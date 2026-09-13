/* Voyagraph — app logic: state, CRUD, simulation calls, rendering. */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = p => p + Math.random().toString(36).slice(2, 9);

const state = {
  graph: { name: 'Untitled trip', currency: 'USD', nodes: [], edges: [] },
  mode: 'route',
  must: new Set(),
  editingNode: null,
  editingEdge: null,
  options: [],
  selected: 0
};

let gc; // GraphCanvas

/* ───────── utilities ───────── */
const money = v => `${state.graph.currency} ${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const hrs = v => v >= 24 ? `${(v / 24).toFixed(1)}d` : `${Number(v).toFixed(1)}h`;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

async function api(path, body, method = 'POST') {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

/* ───────── persistence to browser (autosave draft) ───────── */
function cache() { localStorage.setItem('voyagraph.draft', JSON.stringify(state.graph)); }
function restore() {
  try {
    const raw = localStorage.getItem('voyagraph.draft');
    if (raw) state.graph = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}

/* ───────── rendering: lists & selects ───────── */
function refresh() {
  state.graph.name = $('#tripName').value;
  state.graph.currency = $('#currency').value;
  renderNodes(); renderEdges(); renderSelects(); renderStats();
  gc.draw(); cache();
}

function renderNodes() {
  const box = $('#nodeList');
  if (!state.graph.nodes.length) {
    box.innerHTML = '<div class="empty">No places yet.<br>Add one above to begin.</div>'; return;
  }
  box.innerHTML = state.graph.nodes.map(n => `
    <div class="item" data-node="${n.id}">
      <div>
        <div class="t">${esc(n.name)}</div>
        <div class="s">${esc(n.country || '—')} · ${n.stay_nights || 0} nights · ${money((n.stay_nights * n.nightly_cost) + Math.ceil(n.stay_nights || 0) * (n.daily_spend || 0))}</div>
      </div>
      <button class="x" data-del-node="${n.id}" title="Remove">×</button>
    </div>`).join('');
}

function renderEdges() {
  const box = $('#edgeList');
  const name = id => (state.graph.nodes.find(n => n.id === id) || {}).name || '?';
  if (!state.graph.edges.length) {
    box.innerHTML = '<div class="empty">No connections yet.<br>Shift-drag between two nodes on the map.</div>'; return;
  }
  box.innerHTML = state.graph.edges.map(e => `
    <div class="item" data-edge="${e.id}">
      <div>
        <div class="t">${esc(name(e.source))} ${e.bidirectional ? '⇄' : '→'} ${esc(name(e.target))}</div>
        <div class="s">${e.mode} · ${money(e.cost)} · ${hrs(+e.duration_h + +(e.wait_h || 0))}</div>
      </div>
      <button class="x" data-del-edge="${e.id}" title="Remove">×</button>
    </div>`).join('');
}

function renderSelects() {
  const opts = state.graph.nodes.map(n => `<option value="${n.id}">${esc(n.name)}</option>`).join('');
  ['#e_from', '#e_to', '#s_start', '#s_end'].forEach(sel => {
    const el = $(sel), prev = el.value;
    el.innerHTML = opts;
    if ([...el.options].some(o => o.value === prev)) el.value = prev;
  });
  const te = $('#s_tourend'), prev = te.value;
  te.innerHTML = '<option value="">— anywhere —</option>' + opts;
  te.value = prev;

  $('#s_must').innerHTML = state.graph.nodes.map(n =>
    `<button type="button" class="chip ${state.must.has(n.id) ? 'on' : ''}" data-must="${n.id}">${esc(n.name)}</button>`
  ).join('') || '<span class="hint">Add places first.</span>';
}

function renderStats() {
  const g = state.graph;
  const fare = g.edges.reduce((s, e) => s + (+e.cost || 0), 0);
  const stay = g.nodes.reduce((s, n) => s + (n.stay_nights * n.nightly_cost) + Math.ceil(n.stay_nights || 0) * (n.daily_spend || 0), 0);
  $('#stats').innerHTML = `
    <span><b>${g.nodes.length}</b> places</span>
    <span><b>${g.edges.length}</b> connections</span>
    <span>All fares on map <b>${money(fare)}</b></span>
    <span>All stays <b>${money(stay)}</b></span>`;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ───────── node CRUD ───────── */
$('#nodeForm').addEventListener('submit', e => {
  e.preventDefault();
  const data = {
    name: $('#n_name').value.trim(),
    country: $('#n_country').value.trim(),
    stay_nights: +$('#n_nights').value || 0,
    nightly_cost: +$('#n_nightly').value || 0,
    daily_spend: +$('#n_daily').value || 0,
    notes: $('#n_notes').value.trim()
  };
  if (state.editingNode) {
    Object.assign(state.graph.nodes.find(n => n.id === state.editingNode), data);
    toast('Place updated');
  } else {
    const c = gc; const cx = (c.w / 2 - c.ox) / c.scale, cy = (c.hgt / 2 - c.oy) / c.scale;
    const a = Math.random() * Math.PI * 2, R = 90 + Math.random() * 90;
    state.graph.nodes.push({
      id: uid('n_'), ...data,
      x: cx + R * Math.cos(a), y: cy + R * Math.sin(a)
    });
    toast(`${data.name} added`);
  }
  resetNodeForm(); refresh();
});

function resetNodeForm() {
  state.editingNode = null;
  $('#nodeForm').reset();
  $('#nodeFormTitle').textContent = 'Add a place';
  $('#nodeSubmit').textContent = 'Add place';
  $('#nodeCancel').hidden = true;
}
$('#nodeCancel').addEventListener('click', resetNodeForm);

function editNode(id) {
  const n = state.graph.nodes.find(x => x.id === id); if (!n) return;
  state.editingNode = id;
  $('#n_name').value = n.name; $('#n_country').value = n.country || '';
  $('#n_nights').value = n.stay_nights || 0; $('#n_nightly').value = n.nightly_cost || 0;
  $('#n_daily').value = n.daily_spend || 0; $('#n_notes').value = n.notes || '';
  $('#nodeFormTitle').textContent = 'Edit place';
  $('#nodeSubmit').textContent = 'Save changes';
  $('#nodeCancel').hidden = false;
  switchTab('places');
  $('#n_name').focus();
}

/* ───────── edge CRUD ───────── */
$('#edgeForm').addEventListener('submit', e => {
  e.preventDefault();
  const data = {
    source: $('#e_from').value, target: $('#e_to').value,
    mode: $('#e_mode').value, cost: +$('#e_cost').value || 0,
    duration_h: +$('#e_dur').value || 0, wait_h: +$('#e_wait').value || 0,
    cost_var_pct: +$('#e_var').value || 0, bidirectional: $('#e_bi').checked,
    notes: $('#e_notes').value.trim()
  };
  if (data.source === data.target) return toast('Pick two different places.');
  if (state.editingEdge) {
    Object.assign(state.graph.edges.find(x => x.id === state.editingEdge), data);
    toast('Connection updated');
  } else {
    state.graph.edges.push({ id: uid('e_'), ...data });
    toast('Connection added');
  }
  resetEdgeForm(); refresh();
});

function resetEdgeForm() {
  state.editingEdge = null;
  $('#edgeForm').reset(); $('#e_bi').checked = true; $('#e_var').value = 15;
  $('#edgeFormTitle').textContent = 'Add a connection';
  $('#edgeSubmit').textContent = 'Add connection';
  $('#edgeCancel').hidden = true;
}
$('#edgeCancel').addEventListener('click', resetEdgeForm);

function editEdge(id) {
  const e = state.graph.edges.find(x => x.id === id); if (!e) return;
  state.editingEdge = id;
  switchTab('links');
  renderSelects();
  $('#e_from').value = e.source; $('#e_to').value = e.target;
  $('#e_mode').value = e.mode; $('#e_cost').value = e.cost;
  $('#e_dur').value = e.duration_h; $('#e_wait').value = e.wait_h || 0;
  $('#e_var').value = e.cost_var_pct ?? 15; $('#e_bi').checked = !!e.bidirectional;
  $('#e_notes').value = e.notes || '';
  $('#edgeFormTitle').textContent = 'Edit connection';
  $('#edgeSubmit').textContent = 'Save changes';
  $('#edgeCancel').hidden = false;
}

/* delegated clicks on the two lists */
document.addEventListener('click', ev => {
  const dn = ev.target.closest('[data-del-node]');
  if (dn) {
    const id = dn.dataset.delNode;
    state.graph.nodes = state.graph.nodes.filter(n => n.id !== id);
    state.graph.edges = state.graph.edges.filter(e => e.source !== id && e.target !== id);
    state.must.delete(id); refresh(); return;
  }
  const de = ev.target.closest('[data-del-edge]');
  if (de) {
    state.graph.edges = state.graph.edges.filter(e => e.id !== de.dataset.delEdge);
    refresh(); return;
  }
  const it = ev.target.closest('[data-node]'); if (it) return editNode(it.dataset.node);
  const ie = ev.target.closest('[data-edge]'); if (ie) return editEdge(ie.dataset.edge);
  const mc = ev.target.closest('[data-must]');
  if (mc) {
    const id = mc.dataset.must;
    state.must.has(id) ? state.must.delete(id) : state.must.add(id);
    renderSelects();
  }
  const op = ev.target.closest('[data-opt]');
  if (op) selectOption(+op.dataset.opt);
});

/* ───────── tabs & modes ───────── */
function switchTab(name) {
  $$('.panel.left .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}
$$('.panel.left .seg-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$$('.seg.small .seg-btn').forEach(b => b.addEventListener('click', () => {
  $$('.seg.small .seg-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.mode = b.dataset.mode;
  $('#routeOnly').hidden = state.mode !== 'route';
  $('#tourOnly').hidden = state.mode !== 'tour';
}));

$('#s_timevalue').addEventListener('input', e => $('#tvLabel').textContent = e.target.value);

/* ───────── simulation ───────── */
$('#btnRun').addEventListener('click', run);

async function run() {
  const tv = +$('#s_timevalue').value;
  const penalty = {};
  if ($('#p_noflight').checked) penalty.flight = 100000;
  if ($('#p_nobus').checked) penalty.bus = 100000;

  const btn = $('#btnRun'); btn.disabled = true; btn.textContent = 'Simulating…';
  $('#results').innerHTML = '';
  try {
    let res;
    if (state.mode === 'route') {
      res = await api('/api/route', {
        graph: state.graph, start: $('#s_start').value, end: $('#s_end').value,
        time_value: tv, k: 5, mode_penalty: penalty
      });
    } else {
      if (!state.must.size) throw new Error('Tick the places you want to visit.');
      res = await api('/api/tour', {
        graph: state.graph, start: $('#s_start').value,
        end: $('#s_tourend').value || null,
        must_visit: [...state.must], time_value: tv, top_n: 5, mode_penalty: penalty
      });
    }
    state.options = res.options; state.selected = 0;
    renderOptions();
    selectOption(0);
  } catch (err) {
    $('#results').innerHTML = `<div class="error">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Run simulation';
  }
}

