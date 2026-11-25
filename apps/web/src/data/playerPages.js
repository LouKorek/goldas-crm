// Live player pages.
//
// Two users of this file:
//   The public page (/p/<token>, pages/PlayerPage.jsx): a club opens the link
//     the owner sent and sees one player's profile. No sign-in: the token in
//     the link is its key (netlify/functions/player-page.js).
//   The player's page in the CRM (components/player/PlayerLinks.jsx): the
//     links that exist for a player, who opened them, copy and revoke. That
//     goes through a signed-in function; the browser never reads the
//     player_pages collection itself.
import { auth } from 'lib/firebase';
import { callFunctionJson } from 'lib/api';

// ── the public page ─────────────────────────────────────────────────────────

/**
 * Someone signed in to the CRM in this browser is looking at their own link:
 * their sign-in goes along, and the server shows the page without counting an
 * opening. A club has no sign-in here, so nothing is sent and nothing waits.
 */
async function ownSignIn() {
  try {
    await Promise.race([auth.authStateReady(), new Promise((r) => setTimeout(r, 1500))]);
    return auth.currentUser ? { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` } : {};
  } catch { return {}; }
}

async function pageCall(token, action, headers = {}) {
  const res = await fetch('/.netlify/functions/player-page', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ t: token, action }),
    cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('unavailable'); e.status = res.status; throw e; }
  return data;
}

/** What the link shows: { lang, player, stats, contact, expiresAt, preview? }. Asking for it is what counts as an opening. */
export const loadPlayerPage = async (token) => pageCall(token, 'view', await ownSignIn());
/** The player's photo as a data: URL, or null when there is none. */
export const loadPlayerPhoto = (token) => pageCall(token, 'photo').then((r) => r.photo || null).catch(() => null);
/** The address the CV downloads from, under the same link. */
export const playerCvUrl = (token) => `/.netlify/functions/player-page?cv=1&t=${encodeURIComponent(token)}`;

// ── the CRM ─────────────────────────────────────────────────────────────────

/** A player's links, newest first: { links: [{ id, club, general, lang, state, createdAt, expiresAt, opens, lastOpenAt, openings, url }], canEdit }. */
export const listPlayerLinks = (playerId) => callFunctionJson('player-links', { query: { playerId } });
/** Stops a link at once → { link }. */
export const revokePlayerLink = (id) => callFunctionJson('player-links', { method: 'POST', body: { action: 'revoke', id } });
