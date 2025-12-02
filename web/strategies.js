// web/strategies.js
const DASHBOARD_BASE = 'https://ict-4oov.onrender.com';

const statsBody = document.getElementById('statsBody');
const refreshBtn = document.getElementById('refreshBtn');

const fmt = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));
const pct = (n) => (n == null ? '0%' : (n * 100).toFixed(1) + '%');

async function fetchJSON(path) {
  const url = `${DASHBOARD_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function loadStats() {
  try {
    const data = await fetchJSON('/stats/summary');
    const byStrategy = data.byStrategy || [];
    renderStats(byStrategy);
  } catch (err) {
    console.error(err);
    alert('Failed to load stats.');
  }
}

function renderStats(strategies) {
  statsBody.innerHTML = '';
  
  // Sort by Net Pips descending by default
  strategies.sort((a, b) => (b.netPips || 0) - (a.netPips || 0));

  for (const s of strategies) {
    const tr = document.createElement('tr');
    const netPips = s.netPips || 0;
    
    tr.innerHTML = `
      <td>${s.strategy}</td>
      <td>${s.signals || 0}</td>
      <td>${s.wins || 0}</td>
      <td>${s.losses || 0}</td>
      <td>${pct(s.winRate)}</td>
      <td class="${netPips >= 0 ? 'pips-pos' : 'pips-neg'}">${fmt(netPips, 1)}</td>
    `;
    statsBody.appendChild(tr);
  }
}

refreshBtn.addEventListener('click', loadStats);

// Init
loadStats();
