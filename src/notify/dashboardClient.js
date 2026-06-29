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
 * Post a trade result (full close) to the dashboard.
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

/**
 * Notify the dashboard of a partial close (scale-out).
 * Payload: { instrumentId, strategy, entryTs, exitPrice, exitTs,
 *            partialPips, partialLots, remainingLots, slEvents }
 */
export async function postPartialClose(payload) {
  try {
    const res = await fetch(`${DASHBOARD_URL}/_internal/partial_close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const msg = await res.text();
      console.warn('dashboard partial_close failed:', res.status, msg);
    }
  } catch (e) {
    console.warn('dashboard partial_close error:', e.message);
  }
}

/**
 * Notify the dashboard that a trade's SL was moved (e.g. break-even).
 * Payload: { instrumentId, strategy, entryTs, newSl, slEvents }
 */
export async function postSlUpdate(payload) {
  try {
    const res = await fetch(`${DASHBOARD_URL}/_internal/sl_update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const msg = await res.text();
      console.warn('dashboard sl_update failed:', res.status, msg);
    }
  } catch (e) {
    console.warn('dashboard sl_update error:', e.message);
  }
}
