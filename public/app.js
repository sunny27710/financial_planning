// Portfolio tracker frontend (vanilla JS, no build step).
const S = {
  holdings: [], priceAlerts: [], callRules: [], notifications: [], settings: {},
  quotes: {}, callMatches: {}, status: {}, provider: '',
};
const prevPrices = {};
const editing = { holding: null, price: null };

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n, d = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, f = money) => (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n));
const pct = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`);
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
const formData = (form) => {
  const o = Object.fromEntries(new FormData(form));
  form.querySelectorAll('input[type=checkbox]').forEach((c) => (o[c.name] = c.checked));
  return o;
};

// ---------- live stream ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));
  es.addEventListener('state', (e) => { Object.assign(S, JSON.parse(e.data)); renderAll(); });
  es.addEventListener('quotes', (e) => { const d = JSON.parse(e.data); S.quotes = d.quotes; S.status = d.status; renderHoldings(); renderPrice(); renderStatus(); });
  es.addEventListener('priceAlerts', (e) => { S.priceAlerts = JSON.parse(e.data); renderPrice(); });
  es.addEventListener('callMatches', (e) => { const d = JSON.parse(e.data); S.callMatches = d.callMatches; S.status = d.status; renderCalls(); renderStatus(); });
  es.addEventListener('status', (e) => { S.status = JSON.parse(e.data); renderStatus(); });
  es.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    S.notifications.unshift(n);
    renderFeed();
    showNotification(n);
  });
}

function setConn(ok) {
  $('#conn').className = `dot ${ok ? 'live' : 'err'}`;
  if (!ok) $('#statusText').textContent = 'Disconnected — retrying…';
}

function renderStatus() {
  const st = S.status || {};
  let text = st.lastQuoteAt ? `Prices updated ${new Date(st.lastQuoteAt).toLocaleTimeString()}` : 'Waiting for prices…';
  if (st.quoteError) text = `Quote error: ${st.quoteError}`;
  $('#statusText').textContent = text;
  $('#statusText').title = st.optionsError ? `Options: ${st.optionsError}` : st.lastOptionsAt ? `Options scanned ${new Date(st.lastOptionsAt).toLocaleTimeString()}` : '';
  const b = $('#providerBadge');
  b.textContent = { mock: 'SIMULATED DATA', yahoo: 'Yahoo Finance', finnhub: 'Finnhub + Yahoo options' }[S.provider] || '';
  b.className = `badge ${S.provider === 'mock' ? 'warn' : ''}`;
}

// ---------- notifications ----------
function updateNotifButton() {
  const btn = $('#enableNotifs');
  if (!('Notification' in window)) { btn.textContent = 'Notifications unsupported'; btn.disabled = true; return; }
  btn.hidden = Notification.permission === 'granted';
  if (Notification.permission === 'denied') { btn.textContent = 'Notifications blocked'; btn.disabled = true; }
}
$('#enableNotifs').addEventListener('click', async () => { await Notification.requestPermission(); updateNotifButton(); });

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.06;
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch {}
}

function showNotification(n) {
  const t = document.createElement('div');
  t.className = `toast ${n.type}`;
  t.innerHTML = `<div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div>`;
  t.onclick = () => t.remove();
  $('#toasts').prepend(t);
  setTimeout(() => t.remove(), 12000);
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    const note = new Notification(n.title, { body: n.body, tag: n.id });
    note.onclick = () => { window.focus(); note.close(); };
  }
}

// ---------- holdings ----------
function portfolioTotals() {
  let value = 0, cost = 0, day = 0, prevValue = 0, priced = 0;
  for (const h of S.holdings) {
    const q = S.quotes[h.symbol];
    cost += h.shares * (h.costBasis || 0);
    if (!q) continue;
    priced++;
    value += h.shares * q.price;
    prevValue += h.shares * q.prevClose;
    day += h.shares * q.change;
  }
  return { value, cost, day, dayPct: prevValue ? (day / prevValue) * 100 : 0, gain: value - cost, gainPct: cost ? ((value - cost) / cost) * 100 : 0, priced };
}

function renderHoldings() {
  const t = portfolioTotals();
  const has = S.holdings.length > 0;
  $('#totalValue').textContent = has ? money(t.value) : '—';
  $('#dayChange').innerHTML = has ? `<span class="${cls(t.day)}">${signed(t.day)} <span class="sub">${pct(t.dayPct)}</span></span>` : '—';
  $('#totalGain').innerHTML = has && t.cost ? `<span class="${cls(t.gain)}">${signed(t.gain)} <span class="sub">${pct(t.gainPct)}</span></span>` : '—';
  $('#totalCost').textContent = has ? money(t.cost) : '—';
  document.title = has && t.priced ? `${money(t.value, 0)} (${pct(t.dayPct)}) · Portfolio` : 'Portfolio Tracker';

  $('#holdingsEmpty').hidden = has;
  $('#holdingsBody').closest('.table-wrap').hidden = !has;
  const rows = [...S.holdings].sort((a, b) => {
    const va = a.shares * (S.quotes[a.symbol]?.price || 0), vb = b.shares * (S.quotes[b.symbol]?.price || 0);
    return vb - va;
  });
  $('#holdingsBody').innerHTML = rows.map((h) => {
    const q = S.quotes[h.symbol];
    const value = q ? h.shares * q.price : null;
    const gain = q && h.costBasis ? value - h.shares * h.costBasis : null;
    const gainPct = gain != null ? (gain / (h.shares * h.costBasis)) * 100 : null;
    const prev = prevPrices[h.id];
    const flash = q && prev != null && q.price !== prev ? (q.price > prev ? 'flash-up' : 'flash-down') : '';
    if (q) prevPrices[h.id] = q.price;
    const session = q && q.session !== 'regular' ? `<small>${q.session}-market</small>` : '';
    return `<tr>
      <td class="sym">${esc(h.symbol)}<small>${esc(q?.name || 'Loading…')}</small></td>
      <td class="r ${flash}">${q ? money(q.price) : '—'}${session}</td>
      <td class="r ${cls(q?.change)}">${q ? `${signed(q.change)}<br><small>${pct(q.changePct)}</small>` : '—'}</td>
      <td class="r">${h.shares.toLocaleString()}</td>
      <td class="r">${h.costBasis ? money(h.costBasis) : '<span class="muted">—</span>'}</td>
      <td class="r">${money(value)}</td>
      <td class="r ${cls(gain)}">${gain != null ? `${signed(gain)}<br><small>${pct(gainPct)}</small>` : '—'}</td>
      <td class="r">${value != null && t.value ? ((value / t.value) * 100).toFixed(1) + '%' : '—'}</td>
      <td class="r">
        <button class="icon-btn" title="Add price alert" data-act="alert" data-sym="${esc(h.symbol)}">🔔</button>
        <button class="icon-btn" title="Edit" data-act="edit-holding" data-id="${h.id}">✎</button>
        <button class="icon-btn" title="Remove" data-act="del-holding" data-id="${h.id}">✕</button>
      </td></tr>`;
  }).join('');
  $('#symbolList').innerHTML = [...new Set(S.holdings.map((h) => h.symbol))].map((s) => `<option value="${esc(s)}">`).join('');
}

$('#holdingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const d = formData(form);
  if (!editing.holding && !Number(d.shares) && !Number(d.amount)) return alert('Enter the number of shares, or the dollar amount you invested.');
  try {
    if (editing.holding) await api('PUT', `/api/holdings/${editing.holding}`, formData(form));
    else await api('POST', '/api/holdings', formData(form));
    resetHoldingForm();
  } catch (err) { alert(err.message); }
});
function resetHoldingForm() {
  editing.holding = null;
  $('#holdingForm').reset();
  $('#holdingForm button').textContent = 'Add holding';
}

// ---------- price alerts ----------
function renderPrice() {
  const list = S.priceAlerts;
  $('#priceCount').textContent = list.filter((a) => a.active).length || '';
  $('#priceEmpty').hidden = list.length > 0;
  $('#priceBody').closest('.table-wrap').hidden = !list.length;
  $('#priceBody').innerHTML = list.map((a) => {
    const q = S.quotes[a.symbol];
    const dist = q ? ((a.target - q.price) / q.price) * 100 : null;
    let status = a.active ? '<span class="pill on">Watching</span>' : '<span class="pill">Off</span>';
    if (a.lastTriggeredAt) status += ` <span class="pill fired" title="at ${money(a.lastTriggeredPrice)}">Fired ${ago(a.lastTriggeredAt)}</span>`;
    return `<tr>
      <td class="sym">${esc(a.symbol)}</td>
      <td>${a.direction === 'above' ? '▲ at or above' : '▼ at or below'} <b>${money(a.target)}</b>${a.repeat ? ' <span class="pill">repeat</span>' : ''}</td>
      <td class="r">${q ? money(q.price) : '—'}</td>
      <td class="r ${dist == null ? '' : 'muted'}">${pct(dist)}</td>
      <td>${status}</td>
      <td class="muted">${esc(a.note)}</td>
      <td class="r">
        <button class="icon-btn" data-act="toggle-price" data-id="${a.id}" title="${a.active ? 'Pause' : 'Re-arm'}">${a.active ? '⏸' : '↻'}</button>
        <button class="icon-btn" data-act="edit-price" data-id="${a.id}" title="Edit">✎</button>
        <button class="icon-btn" data-act="del-price" data-id="${a.id}" title="Delete">✕</button>
      </td></tr>`;
  }).join('');
}

$('#priceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (editing.price) await api('PUT', `/api/price-alerts/${editing.price}`, { ...formData(e.target), active: true });
    else await api('POST', '/api/price-alerts', formData(e.target));
    resetPriceForm();
  } catch (err) { alert(err.message); }
});
function resetPriceForm() {
  editing.price = null;
  $('#priceForm').reset();
  $('#priceForm button').textContent = 'Add alert';
}

// ---------- covered calls ----------
function ruleCriteria(r) {
  const parts = [`premium ≥ ${money(r.minPremium)}/sh (${r.premiumBasis})`, `${r.minDte}–${r.maxDte} DTE`, `strike ≥ ${r.minOtmPct}% OTM`];
  if (r.minAnnualizedPct) parts.push(`≥ ${r.minAnnualizedPct}% annualized`);
  if (r.requireShares && r.symbol !== '*') parts.push('only if ≥100 shares');
  return parts.join(' · ');
}

function renderCalls() {
  const rules = S.callRules;
  $('#callsEmpty').hidden = rules.length > 0;
  let total = 0;
  $('#callRules').innerHTML = rules.map((r) => {
    const per = S.callMatches[r.id] || {};
    const syms = Object.keys(per);
    const count = syms.reduce((n, s) => n + per[s].length, 0);
    total += count;
    let body;
    if (!r.active) body = '<div class="none">Paused.</div>';
    else if (!(r.id in S.callMatches)) body = '<div class="none">Scanning option chains…</div>';
    else if (!count) body = `<div class="none">No contracts currently meet these conditions${r.symbol === '*' && !syms.length ? ' (no holdings with ≥ 100 shares)' : ''}.</div>`;
    else {
      body = `<div class="table-wrap" style="border:0;border-radius:0;box-shadow:none"><table>
        <thead><tr><th>Contract</th><th class="r">Expiry</th><th class="r">DTE</th><th class="r">Strike</th><th class="r">OTM</th>
        <th class="r">Bid / Ask</th><th class="r">Premium</th><th class="r">Yield</th><th class="r">Annualized</th><th class="r">OI</th><th class="r">If you write</th></tr></thead><tbody>
        ${syms.filter((s) => per[s].length).map((s) => `<tr class="sym-group"><td colspan="11">${esc(s)} · ${money(S.quotes[s]?.price)}</td></tr>` +
          per[s].slice(0, 10).map((m) => `<tr>
            <td class="muted">${esc(m.contractSymbol)}</td>
            <td class="r">${new Date(m.expiration).toISOString().slice(0, 10)}</td>
            <td class="r">${m.dte}</td>
            <td class="r">${money(m.strike)}</td>
            <td class="r">${m.otmPct.toFixed(1)}%</td>
            <td class="r">${money(m.bid)} / ${money(m.ask)}</td>
            <td class="r up"><b>${money(m.premium)}</b></td>
            <td class="r">${m.yieldPct.toFixed(2)}%</td>
            <td class="r">${m.annualizedPct.toFixed(1)}%</td>
            <td class="r">${(m.openInterest || 0).toLocaleString()}</td>
            <td class="r">${m.contracts ? `${m.contracts}× → ${money(m.totalPremium, 0)}` : '<span class="muted">&lt;100 sh</span>'}</td>
          </tr>`).join('') + (per[s].length > 10 ? `<tr><td colspan="11" class="muted">+${per[s].length - 10} more</td></tr>` : '')).join('')}
        </tbody></table></div>`;
    }
    return `<div class="rule">
      <div class="rule-head">
        <span class="title">${r.symbol === '*' ? 'All holdings (≥100 sh)' : esc(r.symbol)}</span>
        <span class="crit">${esc(ruleCriteria(r))}</span>
        <span class="actions">
          ${r.active ? `<span class="pill on">${count} match${count === 1 ? '' : 'es'}</span>` : '<span class="pill">Off</span>'}
          <button class="icon-btn" data-act="scan-rule" data-id="${r.id}" title="Scan now">⟳</button>
          <button class="icon-btn" data-act="toggle-rule" data-id="${r.id}" title="${r.active ? 'Pause' : 'Resume'}">${r.active ? '⏸' : '▶'}</button>
          <button class="icon-btn" data-act="del-rule" data-id="${r.id}" title="Delete">✕</button>
        </span>
      </div>${body}</div>`;
  }).join('');
  $('#callCount').textContent = total || '';
}

$('#callForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/call-rules', formData(e.target));
  } catch (err) { alert(err.message); }
});

// ---------- feed & settings ----------
function renderFeed() {
  const list = S.notifications;
  $('#feedEmpty').hidden = list.length > 0;
  $('#feed').hidden = !list.length;
  $('#feedCount').textContent = list.length ? Math.min(list.length, 99) : '';
  $('#feed').innerHTML = list.slice(0, 100).map((n) =>
    `<li><time title="${esc(new Date(n.createdAt).toLocaleString())}">${ago(n.createdAt)}</time><div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div></li>`).join('');
}
$('#testNotif').addEventListener('click', () => api('POST', '/api/test-notification').catch((e) => alert(e.message)));
$('#clearNotifs').addEventListener('click', () => confirm('Clear all notifications?') && api('DELETE', '/api/notifications'));

function renderSettings() {
  const f = $('#settingsForm');
  if (f.contains(document.activeElement)) return; // don't clobber while typing
  for (const [k, v] of Object.entries(S.settings)) if (f.elements[k]) f.elements[k].value = v ?? '';
}
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('PUT', '/api/settings', formData(e.target)); e.target.querySelector('button').textContent = 'Saved ✓'; setTimeout(() => (e.target.querySelector('button').textContent = 'Save settings'), 1500); }
  catch (err) { alert(err.message); }
});

// ---------- actions ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id, sym } = b.dataset;
  try {
    if (act === 'del-holding' && confirm('Remove this holding?')) await api('DELETE', `/api/holdings/${id}`);
    if (act === 'edit-holding') {
      const h = S.holdings.find((x) => x.id === id);
      const f = $('#holdingForm');
      f.elements.symbol.value = h.symbol; f.elements.shares.value = h.shares; f.elements.costBasis.value = h.costBasis || ''; f.elements.amount.value = '';
      editing.holding = id; f.querySelector('button').textContent = 'Save changes'; f.elements.shares.focus();
    }
    if (act === 'alert') {
      switchTab('price');
      const f = $('#priceForm');
      f.elements.symbol.value = sym; f.elements.target.focus();
    }
    if (act === 'del-price') await api('DELETE', `/api/price-alerts/${id}`);
    if (act === 'toggle-price') {
      const a = S.priceAlerts.find((x) => x.id === id);
      await api('PATCH', `/api/price-alerts/${id}`, { active: !a.active });
    }
    if (act === 'edit-price') {
      const a = S.priceAlerts.find((x) => x.id === id);
      const f = $('#priceForm');
      for (const k of ['symbol', 'direction', 'target', 'note']) f.elements[k].value = a[k] ?? '';
      f.elements.repeat.checked = !!a.repeat;
      editing.price = id; f.querySelector('button').textContent = 'Save alert';
    }
    if (act === 'del-rule' && confirm('Delete this covered-call alert?')) await api('DELETE', `/api/call-rules/${id}`);
    if (act === 'toggle-rule') {
      const r = S.callRules.find((x) => x.id === id);
      await api('PATCH', `/api/call-rules/${id}`, { active: !r.active });
    }
    if (act === 'scan-rule') { b.disabled = true; await api('POST', `/api/call-rules/${id}/scan`); b.disabled = false; }
  } catch (err) { alert(err.message); }
});

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  try { localStorage.setItem('tab', name); } catch {}
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { resetHoldingForm(); resetPriceForm(); } });

function renderAll() { renderStatus(); renderHoldings(); renderPrice(); renderCalls(); renderFeed(); renderSettings(); }

try { const t = localStorage.getItem('tab'); if (t) switchTab(t); } catch {}
updateNotifButton();
connect();
setInterval(renderFeed, 30_000); // keep "x min ago" fresh
