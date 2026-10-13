// 009 — point two Ashdod players at their IFA squads.
//
// The browser sync of 13.10.2026 found no squad for Naveh Salant
// ("מ.ס. אשדוד · נוער על") and no club for Omri Shalom Takala
// ("מ.ס. אשדוד/ז'ילבר"), so neither has fixtures. The IFA says:
//   Naveh (player_id 226169): מ.ס. אשדוד, ליגת העל לנוער → team_id 1199
//   "מ.ס. אשדוד/ז'ילבר" is the IFA name of the club's נערים א' על squad
//   (מועדון ספורט אשדוד ז'ילבר) → team_id 1200; Omri (born 2010) is נערים א'.
// Lou approved on 13.10.2026. This writes the same autoFetch.ifa cache the
// sync itself writes, so the next run reads each team's games page directly.
// The import still runs its age/club plausibility check before linking.
const CLUB_RE = /אשדוד|ashdod/i;
const SEASON = '2026/2027';
const PLAYERS = [
  { key: 'naveh', nameRe: /salant|סלנט/i, playerId: '226169', teamId: '1199', teamName: 'מ.ס. אשדוד', ageGroup: 'נוער', league: 'ליגת העל לנוער' },
  { key: 'omri', nameRe: /takala|טקלה/i, playerId: null, teamId: '1200', teamName: 'מועדון ספורט אשדוד ז\'ילבר', ageGroup: 'נערים א', league: "נערים א' על" },
];

const id = '009-ashdod-squads';
const title = 'נווה סלנט ועומרי שלום טקלה: הצמדה לקבוצות מ.ס. אשדוד בהתאחדות';

const live = (p) => p && !p.deletedAt;
const playerIdOf = (p) => { try { return new URL(p.ifaTeamUrl || '').searchParams.get('player_id') || ''; } catch { return ''; } };

function planA(players) {
  const problems = [], skipped = [], writes = [], notes = [], pinned = [];
  for (const spec of PLAYERS) {
    const hits = players.filter((p) => live(p) && spec.nameRe.test(String(p.fullName || p.name || '')));
    if (hits.length !== 1) { problems.push(`${spec.key}: נמצאו ${hits.length} שחקנים שמתאימים לשם, צפוי 1`); continue; }
    const p = hits[0];
    const label = `${p.fullName || p.name} (${p.id})`;
    if (!CLUB_RE.test(String(p.currentClub || ''))) { problems.push(`${label}: currentClub הוא "${p.currentClub}", לא אשדוד`); continue; }
    const pid = playerIdOf(p);
    if (!pid) { problems.push(`${label}: ifaTeamUrl בלי player_id (${p.ifaTeamUrl || 'ריק'})`); continue; }
    if (spec.playerId && pid !== spec.playerId) { problems.push(`${label}: player_id בקישור הוא ${pid}, לא ${spec.playerId}`); continue; }
    const cur = p.autoFetch && p.autoFetch.ifa;
    if (cur && String(cur.teamId) === spec.teamId && cur.forClub === p.currentClub) { skipped.push({ id: p.id, reason: `כבר מוצמד לקבוצה ${spec.teamId}` }); continue; }
    writes.push(['players', p.id, {
      autoFetch: {
        ifa: { playerId: pid, teamId: spec.teamId, clubId: (cur && cur.clubId) || '', teamName: spec.teamName, ageGroup: spec.ageGroup, league: spec.league, seasonLabel: SEASON, forClub: p.currentClub, resolvedAt: new Date().toISOString(), via: `migration-${id.slice(0, 3)}` },
        ifaFail: null,
      },
      updatedAt: new Date().toISOString(),
    }, true]);
    pinned.push(p.id);
    notes.push(`${label}: ${p.currentClub} → ${spec.teamName} (${spec.league}, team ${spec.teamId})`);
  }
  return { problems, skipped, writes, notes, pinned };
}

async function plan(store) {
  const players = await store.load('players');
  const a = planA(players);
  if (a.problems.length) throw new Error(`לא שונה כלום. ${a.problems.join('; ')}`);
  const report = {
    summary: `${a.pinned.length} שחקנים הוצמדו לקבוצות מ.ס. אשדוד בהתאחדות; המשחקים יתקשרו בסנכרון הבא.${a.skipped.length ? ` ${a.skipped.length} דולגו.` : ''}`,
    counts: { pinned: a.pinned.length, skipped: a.skipped.length },
    pinned: a.pinned, skipped: a.skipped,
    notes: [...a.notes, ...a.skipped.map((s) => `${s.id} דולג: ${s.reason}`)],
  };
  return { report, writes: a.writes };
}

module.exports = { id, title, plan, _internal: { planA, PLAYERS } };
