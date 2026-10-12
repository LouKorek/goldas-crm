// 003 — deals from the candidates' linked clubs. One `deals` document per
// candidate × linked club at the candidate's status, plus a closed
// 'Not Relevant' deal for every club they were marked not relevant for, so
// the history Lou kept in the pipeline is not lost. Idempotent: a deal that
// already exists for that pair is left alone.
const { clubKey, isDealStage, playerName } = require('@goldas/domain');

const id = '003-deals';
const title = 'עסקאות מהמועדונים המקושרים של המועמדים';

const dealId = (playerId, key) => `${playerId}__${key.replace(/[^a-z0-9֐-׿]+/gi, '_').slice(0, 60)}`;

async function plan(store) {
  const [players, clubs, deals] = await Promise.all(['players', 'clubs', 'deals'].map((c) => store.load(c)));
  const clubIdByKey = new Map(clubs.map((c) => [c.key, c.id]));
  const have = new Set(deals.map((d) => d.id));
  const writes = [];
  let open = 0, closed = 0, skipped = 0;
  for (const p of players) {
    if (p.deletedAt || p.stage === 'represented' || (!p.stage && !p.legacy)) continue;
    const stage = isDealStage(p.status) ? p.status : 'Not Contacted';
    const seen = new Set();
    const add = (c, st, closedAt) => {
      const key = clubKey(c && c.clubName);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const docId = dealId(p.id, key);
      if (have.has(docId)) { skipped += 1; return; }
      const at = c.linkedAt || c.markedAt || p.createdAt?.toDate?.()?.toISOString?.() || store.now();
      writes.push(['deals', docId, {
        playerId: p.id, playerName: playerName(p), category: p.category || 'men',
        clubId: clubIdByKey.get(key) || '', clubName: String(c.clubName).trim(), clubKey: key,
        stage: st, history: [{ stage: st, at, by: 'migration', note: 'נוצר מהמועדונים המקושרים' }],
        enteredStageAt: at, openedAt: at,
        transferFee: p.transferFee || '', salary: p.salary || '', owner: '', notes: '',
        source: 'migration', closedAt, deletedAt: null, createdAt: store.now(),
      }, false]);
      if (closedAt) closed += 1; else open += 1;
    };
    const closing = stage === 'Not Relevant' || stage === 'Contract Signed';
    for (const c of p.linkedClubs || []) add(c, stage, closing ? store.now() : null);
    for (const c of p.previousClubs || []) add(c, 'Not Relevant', c.markedAt || store.now());
  }
  const report = {
    summary: `${open} עסקאות פתוחות ו-${closed} סגורות ייווצרו מהמועדונים המקושרים${skipped ? ` (${skipped} כבר קיימות)` : ''}.`,
    counts: { open, closed, skipped, writes: writes.length },
    notes: [],
  };
  return { report, writes };
}

module.exports = { id, title, plan };
