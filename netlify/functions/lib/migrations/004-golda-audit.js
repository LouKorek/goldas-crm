// 004 — one audit log. Golda's old wa_audit lines move into `audit`, marked
// via: 'golda', so the Golda screen and Home show her whole history in one
// place and the old collection can be left alone. Idempotent: a line that
// was already copied (same id) is skipped. Legacy lines were all written in
// the owner's name, which is what they say.
const { OWNER_EMAIL } = require('../firestore.js');

const id = '004-golda-audit';
const title = 'יומן הפעולות של גולדה מצטרף ליומן המערכת';

async function plan(store) {
  const [legacy, audit] = await Promise.all([store.load('wa_audit'), store.load('audit')]);
  const have = new Set(audit.map((a) => a.id));
  const writes = [];
  let skipped = 0;
  for (const a of legacy) {
    const docId = `wa_${a.id}`;
    if (have.has(docId)) { skipped += 1; continue; }
    writes.push(['audit', docId, {
      action: a.action || 'update', collection: a.collection || '', docId: a.docId || '',
      before: a.before === undefined ? null : a.before, after: a.after === undefined ? null : a.after,
      fields: Object.keys(a.after || a.before || {}).slice(0, 50),
      by: OWNER_EMAIL, byName: `${a.sender || 'לו'} (גולדה)`, via: 'golda', channel: 'whatsapp', actor: 'golda',
      onBehalfOf: a.sender && a.sender !== 'לו' ? '' : OWNER_EMAIL, sender: a.sender || 'לו', phone: a.phone || '',
      at: a.at || store.serverNow(), undone: !!a.undone, undoneAt: a.undoneAt || null, legacy: true,
    }, false]);
  }
  const report = {
    summary: `${writes.length} פעולות של גולדה יועתקו ליומן המערכת${skipped ? ` (${skipped} כבר שם)` : ''}.`,
    counts: { copied: writes.length, skipped },
    notes: [],
  };
  return { report, writes };
}

module.exports = { id, title, plan };
