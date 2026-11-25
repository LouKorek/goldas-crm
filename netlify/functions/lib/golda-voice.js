// A voice answer, only when asked for. Lou's condition, in his words: "רק אם
// אמרתי בהקלטה או בכתב שאני מעוניין שהיא תענה לי בהודעה קולית". So Golda
// answers with a voice note only when the message she is answering, typed or
// a voice note, itself asks for a voice answer. There is no standing "always
// by voice" mode, and a voice note in is not a request for a voice note out.
//
// The model decides through the voice_reply tool; the server checks the same
// condition on its own, without a second model call: the tool refuses unless
// the words of the current message contain a request for a voice answer
// (asksForVoice below). That check is a necessary condition, not a sufficient
// one: the model still judges whether the words really ask for it.
//
// The voice note is the short spoken version (no links, no lists of numbers,
// no markup, lib/golda-tts.js); the normal text answer follows it, so links
// and buttons keep working. Team members only (the player's Golda has no such
// tool), WhatsApp only (the app has no voice notes). Any failure: the answer
// goes in text with one line saying the voice answer is not available yet.
const { synthesize } = require('./golda-tts.js');

const VOICE_UNAVAILABLE = 'את התשובה הקולית אני עוד לא יכולה לשלוח, אז הנה בכתב.';

// Hebrew letters, for word edges (\b does not work with Hebrew in JS).
const HE = '\\u0590-\\u05FF';
const EDGE_BEFORE = `(?:^|[^${HE}A-Za-z])`;
const EDGE_AFTER = `(?![${HE}A-Za-z])`;

