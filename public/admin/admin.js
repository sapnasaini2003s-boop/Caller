/* FacultyMe Caller — admin page. */

const $ = id => document.getElementById(id);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let flashTimer;
function flash(text, kind = 'ok') {
  clearTimeout(flashTimer);
  $('flash').innerHTML = `<div class="msg ${kind}">${escapeHtml(text)}</div>`;
  flashTimer = setTimeout(() => { $('flash').innerHTML = ''; }, kind === 'err' ? 9000 : 4000);
}

/* ── team ────────────────────────────────────────────────────────────── */

async function loadTeam() {
  const { users } = await api('GET', '/api/admin/users');
  window.allUsers = users;
  const active = users.filter(u => u.active).length;
  $('teamCount').textContent = `${users.length} people · ${active} active`;

  $('teamBody').innerHTML = users.map(u => {
    const pct = u.assigned ? Math.round((u.called / u.assigned) * 100) : 0;
    const access = !u.active ? '<span class="pill off">Disabled</span>'
      : u.must_reset ? '<span class="pill new">Login sent</span>'
      : '<span class="pill on">Active</span>';
    return `<tr>
      <td><b>${escapeHtml(u.name)}</b><div class="muted mono">${escapeHtml(u.username)}</div></td>
      <td>${escapeHtml(u.area || '—')}</td>
      <td><span class="mono">${u.called} / ${u.assigned}</span>
          <div class="bar"><i style="width:${pct}%"></i></div></td>
      <td class="mono">${u.vacancies || 0}</td>
      <td>${access}</td>
      <td>
        <button class="btn btn-ghost" data-reset="${u.id}">Reset password</button>
        <button class="btn btn-ghost" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>
      </td>
    </tr>`;
  }).join('');

  const opts = users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  $('assignTo').innerHTML = users.filter(u => u.active)
    .map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  const keep = $('hCaller').value;
  $('hCaller').innerHTML = '<option value="">Everyone</option>' + opts;
  $('hCaller').value = keep;
}

$('teamBody').addEventListener('click', async e => {
  const reset = e.target.closest('[data-reset]');
  const toggle = e.target.closest('[data-active]');
  try {
    if (reset) {
      const out = await api('POST', `/api/admin/users/${reset.dataset.reset}/reset`);
      flash(out.delivered
        ? 'New password sent on WhatsApp'
        : `WhatsApp did not go out. Give them this password: ${out.tempPassword}`,
        out.delivered ? 'ok' : 'err');
      return loadTeam();
    }
    if (toggle) {
      await api('POST', `/api/admin/users/${toggle.dataset.active}/active`, { active: Number(toggle.dataset.to) });
      flash(Number(toggle.dataset.to) ? 'Access restored' : 'Access removed — they are signed out now');
      return loadTeam();
    }
  } catch (err) { flash(err.message, 'err'); }
});

$('addToggle').addEventListener('click', () => {
  const open = $('addBox').hidden;
  $('addBox').hidden = !open;
  $('addToggle').textContent = open ? 'Close' : 'Add caller';
  if (open) $('aName').focus();
});
$('addCancel').addEventListener('click', () => {
  $('addBox').hidden = true;
  $('addToggle').textContent = 'Add caller';
});

$('addSave').addEventListener('click', async () => {
  const btn = $('addSave');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/admin/users', {
      name: $('aName').value, mobile: $('aMobile').value,
      area: $('aArea').value, role: $('aRole').value,
    });
    flash(out.delivered
      ? `${out.user.name} added — login sent to their WhatsApp`
      : `${out.user.name} added, but WhatsApp failed. Caller ID ${out.user.username}, password ${out.tempPassword}`,
      out.delivered ? 'ok' : 'err');
    ['aName', 'aMobile', 'aArea'].forEach(id => { $(id).value = ''; });
    $('addBox').hidden = true;
    $('addToggle').textContent = 'Add caller';
    loadTeam();
  } catch (err) { flash(err.message, 'err'); }
  finally { btn.disabled = false; }
});

/* ── schools ─────────────────────────────────────────────────────────── */

