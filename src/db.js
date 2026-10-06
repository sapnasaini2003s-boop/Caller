import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  mobile      TEXT,
  area        TEXT,
  role        TEXT NOT NULL DEFAULT 'caller',   -- caller | admin
  pass_hash   TEXT,
  pass_salt   TEXT,
  must_reset  INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  device      TEXT
);

CREATE TABLE IF NOT EXISTS schools (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  udise_code    TEXT UNIQUE,
  name          TEXT NOT NULL,
  district      TEXT,
  block         TEXT,
  address       TEXT,
  pincode       TEXT,
  std_code      TEXT,
  phone         TEXT,
  email         TEXT,
  head_master   TEXT,
  management    TEXT,
  wa_number     TEXT,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | done | callback
  last_outcome  TEXT,
  next_action_on TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  direction     TEXT NOT NULL DEFAULT 'out',      -- out | in
  provider_id   TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  duration_s    INTEGER,
  outcome       TEXT,                             -- vacancy | no_vacancy | callback | no_answer
  subject       TEXT,
  grade         TEXT,
  note          TEXT,
  follow_up_on  TEXT,
  recording_url TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id   INTEGER REFERENCES schools(id) ON DELETE SET NULL,
  user_id     INTEGER REFERENCES users(id),
  to_number   TEXT NOT NULL,
  template    TEXT,
  body        TEXT,
  provider_id TEXT UNIQUE,
  status      TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schools_assigned ON schools(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_calls_user_time  ON calls(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_school     ON calls(school_id, started_at);
`);

/* ── helpers ─────────────────────────────────────────────────────────── */

export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);

export const today = () => new Date().toISOString().slice(0, 10);

/** Schools assigned to one caller, unfinished first, then by name. */
export function listForCaller(userId) {
  return all(
    `SELECT id, udise_code, name, district, block, address, pincode,
            std_code, phone, email, head_master, wa_number,
            status, last_outcome, next_action_on
       FROM schools
      WHERE assigned_to = ?
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'callback' THEN 1 ELSE 2 END,
               name
      LIMIT 300`,
    userId
  );
}

/** Counters shown at the top of the caller's list and in the admin table. */
export function callerStats(userId, day = today()) {
  const assigned = get('SELECT COUNT(*) n FROM schools WHERE assigned_to = ?', userId).n;
  const row = get(
    `SELECT COUNT(*) calls,
            COUNT(DISTINCT school_id) schools,
            SUM(CASE WHEN outcome = 'vacancy' THEN 1 ELSE 0 END) vacancies
       FROM calls
      WHERE user_id = ? AND date(started_at) = ?`,
    userId, day
  );
  return {
    assigned,
    called: row.schools || 0,
    calls: row.calls || 0,
    vacancies: row.vacancies || 0,
    remaining: Math.max(0, assigned - (row.schools || 0)),
  };
}

/** Everything known about one school, for the caller's screen. */
export function schoolDetail(id) {
  const school = get('SELECT * FROM schools WHERE id = ?', id);
  if (!school) return null;
  school.history = all(
    `SELECT c.id, c.started_at, c.duration_s, c.outcome, c.subject, c.grade,
            c.note, c.recording_url, u.name AS caller
       FROM calls c JOIN users u ON u.id = c.user_id
      WHERE c.school_id = ?
      ORDER BY c.started_at DESC LIMIT 20`,
    id
  );
  school.messages = all(
    `SELECT template, status, created_at FROM messages
      WHERE school_id = ? ORDER BY id DESC LIMIT 10`,
    id
  );
  return school;
}
