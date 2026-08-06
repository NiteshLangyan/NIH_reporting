const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getSettingValue, setSettingValue } = require('./db');

// In-memory admin session store: token -> expiry timestamp.
// Sessions reset on server restart, which is acceptable for a single-admin internal tool.
const adminSessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidAdminSession(token) {
  if (!token) return false;
  const expiry = adminSessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function destroyAdminSession(token) {
  adminSessions.delete(token);
}

async function verifyAdminCredentials(username, password) {
  const storedUsername = getSettingValue('admin_username');
  const storedHash = getSettingValue('admin_password_hash');
  if (!storedUsername || !storedHash) return false;
  if (username !== storedUsername) return false;
  return bcrypt.compare(password, storedHash);
}

async function updateAdminPassword(newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  setSettingValue('admin_password_hash', hash);
}

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies.admin_session;
  if (!isValidAdminSession(token)) {
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
