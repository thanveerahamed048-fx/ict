// src/notify/mailer.js
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';

export class Mailer {
  constructor({ host, port = 587, secure, user, pass, from, to, enabled = true, throttleMs = 60000 } = {}) {
    if (secure === undefined) secure = String(port) === '465';
    this.enabled = !!enabled;
    this.from = from;
    this.to = Array.isArray(to) ? to : String(to || '').split(',').map(s => s.trim()).filter(Boolean);
    this.throttleMs = throttleMs;
    this.lastSent = new Map();

    this.transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure,
      auth: user ? { user, pass } : undefined
    });
  }

  async sendSignal(signal) {
    if (!this.enabled || !this.to.length) return;

    const key = `${signal.type}:${signal.instrumentId}:${signal.direction || 'na'}:${signal.variant || 'na'}`;
    const now = Date.now();
    const last = this.lastSent.get(key) || 0;
    if (now - last < this.throttleMs) return;

    const { subject, text, html } = buildEmail(signal);
    await this.transporter.sendMail({ from: this.from, to: this.to.join(','), subject, text, html });
    this.lastSent.set(key, now);
  }
}

function fmt(px, d = 5) { return px == null || Number.isNaN(px) ? 'n/a' : Number(px).toFixed(d); }
function fmtPips(p) { if (p == null || Number.isNaN(p)) return 'n/a'; const s = p >= 0 ? '+' : ''; return `${s}${p.toFixed(1)} pips`; }
function fmtList(arr, d = 5) { return !Array.isArray(arr) || arr.length === 0 ? 'n/a' : arr.map(x => fmt(x, d)).join(', '); }
const labelPips = (name, pips) => pips != null ? `${name} (${pips} pips)` : name;

