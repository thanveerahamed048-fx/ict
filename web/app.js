// web/app.js
const DASHBOARD_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.port !== ""
  ? window.location.origin
  : 'https://ict-4oov.onrender.com';

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

// Prop Firm UI variables
const propFirmTitle = document.getElementById('propFirmTitle');
const propFirmStatusBadge = document.getElementById('propFirmStatusBadge');
const payoutBtn = document.getElementById('payoutBtn');
const settingsBtn = document.getElementById('settingsBtn');
const propBalance = document.getElementById('propBalance');
const propEquity = document.getElementById('propEquity');
const propInitial = document.getElementById('propInitial');
const propDailyDrawdown = document.getElementById('propDailyDrawdown');
const propDailyProgress = document.getElementById('propDailyProgress');
const propWatermark = document.getElementById('propWatermark');
const propOverallDrawdown = document.getElementById('propOverallDrawdown');
const propOverallProgress = document.getElementById('propOverallProgress');
const propMinEquity = document.getElementById('propMinEquity');
const propProfitProgress = document.getElementById('propProfitProgress');
const propProfitLimit = document.getElementById('propProfitLimit');
const propProfitProgressBar = document.getElementById('propProfitProgressBar');
const propProfitPct = document.getElementById('propProfitPct');
const propDays = document.getElementById('propDays');
const propDaysProgress = document.getElementById('propDaysProgress');
const propDaysList = document.getElementById('propDaysList');

// Settings modal UI variables
const settingsModal = document.getElementById('settingsModal');
const modalClose = document.getElementById('modalClose');
const settingsForm = document.getElementById('settingsForm');
const firmSelect = document.getElementById('firmSelect');
const phaseSelect = document.getElementById('phaseSelect');
const balanceInput = document.getElementById('balanceInput');
const riskTypeSelect = document.getElementById('riskTypeSelect');
const riskPercentInput = document.getElementById('riskPercentInput');
const fixedLotsInput = document.getElementById('fixedLotsInput');
const riskPercentGroup = document.getElementById('riskPercentGroup');
const fixedLotsGroup = document.getElementById('fixedLotsGroup');

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

