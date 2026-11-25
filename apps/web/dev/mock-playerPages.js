// Harness stand-in for data/playerPages: the public live player page and the
// "Live links" card, with no backend.
//
// The public page, as a club sees it:  /dev/app.html?path=/p/<token>
//   demo           English, photo, YouTube video, this season's totals
//   demo-he        the same in Hebrew (right to left)
//   demo-bare      a thin record: no photo, no video, no totals, a free agent
//   demo-vimeo     a video that is not on YouTube (a button, not a player)
//   demo-preview   the owner's own look (the "not counted" note)
//   gone           a link that no longer works
//   broken         the server did not answer
//
// The card, on a player's page:  /dev/app.html?path=/players/p1
//   p1 has four links (opened, not opened yet, expired, revoked); p3 has one;
//   the other players have none, so the card is not there.
//   &role=viewer in the address shows it as someone who may not edit.
const H = 3600e3, D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

// A stand-in portrait, drawn here so the harness needs no picture of a real person.
const PORTRAIT = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6f58"/><stop offset="1" stop-color="#0b2a20"/></linearGradient></defs><rect width="400" height="500" fill="url(#g)"/><circle cx="200" cy="170" r="72" fill="#d9c8a9"/><path d="M60 500c0-110 62-180 140-180s140 70 140 180z" fill="#f4f0e6"/><path d="M150 330l50 60 50-60" fill="none" stroke="#c9a227" stroke-width="10"/></svg>`)}`;

const CONTACT = { site: 'gold-as.com', url: 'https://gold-as.com', agent: { en: 'Lou Korek', he: 'לו קורק' }, title: { en: 'FIFA Licensed Agent', he: 'סוכן מורשה FIFA' } };
const FULL = {
  name: 'Noam Barzilay', age: 19, birthYear: 2007, position: 'LB', otherPositions: ['CB', 'LWB'], foot: 'Left', heightCm: 184,
  nationalities: ['Israel', 'Germany'], club: 'Hapoel Haifa', league: 'Israel 1', nationalTeam: { country: 'Israel', former: false, youth: true },
  video: { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', youtubeId: 'aqz-KE-bpKQ' },
  profile: { url: 'https://www.transfermarkt.com/noam-barzilay/profil/spieler/1', transfermarkt: true }, photo: true,
};
const STATS = { season: '2026/27', totals: { games: 11, starts: 9, minutes: 842, goals: 2, assists: 4, yellow: 1 } };
const PAGES = {
  demo: { lang: 'en', player: FULL, stats: STATS },
  'demo-he': { lang: 'he', player: { ...FULL, name: 'נועם ברזילי', club: 'הפועל חיפה' }, stats: STATS },
  'demo-bare': { lang: 'en', player: { name: 'Daniel de la Cruz Santamaria', age: 27, birthYear: 1999, position: 'ST', nationalities: ['Spain'], freeAgent: true, photo: false }, stats: null },
  'demo-vimeo': { lang: 'en', player: { ...FULL, photo: false, video: { url: 'https://vimeo.com/76979871', youtubeId: null }, profile: { url: 'https://example.com/profile', transfermarkt: false } }, stats: null },
  'demo-preview': { lang: 'en', player: FULL, stats: STATS, preview: true },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadPlayerPage(token) {
  await wait(250);
  if (token === 'broken') throw Object.assign(new Error('unavailable'), { status: 500 });
  const page = PAGES[token];
  if (!page) throw Object.assign(new Error('unavailable'), { status: 404 });
  return { ...page, contact: CONTACT, expiresAt: iso(now + 9 * D) };
}
export const loadPlayerPhoto = async (token) => { await wait(200); return PAGES[token]?.player?.photo ? PORTRAIT : null; };
export const playerCvUrl = () => '#cv';

const link = (id, o) => ({
  id, playerId: 'p1', playerName: 'שחקן מיוצג 1', club: '', general: false, lang: 'en', state: 'active',
  createdAt: iso(now - 5 * D), expiresAt: iso(now + 9 * D), revokedAt: null, days: 14, createdByName: 'לו קורק',
  opens: 0, firstOpenAt: null, lastOpenAt: null, openings: [], url: `${location.origin}/dev/app.html?path=/p/demo`, ...o,
});
const LINKS = {
  p1: [
    link('a', { club: 'Hertha BSC', opens: 3, firstOpenAt: iso(now - 4 * D), lastOpenAt: iso(now - 3 * H), openings: [{ at: iso(now - 3 * H), device: 'phone' }, { at: iso(now - 2 * D), device: 'desktop' }, { at: iso(now - 4 * D), device: 'desktop' }] }),
    link('b', { general: true, lang: 'he', createdAt: iso(now - 1 * D), expiresAt: iso(now + 29 * D), days: 30, url: `${location.origin}/dev/app.html?path=/p/demo-he` }),
    link('c', { club: 'Royal Antwerp Football Club', state: 'expired', createdAt: iso(now - 40 * D), expiresAt: iso(now - 26 * D), opens: 1, firstOpenAt: iso(now - 38 * D), lastOpenAt: iso(now - 38 * D), openings: [{ at: iso(now - 38 * D), device: 'desktop' }], url: null }),
    link('d', { club: 'מכבי חיפה', lang: 'he', state: 'revoked', createdAt: iso(now - 12 * D), expiresAt: iso(now + 2 * D), revokedAt: iso(now - 10 * D), url: null }),
  ],
  p3: [link('e', { playerId: 'p3', club: 'Ajax', opens: 1, firstOpenAt: iso(now - 26 * H), lastOpenAt: iso(now - 26 * H), openings: [{ at: iso(now - 26 * H), device: 'phone' }] })],
};
const viewer = new URLSearchParams(location.search).get('role') === 'viewer';
export const listPlayerLinks = async (playerId) => {
  await wait(120);
  const rows = (LINKS[playerId] || []).map((l) => (viewer ? { ...l, url: null } : l));
  return { links: rows, canEdit: !viewer };
};
export const revokePlayerLink = async (id) => {
  await wait(200);
  for (const rows of Object.values(LINKS)) {
    const l = rows.find((x) => x.id === id);
    if (l) { Object.assign(l, { state: 'revoked', revokedAt: iso(Date.now()), url: null }); return { link: { ...l } }; }
  }
  throw new Error('not found');
};
