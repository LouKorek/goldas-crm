// How hard Golda thinks about one message. She used to think at the top level
// about everything, so "מתי נגמר החוזה של דנה?" waited as long as a monthly
// report. Now a plain lookup runs lighter and comes back faster; everything
// else stays at the top.
//
// The choice is made from the message itself, with no extra model call, and
// it only ever goes DOWN when the message positively looks simple. Anything
// that writes, needs judgement, carries a file or a voice note, touches the
// website or YouTube, answers a question Golda asked, or continues a two-step
// action (a delete or a draft waiting for a yes) stays at the top. When in
// doubt: the top.
const TOP = 'xhigh';      // multi-step agent work: planning, cross-checking, verifying
const LOOKUP = 'medium';  // one read-only question with a short factual answer
const CHAT = 'low';       // "תודה", "בוקר טוב": nothing to look up at all

const LOOKUP_MAX_CHARS = 140;

// Hebrew has no word boundaries a regex understands, so these are stems: a hit
// anywhere in the message is enough to stay at the top (missing a lookup only
// costs time; missing a change would cost care). W marks a short form that
// must start a word, so "השנה" (this year) is not read as "שנה" (change).
const W = '(?<![א-ת])';
const WRITES = new RegExp([
  // add, update, change, fix, replace
  'הוסיפ', 'תוסיפ', 'תוסיף', 'להוסיף', 'עדכנ', 'לעדכן', 'תעדכן', 'תשנ', 'לשנות', `${W}שני `, `${W}שנה `, 'תקנ', 'לתקן', 'תחליפ', 'להחליף', 'החליפ',
  // delete, cancel, remove
  'מחק', 'תבטל', 'לבטל', 'בטלי', `${W}בטל `, 'תסיר', 'להסיר', 'הסיר', 'תוריד', 'להוריד', 'הוריד',
  // create, open, close, mark, record, save, attach
  'תצר', 'ליצור', `${W}צרי `, `${W}צור `, 'תפתח', 'לפתוח', 'פתחי', 'תסגר', 'לסגור', 'סגרי', 'תסמנ', 'לסמן', 'סמני', 'תרשמ', 'לרשום', 'רשמי', 'תשמר', 'לשמור', 'שמרי', 'תצרפ', 'לצרף', 'צרפי', 'תכניס', 'להכניס', 'הכניס',
  // schedule, move, send, upload, publish
  'תקבע', 'לקבוע', 'קבעי', 'תזיז', 'להזיז', 'הזיז', 'תעביר', 'להעביר', 'העביר', 'תשלח', 'לשלוח', 'שלחי', 'תעל', 'להעלות', 'העלי', 'פרסמ', 'לפרסם', 'תפרסמ',
  // remember, forget, write, prepare, sync, search, check
  'תזכר', 'תזכור', 'זכרי', 'תשכח', 'שכחי', 'תכתב', 'לכתוב', 'כתבי', 'תכינ', 'להכין', 'הכיני', 'תנסח', 'לנסח', 'נסחי', 'סנכרנ', 'חפשי', 'תחפש', 'לחפש', 'בדקי', 'תבדק', 'לבדוק',
].join('|'));
const WRITES_EN = /\b(add|update|change|edit|fix|replace|delete|remove|cancel|undo|create|open|close|mark|save|attach|schedule|move|send|upload|publish|remember|forget|write|draft|prepare|sync|search|check|set)\b/i;

// Judgement, analysis, long answers, and the heavy tools (files, PDF, website, YouTube, the web).
const HEAVY = new RegExp([
  'דעת', 'ממליצ', 'המלצ', 'כדאי', 'הזדמנו', 'ניתוח', 'נתחי', 'לנתח', 'דוח', 'דו"ח', 'סיכום', 'סכמי', 'תסכמ', 'לסכם', 'מה המצב', 'מה אם', 'תמונ', `${W}למה`, 'מדוע', `${W}איך`, 'כיצד', 'חושב', 'עדיף', 'צריכ', 'צריך', 'אפשר', 'רוצה', 'בבקשה', 'השוו', 'מתאימ', 'מתאים',
  'ספרי', 'תסביר', 'הסביר', 'תדריך', 'בריף', 'אסטרטג', 'תכנית', 'תוכנית', 'מה עכשיו', 'מה לעשות', 'מה דורש',
  'אתר', 'יוטיוב', 'סרטון', 'וידאו', 'קאבר', 'דף שחקן', 'קובץ', 'מסמך', 'כתוב ב', 'חדשות', 'חלון', 'אינטרנט', 'גוגל', 'ברשת', 'טרנספרמרקט',
].join('|'));
const HEAVY_EN = /\b(why|how(?!\s+(?:many|much|old)\b)|should|recommend\w*|opinion|analy\w*|report|summar\w*|compare|explain|brief|website|site|youtube|video|cover|pdf|cv|file|document|news|web|google|transfermarkt)\b/i;