/** Small CSV reader — handles quoted fields and embedded commas. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];

  const headers = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(v => v && v.trim()))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

$('csvFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const rows = parseCsv(await file.text());
    if (!rows.length) return flash('That file has no rows', 'err');

    // Send in batches so a big district import does not hit the body limit.
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const out = await api('POST', '/api/admin/schools/import', { rows: rows.slice(i, i + 500) });
      added += out.added;
    }
    flash(`Imported ${added} schools`);
    loadSchools();
  } catch (err) {
    flash(err.message, 'err');
  } finally {
    e.target.value = '';
  }
});

$('assignBtn').addEventListener('click', async () => {
  const userIds = Array.from($('assignTo').selectedOptions).map(o => Number(o.value));
  if (!userIds.length) return flash('Pick at least one caller', 'err');
  try {
    const out = await api('POST', '/api/admin/schools/assign', { userIds, limit: 1000 });
    flash(out.assigned ? `${out.assigned} schools shared out, about ${out.perCaller} each` : (out.note || 'Nothing to assign'));
    loadTeam(); loadSchools();
  } catch (err) { flash(err.message, 'err'); }
});

let schQTimer;
$('schQ').addEventListener('input', () => {
  clearTimeout(schQTimer);
  schQTimer = setTimeout(loadSchools, 250);
});

async function loadSchools() {
  const { schools, counts } = await api('GET', '/api/admin/schools?q=' + encodeURIComponent($('schQ').value));
  $('schoolCount').textContent =
    `${counts.total || 0} total · ${counts.unassigned || 0} unassigned · ${counts.done || 0} done`;
  
  $('schoolBody').innerHTML = schools.length ? schools.map(s => `
    <tr>
      <td><b>${escapeHtml(s.name)}</b><div class="muted mono">${escapeHtml(s.udise_code || '')}</div></td>
      <td>${escapeHtml(s.district || '—')}</td>
      <td class="mono">${escapeHtml(s.phone || '—')}</td>
      <td>
        <select class="single-assign" data-id="${s.id}" style="padding:4px; border-radius:4px; border:1px solid #ccc; max-width:150px;">
          <option value="">Unassigned</option>
          ${(window.allUsers || []).map(u => `<option value="${u.id}" ${u.name === s.caller ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
        </select>
      </td>
      <td>${escapeHtml(s.last_outcome || s.status)}</td>
    </tr>`).join('')
    : `<tr><td colspan="5" class="muted" style="padding:24px 0">No schools yet — import a CSV above.</td></tr>`;
}

$('schoolBody').addEventListener('change', async (e) => {
  if (e.target.classList.contains('single-assign')) {
    const schoolId = e.target.dataset.id;
    const userId = e.target.value;
    try {
      await api('POST', `/api/admin/schools/${schoolId}/assign`, { userId });
      flash('Assignment updated');
      loadTeam();
    } catch (err) { flash(err.message, 'err'); }
  }
});

/* ── report ──────────────────────────────────────────────────────────── */

async function loadReport() {
  const { totals, vacancies } = await api('GET', '/api/admin/report?date=' + $('repDate').value);
  $('rCalls').textContent = totals.calls || 0;
  $('rSchools').textContent = totals.schools || 0;
  $('rVac').textContent = totals.vacancies || 0;
  $('rNoAns').textContent = totals.no_answer || 0;
  $('repBody').innerHTML = vacancies.length ? vacancies.map(v => `
    <tr>
      <td><b>${escapeHtml(v.name)}</b><div class="muted">${escapeHtml(v.district || '')}</div></td>
      <td>${escapeHtml(v.subject || '—')}</td>
      <td>${escapeHtml(v.grade || '—')}</td>
      <td>${escapeHtml(v.caller)}</td>
    </tr>`).join('')
    : `<tr><td colspan="4" class="muted" style="padding:24px 0">No vacancies logged on this date.</td></tr>`;
}
$('repDate').addEventListener('change', loadReport);

/* ── trends chart ────────────────────────────────────────────────────── */

/**
 * Grouped bars, two series of the same unit on one axis. Drawn as SVG so it
 * stays sharp, respects the theme tokens, and needs no charting library.
 */
