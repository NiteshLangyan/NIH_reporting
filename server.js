require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const { sql, ensureInitialized, getSettingValue } = require('./db');
const { matchQuery } = require('./catalogue');
const adminRouter = require('./admin-routes');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = 'gemini-flash-latest';

// The database (managed via the admin panel) is the single source of truth
// for API keys — no .env fallback. Mixing the two caused a stale env var to
// occasionally look "invalid" after the admin panel's key had already been
// updated, since env vars and DB rows can silently drift apart.
async function getAnthropicClient() {
  await ensureInitialized();
  const apiKey = await getSettingValue('anthropic_api_key');
  if (!apiKey) {
    throw new Error('No Anthropic API key configured. Set one in the admin panel (/admin.html).');
  }
  return new Anthropic({ apiKey });
}

async function getGeminiClient() {
  await ensureInitialized();
  const apiKey = await getSettingValue('gemini_api_key');
  return apiKey ? new GoogleGenerativeAI(apiKey) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gemini's free tier (gemini-flash-latest) periodically returns 503
// "currently experiencing high demand" or 429 rate-limit errors that are
// typically resolved within a few seconds. Retry those specifically before
// giving up, so a transient Google-side blip doesn't fail the whole request
// right when Anthropic has also failed over.
function isTransientGeminiError(err) {
  return err && (err.status === 503 || err.status === 429);
}

// ─── Shared LLM call: try Claude first, fall back to Gemini if it fails ─────
async function askLLM({ system, prompt, maxTokens = 2048 }) {
  try {
    const anthropic = await getAnthropicClient();
    const claudeModel = await getSettingValue('claude_model', 'claude-sonnet-5');
    const message = await anthropic.messages.create({
      model: claudeModel,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].text;
  } catch (claudeErr) {
    console.error('⚠️  Anthropic API failed, falling back to Gemini:', claudeErr.message);

    const genAI = await getGeminiClient();
    if (!genAI) {
      throw new Error(`Anthropic API failed and no Gemini API key is configured for fallback: ${claudeErr.message}`);
    }

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: system,
    });

    const maxAttempts = 3;
    let lastGeminiErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (geminiErr) {
        lastGeminiErr = geminiErr;
        const willRetry = attempt < maxAttempts && isTransientGeminiError(geminiErr);
        if (willRetry) {
          const delayMs = attempt * 1500; // 1.5s, then 3s
          console.error(`⚠️  Gemini attempt ${attempt} failed (transient), retrying in ${delayMs}ms:`, geminiErr.message);
          await sleep(delayMs);
        }
      }
    }

    console.error('❌ Gemini fallback also failed after retries:', lastGeminiErr.message);
    throw new Error(`Both Anthropic and Gemini failed. Anthropic: ${claudeErr.message}; Gemini: ${lastGeminiErr.message}`);
  }
}

app.use(express.json());
app.use(cookieParser());

// ─── Anonymous session tracking (for search-log analytics, no login required) ─
const SESSION_COOKIE = 'nih_session_id';
app.use((req, res, next) => {
  let sessionId = req.cookies[SESSION_COOKIE];
  if (!sessionId) {
    sessionId = randomUUID();
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
  }
  req.sessionId = sessionId;
  next();
});

app.use('/admin/api', adminRouter);
app.use(express.static(path.join(__dirname, 'public')));

async function logSearch(sessionId, query, matchedCatalogueId, similarity) {
  await ensureInitialized();
  await sql`
    INSERT INTO search_log (session_id, query, matched_catalogue_id, similarity)
    VALUES (${sessionId}, ${query}, ${matchedCatalogueId}, ${similarity})
  `;
}

// ─── NIH Reporter API endpoints (clinical studies is v1 only) ────────────────
const NIH_ENDPOINTS = {
  projects:       'https://api.reporter.nih.gov/v2/projects/search',
  publications:   'https://api.reporter.nih.gov/v2/publications/search',
  clinicalstudies:'https://api.reporter.nih.gov/v1/clinicalstudies/search',
};

// ─── System prompt for Step 1: interpret user query → structured API call ────
// Field names verified directly against api.reporter.nih.gov (V2) — "search_id"
// and "is_active" are NOT real filter fields (search_id retrieves a prior
// saved search by ID; an unrecognized "is_active" is silently ignored), so
// using either one causes NIH to return its *entire unfiltered database*
// instead of a filtered result.
function buildQueryBuilderSystem() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are an expert at the NIH RePORTER API v2.
Your job is to convert a user's natural language request into a valid JSON API call for NIH RePORTER.

Today's date is ${today}. Compute any relative time window ("past 30 days", "this quarter", "within six months", "expiring next year") into concrete "from_date"/"to_date" values (YYYY-MM-DD) based on this date. Never omit the date filter just because the window is relative — resolve it yourself.

The NIH RePORTER API has three main search endpoints:
1. POST /v2/projects/search   — funded research projects
2. POST /v2/publications/search — publications from NIH-funded research
3. POST /v2/clinicalstudies/search — clinical studies