// What a lookup starts with: a question word. ("איך" and "למה" are judgement, above.)
const ASKS = /^(?:גולדה[,،:]?\s*)?(?:עד\s+מתי|מתי|מה|מהו|מהי|מי|למי|של\s+מי|כמה|בן\s+כמה|בת\s+כמה|איפה|היכן|איזה|איזו|אילו|באיזה|באיזו|האם|יש|when|what|who|whose|where|which|how\s+(?:many|much|old)|is|are|does|do)(?=[\s?]|$)/i;

const SMALL_TALK = /^(?:גולדה[,،:]?\s*)?(?:תודה(?:\s+רבה)?|תודה\s+גולדה|מעולה|מצוין|מצויין|יופי|סבבה|אחלה|אין\s+בעד\s+מה|בוקר\s+טוב|צהריים\s+טובים|ערב\s+טוב|לילה\s+טוב|שבת\s+שלום|שבוע\s+טוב|היי|הי|שלום|thanks|thank\s+you|thx|great|hi|hello|good\s+(?:morning|evening|night))(?:\s+גולדה)?[\s!.🙂🙏👍❤️😊]*$/iu;

/** Did Golda's last turn leave something open: a question, or buttons to tap? */
function awaitsAnswer(history = []) {
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant') return false;
  if (Array.isArray(last.buttons) && last.buttons.length) return true;
  return String(last.text || '').slice(-400).includes('?');
}

/** Is a two-step action waiting for the writer's yes? */
function hasPending(session = {}) {
  return (Array.isArray(session.pendingDeletes) && session.pendingDeletes.length > 0) || Boolean(session.pendingDelete);
}

/**
 * chooseEffort({ text, media, session, history }) → { effort, reason }
 *   text     the message as the agent will read it (a voice note starts with 🎤,
 *            a forwarded message with [הודעה מועברת])
 *   media    the attached file, if any
 *   session  the writer's session (pending deletes)
 *   history  this topic's turns, oldest first
 *   topic    the side topic the chat is in; null in the main (CRM) topic
 */
function chooseEffort({ text = '', media = null, session = {}, history = [], topic = null } = {}) {
  const top = (reason) => ({ effort: TOP, reason });
  const t = String(text || '').trim();
  if (media) return top('a file came with the message');
  if (topic) return top('a side topic (research, writing, planning)');
  if (!t) return top('no text');
  if (t.startsWith('🎤')) return top('a voice note');
  if (t.startsWith('[הודעה מועברת]')) return top('a forwarded message');
  if (hasPending(session)) return top('an action is waiting for a yes');
  if (awaitsAnswer(history)) return top('answers a question Golda asked');
  if (/\n/.test(t)) return top('more than one line');
  if (WRITES.test(`${t} `) || WRITES_EN.test(t)) return top('asks for a change or an action');
  if (HEAVY.test(t) || HEAVY_EN.test(t)) return top('needs judgement or a heavy tool');
  if (SMALL_TALK.test(t)) return { effort: CHAT, reason: 'small talk' };
  if (t.length > LOOKUP_MAX_CHARS) return top('a long message');
  if (ASKS.test(t)) return { effort: LOOKUP, reason: 'a short lookup question' };
  return top('not clearly a lookup');
}

// One model for everything Golda does; effort is what changes with the task.
const MODEL = 'claude-opus-5-5';

// How hard each kind of work thinks. A conversation picks its own level per
// message (chooseEffort above); here it is the level it starts from. The
// background jobs used to carry their own constants; they read them from here.
//   briefing     the morning briefing and the weekly recap
//   scouting     the weekly web search for a club requirement
//   radar_scan   a wide, cheap pass over many items: is anything here worth a look
//   radar_card   writing up the one item that was
//   research     a deep look at one question, on request
//   review       reading back over her own work
//   deal         thinking a deal through: fit, terms, next step
//   player       an answer to a represented player (lib/golda-player.js)
//   style        learning the YouTube channel's style (lib/youtube-style.js)
const TASK_EFFORT = {
  briefing: 'high',
  scouting: 'high',
  radar_scan: 'low',
  radar_card: 'medium',
  research: 'high',
  review: 'medium',
  deal: 'high',
  player: 'medium',
  style: 'high',
};

/**
 * effortForTask(task) → { model, effort }
 * 'chat' is the conversation's default (what chooseEffort answers when
 * nothing says the message is simple). An unknown task is a mistake in the
 * code, so it throws instead of quietly running at some level.
 */
function effortForTask(task) {
  if (task === 'chat') return { model: MODEL, effort: chooseEffort().effort };
  if (!Object.prototype.hasOwnProperty.call(TASK_EFFORT, task)) throw new TypeError(`effortForTask: unknown task "${task}"`);
  return { model: MODEL, effort: TASK_EFFORT[task] };
}

module.exports = { chooseEffort, awaitsAnswer, effortForTask, MODEL, TASKS: ['chat', ...Object.keys(TASK_EFFORT)], TOP, LOOKUP, CHAT, LOOKUP_MAX_CHARS };