function buildEmail(signal) {
  const d = signal.decimals ?? 5;
  const tsNY = signal.tsMs ? DateTime.fromMillis(signal.tsMs, { zone: 'America/New_York' }).toFormat('yyyy-LL-dd HH:mm:ss') : '';
  const ses = signal.sessions || {};
  const header = `${signal.instrumentId} • ${signal.type.replace('_',' ').toUpperCase()}`;

  let subject = '';
  let mainRows = '';

  // PO3 native (kept for completeness; we won’t send it now if ModelBus stopped calling it)
  if (signal.type === 'po3_entry') {
    const rrStr = (signal.rrs || []).map(x => Number(x).toFixed(2)).join(' / ');
    subject = `PO3 ENTRY ${signal.direction?.toUpperCase()} — ${signal.instrumentId} @ ${fmt(signal.entry, d)} (RRs ${rrStr})`;
    mainRows = `
      <tr><td>Direction</td><td>${signal.direction?.toUpperCase()}</td></tr>
      <tr><td>Entry</td><td>${fmt(signal.entry, d)}</td></tr>
      <tr><td>Stop</td><td>${fmt(signal.stop, d)}</td></tr>
      <tr><td>Targets</td><td>${fmtList(signal.targets, d)}</td></tr>
      <tr><td>RRs</td><td>${rrStr}</td></tr>
    `;
  }

  // Strategy entry (PO3, FVGC, BREAKER, JUDAS) — fixed pip SL/TP
  else if (signal.type === 'strategy_entry') {
    subject = `${signal.strategy} ENTRY ${signal.direction?.toUpperCase()} — ${signal.instrumentId} @ ${fmt(signal.entry, d)}`;
    mainRows = `
      <tr><td>Strategy</td><td>${signal.strategy}</td></tr>
      <tr><td>Direction</td><td>${signal.direction?.toUpperCase()}</td></tr>
      <tr><td>Entry</td><td>${fmt(signal.entry, d)}</td></tr>
      ${signal.stop != null ? `<tr><td>Native Stop</td><td>${fmt(signal.stop, d)}</td></tr>` : ''}
      ${signal.targets ? `<tr><td>Native Targets</td><td>${fmtList(signal.targets, d)}</td></tr>` : ''}
      ${signal.sl != null ? `<tr><td>${labelPips('SL', signal.slPips)}</td><td>${fmt(signal.sl, d)}</td></tr>` : ''}
      ${signal.tp != null ? `<tr><td>${labelPips('TP', signal.tpPips)}</td><td>${fmt(signal.tp, d)}</td></tr>` : ''}
    `;
  }

  // Result
  else if (signal.type === 'result') {
    const outcome = signal.outcome?.toUpperCase();
    const variant = signal.variant || (signal.tpPips && signal.slPips ? `TP${signal.tpPips}/SL${signal.slPips}` : 'FixedPips');
    subject = `RESULT ${outcome} ${variant} — ${signal.instrumentId} ${fmt(signal.entry, d)} → ${fmt(signal.exit, d)} (${fmtPips(signal.pips)})`;
    mainRows = `
      <tr><td>Variant</td><td>${variant}</td></tr>
      <tr><td>Outcome</td><td>${outcome}</td></tr>
      <tr><td>Entry</td><td>${fmt(signal.entry, d)}</td></tr>
      <tr><td>Exit</td><td>${fmt(signal.exit, d)}</td></tr>
      <tr><td>Result</td><td>${fmtPips(signal.pips)}</td></tr>
      ${signal.meta?.cause ? `<tr><td>Cause</td><td>${signal.meta.cause}</td></tr>` : ''}
      ${signal.meta?.models ? `<tr><td>Models</td><td>${Array.isArray(signal.meta.models) ? signal.meta.models.join(', ') : signal.meta.models}</td></tr>` : ''}
      ${signal.meta?.score != null ? `<tr><td>Score</td><td>${signal.meta.score}</td></tr>` : ''}
    `;
  }

  else {
    subject = `Signal — ${signal.instrumentId}`;
  }

  const contextRows = `
    ${ses.dailyOpen != null ? `<tr><td>Daily Open</td><td>${fmt(ses.dailyOpen, d)}</td></tr>` : ''}
    ${ses.asiaLo != null && ses.asiaHi != null ? `<tr><td>Asia Range</td><td>${fmt(ses.asiaLo, d)} — ${fmt(ses.asiaHi, d)}</td></tr>` : ''}
    ${ses.prevDayHigh != null && ses.prevDayLow != null ? `<tr><td>Prev Day H/L</td><td>${fmt(ses.prevDayHigh, d)} / ${fmt(ses.prevDayLow, d)}</td></tr>` : ''}
    ${tsNY ? `<tr><td>Time (NY)</td><td>${tsNY}</td></tr>` : ''}
  `;

  const html = `
  <div style="font-family: Arial, sans-serif; color:#111; max-width:560px;">
    <div style="font-size:16px; font-weight:600; margin-bottom:8px;">${header}</div>
    <table style="border-collapse:collapse;width:100%;">
      <tbody>
        ${mainRows}
        <tr><td colspan="2" style="padding-top:8px;font-weight:600;">Context</td></tr>
        ${contextRows}
      </tbody>
    </table>
    <div style="margin-top:10px; font-size:12px; color:#555;">
      This alert is informational and not financial advice.
    </div>
  </div>`;

  const text = [
    header,
    ...(signal.type === 'strategy_entry' ? [
      `Strategy: ${signal.strategy}`,
      `Direction: ${signal.direction?.toUpperCase()}`,
      `Entry: ${fmt(signal.entry, d)}`,
      ...(signal.stop != null ? [`Native Stop: ${fmt(signal.stop, d)}`] : []),
      ...(signal.targets ? [`Native Targets: ${fmtList(signal.targets, d)}`] : []),
      ...(signal.sl != null ? [`${labelPips('SL', signal.slPips)}: ${fmt(signal.sl, d)}`] : []),
      ...(signal.tp != null ? [`${labelPips('TP', signal.tpPips)}: ${fmt(signal.tp, d)}`] : [])
    ] : []),
    ...(signal.type === 'result' ? [
      `Variant: ${signal.variant || (signal.tpPips && signal.slPips ? `TP${signal.tpPips}/SL${signal.slPips}` : 'FixedPips')}`,
      `Outcome: ${signal.outcome}`,
      `Entry: ${fmt(signal.entry, d)}`,
      `Exit: ${fmt(signal.exit, d)}`,
      `Result: ${fmtPips(signal.pips)}`
    ] : []),
    ...(ses.dailyOpen != null ? [`Daily Open: ${fmt(ses.dailyOpen, d)}`] : []),
    ...(ses.asiaLo != null && ses.asiaHi != null ? [`Asia Range: ${fmt(ses.asiaLo, d)} — ${fmt(ses.asiaHi, d)}`] : []),
    ...(ses.prevDayHigh != null && ses.prevDayLow != null ? [`Prev Day H/L: ${fmt(ses.prevDayHigh, d)} / ${fmt(ses.prevDayLow, d)}`] : []),
    ...(tsNY ? [`Time (NY): ${tsNY}`] : [])
  ].join('\n');

  return { subject, html, text };
}