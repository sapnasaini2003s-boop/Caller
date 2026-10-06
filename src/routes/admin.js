import { Router } from 'express';
import { get, all, run, today } from '../db.js';
import { requireAdmin, hashPassword, tempPassword } from '../auth.js';
import { config, normalizeMsisdn } from '../config.js';
import { sendText } from '../infobip.js';

const router = Router();
router.use(requireAdmin);

/* ── team ────────────────────────────────────────────────────────────── */

router.get('/users', (_req, res) => {
  const day = today();
  const rows = all(
    `SELECT u.id, u.username, u.name, u.mobile, u.area, u.role, u.active, u.must_reset,
            (SELECT COUNT(*) FROM schools s WHERE s.assigned_to = u.id) AS assigned,
            (SELECT COUNT(DISTINCT c.school_id) FROM calls c
              WHERE c.user_id = u.id AND date(c.started_at) = ?) AS called,
            (SELECT COUNT(*) FROM calls c
              WHERE c.user_id = u.id AND date(c.started_at) = ? AND c.outcome = 'vacancy') AS vacancies
       FROM users u ORDER BY u.active DESC, u.name`,
    day, day
  );
  res.json({ users: rows });
});

router.post('/users', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const mobile = String(req.body?.mobile || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a name' });
  if (!mobile) return res.status(400).json({ error: 'Enter a mobile number — the login goes there' });

  let msisdn;
  try { msisdn = normalizeMsisdn(mobile); }
  catch { return res.status(400).json({ error: 'That mobile number does not look right' }); }

  const area = String(req.body?.area || '').trim() || null;
  const role = req.body?.role === 'admin' ? 'admin' : 'caller';

  // first.last from the name, with a number appended if it is taken
  const base = name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).slice(0, 2).join('.') || 'caller';
  let username = base, n = 1;
  while (get('SELECT 1 FROM users WHERE username = ?', username)) username = `${base}${++n}`;

  const temp = tempPassword();
  const { hash, salt } = hashPassword(temp);
  const info = run(
    `INSERT INTO users (username, name, mobile, area, role, pass_hash, pass_salt, must_reset)
     VALUES (?,?,?,?,?,?,?,1)`,
    username, name, msisdn, area, role, hash, salt
  );

  // Send the login over WhatsApp. If that fails the account still exists —
  // the admin gets the password back and can pass it on themselves.
  let delivered = false, deliveryError = null;
  try {
    await sendText(msisdn,
      `FacultyMe Caller\n\nYour login\nCaller ID: ${username}\nPassword: ${temp}\n\n` +
      `You will be asked to set your own password when you sign in.`);
    delivered = true;
  } catch (e) {
    deliveryError = e.message;
  }

  res.json({
    user: { id: Number(info.lastInsertRowid), username, name, mobile: msisdn, area, role },
    delivered,
    deliveryError,
    tempPassword: delivered ? undefined : temp,
  });
});

router.post('/users/:id/active', (req, res) => {
  const id = Number(req.params.id);
  const active = req.body?.active ? 1 : 0;
  if (id === req.user.id && !active) {
    return res.status(400).json({ error: 'You cannot switch off your own account' });
  }
  run('UPDATE users SET active = ? WHERE id = ?', active, id);
  if (!active) run('DELETE FROM sessions WHERE user_id = ?', id);   // signs them out now
  res.json({ ok: true });
});

router.post('/users/:id/reset', async (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user' });

  const temp = tempPassword();
  const { hash, salt } = hashPassword(temp);
  run('UPDATE users SET pass_hash = ?, pass_salt = ?, must_reset = 1 WHERE id = ?', hash, salt, user.id);
  run('DELETE FROM sessions WHERE user_id = ?', user.id);

  let delivered = false;
  try {
    await sendText(user.mobile, `FacultyMe Caller\n\nNew password: ${temp}\nCaller ID: ${user.username}`);
    delivered = true;
  } catch { /* fall through and hand it to the admin */ }

  res.json({ ok: true, delivered, tempPassword: delivered ? undefined : temp });
});

