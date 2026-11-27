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
//   verified    the statement was read in the regulator's own document (FIFA,
//               the Israel FA) on `readOn`. Only these carry a statement of the
//               rule, and only what was read: a part of the document that was
//               not read is named as not read.
//   unverified  the document was not read. Such a row names the topic and where
//               to check it, and states no rule: no number, no limit, no
//               article. It is shown as "not checked".
// To verify a row: read the document, write the statement (he), the article
// and readOn, and set status to 'verified'.
// The rows dated READ_ON_PDF were read in the official PDFs through the owner's
// browser (FIFA's PDF library and the Israel FA's site refuse automated
// readers). The Israel FA replaces its files with every new version: its rules
// page lists the current ones, so that page is the link, and each row names
// the version that was read.
const { israelDate, daysBetween, ageOn, stageOfPlayer, isClosedStage, stageIndex, playerName } = require('@goldas/domain');
const { WINDOWS } = require('./transfer-windows.js');

const READ_ON = '2026-11-25';
const READ_ON_PDF = '2026-11-27';
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
const SUSPENSION_NOTICE_ON = '8.9.2023';
// A pointer, never a conclusion: who announced what and when, what was not found by the day it was read, and what may change it.
const SUSPENDED_TAIL = `פיפ"א הודיעה ב-${SUSPENSION_NOTICE_ON} על השעיית הכלל הזה. נכון ל-${Number(READ_ON.slice(8, 10))}.${Number(READ_ON.slice(5, 7))}.${READ_ON.slice(0, 4)}, היום שבו נקרא, לא מצאתי הודעה רשמית שההשעיה הסתיימה, ואחרי פסק הדין של בית הדין של האיחוד האירופי מיולי 2026 זה עשוי להשתנות. מה שקבעה ההתאחדות המקומית לא נבדק כאן.`;
// Only addresses that were found while reading are written here; where a
// document's own address was not found, the regulator's site is given and the
// document is named.
const IFA_SITE = 'https://www.football.org.il';
// The documents read on READ_ON_PDF.
const FFAR_PDF_URL = 'https://digitalhub.fifa.com/m/1e7b741fa0fae779/original/FIFA-Football-Agent-Regulations.pdf';
const FFAR_READ_IN = 'FIFA Football Agent Regulations, the PDF in FIFA\'s document library (file title "FIFA Football Agent Regulations DEC 2024 EN v2")';
const ffarSource = (article) => ({ document: FFAR, article, readIn: FFAR_READ_IN, url: FFAR_PDF_URL });
// Two editions of the RSTP were read: the one of July 2025 and the one of
// January 2027 (in force from RSTP_NEW_FROM). The link is to the edition of the day.
const RSTP_2025_URL = 'https://digitalhub.fifa.com/m/4139b312ba9cfb4f/original/Regulations-on-the-Status-and-Transfer-of-Players-July-2025-edition.pdf';
const RSTP_2027_URL = 'https://digitalhub.fifa.com/asset/e495d04b-ef95-4d07-ace2-ea4d7781d7de/Regulations-on-the-Status-and-Transfer-of-Players_January-2027.pdf';
const rstpSource = (article) => (c) => ({
  document: RSTP, article,
  readIn: 'RSTP, July 2025 edition and January 2027 edition, the PDFs in FIFA\'s document library',
  url: c.today < RSTP_NEW_FROM ? RSTP_2025_URL : RSTP_2027_URL,
});
const IFA = 'ההתאחדות לכדורגל בישראל';
const IFA_RULES_PAGE = 'https://www.football.org.il/association/aboutassociation/rules/';
const ifaSource = (name, version, article) => ({ document: `${IFA}, ${name}, גרסת ${version}`, article, readIn: `הקובץ "${name} - ${version}" בעמוד התקנונים באתר ההתאחדות`, url: IFA_RULES_PAGE });
// A circular with amendments to the RSTP that was seen listed and not read.
const RSTP_CIRCULAR_NOT_READ = 'חוזר של פיפ"א מספטמבר 2026 עם תיקונים ל-RSTP לא נקרא, אז לא בדקתי אם הוא נוגע לסעיף הזה.';
/** A day `months` calendar months after `day` (YYYY-MM-DD). */
const addMonths = (day, months) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
// The Israel FA's agents regulations, by whether the player is a minor: the part on minors is spelled out only where it touches.
const IFA_AGENTS_MINORS = 'לפי סעיפים 21 עד 23, פנייה של סוכן לקטין או לאפוטרופוס שלו וחתימה על הסכם ייצוג נעשות רק בששת החודשים שלפני הגיל שבו, לפי הדין בישראל, קטין יכול לחתום על חוזה עבודה; הפנייה טעונה הסכמה בכתב מראש של האפוטרופוס; הסוכן צריך להשלים קודם את קורס פיפ"א בנושא קטינים; וההסכם אכיף רק אם חתמו עליו הקטין והאפוטרופוסים שלו. לפי סעיף 24, הפרה גוררת קנס, השעיה של הרישום כסוכן בהתאחדות עד שנתיים ודיווח לפיפ"א. לפי סעיף 28, סוכן לא מקבל עמלה על ייצוג של שחקן קטין או על עסקה שקשורה בו, אלא אם הקטין חתם על חוזה העבודה הראשון שלו או על חוזה מאוחר יותר.';
const ifaAgentsHe = (c) => [
  'תקנון סוכני הכדורגל של ההתאחדות לכדורגל בישראל (גרסת יולי 2026) חל, לפי סעיפים 3 ו-4 שלו, על הסכמי ייצוג ועל עסקאות עם "ממד לאומי", ובהם העברה בין שני מועדונים בהתאחדות, או לקוח שרשום בהתאחדות או גר בישראל.',
  'סעיף 5 עוסק בתנאים למתן שירותי סוכן בישראל (רישיון סוכן בתוקף מפיפ"א, ולסוכן ישראלי גם רישום בהתאחדות), וסעיף 7 ברישום בפנקס הסוכנים, שמתחדש בכל עונה. לפי סעיף 12, הסכם ייצוג בין יחיד לסוכן הוא לתקופה שלא עולה על שנתיים, מאריכים אותו רק בהסכם חדש, וסעיף של חידוש אוטומטי בטל. סעיף 15 מפרט מה ההסכם כולל כדי להיות תקף, ולפי סעיף 31 סכסוכים עם ממד לאומי נדונים במוסד לבוררות ולגישור של ההתאחדות.',
  c && c.minor ? IFA_AGENTS_MINORS : 'סעיפים 21 עד 24 עוסקים בייצוג של קטינים, וסעיף 28 בעמלה על ייצוג של קטין.',
  'סעיפים 29 ו-30 לא נקראו, וכדאי לקרוא את התקנון המלא מול העסקה הזאת.',
].join(' ');

