# FacultyMe Caller

A telecalling app for the FacultyMe team. A caller opens their list of schools,
dials one, logs whether there's a vacancy, and sends the WhatsApp follow-up
from the same screen. The admin adds callers, imports schools, shares them out,
and watches the day's numbers build up.

## Running it

Needs Node 22.5 or newer — the database uses Node's built-in `node:sqlite`,
so there is no native module to compile and no build step anywhere.

```bash
npm install
cp .env.example .env     # then fill it in, see below
npm run seed             # first admin + 10 real Bengaluru schools
npm start
```

- Caller app — <http://localhost:3100>
- Admin panel — <http://localhost:3100/admin>

They are two separate front-ends. The caller app and the admin panel share no
HTML, CSS or JavaScript, and neither links to the other — a caller's phone
never downloads any admin code. What they do share is one API and one database,
which is what makes a school assigned in the admin appear on the caller's list;
there is no syncing between two copies of anything.

The seed creates `admin` / `changeme123`. Change that password after the first
sign-in, or set `SEED_ADMIN_PASS` before running the seed.

The database lands in `data/caller.db`. SQLite needs real file locking, which
network drives and mounted shares do not provide — if you see `disk I/O error`
at startup, point `DB_FILE` in `.env` at a path on a local disk.

## Configuration

Everything lives in `.env`. The two that matter on day one:

| Setting | What it does |
|---|---|
| `SESSION_SECRET` | Signs session cookies. Any long random string. The app refuses to start without it. |
| `TELEPHONY_PROVIDER` | `manual` or `infobip` — see below. |

Infobip settings (`INFOBIP_BASE_URL`, `INFOBIP_API_KEY`, `WA_SENDER`) come from
the portal under Developer Tools → API Keys. The WhatsApp sender is already
live on the account.

## The two calling modes

**`manual`** — the caller's own phone dials. The app hands the number to the
phone's dialler and logs the call exactly as it would otherwise. Works today,
no Infobip Voice, no KYC, nothing to wait for. The drawback is that calls go
out from personal numbers, and at volume those get flagged as spam.

**`infobip`** — Infobip rings the caller, then bridges the school. The school
sees `VOICE_CALLER_ID`, the caller's personal number stays private, and the
call is recorded. Needs Voice activation and KYC on the Infobip account first.

Both modes write the same `calls` row. Switching over later is one line in
`.env` and a restart; no code changes, and no data to migrate.

## Getting schools in

Either upload a CSV on the admin page, or from the command line:

```bash
node scripts/import-udise.js bangalore-schools.csv
```

It takes what the UDISE puller writes — `udiseCode`, `name`, `district`,
`block`, `address`, `pincode`, `stdCode`, `phone`, `email`, `headMaster`.
Importing the same district again updates those rows rather than duplicating
them, matched on `udiseCode`.

UDISE stores a landline as a bare subscriber number with no STD code, which is
why `stdCode` is its own column. `dialable()` in `src/config.js` puts them back
together, and leaves a real mobile number alone.

Once schools are in, pick the callers on the admin page and hit **Share out
evenly**.

## How callers get in

Nobody signs themselves up. The admin adds a caller with their name and mobile;
the app generates a caller ID and a one-time password and sends both to that
mobile over WhatsApp. On first sign-in they set their own password.

If WhatsApp fails, the account is still created and the admin is shown the
password to pass on by hand — a messaging outage shouldn't block onboarding.

**Disable** ends access immediately: it deletes that user's session rows, so
the very next request they make is rejected rather than waiting for a token to
expire. That is the point of keeping sessions in the database.

One caller can be signed in on a phone and a laptop at the same time, on
purpose — calling on the phone while posting a job on the laptop is a normal
way to work. Each device gets its own session row and all state lives on the
server, so the two stay in step.

## On a phone

The caller app is installable as it stands — open it on the phone, choose **Add
to Home Screen**, and it runs full screen with its own icon.

For a proper APK the callers install from a file, see `mobile/README.md`. It
wraps this same app, so a change you deploy here reaches every phone on the next
app open without rebuilding anything.

## Webhooks

Point these at the app from the Infobip portal, and set the same
`x-webhook-secret` header on each:

| Event | Path |
|---|---|
| WhatsApp delivery reports | `POST /webhooks/status` |
| Inbound WhatsApp | `POST /webhooks/inbound` |
| Call events and recordings | `POST /webhooks/call-events` |

Each one answers `200` first and does its work afterwards, because Infobip
retries anything it doesn't get a fast acknowledgement for. Every write is safe
to repeat, so a retry can't double-count a call or a message.

## Layout

```
src/
  config.js        .env loading, phone-number handling
  db.js            schema and the queries the screens need
  auth.js          passwords, sessions, roles
  infobip.js       WhatsApp sending and click-to-call
  routes/
    auth.js        sign in, sign out, set password
    calling.js     the caller's list, calls, outcomes, WhatsApp
    admin.js       team, school import and assignment, daily report
    webhooks.js    delivery reports, inbound messages, call events
  server.js
public/
  caller/          the phone app — its own HTML, CSS and JS
  admin/           the admin panel — its own HTML, CSS and JS
scripts/
  seed.js          first admin and sample schools
  import-udise.js  CSV import
mobile/            Capacitor shell that turns the caller app into an APK
```

The only dependency is Express. Sessions, password hashing, CSV parsing and
cookie handling are a few lines each of standard library rather than four more
packages to keep patched.

## Known gaps

These are deliberately not built yet:

- **Inbound calls.** A school calling the company number isn't routed to a
  caller. Needs a Voice ring-group configuration on the Infobip side.
- **Recording playback.** Recording URLs arrive on the webhook and are stored,
  but there's no player in the app yet.
- **Job posting.** Creating a job on the school's behalf, with the school
  confirming over WhatsApp, isn't wired to the FacultyMe platform.
- **AI call scoring.** Worth testing transcription accuracy on real
  Hindi/Kannada/English calls before building anything on top of it.
