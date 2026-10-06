import { Router } from 'express';
import { get, run } from '../db.js';
import { verifyPassword, hashPassword, startSession, endSession, requireUser } from '../auth.js';

const router = Router();

/**
 * Sign-in throttle. Without one, a short password is guessable at thousands of
 * tries a minute. Counted per caller ID and per IP, so one noisy address can't
 * lock out a caller who is innocently typing.
 */
const ATTEMPTS = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function throttled(key) {
  const now = Date.now();
  const row = ATTEMPTS.get(key);
  if (!row || now - row.first > WINDOW_MS) return false;
  return row.n >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const now = Date.now();
  const row = ATTEMPTS.get(key);
  if (!row || now - row.first > WINDOW_MS) ATTEMPTS.set(key, { n: 1, first: now });
  else row.n++;
  // The map only grows on failures; clear it out occasionally.
  if (ATTEMPTS.size > 5000) {
    for (const [k, v] of ATTEMPTS) if (now - v.first > WINDOW_MS) ATTEMPTS.delete(k);
  }
}

const clearFailures = (...keys) => keys.forEach(k => ATTEMPTS.delete(k));

router.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your caller ID and password' });

  const byUser = `u:${username}`;
  const byIp = `i:${req.ip}`;
  if (throttled(byUser) || throttled(byIp)) {
    return res.status(429).json({ error: 'Too many attempts. Wait ten minutes, or ask your admin to reset your password.' });
  }

  const user = get('SELECT * FROM users WHERE lower(username) = ?', username);
  // Same message either way — never reveal which half was wrong.
  if (!user || !verifyPassword(password, user.pass_hash, user.pass_salt)) {
    recordFailure(byUser);
    recordFailure(byIp);
    return res.status(401).json({ error: 'That caller ID and password do not match' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'This account has been switched off. Ask your admin.' });
  }

  clearFailures(byUser, byIp);
  startSession(res, user.id, req.get('user-agent')?.slice(0, 120));
  res.json({
    user: { id: user.id, username: user.username, name: user.name, role: user.role, area: user.area },
    mustReset: !!user.must_reset,
  });
});

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.user, mustReset: !!req.user.must_reset });
});

router.post('/password', requireUser, (req, res) => {
  const next = String(req.body?.password || '');
  if (next.length < 8) return res.status(400).json({ error: 'Use at least 8 characters' });

  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  // Someone setting their first password came from a one-time code and has
  // already proved it by signing in; everyone else states the current one.
  if (!user.must_reset) {
    if (!verifyPassword(String(req.body?.current || ''), user.pass_hash, user.pass_salt)) {
      return res.status(400).json({ error: 'Current password is wrong' });
    }
  }

  const { hash, salt } = hashPassword(next);
  run('UPDATE users SET pass_hash = ?, pass_salt = ?, must_reset = 0 WHERE id = ?', hash, salt, user.id);
  res.json({ ok: true });
});

export default router;
