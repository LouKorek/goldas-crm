// The live links of a player, for the CRM's own screens (the "Live links"
// card on the player page). The browser never reads player_pages itself.
//
//   GET  ?playerId=<id>                  → { links: [...], canEdit }   any signed-in user
//   POST { action: 'revoke', id }        → { link }                    needs the right to edit
//
// A link's address is included only for a user who may edit and only while
// the link still works; a viewer sees that links exist and who opened them.
// There is no "create" here on purpose: a live page is made only when the
// owner asks Golda for one (lib/golda-player-page.js).
const { withAuth, json } = require('./lib/auth.js');
const { getDb, admin } = require('./lib/firestore.js');
const { can } = require('@goldas/domain');
const { originOf } = require('./lib/site.js');
const pages = require('./lib/player-pages.js');

async function handle(event, ctx, deps = {}) {
  const db = deps.db || getDb();
  const now = deps.now || Date.now();
  const user = ctx.auth.user;
  const editor = !!user && can(user.role, 'edit');
  const base = originOf(event);

  if (event.httpMethod === 'GET') {
    const playerId = String((event.queryStringParameters || {}).playerId || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(playerId)) return json(400, { error: 'bad request' });
    return json(200, { links: await pages.listLinks(db, playerId, { now, withUrl: editor, base }), canEdit: editor });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad request' }); }
  if (!body || body.action !== 'revoke') return json(400, { error: 'bad request' });
  if (!editor) return json(403, { error: 'Forbidden' });
  const link = await pages.revokeLink(db, body.id, { by: user, now });
  if (!link) return json(404, { error: 'not found' });
  if (!link.revokedAt) {
    await db.collection('audit').add({
      action: 'update', collection: pages.COL, docId: link.id, name: link.playerName || '',
      summary: `Live page link revoked: ${link.playerName || ''}${link.club ? ` · ${link.club}` : ''}`, fields: ['revokedAt'],
      by: user.email, byName: user.name, via: 'web', at: admin.firestore.FieldValue.serverTimestamp(), undone: false,
    });
  }
  const fresh = await db.collection(pages.COL).doc(link.id).get();
  return json(200, { link: pages.viewOf({ id: link.id, ...fresh.data() }, { now, withUrl: false }) });
}

exports.handler = withAuth({ action: 'read' }, (event, ctx) => handle(event, ctx));
exports._handle = handle;
