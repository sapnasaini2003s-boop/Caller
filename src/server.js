import path from 'node:path';
import express from 'express';
import { config, assertConfig, ROOT } from './config.js';
import { attachUser } from './auth.js';
import { get } from './db.js';

import authRoutes from './routes/auth.js';
import callingRoutes from './routes/calling.js';
import adminRoutes from './routes/admin.js';
import webhookRoutes from './routes/webhooks.js';

assertConfig();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));   // bulk school imports arrive here

/* Cookies — a dozen lines instead of a dependency. */
app.use((req, _res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    req.cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  next();
});

app.use('/webhooks', webhookRoutes);        // before auth — Infobip has no cookie
app.use(attachUser);

/* Before the routers below — callingRoutes guards everything under /api. */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    telephony: config.telephony,
    schools: get('SELECT COUNT(*) n FROM schools').n,
    users: get('SELECT COUNT(*) n FROM users').n,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', callingRoutes);

/* ── two separate front-ends, one API ─────────────────────────────────
   The caller app and the admin panel share no files. The phone only ever
   downloads what is under public/caller, so the admin screens are not
   sitting on a caller's device at all. */

const CALLER = path.join(ROOT, 'public', 'caller');
const ADMIN = path.join(ROOT, 'public', 'admin');

// redirect:false so /admin serves the panel instead of bouncing to /admin/
app.use('/admin', express.static(ADMIN, { redirect: false }));
app.get(/^\/admin(\/.*)?$/, (_req, res) => res.sendFile(path.join(ADMIN, 'index.html')));

app.use(express.static(CALLER));
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'No such endpoint' });
  // A missing file is a 404, not the app shell. Returning HTML for
  // /whatever.css only hides typos and broken references.
  if (path.extname(req.path)) return res.status(404).send('Not found');
  res.sendFile(path.join(CALLER, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

app.listen(config.port, () => {
  console.log(`\n  Caller app  →  http://localhost:${config.port}`);
  console.log(`  Admin panel →  http://localhost:${config.port}/admin`);
  console.log(`  calling mode   ${config.telephony}\n`);
});
