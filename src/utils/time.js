import { DateTime } from 'luxon';

export const NY_ZONE = 'America/New_York';

export const nowNY = () => DateTime.now().setZone(NY_ZONE);
export const msToNY = (ms) => DateTime.fromMillis(ms, { zone: NY_ZONE });
export const nyDayKey = (dtNY) => dtNY.toFormat('yyyy-LL-dd');

export const inHourRangeNY = (dtNY, startHour, endHour) => {
  const hr = dtNY.hour + dtNY.minute / 60;
  return hr >= startHour && hr <= endHour;
};

// Sessions (PO3 defaults)
export const SESSIONS = {
  ASIA_START: 0,
  ASIA_END: 5,
  LONDON_START: 2,
  LONDON_END: 5,
  NY_START: 8.5,
  NY_END: 11
};