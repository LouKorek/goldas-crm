// Golda outside WhatsApp's 24-hour window: what is sent, what waits, what
// re-opens the conversation, and how a failed status is understood.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';
process.env.OWNER_EMAIL = 'lou.korek@gmail.com';

const outbox = require('../wa-outbox.js');
const { extractStatuses, extractMessages } = require('../wa-api.js');
const { needsRecheck, ensureTemplate, TEMPLATE } = require('../wa-templates.js');

const H = 3600000;

/** Just enough of Firestore for the module: docs, merge, equality queries. */
function fakeDb(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  let n = 0;
  const col = (name) => ({
    doc(id = `auto${++n}`) {
      return {
        id,
        async get() { const d = data[name]?.[id]; return { exists: !!d, data: () => (d ? { ...d } : undefined) }; },
        async set(v, o) { data[name] = data[name] || {}; data[name][id] = o?.merge ? { ...(data[name][id] || {}), ...v } : { ...v }; },
      };
    },
    where(f, _op, v) {
      const filters = [[f, v]];
      const q = {
        where(f2, _o, v2) { filters.push([f2, v2]); return q; },
        async get() {
          const docs = Object.entries(data[name] || {}).filter(([, d]) => filters.every(([k, x]) => d[k] === x))
            .map(([id, d]) => ({ id, data: () => ({ ...d }) }));
          return { docs };
        },
      };
      return q;
    },
  });
  return { data, collection: col };
}

function fakeApi() {
  const calls = [];
  let i = 0;
  return {
    calls,
    async sendText(to, body, via) { calls.push({ kind: 'text', to, body, via }); return [`wamid.t${++i}`]; },
    async sendTemplate(to, name, language, via) {
      calls.push({ kind: 'template', to, name, language, via });
      if (name === 'golda_update' && via === 'no-template-here') throw new Error('WhatsApp API 404: {"error":{"code":132001,"message":"Template name does not exist"}}');
      return `wamid.tpl${++i}`;
    },
  };
}
const quiet = { log: () => {} };

test('the window is open for 23 hours after the last inbound message, unknown before the first one', () => {
  const now = Date.now();
  assert.equal(outbox.windowState({}, now), 'unknown');
  assert.equal(outbox.windowState({ lastInbound: now - 2 * H }, now), 'open');
  assert.equal(outbox.windowState({ lastInbound: now - 23.5 * H }, now), 'closed');
});

test('inside the window the text is sent and recorded under its message id', async () => {
  const now = Date.now();
  const db = fakeDb({ wa_contacts: { 972500000001: { lastInbound: now - H } } });
  const api = fakeApi();
  const r = await outbox.deliver(db, { to: '+972 50-000-0001', body: 'בוקר טוב', kind: 'briefing' }, { now, api, ...quiet });
  assert.equal(r.state, 'sent');
  assert.equal(api.calls.length, 1);
  assert.equal(db.data.wa_outbox['wamid.t1'].state, 'sent');
  assert.equal(db.data.wa_outbox['wamid.t1'].kind, 'briefing');
});

test('outside the window the text waits and one template goes out, not two', async () => {
  const now = Date.now();
  const db = fakeDb({ wa_contacts: { 972500000001: { lastInbound: now - 30 * H } }, app_meta: { whatsapp: { template: { name: 'golda_update', language: 'he', accounts: { 1: { status: 'APPROVED' } } } } } });
  const api = fakeApi();
  const a = await outbox.deliver(db, { to: '972500000001', body: 'תדריך', kind: 'briefing' }, { now, api, ...quiet });
  const b = await outbox.deliver(db, { to: '972500000001', body: 'דחוף', kind: 'urgent' }, { now: now + 60000, api, ...quiet });
  assert.equal(a.state, 'queued'); assert.equal(b.state, 'queued');
  assert.equal(a.reengage.template, 'golda_update');
  assert.equal(b.reengage.skipped, 'recently');
  assert.deepEqual(api.calls.map((c) => c.kind), ['template']);
  assert.equal(Object.values(db.data.wa_outbox).filter((r) => r.state === 'queued').length, 2);
});

test('hello_world is used while Golda\'s template is not approved, and when it is missing on the number\'s account', async () => {
  const now = Date.now();
  assert.deepEqual(outbox.templateFor({}), { name: 'hello_world', language: 'en_US', own: false });
  assert.deepEqual(outbox.templateFor({ template: { name: 'golda_update', language: 'he', accounts: { 1: { status: 'PENDING' } } } }), { name: 'hello_world', language: 'en_US', own: false });
  const db = fakeDb({ wa_contacts: { 972500000001: { lastInbound: now - 30 * H } }, app_meta: { whatsapp: { template: { name: 'golda_update', language: 'he', accounts: { 1: { status: 'APPROVED' } } } } } });
  const api = fakeApi();
  const r = await outbox.deliver(db, { to: '972500000001', body: 'x', via: 'no-template-here' }, { now, api, ...quiet });
  assert.equal(r.reengage.template, 'hello_world');
  assert.deepEqual(api.calls.map((c) => c.name), ['golda_update', 'hello_world']);
});

