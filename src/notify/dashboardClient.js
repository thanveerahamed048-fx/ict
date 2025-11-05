// src/notify/dashboardClient.js

// Resolve dashboard API base URL
// - In Node: use env DASHBOARD_URL, else http://127.0.0.1:<PORT>
// - In Browser: use current origin
export const DASHBOARD_URL =
  typeof window === 'undefined'
    ? (process.env.DASHBOARD_URL || `http://127.0.0.1:${process.env.PORT || process.env.HTTP_PORT || 8080}`)
    : window.location.origin;

/**
 * Post a new strategy entry (open trade) to the dashboard.
 * Expected payload shape:
 * {
 *   instrumentId, strategy, direction, entry, entryTs,
 *   sl, tp, pipSize, decimals, tpPips, slPips,
 *   sessions, models, score, variantLabel
 * }
 */
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

/**
 * Post a trade result (close) to the dashboard.
 * Expected payload shape:
 * {
 *   instrumentId, strategy, entryTs, direction,
 *   exit, exitTs, outcome, pips, variant
 * }
 */
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