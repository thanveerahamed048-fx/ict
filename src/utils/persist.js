// src/utils/persist.js
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve('data');

async function ensureDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

export async function saveAsiaSnapshot(instrumentId, dayKey, sessions) {
  await ensureDir();
  const file = path.join(DATA_DIR, `${instrumentId}-${dayKey}.json`);
  const payload = {
    instrumentId,
    dayKey,
    dailyOpen: sessions.dailyOpen ?? null,
    asiaHi: sessions.asiaHi ?? null,
    asiaLo: sessions.asiaLo ?? null,
    asiaDone: sessions.asiaDone ?? false,
    prevDayHigh: sessions.prevDayHigh ?? null,
    prevDayLow: sessions.prevDayLow ?? null,
    todayHigh: sessions.todayHigh ?? null,
    todayLow: sessions.todayLow ?? null,
    savedAt: Date.now()
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}

export async function loadAsiaSnapshot(instrumentId, dayKey) {
  try {
    const file = path.join(DATA_DIR, `${instrumentId}-${dayKey}.json`);
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}