test('a 131047 status turns a sent text into a queued one and re-engages; delivered is recorded', async () => {
  const now = Date.now();
  const db = fakeDb({ wa_outbox: { 'wamid.a': { to: '972500000001', via: 'p1', body: 'תדריך', state: 'sent' }, 'wamid.b': { to: '972500000001', via: 'p1', body: 'שני', state: 'sent' } } });
  const api = fakeApi();
  const statuses = extractStatuses({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'p1' }, statuses: [
    { id: 'wamid.a', status: 'failed', recipient_id: '972500000001', timestamp: '1', errors: [{ code: 131047, title: 'Re-engagement message', message: 'More than 24 hours have passed' }] },
    { id: 'wamid.b', status: 'delivered', recipient_id: '972500000001', timestamp: '2' },
    { id: 'wamid.unknown', status: 'read', recipient_id: '972500000001', timestamp: '3' },
  ] } }] }] });
  assert.equal(statuses.length, 3);
  assert.ok(outbox.isWindowError(statuses[0].errors));
  const handled = await outbox.onStatuses(db, statuses, { now, api, ...quiet });
  assert.equal(handled, 2);
  assert.equal(db.data.wa_outbox['wamid.a'].state, 'queued');
  assert.equal(db.data.wa_outbox['wamid.b'].state, 'delivered');
  assert.equal(db.data.wa_contacts['972500000001'].lastFailure.code, 131047);
  assert.deepEqual(api.calls.map((c) => c.kind), ['template']);
});

test('an inbound message opens the window and releases what waited, oldest first', async () => {
  const now = Date.now();
  const db = fakeDb({ wa_outbox: {
    q2: { to: '972500000001', body: 'שני', state: 'queued', queuedAt: now - H },
    q1: { to: '972500000001', body: 'ראשון', state: 'queued', queuedAt: now - 2 * H },
    other: { to: '972500000002', body: 'לא שלי', state: 'queued', queuedAt: now - 3 * H },
    done: { to: '972500000001', body: 'נשלח', state: 'sent' },
  } });
  const api = fakeApi();
  const r = await outbox.onInbound(db, '972500000001', 'p1', { now, api, ...quiet });
  assert.deepEqual(r, { pending: 2, flushed: 2 });
  assert.deepEqual(api.calls.map((c) => c.body), ['ראשון', 'שני']);
  assert.equal(db.data.wa_outbox.q1.state, 'sent');
  assert.equal(db.data.wa_outbox.other.state, 'queued');
  assert.equal(db.data.wa_contacts['972500000001'].lastInbound, now);
  assert.equal(outbox.windowState(db.data.wa_contacts['972500000001'], now), 'open');
});

test('a quick-reply tap arrives with its payload', () => {
  const [m] = extractMessages({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'p1' }, messages: [
    { id: 'wamid.x', from: '972500000001', type: 'button', timestamp: '1', button: { payload: 'שלחי את העדכון', text: 'שלחי את העדכון' } },
  ] } }] }] });
  assert.equal(m.type, 'button');
  assert.equal(m.text, 'שלחי את העדכון');
  assert.equal(m.payload, 'שלחי את העדכון');
});

test('the template is created where missing and re-checked while pending', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '')}`);
    const get = (opts.method || 'GET') === 'GET';
    if (get && url.includes('/111/')) return { json: async () => ({ data: [{ id: 't1', name: 'golda_update', language: 'he', status: 'APPROVED' }] }) };
    if (get && url.includes('/222/')) return { json: async () => ({ data: [] }) };
    if (opts.method === 'POST') return { json: async () => ({ id: 't2', status: 'PENDING' }) };
    return { json: async () => ({ error: { code: 200, message: 'no permission' } }) };
  };
  const db = fakeDb();
  const r = await ensureTemplate(db, { fetchImpl, env: { WA_TOKEN: 'x', WA_WABA_IDS: '111,222' }, now: 5, ...quiet });
  assert.equal(r.accounts['111'].status, 'APPROVED');
  assert.equal(r.accounts['222'].status, 'PENDING'); assert.equal(r.accounts['222'].created, true);
  assert.equal(r.accounts['1394027662708325'].status, 'error');
  assert.ok(seen.some((s) => s.startsWith('POST 222/message_templates')));
  assert.equal(db.data.app_meta.whatsapp.template.name, TEMPLATE.name);
  assert.equal(needsRecheck(db.data.app_meta.whatsapp, 10), false, 'approved somewhere: no recheck');
  assert.equal(needsRecheck({ template: { accounts: { 1: { status: 'PENDING' } }, checkedAt: 0 } }, 2 * H), true);
  assert.equal(needsRecheck({ template: { accounts: { 1: { status: 'PENDING' } }, checkedAt: 2 * H - 1000 } }, 2 * H), false);
  assert.equal(needsRecheck({}), true);
});
