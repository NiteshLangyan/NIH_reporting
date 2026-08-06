const express = require('express');
const { sql, ensureInitialized, getSettingValue, setSettingValue } = require('./db');
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

  const token = await createAdminSession();
  res.cookie('admin_session', token, {
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000,
    sameSite: 'strict',
  });
  res.json({ success: true });
});

router.post('/logout', async (req, res) => {
  const token = req.cookies && req.cookies.admin_session;
  if (token) await destroyAdminSession(token);
  res.clearCookie('admin_session');
  res.json({ success: true });
});

router.get('/session', requireAdmin, (req, res) => {
  res.json({ authenticated: true });
});

// Everything below requires an authenticated admin session.
router.use(requireAdmin);

// ─── Settings: API keys + similarity threshold ─────────────────────────────
router.get('/settings', async (req, res) => {
  const anthropicKey = await getSettingValue('anthropic_api_key', '');
  const geminiKey = await getSettingValue('gemini_api_key', '');
  res.json({
    // Keys are masked - the admin panel shows a hint, not the full secret.
    anthropic_api_key_set: Boolean(anthropicKey),
    anthropic_api_key_preview: anthropicKey ? `${anthropicKey.slice(0, 10)}...${anthropicKey.slice(-4)}` : '',
    gemini_api_key_set: Boolean(geminiKey),
    gemini_api_key_preview: geminiKey ? `${geminiKey.slice(0, 6)}...${geminiKey.slice(-4)}` : '',
    similarity_threshold: parseFloat(await getSettingValue('similarity_threshold', '0.75')),
    admin_username: await getSettingValue('admin_username', 'admin'),
  });
});

router.post('/settings', async (req, res) => {
  const { anthropic_api_key, gemini_api_key, similarity_threshold, admin_username, new_password } = req.body;

  if (typeof anthropic_api_key === 'string' && anthropic_api_key.trim() !== '') {
    await setSettingValue('anthropic_api_key', anthropic_api_key.trim());
  }
  if (typeof gemini_api_key === 'string' && gemini_api_key.trim() !== '') {
    await setSettingValue('gemini_api_key', gemini_api_key.trim());
  }
  if (similarity_threshold !== undefined && similarity_threshold !== null && similarity_threshold !== '') {
    const num = parseFloat(similarity_threshold);
    if (Number.isNaN(num) || num < 0 || num > 1) {
      return res.status(400).json({ error: 'similarity_threshold must be a number between 0 and 1.' });
    }
    await setSettingValue('similarity_threshold', String(num));
  }
  if (typeof admin_username === 'string' && admin_username.trim() !== '') {
    await setSettingValue('admin_username', admin_username.trim());
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
router.get('/catalogue', async (req, res) => {
  const { rows } = await sql`
    SELECT id, category, category_name, question, output_fields, answer_contract, created_at, updated_at
    FROM catalogue ORDER BY category, id
  `;
  res.json({ items: rows });
});

router.post('/catalogue', async (req, res) => {
  const { category, category_name, question, output_fields, answer_contract } = req.body;
  if (!category || !question || !output_fields) {
    return res.status(400).json({ error: 'category, question, and output_fields are required.' });
  }

  const defaultContract =
    'State the population, time window, filters, ranking rule, and data freshness. Return a structured table that can be exported, not only narrative prose. Cite evidence for scientific classification and non-obvious business conclusions. Disclose incomplete source coverage, ambiguous identities, and inferred values.';

  const { rows } = await sql`
    INSERT INTO catalogue (category, category_name, question, output_fields, answer_contract)
    VALUES (${category}, ${category_name || category}, ${question}, ${output_fields}, ${answer_contract || defaultContract})
    RETURNING id
  `;

  // Embedding is computed lazily by ensureEmbeddings() on next match, but we
  // compute it eagerly here so the new question is searchable immediately.
  await ensureEmbeddings();

  res.status(201).json({ id: rows[0].id });
});

router.put('/catalogue/:id', async (req, res) => {
  const { id } = req.params;
  const { category, category_name, question, output_fields, answer_contract } = req.body;

  const { rows: existingRows } = await sql`SELECT id FROM catalogue WHERE id = ${id}`;
  if (existingRows.length === 0) return res.status(404).json({ error: 'Catalogue entry not found.' });

  const questionChanged = typeof question === 'string';

  if (questionChanged) {
    await sql`
      UPDATE catalogue SET
        category = COALESCE(${category ?? null}, category),
        category_name = COALESCE(${category_name ?? null}, category_name),
        question = COALESCE(${question ?? null}, question),
        output_fields = COALESCE(${output_fields ?? null}, output_fields),
        answer_contract = COALESCE(${answer_contract ?? null}, answer_contract),
        updated_at = now(),
        embedding = NULL
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE catalogue SET
        category = COALESCE(${category ?? null}, category),
        category_name = COALESCE(${category_name ?? null}, category_name),
        output_fields = COALESCE(${output_fields ?? null}, output_fields),
        answer_contract = COALESCE(${answer_contract ?? null}, answer_contract),
        updated_at = now()
      WHERE id = ${id}
    `;
  }

  if (questionChanged) await ensureEmbeddings();

  res.json({ success: true });
});

router.delete('/catalogue/:id', async (req, res) => {
  const { id } = req.params;
  const { rowCount } = await sql`DELETE FROM catalogue WHERE id = ${id}`;
  if (rowCount === 0) return res.status(404).json({ error: 'Catalogue entry not found.' });
  res.json({ success: true });
});

// ─── Search log / usage analytics ──────────────────────────────────────────
router.get('/search-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);

  const { rows } = await sql`
    SELECT sl.id, sl.session_id, sl.query, sl.similarity, sl.created_at,
           c.question AS matched_question, c.category AS matched_category
    FROM search_log sl
    LEFT JOIN catalogue c ON c.id = sl.matched_catalogue_id
    ORDER BY sl.created_at DESC
    LIMIT ${limit}
  `;

  const { rows: totalRows } = await sql`SELECT COUNT(*)::int AS total FROM search_log`;
  const { rows: sessionRows } = await sql`SELECT COUNT(DISTINCT session_id)::int AS distinct_sessions FROM search_log`;

  res.json({ total: totalRows[0].total, distinct_sessions: sessionRows[0].distinct_sessions, items: rows });
});

module.exports = router;
