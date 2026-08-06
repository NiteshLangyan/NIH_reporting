const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { sql, ensureInitialized, getSettingValue, setSettingValue } = require('./db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

async function createAdminSession() {
  await ensureInitialized();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`INSERT INTO admin_sessions (token, expires_at) VALUES (${token}, ${expiresAt.toISOString()})`;
  return token;
}

async function isValidAdminSession(token) {
  if (!token) return false;
  await ensureInitialized();

  const { rows } = await sql`SELECT expires_at FROM admin_sessions WHERE token = ${token}`;
  if (rows.length === 0) return false;

  if (new Date(rows[0].expires_at).getTime() < Date.now()) {
    await sql`DELETE FROM admin_sessions WHERE token = ${token}`;
    return false;
  }
  return true;
}

async function destroyAdminSession(token) {
  await ensureInitialized();
  await sql`DELETE FROM admin_sessions WHERE token = ${token}`;
}

async function verifyAdminCredentials(username, password) {
  const storedUsername = await getSettingValue('admin_username');
  const storedHash = await getSettingValue('admin_password_hash');
  if (!storedUsername || !storedHash) return false;
  if (username !== storedUsername) return false;
  return bcrypt.compare(password, storedHash);
}

async function updateAdminPassword(newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  await setSettingValue('admin_password_hash', hash);
}

async function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies.admin_session;
  const valid = await isValidAdminSession(token);
  if (!valid) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
}

module.exports = {
  createAdminSession,
  isValidAdminSession,
  destroyAdminSession,
  verifyAdminCredentials,
  updateAdminPassword,
  requireAdmin,
};