You must return a JSON object with exactly two keys:
- "endpoint": one of "projects", "publications", or "clinicalstudies"
- "payload": the full POST body for that endpoint

=== PROJECTS /v2/projects/search payload structure ===
{
  "criteria": {
    "advanced_text_search": {                      // free-text keyword search — use this, NOT "search_id"
      "operator": "and",                           // "and" | "or" | "advanced"
      "search_field": "all",                       // "all", or comma-separated: "projecttitle,terms,abstracttext"
      "search_text": "medicinal chemistry lead optimization"
    },
    "fiscal_years": [2022, 2023, 2024],             // filter by fiscal year(s)
    "org_names": ["Harvard University"],            // filter by organization
    "pi_names": [{"first_name":"John","last_name":"Smith"}], // filter by PI
    "activity_codes": ["R01","R21"],                // NIH activity codes
    "award_types": ["1","2"],                       // award type codes
    "org_states": ["CA","NY"],                      // US state abbreviations
    "agencies": ["NCI","NIMH"],                     // NIH institutes/agencies
    "include_active_projects": true,                // only currently active projects — NOT "is_active"
    "project_start_date": {"from_date":"2026-01-01","to_date":"2026-06-30"}, // project start window
    "project_end_date": {"from_date":"2026-01-01","to_date":"2026-06-30"},   // project/budget-period end window — use for "expiring", "ending within X months", "renewal due" questions
    "award_notice_date": {"from_date":"2026-01-01","to_date":"2026-06-30"}   // use for "new awards in the past N days/weeks/months"
  },
  "offset": 0,
  "limit": 10,
  "sort_field": "project_start_date",              // e.g. project_start_date, award_amount, project_end_date
  "sort_order": "desc"
}

=== PUBLICATIONS /v2/publications/search payload structure ===
{
  "criteria": {
    "pmids": [12345678],                          // PubMed IDs
    "fiscal_years": [2022, 2023],
    "pi_names": [{"first_name":"Jane","last_name":"Doe"}],
    "org_names": ["MIT"]
  },
  "offset": 0,
  "limit": 10
}

=== CLINICAL STUDIES /v2/clinicalstudies/search payload structure ===
{
  "criteria": {
    "fiscal_years": [2022, 2023],
    "org_names": ["Stanford University"]
  },
  "offset": 0,
  "limit": 10
}

Rules:
- Only include criteria fields that the user actually asked about or that are needed to resolve a time window they implied. Do NOT add fields with null or empty values.
- Default limit to 10 unless user specifies.
- For keyword/topic searches use "advanced_text_search" — never "search_id" (that field retrieves a previously saved search by ID, not a new keyword search).
- For "only active/ongoing/current projects" use "include_active_projects": true — never "is_active" (not a real field; NIH silently ignores it and returns unfiltered results).
- For any date-bounded phrase ("past 30 days", "within N months", "this quarter", "expiring soon", "recently funded"), compute concrete from_date/to_date values from today's date and apply them to the most relevant date field (award_notice_date for new awards, project_end_date for expirations/renewals, project_start_date for start-date windows).
- Return ONLY valid JSON with no explanation, no markdown, no code blocks. Just raw JSON.`;
}

// ─── System prompt for Step 2: summarize API results in plain language ────────
const SUMMARIZER_SYSTEM = `You are a helpful research assistant that explains NIH RePORTER data in clear, friendly language.
You will receive:
1. The user's original question
2. The raw JSON results from the NIH RePORTER API

Your job is to summarize the results in a way that directly answers the user's question.
- Use plain language, not jargon
- Highlight the most relevant findings
- Mention key details like project titles, PIs, institutions, funding amounts, and years where relevant
- If there are many results, summarize the top ones and note the total count
- If no results were found, say so clearly and suggest refining the search
- Keep the response concise but informative
- Use bullet points or short paragraphs as appropriate`;

// ─── Step 1: Ask Claude (or Gemini fallback) to build the API query ──────────
async function buildNIHQuery(userQuery) {
  const raw = (await askLLM({ system: buildQueryBuilderSystem(), prompt: userQuery, maxTokens: 1024 })).trim();
  // Strip any accidental markdown code fences
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

// ─── Step 2: Call the NIH Reporter API ───────────────────────────────────────
async function callNIHReporter(endpoint, payload) {
  const url = NIH_ENDPOINTS[endpoint];
  console.log(`\n📡 Calling NIH API: POST ${url}`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  try {
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 30000,
    });
    console.log(`✅ NIH API responded with status ${response.status}`);
    return response.data;
  } catch (e) {
    console.error('❌ NIH API error:');
    console.error('  Status:', e.response?.status);
    console.error('  Data:', JSON.stringify(e.response?.data));
    console.error('  Message:', e.message);
    console.error('  Code:', e.code);
    throw e;
  }
}

// ─── Step 3: Ask Claude (or Gemini fallback) to summarize results ────────────
// When `catalogueMatch` is provided, the question matched one of the governed
// catalogue entries (Appendix A) closely enough — the summarizer is told to
// answer using exactly that entry's required output fields and answer contract.
async function summarizeResults(userQuery, nihData, endpoint, catalogueMatch) {
  const dataStr = JSON.stringify(nihData, null, 2);
  let prompt = `User's question: "${userQuery}"\n\nEndpoint searched: ${endpoint}\n\nNIH RePORTER API results:\n${dataStr}`;
  let system = SUMMARIZER_SYSTEM;

  if (catalogueMatch) {
    system = `${SUMMARIZER_SYSTEM}

This question matches a governed catalogue question ("${catalogueMatch.question}", category ${catalogueMatch.category} - ${catalogueMatch.categoryName}). Answer using exactly these required output fields, in a structured table/list format, in addition to your narrative summary:

Required output fields: ${catalogueMatch.outputFields}

Answer contract:
${catalogueMatch.answerContract}`;
  }

  return askLLM({ system, prompt, maxTokens: 2048 });
}