/* ── schools ─────────────────────────────────────────────────────────── */

/** Bulk import. Accepts the columns the UDISE puller writes. */
router.post('/schools/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to import' });

  const stmt = `
    INSERT INTO schools (udise_code, name, district, block, address, pincode,
                         std_code, phone, email, head_master, management)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(udise_code) DO UPDATE SET
      name = excluded.name, district = excluded.district, block = excluded.block,
      address = excluded.address, pincode = excluded.pincode,
      std_code = excluded.std_code, phone = excluded.phone,
      email = excluded.email, head_master = excluded.head_master,
      management = excluded.management`;

  let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const name = String(r.name || r.schoolName || '').trim();
    if (!name) { skipped++; continue; }

    const code = String(r.udiseCode || r.udise_code || '').trim() || null;

    /* SQLite treats every NULL as distinct, so ON CONFLICT(udise_code) never
       fires for a row without a code — re-importing would quietly duplicate
       it. Match those on name and pincode instead. */
    if (!code) {
      const existing = get(
        'SELECT id FROM schools WHERE udise_code IS NULL AND name = ? AND IFNULL(pincode, \'\') = ?',
        name, r.pincode ? String(r.pincode) : ''
      );
      if (existing) {
        run(
          `UPDATE schools SET district = ?, block = ?, address = ?, std_code = ?,
                              phone = ?, email = ?, head_master = ?, management = ?
            WHERE id = ?`,
          r.district || null, r.block || null, r.address || null,
          r.stdCode || r.std_code || null,
          r.phone ? String(r.phone) : null,
          r.email || null, r.headMaster || r.head_master || null,
          r.management || null, existing.id
        );
        updated++;
        continue;
      }
    }

    run(stmt,
      code,
      name,
      r.district || null, r.block || null, r.address || null,
      r.pincode ? String(r.pincode) : null,
      r.stdCode || r.std_code || null,
      r.phone ? String(r.phone) : null,
      r.email || null, r.headMaster || r.head_master || null,
      r.management || null
    );
    added++;
  }
  res.json({ added, updated, skipped, total: get('SELECT COUNT(*) n FROM schools').n });
});

/** Share the unassigned schools out evenly across the chosen callers. */
router.post('/schools/assign', (req, res) => {
  const userIds = (Array.isArray(req.body?.userIds) ? req.body.userIds : []).map(Number).filter(Boolean);
  if (!userIds.length) return res.status(400).json({ error: 'Pick at least one caller' });

  const limit = Number(req.body?.limit) || 500;
  const district = req.body?.district ? String(req.body.district) : null;

  const pool = all(
    `SELECT id FROM schools
      WHERE assigned_to IS NULL AND status = 'pending' ${district ? 'AND district = ?' : ''}
      ORDER BY name LIMIT ?`,
    ...(district ? [district, limit] : [limit])
  );
  if (!pool.length) return res.json({ assigned: 0, note: 'No unassigned schools match' });

  pool.forEach((s, i) => run('UPDATE schools SET assigned_to = ? WHERE id = ?', userIds[i % userIds.length], s.id));
  res.json({ assigned: pool.length, perCaller: Math.ceil(pool.length / userIds.length) });
});

router.post('/schools/:id/assign', (req, res) => {
  const userId = req.body.userId ? Number(req.body.userId) : null;
  run('UPDATE schools SET assigned_to = ? WHERE id = ?', userId, req.params.id);
  res.json({ ok: true });
});

