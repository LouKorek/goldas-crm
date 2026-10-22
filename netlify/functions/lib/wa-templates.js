// Golda's message templates on Meta. A business may only send an approved
// template outside WhatsApp's 24-hour window, so Golda has two of her own:
//   golda_digest  carries the update itself (a title and a one-line summary)
//                 plus a button for the full text (lib/wa-outbox.js digestOf);
//   golda_update  the older pointer ("there is an update, tap"), kept as the
//                 fallback while the digest awaits review;
// and Meta's hello_world behind both.
//
// ensureTemplate() is idempotent and runs on every production deploy
// (deploy-succeeded), from whatsapp-setup?template=1, and each hour from
// golda-briefing while a template is pending: it reads each template's status
// on every WhatsApp account we know (WA_WABA_IDS plus the test account), creates
// it where it is missing, and writes the result to app_meta/whatsapp.templates.
// Creating or reading templates needs the whatsapp_business_management
// permission on WA_TOKEN; without it the status stays 'error' and hello_world
// is used. Never logs the token.
const GRAPH = 'https://graph.facebook.com/v21.0';
const TEST_WABA = '1394027662708325';   // Meta's test number lives here

const DIGEST = {
  name: 'golda_digest',
  language: 'he',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: '{{1}}\n{{2}}\n\nלפירוט המלא לחצו על הכפתור, או כתבו לי כל דבר.',
      example: { body_text: [['בוקר טוב, לו ☀️ 22.10.2026', 'היום: 19:00 הפועל – מכבי · דורש פעולה (2): חוזה של נועם ברזילי מסתיים בעוד 5 ימים · ב-24 השעות האחרונות ביצעתי 3 שינויים במערכת']] },
    },
    { type: 'FOOTER', text: 'גולדה · Gold A&S' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'שלחי את הפירוט' }] },
  ],
};
const UPDATE = {
  name: 'golda_update',
  language: 'he',
  category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'יש לי עדכון חדש בשבילך מהמערכת 📋\nלחצו על הכפתור ואשלח אותו מיד.' },
    { type: 'FOOTER', text: 'גולדה · Gold A&S' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'שלחי את העדכון' }] },
  ],
};
const TEMPLATES = [DIGEST, UPDATE];
const TEMPLATE = UPDATE;   // compatibility

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

/** One account, one template: read its status; create it when missing. */
async function ensureOn(waba, { fetchImpl = fetch, template = UPDATE } = {}) {
  const got = await graph(`${waba}/message_templates?name=${template.name}&fields=id,name,status,language,category,rejected_reason`, 'GET', null, fetchImpl);
  if (got.body?.error) return { status: 'error', error: `${got.body.error.code || got.status}: ${got.body.error.message || ''}`.slice(0, 200) };
  const found = (got.body?.data || []).find((t) => t.name === template.name && t.language === template.language);
  if (found) return { status: found.status || 'UNKNOWN', id: found.id || null, ...(found.rejected_reason && found.rejected_reason !== 'NONE' ? { error: found.rejected_reason } : {}) };
  const made = await graph(`${waba}/message_templates`, 'POST', template, fetchImpl);
  if (made.body?.error) return { status: 'error', error: `${made.body.error.code || made.status}: ${made.body.error.message || ''}`.slice(0, 200) };
  return { status: made.body?.status || 'PENDING', id: made.body?.id || null, created: true };
}

/**
 * Every template on every account. Writes app_meta/whatsapp.templates
 * { name: { language, accounts: { waba: { status, id?, error? } }, checkedAt } }
 * (and `template` = golda_update, for the fields older code reads).
 */
async function ensureTemplate(db, { fetchImpl = fetch, env = process.env, log = console.log, now = Date.now() } = {}) {
  if (!env.WA_TOKEN) return { skipped: 'WA_TOKEN not set' };
  const templates = {};
  for (const template of TEMPLATES) {
    const accounts = {};
    for (const waba of wabaIds(env)) {
      try { accounts[waba] = await ensureOn(waba, { fetchImpl, template }); }
      catch (e) { accounts[waba] = { status: 'error', error: String(e.message).slice(0, 200) }; }
    }
    templates[template.name] = { name: template.name, language: template.language, accounts, checkedAt: now };
    const line = Object.entries(accounts).map(([w, a]) => `${w}: ${a.status}${a.created ? ' (created)' : ''}${a.error ? ` – ${a.error}` : ''}`).join('; ');
    log(`[wa-templates] ${template.name}: ${line}`);
  }
  await db.collection('app_meta').doc('whatsapp').set({ templates, template: templates[UPDATE.name] }, { merge: true });
  return { templates, checkedAt: now, accounts: templates[DIGEST.name].accounts, name: DIGEST.name };
}

const approvedSomewhere = (t) => Object.values(t?.accounts || {}).some((a) => a.status === 'APPROVED');

/** True while some template still waits for Meta's review (or was never checked), at most once an hour. */
const needsRecheck = (meta, now = Date.now(), everyMs = 3600000) => {
  const all = meta?.templates;
  if (!all) return true;
  const pending = TEMPLATES.filter((t) => !approvedSomewhere(all[t.name]));
  if (!pending.length) return false;
  const checked = Math.min(...pending.map((t) => all[t.name]?.checkedAt || 0));
  return now - checked >= everyMs;
};

module.exports = { ensureTemplate, ensureOn, needsRecheck, approvedSomewhere, wabaIds, TEMPLATES, DIGEST, UPDATE, TEMPLATE, TEST_WABA };
