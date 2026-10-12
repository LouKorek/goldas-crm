// 02 · Matching. For one open club requirement, a 0–100 score for every
// available player (represented or candidate) with a worded explanation.
// Pure: runs identically in the browser (live, next to the requirement),
// on the server at night (saved to match_scores) and inside Golda.
import { isEuropean, EU_COUNTRIES } from '../constants.js';
import { isYouthAge } from '../ageGroups.js';
import { playerName } from '../stages.js';
import { daysAway, toDateStr } from './dates.js';

export interface MatchReason { key: string; ok: boolean | null; he: string; en: string }
export interface MatchScore {
  playerId: string;
  playerName: string;
  stage: string;
  score: number;
  reasons: MatchReason[];
  /** False when a hard rule (gender, not relevant) rules the player out. */
  eligible: boolean;
}

const WEIGHTS = { position: 30, age: 20, gender: 10, youth: 10, league: 10, money: 15, eu: 5, contract: 10 };
const MAX = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).replace(/[,\s]/g, '').match(/\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/k\b/i.test(String(v))) n *= 1000;
  if (/m\b/i.test(String(v))) n *= 1_000_000;
  return n;
};
const tier = (v: unknown): number | null => { const m = /\d/.exec(String(v ?? '')); return m ? Number(m[0]) : /5\+|\+/.test(String(v ?? '')) ? 5 : null; };
const ageOf = (dob: unknown, now: Date): number | null => {
  const s = toDateStr(dob);
  if (!s) return null;
  const d = daysAway(s, now);
  return d === null ? null : Math.floor(-d / 365.25);
};
const str = (v: unknown) => (v == null ? '' : String(v));

