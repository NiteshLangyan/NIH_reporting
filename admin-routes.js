const express = require('express');
const { db, getSettingValue, setSettingValue } = require('./db');
const { ensureEmbeddings } = require('./catalogue');
const {
  createAdminSession,
  destroyAdminSession,
  verifyAdminCredentials,
  updateAdminPassword,
  requireAdmin,
} = require('./auth');

const router = express.Router();

// ─── Auth ─────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const valid = await verifyAdminCredentials(username, password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = createAdminSession();
  res.cookie('admin_session', token, {
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000,
    sameSite: 'strict',
  });
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies.admin_session;
  if (token) destroyAdminSession(token);
  res.clearCookie('admin_session');
  res.json({ success: true });
});

router.get('/session', requireAdmin, (req, res) => {
  res.json({ authenticated: true });
});

// Everything below requires an authenticated admin session.
router.use(requireAdmin);

// ─── Settings: API keys + similarity threshold ─────────────────────────────
router.get('/settings', (req, res) => {
  const anthropicKey = getSettingValue('anthropic_api_key', '');
  const geminiKey = getSettingValue('gemini_api_key', '');
  res.json({
    // Keys are masked - the admin panel shows a hint, not the full secret.
    anthropic_api_key_set: Boolean(anthropicKey),
    anthropic_api_key_preview: anthropicKey ? `${anthropicKey.slice(0, 10)}...${anthropicKey.slice(-4)}` : '',
    gemini_api_key_set: Boolean(geminiKey),
    gemini_api_key_preview: geminiKey ? `${geminiKey.slice(0, 6)}...${geminiKey.slice(-4)}` : '',
    similarity_threshold: parseFloat(getSettingValue('similarity_threshold', '0.75')),
    admin_username: getSettingValue('admin_username', 'admin'),
  });
});

router.post('/settings', async (req, res) => {
  const { anthropic_api_key, gemini_api_key, similarity_threshold, admin_username, new_password } = req.body;

  if (typeof anthropic_api_key === 'string' && anthropic_api_key.trim() !== '') {
    setSettingValue('anthropic_api_key', anthropic_api_key.trim());
  }
  if (typeof gemini_api_key === 'string' && gemini_api_key.trim() !== '') {
    setSettingValue('gemini_api_key', gemini_api_key.trim());
  }
  if (similarity_threshold !== undefined && similarity_threshold !== null && similarity_threshold !== '') {
    const num = parseFloat(similarity_threshold);
    if (Number.isNaN(num) || num < 0 || num > 1) {
      return res.status(400).json({ error: 'similarity_threshold must be a number between 0 and 1.' });
    }
    setSettingValue('similarity_threshold', String(num));
  }
  if (typeof admin_username === 'string' && admin_username.trim() !== '') {
    setSettingValue('admin_username', admin_username.trim());
  }
  if (typeof new_password === 'string' && new_password.trim() !== '') {
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    await updateAdminPassword(new_password);
  }

  res.json({ success: true });
});

// ─── Catalogue CRUD ─────────────────────────────────────────────────────────
router.get('/catalogue', (req, res) => {
  const rows = db
    .prepare('SELECT id, category, category_name, question, output_fields, answer_contract, created_at, updated_at FROM catalogue ORDER BY category, id')
    .all();
  res.json({ items: rows });
});

router.post('/catalogue', async (req, res) => {
  const { category, category_name, question, output_fields, answer_contract } = req.body;
  if (!category || !question || !output_fields) {
    return res.status(400).json({ error: 'category, question, and output_fields are required.' });
  }

  const defaultContract =
    'State the population, time window, filters, ranking rule, and data freshness. Return a structured table that can be exported, not only narrative prose. Cite evidence for scientific classification and non-obvious business conclusions. Disclose incomplete source coverage, ambiguous identities, and inferred values.';

  const result = db
    .prepare(
      'INSERT INTO catalogue (category, category_name, question, output_fields, answer_contract) VALUES (?, ?, ?, ?, ?)'
    )
    .run(category, category_name || category, question, output_fields, answer_contract || defaultContract);

  // Embedding is computed lazily by ensureEmbeddings() on next match, but we
  // compute it eagerly here so the new question is searchable immediately.
  await ensureEmbeddings();

  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/catalogue/:id', async (req, res) => {
  const { id } = req.params;
  const { category, category_name, question, output_fields, answer_contract } = req.body;

  const existing = db.prepare('SELECT id FROM catalogue WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Catalogue entry not found.' });

  const questionChanged = typeof question === 'string';

  db.prepare(
    `UPDATE catalogue SET
      category = COALESCE(?, category),
      category_name = COALESCE(?, category_name),
      question = COALESCE(?, question),
      output_fields = COALESCE(?, output_fields),
      answer_contract = COALESCE(?, answer_contract),
      updated_at = datetime('now')
      ${questionChanged ? ', embedding = NULL' : ''}
    WHERE id = ?`
  ).run(category ?? null, category_name ?? null, question ?? null, output_fields ?? null, answer_contract ?? null, id);

  if (questionChanged) await ensureEmbeddings();

  res.json({ success: true });
});

router.delete('/catalogue/:id', (req, res) => {
  const { id } = req.params;
  const result = db.prepare('DELETE FROM catalogue WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Catalogue entry not found.' });
  res.json({ success: true });
});

// ─── Search log / usage analytics ──────────────────────────────────────────
router.get('/search-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);

  const rows = db
    .prepare(
      `SELECT sl.id, sl.session_id, sl.query, sl.similarity, sl.created_at,
              c.question AS matched_question, c.category AS matched_category
       FROM search_log sl
       LEFT JOIN catalogue c ON c.id = sl.matched_catalogue_id
       ORDER BY sl.created_at DESC
       LIMIT ?`
    )
    .all(limit);

  const { total } = db.prepare('SELECT COUNT(*) AS total FROM search_log').get();
  const { distinct_sessions } = db.prepare('SELECT COUNT(DISTINCT session_id) AS distinct_sessions FROM search_log').get();

  res.json({ total, distinct_sessions, items: rows });
});

module.exports = router;