// ─── Debug: test NIH API with a hardcoded minimal query ──────────────────────
app.get('/api/test', async (req, res) => {
  const url = NIH_ENDPOINTS['projects'];
  const payload = { criteria: { advanced_text_search: { operator: 'and', search_field: 'all', search_text: 'cancer' } }, offset: 0, limit: 3 };
  console.log('\n🧪 Test route: calling NIH API directly...');
  try {
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 30000,
    });
    console.log('✅ Test succeeded, status:', response.status);
    res.json({ success: true, status: response.status, sample: response.data });
  } catch (e) {
    console.error('❌ Test failed:', e.message, e.code, e.response?.status, e.response?.data);
    res.status(502).json({
      success: false,
      message: e.message,
      code: e.code,
      httpStatus: e.response?.status,
      body: e.response?.data,
    });
  }
});

// ─── Main search route ────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;

  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Query is required.' });
  }

  try {
    // Step 1: Claude builds the structured query
    let nihQuery;
    try {
      nihQuery = await buildNIHQuery(query);
      console.log('\n🤖 Claude built query:', JSON.stringify(nihQuery, null, 2));
    } catch (e) {
      console.error('Claude query build failed:', e.message);
      return res.status(500).json({ error: 'Failed to interpret your query. Please try rephrasing it.', details: e.message });
    }

    const { endpoint, payload } = nihQuery;

    if (!['projects', 'publications', 'clinicalstudies'].includes(endpoint)) {
      return res.status(500).json({ error: `Unexpected endpoint returned: ${endpoint}` });
    }

    // Step 2: Call NIH Reporter API
    let nihData;
    try {
      nihData = await callNIHReporter(endpoint, payload);
    } catch (e) {
      const status = e.response?.status ?? 'no response';
      const errBody = e.response?.data ? JSON.stringify(e.response.data) : '';
      const errMsg = errBody || e.message || e.code || 'Unknown error';
      return res.status(502).json({
        error: `NIH Reporter API call failed (HTTP ${status}).`,
        details: errMsg,
      });
    }

    // Check whether this question matches a governed catalogue question (Appendix A)
    let catalogueMatch = null;
    try {
      catalogueMatch = await matchQuery(query);
    } catch (e) {
      console.error('⚠️  Catalogue matching failed (continuing without it):', e.message);
    }

    try {
      await logSearch(req.sessionId, query, catalogueMatch?.id ?? null, catalogueMatch?.similarity ?? null);
    } catch (e) {
      console.error('⚠️  Failed to log search (continuing):', e.message);
    }

    // Step 3: Claude summarizes (using the catalogue's required format, if matched)
    const summary = await summarizeResults(query, nihData, endpoint, catalogueMatch);

    res.json({
      summary,
      endpoint,
      query_sent: payload,
      total_count: nihData.meta?.total ?? nihData.total ?? null,
      raw_results: nihData,
      catalogue_match: catalogueMatch
        ? { category: catalogueMatch.category, categoryName: catalogueMatch.categoryName, question: catalogueMatch.question, similarity: catalogueMatch.similarity }
        : null,
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'An unexpected error occurred.', details: err.message });
  }
});

// ─── Follow-up route: answer questions about existing results ─────────────────
app.post('/api/followup', async (req, res) => {
  const { followup, originalQuery, nihData, endpoint } = req.body;

  if (!followup || !nihData) {
    return res.status(400).json({ error: 'followup and nihData are required.' });
  }

  const system = `You are a helpful NIH research assistant. The user ran a search on NIH RePORTER and received results. They now have a follow-up question about those results or want to refine their understanding.

Answer conversationally and helpfully based on the data provided. Be specific — reference actual project titles, PI names, institutions, or amounts from the data where relevant. Use plain language and format your answer with markdown (bold, bullets, headers) for readability.`;

  const prompt = `Original search: "${originalQuery}"
Endpoint searched: ${endpoint}
Follow-up question: "${followup}"

NIH RePORTER data:
${JSON.stringify(nihData, null, 2)}`;

  try {
    const answer = await askLLM({ system, prompt, maxTokens: 2048 });
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: 'Follow-up failed.', details: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ NIH Reporter AI running at http://localhost:${PORT}\n`);
});