function drawTrend(series) {
  const W = 760, H = 200, padL = 34, padR = 8, padT = 10, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const max = Math.max(4, ...series.map(d => d.calls));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = step * 4;
  const y = v => padT + plotH - (v / top) * plotH;

  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(14, slot / 2 - 2));   // 2px gap between the pair

  const gridlines = Array.from({ length: 5 }, (_, i) => {
    const v = i * step, yy = y(v);
    return `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>
            <text class="axis-label" x="${padL - 6}" y="${yy + 3.5}" text-anchor="end">${v}</text>`;
  }).join('');

  const bars = series.map((d, i) => {
    const x = padL + i * slot + (slot - barW * 2 - 2) / 2;
    const bar = (val, xx, color) => {
      if (!val) return '';
      const h = Math.max(2, (val / top) * plotH);
      return `<rect x="${xx.toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"/>`;
    };
    return `<rect class="hit" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" data-i="${i}" tabindex="0"/>
            <rect class="band" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent" pointer-events="none"/>
            ${bar(d.calls, x, 'var(--series-calls)')}
            ${bar(d.vacancies, x + barW + 2, 'var(--series-vac)')}`;
  }).join('');

  // Label roughly every seventh day, and always the last one.
  const every = Math.max(1, Math.round(series.length / 6));
  const labels = series.map((d, i) => {
    if (i % every !== 0 && i !== series.length - 1) return '';
    const dt = new Date(d.day + 'T00:00:00');
    return `<text class="axis-label" x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${dt.getDate()} ${dt.toLocaleString('en-IN', { month: 'short' })}</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
            aria-label="Calls and vacancies per day for the last ${series.length} days">
    ${gridlines}${bars}${labels}
  </svg>`;
}

let tipEl;
function bindTrendHover(container, series) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    document.body.appendChild(tipEl);
  }
  const place = (hit, d) => {
    const r = hit.getBoundingClientRect();
    const dt = new Date(d.day + 'T00:00:00');
    tipEl.innerHTML =
      `<b>${dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</b>` +
      `<i style="background:var(--series-calls)"></i>${d.calls} call${d.calls === 1 ? '' : 's'}<br>` +
      `<i style="background:var(--series-vac)"></i>${d.vacancies} vacanc${d.vacancies === 1 ? 'y' : 'ies'}`;
    tipEl.style.opacity = '1';
    const t = tipEl.getBoundingClientRect();
    tipEl.style.left = Math.min(window.innerWidth - t.width - 8,
      Math.max(8, r.left + r.width / 2 - t.width / 2)) + 'px';
    tipEl.style.top = (window.scrollY + r.top - t.height - 8) + 'px';
  };
  const hide = () => { if (tipEl) tipEl.style.opacity = '0'; };

  container.querySelectorAll('.hit').forEach(hit => {
    const d = series[Number(hit.dataset.i)];
    hit.addEventListener('mouseenter', () => place(hit, d));
    hit.addEventListener('focus', () => place(hit, d));
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('blur', hide);
  });
  container.addEventListener('mouseleave', hide);
}

const mmss = s => s == null ? '—'
  : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function loadTrends() {
  const { series, byCaller } = await api('GET', '/api/admin/trends?days=' + $('trendDays').value);
  const wrap = $('trendChart');
  wrap.innerHTML = drawTrend(series);
  bindTrendHover(wrap, series);

  $('byCallerBody').innerHTML = byCaller.length ? byCaller.map(c => `
    <tr>
      <td><b>${escapeHtml(c.caller)}</b></td>
      <td class="mono">${c.calls}</td>
      <td class="mono">${c.schools}</td>
      <td class="mono" style="color:var(--go);font-weight:600">${c.vacancies || 0}</td>
      <td class="mono">${c.no_answer || 0}</td>
      <td class="mono">${mmss(c.avg_duration)}</td>
    </tr>`).join('')
    : `<tr><td colspan="6" class="muted" style="padding:22px 0">No calls in this period.</td></tr>`;
}
$('trendDays').addEventListener('change', loadTrends);

/* ── call history ────────────────────────────────────────────────────── */

const OUTCOME_LABEL = {
  vacancy: 'Vacancy', no_vacancy: 'No vacancy', callback: 'Call back', no_answer: 'No answer',
};

let histOffset = 0;

function histQuery(extra = '') {
  const p = new URLSearchParams();
  if ($('hFrom').value) p.set('from', $('hFrom').value);
  if ($('hTo').value) p.set('to', $('hTo').value);
  if ($('hCaller').value) p.set('userId', $('hCaller').value);
  if ($('hOutcome').value) p.set('outcome', $('hOutcome').value);
  if ($('hQ').value.trim()) p.set('q', $('hQ').value.trim());
  return p.toString() + extra;
}

