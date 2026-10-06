import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Tiny .env reader — avoids a dependency for six lines of work. */
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;      // real env wins
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}
loadEnv();

export const config = {
  port: Number(process.env.PORT || 3100),
  sessionSecret: process.env.SESSION_SECRET || '',
  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'caller.db'),

  infobipBaseUrl: (process.env.INFOBIP_BASE_URL || '').replace(/\/+$/, ''),
  infobipApiKey: process.env.INFOBIP_API_KEY || '',
  waSender: process.env.WA_SENDER || '',

  telephony: (process.env.TELEPHONY_PROVIDER || 'manual').toLowerCase(),
  voiceCallerId: process.env.VOICE_CALLER_ID || '',

  webhookSecret: process.env.WEBHOOK_SECRET || '',
  defaultCc: '91',
};

/* Fail loudly at boot rather than mysteriously on the first request. */
export function assertConfig() {
  const missing = [];
  if (!config.sessionSecret || config.sessionSecret.includes('change-me')) {
    missing.push('SESSION_SECRET (set it to a long random string)');
  }
  if (config.telephony === 'infobip' && !config.voiceCallerId) {
    missing.push('VOICE_CALLER_ID (required when TELEPHONY_PROVIDER=infobip)');
  }
  if (missing.length) {
    console.error('\nCannot start — fix these in .env:\n  ' + missing.join('\n  ') + '\n');
    process.exit(1);
  }
  if (!config.infobipApiKey) {
    console.warn('! INFOBIP_API_KEY is not set — WhatsApp sending and Infobip calling will fail.');
  }
}

/**
 * E.164 digits, no "+". Will not prefix a country code that is already there,
 * which is the mistake that produces 9191... numbers.
 */
export function normalizeMsisdn(input, cc = config.defaultCc) {
  const d = String(input ?? '').replace(/\D/g, '');
  if (!d) throw new Error('Empty phone number');
  if (d.startsWith(cc) && d.length > 10) return d;
  if (d.length === 10) return cc + d;
  return d;
}

/**
 * UDISE stores landlines as a bare subscriber number with no STD code, so a
 * school row carries its code separately. Produces something dialable.
 */
export function dialable(phone, stdCode) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && /^[6-9]/.test(d)) return config.defaultCc + d;   // mobile
  if (d.length >= 11) return d.replace(/^0/, config.defaultCc);
  const std = String(stdCode ?? '').replace(/\D/g, '').replace(/^0/, '');
  return std ? config.defaultCc + std + d : d;
}
