import { config, normalizeMsisdn } from './config.js';

/**
 * Infobip REST client.
 *
 * WhatsApp works today — the sender is already live on the account.
 * Calling has two modes, set by TELEPHONY_PROVIDER:
 *
 *   manual   the caller's own phone dials. The app returns a tel: number and
 *            logs the call; no Infobip Voice, no KYC. This is what runs on
 *            day one.
 *   infobip  Infobip rings the caller first, then bridges the school. The
 *            school sees VOICE_CALLER_ID, the caller's personal number stays
 *            private, and the call is recorded. Needs Voice activation + KYC.
 *
 * Both modes write the same `calls` row, so the rest of the app does not care
 * which one is active and switching over later changes nothing but .env.
 */

async function api(method, path, body) {
  if (!config.infobipApiKey) throw new Error('INFOBIP_API_KEY is not set');
  const res = await fetch(config.infobipBaseUrl + path, {
    method,
    headers: {
      Authorization: `App ${config.infobipApiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.requestError?.serviceException?.text || `Infobip ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ── WhatsApp ────────────────────────────────────────────────────────── */

export async function sendTemplate(to, templateName, placeholders = [], language = 'en') {
  const payload = {
    messages: [{
      from: config.waSender,
      to: normalizeMsisdn(to),
      content: {
        templateName,
        templateData: { body: { placeholders: placeholders.map(String) } },
        language,
      },
    }],
  };
  const out = await api('POST', '/whatsapp/1/message/template', payload);
  const m = out?.messages?.[0];
  return { providerId: m?.messageId, status: m?.status?.name || m?.status?.groupName };
}

export async function sendText(to, text) {
  const out = await api('POST', '/whatsapp/1/message/text', {
    from: config.waSender,
    to: normalizeMsisdn(to),
    content: { text },
  });
  return { providerId: out?.messageId, status: out?.status?.name };
}

/* ── Calling ─────────────────────────────────────────────────────────── */

/**
 * Connects a caller to a school.
 * Returns { mode, providerId, dial } — `dial` is set only in manual mode,
 * where the browser hands it to the phone's dialler.
 */
export async function startCall({ agentNumber, schoolNumber }) {
  if (config.telephony !== 'infobip') {
    return { mode: 'manual', providerId: null, dial: schoolNumber };
  }

  // Ring the agent; once they answer, Infobip dials the school and bridges.
  const out = await api('POST', '/calls/1/calls', {
    endpoint: { type: 'PHONE', phoneNumber: '+' + normalizeMsisdn(agentNumber) },
    from: config.voiceCallerId,
    callsConfigurationId: process.env.INFOBIP_CALLS_CONFIG_ID || undefined,
    platform: { applicationId: process.env.INFOBIP_APPLICATION_ID || undefined },
    recording: { recordingType: 'AUDIO' },
    customData: { connectTo: '+' + normalizeMsisdn(schoolNumber) },
  });

  return { mode: 'infobip', providerId: out?.id || null, dial: null };
}
