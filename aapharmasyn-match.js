const fs = require('fs');
const path = require('path');
const { sql, ensureInitialized } = require('./db');
const { embedText, cosineSimilarity } = require('./embeddings');

// aapharmasyn_data.json is a complete, untouched mirror of llms.txt (every
// section, including non-technical ones like Employment/Testimonials/Company
// Timeline). For BD-fit matching we only want the sections that actually
// describe a chemistry service — matching a NIH project's abstract against
// "Client Testimonials" or "Company Timeline" would produce a nonsense top
// match, so those headings are excluded here. This filtering only affects
// which chunks are embedded for matching; aapharmasyn_data.json itself is
// never modified.
const EXCLUDED_HEADINGS = new Set([
  'AAPharmaSyn', // top-level title/intro, not a service description
  'Company Mission & Values',
  'Vision',
  'About AAPharmaSyn (Company Story)',
  'Company Timeline',
  'Explore More About AAPharmaSyn',
  'Additional Services', // pure links to sections already included in detail elsewhere
  'Lab Capabilities', // pure links; "Capabilities Overview Detail" covers the substance
  'Other Services', // pure link list, no substantive content of its own
  'Project & Program Support', // pure links
  'Resources',
  'Current and Legacy Clients',
  'Client Testimonials',
  'Employment',
  'Personnel',
  'Company Culture',
  'Management Team',
  'Operating Philosophy',
  'Core Values',
  'Company & Trust',
  'Partners Detail',
  'Example Partner Needs Addressed',
  'Partner Logos',
  'Resources Page Detail',
  'Publicly Available Information',
  'Government',
  'Patents',
  'Chemistry', // "Resources > Chemistry" link list, not a chemistry-capability description
  'Useful Guides (linked resources)',
  'White Papers Detail',
  'White Papers List (title — publish date)',
  'Key Pages',
]);

let chunksCache = null;
function loadChunks() {
  if (chunksCache) return chunksCache;

  const dataPath = path.join(__dirname, 'aapharmasyn_data.json');
  const sections = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  let lastLevel2Heading = null;
  const chunks = [];
  for (const section of sections) {
    if (section.level === 2) lastLevel2Heading = section.heading;
    if (EXCLUDED_HEADINGS.has(section.heading)) continue;
    if (!section.content || section.content.trim() === '') continue;

    // A level-3 subsection's heading alone often lacks context (e.g. "Applications"
    // appears under two different parents), so prefix it with its parent ## heading.
    const contextualHeading =
      section.level === 3 && lastLevel2Heading && lastLevel2Heading !== section.heading
        ? `${lastLevel2Heading} — ${section.heading}`
        : section.heading;

    chunks.push({
      heading: contextualHeading,
      text: `${contextualHeading}\n${section.content}`,
    });
  }

  chunksCache = chunks;
  return chunks;
}

// Search results are matched concurrently (Promise.all over ~10 results per
// search), and each call used to independently run "CREATE TABLE IF NOT
// EXISTS" — under true concurrency Postgres's own catalog insert for that
// table can collide across simultaneous DDL statements. Memoizing the setup
// into a single shared promise (same pattern as db.js's ensureInitialized)
// ensures the table/embedding bootstrap only actually runs once per warm
// instance, and every concurrent caller just awaits that one run.
let embeddingsReadyPromise = null;
async function ensureServiceEmbeddings() {
  if (!embeddingsReadyPromise) embeddingsReadyPromise = setupServiceEmbeddings();
  return embeddingsReadyPromise;
}

async function setupServiceEmbeddings() {
  await ensureInitialized();
  await sql`
    CREATE TABLE IF NOT EXISTS aapharmasyn_chunks (
      heading TEXT PRIMARY KEY,
      embedding TEXT NOT NULL
    )
  `;

  const chunks = loadChunks();
  const { rows } = await sql`SELECT heading FROM aapharmasyn_chunks`;
  const existing = new Set(rows.map((r) => r.heading));

  for (const chunk of chunks) {
    if (existing.has(chunk.heading)) continue;
    const vector = await embedText(chunk.text);
    await sql`
      INSERT INTO aapharmasyn_chunks (heading, embedding) VALUES (${chunk.heading}, ${JSON.stringify(vector)})
      ON CONFLICT (heading) DO NOTHING
    `;
  }

  // Prune rows for headings no longer in the source (e.g. after an edit to
  // aapharmasyn_data.json or the exclusion list), so stale chunks can't be matched.
  const currentHeadings = chunks.map((c) => c.heading);
  if (currentHeadings.length > 0) {
    await sql`DELETE FROM aapharmasyn_chunks WHERE heading != ALL(${currentHeadings})`;
  }
}

// Cached after the first load per warm instance — the chunk set only
// changes when aapharmasyn_data.json is edited and the server restarts, so
// re-querying Postgres for the same rows on every one of the ~10 concurrent
// per-search matches would be pure overhead.
let chunkRowsCache = null;
async function getChunkRows() {
  if (!chunkRowsCache) {
    const { rows } = await sql`SELECT heading, embedding FROM aapharmasyn_chunks`;
    chunkRowsCache = rows.map((r) => ({ heading: r.heading, vector: JSON.parse(r.embedding) }));
  }
  return chunkRowsCache;
}

// Score a piece of NIH result text (project title+abstract, or publication
// title) against every AAPharmaSyn service chunk and return the best match.
// Returns null if there's no usable text or no chunks are available.
async function matchAgainstServices(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  await ensureServiceEmbeddings();

  const rows = await getChunkRows();
  if (rows.length === 0) return null;

  const queryVector = await embedText(trimmed);

  let best = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    const score = cosineSimilarity(queryVector, row.vector);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (!best) return null;

  // Cosine similarity from this embedding model for genuinely related NIH
  // abstract <-> service-description text lands roughly in 0.2-0.85 in
  // practice (observed against real NIH RePORTER results), not 0-1, so a raw
  // score reads as misleadingly low to a human and a narrower band clips
  // distinct strong matches to the same displayed 100. Rescale that observed
  // range to 0-100, for display only — this does not change ranking, since
  // it's a monotonic transform of bestScore.
  const displayScore = Math.max(0, Math.min(100, Math.round(((bestScore - 0.2) / 0.65) * 100)));

  return {
    score: displayScore,
    rawSimilarity: bestScore,
    service: best.heading,
  };
}

module.exports = { matchAgainstServices, ensureServiceEmbeddings, loadChunks };
