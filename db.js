const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { sql } = require('@vercel/postgres');

// Serverless functions cold-start repeatedly, so initialization must be cheap,
// idempotent, and safe to run concurrently. This promise is memoized per
// warm instance so we don't re-run DDL/seeding on every request.
let initPromise = null;

async function ensureInitialized() {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

async function initialize() {
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS catalogue (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      category_name TEXT NOT NULL,
      question TEXT NOT NULL,
      output_fields TEXT NOT NULL,
      answer_contract TEXT NOT NULL,
      embedding TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS search_log (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      query TEXT NOT NULL,
      matched_catalogue_id INTEGER REFERENCES catalogue(id),
      similarity REAL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_search_log_session ON search_log(session_id)`;

  // Admin sessions live in the DB, not in server memory — a serverless
  // function has no guaranteed single warm instance, so an in-memory
  // session store would randomly reject valid logins on a cold instance.
  await sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;

  await seedDefaultSettings();
  await seedCatalogueIfEmpty();
}

async function seedDefaultSettings() {
  const defaults = {
    similarity_threshold: '0.75',
    admin_username: 'admin',
    // Default password "admin123" - change immediately after first login.
    admin_password_hash: bcrypt.hashSync('admin123', 10),
    anthropic_api_key: '',
    gemini_api_key: '',
  };

  for (const [key, value] of Object.entries(defaults)) {
    await sql`
      INSERT INTO settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO NOTHING
    `;
  }
}

// Seed the catalogue from catalogue.seed.json on first run only (table empty).
async function seedCatalogueIfEmpty() {
  const { rows } = await sql`SELECT COUNT(*)::int AS count FROM catalogue`;
  if (rows[0].count > 0) return;

  const seedPath = path.join(__dirname, 'catalogue.seed.json');
  if (!fs.existsSync(seedPath)) return;

  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
  let inserted = 0;

  for (const cat of seed) {
    for (const q of cat.questions) {
      await sql`
        INSERT INTO catalogue (category, category_name, question, output_fields, answer_contract)
        VALUES (${cat.category}, ${cat.categoryName}, ${q.question}, ${q.outputFields}, ${cat.answerContract})
      `;
      inserted++;
    }
  }

  console.log(`Seeded catalogue with ${inserted} questions.`);
}

async function getSettingValue(key, fallback = null) {
  await ensureInitialized();
  const { rows } = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return rows.length > 0 ? rows[0].value : fallback;
}

async function setSettingValue(key, value) {
  await ensureInitialized();
  await sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `;
}

module.exports = {
  sql,
  ensureInitialized,
  getSettingValue,
  setSettingValue,
};
