// src/notify/dashboardClient.js
export const DASHBOARD_URL = 'http://localhost:8888';

export async function postStrategyEntry(payload) {
  try {
    const res = await fetch(`${DASHBOARD_URL}/_internal/strategy_entry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const msg = await res.text();
      console.warn('dashboard entry failed:', res.status, msg);
    }
  } catch (e) {
    console.warn('dashboard entry error:', e.message);
  }
}

export async function postResult(payload) {
  try {
    const res = await fetch(`${DASHBOARD_URL}/_internal/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const msg = await res.text();
      console.warn('dashboard result failed:', res.status, msg);
    }
  } catch (e) {
    console.warn('dashboard result error:', e.message);
  }
}