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
      auth: user ? { user, pass } : undefined,
      logger: true, // turn on nodemailer logs
      debug: true   // verbose SMTP logs
      // tls: { minVersion: 'TLSv1.2' } // uncomment if your provider requires explicit TLS >=1.2
    });
  }

  async verify() {
    if (!this.enabled) {
      console.warn('[mailer] disabled (MAIL_ENABLED!=1)');
      return;
    }
    try {
      await this.transporter.verify();
      console.log('[mailer] SMTP connection verified OK');
    } catch (e) {
      console.error('[mailer] SMTP verify failed:', e.message);
      throw e;
    }
  }

  async sendSignal(signal) {
    if (!this.enabled || !this.to.length) {
      console.warn('[mailer] send skipped (disabled or no recipients)');
      return;
    }
    const key = `${signal.type}:${signal.instrumentId}:${signal.direction || 'na'}:${signal.variant || 'na'}`;
    const now = Date.now();
    const last = this.lastSent.get(key) || 0;
    if (now - last < this.throttleMs) {
      // console.log('[mailer] throttled', key);
      return;
    }

    const { subject, text, html } = buildEmail(signal);
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: this.to.join(','),
        subject,
        text,
        html
      });
      console.log('[mailer] sent:', info.messageId);
      this.lastSent.set(key, now);
    } catch (e) {
      console.error('[mailer] send failed:', e.message);
      throw e;
    }
  }
}

// ... keep buildEmail as-is ...