// The words that name a voice answer.
// Matches "הודעה קולית", "תשובה קולית", "קולית", "הקלטה", "וויס", "אודיו"; not "קולנוע".
// https://regex101.com/?regex=(%3F%3A%D7%94%D7%95%D7%93%D7%A2%5B%D7%94%D7%AA%5D%5Cs%2B%D7%A7%D7%95%D7%9C%D7%99%D7%AA%7C%D7%A7%D7%95%D7%9C%D7%99%D7%AA%7C%D7%94%D7%A7%D7%9C%D7%98%D7%94)&testString=%D7%AA%D7%A2%D7%A0%D7%99%20%D7%9C%D7%99%20%D7%91%D7%94%D7%95%D7%93%D7%A2%D7%94%20%D7%A7%D7%95%D7%9C%D7%99%D7%AA
const HE_TERM = '(?:(?:הודע[הת]|תשוב[הת]|מענה)\\s+(?:ה)?קולי(?:ת)?|קולית|הקלט(?:ה|ות)|ווי?י?ס|וייס|אודיו)';
// Hebrew verbs of recording: "תקליטי", "הקליטי", "להקליט"; not "הקלטתי" (I recorded).
// https://regex101.com/?regex=(%3F%3A%D7%AA%D7%A7%D7%9C%D7%99%D7%98%D7%99%3F%7C%D7%94%D7%A7%D7%9C%D7%99%D7%98%D7%99%7C%D7%9C%D7%94%D7%A7%D7%9C%D7%99%D7%98)&testString=%D7%AA%D7%A7%D7%9C%D7%99%D7%98%D7%99%20%D7%9C%D7%99
const HE_RECORD_VERB = `${EDGE_BEFORE}(?:תקליטי?|הקליטי|להקליט)${EDGE_AFTER}`;
// The manner of the answer: "בהודעה קולית", "בקולית", "בהקלטה", "בקול", "בוויס", "באודיו".
// Matches "תעני לי בהודעה קולית", "תגידי בקול"; rejects "בקולנוע".
// https://regex101.com/?regex=(%3F%3A%5E%7C%5B%5E%5Cu0590-%5Cu05FF%5D)%D7%95%3F%D7%91(%3F%3A%D7%94)%3F%D7%A7%D7%95%D7%9C%D7%99%D7%AA&testString=%D7%AA%D7%A2%D7%A0%D7%99%20%D7%91%D7%A7%D7%95%D7%9C%D7%99%D7%AA
const HE_MANNER = new RegExp(`${EDGE_BEFORE}ו?ב(?:ה)?(?:${HE_TERM}|קולך?|קול\\s+רם)${EDGE_AFTER}`);
// A request around a voice word: imperative, "please", "I want", "can you".
// Matches "תשלחי לי הקלטה", "הודעה קולית בבקשה"; rejects "שלחתי לו הודעה קולית".
// https://regex101.com/?regex=(%3F%3A%D7%AA%D7%A2%D7%A0%D7%99%7C%D7%AA%D7%A9%D7%9C%D7%97%D7%99%7C%D7%91%D7%91%D7%A7%D7%A9%D7%94)&testString=%D7%AA%D7%A9%D7%9C%D7%97%D7%99%20%D7%9C%D7%99%20%D7%94%D7%A7%D7%9C%D7%98%D7%94
const HE_CUE = `${EDGE_BEFORE}(?:תעני|עני|ענייה|תעניי|תשלחי|שלחי|תחזירי|תגידי|תספרי|תקריאי|תקראי|תדברי|תני|אפשר|בבקשה|רוצה|מעוניין|מעוניינת|מבקש|מבקשת|לענות|לקבל|תשובה)${EDGE_AFTER}`;
const HE_TERM_RE = new RegExp(`${EDGE_BEFORE}ו?(?:ה|ב|ל)?${HE_TERM}${EDGE_AFTER}`);
// "no / without / don't", at most two words before a voice word and in the same
// clause, cancels it. Matches "בלי הודעה קולית", "אל תשלחי הקלטה", "no voice note";
// rejects "לא יודע, תעני בהקלטה" (the comma ends the clause).
// https://regex101.com/?regex=(%3F%3A%D7%91%D7%9C%D7%99%7C%D7%9C%D7%90%7C%D7%90%D7%9C)%5Cs%2B%D7%94%D7%A7%D7%9C%D7%98%D7%94&testString=%D7%91%D7%9C%D7%99%20%D7%94%D7%A7%D7%9C%D7%98%D7%94
const NEGATED = new RegExp(`${EDGE_BEFORE}(?:בלי|לא|אל|ללא|without|no|not|don'?t|never)\\s+(?:[^\\s,.!?;:]+\\s+){0,2}(?:ו?(?:ה|ב|ל)?${HE_TERM}|תקליטי?|ב?קול${EDGE_AFTER}|voice|audio|recording)`, 'i');
// English: "by voice", "in a voice note", "as audio", "out loud", "aloud".
// https://regex101.com/?regex=%5Cb(%3F%3Aby%7Cin%7Cas%7Cvia%7Cwith)%5Cs%2B(%3F%3Aa%5Cs%2B)%3F(%3F%3Avoice%7Caudio)%5Cb&testString=answer%20me%20by%20voice
const EN_MANNER = /\b(?:by|in|as|via|with)\s+(?:a\s+)?(?:voice|audio)\b|\b(?:out\s+loud|aloud)\b/i;
// https://regex101.com/?regex=%5Cbvoice(%3F%3A%5Cs*(%3F%3Anote%7Cmessage))%3F%5Cb&testString=send%20me%20a%20voice%20note
const EN_TERM = /\bvoice(?:\s*(?:note|message|memo|reply|answer|recording))?\b|\baudio\b|\brecording\b/i;
// https://regex101.com/?regex=%5Cb(%3F%3Areply%7Canswer%7Csend%7Cplease)%5Cb&testString=please%20send%20a%20voice%20note
const EN_CUE = /\b(?:reply|answer|respond|send|tell|read|record|want|like|can you|could you|please)\b/i;

/**
 * Does this message itself ask for a voice answer? Pure, so it is tested.
 * The text is the current turn's words: typed, or a voice note's transcript
 * (which starts with 🎤). A forwarded message is someone else's words, so it
 * never asks.
 */