export function scoreRequirement(
  requirement: Record<string, unknown>,
  players: Array<Record<string, unknown>>,
  now: Date = new Date(),
): MatchScore[] {
  const r = requirement;
  const out: MatchScore[] = [];
  const reqPos = str(r.requiredPosition);
  const ageMin = r.ageNotSpecified ? null : num(r.ageMin);
  const ageMax = r.ageNotSpecified ? null : num(r.ageMax);
  const budgetSalary = num(r.salary);
  const budgetFee = num(r.transferFee);
  const clubTier = tier(r.leagueTier);
  const clubCountry = str(r.leagueCountry);
  const clubInEurope = !!clubCountry && clubCountry !== 'Israel' && EU_COUNTRIES.includes(clubCountry);
  const wantsWomen = str(r.gender) === 'Women';
  const wantsMen = str(r.gender) === 'Men';

  for (const p of players) {
    if (p.deletedAt) continue;
    const stage = str(p.stage || 'represented');
    if (stage === 'not_relevant') continue;
    const reasons: MatchReason[] = [];
    let pts = 0; let eligible = true;

    // Gender is a hard rule.
    const isWoman = str(p.gender) === 'Women' || p.category === 'women';
    if (wantsWomen && !isWoman) { eligible = false; reasons.push({ key: 'gender', ok: false, he: 'הדרישה לנשים', en: 'Requirement is for women' }); }
    else if (wantsMen && isWoman) { eligible = false; reasons.push({ key: 'gender', ok: false, he: 'הדרישה לגברים', en: 'Requirement is for men' }); }
    else if (wantsWomen || wantsMen) { pts += WEIGHTS.gender; reasons.push({ key: 'gender', ok: true, he: 'מגדר ✓', en: 'Gender ✓' }); }

    // Position: primary or secondary.
    if (reqPos) {
      const prim = str(p.primaryPosition) === reqPos;
      const sec = Array.isArray(p.secondaryPositions) && (p.secondaryPositions as unknown[]).map(String).includes(reqPos);
      if (prim) { pts += WEIGHTS.position; reasons.push({ key: 'position', ok: true, he: `עמדה ${reqPos} ✓`, en: `Position ${reqPos} ✓` }); }
      else if (sec) { pts += Math.round(WEIGHTS.position * 0.6); reasons.push({ key: 'position', ok: true, he: `${reqPos} עמדה משנית`, en: `${reqPos} as secondary position` }); }
      else reasons.push({ key: 'position', ok: false, he: `עמדה ${str(p.primaryPosition) || '?'} ולא ${reqPos}`, en: `Plays ${str(p.primaryPosition) || '?'}, not ${reqPos}` });
    }

    // Age in range (2 years of slack earns part marks).
    const age = ageOf(p.dob, now);
    if (ageMin !== null || ageMax !== null) {
      if (age === null) reasons.push({ key: 'age', ok: null, he: 'גיל לא ידוע', en: 'Age unknown' });
      else {
        const below = ageMin !== null ? ageMin - age : 0;
        const above = ageMax !== null ? age - ageMax : 0;
        const off = Math.max(below, above, 0);
        if (off === 0) { pts += WEIGHTS.age; reasons.push({ key: 'age', ok: true, he: `גיל ${age} ✓`, en: `Age ${age} ✓` }); }
        else if (off <= 2) { pts += Math.round(WEIGHTS.age * 0.4); reasons.push({ key: 'age', ok: null, he: `גיל ${age}, ${off} שנים מחוץ לטווח`, en: `Age ${age}, ${off} years outside range` }); }
        else reasons.push({ key: 'age', ok: false, he: `גיל ${age} מחוץ לטווח`, en: `Age ${age} outside range` });
      }
    } else if (age !== null) { pts += Math.round(WEIGHTS.age * 0.5); }

    // Youth club wants youth-age players; adult club wants adults.
    const youthPlayer = isYouthAge(p.dob, now) || p.category === 'youth';
    if (r.clubIsYouth) {
      if (youthPlayer) { pts += WEIGHTS.youth; reasons.push({ key: 'youth', ok: true, he: 'נוער ✓', en: 'Youth ✓' }); }
      else reasons.push({ key: 'youth', ok: false, he: 'בוגר לקבוצת נוער', en: 'Adult for a youth team' });
    } else if (youthPlayer && age !== null && age < 17) {
      reasons.push({ key: 'youth', ok: false, he: 'צעיר מדי לבוגרים', en: 'Too young for seniors' });
    } else pts += WEIGHTS.youth;

    // League level: playing at the club's level or above counts fully.
    const pTier = tier(p.leagueTier);
    if (clubTier !== null && pTier !== null) {
      if (pTier <= clubTier) { pts += WEIGHTS.league; reasons.push({ key: 'league', ok: true, he: 'רמת ליגה ✓', en: 'League level ✓' }); }
      else if (pTier === clubTier + 1) { pts += Math.round(WEIGHTS.league * 0.5); reasons.push({ key: 'league', ok: null, he: 'ליגה אחת מתחת', en: 'One league below' }); }
      else reasons.push({ key: 'league', ok: false, he: 'ליגה נמוכה בהרבה', en: 'Much lower league' });
    }

    // Money: asking salary / fee against the club's budget.
    const askSalary = num(p.salary); const askFee = num(p.transferFee);
    const budget = budgetSalary ?? budgetFee; const ask = budgetSalary !== null ? askSalary : askFee;
    if (budget !== null && ask !== null) {
      const over = (ask - budget) / budget;
      if (over <= 0) { pts += WEIGHTS.money; reasons.push({ key: 'money', ok: true, he: 'בתקציב ✓', en: 'Within budget ✓' }); }
      else if (over <= 0.2) { pts += Math.round(WEIGHTS.money * 0.4); reasons.push({ key: 'money', ok: null, he: `מבקש ${Math.round(over * 100)}% מעל התקציב`, en: `Asks ${Math.round(over * 100)}% over budget` }); }
      else reasons.push({ key: 'money', ok: false, he: `מבקש ${Math.round(over * 100)}% מעל התקציב`, en: `Asks ${Math.round(over * 100)}% over budget` });
    } else if (budget !== null) reasons.push({ key: 'money', ok: null, he: 'שכר מבוקש לא ידוע', en: 'Asking salary unknown' });

    // EU passport matters only for a club in Europe.
    if (clubInEurope) {
      const nats = Array.isArray(p.nationalities) ? (p.nationalities as unknown[]).map(String) : [];
      if (isEuropean(nats)) { pts += WEIGHTS.eu; reasons.push({ key: 'eu', ok: true, he: 'דרכון אירופי ✓', en: 'EU passport ✓' }); }
      else reasons.push({ key: 'eu', ok: false, he: 'ללא דרכון אירופי', en: 'No EU passport' });
    }

    // A free agent, or a contract ending soon, is easier to move.
    const cs = str(p.contractStatus);
    const endIn = daysAway(p.contractEnd, now);
    if (cs === 'Free' || (!cs && !p.currentClub)) { pts += WEIGHTS.contract; reasons.push({ key: 'contract', ok: true, he: 'שחקן חופשי', en: 'Free agent' }); }
    else if (endIn !== null && endIn <= 180) { pts += Math.round(WEIGHTS.contract * 0.5); reasons.push({ key: 'contract', ok: null, he: `החוזה מסתיים בעוד ${Math.max(endIn, 0)} ימים`, en: `Contract ends in ${Math.max(endIn, 0)} days` }); }

    const score = eligible ? Math.min(100, Math.round((pts / MAX) * 100)) : 0;
    out.push({ playerId: str(p.id), playerName: playerName(p as { name?: unknown }), stage, score, reasons, eligible });
  }
  return out.filter((m) => m.eligible).sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName));
}

/** The top `n` matches with a score of at least `min`. */
export const topMatches = (req: Record<string, unknown>, players: Array<Record<string, unknown>>, { n = 5, min = 35, now = new Date() } = {}): MatchScore[] =>
  scoreRequirement(req, players, now).filter((m) => m.score >= min).slice(0, n);

/** One-line explanation: "עמדה ✓ · גיל 24 ✓ · מבקש 20% מעל התקציב". */
export const explainMatch = (m: MatchScore, lang: 'he' | 'en' = 'he'): string =>
  m.reasons.filter((r) => r.ok !== null || true).map((r) => r[lang]).join(' · ');
