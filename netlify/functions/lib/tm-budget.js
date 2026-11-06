// How many ScraperAPI credits TM Watch may spend right now.
//
// The free plan gives 1,000 credits a month and a full TM Watch day can use
// 150, so a flat per-run budget empties the account in about a week (it hit
// 1,042/1,000 on 6 Nov 2026) and the watch then stands still until the
// reset. Instead, what is left is spread evenly over the days until the
// reset: each day may spend its share, and a day that spends less leaves
// more for the days after it.
//
//   remaining   credits left on the account now (null = unknown)
//   spentToday  credits TM Watch already spent today (all runs/links)
//   nextReset   'YYYY-MM-DD' of the next monthly reset (null = unknown)
//   today       'YYYY-MM-DD' (UTC)
//   reserve     credits never touched (safety margin)
//   perRunMax   hard ceiling for one run
const DAY = 86400000;

function daysUntil(nextReset, today) {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${nextReset}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(1, Math.ceil((b - a) / DAY));
}

function tmSpendCap({ remaining, spentToday = 0, nextReset, today, reserve = 20, perRunMax = 150 }) {
  if (remaining == null) return Math.min(perRunMax, 30);
  const usable = Math.max(0, remaining - reserve);
  const days = nextReset ? daysUntil(nextReset, today) : null;
  // Unknown reset date: assume a 30-day month.
  const perDay = Math.floor((usable + spentToday) / (days ?? 30));
  return Math.max(0, Math.min(perRunMax, usable, perDay - spentToday));
}

module.exports = { tmSpendCap, daysUntil };
