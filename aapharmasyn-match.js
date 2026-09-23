const fs = require('fs');
const path = require('path');
const { sql, ensureInitialized } = require('./db');
const { embedText, cosineSimilarity } = require('./embeddings');

// aapharmasyn_data.json holds only AAPharmaSyn's service/capability sections
// (non-technical content like Employment/Testimonials/Company Timeline is
// filtered out, and level-3 headings are already parent-prefixed for
// context) — generated from the full llms.txt by scripts/build-aapharmasyn-data.js.
// Re-run that script after editing llms.txt; this module just consumes the result.
let chunksCache = null;
function loadChunks() {
  if (chunksCache) return chunksCache;

  const dataPath = path.join(__dirname, 'aapharmasyn_data.json');
  const sections = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  chunksCache = sections.map((section) => ({
    heading: section.heading,
    text: `${section.heading}\n${section.content}`,
  }));

  return chunksCache;
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
