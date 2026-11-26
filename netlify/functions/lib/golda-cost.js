// What Golda's thinking costs, and the ceiling on what she may spend on her own.
//
// Every model call ends with record(): the tokens the API reported are priced
// from the table below and added to the day's ledger,
//   golda_cost/{Israel date YYYY-MM-DD} =
//     { totalUsd, backgroundUsd, byKind: { [kind]: { usd, calls } }, calls,
//       estimatedCalls, warnedAt, cappedAt, updatedAt }
// The ledger holds numbers only: never a message, a name or a prompt.
//
// The ceiling (app_meta/goldaCost.capUsd, US dollars a day, 5 unless the
// admin changed it on the System screen) applies to BACKGROUND work only: what
// Golda does on her own (scouting, the radar, research, reviews, deal work).
// A conversation and a briefing are never blocked: a person is waiting for
// them. A background job asks gate() before it starts and skips with a job
// note when the day's background spend has reached the ceiling. A ceiling of
// 0 switches background work off.
//
// Recording never breaks the call that produced the answer: a ledger that
// cannot be written is logged and the answer goes on.
//
// `calls` counts pieces of work, not API requests: a chat message that took
// several steps of the tool loop is one, and so is one scouted requirement.
// warnedAt is kept for an early warning that nothing sends yet; cappedAt is
// stamped by capNotice() the first time the ceiling is reached that day, so
// the owner hears it once.
const { israelDate } = require('@goldas/domain');

// US dollars per million tokens. cacheWrite is the 5-minute cache (the only
// one the code uses), cacheWrite1h the 1-hour one.
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read on
// 2026-11-25; the same numbers as the claude-api skill's reference (cached
// 2026-11-03). First-party API list prices; no negotiated discount is applied.
// A model that is not here has no price: its call is recorded at 0 and
// counted in estimatedCalls, never guessed.
const PRICES_AS_OF = '2026-11-25';
const PRICES = {
  // The model every Golda call asks for (lib/golda-effort.js).
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5, cacheWrite1h: 8 },
  // What may answer instead when the first model declines (fallbacks: 'default').
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25, cacheWrite1h: 10 },
};
// One web search, whatever the model: $10 per 1,000 searches (same source).
const WEB_SEARCH_USD = 10 / 1000;

const KINDS = ['chat', 'briefing', 'scouting', 'radar', 'research', 'review', 'deal', 'other'];
// Never blocked: a person is waiting for the answer.
const FOREGROUND = new Set(['chat', 'briefing']);
const isBackground = (kind) => !FOREGROUND.has(kind);

const LEDGER = 'golda_cost';
const SETTINGS = ['app_meta', 'goldaCost'];
const DEFAULT_CAP_USD = 5;
const CAP_MIN = 0;
const CAP_MAX = 100;
const DAYS_SHOWN = 14;

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const micro = (v) => Math.round(num(v) * 1e6) / 1e6;       // no floating-point dust in the ledger
const cents = (v) => Math.round(num(v) * 100) / 100;
const dayOf = (now = Date.now()) => israelDate(now instanceof Date ? now : new Date(now));
const msOf = (now = Date.now()) => (now instanceof Date ? now.getTime() : Number(now) || Date.now());

/**
 * The token counts of one answer, whichever way they are spelled: the SDK's
 * (input_tokens, cache_read_input_tokens, server_tool_use.web_search_requests)
 * or the sums the agent keeps over a tool loop (inputTokens, cacheReadTokens).
 */
