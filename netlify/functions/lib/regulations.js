// Regulation pointers: a dated table of football rules that touch the
// agency's work (agents, minors, transfer windows), each with the document it
// comes from, the article, the page it was read on and the day it was read.
// Modelled on lib/transfer-windows.js: the facts are a table, the code only
// decides which rows touch a player or a deal today.
//
// What this is NOT: legal advice. A flag points to a rule and says why it
// touches this deal; it never says "allowed" or "forbidden". Every flag ends
// with the same line telling the owner to check with a lawyer.
//
// status:
//   verified    the statement was read on the regulator's own page (FIFA) on
//               `readOn`. Only these carry a statement of the rule.
//   unverified  the document could not be opened from here (FIFA's PDF library
//               and the Israel FA's site refuse automated readers). Such a row
//               names the topic and where to check it, and states no rule: no
//               number, no limit, no article. It is shown as "not checked".
// To verify a row: read the document, write the statement (he), the article
// and readOn, and set status to 'verified'.
const { israelDate, daysBetween, ageOn, stageOfPlayer, isClosedStage, stageIndex, playerName } = require('@goldas/domain');
const { WINDOWS } = require('./transfer-windows.js');

const READ_ON = '2026-11-25';
const WINDOWS_READ_ON = '2026-11-08';
const DISCLAIMER = 'זו הפניה לכלל ולא קביעה משפטית. כדאי לבדוק מול עורך דין.';
const ADULT_AGE = 18;
const RSTP_NEW_FROM = '2027-01-01';
// A row read longer ago than this says so on its flag.
const STALE_AFTER_DAYS = 180;
const WINDOW_CLOSING_DAYS = 30;
const AVG_DAYS_PER_MONTH = 30.44;
const AREAS = ['agents', 'minors', 'windows'];

const FFAR = 'FIFA Football Agent Regulations (FFAR)';
const RSTP = 'FIFA Regulations on the Status and Transfer of Players (RSTP)';
// FIFA's notice on the suspended rules. The address is the one FIFA's own
// agents news index links to; that host refused the automated reader, so the
// text was read on FIFA's mirror of the same page
// (confederationscup.tickets.fifa.com/transfer-system/agents/news/…).
const SUSPENSION = {
  readIn: 'FIFA, "Information on the preliminary injunction granted by the Landgericht Dortmund in the procedure 8 O 1/23 (Kart)", 8.9.2023',
  url: 'https://www.inside.fifa.com/news/information-on-the-preliminary-injunction-granted-by-the-landgericht',
};
const SUSPENDED_TAIL = 'מושעה בכל העולם עד להודעה חדשה, לפי הודעת פיפ"א. פיפ"א המליצה להתאחדויות החברות להשעות גם את הכללים המקבילים שלהן; מה שקבעה ההתאחדות המקומית לא נבדק כאן.';
// Where an unverified topic is to be checked. Only addresses that were found
// while reading are written here; where the document's own address was not
// found, the regulator's site is given and the document is named.
const FFAR_PDF = { document: FFAR, url: 'https://digitalhub.fifa.com/m/1e7b741fa0fae779/original/FIFA-Football-Agent-Regulations.pdf' };
const RSTP_DOC = { document: `${RSTP}, במסמכי הרגולציה באתר פיפ"א`, url: 'https://inside.fifa.com' };
const IFA_SITE = 'https://www.football.org.il';
const IFA_AGENTS_PDF = 'https://www.football.org.il/files/agent/%D7%AA%D7%A7%D7%A0%D7%95%D7%9F%20%D7%A1%D7%95%D7%9B%D7%A0%D7%99%20%D7%9B%D7%93%D7%95%D7%A8%D7%92%D7%9C.pdf';
const IFA_REGISTRATION_PDF = 'https://www.football.org.il/files/Rules/Registration.pdf';

