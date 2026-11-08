// Voice messages for Golda: a WhatsApp voice note (OGG/Opus) is turned into
// text with Google Cloud Speech-to-Text, using the same service account the
// calendar sync uses (FIREBASE_SERVICE_ACCOUNT_KEY, project gold-as-crm).
// Hebrew first, English recognised as well. Up to a minute goes through the
// synchronous call; longer notes through the long-running call, polled here.
//
// Nothing here is fatal for Golda: when transcription is impossible (API not
// enabled, billing off, an unsupported format), the caller gets a typed error
// and tells the writer to type the message instead. The state of the service
// is kept in app_meta/whatsapp.speech so the Golda screen can show it.
const SPEECH = 'https://speech.googleapis.com/v1';
const SERVICE = 'speech.googleapis.com';
const LANGUAGE = 'he-IL';
const ALSO = ['en-US'];
const SYNC_MAX_BYTES = 900 * 1024;      // a minute of Opus is far below this; bigger goes long-running
const POLL_MS = 1500;
const POLL_MAX_MS = 90000;

class SpeechError extends Error {
  constructor(state, message, status = 0) { super(message); this.state = state; this.status = status; }
}

/** The Opus header inside an Ogg stream: channels and the input sample rate. */
function opusHead(buffer) {
  const i = buffer.indexOf('OpusHead', 0, 'latin1');
  if (i < 0 || i + 16 > buffer.length) return null;
  const channels = buffer[i + 9] || 1;
  const rate = buffer.readUInt32LE(i + 12);
  return { channels, rate: [8000, 12000, 16000, 24000, 48000].includes(rate) ? rate : 48000 };
}

/** Recognition config for a WhatsApp audio message, or null when the format is not supported. */
function configFor(buffer, mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const base = { languageCode: LANGUAGE, alternativeLanguageCodes: ALSO, enableAutomaticPunctuation: true, model: 'default' };
  if (type === 'audio/ogg' || type === 'audio/opus' || buffer.slice(0, 4).toString('latin1') === 'OggS') {
    const head = opusHead(buffer) || { channels: 1, rate: 16000 };
    return { ...base, encoding: 'OGG_OPUS', sampleRateHertz: head.rate, audioChannelCount: head.channels };
  }
  if (type === 'audio/mpeg' || type === 'audio/mp3') return { ...base, encoding: 'MP3', sampleRateHertz: 16000 };
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/flac') return base;   // header carries the rate
  return null;
}

function classify(e) {
  const status = e.response ? e.response.status : e.status || 0;
  const data = e.response && e.response.data && e.response.data.error ? e.response.data.error : {};
  const text = `${data.status || ''} ${data.message || e.message || ''} ${JSON.stringify(data.details || [])}`;
  if (status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(text)) return new SpeechError('needs_api', 'Speech-to-Text API is not enabled on the project', status);
  if (status === 403 && /billing/i.test(text)) return new SpeechError('needs_billing', 'Speech-to-Text needs billing enabled on the Google project', status);
  if (status === 403 || status === 401) return new SpeechError('needs_permission', String(data.message || e.message).slice(0, 200), status);
  if (status === 400) return new SpeechError('bad_audio', String(data.message || e.message).slice(0, 200), status);
  return new SpeechError('error', String(data.message || e.message || e).slice(0, 200), status);
}

function speechClient(svc) {
  const { JWT } = require('google-auth-library');
  const jwt = new JWT({ email: svc.client_email, key: svc.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return {
    email: svc.client_email,
    projectId: svc.project_id || 'gold-as-crm',
    async call(method, path, data) {
      try { return (await jwt.request({ url: `${SPEECH}/${path}`, method, data })).data; } catch (e) { throw classify(e); }
    },
    async enable() {
      try {
        await jwt.request({ url: `https://serviceusage.googleapis.com/v1/projects/${svc.project_id || 'gold-as-crm'}/services/${SERVICE}:enable`, method: 'POST', data: {} });
        return { ok: true };
      } catch (e) {
        const status = e.response ? e.response.status : 0;
        const message = e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message;
        return { ok: false, status, message: String(message || '').slice(0, 300) };
      }
    },
  };
}

const joinResults = (response) => {
  const results = (response && response.results) || [];
  const text = results.map((r) => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '').join(' ').replace(/\s+/g, ' ').trim();
  const conf = results.map((r) => r.alternatives && r.alternatives[0] && r.alternatives[0].confidence).filter((c) => typeof c === 'number');
  const language = results.map((r) => r.languageCode).find(Boolean) || LANGUAGE;
  return { text, language, confidence: conf.length ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 100) / 100 : null };
};

/**
 * transcribe(buffer, mimeType, { svc, client, sleep })
 * Returns { text, language, confidence, seconds? } or throws a SpeechError
 * ({ state: needs_api | needs_billing | needs_permission | bad_audio | unsupported | empty | error }).
 * A disabled API is switched on once, by the server itself, and the call retried.
 */
async function transcribe(buffer, mimeType, { svc, client, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const config = configFor(buffer, mimeType);
  if (!config) throw new SpeechError('unsupported', `audio format ${mimeType || 'unknown'} is not supported`);
  const c = client || speechClient(svc || JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}'));
  const body = { config, audio: { content: buffer.toString('base64') } };
  const recognise = async () => {
    if (buffer.length <= SYNC_MAX_BYTES) {
      try { return await c.call('POST', 'speech:recognize', body); } catch (e) {
        if (!(e.state === 'bad_audio' && /too long|longer than/i.test(e.message))) throw e;
      }
    }
    const op = await c.call('POST', 'speech:longrunningrecognize', body);
    const started = now();
    let cur = op;
    while (!cur.done) {
      if (now() - started > POLL_MAX_MS) throw new SpeechError('error', 'transcription took too long');
      await sleep(POLL_MS);
      cur = await c.call('GET', `operations/${op.name}`);
    }
    if (cur.error) throw new SpeechError('error', String(cur.error.message || 'transcription failed').slice(0, 200));
    return cur.response || {};
  };
  let response;
  try { response = await recognise(); } catch (e) {
    if (e.state !== 'needs_api') throw e;
    const en = await c.enable();
    if (!en.ok) throw new SpeechError('needs_api', `could not enable the Speech-to-Text API by itself: ${en.status} ${en.message}`, en.status);
    await sleep(3000);
    response = await recognise();
  }
  const out = joinResults(response);
  if (!out.text) throw new SpeechError('empty', 'no speech recognised');
  return out;
}

/** What the writer hears when a voice note could not be transcribed, by state. */
function excuse(state) {
  switch (state) {
    case 'needs_billing': case 'needs_api': case 'needs_permission': return 'התמלול של הודעות קוליות עוד לא פעיל אצלי (מנהל מפעיל אותו בלחיצה במסך גולדה, בלשונית "התדריך שלי")';
    case 'unsupported': return 'את הקובץ הקולי הזה אני לא יודעת לקרוא';
    case 'empty': return 'לא הצלחתי לשמוע מילים בהודעה הקולית';
    default: return 'לא הצלחתי לתמלל את ההודעה הקולית הפעם';
  }
}

module.exports = { transcribe, configFor, opusHead, joinResults, speechClient, SpeechError, excuse, SERVICE, LANGUAGE };
