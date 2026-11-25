// Phone notifications, the signed-in user's side (lib/push.js does the work).
// Every user may turn them on for his own devices; what each one receives is
// decided when it is sent (his role: money only to admins).
//
//   POST { op: 'key' }                              → { publicKey }
//   POST { op: 'list', endpoint? }                  → { devices }   (endpoint marks "this device")
//   POST { op: 'subscribe', subscription, installed } → { devices }
//   POST { op: 'unsubscribe', id | endpoint }       → { devices }
//   POST { op: 'test', id? }                        → { ok, gone, failed, devices }
//
// Devices come back as { id, device, installed, createdAt, lastOkAt, failing,
// thisDevice }; push addresses and keys never leave the server.
const { withAuth, json, header } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const push = require('./lib/push.js');

exports.handler = withAuth({ action: 'read' }, async (event, ctx) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const db = getDb();
  const user = ctx.auth.user;
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : body.subscription?.endpoint || '';
  const list = async () => json(200, { devices: await push.devicesOf(db, user.email, endpoint) });
  try {
    switch (body.op) {
      case 'key': return json(200, { publicKey: (await push.vapidKeys(db)).publicKey });
      case 'list': return list();
      case 'subscribe':
        await push.subscribe(db, user, body.subscription, { ua: header(event, 'user-agent'), installed: !!body.installed });
        return list();
      case 'unsubscribe':
        await push.unsubscribe(db, user.email, body.id || (endpoint ? push.subId(endpoint) : ''));
        return list();
      case 'test': return json(200, await push.sendTest(db, user.email, { id: typeof body.id === 'string' ? body.id : '' }));
      default: return json(400, { error: `unknown op ${body.op}` });
    }
  } catch (e) {
    if (e.status === 400) return json(400, { error: e.message });
    console.error('[push] failed:', body.op, e.message);
    return json(500, { error: 'Internal error' });
  }
});
