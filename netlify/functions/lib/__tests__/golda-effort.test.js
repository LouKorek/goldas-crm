// How hard Golda thinks about a message: a plain lookup runs lighter, and
// everything that writes, judges, carries a file or continues a two-step
// action stays at the top.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseEffort, TOP, LOOKUP, CHAT } = require('../golda-effort.js');
const { runAgent, EFFORT } = require('../wa-agent.js');

const of = (text, extra = {}) => chooseEffort({ text, ...extra }).effort;

test('the top level is still xhigh', () => {
  assert.equal(TOP, 'xhigh');
  assert.equal(EFFORT, TOP);
  assert.equal(LOOKUP, 'medium');
  assert.equal(CHAT, 'low');
});

test('a short read-only question runs lighter', () => {
  for (const q of [
    'מתי נגמר החוזה של דנה?',
    'מה יש היום?',
    'מתי המשחק הבא של אסף',
    'כמה שחקנים מיוצגים יש לנו?',
    'מי השחקנים שהחוזה שלהם נגמר השנה?',
    'מה הטלפון של המנהל המקצועי של הפועל חדרה?',
    'גולדה, עד מתי הדרכון של נועה בתוקף?',
    'יש לדנה הסכם ייצוג בתוקף?',
    'מתי החוזה של שלמה נגמר?',
    "when is Dana's contract up?",
    'how many players do we have',
  ]) assert.equal(of(q), LOOKUP, q);
});

test('small talk runs at the lowest level', () => {
  for (const q of ['תודה', 'תודה רבה!', 'בוקר טוב גולדה', 'מעולה 👍', 'thanks']) assert.equal(of(q), CHAT, q);
});

test('anything that writes stays at the top', () => {
  for (const q of [
    'תעדכני את החוזה של דנה עד 30/6/2027',
    'מי השחקן של מכבי? תוסיפי לו משימה',
    'מה הטלפון של יוסי ותשני אותו ל-0501234567',
    'תמחקי את המשימה של אתמול',
    'בטל',
    'תזכרי שדנה מעדיפה לשחק בחוץ לארץ',
    'מתי נקבע פגישה עם הפועל? תקבעי ליום שלישי',
    'האם אפשר להעביר את העסקה לשלב הבא?',
    'update the club of Dana to Maccabi',
  ]) assert.equal(of(q), TOP, q);
});

test('judgement, analysis and the heavy tools stay at the top', () => {
  for (const q of [
    'מה דעתך על ההצעה של מכבי?',
    'מה המצב של דנה?',
    'למה העסקה תקועה?',
    'איך כדאי להתקדם עם הפועל?',
    'מה כתוב בחוזה של אסף?',
    'מי מתאים לדרישה של בית"ר?',
    'מה יש באתר על נועה?',
    'מה הסרטון האחרון של דנה ביוטיוב?',
    'מתי נסגר חלון ההעברות?',
    'מה אם נציע אותה לקבוצה אחרת?',
    'what should we do with Dana?',
    'תני לי דוח על כל השחקנים',
    'ספרי לי על אסף',
  ]) assert.equal(of(q), TOP, q);
});

test('a file, a voice note, a forwarded message, a long or multi-line message stay at the top', () => {
  assert.equal(of('מה זה?', { media: { mimeType: 'image/jpeg' } }), TOP);
  assert.equal(of('🎤 מתי נגמר החוזה של דנה'), TOP);
  assert.equal(of('[הודעה מועברת]\nמתי המשחק?'), TOP);
  assert.equal(of('מתי המשחק של דנה?\nומתי של אסף?'), TOP);
  assert.equal(of(`מה ${'פרט '.repeat(40)}?`), TOP);
  assert.equal(of(''), TOP);
});

