// 002 — clubs as records. Every club name found in the data (players'
// current, linked and previous clubs, requirements, contacts, match teams) is
// folded with clubKey(); one `clubs` document is created per key, with the
// spellings as aliases, and the records that named it get a clubId.
const { clubKey, preferName, isYouthName, isWomenName } = require('@goldas/domain');

const id = '002-clubs';
const title = 'מועדונים כרשומות (עם מיזוג כתיבים)';

const str = (v) => String(v || '').trim();

async function plan(store) {
  const [players, reqs, contacts, matches, clubs] = await Promise.all(
    ['players', 'club_requirements', 'contacts', 'matches', 'clubs'].map((c) => store.load(c)),
  );
  // key → { variants: Map<name, count>, refs }
  const groups = new Map();
  const note = (name) => {
    const n = str(name); const key = clubKey(n);
    if (!key) return '';
    if (!groups.has(key)) groups.set(key, { variants: new Map(), refs: 0 });
    const g = groups.get(key);
    g.variants.set(n, (g.variants.get(n) || 0) + 1);
    g.refs += 1;
    return key;
  };
  const playerKeys = new Map();
  for (const p of players) {
    if (p.deletedAt) continue;
    playerKeys.set(p.id, note(p.currentClub));
    for (const c of p.linkedClubs || []) note(c.clubName);
    for (const c of p.previousClubs || []) note(c.clubName);
  }
  for (const r of reqs) if (!r.deletedAt) note(r.clubName);
  for (const c of contacts) if (!c.deletedAt) note(c.clubName);
  for (const m of matches) if (!m.deletedAt) { note(m.homeTeam); note(m.awayTeam); }

  const existing = new Map(clubs.map((c) => [c.key, c]));
  const writes = [];
  const idByKey = new Map();
  const merged = [];
  let created = 0;
  for (const [key, g] of groups) {
    const names = [...g.variants.keys()];
    const name = names.reduce((a, b) => preferName(a, b));
    const aliases = names.filter((n) => n !== name);
    const cur = existing.get(key);
    if (cur) {
      idByKey.set(key, cur.id);
      const add = aliases.filter((a) => a !== cur.name && !(cur.aliases || []).includes(a));
      if (add.length) writes.push(['clubs', cur.id, { aliases: [...(cur.aliases || []), ...add] }]);
    } else {
      const docId = `c_${key.replace(/[^a-z0-9֐-׿]+/gi, '_').slice(0, 60)}`;
      idByKey.set(key, docId);
      writes.push(['clubs', docId, {
        name, key, aliases, country: 'Israel', leagueTier: '', logoUrl: '', notes: '',
        youth: isYouthName(name), women: isWomenName(name),
        source: 'migration', createdAt: store.now(), deletedAt: null,
      }, false]);
      created += 1;
    }
    if (names.length > 1) merged.push({ key, name, variants: names, count: g.refs });
  }
  for (const p of players) {
    const key = playerKeys.get(p.id);
    if (key && idByKey.get(key) && p.currentClubId !== idByKey.get(key)) writes.push(['players', p.id, { currentClubId: idByKey.get(key) }]);
  }
  for (const r of reqs) { const k = clubKey(r.clubName); if (k && idByKey.get(k) && r.clubId !== idByKey.get(k)) writes.push(['club_requirements', r.id, { clubId: idByKey.get(k) }]); }
  for (const c of contacts) { const k = clubKey(c.clubName); if (k && idByKey.get(k) && c.clubId !== idByKey.get(k)) writes.push(['contacts', c.id, { clubId: idByKey.get(k) }]); }

  merged.sort((a, b) => b.count - a.count);
  const report = {
    summary: `${groups.size} מועדונים זוהו בנתונים, ${created} חדשים ייווצרו (${existing.size} כבר קיימים). ${merged.length} מועדונים נכתבו ביותר מכתיב אחד ויאוחדו.`,
    counts: { found: groups.size, created, existing: existing.size, merged: merged.length, writes: writes.length },
    groups: merged,
    notes: [],
  };
  return { report, writes };
}

module.exports = { id, title, plan };