function asksForVoice(text) {
  let t = String(text || '').trim();
  if (!t || t.startsWith('[הודעה מועברת]')) return false;
  t = t.replace(/^🎤\s*/u, '');
  // Only the writer's own words: an attachment note added by the server is not his.
  t = t.replace(/\n\[Attached [^\]]*\]\s*$/s, '');
  if (NEGATED.test(t)) return false;
  if (HE_MANNER.test(t) || EN_MANNER.test(t)) return true;
  const he = (HE_TERM_RE.test(t) && new RegExp(HE_CUE).test(t)) || new RegExp(HE_RECORD_VERB).test(t);
  const en = EN_TERM.test(t) && EN_CUE.test(t);
  return he || en;
}

const VOICE_TOOL_DEF = {
  name: 'voice_reply',
  description: 'Send a short WhatsApp voice note with your answer, before the text answer (which still goes out as usual, with its links and buttons). ONLY when the message you are answering right now, typed or a voice note, itself asks in so many words for a voice answer ("תעני לי בהודעה קולית", "בהקלטה", "voice note please"). Never because the message was a voice note, never because of an earlier message or a memory: there is no "always by voice" mode. The server refuses when the current message does not ask for it. Pass the spoken version of the answer: short (two to five sentences), plain spoken Hebrew (or English when the writer wrote in English), no links, no lists of numbers, no markup. One call per answer.',
  input_schema: { type: 'object', properties: {
    text: { type: 'string', description: 'What to say, as you would say it out loud' },
    lang: { type: 'string', enum: ['he', 'en'], description: 'Defaults to the language of the text' },
  }, required: ['text'], additionalProperties: false },
};

/** The prompt line for the voice answer; WhatsApp only. */
function voiceSection(channel = 'whatsapp') {
  if (channel === 'app') return '';
  return '- A voice answer: ONLY when the message you are answering right now itself asks for one, in writing or in the voice note ("תעני לי בהודעה קולית", "תשלחי לי הקלטה", "בקול"), call voice_reply once with the short spoken version, then write your usual text answer (it follows the voice note, with the links and buttons). A voice note in is not a request for a voice note out; an earlier request or a memory is not one either, and you never save "always answer by voice" as a memory. If voice_reply says it is not available, add its one line to the text answer.';
}

/**
 * voiceTools({ identity, channel, turnText, state, db, synth })
 *   turnText  the words of the message being answered (typed or transcribed)
 *   state     wa-agent's per-answer state: the voice note goes into state.outVoice
 */
function voiceTools({ identity = {}, channel = 'whatsapp', turnText = '', state = {}, db = null, synth = synthesize }) {
  async function voiceReply({ text, lang }) {
    if (identity.role === 'player') throw new Error('voice answers are for the team only');
    if (channel !== 'whatsapp') return { sent: false, reason: 'app', instruction: 'There are no voice notes in the app. Answer in text only and do not mention a voice note.' };
    if (!asksForVoice(turnText)) return { sent: false, refused: true, reason: 'not_asked', instruction: 'The message you are answering does not ask for a voice answer, so none goes out. Answer in text only and do not mention a voice note.' };
    if (state.outVoice) return { sent: false, reason: 'one_per_answer', instruction: 'A voice note is already on its way with this answer.' };
    try {
      const out = await synth(text, { lang });
      state.outVoice = { buffer: out.buffer, mimeType: out.mimeType, spoken: out.spoken, lang: out.lang };
      if (db) db.collection('app_meta').doc('whatsapp').set({ tts: { state: 'ok', at: Date.now(), message: '' } }, { merge: true }).catch(() => {});
      return { ready: true, spoken: out.spoken, instruction: 'The voice note goes out right before your text answer. Write the text answer as usual; no need to say a voice note is attached.' };
    } catch (e) {
      const st = e.state || 'error';
      console.warn('[golda] voice answer failed:', st, e.message);
      if (db && st !== 'empty' && st !== 'bad_text') db.collection('app_meta').doc('whatsapp').set({ tts: { state: st, at: Date.now(), message: String(e.message || '').slice(0, 300) } }, { merge: true }).catch(() => {});
      return { sent: false, unavailable: true, state: st, instruction: `Answer in text, and add this line as it is: "${VOICE_UNAVAILABLE}"` };
    }
  }
  return { voice_reply: voiceReply };
}

module.exports = { asksForVoice, voiceTools, voiceSection, VOICE_TOOL_DEF, VOICE_UNAVAILABLE };