function tokensOf(usage) {
  const u = usage || {};
  const write = num(u.cache_creation_input_tokens ?? u.cacheWriteTokens);
  const write1h = Math.min(write, num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
  return {
    input: num(u.input_tokens ?? u.inputTokens),
    output: num(u.output_tokens ?? u.outputTokens),
    cacheRead: num(u.cache_read_input_tokens ?? u.cacheReadTokens),
    cacheWrite: write - write1h,
    cacheWrite1h: write1h,
    searches: num((u.server_tool_use && u.server_tool_use.web_search_requests) ?? u.searches),
  };
}

/**
 * A running sum over the answers of one piece of work (a tool loop, a search
 * that pauses and resumes), in the SDK's field names:
 *   let spent = null; … spent = addUsage(spent, res.usage); … record(db, { usage: spent })
 */
function addUsage(sum, usage) {
  const a = tokensOf(sum), b = tokensOf(usage);
  return {
    input_tokens: a.input + b.input, output_tokens: a.output + b.output,
    cache_read_input_tokens: a.cacheRead + b.cacheRead,
    cache_creation_input_tokens: a.cacheWrite + a.cacheWrite1h + b.cacheWrite + b.cacheWrite1h,
    cache_creation: { ephemeral_1h_input_tokens: a.cacheWrite1h + b.cacheWrite1h },
    server_tool_use: { web_search_requests: a.searches + b.searches },
  };
}

/**
 * priceOf({ model, usage, searches }) → { usd, estimated }
 * Pure. `searches` (web searches) overrides the count in `usage` when given.
 * A model without a price comes out as { usd: 0, estimated: true }.
 */
function priceOf({ model, usage, searches } = {}) {
  const p = PRICES[String(model || '')];
  if (!p) return { usd: 0, estimated: true };
  const t = tokensOf(usage);
  const n = searches == null ? t.searches : num(searches);
  const usd = (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.cacheWrite1h * p.cacheWrite1h) / 1e6
    + n * WEB_SEARCH_USD;
  return { usd: micro(usd), estimated: false };
}

/** A day's ledger as clean numbers, whatever is stored. */
function dayView(date, d) {
  const src = d || {};
  const byKind = {};
  for (const k of KINDS) {
    const row = src.byKind && src.byKind[k];
    if (row && (num(row.usd) || num(row.calls))) byKind[k] = { usd: micro(row.usd), calls: Math.floor(num(row.calls)) };
  }
  return {
    date, totalUsd: micro(src.totalUsd), backgroundUsd: micro(src.backgroundUsd), byKind,
    calls: Math.floor(num(src.calls)), estimatedCalls: Math.floor(num(src.estimatedCalls)),
    warnedAt: num(src.warnedAt) || null, cappedAt: num(src.cappedAt) || null,
  };
}

/** A ceiling the admin may set: a number from 0 to 100 dollars a day. */
const validCap = (v) => typeof v === 'number' && Number.isFinite(v) && v >= CAP_MIN && v <= CAP_MAX;

async function readCap(db) {
  const snap = await db.collection(SETTINGS[0]).doc(SETTINGS[1]).get();
  const v = snap.exists ? (snap.data() || {}).capUsd : undefined;
  return validCap(v) ? v : DEFAULT_CAP_USD;
}

async function readDay(db, now = Date.now()) {
  const date = dayOf(now);
  const snap = await db.collection(LEDGER).doc(date).get();
  return dayView(date, snap.exists ? snap.data() : null);
}

/**
 * billedModel(reported, asked) → the model id a call is priced as.
 * The model the answer says it came from (a fallback may have answered), when
 * the table prices it (a dated id is priced as its undated name); an id the
 * table does not know is priced as the dearest
 * model in the table, never at 0; no id at all → the model that was asked for.
 */
function billedModel(reported, asked) {
  const r = String(reported || '');
  if (!r) return asked;
  if (PRICES[r]) return r;
  const undated = r.replace(/-\d{8}$/, '');           // 'claude-opus-5-5-20261101' is 'claude-opus-5-5'
  if (PRICES[undated]) return undated;
  return Object.keys(PRICES).reduce((a, b) => (PRICES[b].output > PRICES[a].output || (PRICES[b].output === PRICES[a].output && PRICES[b].input > PRICES[a].input) ? b : a));
}

/**
 * estimateUsage(request) → usage in the SDK's field names, for a call that
 * threw or was stopped before its answer said what it used. On the high side:
 * one input token per two characters of the request, half of max_tokens as
 * output, and every web search the request allowed.
 */
function estimateUsage(req = {}) {
  const r = req || {};
  const text = JSON.stringify({ system: r.system || '', messages: r.messages || [], tools: r.tools || [] });
  const searches = (Array.isArray(r.tools) ? r.tools : []).reduce((n, t) => n + (t && /web_search/.test(String(t.type || '')) ? num(t.max_uses) : 0), 0);
  return { input_tokens: Math.ceil(text.length / 2), output_tokens: Math.ceil(num(r.max_tokens) / 2), server_tool_use: { web_search_requests: searches } };
}

/**
 * record(db, { kind, model, usage, searches, now, estimate }) → { usd, totalUsd }
 * Adds one answer's cost to the day's ledger, in a transaction. Never throws:
 * when the ledger cannot be written, totalUsd is null and the caller goes on.
 * estimate: true marks a cost that was estimated (estimateUsage), not reported:
 * it is counted in estimatedCalls.
 */
async function record(db, { kind = 'other', model, usage, searches, now = Date.now(), estimate = false } = {}) {
  const k = KINDS.includes(kind) ? kind : 'other';
  const priced = priceOf({ model, usage, searches });
  const usd = priced.usd, estimated = priced.estimated || Boolean(estimate);
  if (!db) return { usd, totalUsd: null };
  try {
    const date = dayOf(now);
    const ref = db.collection(LEDGER).doc(date);
    const totalUsd = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = dayView(date, snap.exists ? snap.data() : null);
      const row = d.byKind[k] || { usd: 0, calls: 0 };
      const next = {
        totalUsd: micro(d.totalUsd + usd),
        backgroundUsd: micro(d.backgroundUsd + (isBackground(k) ? usd : 0)),
        byKind: { ...d.byKind, [k]: { usd: micro(row.usd + usd), calls: row.calls + 1 } },
        calls: d.calls + 1,
        estimatedCalls: d.estimatedCalls + (estimated ? 1 : 0),
        warnedAt: d.warnedAt, cappedAt: d.cappedAt, updatedAt: msOf(now),
      };
      tx.set(ref, next);
      return next.totalUsd;
    });
    return { usd, totalUsd };
  } catch (e) {
    console.warn('[golda-cost] the ledger was not written:', e && e.message);
    return { usd, totalUsd: null };
  }
}

