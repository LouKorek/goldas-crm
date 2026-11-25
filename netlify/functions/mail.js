// The agency's mail in the CRM (lib/mail-store.js): the threads of one
// record, hand corrections of a link, and the Gmail connection itself.
//
// Who sees what. Mail is read here only, never by the browser from the
// database. Admins and managers (the roles that edit, and the roles Golda
// answers about mail) see the mail of a club and a contact; a viewer sees
// none. Mail linked to a deal is admin-only, wherever it shows: a deal's
// correspondence is its negotiation (fee, salary, commission), the same
// money that only an admin sees on the deal.
//
//   GET  ?deal=<id> | ?club=<id> | ?contact=<id>   → { address, threads }
//   POST { action: 'deals', id, dealIds }           put a message on these deals (admin)
//   POST { action: 'hide', id }                     "not agency mail" (admin, manager)
//   POST { action: 'reset', id }                    undo a hand correction (admin, manager)
//   POST { action: 'start' }                        → { url }: the Google consent screen (admin)
//   POST { action: 'sync' }                         sync now (admin)
//   POST { action: 'disconnect' }                   forget the key and delete every stored message (admin)
const { withAuth, json, internalHeaders } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const { can } = require('@goldas/domain');
const store = require('./lib/mail-store.js');
const gmailAuth = require('./lib/gmail-auth.js');
const { originOf } = require('./lib/site.js');

const DAY = 864e5;

async function kickSync(event, reason) {
  const res = await fetch(`${originOf(event)}/.netlify/functions/gmail-sync-background`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders(`gmail-sync:${reason}`)) }, body: JSON.stringify({ reason }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`the sync did not start (${res.status})`);
}

const read = withAuth({ action: 'edit' }, async (event, ctx) => {
  const q = event.queryStringParameters || {};
  const kind = q.deal ? 'deal' : q.club ? 'club' : q.contact ? 'contact' : null;
  if (!kind) return json(400, { error: 'which record?' });
  const money = can(ctx.auth.user.role, 'money');
  if (kind === 'deal' && !money) return json(403, { error: 'Forbidden' });
  const db = getDb();
  const pub = await gmailAuth.publicStatus(db);
  if (!pub.connected) return json(200, { connected: false, address: null, threads: [] });
  const list = await store.messagesFor(db, kind, q[kind], { money });
  return json(200, { connected: true, address: pub.address || null, threads: store.threadsOf(list, pub.address || '') });
});

const write = withAuth({ action: 'edit' }, async (event, ctx) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const { role, email } = ctx.auth.user;
  const db = getDb();
  const need = (action) => { if (!can(role, action)) { const e = new Error('Forbidden'); e.status = 403; throw e; } };
  try {
    switch (body.action) {
      case 'deals': {
        need('money');
        const ids = Array.isArray(body.dealIds) ? body.dealIds.map(String).filter(Boolean).slice(0, 5) : [];
        // The deals must exist; their clubs come along so the message shows on them too.
        const deals = (await Promise.all(ids.map((id) => db.collection('deals').doc(id).get()))).filter((s) => s.exists && !s.data().deletedAt);
        if (deals.length !== ids.length) return json(400, { error: 'deal not found' });
        const clubIds = deals.map((s) => s.data().clubId).filter(Boolean);
        return json(200, await store.setDeals(db, body.id, ids, { clubIds, by: email }));
      }
      case 'hide': {
        const { m } = await readVisible(db, body.id, role);
        if (!m) return json(404, { error: 'message not found' });
        return json(200, await store.hide(db, body.id, { by: email }));
      }
      case 'reset': {
        const { m } = await readVisible(db, body.id, role);
        if (!m) return json(404, { error: 'message not found' });
        return json(200, await store.resetLinks(db, body.id));
      }
      case 'start': {
        need('manage_settings');
        // Switch the Gmail API on before the consent screen (at most once a day): the server's own key does it.
        const pub = await gmailAuth.publicStatus(db);
        const tried = (pub.api && pub.api.triedAt) || 0;
        if (!(pub.api && pub.api.state === 'on') && Date.now() - tried > DAY) {
          const en = await gmailAuth.enableGmailApi(gmailAuth.serviceAccount());
          await gmailAuth.savePublic(db, { api: en.ok ? { state: 'switched_on', at: Date.now(), triedAt: Date.now() } : { state: 'unknown', at: Date.now(), triedAt: Date.now(), status: en.status, message: en.message } });
        }
        return json(200, { url: await gmailAuth.startUrl(db, email, { origin: originOf(event) }) });
      }
      case 'sync': {
        need('manage_settings');
        await kickSync(event, `admin:${email}`);
        return json(200, { started: true });
      }
      case 'disconnect': {
        need('manage_settings');
        return json(200, await store.disconnect(db, { by: email }));
      }
      default:
        return json(400, { error: 'unknown action' });
    }
  } catch (e) {
    return json(e.status || (/not set up/.test(e.message) ? 503 : 400), { error: e.message });
  }
});

/** A message this role may act on: not hidden, and not linked to a deal unless the role sees money. */
async function readVisible(db, id, role) {
  const snap = await db.collection(store.MESSAGES).doc(String(id || '')).get();
  const m = snap.exists ? snap.data() : null;
  if (!m || m.hidden || ((m.dealIds || []).length && !can(role, 'money'))) return { m: null };
  return { m };
}

exports.handler = async (event, context) => (event.httpMethod === 'POST' ? write(event, context) : read(event, context));
