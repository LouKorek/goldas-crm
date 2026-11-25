// Golda's three tools for live player pages (lib/player-pages.js).
//
//   live_page_create   a private link to one player's live page, for a named
//                      club (or a general one), for N days, in English or Hebrew
//   live_page_list     a player's links and who opened them, or every link
//                      that still works
//   live_page_revoke   stops a link at once
//
// The PDF sheet (player_pdf) stays the answer to "send me the player's page".
// A live page is made only when the writer asks for one in so many words, and
// the link goes to the writer alone: Golda never sends it to a club.
//
// Who may: making a link puts a player's profile on a public address, so it
// follows the website's rule and is an admin's to ask for (TOOL_ACTION in
// lib/wa-agent.js). Stopping a link needs the right to edit; seeing the links
// is open to everyone on the team, without the addresses for a viewer.
const { can, israelDate } = require('@goldas/domain');
const pages = require('./player-pages.js');

const PLAYER_PAGE_TOOL_DEFS = [
  { name: 'live_page_create', description: "Make a private LIVE web page of one represented player and get its link: the player's photo, key facts, video, this season's totals and a CV download, in the agency's design, with no sign-in. Use ONLY when the writer asks in so many words for a live page or a link to the player (\"דף חי\", \"לינק לשחקן\", \"live page\"); for \"דף שחקן\" / \"CV\" / \"PDF\" use player_pdf. One link per club, so the agency sees which club opened it: pass club when the writer named one, leave it out for a general link. days: how long the link works (14 when the writer named no period, 90 at most). lang: 'en' (default) or 'he' when asked for Hebrew. The link is returned to you: give it to the writer, who sends it on himself. You never send it to anyone else. Admin only.",
    input_schema: { type: 'object', properties: {
      playerId: { type: 'string', description: 'The id of the player in players, from search or list' },
      club: { type: 'string', description: 'The club the link is for, as the writer named it. Leave out for a general link' },
      days: { type: 'integer', description: 'How many days the link works: 1 to 90. Leave out when the writer named no period (14 days)' },
      lang: { type: 'string', enum: ['en', 'he'], description: "The page's language: en (default) or he" },
    }, required: ['playerId'], additionalProperties: false } },
  { name: 'live_page_list', description: "The live page links of one player (playerId), or with no playerId every link that still works: for each one the club, when it was made, until when it works (or that it expired or was stopped), how many times it was opened, the first and the last opening and whether from a phone or a computer. Use for \"מי פתח את הדף של…\", \"אילו לינקים פתוחים\".",
    input_schema: { type: 'object', properties: { playerId: { type: 'string' } }, additionalProperties: false } },
  { name: 'live_page_revoke', description: "Stop a live page link at once (\"תבטלי את הלינק של…\", \"תסגרי את הדף\"). linkId comes from live_page_list. The link stops working immediately and cannot be brought back; a new one can be made.",
    input_schema: { type: 'object', properties: { linkId: { type: 'string' } }, required: ['linkId'], additionalProperties: false } },
];

/** 2026-12-09 → 09/12/2026 */
const dayHe = (ms) => israelDate(new Date(ms)).split('-').reverse().join('/');

