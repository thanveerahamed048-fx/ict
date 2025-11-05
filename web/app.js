// web/app.js
const DASHBOARD_BASE = 'http://0.0.0.0:8888';

const kpiSignals = document.getElementById('kpiSignals');
const kpiOpen = document.getElementById('kpiOpen');
const kpiClosed = document.getElementById('kpiClosed');
const kpiWinRate = document.getElementById('kpiWinRate');
const kpiNetPips = document.getElementById('kpiNetPips');
const kpiAvgPips = document.getElementById('kpiAvgPips');

const equityEl = document.getElementById('equityChart');
const dailyEl = document.getElementById('dailyChart');
const stratEl = document.getElementById('strategyChart');

const dateStart = document.getElementById('dateStart');
const dateEnd = document.getElementById('dateEnd');
const tableDate = document.getElementById('tableDate');
const instrumentSelect = document.getElementById('instrumentSelect');
const refreshBtn = document.getElementById('refreshBtn');

const statusSelect = document.getElementById('statusSelect');
const directionSelect = document.getElementById('directionSelect');
const strategyChks = () => [...document.querySelectorAll('.strategyChk:checked')].map(c => c.value);
const applyFiltersBtn = document.getElementById('applyFiltersBtn');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');
const csvBtn = document.getElementById('csvBtn');

const tradesBody = document.getElementById('tradesBody');

const drawer = document.getElementById('drawer');
const drawerClose = document.getElementById('drawerClose');
const drawerTitle = document.getElementById('drawerTitle');
const drawerBody = document.getElementById('drawerBody');

let equityChart = echarts.init(equityEl, null, { renderer: 'canvas' });
let dailyChart = echarts.init(dailyEl, null, { renderer: 'canvas' });
let stratChart = echarts.init(stratEl, null, { renderer: 'canvas' });

const fmt = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));
const pct = (n) => (n == null ? '0%' : (n * 100).toFixed(1) + '%');

let lastTrades = [];
let instrumentsPopulated = false;

