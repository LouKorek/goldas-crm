// Golda's re-engagement template on Meta. A business may only send an approved
// template outside WhatsApp's 24-hour window, so Golda needs one of her own
// (lib/wa-outbox.js falls back to Meta's hello_world until this is approved).
//
// ensureTemplate() is idempotent and runs on every production deploy
// (deploy-succeeded), from whatsapp-setup?template=1, and each hour from
// golda-briefing while the template is pending: it reads the template's status
// on every WhatsApp account we know (WA_WABA_IDS plus the test account), creates
// it where it is missing, and writes the result to app_meta/whatsapp.template.
// Creating or reading templates needs the whatsapp_business_management
// permission on WA_TOKEN; without it the status stays 'error' and hello_world
// is used. Never logs the token.
const GRAPH = 'https://graph.facebook.com/v21.0';
const TEST_WABA = '1394027662708325';   // Meta's test number lives here

const TEMPLATE = {
  name: 'golda_update',
  language: 'he',
  category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'יש לי עדכון חדש בשבילך מהמערכת 📋\nלחצו על הכפתור ואשלח אותו מיד.' },
    { type: 'FOOTER', text: 'גולדה · Gold A&S' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'שלחי את העדכון' }] },
  ],
};

const wabaIds = (env = process.env) => Array.from(new Set(
  `${env.WA_WABA_IDS || '1564386882158483'},${TEST_WABA}`.split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)),
));

async function graph(path, method = 'GET', body, fetchImpl = fetch, token = process.env.WA_TOKEN) {
  const res = await fetchImpl(`${GRAPH}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

/** One account: read the template's status; create it when missing. */
async function ensureOn(waba, { fetchImpl = fetch } = {}) {
  const got = await graph(`${waba}/message_templates?name=${TEMPLATE.name}&fields=id,name,status,language,category,rejected_reason`, 'GET', null, fetchImpl);
  if (got.body?.error) return { status: 'error', error: `${got.body.error.code || got.status}: ${got.body.error.message || ''}`.slice(0, 200) };
  const found = (got.body?.data || []).find((t) => t.name === TEMPLATE.name && t.language === TEMPLATE.language);
  if (found) return { status: found.status || 'UNKNOWN', id: found.id || null, ...(found.rejected_reason && found.rejected_reason !== 'NONE' ? { error: found.rejected_reason } : {}) };
  const made = await graph(`${waba}/message_templates`, 'POST', TEMPLATE, fetchImpl);
  if (made.body?.error) return { status: 'error', error: `${made.body.error.code || made.status}: ${made.body.error.message || ''}`.slice(0, 200) };
  return { status: made.body?.status || 'PENDING', id: made.body?.id || null, created: true };
}

async function ensureTemplate(db, { fetchImpl = fetch, env = process.env, log = console.log, now = Date.now() } = {}) {
  if (!env.WA_TOKEN) return { skipped: 'WA_TOKEN not set' };
  const accounts = {};
  for (const waba of wabaIds(env)) {
    try { accounts[waba] = await ensureOn(waba, { fetchImpl }); }
    catch (e) { accounts[waba] = { status: 'error', error: String(e.message).slice(0, 200) }; }
  }
  const summary = { name: TEMPLATE.name, language: TEMPLATE.language, accounts, checkedAt: now };
  await db.collection('app_meta').doc('whatsapp').set({ template: summary }, { merge: true });
  const line = Object.entries(accounts).map(([w, a]) => `${w}: ${a.status}${a.created ? ' (created)' : ''}${a.error ? ` – ${a.error}` : ''}`).join('; ');
  log(`[wa-templates] ${TEMPLATE.name}: ${line}`);
  return summary;
}

/** True when some account still waits for Meta's review, so it is worth checking again. */
const needsRecheck = (meta, now = Date.now(), everyMs = 3600000) => {
  const t = meta?.template;
  if (!t) return true;
  const statuses = Object.values(t.accounts || {}).map((a) => a.status);
  if (statuses.includes('APPROVED')) return false;
  return now - (t.checkedAt || 0) >= everyMs;
};

module.exports = { ensureTemplate, ensureOn, needsRecheck, wabaIds, TEMPLATE, TEST_WABA };
