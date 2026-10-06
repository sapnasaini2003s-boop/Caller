import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { get, run } from '../db.js';

const router = Router();

/* Infobip retries anything it does not get a fast 200 for, so every handler
   here acknowledges first and does its work afterwards, and every write is
   safe to repeat. */

let warnedNoSecret = false;

function checkSecret(req, res) {
  const want = config.webhookSecret;
  if (!want) {
    // Refuse rather than accept. An open webhook lets anyone post fake
    // delivery reports and call events straight into the database.
    if (!warnedNoSecret) {
      console.error('! WEBHOOK_SECRET is not set — webhooks are refused until it is.');
      warnedNoSecret = true;
    }
    res.sendStatus(503);
    return false;
  }
  const got = String(req.get('x-webhook-secret') || '');
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.sendStatus(401);
    return false;
  }
  return true;
}

/** Delivery reports for WhatsApp messages. */
router.post('/status', (req, res) => {
  if (!checkSecret(req, res)) return;
  res.sendStatus(200);

  for (const r of req.body?.results || []) {
    const id = r.messageId;
    if (!id) continue;
    run(
      'UPDATE messages SET status = ?, error = ? WHERE provider_id = ?',
      r.status?.name || r.status?.groupName || null,
      r.error?.name || null,
      id
    );
  }
});

/** Inbound WhatsApp — a school replying. */
router.post('/inbound', (req, res) => {
  if (!checkSecret(req, res)) return;
  res.sendStatus(200);

  for (const r of req.body?.results || []) {
    const from = String(r.from || '').replace(/\D/g, '');
    if (!from) continue;
    const text = r.message?.text || r.message?.type || '';
    const school = get('SELECT id FROM schools WHERE wa_number = ?', from);
    run(
      'INSERT OR IGNORE INTO messages (school_id, to_number, body, provider_id, status) VALUES (?,?,?,?,?)',
      school?.id || null, from, String(text).slice(0, 2000), r.messageId || null, 'INBOUND'
    );
  }
});

/** Call events from Infobip Voice: ringing, answered, finished, recording. */
router.post('/call-events', (req, res) => {
  if (!checkSecret(req, res)) return;
  res.sendStatus(200);

  const events = Array.isArray(req.body?.results) ? req.body.results : [req.body];
  for (const e of events) {
    const providerId = e?.callId || e?.call?.id;
    if (!providerId) continue;

    const call = get('SELECT id FROM calls WHERE provider_id = ?', providerId);
    if (!call) continue;

    const duration = Number(e?.call?.duration ?? e?.duration);
    const recording = e?.recording?.url || e?.recordingUrl || null;
    const finished = /FINISHED|COMPLETED|HANGUP/i.test(String(e?.type || e?.state || ''));

    run(
      `UPDATE calls
          SET duration_s   = COALESCE(?, duration_s),
              recording_url = COALESCE(?, recording_url),
              ended_at      = CASE WHEN ? THEN COALESCE(ended_at, datetime('now')) ELSE ended_at END
        WHERE id = ?`,
      Number.isFinite(duration) ? duration : null,
      recording,
      finished ? 1 : 0,
      call.id
    );
  }
});

export default router;