/**
 * gate(db, kind, { now }) → { ok, reason, spentUsd, capUsd }
 * May this kind of work start now? Only background kinds are ever refused:
 * when the day's background spend has reached the ceiling. spentUsd is that
 * background spend. A ledger that cannot be read does not stop the work.
 */
async function gate(db, kind, { now = Date.now() } = {}) {
  let capUsd = DEFAULT_CAP_USD, spentUsd = 0;
  try {
    [capUsd, spentUsd] = await Promise.all([readCap(db), readDay(db, now).then((d) => d.backgroundUsd)]);
  } catch (e) {
    console.warn('[golda-cost] the ledger was not read:', e && e.message);
    return { ok: true, reason: 'ledger unreadable', spentUsd: 0, capUsd };
  }
  if (!isBackground(kind)) return { ok: true, reason: 'never capped', spentUsd, capUsd };
  if (spentUsd >= capUsd) return { ok: false, reason: 'cap reached', spentUsd, capUsd };
  return { ok: true, reason: 'under the cap', spentUsd, capUsd };
}

const usdText = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/**
 * capNotice(db, { now }) → string | null
 * One short Hebrew message for the owner the first time the ceiling is
 * reached that day; it stamps cappedAt, so every later call that day answers
 * null. A ceiling of 0 is the admin's own switch, so it is never announced.
 */
