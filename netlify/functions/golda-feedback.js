// 👍/👎 under one of Golda's answers in the app. Only the person who asked can
// rate the answer (the inbox message must be theirs). A rating of 0 removes it.
//
// POST { inboxId, rating: 1 | -1 | 0 }  → 200 { saved | removed }
const { getDb } = require('./lib/firestore.js');
const { withAuth, json } = require('./lib/auth.js');
const { recordFeedback } = require('./lib/golda-feedback.js');

exports.handler = withAuth({ action: 'read' }, async (event, ctx) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const user = ctx.auth.user;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const inboxId = String(body.inboxId || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
  const rating = [1, -1, 0].includes(Number(body.rating)) ? Number(body.rating) : null;
  if (!inboxId || rating === null) return json(400, { error: 'inboxId and rating (1, -1 or 0) are required' });
  const db = getDb();
  const snap = await db.collection('wa_inbox').doc(inboxId).get();
  if (!snap.exists) return json(404, { error: 'answer not found' });
  const inbox = { id: snap.id, ...snap.data() };
  if (String(inbox.email || '').toLowerCase() !== String(user.email || '').toLowerCase()) return json(403, { error: 'only the person who asked can rate this answer' });
  const r = await recordFeedback(db, {
    who: user.email, email: user.email, name: user.name, answerId: `app_${inboxId}`, inbox, rating,
    emoji: rating > 0 ? '👍' : rating < 0 ? '👎' : '', channel: 'app',
  });
  return json(200, r);
});
