const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS catalogue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    category_name TEXT NOT NULL,
    question TEXT NOT NULL,
    output_fields TEXT NOT NULL,
    answer_contract TEXT NOT NULL,
    embedding TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS search_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    query TEXT NOT NULL,
    matched_catalogue_id INTEGER,
    similarity REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (matched_catalogue_id) REFERENCES catalogue(id)
  );

  CREATE INDEX IF NOT EXISTS idx_search_log_session ON search_log(session_id);
`);

const DEFAULTS = {
  similarity_threshold: '0.75',
  admin_username: 'admin',
  // Default password "admin123" - change immediately after first login.
  admin_password_hash: bcrypt.hashSync('admin123', 10),
  anthropic_api_key: '',
  gemini_api_key: '',
};

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

for (const [key, value] of Object.entries(DEFAULTS)) {
  const existing = getSetting.get(key);
  if (!existing) setSetting.run(key, value);
}

// Seed the catalogue from catalogue.seed.json on first run only (table empty).
function seedCatalogueIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM catalogue').get();
  if (count > 0) return;

  const seedPath = path.join(__dirname, 'catalogue.seed.json');
  if (!fs.existsSync(seedPath)) return;

  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
  const insert = db.prepare(`
    INSERT INTO catalogue (category, category_name, question, output_fields, answer_contract)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((categories) => {
    for (const cat of categories) {
      for (const q of cat.questions) {
        insert.run(cat.category, cat.categoryName, q.question, q.outputFields, cat.answerContract);
      }
    }
  });

  insertMany(seed);
  console.log(`Seeded catalogue with ${seed.reduce((n, c) => n + c.questions.length, 0)} questions.`);
}

seedCatalogueIfEmpty();

function getSettingValue(key, fallback = null) {
  const row = getSetting.get(key);
  return row ? row.value : fallback;
}

function setSettingValue(key, value) {
  setSetting.run(key, value);
}

module.exports = {
  db,
  getSettingValue,
  setSettingValue,
};
