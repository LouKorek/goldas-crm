// Golda's voice: a short spoken answer, made with Google Cloud Text-to-Speech
// as OGG/Opus so WhatsApp shows it as a voice note. Same service account and
// same pattern as the transcription (lib/golda-speech.js): a typed error per
// state, and a disabled API is switched on once by the server itself.
//
// Golda speaks only when the message she answers asks for a voice answer
// (lib/golda-voice.js decides that); this file only turns words into sound.
// Nothing here is fatal: on any failure the caller answers in text.
const TTS = 'https://texttospeech.googleapis.com/v1';
const SERVICE = 'texttospeech.googleapis.com';
const SPOKEN_MAX = 700;          // characters: a voice note of about forty seconds
const VOICES = {
  he: { languageCode: 'he-IL', ssmlGender: 'FEMALE' },
  en: { languageCode: 'en-US', ssmlGender: 'FEMALE' },
};

class TtsError extends Error {
  constructor(state, message, status = 0) { super(message); this.state = state; this.status = status; }
}

function classify(e) {
  const status = e.response ? e.response.status : e.status || 0;
  const data = e.response && e.response.data && e.response.data.error ? e.response.data.error : {};
  const text = `${data.status || ''} ${data.message || e.message || ''} ${JSON.stringify(data.details || [])}`;
  if (status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(text)) return new TtsError('needs_api', 'Text-to-Speech API is not enabled on the project', status);
  if (status === 403 && /billing/i.test(text)) return new TtsError('needs_billing', 'Text-to-Speech needs billing enabled on the Google project', status);
  if (status === 403 || status === 401) return new TtsError('needs_permission', String(data.message || e.message).slice(0, 200), status);
  if (status === 400) return new TtsError('bad_text', String(data.message || e.message).slice(0, 200), status);
  return new TtsError('error', String(data.message || e.message || e).slice(0, 200), status);
}

function ttsClient(svc) {
  const { JWT } = require('google-auth-library');
  const jwt = new JWT({ email: svc.client_email, key: svc.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const project = svc.project_id || 'gold-as-crm';
  return {
    async call(method, path, data) {
      try { return (await jwt.request({ url: `${TTS}/${path}`, method, data })).data; } catch (e) { throw classify(e); }
    },
    async enable() {
      try {
        await jwt.request({ url: `https://serviceusage.googleapis.com/v1/projects/${project}/services/${SERVICE}:enable`, method: 'POST', data: {} });
        return { ok: true };
      } catch (e) {
        const status = e.response ? e.response.status : 0;
        const message = e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message;
        return { ok: false, status, message: String(message || '').slice(0, 300) };
      }
    },
  };
}

/**
 * The words to speak: no links, no markup, no lists of numbers, no button line.
 * A long answer is cut at a sentence end before SPOKEN_MAX.
 */
function spokenText(text, max = SPOKEN_MAX) {
  let s = String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, ' ')                       // a [[כפתורים: …]] line
    .replace(/https?:\/\/\S+/g, ' ')                       // links
    .replace(/[*_~`#>|]/g, ' ')                            // WhatsApp and markdown marks
    .replace(/^\s*(?:[•\-–]|\d+[.)])\s+/gm, '')            // list bullets and numbers
    .replace(/[\p{Extended_Pictographic}‍️]/gu, ' ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*\.){2,}/g, '.')
    .replace(/^[\s.]+/, '')
    .trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  s = cut > max * 0.4 ? head.slice(0, cut + 1) : `${head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max)}…`;
  return s.trim();
}

/** he when the text has Hebrew letters, else en. */
const languageOf = (text) => (/[֐-׿]/.test(String(text || '')) ? 'he' : 'en');

/**
 * synthesize(text, { lang, svc, client, sleep })
 * Returns { buffer, mimeType: 'audio/ogg', spoken, lang } or throws a TtsError
 * ({ state: needs_api | needs_billing | needs_permission | bad_text | empty | error }).
 */
async function synthesize(text, { lang, svc, client, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const spoken = spokenText(text);
  if (!spoken) throw new TtsError('empty', 'nothing to say');
  const language = lang === 'he' || lang === 'en' ? lang : languageOf(spoken);
  const c = client || ttsClient(svc || JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}'));
  const body = { input: { text: spoken }, voice: VOICES[language], audioConfig: { audioEncoding: 'OGG_OPUS', speakingRate: 1.05 } };
  const say = () => c.call('POST', 'text:synthesize', body);
  let out;
  try { out = await say(); } catch (e) {
    if (e.state !== 'needs_api') throw e;
    const en = await c.enable();
    if (!en.ok) throw new TtsError('needs_api', `could not enable the Text-to-Speech API by itself: ${en.status} ${en.message}`, en.status);
    await sleep(3000);
    out = await say();
  }
  if (!out || !out.audioContent) throw new TtsError('error', 'no audio came back');
  return { buffer: Buffer.from(out.audioContent, 'base64'), mimeType: 'audio/ogg', spoken, lang: language };
}

module.exports = { synthesize, spokenText, languageOf, ttsClient, classify, TtsError, SERVICE, SPOKEN_MAX };
