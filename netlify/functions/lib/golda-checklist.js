// The player checklist, for Golda: "what is missing for <player>?" and "who
// has the least complete file?", from the one definition the app shows
// (packages/domain/src/engines/completeness.ts). Read-only, every role.
//
// The calendar item needs the match sync's report (app_meta/syncWarnings) and
// the website card the nightly stamp (siteCard on the player); without them
// those items are "not known yet" and stay out of the score, as in the app.
const { playerCompleteness, calendarBlock, playerName, isScored } = require('@goldas/domain');

const APP = 'https://goldas-crm.netlify.app';
const DEFAULT_N = 5;
const MAX_N = 20;

// What to do about a missing item, in a few Hebrew words Golda can pass on.
const HOW = {
  reprAgreement: 'להעלות את הסכם הייצוג ולמלא תאריך סיום ייצוג',
  passport: 'להעלות צילום דרכון ולמלא תוקף',
  photo: 'להעלות תמונה בטופס השחקן, או לשלוח לי אותה ואצרף',
  video: 'להוסיף קישור לסרטון',
  ifa: 'להדביק את קישור הפרופיל שלו באתר ההתאחדות',
  transfermarkt: 'להדביק את קישור הטרנספרמרקט שלו',
  siteCard: 'אין לו כרטיס ב-gold-as.com; אפשר לבקש ממני להוסיף (צריך תמונה)',
  calendar: 'סנכרון המשחקים לא מוצא לו משחקים',
};

const SYNC_WHY = {
  'no-club': 'אין מועדון ברשומה', 'no-source': 'אין מדינה וליגה ברשומה', 'ifa-url-missing': 'אין קישור להתאחדות',
  'ifa-url-invalid': 'קישור ההתאחדות לא תקין', 'ifa-url-has-no-id': 'בקישור ההתאחדות אין מזהה שחקן',
  'ifa-club-not-found': 'המועדון לא נמצא בהתאחדות', 'ifa-team-not-matched': 'הקבוצה שלו בהתאחדות לא זוהתה (אפשר לנעוץ אותה בטופס)',
  'no-fixtures-or-team-not-found': 'לא נמצאו משחקים לקבוצה שלו',
};

const rowsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

async function loadContext(db) {
  const [players, report] = await Promise.all([
    db.collection('players').get().then(rowsOf),
    db.collection('app_meta').doc('syncWarnings').get().then((s) => (s.exists ? (s.data() || null) : null)).catch(() => null),
  ]);
  return { players: players.filter(isScored), ctx: { now: new Date(), syncReport: report } };
}

/** One player's checklist, in the words Golda answers with. */
function checklistOf(p, ctx) {
  const c = playerCompleteness(p, ctx);
  if (!c) return null;
  const how = (i) => (i.key === 'calendar' ? `${HOW.calendar}: ${SYNC_WHY[calendarBlock(p, ctx)] || 'לבדוק את דוח הסנכרון'}` : HOW[i.key] || 'למלא בטופס השחקן');
  return {
    playerId: p.id, name: playerName(p), score: c.score,
    title: c.onboarding ? 'קליטת שחקן' : 'שלמות התיק',
    missing: c.missing.map((i) => ({ key: i.key, what: i.label.he, how: how(i) })),
    notKnownYet: c.unknown.map((i) => i.label.he),
    done: c.done.length,
    link: `${APP}/players/${p.id}`,
  };
}

const CHECKLIST_TOOL_DEF = {
  name: 'player_checklist',
  description: "The checklist of a represented player's file (representation agreement, passport, photo, video, IFA link, Transfermarkt, website card, games in the calendar, and the record's dates and details) with a 0-100 score. With playerId: what is missing for him and how to fix each, most important first. Without: the players with the least complete file first. Use for \"מה חסר ל…\", \"מה חסר בתיק של…\", \"למי חסר הכי הרבה\", \"איזה תיקים לא מלאים\". Prospects are not scored.",
  input_schema: { type: 'object', properties: {
    playerId: { type: 'string', description: 'One player (find him with search first). Leave out for the ranking.' },
    n: { type: 'integer', description: `How many players in the ranking, default ${DEFAULT_N}, max ${MAX_N}` },
  }, additionalProperties: false },
};

function checklistTools({ db }) {
  return {
    player_checklist: async ({ playerId, n } = {}) => {
      const { players, ctx } = await loadContext(db);
      if (playerId) {
        const p = players.find((x) => x.id === playerId);
        if (!p) throw new Error('not a represented player (only represented players have a checklist)');
        return checklistOf(p, ctx);
      }
      const k = Math.max(1, Math.min(Number(n) || DEFAULT_N, MAX_N));
      const all = players.map((p) => checklistOf(p, ctx)).filter(Boolean)
        .sort((a, b) => a.score - b.score || b.missing.length - a.missing.length || a.name.localeCompare(b.name, 'he'));
      return {
        players: all.slice(0, k).map((x) => ({ playerId: x.playerId, name: x.name, score: x.score, missing: x.missing.map((m) => m.what), link: x.link })),
        complete: all.filter((x) => x.score === 100).length,
        total: all.length,
      };
    },
  };
}

module.exports = { CHECKLIST_TOOL_DEF, checklistTools, checklistOf, HOW };