function renderOptions() {
  const cheapest = Math.min(...state.options.map(o => o.total_cost));
  const fastest = Math.min(...state.options.map(o => o.travel_hours));
  $('#results').innerHTML = state.options.map((o, i) => `
    <div class="opt ${i === state.selected ? 'sel' : ''}" data-opt="${i}">
      <div class="opt-head">
        <span class="opt-rank">Option ${i + 1}</span>
        <span class="opt-cost">${money(o.total_cost)}</span>
      </div>
      <div class="opt-path">${o.labels.map(esc).join(' → ')}</div>
      <div class="opt-meta">
        ${o.total_cost === cheapest ? '<span class="best">Cheapest</span>' : ''}
        ${o.travel_hours === fastest ? '<span class="best">Fastest</span>' : ''}
        <span class="badge">${o.hops} legs</span>
        <span class="badge">${hrs(o.travel_hours)} travelling</span>
        <span class="badge">fares ${money(o.travel_cost)}</span>
        <span class="badge">stays ${money(o.stay_cost)}</span>
        ${o.modes.map(m => `<span class="badge">${m}</span>`).join('')}
      </div>
    </div>`).join('') + '<div id="detail"></div>';
}

async function selectOption(i) {
  state.selected = i;
  const o = state.options[i]; if (!o) return;
  $$('.opt').forEach((el, k) => el.classList.toggle('sel', k === i));
  gc.setRoute(o.leg_ids, o.sequence);

  const detail = $('#detail');
  detail.innerHTML = `
    <div class="card">
      <h3>Leg by leg</h3>
      <table>
        <tr><th>From → To</th><th>Mode</th><th class="num">Fare</th><th class="num">Time</th></tr>
        ${o.legs.map(l => `<tr>
          <td>${esc(l.from)} → ${esc(l.to)}</td>
          <td>${esc(l.mode)}</td>
          <td class="num">${money(l.cost)}</td>
          <td class="num">${hrs(l.hours)}</td></tr>`).join('')}
        <tr><td colspan="2"><b>Total</b></td>
            <td class="num"><b>${money(o.travel_cost)}</b></td>
            <td class="num"><b>${hrs(o.travel_hours)}</b></td></tr>
      </table>
    </div>
    <div class="card" id="mcCard"><h3>Budget simulation</h3>
      <div class="hint">Running…</div></div>`;

  try {
    const sim = await api('/api/simulate', {
      graph: state.graph, leg_ids: o.leg_ids, sequence: o.sequence,
      runs: +$('#s_runs').value || 5000,
      stay_var_pct: +$('#s_stayvar').value || 10
    });
    renderSim(sim, o);
  } catch (e) {
    $('#mcCard').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

function renderSim(sim, o) {
  const m = sim.monte_carlo;
  $('#mcCard').innerHTML = `
    <h3>Budget simulation <span class="badge">${m.runs.toLocaleString()} runs</span></h3>
    <div class="mc-grid">
      <div class="mc-cell"><div class="v">${money(m.p50)}</div><div class="k">Typical (P50)</div></div>
      <div class="mc-cell"><div class="v">${money(m.p90)}</div><div class="k">Safe budget (P90)</div></div>
      <div class="mc-cell"><div class="v">${money(m.max - m.min)}</div><div class="k">Spread</div></div>
    </div>
    <canvas id="hist"></canvas>
    <p class="micro">Best case ${money(m.min)} · worst case ${money(m.max)}. Carry <b>${money(m.recommended_budget)}</b> to be comfortable 9 times out of 10.</p>
    <h3 style="margin-top:14px">What moves the price most</h3>
    <table>
      <tr><th>Leg</th><th class="num">Fare</th><th class="num">Share</th><th class="num">Save 20%</th></tr>
      ${sim.sensitivity.slice(0, 6).map(s => `<tr>
        <td>${esc(s.leg)}</td><td class="num">${money(s.cost)}</td>
        <td class="num">${s.share_pct}%</td>
        <td class="num">−${money(s.saving_if_cheaper)}</td></tr>`).join('')}
    </table>`;
  drawHist(m.histogram);
}

function drawHist(h) {
  const c = $('#hist'); if (!c || !h.counts.length) return;
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  c.width = r.width * dpr; c.height = 80 * dpr;
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
  const max = Math.max(...h.counts), w = r.width / h.counts.length;
  h.counts.forEach((v, i) => {
    const bh = (v / max) * 68;
    g.fillStyle = accent; g.globalAlpha = 0.25 + 0.75 * (v / max);
    g.fillRect(i * w + 1, 76 - bh, Math.max(1, w - 2), bh);
  });
  g.globalAlpha = 1;
}

/* ───────── toolbar ───────── */
$('#btnTheme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('voyagraph.theme', next);
  setTimeout(() => { gc.draw(); if (state.options.length) selectOption(state.selected); }, 60);
});

$('#btnSample').addEventListener('click', async () => {
  const g = await fetch('/api/sample').then(r => r.json());
  state.graph = g; state.must = new Set();
  $('#tripName').value = g.name; $('#currency').value = g.currency;
  gc.store = state.graph; refresh(); gc.fit();
  toast('Sample trip loaded');
});

$('#btnSave').addEventListener('click', async () => {
  const r = await api('/api/trips', { graph: state.graph });
  toast(`Saved as ${r.saved}`);
});

$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.graph, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.graph.name || 'trip').replace(/[^\w\- ]/g, '') + '.json';
  a.click(); URL.revokeObjectURL(a.href);
});

