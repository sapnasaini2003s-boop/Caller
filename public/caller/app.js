/* FacultyMe Caller — caller app. No build step, no framework. */

const $ = id => document.getElementById(id);
const VIEWS = ['viewLogin', 'viewReset', 'viewList', 'viewSchool', 'viewOutcome', 'viewWhatsApp'];

const state = {
  user: null,
  school: null,     // school currently open
  callId: null,
  startedAt: null,
  outcome: null,
  templates: [],
};

/* ── plumbing ────────────────────────────────────────────────────────── */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body is fine */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function show(view) {
  VIEWS.forEach(v => { $(v).hidden = v !== view; });
  $('topbar').hidden = view === 'viewLogin';
  window.scrollTo(0, 0);
}

let flashTimer;
function flash(text, kind = 'ok') {
  clearTimeout(flashTimer);
  $('flash').innerHTML = `<div class="msg ${kind}">${escapeHtml(text)}</div>`;
  flashTimer = setTimeout(() => { $('flash').innerHTML = ''; }, kind === 'err' ? 7000 : 3500);
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Mobiles read as +91 98860 41234; landlines as +91 80 2648 4933, because a
   UDISE landline is an STD code plus a subscriber number, not a 10-digit block. */
const prettyNumber = d => {
  const s = String(d || '').replace(/\D/g, '');
  if (!s.startsWith('91') || s.length <= 10) return s;
  const rest = s.slice(2);
  if (rest.length === 10 && /^[6-9]/.test(rest)) return `+91 ${rest.slice(0, 5)} ${rest.slice(5)}`;
  const std = rest.length >= 10 ? rest.slice(0, 2) : rest.slice(0, 3);
  const sub = rest.slice(std.length);
  return `+91 ${std} ${sub.length > 4 ? sub.slice(0, sub.length - 4) + ' ' + sub.slice(-4) : sub}`;
};

const OUTCOME_LABEL = {
  vacancy: 'Vacancy', no_vacancy: 'No vacancy', callback: 'Call back', no_answer: 'No answer',
};

/* ── sign in ─────────────────────────────────────────────────────────── */

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/auth/login', {
      username: $('username').value, password: $('password').value,
    });
    state.user = out.user;
    $('password').value = '';
    afterSignIn(out.mustReset);
  } catch (err) {
    flash(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('signOut').addEventListener('click', async e => {
  e.preventDefault();
  await api('POST', '/api/auth/logout').catch(() => {});
  state.user = null;
  show('viewLogin');
});

$('resetForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('newPass').value !== $('newPass2').value) return flash('The two passwords do not match', 'err');
  try {
    await api('POST', '/api/auth/password', { password: $('newPass').value });
    flash('Password saved');
    loadList();
  } catch (err) { flash(err.message, 'err'); }
});

function afterSignIn(mustReset) {
  $('whoName').textContent = state.user.name + (state.user.area ? ` · ${state.user.area}` : '');
  if (mustReset) { show('viewReset'); $('newPass').focus(); return; }
  loadList();
}

/* ── my list ─────────────────────────────────────────────────────────── */

async function loadList() {
  const { stats, schools } = await api('GET', '/api/my/schools');
  $('sAssigned').textContent = stats.assigned;
  $('sCalled').textContent = stats.called;
  $('sVac').textContent = stats.vacancies;
  $('sLeft').textContent = stats.remaining;
  $('todayLabel').textContent = new Date().toLocaleDateString('en-IN',
    { weekday: 'long', day: 'numeric', month: 'short' });

  $('schoolList').innerHTML = schools.length ? schools.map(s => `
    <button class="schoolrow ${s.status}" data-id="${s.id}">
      <div class="nm">${escapeHtml(s.name)}</div>
      <div class="dt">
        <span class="mono">${escapeHtml(s.udise_code || '')}</span>
        ${s.block ? `<span>${escapeHtml(s.block)}</span>` : ''}
        ${s.last_outcome ? `<span>${OUTCOME_LABEL[s.last_outcome] || ''}</span>`
                         : s.dial ? `<span class="mono">${escapeHtml(prettyNumber(s.dial))}</span>` : '<span>No number</span>'}
      </div>
    </button>`).join('')
    : `<div class="empty">No schools assigned yet.<br>Your admin assigns them from the admin page.</div>`;

  show('viewList');
}

$('schoolList').addEventListener('click', e => {
  const row = e.target.closest('[data-id]');
  if (row) openSchool(Number(row.dataset.id));
});

$('backToList').addEventListener('click', loadList);

/* ── one school ──────────────────────────────────────────────────────── */

async function openSchool(id) {
  const { school } = await api('GET', `/api/schools/${id}`);
  state.school = school;

  $('schName').textContent = school.name;
  $('schAddr').textContent = [school.address, school.block, school.pincode].filter(Boolean).join(' · ');
  $('schNum').textContent = school.dial ? prettyNumber(school.dial) : 'No number on record';
  $('schVia').textContent = school.dial ? 'Call is logged against this school' : '';
  $('dialBtn').hidden = !school.dial;

  const hist = school.history || [];
  $('schHistory').innerHTML = hist.length ? `
    <div class="eyebrow" style="margin-bottom:8px">Earlier calls</div>
    <ul>${hist.map(h => `
      <li><b>${OUTCOME_LABEL[h.outcome] || 'Called'}</b>
        — ${new Date(h.started_at + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
        by ${escapeHtml(h.caller)}
        ${h.subject ? `<br><span class="muted">${escapeHtml(h.subject)}${h.grade ? ', ' + escapeHtml(h.grade) : ''}</span>` : ''}
        ${h.note ? `<br><span class="muted">${escapeHtml(h.note)}</span>` : ''}
      </li>`).join('')}</ul>`
    : `<div class="muted">No one has called this school yet.</div>`;

  show('viewSchool');
}

$('dialBtn').addEventListener('click', async () => {
  const btn = $('dialBtn');
  btn.disabled = true;
  try {
    const out = await api('POST', `/api/schools/${state.school.id}/call`);
    state.callId = out.callId;
    state.startedAt = Date.now();

    // manual mode: hand the number to the phone's dialler
    if (out.mode === 'manual' && out.dial) window.location.href = `tel:+${out.dial}`;

    openOutcome(out.mode);
  } catch (err) {
    flash(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ── outcome ─────────────────────────────────────────────────────────── */

let timerId;
function openOutcome(mode) {
  $('outName').textContent = state.school.name;
  state.outcome = null;
  $('outcomeChips').querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
  $('vacancyFields').hidden = true;
  $('followUpField').hidden = true;
  $('oSubject').value = '';
  $('oNote').value = '';
  $('oWa').value = state.school.wa_number ? state.school.wa_number.slice(-10) : '';

  clearInterval(timerId);
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $('callTimer').textContent =
      `${mode === 'infobip' ? 'Call connecting' : 'Call in progress'} · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  show('viewOutcome');
}

$('outcomeChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('outcomeChips').querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
  chip.setAttribute('aria-pressed', 'true');
  state.outcome = chip.dataset.v;
  $('vacancyFields').hidden = state.outcome !== 'vacancy';
  $('followUpField').hidden = !(state.outcome === 'callback' || state.outcome === 'no_answer');
  if (!$('followUpField').hidden && !$('oFollowUp').value) {
    const d = new Date(); d.setDate(d.getDate() + 3);
    $('oFollowUp').value = d.toISOString().slice(0, 10);
  }
});

async function saveOutcome() {
  if (!state.outcome) { flash('Pick what happened on the call', 'err'); return false; }
  const payload = {
    outcome: state.outcome,
    subject: $('oSubject').value.trim() || null,
    grade: state.outcome === 'vacancy' ? $('oGrade').value : null,
    note: $('oNote').value.trim() || null,
    followUpOn: $('followUpField').hidden ? null : ($('oFollowUp').value || null),
    waNumber: $('oWa').value.trim() || null,
    durationS: Math.floor((Date.now() - state.startedAt) / 1000),
  };
  await api('POST', `/api/calls/${state.callId}/outcome`, payload);
  clearInterval(timerId);
  return true;
}

$('saveOnly').addEventListener('click', async () => {
  try {
    if (await saveOutcome()) { flash('Logged'); loadList(); }
  } catch (err) { flash(err.message, 'err'); }
});

$('saveSend').addEventListener('click', async () => {
  try {
    if (!(await saveOutcome())) return;
    const to = $('oWa').value.trim() || state.school.wa_number;
    if (!to) { flash('Logged. No WhatsApp number for this school yet.', 'ok'); return loadList(); }
    openWhatsApp(to);
  } catch (err) { flash(err.message, 'err'); }
});

/* ── whatsapp ────────────────────────────────────────────────────────── */

async function openWhatsApp(to) {
  if (!state.templates.length) {
    state.templates = (await api('GET', '/api/templates')).templates;
  }
  $('waName').textContent = state.school.name;
  $('waTo').value = to;
  $('waTemplate').innerHTML = state.templates
    .map(t => `<option value="${t.name}">${escapeHtml(t.label)}</option>`).join('');
  renderPreview();
  show('viewWhatsApp');
}

function placeholdersFor(templateName) {
  if (templateName === 'check_vacancy_in_school') {
    return [state.school.name, $('oSubject').value.trim() || 'a teaching', $('oGrade').value];
  }
  if (templateName === 'school_welcome_message') return [state.school.name];
  return [];
}

function renderPreview() {
  const name = $('waTemplate').value;
  const t = state.templates.find(x => x.name === name);
  const vals = placeholdersFor(name);
  $('waPreview').innerHTML =
    `<b>${escapeHtml(t?.label || name)}</b><br>` +
    (vals.length ? vals.map((v, i) => `${escapeHtml(t.placeholders[i] || `Field ${i + 1}`)}: ${escapeHtml(v)}`).join('<br>')
                 : 'No fields to fill in.');
}
$('waTemplate').addEventListener('change', renderPreview);

$('waSend').addEventListener('click', async () => {
  const btn = $('waSend');
  btn.disabled = true;
  try {
    const name = $('waTemplate').value;
    await api('POST', `/api/schools/${state.school.id}/whatsapp`, {
      to: $('waTo').value.trim(),
      template: name,
      placeholders: placeholdersFor(name),
    });
    flash('WhatsApp sent');
    loadList();
  } catch (err) {
    flash(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('waSkip').addEventListener('click', loadList);

/* ── boot ────────────────────────────────────────────────────────────── */

(async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
    afterSignIn(me.mustReset);
  } catch {
    show('viewLogin');
  }
})();