const RULES = [
  // ── Agents (FFAR) ──────────────────────────────────────────────────────────
  {
    id: 'agent_licence', area: 'agents', status: 'verified', readOn: READ_ON,
    he: 'לפי פיפ"א, מאז 1 באוקטובר 2023 חובה לעבוד רק עם סוכני כדורגל בעלי רישיון.',
    source: { document: FFAR, article: '', readIn: 'FIFA media release, "FIFA Football Agent Regulations to fully enter into force as of 1 October", 29.9.2023', url: 'https://inside.fifa.com/transfer-system/agents/media-releases/fifa-football-agent-regulations-to-fully-enter-into-force-as-of-1-october' },
    when: (c) => (c.openDeal ? 'יש עסקה פתוחה שבה הסוכנות פועלת כסוכן' : null),
  },
  {
    id: 'agent_fee_cap_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `הכלל שמגביל את גובה העמלה של סוכן (תקרת העמלה, FFAR) ${SUSPENDED_TAIL}`,
    source: { document: FFAR, article: 'art. 15 pars 1-4', ...SUSPENSION },
    when: (c) => (c.hasCommission ? 'בעסקה רשומה עמלה' : null),
  },
  {
    id: 'agent_client_pays_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `הכלל שלפיו הלקוח הוא שמשלם לסוכן (FFAR) ${SUSPENDED_TAIL}`,
    source: { document: FFAR, article: 'art. 14 pars 2 and 10', ...SUSPENSION },
    when: (c) => (c.represented && c.clubPays ? 'בעסקה רשום תשלום מהמועדון על שחקן שהסוכנות מייצגת' : null),
  },
  {
    id: 'agent_clearing_house_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `הכלל שלפיו תשלום העמלה עובר דרך מסלקת פיפ"א (FFAR) ${SUSPENDED_TAIL}`,
    source: { document: FFAR, article: 'art. 14 par. 13', ...SUSPENSION },
    when: (c) => (c.hasPayments ? 'בעסקה רשומים תשלומים לסוכנות' : null),
  },
  {
    id: 'agent_dual_representation_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `האיסור על ייצוג כפול (FFAR) ${SUSPENDED_TAIL}`,
    source: { document: FFAR, article: 'art. 12 pars 8-10', ...SUSPENSION },
    when: (c) => (c.represented && c.mandate ? 'השחקן מיוצג על ידי הסוכנות ובעסקה יש מנדט: אם המנדט הוא מהמועדון, הסוכנות פועלת עבור שני הצדדים' : null),
  },
  {
    // Shown with any suspended rule: the suspension is the part most likely to move.
    id: 'agent_rules_cjeu_2026', area: 'agents', status: 'verified', readOn: READ_ON, withSuspended: true,
    he: 'בעקבות פסק הדין של בית הדין של האיחוד האירופי מ-16.7.2026, פיפ"א הודיעה שבית הדין מצא שעיקרי תקנון הסוכנים (חובת רישיון, תקרת עמלה, איסור ייצוג כפול, "הלקוח משלם", תשלום יחסי) ניתנים להצדקה, ושהיא בוחנת את ההשלכות המעשיות. ההודעה לא אומרת שההשעיה הסתיימה, כך שהמצב עשוי להשתנות.',
    source: { document: FFAR, article: '', readIn: 'FIFA news on the judgment of the Court of Justice of the European Union, 16.7.2026', url: 'https://inside.fifa.com/news/welcomes-court-of-justice-european-union-decision-football-agent-regulations' },
    when: () => null,
  },
  {
    // The number is not in the table until someone reads the article: with
    // limitMonths filled and the status set to verified, the code compares it
    // with the agreement on record.
    id: 'agent_representation_length', area: 'agents', status: 'unverified', limitMonths: null,
    topic: 'האורך המרבי של הסכם ייצוג עם שחקן',
    check: FFAR_PDF,
    when: (c, r) => {
      if (c.reprMonths === null) return null;
      if (r.status === 'verified' && Number.isFinite(r.limitMonths) && c.reprMonths <= r.limitMonths) return null;
      return `הסכם הייצוג הרשום הוא ל-${c.reprMonths} חודשים`;
    },
  },
  {
    id: 'agent_minor_representation', area: 'minors', status: 'unverified',
    topic: 'פנייה לקטין וייצוג של קטין על ידי סוכן (מתי מותר לפנות, מי חותם)',
    check: FFAR_PDF,
    when: (c) => (c.minor ? `השחקן בן ${c.age}` : null),
  },
  {
    id: 'ifa_agents', area: 'agents', status: 'unverified',
    topic: 'תקנון סוכני הכדורגל של ההתאחדות לכדורגל בישראל (רישום הסוכן, הסכם ייצוג, עמלות)',
    check: { document: 'ההתאחדות לכדורגל בישראל, תקנון סוכני כדורגל', url: IFA_AGENTS_PDF },
    when: (c) => (c.israel && c.openDeal ? 'העסקה נוגעת למועדון או לשחקן בישראל' : null),
  },
  // ── Minors (RSTP) ──────────────────────────────────────────────────────────
  {
    id: 'minor_international_transfer', area: 'minors', status: 'verified', readOn: READ_ON, rstp: true,
    he: 'תקנון RSTP של פיפ"א אוסר העברה בינלאומית של שחקן מתחת לגיל 18. היא מותרת רק כשמתקיים אחד מששת החריגים שבתקנון ופיפ"א אישרה מראש.',
    source: { document: RSTP, article: 'art. 19', readIn: 'FIFA Legal news on the guide to submitting a minor application, 19.2.2026 (the article number: FIFA media release of 22.2.2019)', url: 'https://inside.fifa.com/legal/news/new-edition-guide-submitting-minor-application' },
    when: (c) => {
      if (!c.minor || !c.openDeal || c.international === false) return null;
      return c.international ? `השחקן בן ${c.age} והמועדון במדינה אחרת (${c.clubCountry})` : `השחקן בן ${c.age}; לא רשום באיזו מדינה המועדון, והכלל נוגע רק למעבר בין מדינות`;
    },
  },
  {
    id: 'rstp_new_2027', area: 'minors', status: 'verified', readOn: READ_ON, withRstp: true,
    he: (c) => (c.today < RSTP_NEW_FROM
      ? 'פיפ"א אישרה תקנון RSTP חדש, ועיקר השינויים נכנסים לתוקף ב-1.1.2027: מה שכתוב כאן נכון למה שנקרא לפני כן ועשוי להשתנות.'
      : 'תקנון RSTP חדש של פיפ"א נכנס לתוקף ב-1.1.2027, ומה שכתוב כאן נקרא לפני כן: צריך לבדוק מחדש מול התקנון החדש.'),
    source: { document: RSTP, article: '', readIn: 'FIFA news on the new regulatory framework for the transfer system, 10.6.2026', url: 'https://inside.fifa.com/transfer-system/news/bureau-council-new-regulatory-framework-global-football-transfer-system-2027' },
    when: () => null,
  },
  {
    id: 'rstp_minor_contract', area: 'minors', status: 'unverified', rstp: true,
    topic: 'אורך החוזה המקצועני של שחקן קטין',
    check: RSTP_DOC,
    when: (c) => (c.minor && c.openDeal ? `השחקן בן ${c.age} ויש עסקה פתוחה` : null),
  },
  {
    id: 'ifa_minors', area: 'minors', status: 'unverified',
    topic: 'תקנון מעמד והעברות של שחקנים קטינים של ההתאחדות לכדורגל בישראל',
    check: { document: 'ההתאחדות לכדורגל בישראל, תקנון מעמד והעברות של שחקנים קטינים', url: IFA_SITE },
    when: (c) => (c.minor && c.israel ? `השחקן בן ${c.age} ומשחק בישראל או עובר למועדון בישראל` : null),
  },
  // ── Transfer windows and timing ────────────────────────────────────────────
  {
    id: 'rstp_pre_contract', area: 'windows', status: 'unverified', rstp: true,
    topic: 'ממתי מותר למועדון אחר לפנות לשחקן שעדיין בחוזה ולחתום איתו',
    check: RSTP_DOC,
    when: (c) => (c.underContract && c.contractEnd && c.openDeal ? `השחקן בחוזה עד ${c.contractEnd} ויש עסקה פתוחה מול מועדון אחר` : null),
  },
  {
    id: 'windows_israel', area: 'windows', status: 'unverified',
    topic: 'מועדי חלון ההעברות (תקופות הרישום) בישראל לעונה הנוכחית',
    check: { document: 'ההתאחדות לכדורגל בישראל, תקנון הרישום והודעות על תקופות הרישום', url: IFA_REGISTRATION_PDF },
    when: (c) => (c.openDeal && c.clubCountry === 'Israel' ? 'העסקה מול מועדון בישראל' : null),
  },
];