async function capNotice(db, { now = Date.now() } = {}) {
  try {
    const capUsd = await readCap(db);
    if (!(capUsd > 0)) return null;
    const date = dayOf(now);
    const ref = db.collection(LEDGER).doc(date);
    const reached = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = dayView(date, snap.exists ? snap.data() : null);
      if (d.cappedAt || d.backgroundUsd < capUsd) return false;
      tx.set(ref, { cappedAt: msOf(now) }, { merge: true });
      return true;
    });
    if (!reached) return null;
    return `הגעתי היום לתקרת העלות של העבודה שאני עושה לבד (${usdText(capUsd)} דולר), אז עד מחר אני עוצרת אותה. שיחות ותדריכים ממשיכים כרגיל. את התקרה אפשר לשנות במסך מערכת, בלשונית מכסות.`;
  } catch (e) {
    console.warn('[golda-cost] the cap notice failed:', e && e.message);
    return null;
  }
}

/** The notice could not be sent: let the next hour try again. */
async function capNoticeUnsent(db, { now = Date.now() } = {}) {
  await db.collection(LEDGER).doc(dayOf(now)).set({ cappedAt: null }, { merge: true });
}

/** The Israel dates of the last `days` days, oldest first, today last. */
function lastDays(now = Date.now(), days = DAYS_SHOWN) {
  const noon = Date.parse(`${dayOf(now)}T12:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(noon - (days - 1 - i) * 86400000).toISOString().slice(0, 10));
}

/**
 * The meter: today in full, the last 14 days as totals, and the ceiling.
 * { capUsd, defaultCapUsd, capMin, capMax, pricesAsOf, today, days, periodUsd }
 */
async function meter(db, { now = Date.now(), days = DAYS_SHOWN } = {}) {
  const dates = lastDays(now, days);
  const [capUsd, rows] = await Promise.all([
    readCap(db),
    Promise.all(dates.map((date) => db.collection(LEDGER).doc(date).get().then((s) => dayView(date, s.exists ? s.data() : null)))),
  ]);
  const today = rows[rows.length - 1];
  return {
    capUsd, defaultCapUsd: DEFAULT_CAP_USD, capMin: CAP_MIN, capMax: CAP_MAX, pricesAsOf: PRICES_AS_OF,
    today: { date: today.date, totalUsd: today.totalUsd, backgroundUsd: today.backgroundUsd, byKind: today.byKind, calls: today.calls,
      estimatedCalls: today.estimatedCalls, capped: today.backgroundUsd >= capUsd, cappedAt: today.cappedAt },
    days: rows.map((d) => ({ date: d.date, totalUsd: d.totalUsd, backgroundUsd: d.backgroundUsd, calls: d.calls })),
    periodUsd: micro(rows.reduce((n, d) => n + d.totalUsd, 0)),
  };
}

/** The admin's ceiling. Throws on anything that is not a number from 0 to 100. */
async function setCap(db, capUsd, { by = '', now = Date.now() } = {}) {
  if (!validCap(capUsd)) throw new Error(`capUsd must be a number from ${CAP_MIN} to ${CAP_MAX}`);
  const v = cents(capUsd);
  await db.collection(SETTINGS[0]).doc(SETTINGS[1]).set({ capUsd: v, updatedAt: msOf(now), updatedBy: String(by || '') }, { merge: true });
  return v;
}

/** For the open status page: three numbers and a yes/no, nothing else. */
async function statusOf(db, now = Date.now()) {
  const [capUsd, day] = await Promise.all([readCap(db), readDay(db, now)]);
  return { todayUsd: cents(day.totalUsd), capUsd: cents(capUsd), capped: day.backgroundUsd >= capUsd };
}

module.exports = {
  priceOf, record, billedModel, estimateUsage, gate, capNotice, capNoticeUnsent, meter, setCap, statusOf, readCap, readDay, validCap, isBackground, tokensOf, addUsage, lastDays,
  PRICES, PRICES_AS_OF, WEB_SEARCH_USD, KINDS, DEFAULT_CAP_USD, CAP_MIN, CAP_MAX, LEDGER,
};
