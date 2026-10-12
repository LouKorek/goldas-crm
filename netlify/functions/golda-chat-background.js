// The app's door to Golda. A signed-in user posts a message; it is queued in
// wa_inbox like a WhatsApp message (channel: 'app', with the user's identity
// from their token) and handled by the same worker. The screen listens to the
// inbox document for the reply, so this returns at once (background function).
//
// POST { text, clientId? }   → 202, body { messageId }
const { admin, getDb } = require('./lib/firestore.js');
const { withAuth, json } = require('./lib/auth.js');
const { processMessage } = require('./lib/golda-worker.js');

exports.handler = withAuth({ action: 'read' }, async (event, ctx) => {
  const user = ctx.auth.user;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const text = String(body.text || '').trim().slice(0, 4000);
  if (!text) return json(400, { error: 'empty message' });
  const db = getDb();
  const id = String(body.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ref = db.collection('wa_inbox').doc(id);
  try {
    await ref.create({
      id, channel: 'app', from: '', email: user.email, name: user.name, role: user.role, type: 'text', text,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(), timestamp: Math.floor(Date.now() / 1000), state: 'queued',
    });
  } catch (e) {
    if (!(e.code === 6 || /already exists/i.test(e.message))) throw e;
  }
  await processMessage(id);
  return json(200, { messageId: id });
});