// The league windows come from lib/transfer-windows.js, whose source is not
// the league or FIFA: a window flag is always marked as not officially verified.
const WINDOWS_SOURCE = { document: 'thetransferclock.com (אתר שאינו מקור רשמי)', article: '', readIn: '', url: 'https://thetransferclock.com' };
const dmy = (d) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;

const monthsBetween = (from, to) => {
  const days = daysBetween(from, to);
  return Number.isFinite(days) && days > 0 ? Math.round(days / AVG_DAYS_PER_MONTH) : null;
};

/** What the rules look at, taken from the records. `money` false: payments and commission are not read. */
function contextOf({ player = null, deal = null, club = null, requirement = null, today, money = true }) {
  const p = player || {};
  const age = p.dob ? ageOn(p.dob, today) : null;
  const playerCountry = String(p.leagueCountry || '').trim();
  const clubCountry = String((club && club.country) || (requirement && requirement.leagueCountry) || (deal && deal.leagueCountry) || '').trim();
  const payments = money && deal && Array.isArray(deal.payments) ? deal.payments : [];
  const stage = deal ? String(deal.stage || '') : '';
  return {
    today, deal, age, minor: age === null ? null : age < ADULT_AGE,
    represented: !!player && stageOfPlayer(p) === 'represented',
    openDeal: !!deal && !deal.deletedAt && !isClosedStage(stage),
    hasCommission: money && !!deal && (String(deal.commission || '').trim() !== '' || payments.length > 0),
    hasPayments: payments.length > 0,
    clubPays: payments.some((x) => x && x.payer && x.payer.kind === 'club'),
    mandate: !!deal && stage !== 'Not Relevant' && ((Array.isArray(deal.mandateFiles) && deal.mandateFiles.length > 0) || stageIndex(stage) >= stageIndex('Mandate Received')),
    playerCountry, clubCountry,
    international: playerCountry && clubCountry ? playerCountry.toLowerCase() !== clubCountry.toLowerCase() : null,
    israel: [playerCountry, clubCountry].some((x) => x.toLowerCase() === 'israel'),
    reprMonths: p.reprStart && p.reprEnd ? monthsBetween(p.reprStart, p.reprEnd) : null,
    underContract: ['Under Contract', 'Loan'].includes(p.contractStatus), contractEnd: p.contractEnd || '',
  };
}