function histRow(c) {
  const when = new Date(c.started_at.replace(' ', 'T') + 'Z');
  const pill = c.outcome === 'vacancy' ? 'on' : c.outcome === 'no_answer' ? 'off' : 'new';
  return `<tr>
    <td class="mono" style="white-space:nowrap">${when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
      <div class="muted">${when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div></td>
    <td><b>${escapeHtml(c.school)}</b>
      <div class="muted">${escapeHtml(c.district || '')}${c.subject ? ' · ' + escapeHtml(c.subject) : ''}</div>
      ${c.note ? `<div class="muted">${escapeHtml(c.note)}</div>` : ''}</td>
    <td>${escapeHtml(c.caller)}</td>
    <td>${c.outcome ? `<span class="pill ${pill}">${OUTCOME_LABEL[c.outcome]}</span>` : '<span class="muted">Not logged</span>'}</td>
    <td class="mono">${mmss(c.duration_s)}</td>
    <td class="audio-row">${c.recording_url
      ? `<audio controls preload="none" src="/api/admin/calls/${c.id}/recording"></audio>`
      : '<span class="muted">No recording</span>'}</td>
  </tr>`;
}

async function loadHistory(append = false) {
  if (!append) histOffset = 0;
  const { calls, total } = await api('GET', `/api/admin/calls?${histQuery(`&limit=50&offset=${histOffset}`)}`);

  $('histCount').textContent = total ? `${total} call${total === 1 ? '' : 's'}` : '';
  const html = calls.map(histRow).join('');
  if (append) $('histBody').insertAdjacentHTML('beforeend', html);
  else $('histBody').innerHTML = html || `<tr><td colspan="6" class="muted" style="padding:22px 0">No calls match these filters.</td></tr>`;

  histOffset += calls.length;
  $('histMore').hidden = histOffset >= total;
}

['hFrom', 'hTo', 'hCaller', 'hOutcome'].forEach(id => $(id).addEventListener('change', () => loadHistory()));
let hqTimer;
$('hQ').addEventListener('input', () => { clearTimeout(hqTimer); hqTimer = setTimeout(() => loadHistory(), 300); });
$('histMore').addEventListener('click', () => loadHistory(true));

$('expCalls').addEventListener('click', () => { window.location.href = `/api/admin/export/calls.csv?${histQuery()}`; });
$('expVac').addEventListener('click', () => { window.location.href = `/api/admin/export/vacancies.csv?${histQuery()}`; });

/* ── sign in ─────────────────────────────────────────────────────────── */

function showLogin(message) {
  $('gate').hidden = true;
  $('whoBox').hidden = true;
  $('panel').hidden = true;
  $('loginBox').hidden = false;
  if (message) flash(message, 'err');
  $('lUser').focus();
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/auth/login', {
      username: $('lUser').value, password: $('lPass').value,
    });
    $('lPass').value = '';
    if (out.user.role !== 'admin') {
      await api('POST', '/api/auth/logout').catch(() => {});
      return flash('That account is a caller, not an admin. Use the phone app to make calls.', 'err');
    }
    $('loginBox').hidden = true;
    await start(out.user);
  } catch (err) {
    flash(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('signOut').addEventListener('click', async e => {
  e.preventDefault();
  await api('POST', '/api/auth/logout').catch(() => {});
  window.location.reload();
});

/* ── boot ────────────────────────────────────────────────────────────── */

async function start(user) {
  $('whoName').textContent = user.name;
  $('whoBox').hidden = false;
  $('gate').hidden = true;
  $('panel').hidden = false;
  $('repDate').value = new Date().toISOString().slice(0, 10);
  await loadTeam();                              // fills the caller filter first
  await Promise.all([loadSchools(), loadReport(), loadTrends(), loadHistory()]);
}

(async function boot() {
  let me;
  try {
    me = await api('GET', '/api/auth/me');
  } catch {
    return showLogin();
  }
  if (me.user.role !== 'admin') {
    await api('POST', '/api/auth/logout').catch(() => {});
    return showLogin('That account is a caller, not an admin.');
  }
  await start(me.user);
})();



