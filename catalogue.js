const { db, getSettingValue } = require('./db');
const { embedText, cosineSimilarity } = require('./embeddings');

const selectMissingEmbeddings = db.prepare(
  'SELECT id, question FROM catalogue WHERE embedding IS NULL OR embedding = ?'
);
const updateEmbedding = db.prepare('UPDATE catalogue SET embedding = ? WHERE id = ?');
const selectAllWithEmbeddings = db.prepare(
  'SELECT id, category, category_name, question, output_fields, answer_contract, embedding FROM catalogue WHERE embedding IS NOT NULL'
);

// Compute and store embeddings for any catalogue rows that don't have one yet
// (new seed rows, or rows added/edited via the admin panel).
async function ensureEmbeddings() {
  const missing = selectMissingEmbeddings.all('');
  for (const row of missing) {
    const vector = await embedText(row.question);
    updateEmbedding.run(JSON.stringify(vector), row.id);
  }
  return missing.length;
}

// Find the best-matching catalogue entry for a user query.
// Returns null if nothing clears the configured similarity threshold.
async function matchQuery(userQuery) {
  await ensureEmbeddings();

  const rows = selectAllWithEmbeddings.all();
  if (rows.length === 0) return null;

  const queryVector = await embedText(userQuery);
  const threshold = parseFloat(getSettingValue('similarity_threshold', '0.75'));

  let best = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    const vector = JSON.parse(row.embedding);
    const score = cosineSimilarity(queryVector, vector);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (!best || bestScore < threshold) {
    return null;
  }

  return {
    id: best.id,
    category: best.category,
    categoryName: best.category_name,
    question: best.question,
    outputFields: best.output_fields,
    answerContract: best.answer_contract,
    similarity: bestScore,
  };
}

module.exports = { ensureEmbeddings, matchQuery };
