// IFA (football.org.il) text logic shared by the server sync and the browser
// sync. Pure string work only: no fetching, no DOM, no cheerio, so the same
// file runs in a Netlify function (require) and in a browser tab (<script>).
//
// Served at /tools/ifa-text.js and required by
// netlify/functions/sync-matches-background.js. Change it in one place.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GA_IFA_TEXT = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

function deriveSeason(dateStr) {
  // Football season runs Aug → Jul. "2025-26" means Aug 2025 → Jul 2026.
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function normalizeIfaTime(s) {
  if (!s) return '';
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(s.trim());
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const mn = m[2];
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${mn}`;
}

function ifaLooksReal(html) {
  return !!html && html.length > 20000 && !/Just a moment|cf-browser-verification|Attention Required/i.test(html);
}

function ifaExpandAbbrev(s) {
  return String(s || '')
    .replace(/נערו['׳"]?\s*\.\s*/g, 'נערות ')
    .replace(/נער['׳"]?\s*\.\s*/g,  'נערים ')
    .replace(/ילדו['׳"]?\s*\.\s*/g, 'ילדות ')
    .replace(/ילד['׳"]?\s*\.\s*/g,  'ילדים ')
    .replace(/טרו['׳"]?\s*\.\s*/g,  'טרום ');
}

const IFA_STOPWORDS = new Set(['ליגה', 'ליגת', 'קבוצה', 'קבוצת', 'גיל', 'של']);

function ifaTokens(s, { dropShort = true } = {}) {
  return ifaExpandAbbrev(s)
    .replace(/["'״׳()]/g, ' ')
    .replace(/[.,\-–—]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t && !IFA_STOPWORDS.has(t) && (!dropShort || t.length > 1 || /^[א-ת]$/.test(t)));
}

const IFA_CITY_ABBREV = [
  [/ראשל["'׳]?[\s-]*צ/g, 'ראשון לציון'],
  [/רמה["'׳]?[\s-]*ש/g,  'רמת השרון'],
  [/כפ["'׳]?[\s-]*ס/g,   'כפר סבא'],
  [/פ["'׳]?[\s-]*ת(?![א-ת])/g, 'פתח תקוה'],
  [/ת["'׳]?[\s-]*א(?![א-ת])/g, 'תל אביב'],
  [/ר["'׳]?[\s-]*ג(?![א-ת])/g, 'רמת גן'],
  [/ב["'׳]?[\s-]*ש(?![א-ת])/g, 'באר שבע'],
  [/ק["'׳]?[\s-]*ש(?![א-ת])/g, 'קרית שמונה'],
  [/נס["'׳]?[\s-]*צ(?![א-ת])/g, 'נס ציונה'],
  [/י["'׳-]\s*ם(?![א-ת])/g,    'ירושלים'],
  [/(?<![א-ת])הפ["'׳]/g,  'הפועל '],
  [/(?<![א-ת])מ["'׳]?\.?\s*כ\.?(?=\s)/g, ' '],   // מ.כ. = מועדון כדורגל
  [/(?<![א-ת])מ["'׳]?\.?\s*ס\.?(?=\s)/g, ' '],   // מ.ס. = מועדון ספורט
];

function ifaNormalizeName(s) {
  let out = ` ${String(s || '')} `;
  for (const [re, full] of IFA_CITY_ABBREV) out = out.replace(re, full);
  return out
    .replace(/וו/g, 'ו')          // תקווה → תקוה
    .replace(/[־–—-]/g, ' ')
    .replace(/["'״׳()]/g, ' ');
}

const IFA_CLUB_NOISE = new Set(['מועדון', 'כדורגל', 'מכ', 'מס', 'אס', 'קפ', 'עמותת', 'ספורט', 'עירוני']);

function ifaClubTokens(s) {
  return ifaTokens(ifaNormalizeName(s)).filter(t => t.length > 1 && !IFA_CLUB_NOISE.has(t));
}

function ifaContainment(wanted, candidate) {
  const w = ifaClubTokens(wanted), c = ifaClubTokens(candidate);
  if (!w.length || !c.length) return 0;
  const cs = new Set(c);
  const shared = w.filter(t => cs.has(t)).length;
  // One word in common is a coincidence when both names have several.
  if (shared < 2 && Math.min(w.length, c.length) > 1) return 0;
  return shared / Math.min(w.length, c.length);
}

function ifaScoreTeam(teamLabel, clubName, cand) {
  const want = new Set(ifaTokens(teamLabel));
  const have = new Set([...ifaTokens(cand.ageGroup), ...ifaTokens(cand.league)]);
  let score = 0;
  for (const t of want) if (have.has(t)) score++;
  const age = ifaTokens(cand.ageGroup);
  if (age.length && age.every(t => want.has(t))) score += 3;
  if (ifaContainment(clubName, cand.teamName) >= 0.5) score += 2;
  return score;
}

// "נתוני השחקן בקבוצה: מכבי ע. בת ים "צו פיוס" (נער.א שפלה)" → club name and
// the parenthesised squad label. null when the caption has no squad.
function ifaParseCaption(caption) {
  const m = /בקבוצה:\s*(.+)$/.exec(String(caption || '').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const full = m[1].trim();
  const lm = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(full);
  return { clubName: (lm ? lm[1] : full).trim(), teamLabel: (lm ? lm[2] : '').trim() };
}

// Clubs from the register worth following for this squad name, best first.
// Deliberately loose: a squad caption often carries a sponsor nickname the
// register doesn't ("מכבי ע. בת ים \"צו פיוס\""), so a weak name match is worth
// following; the age-group gate in ifaPickTeam is what actually decides.
function ifaRankClubs(index, clubName, gender) {
  const wantWomen = gender === 'Women';
  return (index || [])
    .filter(c => (wantWomen ? c.sector === 'נשים' : c.sector !== 'נשים') || !c.sector)
    .map(c => ({ ...c, s: ifaContainment(clubName, c.name) }))
    .filter(c => c.s >= 0.4)
    .sort((a, b) => b.s - a.s);
}

// The club page's squad that matches the player page's label, or null.
function ifaPickTeam(teams, teamLabel, clubName) {
  const best = (teams || [])
    .map(t => ({ ...t, s: ifaScoreTeam(teamLabel, clubName, t) }))
    .sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 3 ? best : null;
}

// One row of the team-games list, from its labelled cells, as a fixture (no
// sourceTeamId; the caller adds it). null for unparseable rows and byes.
// Labels differ by language (תאריך/משחק/אצטדיון/שעה vs Date/Game/Stadium/Time)
// and so does the date order: DD/MM/YYYY in Hebrew, M/D/YYYY on /en/ pages.
function ifaFixtureFromCells(cells, href, isEnglishPage) {
  const cell = (...keys) => { for (const k of keys) if (cells[k]) return cells[k]; return ''; };
  const dateStr  = cell('תאריך', 'Date');
  const matchStr = cell('משחק', 'Game', 'Match');
  const stadium  = cell('אצטדיון', 'Stadium');
  const timeStr  = cell('שעה', 'Time');
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr);
  if (!dm) return null;
  const day   = isEnglishPage ? dm[2] : dm[1];
  const month = isEnglishPage ? dm[1] : dm[2];
  const date = `${dm[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const sep = matchStr.lastIndexOf(' - ');
  if (sep < 1) return null;
  const homeTeam = matchStr.slice(0, sep).trim();
  const awayTeam = matchStr.slice(sep + 3).trim();
  if (!homeTeam || !awayTeam) return null;
  // IFA marks a bye as a match against "חופשית" (Hebrew) or "Bye"/"Free".
  const isPlaceholder = (t) => t === 'חופשית' || /^(bye|free)$/i.test(t);
  if (isPlaceholder(homeTeam) || isPlaceholder(awayTeam)) return null;
  const gm = /game_id=(\d+)/.exec(href || '');
  return {
    source: 'ifa',
    sourceMatchId: gm ? gm[1] : `${date}|${homeTeam}|${awayTeam}`,
    date,
    time: normalizeIfaTime(timeStr),
    homeTeam,
    awayTeam,
    stadiumName: stadium,
    season: deriveSeason(date),
  };
}

return {
  deriveSeason, normalizeIfaTime, ifaLooksReal,
  ifaExpandAbbrev, ifaTokens, ifaNormalizeName, ifaClubTokens, ifaContainment,
  ifaScoreTeam, ifaParseCaption, ifaRankClubs, ifaPickTeam, ifaFixtureFromCells,
};
});