/** A flag as Golda shows it: the rule, why here, where it is written, when it was read, and the closing line. */
function flagOf(rule, ctx, why) {
  const he = typeof rule.he === 'function' ? rule.he(ctx) : rule.he;
  const s = rule.source;
  const verified = rule.status === 'verified';
  const old = daysBetween(rule.readOn, ctx.today) > STALE_AFTER_DAYS;
  const where = [s.document, s.article, s.readIn && `נקרא ב: ${s.readIn}`].filter(Boolean).join(', ');
  const line = [
    `${he}${why ? ` (${why}.)` : ''}`,
    `מקור: ${where}. ${s.url}`,
    `נקרא ב-${dmy(rule.readOn)}${old ? ', לפני יותר מחצי שנה: כדאי לוודא שלא השתנה' : ''}${verified ? '' : '. לא אומת מול מקור רשמי'}.`,
    DISCLAIMER,
  ].join('\n');
  return { id: rule.id, area: rule.area, status: rule.status, he, why: why || '', source: { document: s.document, article: s.article || '', readIn: s.readIn || '', url: s.url }, readOn: rule.readOn, line };
}

/** The window of the deal's league today, from the league table (never an official source). */
function windowFlag(ctx, windows) {
  if (!ctx.openDeal || !ctx.clubCountry) return null;
  const mine = windows.filter((w) => w.country.toLowerCase() === ctx.clubCountry.toLowerCase());
  if (!mine.length) return null;
  const open = mine.find((w) => w.opens <= ctx.today && ctx.today <= w.closes);
  const next = mine.filter((w) => w.opens > ctx.today).sort((a, b) => a.opens.localeCompare(b.opens))[0];
  const league = `${(open || next || mine[0]).league} (${ctx.clubCountry})`;
  let he;
  if (open) {
    const left = daysBetween(ctx.today, open.closes);
    if (left > WINDOW_CLOSING_DAYS) return null;
    he = `חלון ההעברות ב-${league} נסגר ב-${dmy(open.closes)}${open.closesAt ? ` בשעה ${open.closesAt}` : ''}: נשארו ${left} ימים.`;
  } else if (next) he = `חלון ההעברות ב-${league} סגור היום, ונפתח ב-${dmy(next.opens)}.`;
  else he = `חלון ההעברות ב-${league} סגור היום, והמועד הבא לא רשום אצלי.`;
  return flagOf({ id: 'window_league', area: 'windows', status: 'unverified', he, source: WINDOWS_SOURCE, readOn: WINDOWS_READ_ON }, ctx, 'העסקה מול מועדון בליגה הזאת');
}