router.get('/schools', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  res.json({
    schools: all(
      `SELECT s.id, s.udise_code, s.name, s.district, s.block, s.phone, s.std_code,
              s.status, s.last_outcome, u.name AS caller
         FROM schools s LEFT JOIN users u ON u.id = s.assigned_to
        WHERE s.name LIKE ? OR s.udise_code LIKE ? OR s.district LIKE ?
        ORDER BY s.name LIMIT 200`,
      q, q, q
    ),
    counts: get(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN assigned_to IS NULL THEN 1 ELSE 0 END) unassigned,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done
         FROM schools`
    ),
  });
});

/* ── report ──────────────────────────────────────────────────────────── */

router.get('/report', (req, res) => {
  const day = String(req.query.date || today()).slice(0, 10);
  res.json({
    date: day,
    totals: get(
      `SELECT COUNT(*) calls,
              COUNT(DISTINCT school_id) schools,
              SUM(CASE WHEN outcome = 'vacancy' THEN 1 ELSE 0 END) vacancies,
              SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) no_answer
         FROM calls WHERE date(started_at) = ?`,
      day
    ),
    vacancies: all(
      `SELECT s.name, s.district, c.subject, c.grade, c.note, u.name AS caller, c.started_at
         FROM calls c JOIN schools s ON s.id = c.school_id JOIN users u ON u.id = c.user_id
        WHERE date(c.started_at) = ? AND c.outcome = 'vacancy'
        ORDER BY c.started_at DESC LIMIT 100`,
      day
    ),
  });
});

/* ── call history ────────────────────────────────────────────────────── */

const OUTCOMES = ['vacancy', 'no_vacancy', 'callback', 'no_answer'];

function historyWhere(q) {
  const where = [], args = [];
  if (q.from) { where.push('date(c.started_at) >= ?'); args.push(String(q.from).slice(0, 10)); }
  if (q.to) { where.push('date(c.started_at) <= ?'); args.push(String(q.to).slice(0, 10)); }
  if (q.userId) { where.push('c.user_id = ?'); args.push(Number(q.userId)); }
  if (q.outcome && OUTCOMES.includes(q.outcome)) { where.push('c.outcome = ?'); args.push(q.outcome); }
  if (q.q) {
    where.push('(s.name LIKE ? OR s.udise_code LIKE ? OR c.note LIKE ? OR c.subject LIKE ?)');
    const like = `%${String(q.q).trim()}%`;
    args.push(like, like, like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

router.get('/calls', (req, res) => {
  const { sql, args } = historyWhere(req.query);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const offset = Math.max(0, Number(req.query.offset) || 0);

  res.json({
    total: get(
      `SELECT COUNT(*) n FROM calls c JOIN schools s ON s.id = c.school_id ${sql}`, ...args
    ).n,
    calls: all(
      `SELECT c.id, c.started_at, c.duration_s, c.outcome, c.subject, c.grade, c.note,
              c.recording_url, s.name AS school, s.district, s.udise_code, u.name AS caller
         FROM calls c
         JOIN schools s ON s.id = c.school_id
         JOIN users u ON u.id = c.user_id
         ${sql}
        ORDER BY c.started_at DESC
        LIMIT ? OFFSET ?`,
      ...args, limit, offset
    ),
  });
});

/* ── trends ──────────────────────────────────────────────────────────── */

router.get('/trends', (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));

  const rows = all(
    `SELECT date(started_at) AS day,
            COUNT(*) AS calls,
            SUM(CASE WHEN outcome = 'vacancy' THEN 1 ELSE 0 END) AS vacancies,
            SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) AS no_answer
       FROM calls
      WHERE date(started_at) >= date('now', ?)
      GROUP BY day ORDER BY day`,
    `-${days - 1} days`
  );

  // Fill the gaps, so quiet days are visibly zero instead of missing.
  const byDay = new Map(rows.map(r => [r.day, r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const r = byDay.get(d);
    series.push({ day: d, calls: r?.calls || 0, vacancies: r?.vacancies || 0, noAnswer: r?.no_answer || 0 });
  }

  res.json({
    days,
    series,
    byCaller: all(
      `SELECT u.name AS caller,
              COUNT(c.id) AS calls,
              COUNT(DISTINCT c.school_id) AS schools,
              SUM(CASE WHEN c.outcome = 'vacancy' THEN 1 ELSE 0 END) AS vacancies,
              SUM(CASE WHEN c.outcome = 'no_answer' THEN 1 ELSE 0 END) AS no_answer,
              CAST(AVG(c.duration_s) AS INTEGER) AS avg_duration
         FROM calls c JOIN users u ON u.id = c.user_id
        WHERE date(c.started_at) >= date('now', ?)
        GROUP BY u.id ORDER BY vacancies DESC, calls DESC`,
      `-${days - 1} days`
    ),
  });
});

/* ── export ──────────────────────────────────────────────────────────── */

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel opens UTF-8 school names correctly instead of mojibake.
  res.send('﻿' + [header.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n'));
}

router.get('/export/calls.csv', (req, res) => {
  const { sql, args } = historyWhere(req.query);
  const rows = all(
    `SELECT c.started_at, u.name AS caller, s.udise_code, s.name AS school, s.district, s.block,
            s.phone, s.std_code, c.outcome, c.subject, c.grade, c.duration_s, c.note, c.follow_up_on
       FROM calls c JOIN schools s ON s.id = c.school_id JOIN users u ON u.id = c.user_id
       ${sql}
      ORDER BY c.started_at DESC LIMIT 20000`,
    ...args
  );
  sendCsv(res, `calls-${today()}.csv`,
    ['Date', 'Caller', 'UDISE code', 'School', 'District', 'Block', 'Phone', 'Outcome', 'Subject', 'Grade', 'Duration (s)', 'Note', 'Follow up on'],
    rows.map(r => [
      r.started_at, r.caller, r.udise_code, r.school, r.district, r.block,
      r.phone ? `${r.std_code || ''}${r.phone}` : '',
      r.outcome, r.subject, r.grade, r.duration_s, r.note, r.follow_up_on,
    ])
  );
});

router.get('/export/vacancies.csv', (req, res) => {
  const q = { ...req.query, outcome: 'vacancy' };
  const { sql, args } = historyWhere(q);
  const rows = all(
    `SELECT c.started_at, s.name AS school, s.district, s.block, s.email, s.wa_number,
            s.phone, s.std_code, c.subject, c.grade, c.note, u.name AS caller
       FROM calls c JOIN schools s ON s.id = c.school_id JOIN users u ON u.id = c.user_id
       ${sql}
      ORDER BY c.started_at DESC LIMIT 20000`,
    ...args
  );
  sendCsv(res, `vacancies-${today()}.csv`,
    ['Date', 'School', 'District', 'Block', 'Subject', 'Grade', 'Phone', 'WhatsApp', 'Email', 'Note', 'Caller'],
    rows.map(r => [
      r.started_at, r.school, r.district, r.block, r.subject, r.grade,
      r.phone ? `${r.std_code || ''}${r.phone}` : '', r.wa_number, r.email, r.note, r.caller,
    ])
  );
});

/* ── recording playback ──────────────────────────────────────────────── */

/**
 * Infobip recording URLs need the API key, so the browser cannot fetch one
 * directly. This streams it through the server instead, which also keeps the
 * key out of the page. Range requests are passed along so the audio element
 * can seek.
 */
router.get('/calls/:id/recording', async (req, res) => {
  const call = get('SELECT recording_url FROM calls WHERE id = ?', Number(req.params.id));
  if (!call?.recording_url) return res.status(404).json({ error: 'No recording for this call' });

  try {
    const upstream = await fetch(call.recording_url, {
      headers: {
        Authorization: `App ${config.infobipApiKey}`,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
    if (!upstream.ok) return res.status(502).json({ error: `Recording unavailable (${upstream.status})` });

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    res.status(502).json({ error: `Could not fetch the recording: ${e.message}` });
  }
});

export default router;