$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      state.graph = JSON.parse(fr.result); state.must = new Set();
      $('#tripName').value = state.graph.name || 'Imported trip';
      $('#currency').value = state.graph.currency || 'USD';
      gc.store = state.graph; refresh(); gc.fit(); toast('Trip imported');
    } catch { toast('That file isn\'t a valid Voyagraph trip.'); }
  };
  fr.readAsText(f); e.target.value = '';
});

$('#btnTidy').addEventListener('click', () => gc.autoArrange());
$('#btnFit').addEventListener('click', () => gc.fit());
$('#tripName').addEventListener('input', cache);
$('#currency').addEventListener('change', refresh);

/* ───────── boot ───────── */
(function boot() {
  document.documentElement.dataset.theme =
    localStorage.getItem('voyagraph.theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  restore();
  $('#tripName').value = state.graph.name || 'Untitled trip';
  $('#currency').value = state.graph.currency || 'USD';

  gc = new GraphCanvas($('#graph'), state.graph, {
    onNodeClick: editNode,
    onEdgeCreate: (from, to) => {
      switchTab('links'); renderSelects();
      $('#e_from').value = from; $('#e_to').value = to;
      $('#e_cost').focus();
      toast('Fill in the fare and time, then add.');
    },
    onChange: cache
  });

  refresh();
  if (state.graph.nodes.length) gc.fit();
})();