/**
 * regulationFlags({ player, deal, today }) → { today, flags, notVerified, disclaimer }
 *   flags        rules that touch this player or deal, each with its source and
 *                closing line; all read on the regulator's own page, except the
 *                league window, which says it is not officially verified.
 *   notVerified  topics that touch it but were not read at the source: the
 *                topic and where to check, never a statement of the rule.
 * Optional: club, requirement (for the club's country), topic (an area, or
 * 'all': every row of it, whatever the records say), money (false = payments
 * are not read), rules and windows (tests).
 */
function regulationFlags({ player = null, deal = null, club = null, requirement = null, today = israelDate(new Date()), topic = '', money = true, rules = RULES, windows = WINDOWS } = {}) {
  const ctx = contextOf({ player, deal, club, requirement, today, money });
  const asked = (r) => topic === 'all' || topic === r.area;
  const ASKED = 'נושא שנשאל';
  const touched = [];   // every row that touches the case, verified or not
  const flags = [];
  const notVerified = [];
  for (const r of rules) {
    if (r.withSuspended || r.withRstp) continue;
    const why = r.when(ctx, r) || (asked(r) ? ASKED : null);
    if (!why) continue;
    touched.push(r);
    if (r.status === 'verified') flags.push(flagOf(r, ctx, why === ASKED ? '' : why));
    else notVerified.push({ id: r.id, area: r.area, topic: r.topic, why, checkIn: r.check, note: 'לא נבדק מול המקור' });
  }
  // The notes that travel with others: the state of the suspension, the new RSTP.
  for (const r of rules) {
    const follows = (r.withSuspended && touched.some((t) => t.suspended)) || (r.withRstp && touched.some((t) => t.rstp));
    if (follows || ((r.withSuspended || r.withRstp) && asked(r))) flags.push(flagOf(r, ctx, ''));
  }
  const w = windowFlag(ctx, windows);
  return { today, flags: [...flags, ...(w ? [w] : [])], notVerified, disclaimer: DISCLAIMER };
}

