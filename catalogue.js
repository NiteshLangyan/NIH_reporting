const { sql, ensureInitialized, getSettingValue } = require('./db');
const { embedText, cosineSimilarity } = require('./embeddings');

// Compute and store embeddings for any catalogue rows that don't have one yet
// (new seed rows, or rows added/edited via the admin panel).
async function ensureEmbeddings() {
  await ensureInitialized();

  const { rows: missing } = await sql`
    SELECT id, question FROM catalogue WHERE embedding IS NULL
  `;

  for (const row of missing) {
    const vector = await embedText(row.question);
    await sql`UPDATE catalogue SET embedding = ${JSON.stringify(vector)} WHERE id = ${row.id}`;
  }

  return missing.length;
}

// Find the best-matching catalogue entry for a user query.
// Returns null if nothing clears the configured similarity threshold.
async function matchQuery(userQuery) {
  await ensureEmbeddings();

  const { rows } = await sql`
    SELECT id, category, category_name, question, output_fields, answer_contract, embedding
    FROM catalogue WHERE embedding IS NOT NULL
  `;
  if (rows.length === 0) return null;

  const queryVector = await embedText(userQuery);
  const threshold = parseFloat(await getSettingValue('similarity_threshold', '0.75'));

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
