import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db.js';

const COOKIE = 'fmsid';
const MAX_AGE_DAYS = 30;

/* ── passwords ───────────────────────────────────────────────────────── */

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(plain, hash, salt) {
  if (!hash || !salt) return false;
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(plain, salt, 64);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/**
 * Readable one-time password — people type these off a WhatsApp message.
 * Letters only, no I/O/0/1 (they get misread), and no vowels, which keeps
 * random four-letter runs from spelling something we'd rather not send.
 */
export function tempPassword() {
  const abc = 'BCDFGHJKLMNPQRSTVWXZ';
  const num = '23456789';
  const pick = s => s[crypto.randomInt(s.length)];
  return Array.from({ length: 4 }, () => pick(abc)).join('') + '-' +
         Array.from({ length: 4 }, () => pick(num)).join('');
}

/* ── sessions ────────────────────────────────────────────────────────── */
/* Session rows live in the database, so disabling a caller ends their
   access on the next request rather than whenever a token expires. */

const sign = id => crypto.createHmac('sha256', config.sessionSecret).update(id).digest('hex').slice(0, 32);

export function startSession(res, userId, device) {
  const id = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions (id, user_id, device) VALUES (?, ?, ?)', id, userId, device || null);
  res.cookie(COOKIE, `${id}.${sign(id)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_DAYS * 86400 * 1000,
    path: '/',
  });
  return id;
}

export function endSession(req, res) {
  const parsed = parseCookie(req);
  if (parsed) run('DELETE FROM sessions WHERE id = ?', parsed);
  res.clearCookie(COOKIE, { path: '/' });
}

function parseCookie(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const want = sign(id);
  if (mac.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  return id;
}

/**
 * Attaches req.user when the cookie is valid and the account is still active.
 * The same account signing in on a phone and a laptop gets two session rows,
 * which is deliberate — callers work on both at once.
 */
export function attachUser(req, _res, next) {
  req.user = null;
  const sid = parseCookie(req);
  if (sid) {
    const row = get(
      `SELECT u.id, u.username, u.name, u.role, u.area, u.active, u.must_reset
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      sid
    );
    if (row && row.active) {
      req.user = row;
      req.sessionId = sid;
      run("UPDATE sessions SET last_seen = datetime('now') WHERE id = ?", sid);
    } else if (row) {
      run('DELETE FROM sessions WHERE user_id = ?', row.id);   // disabled mid-shift
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}