async function loadPropFirmStatus() {
  try {
    const acc = await fetchJSON('/api/prop-firm/account');
    
    // Title
    const firmLabel = acc.firm === 'goat' ? 'Goat Funded Trader' : 'FundingPips';
    let phaseLabel = 'Phase 1';
    if (acc.phase === 'phase2') phaseLabel = 'Phase 2';
    else if (acc.phase === 'funded') phaseLabel = 'Funded Stage';
    propFirmTitle.textContent = `${firmLabel} • ${phaseLabel}`;
    
    // Status badge
    propFirmStatusBadge.className = 'status-badge badge';
    if (acc.failed) {
      propFirmStatusBadge.textContent = 'FAILED';
      propFirmStatusBadge.classList.add('failed');
      propBalance.classList.add('failed-text');
      propEquity.classList.add('failed-text');
    } else if (acc.phase === 'funded') {
      propFirmStatusBadge.textContent = 'FUNDED';
      propFirmStatusBadge.classList.add('passed');
      propBalance.classList.remove('failed-text');
      propEquity.classList.remove('failed-text');
    } else {
      propFirmStatusBadge.textContent = 'ACTIVE';
      propFirmStatusBadge.classList.add('active');
      propBalance.classList.remove('failed-text');
      propEquity.classList.remove('failed-text');
    }

    // Payout Button Visibility
    if (acc.phase === 'funded' && !acc.failed && (acc.balance - acc.initialBalance) > 0) {
      payoutBtn.style.display = 'inline-block';
    } else {
      payoutBtn.style.display = 'none';
    }

    // Metrics
    propBalance.textContent = '$' + fmt(acc.balance, 2);
    propEquity.textContent = '$' + fmt(acc.equity, 2);
    propInitial.textContent = '$' + fmt(acc.initialBalance, 2);
    propWatermark.textContent = '$' + fmt(acc.highWatermark, 2);

    // 1. Daily Drawdown
    const dailyMaxLimit = acc.highWatermark * 0.05;
    const currentDailyDrawdownVal = Math.max(0, acc.highWatermark - acc.equity);
    const dailyDrawdownPct = acc.highWatermark > 0 ? (currentDailyDrawdownVal / dailyMaxLimit) * 100 : 0;
    
    propDailyDrawdown.textContent = fmt((currentDailyDrawdownVal / acc.highWatermark) * 100, 2) + '%';
    document.querySelector('.prop-firm-metrics .metric-card:nth-child(2) .metric-limit').textContent = `/ $${fmt(dailyMaxLimit, 2)}`;
    propDailyProgress.style.width = Math.min(100, dailyDrawdownPct) + '%';
    if (dailyDrawdownPct >= 80) {
      propDailyProgress.style.backgroundColor = 'var(--danger)';
    } else if (dailyDrawdownPct >= 50) {
      propDailyProgress.style.backgroundColor = '#fca311';
    } else {
      propDailyProgress.style.backgroundColor = 'var(--accent)';
    }

    // 2. Overall Drawdown
    const overallMaxLimit = acc.initialBalance * 0.10;
    const minEquityAllowed = acc.initialBalance - overallMaxLimit;
    const currentOverallDrawdownVal = Math.max(0, acc.initialBalance - acc.equity);
    const overallDrawdownPct = acc.initialBalance > 0 ? (currentOverallDrawdownVal / overallMaxLimit) * 100 : 0;
    
    propOverallDrawdown.textContent = fmt((currentOverallDrawdownVal / acc.initialBalance) * 100, 2) + '%';
    propMinEquity.textContent = '$' + fmt(minEquityAllowed, 2);
    document.querySelector('.prop-firm-metrics .metric-card:nth-child(3) .metric-limit').textContent = `/ $${fmt(overallMaxLimit, 2)}`;
    propOverallProgress.style.width = Math.min(100, overallDrawdownPct) + '%';
    if (overallDrawdownPct >= 80) {
      propOverallProgress.style.backgroundColor = 'var(--danger)';
    } else if (overallDrawdownPct >= 50) {
      propOverallProgress.style.backgroundColor = '#fca311';
    } else {
      propOverallProgress.style.backgroundColor = 'var(--accent)';
    }

    // 3. Profit Target
    let targetPct = 0;
    if (acc.phase === 'phase1') targetPct = 10;
    else if (acc.phase === 'phase2') targetPct = 5;
    
    if (targetPct > 0) {
      const targetVal = acc.initialBalance * (targetPct / 100);
      const currentProfit = Math.max(0, acc.balance - acc.initialBalance);
      const profitTargetPct = (currentProfit / targetVal) * 100;
      
      propProfitProgress.textContent = '$' + fmt(currentProfit, 2);
      propProfitLimit.textContent = `/ $${fmt(targetVal, 2)}`;
      propProfitLimit.style.display = 'inline';
      propProfitProgressBar.style.width = Math.min(100, profitTargetPct) + '%';
      propProfitPct.textContent = fmt(Math.min(100, profitTargetPct), 1) + '%';
      document.querySelector('.prop-firm-metrics .metric-card:nth-child(4) .metric-label').textContent = `Profit Target (${targetPct}%)`;
    } else {
      // Funded
      const profit = acc.balance - acc.initialBalance;
      propProfitProgress.textContent = profit >= 0 ? '+$' + fmt(profit, 2) : '-$' + fmt(Math.abs(profit), 2);
      propProfitLimit.style.display = 'none';
      propProfitProgressBar.style.width = '100%';
      propProfitPct.textContent = 'N/A (Funded)';
      document.querySelector('.prop-firm-metrics .metric-card:nth-child(4) .metric-label').textContent = 'Funded Profits';
    }

    // 4. Trading Days
    const daysCount = acc.tradingDays ? acc.tradingDays.length : 0;
    const daysProgressPct = (daysCount / 3) * 100;
    propDays.textContent = daysCount;
    propDaysProgress.style.width = Math.min(100, daysProgressPct) + '%';
    propDaysList.textContent = acc.tradingDays && acc.tradingDays.length > 0
      ? acc.tradingDays.join(', ')
      : 'No days traded yet';
  } catch (e) {
    console.warn('Error loading prop firm status:', e.message);
  }
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
    const pnl = t.pnl ?? (result != null ? result * (t.lots || 2.0) * 10 : null);
    tr.innerHTML = `
      <td>${t.entryTsNY || '—'}</td>
      <td>${t.instrumentId || '—'}</td>
      <td>${t.strategy}</td>
      <td>${t.direction?.toUpperCase() || ''}</td>
      <td>${t.lots != null ? t.lots : '—'}</td>
      <td>${fmt(t.entryPrice, t.decimals)}</td>
      <td>${t.slPrice != null ? fmt(t.slPrice, t.decimals) : '—'}</td>
      <td>${t.tpPrice != null ? fmt(t.tpPrice, t.decimals) : '—'}</td>
      <td>
        <span class="badge ${t.status}">${t.status}</span>
        ${t.exitReason === 'be' ? '<span class="badge" style="background:#92400E;color:#FDE68A;margin-left:4px;">BE</span>' : ''}
        ${Array.isArray(t.slEvents) && t.slEvents.length > 0 && t.status === 'open' ? '<span class="badge" style="background:#065F46;color:#6EE7B7;margin-left:4px;">🔒BE</span>' : ''}
        ${Array.isArray(t.partialEvents) && t.partialEvents.length > 0 ? '<span class="badge" style="background:#1E3A5F;color:#93C5FD;margin-left:4px;">½</span>' : ''}
      </td>
      <td>${t.exitPrice != null ? fmt(t.exitPrice, t.decimals) : '—'}</td>
      <td class="${result != null ? (result>=0?'pips-pos':'pips-neg') : ''}">${result != null ? fmt(result, 1) : '—'}</td>
      <td class="${pnl != null ? (pnl>=0?'pips-pos':'pips-neg') : ''}">${pnl != null ? '$' + fmt(pnl, 2) : '—'}</td>
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
  const result = t.resultPips ?? null;
  const pnl = t.pnl ?? (result != null ? result * (t.lots || 2.0) * 10 : null);

  // SL events / break-even history
  const slEvents = Array.isArray(t.slEvents) && t.slEvents.length > 0 ? t.slEvents : null;

  // Partial close history
  const partialEvents = Array.isArray(t.partialEvents) && t.partialEvents.length > 0 ? t.partialEvents : null;
  const partialEventsHtml = partialEvents
    ? `<div style="margin-top:12px;">
        <div class="card-title">Partial Closes (Scale-Out)</div>
        ${partialEvents.map((ev, i) => {
          const ts = ev.exitTs ? new Date(ev.exitTs).toISOString().replace('T',' ').slice(0,19) + ' UTC' : '—';
          return `<div style="display:flex;gap:12px;padding:4px 0;border-bottom:1px solid #1E2A35;font-size:12px;">
            <span style="color:#A9B4C0;min-width:60px;">Close ${i + 1}</span>
            <span>@ <strong>${fmt(ev.exitPrice, t.decimals)}</strong></span>
            <span class="${(ev.pips ?? 0) >= 0 ? 'pips-pos' : 'pips-neg'}">${ev.pips != null ? (ev.pips >= 0 ? '+' : '') + fmt(ev.pips, 1) + ' pips' : '—'}</span>
            <span style="color:#A9B4C0;">${ev.lots != null ? ev.lots + ' lots' : '—'}</span>
            <span style="color:#6B7682;margin-left:auto;">${ts}</span>
          </div>`;
        }).join('')}
      </div>`
    : '';
  const slEventsHtml = slEvents
    ? `<div style="margin-top:12px;">
        <div class="card-title">SL Move History</div>
        ${slEvents.map(ev => {
          const label = ev.type === 'break_even' ? '🔒 Break-Even' : ev.type;
          const ts = ev.atTs ? new Date(ev.atTs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
          return `<div style="display:flex;gap:12px;padding:4px 0;border-bottom:1px solid #1E2A35;font-size:12px;">
            <span style="color:#A9B4C0;min-width:110px;">${label}</span>
            <span>SL: <span style="text-decoration:line-through;color:#6B7682;">${fmt(ev.fromSl, t.decimals)}</span> → <span style="color:#10B981;">${fmt(ev.toSl, t.decimals)}</span></span>
            <span style="color:#6B7682;">@ ${fmt(ev.atPrice, t.decimals)}</span>
            <span style="color:#6B7682;margin-left:auto;">${ts}</span>
          </div>`;
        }).join('')}
      </div>`
    : '';

  // Exit reason badge
  const exitReasonLabel = t.exitReason === 'be'
    ? '<span style="color:#F59E0B;font-weight:600;">BE (Break-Even)</span>'
    : t.exitReason === 'tp'
    ? '<span class="pips-pos">TP Hit</span>'
    : t.exitReason === 'sl'
    ? '<span class="pips-neg">SL Hit</span>'
    : t.exitReason || '—';

  drawerBody.innerHTML = `
    <div class="card" style="background:transparent;border:none;padding:0;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div class="card-title">Entry</div>
          <div>Time: ${t.entryTsNY}</div>
          <div>Price: ${fmt(t.entryPrice, t.decimals)}</div>
          <div>Lots: ${t.lots != null ? t.lots : '—'}</div>
          <div>SL: ${t.slPrice != null ? fmt(t.slPrice, t.decimals) : '—'} (${t.slPips != null ? t.slPips + ' pips' : '—'})</div>
          <div>TP: ${t.tpPrice != null ? fmt(t.tpPrice, t.decimals) : '—'} (${t.tpPips != null ? t.tpPips + ' pips' : '—'})</div>
          ${slEvents ? `<div style="margin-top:4px;color:#F59E0B;font-size:12px;">🔒 BE triggered</div>` : ''}
        </div>
        <div>
          <div class="card-title">Exit</div>
          <div>Time: ${t.exitTsNY || '—'}</div>
          <div>Price: ${t.exitPrice != null ? fmt(t.exitPrice, t.decimals) : '—'}</div>
          <div>Reason: ${exitReasonLabel}</div>
          <div>Result: ${result != null ? (result>=0?'<span class="pips-pos">+'+fmt(result,1)+'</span>':'<span class="pips-neg">'+fmt(result,1)+'</span>') : '—'}</div>
          <div>PnL: ${pnl != null ? (pnl>=0?'<span class="pips-pos">+$'+fmt(pnl,2)+'</span>':'<span class="pips-neg">-$'+fmt(Math.abs(pnl),2)+'</span>') : '—'}</div>
          <div>Duration: ${t.timeToCloseMin != null ? t.timeToCloseMin + 'm' : '—'}</div>
        </div>
      </div>
      ${partialEventsHtml}
      ${slEventsHtml}
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
  Promise.all([loadSummary(), loadDaily(), loadTrades(), loadPropFirmStatus()]).catch(console.error);
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

// Position sizing mode toggle
riskTypeSelect.addEventListener('change', () => {
  if (riskTypeSelect.value === 'fixed_lots') {
    riskPercentGroup.style.display = 'none';
    fixedLotsGroup.style.display = 'block';
  } else {
    riskPercentGroup.style.display = 'block';
    fixedLotsGroup.style.display = 'none';
  }
});

// Configure Challenge Modal events
settingsBtn.addEventListener('click', async () => {
  // Open modal instantly so the click is immediately responsive
  settingsModal.classList.remove('hidden');

  try {
    const acc = await fetchJSON('/api/prop-firm/account');
    firmSelect.value = acc.firm || 'goat';
    phaseSelect.value = acc.phase || 'phase1';
    balanceInput.value = acc.initialBalance || 100000;
    riskTypeSelect.value = acc.riskType || 'fixed_percent';
    riskPercentInput.value = acc.riskPercent != null ? acc.riskPercent : 1.0;
    fixedLotsInput.value = acc.fixedLots != null ? acc.fixedLots : 2.0;

    // Trigger update
    riskTypeSelect.dispatchEvent(new Event('change'));
  } catch (e) {
    console.error('Error fetching challenge state:', e);
  }
});

modalClose.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = settingsForm.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Applying...';
  try {
    const payload = {
      firm: firmSelect.value,
      phase: phaseSelect.value,
      initialBalance: Number(balanceInput.value),
      riskType: riskTypeSelect.value,
      riskPercent: Number(riskPercentInput.value),
      fixedLots: Number(fixedLotsInput.value)
    };

    const res = await fetch(`${DASHBOARD_BASE}/api/prop-firm/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      let msg = `Server error ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch { msg = await res.text() || msg; }
      throw new Error(msg);
    }
    settingsModal.classList.add('hidden');
    await Promise.all([loadSummary(), loadDaily(), loadTrades(), loadPropFirmStatus()]);
  } catch (err) {
    alert('Failed to reset challenge: ' + (err.message || 'Unknown error. Check the console.'));
    console.error('[reset]', err);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

// Payout button request
payoutBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to withdraw your profits and request a payout?')) return;
  try {
    const res = await fetch(`${DASHBOARD_BASE}/api/prop-firm/payout`, { method: 'POST' });
    if (!res.ok) {
      const errTxt = await res.text();
      let errJson;
      try { errJson = JSON.parse(errTxt); } catch(e) {}
      throw new Error(errJson?.error || errTxt);
    }
    const data = await res.json();
    alert(`Payout processed successfully! Split Paid: $${data.payout.splitPaid.toFixed(2)}`);
    await Promise.all([loadSummary(), loadDaily(), loadTrades(), loadPropFirmStatus()]);
  } catch (err) {
    alert('Payout request failed: ' + err.message);
  }
});

// ── Live ticker strip ────────────────────────────────────────────────────
const tickerItems = document.getElementById('tickerItems');
const wsStatusDot = document.getElementById('wsStatus');
const prevPrices = new Map(); // instrumentId -> last known price (for flash direction)

async function loadTicker() {
  try {
    const data = await fetchJSON('/api/ticks');

    // WS status dot
    if (data.wsConnected) {
      wsStatusDot.className = 'ws-dot connected';
      wsStatusDot.title = 'Feed connected';
    } else {
      wsStatusDot.className = 'ws-dot disconnected';
      wsStatusDot.title = 'Feed disconnected';
    }

    const items = data.items || [];
    if (!items.length) return;

    // On first call: build ALL chips at once (even those with null price)
    // so the strip always shows every instrument from the start
    if (tickerItems.querySelector('.ticker-placeholder')) {
      tickerItems.innerHTML = '';
      for (const tick of items) {
        const el = document.createElement('div');
        el.className = 'ticker-item';
        el.id = `tick-${tick.instrumentId}`;
        // Add a subtle divider between FX/Metal and Crypto
        if (tick.isCrypto && !tickerItems.querySelector('.ticker-divider')) {
          const div = document.createElement('span');
          div.className = 'ticker-divider';
          div.textContent = '|';
          div.style.cssText = 'color:var(--line);padding:0 4px;align-self:stretch;display:flex;align-items:center;';
          tickerItems.appendChild(div);
        }
        el.innerHTML = `
          <span class="ticker-sym">${tick.instrumentId}</span>
          <span class="ticker-price" id="tick-price-${tick.instrumentId}">—</span>
          <span class="ticker-age"  id="tick-age-${tick.instrumentId}">…</span>
        `;
        tickerItems.appendChild(el);
      }
    }

    // Update prices and ages for every instrument
    for (const tick of items) {
      const id = tick.instrumentId;
      const priceEl = document.getElementById(`tick-price-${id}`);
      const ageEl   = document.getElementById(`tick-age-${id}`);
      if (!priceEl || !ageEl) continue;

      if (tick.price != null) {
        const prev = prevPrices.get(id);
        const priceStr = tick.price.toFixed(tick.decimals);

        // Flash direction colour
        priceEl.classList.remove('up', 'down');
        if (prev != null && tick.price !== prev) {
          priceEl.classList.add(tick.price > prev ? 'up' : 'down');
          setTimeout(() => priceEl.classList.remove('up', 'down'), 1200);
        }
        priceEl.textContent = priceStr;
        prevPrices.set(id, tick.price);
      } else {
        priceEl.textContent = '—';
      }

      // Age — red if > 30 s, or no data yet
      if (tick.ageSec != null) {
        ageEl.textContent = tick.ageSec < 60 ? `${tick.ageSec}s` : `${Math.floor(tick.ageSec / 60)}m`;
        ageEl.className   = tick.ageSec > 30 ? 'ticker-age stale' : 'ticker-age';
      } else {
        ageEl.textContent = 'waiting';
        ageEl.className   = 'ticker-age stale';
      }
    }
  } catch (e) {
    // silently fail — strip will just not update
  }
}

(function init() {
  const end = new Date();
  const start = new Date(end.getTime() - 29*24*3600*1000);
  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  dateEnd.value = fmtDate(end);
  dateStart.value = fmtDate(start);
  tableDate.value = '';

  window.addEventListener('resize', () => { equityChart.resize(); dailyChart.resize(); stratChart.resize(); });

  Promise.all([loadSummary(), loadDaily(), loadTrades(), loadPropFirmStatus()]).catch(err => {
    console.error(err);
    alert('Failed to load data. Check that your dashboard API is running and CORS enabled.');
  });

  // Ticker updates more frequently than the rest of the dashboard
  loadTicker().catch(() => {});
  setInterval(() => loadTicker().catch(() => {}), 2000);

  setInterval(() => {
    loadSummary().catch(()=>{});
    loadDaily().catch(()=>{});
    loadTrades().catch(()=>{});
    loadPropFirmStatus().catch(()=>{});
  }, 5000);
})();
