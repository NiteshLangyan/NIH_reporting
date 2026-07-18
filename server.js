require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── NIH Reporter API endpoints (clinical studies is v1 only) ────────────────
const NIH_ENDPOINTS = {
  projects:       'https://api.reporter.nih.gov/v2/projects/search',
  publications:   'https://api.reporter.nih.gov/v2/publications/search',
  clinicalstudies:'https://api.reporter.nih.gov/v1/clinicalstudies/search',
};

// ─── System prompt for Step 1: interpret user query → structured API call ────
const QUERY_BUILDER_SYSTEM = `You are an expert at the NIH RePORTER API v2.
Your job is to convert a user's natural language request into a valid JSON API call for NIH RePORTER.

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
    "search_id": "text search string",           // free-text keyword search
    "fiscal_years": [2022, 2023, 2024],          // filter by fiscal year(s)
    "org_names": ["Harvard University"],          // filter by organization
    "pi_names": [{"first_name":"John","last_name":"Smith"}], // filter by PI
    "activity_codes": ["R01","R21"],              // NIH activity codes
    "award_types": ["1","2"],                     // award type codes
    "org_states": ["CA","NY"],                    // US state abbreviations
    "agencies": ["NCI","NIMH"],                   // NIH institutes/agencies
    "is_active": true                             // only active projects
  },
  "offset": 0,
  "limit": 10
}

=== PUBLICATIONS /v2/publications/search payload structure ===
{
  "criteria": {
    "pmids": [12345678],                          // PubMed IDs
    "fiscal_years": [2022, 2023],
    "pi_names": [{"first_name":"Jane","last_name":"Doe"}],
    "org_names": ["MIT"],
    "search_id": "keyword search"
  },
  "offset": 0,
  "limit": 10
}

=== CLINICAL STUDIES /v2/clinicalstudies/search payload structure ===
{
  "criteria": {
    "search_id": "keyword search",
    "fiscal_years": [2022, 2023],
    "org_names": ["Stanford University"]
  },
  "offset": 0,
  "limit": 10
}

Rules:
- Only include criteria fields that the user actually asked about. Do NOT add fields with null or empty values.
- Default limit to 10 unless user specifies.
- For keyword searches use "search_id".
- Return ONLY valid JSON with no explanation, no markdown, no code blocks. Just raw JSON.`;

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

// ─── Step 1: Ask Claude to build the API query ────────────────────────────────
async function buildNIHQuery(userQuery) {
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system: QUERY_BUILDER_SYSTEM,
    messages: [{ role: 'user', content: userQuery }],
  });

  const raw = message.content[0].text.trim();
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

// ─── Step 3: Ask Claude to summarize results ──────────────────────────────────
async function summarizeResults(userQuery, nihData, endpoint) {
  const dataStr = JSON.stringify(nihData, null, 2);
  const prompt = `User's question: "${userQuery}"\n\nEndpoint searched: ${endpoint}\n\nNIH RePORTER API results:\n${dataStr}`;

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    system: SUMMARIZER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ─── Debug: test NIH API with a hardcoded minimal query ──────────────────────
app.get('/api/test', async (req, res) => {
  const url = NIH_ENDPOINTS['projects'];
  const payload = { criteria: { search_id: 'cancer' }, offset: 0, limit: 3 };
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

    // Step 3: Claude summarizes
    const summary = await summarizeResults(query, nihData, endpoint);

    res.json({
      summary,
      endpoint,
      query_sent: payload,
      total_count: nihData.meta?.total ?? nihData.total ?? null,
      raw_results: nihData,
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
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ answer: message.content[0].text });
  } catch (e) {
    res.status(500).json({ error: 'Claude follow-up failed.', details: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ NIH Reporter AI running at http://localhost:${PORT}\n`);
});