test('an answer to Golda, or a pending two-step action, stays at the top', () => {
  const asked = [{ role: 'user', text: 'תמחקי את דנה' }, { role: 'assistant', text: 'למחוק את דנה כהן?' }];
  assert.equal(of('מה יש היום?', { history: asked }), TOP, 'she asked a question');
  const buttons = [{ role: 'assistant', text: 'הטיוטה מוכנה ולא באוויר.', buttons: ['כן, לפרסם', 'לא'] }];
  assert.equal(of('תודה', { history: buttons }), TOP, 'buttons are waiting');
  assert.equal(of('מתי המשחק?', { session: { pendingDeletes: [{ collection: 'tasks', id: 't1' }] } }), TOP, 'a delete is armed');
  const told = [{ role: 'user', text: 'מתי המשחק?' }, { role: 'assistant', text: 'ביום שבת ב-19:00.' }];
  assert.equal(of('מתי המשחק של אסף?', { history: told }), LOOKUP, 'nothing is open');
});

test('a side topic (research, writing) stays at the top', () => {
  assert.equal(of('מה יש היום?', { topic: { name: 'מכתב לספונסר' } }), TOP);
});

test('when unsure, the top', () => {
  for (const q of ['דנה כהן', 'כן', 'לא', 'הפועל חדרה 19:00', 'אוקיי תמשיכי']) assert.equal(of(q), TOP, q);
});

// --- the request itself ---------------------------------------------------------
function clientSeeing(seen) {
  return { beta: { messages: { stream: (req) => { seen.push(req); return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'בסדר' }], usage: {} }) }; } } } };
}
const db = { collection: () => { throw new Error('no db in this test'); } };
const base = { db, admin: { firestore: { FieldValue: {} } }, identity: { name: 'לו קורק', role: 'admin', email: 'lou.korek@gmail.com' }, assistantName: 'גולדה', memories: [] };

test('the chosen level goes into the request and comes back with the usage; the model and tools do not change', async () => {
  const seen = [];
  const quick = await runAgent({ ...base, text: 'מתי נגמר החוזה של דנה?', session: { history: [] }, client: clientSeeing(seen) });
  const heavy = await runAgent({ ...base, text: 'תעדכני את החוזה של דנה', session: { history: [] }, client: clientSeeing(seen) });
  assert.deepEqual(seen[0].output_config, { effort: 'medium' });
  assert.deepEqual(seen[1].output_config, { effort: 'xhigh' });
  assert.equal(quick.usage.effort, 'medium');
  assert.equal(heavy.usage.effort, 'xhigh');
  assert.equal(seen[0].model, seen[1].model);
  assert.deepEqual(seen[0].tools.map((t) => t.name), seen[1].tools.map((t) => t.name));
  assert.equal(seen[0].system, seen[1].system);
});

// --- the model and effort of every kind of work ---------------------------------
test('every task has its model and effort, and the callers that existed before run as they did', () => {
  const { effortForTask, TASKS, MODEL } = require('../golda-effort.js');
  assert.equal(MODEL, 'claude-opus-5-5');
  const want = {
    chat: 'xhigh', briefing: 'high', scouting: 'high', radar_scan: 'low', radar_card: 'medium', research: 'high', review: 'medium', deal: 'high',
    player: 'medium', style: 'high',
  };
  for (const [task, effort] of Object.entries(want)) assert.deepEqual(effortForTask(task), { model: 'claude-opus-5-5', effort }, task);
  assert.deepEqual([...TASKS].sort(), Object.keys(want).sort(), 'no task without a test');
  // Only levels the code already asked for.
  for (const task of TASKS) assert.ok(['low', 'medium', 'high', 'xhigh'].includes(effortForTask(task).effort), task);
  // A chat message without anything to go on runs at the chooser's default, the top.
  assert.equal(effortForTask('chat').effort, chooseEffort().effort);
  assert.equal(effortForTask('chat').effort, TOP);
  // A task nobody defined is a mistake in the caller, said at once.
  assert.throws(() => effortForTask('poetry'), /unknown task "poetry"/);
  assert.throws(() => effortForTask(), /unknown task/);
  assert.throws(() => effortForTask('toString'), /unknown task/);
  // The callers read their constants from here.
  assert.deepEqual([require('../golda-briefing-ai.js').MODEL, require('../golda-briefing-ai.js').EFFORT], ['claude-opus-5-5', 'high']);
  assert.equal(require('../wa-agent.js').MODEL, 'claude-opus-5-5');
});