const REGULATION_TOOL_DEF = {
  name: 'regulation_check',
  description: 'Pointers to football regulations that touch a player or a deal: agents (licence, who pays the agent, acting for both sides, the cap on the fee), minors (an international move under 18) and the transfer window of the deal\'s league. Each flag has the rule, why it touches this case, its source (document, article, link), the day it was read, and a closing line. notVerified lists topics that were NOT read at the source: say they were not checked and where to check; never state them as rules. This is a pointer, never a legal conclusion.',
  input_schema: {
    type: 'object',
    properties: {
      playerId: { type: 'string' }, dealId: { type: 'string' },
      topic: { type: 'string', enum: [...AREAS, 'all'], description: 'For a general question with no player or deal ("מה הכללים על קטינים"): every row of that area.' },
    },
    additionalProperties: false,
  },
};

/** regulationTools({ db, role, can }): reading for every role; payments are read only for whoever may see money. */
function regulationTools({ db, role, can = () => false }) {
  const doc = async (col, id) => { if (!id) return null; const s = await db.collection(col).doc(String(id)).get(); return s.exists && !s.data().deletedAt ? { id: s.id, ...s.data() } : null; };
  return {
    regulation_check: async (input = {}) => {
      const now = new Date();
      let deal = await doc('deals', input.dealId);
      if (input.dealId && !deal) throw new Error('deal not found');
      const player = await doc('players', input.playerId || (deal && deal.playerId));
      if (input.playerId && !player) throw new Error('player not found');
      let openDeals = [];
      if (!deal && player) {
        openDeals = (await db.collection('deals').where('playerId', '==', player.id).get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !d.deletedAt && !isClosedStage(d.stage));
        if (openDeals.length === 1) [deal] = openDeals;
      }
      if (!player && !deal && !input.topic) throw new Error('pass playerId, dealId or a topic');
      const club = deal ? await doc('clubs', deal.clubId) : null;
      const requirement = deal ? await doc('club_requirements', deal.requirementId) : null;
      const out = regulationFlags({ player, deal, club, requirement, today: israelDate(now), topic: input.topic || '', money: can(role, 'money') });
      return {
        today: out.today,
        about: { ...(player ? { player: playerName(player), playerId: player.id } : {}), ...(deal ? { dealId: deal.id, club: deal.clubName || '', stage: deal.stage || '' } : {}) },
        ...(!deal && openDeals.length > 1 ? { openDeals: openDeals.map((d) => ({ dealId: d.id, club: d.clubName || '', stage: d.stage || '' })), note: 'Several open deals: call again with the dealId of the one that is meant.' } : {}),
        flags: out.flags.map((f) => ({ id: f.id, area: f.area, status: f.status, text: f.line, source: f.source, readOn: f.readOn })),
        notVerified: out.notVerified,
        rule: 'Show each flag as its text says, with the source link and its closing line unchanged. A flag with status unverified is said as not officially verified. Topics in notVerified were not read at the source: say "לא בדקתי" and where to check, never state the rule from memory. Never conclude that something is allowed, forbidden or legal.',
        ...(out.flags.length || out.notVerified.length ? {} : { nothing: 'No rule in the table touches this. That is not a clearance: the table covers only agents, minors and windows.' }),
      };
    },
  };
}

/** Her lines about regulations in the system prompt. */
function regulationSection() {
  return '- Regulations ("מה הכללים על קטינים / עמלה / ייצוג כפול", "יש בעיה רגולטורית בעסקה של…", a deal for a player under 18 or with a club abroad): regulation_check with the playerId and/or dealId (or a topic for a general question). Show each flag as returned: the rule, why it touches this case, the source link, the day it was read and its closing line, unchanged. What it lists under notVerified was not read at the source: say you did not check it and where to check, and never state it as a rule, not from memory either. You point to rules and never give a legal conclusion of your own ("מותר", "אסור", "חוקי"): that is a lawyer\'s.';
}

module.exports = { RULES, regulationFlags, contextOf, regulationTools, regulationSection, REGULATION_TOOL_DEF, DISCLAIMER, READ_ON };
