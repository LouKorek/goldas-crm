// 001 — one `players` collection. Every represented player gets
// stage 'represented', a category and a `name`; every candidate in the four
// pipeline_* collections is copied into `players` under the same id with
// stage (from its status), category, name and a `legacy` pointer. The old
// documents stay where they are, marked migratedAt, until the model is
// proven; nothing is deleted.
const { stageFromStatus, categoryFromPlayer, playerName, LEGACY_PIPELINE_COLLECTIONS } = require('@goldas/domain');

const id = '001-unify-players';
const title = 'שחקנים ומועמדים באוסף אחד';

async function plan(store) {
  const players = await store.load('players');
  const byId = new Map(players.map((p) => [p.id, p]));
  const notes = [];
  const writes = [];
  let tagged = 0;
  for (const p of players) {
    if (p.stage || p.legacy) continue;
    writes.push(['players', p.id, {
      stage: 'represented', category: categoryFromPlayer(p), name: playerName(p) || p.id,
      deletedAt: p.deletedAt ?? null, migratedAt: store.now(),
    }]);
    tagged += 1;
  }
  const moved = {};
  for (const [category, col] of Object.entries(LEGACY_PIPELINE_COLLECTIONS)) {
    const docs = await store.load(col);
    moved[category] = 0;
    for (const d of docs) {
      if (d.migratedAt) continue;
      const { id: legacyId, ...data } = d;
      let targetId = legacyId;
      const clash = byId.get(targetId);
      if (clash && !(clash.legacy && clash.legacy.collection === col && clash.legacy.id === legacyId)) {
        targetId = `${category}_${legacyId}`;
        notes.push(`${col}/${legacyId}: id already used by a player, copied as ${targetId}`);
      }
      writes.push(['players', targetId, {
        ...data,
        name: playerName(data) || legacyId,
        stage: stageFromStatus(data.status),
        category,
        source: data.source || 'migration',
        legacy: { collection: col, id: legacyId },
        deletedAt: data.deletedAt ?? null,
        migratedAt: store.now(),
      }, false]);
      writes.push([col, legacyId, { migratedAt: store.now(), migratedTo: `players/${targetId}` }]);
      moved[category] += 1;
    }
  }
  const total = Object.values(moved).reduce((a, b) => a + b, 0);
  const report = {
    summary: `${tagged} שחקנים מיוצגים יסומנו, ${total} מועמדים יועתקו ל-players (גברים ${moved.men}, נשים ${moved.women}, נוער ${moved.youth}, יהודים בחו"ל ${moved.jewish}). האוספים הישנים נשארים כגיבוי.`,
    counts: { tagged, moved, writes: writes.length },
    notes,
  };
  return { report, writes };
}

module.exports = { id, title, plan };
