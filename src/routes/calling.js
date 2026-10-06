import { Router } from 'express';
import { get, run, all, listForCaller, callerStats, schoolDetail } from '../db.js';
import { requireUser } from '../auth.js';
import { dialable, normalizeMsisdn } from '../config.js';
import { startCall, sendTemplate } from '../infobip.js';

const router = Router();
router.use(requireUser);

const OUTCOMES = new Set(['vacancy', 'no_vacancy', 'callback', 'no_answer']);

/**
 * A caller may only act on the schools assigned to them. The list already
 * shows only their own, but the API has to enforce it too — otherwise anyone
 * signed in could call, log or message any school in the database just by
 * changing the id in the URL.
 */
function mySchool(req, res, id) {
  const school = get('SELECT * FROM schools WHERE id = ?', Number(id));
  if (!school) {
    res.status(404).json({ error: 'School not found' });
    return null;
  }
  if (req.user.role !== 'admin' && school.assigned_to !== req.user.id) {
    res.status(403).json({ error: 'That school is assigned to another caller' });
    return null;
  }
  return school;
}

/* The caller's own list and counters. */
router.get('/my/schools', (req, res) => {
  res.json({
    stats: callerStats(req.user.id),
    schools: listForCaller(req.user.id).map(s => ({ ...s, dial: dialable(s.phone, s.std_code) })),
  });
});

/* One school, with its full history — what we already know before dialling. */
router.get('/schools/:id', (req, res) => {
  const school = schoolDetail(Number(req.params.id));
  if (!school) return res.status(404).json({ error: 'School not found' });
  if (req.user.role !== 'admin' && school.assigned_to !== req.user.id) {
    return res.status(403).json({ error: 'That school is assigned to another caller' });
  }
  res.json({ school: { ...school, dial: dialable(school.phone, school.std_code) } });
});

/* Start a call. Opens the call row immediately so nothing is lost if the
   caller closes the tab before logging the outcome. */
router.post('/schools/:id/call', async (req, res) => {
  const school = mySchool(req, res, req.params.id);
  if (!school) return;

  const number = dialable(school.phone, school.std_code);
  if (!number) return res.status(400).json({ error: 'This school has no phone number on record' });

  const me = get('SELECT mobile FROM users WHERE id = ?', req.user.id);

  let result;
  try {
    result = await startCall({ agentNumber: me?.mobile || '', schoolNumber: number });
  } catch (e) {
    return res.status(502).json({ error: `Could not start the call: ${e.message}` });
  }

  const info = run(
    'INSERT INTO calls (school_id, user_id, provider_id) VALUES (?, ?, ?)',
    school.id, req.user.id, result.providerId
  );

  res.json({
    callId: Number(info.lastInsertRowid),
    mode: result.mode,
    dial: result.dial,            // manual mode only
    school: { id: school.id, name: school.name, number },
  });
});

/* Log the outcome. This is what the whole app exists to capture. */
router.post('/calls/:id/outcome', (req, res) => {
  const call = get('SELECT * FROM calls WHERE id = ?', Number(req.params.id));
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (call.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'That call belongs to another caller' });
  }

  const outcome = String(req.body?.outcome || '');
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'Pick an outcome' });

  const subject = req.body?.subject ? String(req.body.subject).slice(0, 120) : null;
  const grade = req.body?.grade ? String(req.body.grade).slice(0, 120) : null;
  const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
  const followUp = req.body?.followUpOn ? String(req.body.followUpOn).slice(0, 10) : null;
  const duration = Number.isFinite(+req.body?.durationS) ? Math.max(0, +req.body.durationS) : null;

  run(
    `UPDATE calls
        SET outcome = ?, subject = ?, grade = ?, note = ?, follow_up_on = ?,
            duration_s = ?, ended_at = datetime('now')
      WHERE id = ?`,
    outcome, subject, grade, note, followUp, duration, call.id
  );

  run(
    `UPDATE schools
        SET status = ?, last_outcome = ?, next_action_on = ?
      WHERE id = ?`,
    outcome === 'callback' || outcome === 'no_answer' ? 'callback' : 'done',
    outcome, followUp, call.school_id
  );

  // A WhatsApp number given during the call is consent to message them.
  if (req.body?.waNumber) {
    try {
      run('UPDATE schools SET wa_number = ? WHERE id = ?', normalizeMsisdn(req.body.waNumber), call.school_id);
    } catch { /* a half-typed number shouldn't fail the outcome save */ }
  }

  res.json({ ok: true, stats: callerStats(req.user.id) });
});

/* Send an approved template to the school. */
router.post('/schools/:id/whatsapp', async (req, res) => {
  const school = mySchool(req, res, req.params.id);
  if (!school) return;

  const to = req.body?.to || school.wa_number;
  if (!to) return res.status(400).json({ error: 'No WhatsApp number for this school yet' });

  const template = String(req.body?.template || '').trim();
  if (!template) return res.status(400).json({ error: 'Pick a template' });
  const placeholders = Array.isArray(req.body?.placeholders) ? req.body.placeholders : [];

  let sent;
  try {
    sent = await sendTemplate(to, template, placeholders);
  } catch (e) {
    run(
      'INSERT INTO messages (school_id, user_id, to_number, template, status, error) VALUES (?,?,?,?,?,?)',
      school.id, req.user.id, String(to), template, 'FAILED', e.message
    );
    return res.status(502).json({ error: `WhatsApp did not go out: ${e.message}` });
  }

  run(
    'INSERT INTO messages (school_id, user_id, to_number, template, provider_id, status) VALUES (?,?,?,?,?,?)',
    school.id, req.user.id, normalizeMsisdn(to), template, sent.providerId, sent.status || 'SENT'
  );
  if (!school.wa_number) run('UPDATE schools SET wa_number = ? WHERE id = ?', normalizeMsisdn(to), school.id);

  res.json({ ok: true, status: sent.status });
});

/* Templates the caller can pick from. Names match the live WABA. */
router.get('/templates', (_req, res) => {
  res.json({
    templates: [
      { name: 'check_vacancy_in_school', label: 'Ask about a vacancy', placeholders: ['School name', 'Subject', 'Grade'] },
      { name: 'school_welcome_message', label: 'Welcome a new school', placeholders: ['School name'] },
      { name: 'post_jobs_limk', label: 'Invite them to post jobs', placeholders: [] },
    ],
  });
});

/* Schools due for a call back today or earlier. */
router.get('/my/followups', (req, res) => {
  res.json({
    schools: all(
      `SELECT id, name, district, block, phone, std_code, next_action_on, last_outcome
         FROM schools
        WHERE assigned_to = ? AND next_action_on IS NOT NULL AND next_action_on <= date('now')
        ORDER BY next_action_on LIMIT 100`,
      req.user.id
    ),
  });
});

export default router;