// The deal's expected registration or start date, when one is on record: the age that decides is the age on that day.
const DEAL_DATE_FIELDS = ['registrationDate', 'expectedRegistration', 'expectedStart', 'startDate', 'contractStart'];
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const dmyOf = (d) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;
/** Why a minors' row touches this case: the age, and on which day it was taken. */
function ageWhy(c) {
  if (c.ageOnDate) return `השחקן יהיה בן ${c.age} ב-${dmyOf(c.ageOnDate)}, מועד הרישום הצפוי בעסקה`;
  if (c.openDeal) return `השחקן בן ${c.age} היום; הגיל שקובע הוא הגיל במועד הרישום, שלא רשום בעסקה`;
  return `השחקן בן ${c.age}`;
}
const MINOR_UNKNOWN = { id: 'minor_age_unknown', area: 'minors', he: 'תאריך הלידה של השחקן לא רשום, אז לא בדקתי אם הוא מתחת לגיל 18 ואם הכללים על קטינים נוגעים לו.' };

const RULES = [
  // ── Agents (FFAR) ──────────────────────────────────────────────────────────
  {
    id: 'agent_licence', area: 'agents', status: 'verified', readOn: READ_ON,
    he: 'תקנון סוכני הכדורגל של פיפ"א (FFAR) עוסק בדרישה לרישיון סוכן; לפי הודעת פיפ"א הוא נכנס לתוקף מלא ב-1.10.2023. כדאי לבדוק בתקנון מה הוא קובע לעסקה הזאת.',
    source: { document: FFAR, article: '', readIn: 'FIFA media release, "FIFA Football Agent Regulations to fully enter into force as of 1 October", 29.9.2023', url: 'https://inside.fifa.com/transfer-system/agents/media-releases/fifa-football-agent-regulations-to-fully-enter-into-force-as-of-1-october' },
    when: (c) => (c.openDeal ? 'יש עסקה פתוחה שבה הסוכנות פועלת כסוכן' : null),
  },
  {
    id: 'agent_fee_cap_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `הכלל ב-FFAR שעוסק בתקרת העמלה של סוכן: ${SUSPENDED_TAIL} ההפניה הזאת היא לא אישור שהעמלה הרשומה בעסקה תקינה.`,
    source: { document: FFAR, article: 'art. 15 pars 1-4', ...SUSPENSION },
    when: (c) => (c.hasCommission ? 'בעסקה רשומה עמלה' : null),
  },
  {
    id: 'agent_client_pays_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `הכלל ב-FFAR שעוסק בשאלה מי משלם לסוכן: ${SUSPENDED_TAIL}`,
    source: { document: FFAR, article: 'art. 14 pars 2 and 10', ...SUSPENSION },
    when: (c) => (c.represented && c.clubPays ? 'בעסקה רשום תשלום מהמועדון על שחקן שהסוכנות מייצגת' : null),
  },
  {
    id: 'agent_clearing_house_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `הכלל ב-FFAR שעוסק בתשלום העמלה דרך מסלקת פיפ"א: ${SUSPENDED_TAIL}`,
    source: { document: FFAR, article: 'art. 14 par. 13', ...SUSPENSION },
    when: (c) => (c.hasPayments ? 'בעסקה רשומים תשלומים לסוכנות' : null),
  },
  {
    id: 'agent_dual_representation_suspended', area: 'agents', status: 'verified', readOn: READ_ON, suspended: true,
    he: `הכלל ב-FFAR שעוסק בייצוג כפול (סוכן שפועל עבור שני הצדדים): ${SUSPENDED_TAIL}`,
    source: { document: FFAR, article: 'art. 12 pars 8-10', ...SUSPENSION },
    when: (c) => (c.represented && c.mandate ? 'השחקן מיוצג על ידי הסוכנות ובעסקה יש מנדט: אם המנדט הוא מהמועדון, הסוכנות פועלת עבור שני הצדדים' : null),
  },
  {
    // Shown with any suspended rule: the suspension is the part most likely to move.
    id: 'agent_rules_cjeu_2026', area: 'agents', status: 'verified', readOn: READ_ON, withSuspended: true,
    he: 'פיפ"א פרסמה הודעה על פסק הדין של בית הדין של האיחוד האירופי מ-16.7.2026 בעניין תקנון הסוכנים, ולפיה היא בוחנת את ההשלכות המעשיות. בהודעה לא מצאתי שההשעיה של הכללים שלמעלה הסתיימה; המצב עשוי להשתנות, וכדאי לבדוק את ההודעה ואת מה שפורסם אחריה.',
    source: { document: FFAR, article: '', readIn: 'FIFA news on the judgment of the Court of Justice of the European Union, 16.7.2026', url: 'https://inside.fifa.com/news/welcomes-court-of-justice-european-union-decision-football-agent-regulations' },
    when: () => null,
  },
  {
    // limitMonths is the article's own number: the code compares it with the
    // agreement on record by calendar dates (never by rounded months), and an
    // agreement that ends within it is not flagged.
    id: 'agent_representation_length', area: 'agents', status: 'verified', readOn: READ_ON_PDF, limitMonths: 24,
    topic: 'האורך של הסכם הייצוג עם השחקן',
    he: 'לפי סעיף 12(3) בתקנון סוכני הכדורגל של פיפ"א (FFAR), הסכם ייצוג בין סוכן ליחיד (Individual בלשון התקנון, כאן השחקן) לא יעלה על שנתיים; מאריכים אותו רק בהסכם ייצוג חדש, והסעיף קובע שסעיף של חידוש אוטומטי בטל.',
    source: ffarSource('art. 12 par. 3'),
    when: (c, r) => {
      if (c.reprMonths === null) return null;
      if (r.status === 'verified' && Number.isFinite(r.limitMonths) && c.reprEnd <= addMonths(c.reprStart, r.limitMonths)) return null;
      return `הסכם הייצוג הרשום הוא מ-${dmyOf(c.reprStart)} עד ${dmyOf(c.reprEnd)}, כ-${c.reprMonths} חודשים`;
    },
  },
  {
    id: 'agent_minor_representation', area: 'minors', status: 'verified', readOn: READ_ON_PDF,
    topic: 'פנייה של סוכן לקטין וייצוג של קטין',
    he: 'סעיף 13 בתקנון סוכני הכדורגל של פיפ"א (FFAR) עוסק בייצוג של קטינים. לפי הסעיף, פנייה לקטין או לאפוטרופוס שלו וחתימה על הסכם ייצוג נעשות רק בששת החודשים שלפני הגיל שבו הקטין יכול לחתום על חוזה מקצועני ראשון לפי דין המדינה שבה יועסק, ורק אחרי הסכמה בכתב מראש של האפוטרופוס; הסוכן צריך להשלים קודם את קורס ההשתלמות של פיפ"א בנושא קטינים; ההסכם אכיף רק אם חתמו עליו הקטין והאפוטרופוס שלו; ולהפרה של הכלל על הפנייה הסעיף קובע לפחות קנס והשעיית רישיון של עד שנתיים.',
    source: ffarSource('art. 13 pars 1-4'),
    when: (c) => (c.minor ? ageWhy(c) : null),
  },
  {
    id: 'ifa_agents', area: 'agents', status: 'verified', readOn: READ_ON_PDF,
    topic: 'תקנון סוכני הכדורגל של ההתאחדות לכדורגל בישראל',
    he: ifaAgentsHe,
    source: ifaSource('תקנון סוכני כדורגל', 'יולי 2026', 'סעיפים 3-5, 7, 12, 15, 21-24, 28, 31'),
    when: (c) => (c.israel && c.openDeal ? 'העסקה נוגעת למועדון או לשחקן בישראל' : null),
  },
  // ── Minors (RSTP) ──────────────────────────────────────────────────────────
  {
    id: 'minor_international_transfer', area: 'minors', status: 'verified', readOn: READ_ON, rstp: true,
    he: 'סעיף 19 בתקנון RSTP של פיפ"א עוסק בהעברות בינלאומיות של שחקנים מתחת לגיל 18 ומגביל אותן. החריגים מפורטים בסעיף עצמו, וכדאי לבדוק בו את העסקה הזאת.',
    source: { document: RSTP, article: 'art. 19', readIn: 'FIFA Legal news on the guide to submitting a minor application, 19.2.2026 (the article number: FIFA media release of 22.2.2019)', url: 'https://inside.fifa.com/legal/news/new-edition-guide-submitting-minor-application' },
    when: (c) => {
      if (!c.minor || !c.openDeal || c.international === false) return null;
      return c.international ? `${ageWhy(c)}, והמועדון במדינה אחרת (${c.clubCountry})` : `${ageWhy(c)}; לא רשום באיזו מדינה המועדון, והכלל נוגע רק למעבר בין מדינות`;
    },
  },
  {
    // Travels with a row marked rstp: one that was read before the new edition was (art. 19). It names that row, since rows read in both editions can stand next to it.
    id: 'rstp_new_2027', area: 'minors', status: 'verified', readOn: READ_ON, withRstp: true,
    he: (c) => (c.today < RSTP_NEW_FROM
      ? 'פיפ"א אישרה תקנון RSTP חדש, ועיקר השינויים נכנסים לתוקף ב-1.1.2027: מה שכתוב כאן על סעיף 19 (העברה בינלאומית של קטינים) נכון למה שנקרא לפני כן ועשוי להשתנות.'
      : 'תקנון RSTP חדש של פיפ"א נכנס לתוקף ב-1.1.2027, ומה שכתוב כאן על סעיף 19 (העברה בינלאומית של קטינים) נקרא לפני כן: צריך לבדוק מחדש את הסעיף הזה מול התקנון החדש.'),
    source: { document: RSTP, article: '', readIn: 'FIFA news on the new regulatory framework for the transfer system, 10.6.2026', url: 'https://inside.fifa.com/transfer-system/news/bureau-council-new-regulatory-framework-global-football-transfer-system-2027' },
    when: () => null,
  },
  {
    // Read in both editions, so it does not bring the note about the new RSTP: the row says itself what each edition has.
    id: 'rstp_minor_contract', area: 'minors', status: 'verified', readOn: READ_ON_PDF,
    topic: 'אורך החוזה המקצועני של שחקן קטין',
    he: (c) => (c.today < RSTP_NEW_FROM
      ? `לפי סעיף 18(2) בתקנון RSTP של פיפ"א (מהדורת יולי 2025), שחקן מתחת לגיל 18 לא יחתום על חוזה מקצועני לתקופה של יותר משלוש שנים, וסעיף בחוזה שמתייחס לתקופה ארוכה יותר לא יוכר. במהדורת ינואר 2027, שבתוקף מ-1.1.2027, נוסף לסעיף חריג של עד חמש שנים, בתנאים שמפורטים בו. ${RSTP_CIRCULAR_NOT_READ}`
      : `לפי סעיף 18(2) בתקנון RSTP של פיפ"א (מהדורת ינואר 2027), שחקן מתחת לגיל 18 לא יחתום על חוזה מקצועני לתקופה של יותר משלוש שנים, וסעיף בחוזה שמתייחס לתקופה ארוכה יותר לא יוכר. לסעיף יש חריג: כשהדין המקומי או הסכם קיבוצי לא מונעים זאת, שחקן שרשום במועדון 20 חודשים או שתי תקופות תחרות רצופות (הקצר מביניהם) לפני החתימה יכול לחתום באותו מועדון על חוזה של עד חמש שנים, בתנאים נוספים שמפורטים בסעיף. ${RSTP_CIRCULAR_NOT_READ}`),
    source: rstpSource('art. 18 par. 2'),
    when: (c) => (c.minor && c.openDeal ? `${ageWhy(c)}, ויש עסקה פתוחה` : null),
  },
  {
    id: 'ifa_minors', area: 'minors', status: 'verified', readOn: READ_ON_PDF,
    topic: 'תקנון מעמד והעברות של שחקנים קטינים של ההתאחדות לכדורגל בישראל',
    he: 'תקנון מעמד והעברות של שחקנים קטינים של ההתאחדות לכדורגל בישראל (גרסת אוגוסט 2026) מסדיר, לפי סעיף 1 שלו, את תנאי ההעברה של שחקנים מתחת לגיל 17 ואת הפיצוי והתגמול למועדונים על אימון ופיתוח. לפי סעיף 5, קטין נרשם רק אם הוא והאפוטרופוסים שלו חתמו על טופס ההצטרפות בפורטל המועדונים. לפי סעיף 6, קטין נרשם בעונה בלא יותר משלושה מועדונים ומשחק בשניים בלבד. לפי סעיף 9, הסכם בין מועדון לשחקן מתחת לגיל 18 לא יעלה על שלוש שנים, ותקופה ארוכה יותר בטלה בחלק העודף. סעיפים 10 עד 12 מפרטים באילו מקרים ובאילו מועדים קטין רשום עובר למועדון אחר, ובהם הודעה בכתב של הקטין להתאחדות ולמועדון שלו ותקופת המתנה של 14 יום. ההמשך של סעיף 12 והסעיפים שאחריו לא נקראו, וכדאי לקרוא את התקנון המלא.',
    source: ifaSource('תקנון מעמד והעברות של שחקנים קטינים', 'אוגוסט 2026', 'סעיפים 1, 5, 6, 9, 10-12'),
    when: (c) => (c.minor && c.israel ? `${ageWhy(c)}, ומשחק בישראל או עובר למועדון בישראל` : null),
  },
  // ── Transfer windows and timing ────────────────────────────────────────────
  {
    id: 'rstp_pre_contract', area: 'windows', status: 'verified', readOn: READ_ON_PDF,
    topic: 'פנייה של מועדון אחר לשחקן שעדיין בחוזה',
    he: `לפי סעיף 18(3) בתקנון RSTP של פיפ"א, מועדון שמתכוון לחתום על חוזה עם שחקן מקצועני צריך להודיע על כך בכתב למועדון הנוכחי של השחקן לפני שהוא נכנס איתו למשא ומתן, ושחקן מקצועני חופשי לחתום במועדון אחר רק אם החוזה שלו במועדון הנוכחי הסתיים או עומד להסתיים בתוך שישה חודשים. הנוסח זהה במהדורת יולי 2025 ובמהדורת ינואר 2027. ${RSTP_CIRCULAR_NOT_READ}`,
    source: rstpSource('art. 18 par. 3'),
    when: (c) => (c.underContract && c.contractEnd && c.openDeal ? `השחקן בחוזה עד ${c.contractEnd} ויש עסקה פתוחה מול מועדון אחר` : null),
  },
  {
    id: 'ifa_registration_periods', area: 'windows', status: 'verified', readOn: READ_ON_PDF,
    topic: 'תקופות הרישום בישראל לפי תקנון הרישום',
    he: `לפי סעיף 2 בנספח א' לתקנון הרישום של ההתאחדות לכדורגל בישראל (גרסת נובמבר 2026), פעולת רישום במועדון מקצועני נעשית רק בשתי תקופות רישום, שקובעת ועדת ליגה וגביע בהתאם לכללי פיפ"א, ושחקן מקצועני שהחוזה שלו הסתיים לפני תקופת הרישום הראשונה או במהלכה יכול להירשם גם בין שתי התקופות. סעיף 3 עוסק במועד ההגשה של פעולת רישום ובמסמכים בפורטל המועדונים. המועדים של העונה הנוכחית לא כתובים בתקנון, ולא נקראו.`,
    source: ifaSource('תקנון הרישום', 'נובמבר 2026', `נספח א', סעיפים 2-3`),
    when: (c) => (c.openDeal && c.clubCountry === 'Israel' ? 'העסקה מול מועדון בישראל' : null),
  },
  {
    // The regulations leave the dates to the League and Cup Committee: they are set every season and were not found.
    id: 'windows_israel', area: 'windows', status: 'unverified',
    topic: 'מועדי חלון ההעברות (תקופות הרישום) בישראל לעונה הנוכחית',
    check: { document: `${IFA}, החלטות ועדת ליגה וגביע על תקופות הרישום של העונה`, url: IFA_SITE },
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
  const ageOnDate = (deal && DEAL_DATE_FIELDS.map((k) => deal[k]).find(isDay)) || null;
  const age = p.dob ? ageOn(p.dob, ageOnDate || today) : null;
  const playerCountry = String(p.leagueCountry || '').trim();
  const clubCountry = String((club && club.country) || (requirement && requirement.leagueCountry) || (deal && deal.leagueCountry) || '').trim();
  const payments = money && deal && Array.isArray(deal.payments) ? deal.payments : [];
  const stage = deal ? String(deal.stage || '') : '';
  return {
    today, deal, age, ageOnDate, minor: age === null ? null : age < ADULT_AGE,
    represented: !!player && stageOfPlayer(p) === 'represented',
    openDeal: !!deal && !deal.deletedAt && !isClosedStage(stage),
    hasCommission: money && !!deal && (String(deal.commission || '').trim() !== '' || payments.length > 0),
    hasPayments: payments.length > 0,
    clubPays: payments.some((x) => x && x.payer && x.payer.kind === 'club'),
    mandate: !!deal && stage !== 'Not Relevant' && ((Array.isArray(deal.mandateFiles) && deal.mandateFiles.length > 0) || stageIndex(stage) >= stageIndex('Mandate Received')),
    playerCountry, clubCountry,
    international: playerCountry && clubCountry ? playerCountry.toLowerCase() !== clubCountry.toLowerCase() : null,
    israel: [playerCountry, clubCountry].some((x) => x.toLowerCase() === 'israel'),
    reprMonths: isDay(p.reprStart) && isDay(p.reprEnd) ? monthsBetween(p.reprStart, p.reprEnd) : null,
    reprStart: p.reprStart || '', reprEnd: p.reprEnd || '',
    underContract: ['Under Contract', 'Loan'].includes(p.contractStatus), contractEnd: p.contractEnd || '',
  };
}

/** A flag as Golda shows it: the rule, why here, where it is written, when it was read, and the closing line. */
function flagOf(rule, ctx, why) {
  const he = typeof rule.he === 'function' ? rule.he(ctx) : rule.he;
  const s = typeof rule.source === 'function' ? rule.source(ctx) : rule.source;
  const verified = rule.status === 'verified';
  const old = daysBetween(rule.readOn, ctx.today) > STALE_AFTER_DAYS;
  const where = [s.document, s.article, s.readIn && `נקרא ב: ${s.readIn}`].filter(Boolean).join(', ');
  const line = [
    `${he}${why ? ` (${why}.)` : ''}`,
    `מקור: ${where}. ${s.url}`,
    `נקרא ב-${dmy(rule.readOn)}${old ? ', לפני יותר מחצי שנה: כדאי לוודא שלא השתנה' : ''}${verified ? '' : '. לא אומת מול מקור רשמי'}.`,
    DISCLAIMER,
  ].join('\n');
  return { id: rule.id, area: rule.area, status: rule.status, ...(rule.topic ? { topic: rule.topic } : {}), he, why: why || '', source: { document: s.document, article: s.article || '', readIn: s.readIn || '', url: s.url }, readOn: rule.readOn, line };
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
  he = `${he} המועדים האלה לא ממקור רשמי: הם מאתר שאינו של הליגה או של פיפ"א.`;
  return flagOf({ id: 'window_league', area: 'windows', status: 'unverified', he, source: WINDOWS_SOURCE, readOn: WINDOWS_READ_ON }, ctx, 'העסקה מול מועדון בליגה הזאת');
}

/**
 * regulationFlags({ player, deal, today }) → { today, flags, notVerified, missing, disclaimer }
 *   flags        rules that touch this player or deal, each with its source and
 *                closing line; all read on the regulator's own page, except the
 *                league window, which says it is not officially verified.
 *   notVerified  topics that touch it but were not read at the source: the
 *                topic and where to check, never a statement of the rule.
 *   missing      what could not be checked for lack of a fact (no date of birth: minority).
 * The age for the minors' rows is the age on the deal's expected registration or
 * start date when the deal has one, otherwise today, and the flag says which.
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
  // A player with no date of birth: minority could not be checked, and that is said, not left silent.
  const missing = (player || deal) && ctx.age === null ? [MINOR_UNKNOWN] : [];
  return { today, flags: [...flags, ...(w ? [w] : [])], notVerified, missing, disclaimer: DISCLAIMER };
}

const REGULATION_TOOL_DEF = {
  name: 'regulation_check',
  description: 'Pointers to football regulations that touch a player or a deal: agents (licence, the length of a representation agreement, who pays the agent, acting for both sides, the cap on the fee, the Israel FA\'s agents regulations), minors (an international move under 18, an agent approaching and representing a minor, the length of a minor\'s contract, the Israel FA\'s minors regulations) and timing (approaching a player who is under contract, registration periods in Israel, the transfer window of the deal\'s league). Each flag has the rule, why it touches this case, its source (document, article, link), the day it was read, and a closing line. notVerified lists topics that were NOT read at the source: say they were not checked and where to check; never state them as rules. This is a pointer, never a legal conclusion.',
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
        missing: out.missing.map((m) => m.he),
        rule: 'Show each flag as its text says, with the source link and its closing line unchanged. A flag with status unverified is said as not officially verified. Topics in notVerified were not read at the source: say "לא בדקתי" and where to check, never state the rule from memory. What missing lists could not be checked: say so. Never conclude that something is allowed, forbidden or legal.',
        ...(out.flags.length || out.notVerified.length ? {} : { nothing: 'No rule in the table touches this. That is not a clearance: the table covers only agents, minors and windows.' }),
      };
    },
  };
}

/** Her lines about regulations in the system prompt. */
function regulationSection() {
  return '- Regulations ("מה הכללים על קטינים / עמלה / ייצוג כפול / אורך הסכם ייצוג", "יש בעיה רגולטורית בעסקה של…", a deal for a player under 18, with a club abroad or for a player who is under contract elsewhere): regulation_check with the playerId and/or dealId (or a topic for a general question). Show each flag as returned: the rule, why it touches this case, the source link, the day it was read and its closing line, unchanged. What it lists under notVerified was not read at the source: say you did not check it and where to check, and never state it as a rule, not from memory either. You point to rules and never give a legal conclusion of your own ("מותר", "אסור", "חוקי"): that is a lawyer\'s.';
}

module.exports = { RULES, regulationFlags, contextOf, regulationTools, regulationSection, REGULATION_TOOL_DEF, DISCLAIMER, READ_ON, READ_ON_PDF };