function playerPageTools({ db, admin, identity = {}, role, channel = 'whatsapp', now = () => Date.now() }) {
  const sender = identity.name || '';
  const audit = async (entry) => {
    if (!admin?.firestore?.FieldValue) return;
    await db.collection('audit').add({
      ...entry, collection: pages.COL,
      by: identity.email || '', byName: `${sender} (Golda)`.trim(), via: 'golda', channel, actor: 'golda', onBehalfOf: identity.email || '',
      sender, phone: identity.phone || '', at: admin.firestore.FieldValue.serverTimestamp(), undone: false,
    }).catch((e) => console.error('[golda-player-page] audit failed:', e.message));
  };
  // What the model sees of a link; the address itself only for someone who may edit.
  const line = (v) => ({
    linkId: v.id, player: v.playerName, playerId: v.playerId, for: v.general ? 'general link (no club named)' : v.club, lang: v.lang,
    state: v.state, created: v.createdAt, worksUntil: v.expiresAt, ...(v.revokedAt ? { stopped: v.revokedAt } : {}),
    opened: v.opens, firstOpened: v.firstOpenAt, lastOpened: v.lastOpenAt,
    lastOpenings: v.openings.slice(0, 5).map((o) => `${pages.whenHe(new Date(o.at).getTime())} (${o.device})`),
    ...(v.url ? { link: v.url } : {}),
  });

  return {
    live_page_create: async ({ playerId, club, days, lang } = {}) => {
      if (role !== 'admin') throw new Error(`${sender || 'the writer'} is a ${role} and may not make a live page: only an admin can. The PDF sheet (player_pdf) is open to everyone`);
      const snap = await db.collection('players').doc(String(playerId || '')).get();
      if (!snap.exists || snap.data().deletedAt) throw new Error('player not found');
      const made = await pages.createLink(db, {
        player: { id: snap.id, ...snap.data() }, club, days, lang,
        by: { email: identity.email || '', name: sender, channel }, now: now(),
      });
      await audit({
        action: 'create', docId: made.id, name: snap.data().fullName || '',
        summary: `Live page link: ${snap.data().fullName || ''}${made.club ? ` · ${made.club}` : ' · general'} · ${made.days} days · ${made.lang}`,
        fields: ['club', 'days', 'lang'], note: 'live page link',
      });
      return {
        made: true, linkId: made.id, link: made.url,
        for: made.general ? 'general link (no club named)' : made.club, lang: made.lang,
        days: made.days, worksUntil: dayHe(made.expiresAt),
        ...(made.clamped ? { note: `The writer asked for more than ${pages.MAX_DAYS} days; a link works ${pages.MAX_DAYS} days at most, so this one does. Say so.` } : {}),
        ...(made.defaulted ? { defaulted: `No period was named, so it works ${pages.DEFAULT_DAYS} days.` } : {}),
        instruction: 'Give the writer the link on its own line, say for whom it is and until when it works, and that you will tell him the first time it is opened. Add one short line: opening it in a browser where he is signed in to the CRM is a preview and is not counted; any other opening is. The writer sends the link on himself: you never send it to anyone else.',
      };
    },

    live_page_list: async ({ playerId } = {}) => {
      const editor = can(role, 'edit');
      if (playerId) {
        const links = await pages.listLinks(db, String(playerId), { now: now(), withUrl: editor });
        return { count: links.length, links: links.map(line) };
      }
      // Every link that still works: links are few (made one at a time, on request).
      const docs = (await db.collection(pages.COL).where('revokedAt', '==', null).get()).docs;
      const live = docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => pages.stateOf(l, now()) === 'active')
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40);
      return { count: live.length, links: live.map((l) => line(pages.viewOf(l, { now: now(), withUrl: editor }))) };
    },

    live_page_revoke: async ({ linkId } = {}) => {
      if (!can(role, 'edit')) throw new Error(`${sender || 'the writer'} is a ${role} and may not stop a link`);
      const was = await pages.revokeLink(db, String(linkId || ''), { by: { email: identity.email || '' }, now: now() });
      if (!was) throw new Error('link not found; take linkId from live_page_list');
      if (was.revokedAt) return { stopped: true, already: true, player: was.playerName, for: was.club || 'general link' };
      await audit({
        action: 'update', docId: was.id, name: was.playerName || '',
        summary: `Live page link revoked: ${was.playerName || ''}${was.club ? ` · ${was.club}` : ' · general'}`, fields: ['revokedAt'], note: 'live page link revoked',
      });
      return { stopped: true, player: was.playerName, for: was.club || 'general link', opened: Number(was.opens) || 0, note: 'The link no longer works for anyone.' };
    },
  };
}

module.exports = { playerPageTools, PLAYER_PAGE_TOOL_DEFS };
