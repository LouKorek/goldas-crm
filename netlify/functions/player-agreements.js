// Representation agreements, for the CRM's own screens: the "Representation
// agreement" card on the player page and System › Agreements. The browser
// never reads the agreement collections itself (lib/agreements.js).
//
//   GET  ?playerId=<id>     → { agreements, canCreate, templates: { he, en } }     anyone signed in
//   GET  ?templates=1       → { he, en, signature: { has, name, savedAt } }       admins
//   POST { action: 'create', playerId, lang, start, end?, months?, guardianName?, minor?, days? }  admins (a minor's: the guardian and the player both sign)
//   POST { action: 'revoke' | 'reissue' | 'retry', id, days? }                      admins
//   POST { action: 'template_save', lang, text, defaultMonths, maxMonths, agencyName }   admins
//   POST { action: 'signature_save', png } | { action: 'signature_clear' }        admins (their own signature)
//
// Everyone who may see the player sees the agreements and their states; the
// link's address goes only to admins. Neither the ID numbers the signers
// typed nor their drawn signatures ever leave through here.
const { withAuth, json } = require('./lib/auth.js');
const { getDb, admin } = require('./lib/firestore.js');
const { can } = require('@goldas/domain');
const { originOf } = require('./lib/site.js');
const agreements = require('./lib/agreements.js');

const ID = /^[A-Za-z0-9_-]{1,80}$/;

async function audit(db, user, { docId, name, summary, fields }) {
  await db.collection('audit').add({
    action: 'update', collection: agreements.COL, docId, name: name || '', summary, fields,
    by: user.email, byName: user.name, via: 'web', at: admin.firestore.FieldValue.serverTimestamp(), undone: false,
  }).catch((e) => console.error('[player-agreements] audit failed:', e.message));
}

async function hasTemplates(db) {
  const [he, en] = await Promise.all([agreements.getTemplate(db, 'he'), agreements.getTemplate(db, 'en')]);
  // Which languages can be used, with their period settings (the dialog's defaults); never the text.
  const brief = (t) => (t ? { version: t.version || 1, ...agreements.periodSettings(t) } : null);
  return { he: brief(he), en: brief(en) };
}

async function handle(event, ctx, deps = {}) {
  const db = deps.db || getDb();
  const now = deps.now || Date.now();
  const user = ctx.auth.user;
  const isAdmin = !!user && can(user.role, 'manage_settings');
  const base = originOf(event);

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.templates === '1') {
      if (!isAdmin) return json(403, { error: 'Forbidden' });
      const [he, en, sig] = await Promise.all([agreements.templateView(db, 'he'), agreements.templateView(db, 'en'), agreements.getSignature(db, user.email)]);
      return json(200, { he, en, signature: { has: !!sig, name: sig?.name || '', savedAt: sig?.savedAt ? new Date(sig.savedAt).toISOString() : null, png: sig?.png || null } });
    }
    const playerId = String(q.playerId || '');
    if (!ID.test(playerId)) return json(400, { error: 'bad request' });
    const [list, templates] = await Promise.all([agreements.listAgreements(db, playerId, { now, withUrl: isAdmin, base }), hasTemplates(db)]);
    return json(200, { agreements: list, canCreate: isAdmin, templates });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad request' }); }
  if (!body || typeof body.action !== 'string') return json(400, { error: 'bad request' });
  if (!isAdmin) return json(403, { error: 'Forbidden' });

  try {
    switch (body.action) {
      case 'create': {
        const r = await agreements.createAgreement(db, {
          playerId: body.playerId, lang: body.lang, start: body.start, end: body.end, months: body.months,
          guardianName: body.guardianName, minor: body.minor, days: body.days,
          by: { email: user.email, name: user.name, channel: 'web' }, now, base,
        });
        await audit(db, user, { docId: r.id, name: r.summary.player, summary: `Representation agreement made: ${r.summary.player} · ${r.summary.start} → ${r.summary.end}`, fields: ['created'] });
        return json(200, { agreement: { ...r.view, url: r.url }, summary: r.summary, days: r.days, clamped: r.clamped });
      }
      case 'revoke': {
        const a = await agreements.revokeLink(db, body.id, { now });
        if (!a) return json(404, { error: 'not found' });
        if (!a.link.revokedAt) await audit(db, user, { docId: a.id, name: a.playerName, summary: `Agreement link revoked: ${a.playerName || ''}`, fields: ['link'] });
        const fresh = await db.collection(agreements.COL).doc(a.id).get();
        return json(200, { agreement: agreements.viewOf({ id: a.id, ...fresh.data() }, { now }) });
      }
      case 'reissue': {
        const r = await agreements.reissueLink(db, body.id, { days: body.days, now, base });
        if (!r) return json(404, { error: 'not found' });
        await audit(db, user, { docId: r.agreement.id, name: r.agreement.playerName, summary: `New agreement link: ${r.agreement.playerName || ''} (${r.days} days)`, fields: ['link'] });
        const fresh = await db.collection(agreements.COL).doc(r.agreement.id).get();
        return json(200, { agreement: agreements.viewOf({ id: r.agreement.id, ...fresh.data() }, { now, withUrl: true, base }), days: r.days, clamped: r.clamped });
      }
      case 'retry': {
        const r = await agreements.fileAgreement(db, String(body.id || ''), { now, makePdf: deps.makePdf, FieldValue: admin.firestore.FieldValue });
        const fresh = await db.collection(agreements.COL).doc(String(body.id || '-')).get();
        if (!fresh.exists) return json(404, { error: 'not found' });
        return json(200, { filed: !!r.filed, agreement: agreements.viewOf({ id: fresh.id, ...fresh.data() }, { now }) });
      }
      case 'template_save': {
        const r = await agreements.saveTemplate(db, { lang: body.lang, text: body.text, defaultMonths: body.defaultMonths, maxMonths: body.maxMonths, agencyName: body.agencyName, by: user, now });
        await audit(db, user, { docId: `template_${body.lang}`, name: `template ${body.lang}`, summary: `Agreement template saved (${body.lang}, version ${r.version})`, fields: ['text'] });
        return json(200, { saved: true, ...r, template: await agreements.templateView(db, body.lang) });
      }
      case 'signature_save': {
        const r = await agreements.saveSignature(db, { email: user.email, name: user.name, png: body.png, now });
        return json(200, r);
      }
      case 'signature_clear':
        return json(200, await agreements.clearSignature(db, user.email));
      default:
        return json(400, { error: 'bad request' });
    }
  } catch (e) {
    if (e instanceof agreements.AgreementError) return json(400, { error: e.code, message: e.message });
    throw e;
  }
}

exports.handler = withAuth({ action: 'read' }, (event, ctx) => handle(event, ctx));
exports._handle = handle;