async function fetchJSON(path) {
  const url = `${DASHBOARD_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function ensureInstrumentOptions(byInstrument = []) {
  if (instrumentsPopulated) return;
  const current = instrumentSelect.value;
  instrumentSelect.innerHTML = '<option value="">All instruments</option>';
  for (const row of byInstrument) {
    const id = row.instrumentId;
    if (!id) continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    instrumentSelect.appendChild(opt);
  }
  const exists = [...instrumentSelect.options].some(o => o.value === current);
  instrumentSelect.value = exists ? current : '';
  instrumentsPopulated = true;
}

async function loadSummary() {
  const data = await fetchJSON('/stats/summary');
  const t = data.totals || {};
  kpiSignals.textContent = t.signals ?? 0;
  kpiOpen.textContent = t.open ?? 0;
  kpiClosed.textContent = t.closed ?? 0;
  kpiWinRate.textContent = pct(t.winRate);
  kpiNetPips.textContent = fmt(t.netPips, 1);
  kpiNetPips.classList.toggle('pips-neg', (t.netPips || 0) < 0);
  kpiNetPips.classList.toggle('pips-pos', (t.netPips || 0) >= 0);
  kpiAvgPips.textContent = fmt(t.avgPips, 1);

  ensureInstrumentOptions(data.byInstrument || []);

  const byStrategy = data.byStrategy || [];
  stratChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item' },
    legend: { top: 0, textStyle: { color: '#A9B4C0' } },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      itemStyle: { borderColor: '#0B0F13', borderWidth: 2 },
      label: { color: '#E6EDF3' },
      data: byStrategy.map(s => ({ name: s.strategy, value: s.signals }))
    }]
  });
}

async function loadDaily() {
  const start = dateStart.value || '';
  const end = dateEnd.value || '';
  const qs = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const data = await fetchJSON(`/stats/daily${qs}`);
  const rows = (data.rows || []).sort((a,b) => a.dateNY.localeCompare(b.dateNY));
  const dates = rows.map(r => r.dateNY);
  const pl = rows.map(r => r.netPips || 0);
  const cum = [];
  pl.reduce((acc, v, i) => (cum[i] = acc + v, acc + v), 0);

  equityChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 36, right: 12, top: 24, bottom: 28 },
    xAxis: { type: 'category', data: dates, axisLine: { lineStyle: { color: '#25303A' } }, axisLabel: { color: '#A9B4C0' }},
    yAxis: { type: 'value', splitLine: { lineStyle: { color:'#25303A' }}, axisLabel: { color:'#A9B4C0' } },
    series: [{ type: 'line', data: cum, smooth: true, symbol: 'none', areaStyle: { color: 'rgba(16,185,129,0.08)' }, lineStyle: { color: '#10B981', width: 2 } }]
  });

  dailyChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 36, right: 12, top: 24, bottom: 28 },
    xAxis: { type: 'category', data: dates, axisLine: { lineStyle: { color: '#25303A' } }, axisLabel: { color:'#A9B4C0' } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color:'#25303A' }}, axisLabel: { color:'#A9B4C0' } },
    series: [{ type: 'bar', data: pl.map(v => ({ value: v, itemStyle: { color: v >= 0 ? '#22C55E' : '#EF4444' } })) }]
  });
}

async function loadTrades() {
  const inst = instrumentSelect.value;
  const date = tableDate.value || '';
  let qs = `?limit=500`;
  if (inst) qs += `&instrumentId=${encodeURIComponent(inst)}`;
  if (date) qs += `&date=${encodeURIComponent(date)}`;
  const data = await fetchJSON(`/trades${qs}`);
  lastTrades = (data.items || []);
  renderTrades();
}

function renderTrades() {
  const selectedStrategies = new Set(strategyChks());
  const status = statusSelect.value;
  const dir = directionSelect.value;

  const items = lastTrades.filter(t => {
    if (selectedStrategies.size && !selectedStrategies.has(t.strategy)) return false;
    if (status && t.status !== status) return false;
    if (dir && t.direction !== dir) return false;
    return true;
  });

  tradesBody.innerHTML = '';
  for (const t of items) {
    const tr = document.createElement('tr');
    const result = t.resultPips ?? null;
    tr.innerHTML = `
      <td>${t.entryTsNY || '—'}</td>
      <td>${t.instrumentId || '—'}</td>
      <td>${t.strategy}</td>
      <td>${t.direction?.toUpperCase() || ''}</td>
      <td>${fmt(t.entryPrice, t.decimals)}</td>
      <td>${t.slPrice != null ? fmt(t.slPrice, t.decimals) : '—'}</td>
      <td>${t.tpPrice != null ? fmt(t.tpPrice, t.decimals) : '—'}</td>
      <td><span class="badge ${t.status}">${t.status}</span></td>
      <td>${t.exitPrice != null ? fmt(t.exitPrice, t.decimals) : '—'}</td>
      <td class="${result != null ? (result>=0?'pips-pos':'pips-neg') : ''}">${result != null ? fmt(result, 1) : '—'}</td>
      <td>${t.timeToCloseMin != null ? (t.timeToCloseMin + 'm') : '—'}</td>
    `;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openDrawer(t));
    tradesBody.appendChild(tr);
  }
}

function openDrawer(t) {
  drawerTitle.textContent = `${t.instrumentId} • ${t.strategy} • ${t.direction?.toUpperCase()} • ${t.status}`;
  const ctx = t.context || {};
  drawerBody.innerHTML = `
    <div class="card" style="background:transparent;border:none;padding:0;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div class="card-title">Entry</div>
          <div>Time: ${t.entryTsNY}</div>
          <div>Price: ${fmt(t.entryPrice, t.decimals)}</div>
          <div>SL: ${t.slPrice != null ? fmt(t.slPrice, t.decimals) : '—'} (${t.slPips != null ? t.slPips + ' pips' : '—'})</div>
          <div>TP: ${t.tpPrice != null ? fmt(t.tpPrice, t.decimals) : '—'} (${t.tpPips != null ? t.tpPips + ' pips' : '—'})</div>
        </div>
        <div>
          <div class="card-title">Exit</div>
          <div>Time: ${t.exitTsNY || '—'}</div>
          <div>Price: ${t.exitPrice != null ? fmt(t.exitPrice, t.decimals) : '—'}</div>
          <div>Result: ${t.resultPips != null ? (t.resultPips>=0?'<span class="pips-pos">+'+fmt(t.resultPips,1)+'</span>':'<span class="pips-neg">'+fmt(t.resultPips,1)+'</span>') : '—'}</div>
          <div>Duration: ${t.timeToCloseMin != null ? t.timeToCloseMin + 'm' : '—'}</div>
        </div>
      </div>
      <div style="margin-top:12px;">
        <div class="card-title">Context</div>
        <div>Daily Open: ${ctx.dailyOpen != null ? fmt(ctx.dailyOpen, t.decimals) : '—'}</div>
        <div>Asia Range: ${ctx.asiaLo != null ? fmt(ctx.asiaLo, t.decimals) : '—'} – ${ctx.asiaHi != null ? fmt(ctx.asiaHi, t.decimals) : '—'}</div>
        <div>Prev Day H/L: ${ctx.prevDayHigh != null ? fmt(ctx.prevDayHigh, t.decimals) : '—'} / ${ctx.prevDayLow != null ? fmt(ctx.prevDayLow, t.decimals) : '—'}</div>
        <div>Session: ${t.session || '—'}</div>
        <div>Models: ${Array.isArray(t.models) ? t.models.join(', ') : (t.models || '—')}</div>
        <div>Score: ${t.score != null ? t.score : '—'}</div>
        <div>Variant: ${t.variantLabel || '—'}</div>
      </div>
      <div style="margin-top:12px;color:#6B7682;">ID: ${t._id}</div>
    </div>
  `;
  drawer.classList.remove('hidden');
}
drawerClose.addEventListener('click', () => drawer.classList.add('hidden'));
drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.classList.add('hidden'); });

csvBtn.addEventListener('click', () => {
  const rows = [['Time (NY)','Instrument','Strategy','Direction','Entry','SL','TP','Status','Exit','Result (pips)','Duration']];
  const selectedStrategies = new Set(strategyChks());
  const status = statusSelect.value;
  const dir = directionSelect.value;
  const items = lastTrades.filter(t => {
    if (selectedStrategies.size && !selectedStrategies.has(t.strategy)) return false;
    if (status && t.status !== status) return false;
    if (dir && t.direction !== dir) return false;
    return true;
  });
  for (const t of items) {
    rows.push([
      t.entryTsNY || '',
      t.instrumentId || '',
      t.strategy || '',
      (t.direction || '').toUpperCase(),
      fmt(t.entryPrice, t.decimals),
      t.slPrice != null ? fmt(t.slPrice, t.decimals) : '',
      t.tpPrice != null ? fmt(t.tpPrice, t.decimals) : '',
      t.status || '',
      t.exitPrice != null ? fmt(t.exitPrice, t.decimals) : '',
      t.resultPips != null ? t.resultPips : '',
      t.timeToCloseMin != null ? (t.timeToCloseMin + 'm') : ''
    ]);
  }
  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trades_${(tableDate.value || 'all')}_${instrumentSelect.value || 'all'}.csv`;
  a.click();
});

refreshBtn.addEventListener('click', () => {
  Promise.all([loadSummary(), loadDaily(), loadTrades()]).catch(console.error);
});
applyFiltersBtn.addEventListener('click', () => renderTrades());
resetFiltersBtn.addEventListener('click', () => {
  document.querySelectorAll('.strategyChk').forEach(c => c.checked = true);
  statusSelect.value = '';
  directionSelect.value = '';
  tableDate.value = '';
  instrumentSelect.value = '';
  renderTrades();
});

(function init() {
  const end = new Date();
  const start = new Date(end.getTime() - 29*24*3600*1000);
  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  dateEnd.value = fmtDate(end);
  dateStart.value = fmtDate(start);
  tableDate.value = '';

  window.addEventListener('resize', () => { equityChart.resize(); dailyChart.resize(); stratChart.resize(); });

  Promise.all([loadSummary(), loadDaily(), loadTrades()]).catch(err => {
    console.error(err);
    alert('Failed to load data. Check that your dashboard API is running and CORS enabled.');
  });

  setInterval(() => {
    loadSummary().catch(()=>{});
    loadDaily().catch(()=>{});
    loadTrades().catch(()=>{});
  }, 60_000);
})();
