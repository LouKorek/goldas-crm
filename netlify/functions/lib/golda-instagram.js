// Branded Instagram graphics through Golda: a player's signing, a goal, a
// birthday, or a free headline ("first call-up", "player of the month").
//
// 1. She makes one. The writer asks ("תכיני גרפיקה לחתימה של X במכבי",
//    "story לשער של Z מול הפועל"); the agent finds the player and calls
//    instagram_graphic. The picture is drawn on the server (lib/golda-graphic.js)
//    from the player's own photo in the CRM, or as a card of words when he has
//    none, and goes into the answer's files with its ready caption. The worker
//    sends the picture as an image and the caption as its own message, so it can
//    be copied; in the app chat both show on the answer (lib/golda-worker.js,
//    the Golda screen). Like every file she makes, it is stored in files/{id}
//    and the chat's history keeps only the reference: never the picture itself.
//    Permission: whoever may edit the player.
// 2. She offers one. In the owner's hourly block (golda-briefing.js), when
//    nothing else of hers went out that hour: a represented player's birthday
//    today, or a goal of a represented player in yesterday's match data. One
//    message per hour, at most OFFERS_PER_DAY a day, each event once
//    (state.offered), with two buttons. Never the picture itself: his yes is
//    his next message, and the agent then makes it.
// Golda never posts anywhere and never sends the picture to anyone but the
// person who asked; he uploads it himself.
// State: app_meta/goldaGraphicOffers { offered: { key: 'YYYY-MM-DD' }, day, sentToday }.
const { can, israelDate, daysBetween, playerName, addDays } = require('@goldas/domain');
const { chatOf, nudge } = require('./golda-nudge.js');
const { awaitsAnswer } = require('./golda-effort.js');
const graphic = require('./golda-graphic.js');
const { graphicEvents, buildGraphicOffer } = require('./golda-proactive.js');

const META = ['app_meta', 'goldaGraphicOffers'];
const FROM_HOUR = 10;            // Israel time: after the morning questions
const TO_HOUR = 20;
const OFFERS_PER_DAY = 3;
const KEEP_OFFERED_DAYS = 400;   // a birthday key carries its year
const WAIT_FOR_ANSWER_MS = 2 * 3600000;
const GOAL_LOOKBACK_DAYS = 7;
const MAX_GRAPHICS = 2;          // per answer (the post and the story)
const CAPTION_MAX = 1200;

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const squash = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isImage = (m) => !!m && /^image\/(jpeg|png|webp)$/.test(m.mimeType || '') && !!m.buffer?.length;

const INSTAGRAM_TOOL_DEF = {
  name: 'instagram_graphic',
  description: "Make a branded Instagram picture in the Gold A&S colours for a player, with a ready caption, and hand both to the writer (never posted, never sent to anyone else; the writer uploads it himself). kind: signing (club; defaults to his current club in the CRM), goal (opponent required unless his goal is in the CRM's match data of the last week; score, minute and competition only when the writer said them), birthday (the age comes from his date of birth), custom (headline: one short line such as \"זימון ראשון לנבחרת\" / \"Player of the month\"). size post (1080x1350, default) or story (1080x1920). lang he (default) or en. Uses the player's photo from the CRM, or the photo sent with this message when there is one (photo=none: a card of words). The caption is written from the facts; pass caption only when the writer dictated wording or asked to change it. The picture and the caption go out right after your answer as two messages; your text is one short line.",
  input_schema: {
    type: 'object',
    properties: {
      playerId: { type: 'string' },
      kind: { type: 'string', enum: graphic.KINDS },
      size: { type: 'string', enum: ['post', 'story'] },
      lang: { type: 'string', enum: ['he', 'en'] },
      club: { type: 'string', description: 'signing: the club he signed for, as the writer said it' },
      opponent: { type: 'string', description: 'goal: the team he scored against' },
      score: { type: 'string', description: 'goal: the final score as the writer said it, e.g. "2-1"' },
      minute: { type: 'string', description: 'goal: the minute, digits' },
      competition: { type: 'string', description: 'goal: the league or cup, when said' },
      goals: { type: 'integer', description: 'goal: how many he scored in the match (default: from the match data, else 1)' },
      headline: { type: 'string', description: 'custom: the one-line headline; with another kind it replaces the small gold line' },
      name: { type: 'string', description: 'Only when the writer wants the name spelled differently from the CRM' },
      photo: { type: 'string', enum: ['auto', 'attached', 'none'], description: 'auto (default): the photo sent with this message, else his photo in the CRM, else a card of words' },
      caption: { type: 'string', description: 'Only to replace the caption with the writer\'s own words' },
    },
    required: ['playerId', 'kind'], additionalProperties: false,
  },
};

/** A stored CRM file (files/{id} + chunks, or an old inline data: URL) as bytes; null when it cannot be read. */
async function readStoredFile(db, ref) {
  try {
    let dataUrl = ref && ref.url ? String(ref.url) : '';
    if (!dataUrl && ref && ref.fileId) {
      const meta = await db.collection('files').doc(ref.fileId).get();
      if (!meta.exists) return null;
      const parts = meta.data().parts || 0;
      if (!parts || (meta.data().size || 0) > 15 * 1024 * 1024) return null;
      const chunks = await Promise.all(Array.from({ length: parts }, (_, i) => db.collection('files').doc(ref.fileId).collection('chunks').doc(String(i)).get()));
      if (chunks.some((c) => !c.exists)) return null;
      dataUrl = chunks.map((c) => c.data().data).join('');
    }
    const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(dataUrl);
    return m ? { bytes: Buffer.from(m[2], 'base64'), type: (m[1] || '').toLowerCase() } : null;
  } catch { return null; }
}

/** The player's latest goal in the match data of the last week: { match, goals, opponent? }. */
async function recentGoal(db, player, today) {
  const snap = await db.collection('matches').where('linkedPlayers', 'array-contains', player.id).get().catch(() => ({ docs: [] }));
  const from = addDays(today, -GOAL_LOOKBACK_DAYS);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => !m.deletedAt && m.date >= from && m.date <= today && Number(m.playerStats?.[player.id]?.goals) > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!rows.length) return null;
  const m = rows[0];
  const club = norm(player.currentClub);
  const home = norm(m.homeTeam), away = norm(m.awayTeam);
  const ours = club && (home.includes(club) || club.includes(home)) ? 'home' : club && (away.includes(club) || club.includes(away)) ? 'away' : null;
  return { match: { id: m.id, date: m.date, homeTeam: m.homeTeam || '', awayTeam: m.awayTeam || '' }, goals: Number(m.playerStats[player.id].goals) || 1,
    opponent: ours === 'home' ? m.awayTeam : ours === 'away' ? m.homeTeam : null };
}

/**
 * instagramTools({ db, identity, role, media, state, now })
 *   state  wa-agent's per-answer state: the picture goes into state.outFiles.
 */
function instagramTools({ db, identity = {}, role, media = null, state = { outFiles: [] }, now = () => new Date(), render = graphic.renderGraphic }) {
  async function make(input = {}) {
    if (!can(role, 'edit')) throw new Error(`${identity.name || 'the writer'} may not make graphics for players (it needs edit permission)`);
    const kind = input.kind;
    if (!graphic.KINDS.includes(kind)) throw new Error(`kind must be one of: ${graphic.KINDS.join(', ')}`);
    const size = input.size || 'post';
    if (!graphic.SIZES[size]) throw new Error('size must be post or story');
    const lang = input.lang === 'en' ? 'en' : 'he';
    if ((state.outFiles || []).filter((f) => f.graphic).length >= MAX_GRAPHICS || (state.outFiles || []).length >= 3) throw new Error('at most two graphics per answer');

    const snap = await db.collection('players').doc(String(input.playerId || '')).get();
    if (!snap.exists || snap.data().deletedAt) throw new Error('player not found; find him with search first');
    const p = { id: snap.id, ...snap.data() };
    const today = israelDate(now());
    const facts = { kind, lang, name: squash(input.name, 80) || playerName(p), female: p.gender === 'Women', headline: squash(input.headline, 60) };
    const from = {};
    if (kind === 'signing') {
      facts.club = squash(input.club, 60) || squash(p.currentClub, 60);
      if (!facts.club) throw new Error('which club did he sign for? ask the writer (the CRM has no current club for him)');
      from.club = input.club ? 'the writer' : 'his current club in the CRM';
    } else if (kind === 'goal') {
      const g = input.opponent ? null : await recentGoal(db, p, today);
      facts.opponent = squash(input.opponent, 60) || squash(g?.opponent, 60);
      if (!facts.opponent) {
        throw new Error(g ? `against whom did he score: ${g.match.homeTeam} or ${g.match.awayTeam}? ask the writer in one short question` : 'against whom did he score? ask the writer in one short question');
      }
      facts.goals = Math.max(1, Math.min(9, Number(input.goals) || g?.goals || 1));
      facts.score = squash(input.score, 12);
      facts.minute = squash(String(input.minute ?? '').replace(/[^\d+]/g, ''), 6);
      facts.competition = squash(input.competition, 40);
      if (g) from.match = `${g.match.homeTeam} – ${g.match.awayTeam} on ${g.match.date} (the CRM's match data)`;
    } else if (kind === 'birthday') {
      facts.age = graphic.ageOn(p.dob, today);
      from.age = facts.age ? 'his date of birth in the CRM' : 'unknown: no date of birth in the CRM, so the picture has no age';
    } else {
      if (!facts.headline) throw new Error('a custom graphic needs a headline: ask the writer for the one line');
      facts.club = squash(input.club, 60) || squash(p.currentClub, 60);
    }

    // The picture: the one sent now, else his first photo in the CRM, else none.
    let photo = null, photoFrom = 'none: a card of words';
    if (input.photo !== 'none') {
      if (isImage(media)) { photo = media.buffer; photoFrom = 'the photo sent with this message'; }
      else if (input.photo === 'attached') throw new Error('no photo came with this message; ask the writer to send it with the request, or make it without a photo');
      else {
        const refs = Array.isArray(p.photoFiles) ? p.photoFiles : [];
        for (const ref of [...refs].reverse()) {           // the latest photo first
          const f = await readStoredFile(db, ref);
          if (f && /^image\/(jpeg|png|webp)$/.test(f.type)) { photo = f.bytes; photoFrom = `his photo "${ref.name || 'photo'}" from the CRM`; break; }
        }
        if (!photo) photoFrom = refs.length ? 'none: his photo in the CRM is not a JPG, PNG or WebP, so a card of words' : 'none: he has no photo in the CRM, so a card of words (a photo sent with the request is used instead)';
      }
    }
    const r = await render({ facts, size, photo });
    if (photo && !r.photoUsed) photoFrom = 'none: the photo could not be drawn (too small or unreadable), so a card of words';
    const caption = input.caption ? String(input.caption).replace(/\r/g, '').trim().slice(0, CAPTION_MAX) : graphic.buildCaption(facts);
    const label = { signing: 'signing', goal: 'goal', birthday: 'birthday', custom: 'graphic' }[kind];
    const filename = `${String(facts.name).replace(/[\\/:*?"<>|]/g, '').trim() || 'player'} - ${label} - ${size}.jpg`;
    state.outFiles.push({ buffer: r.bytes, filename, mimeType: 'image/jpeg', caption, graphic: true });
    const other = size === 'post' ? 'story' : 'post';
    return {
      made: true, player: facts.name, kind, size: `${size} ${r.width}x${r.height}`, lang,
      onThePicture: [r.texts.kicker, r.texts.name, ...r.texts.details.filter((d) => r.photoUsed || !d.photoOnly).map((d) => d.text)].filter(Boolean),
      facts: { ...facts, ...(Object.keys(from).length ? { from } : {}) },
      photo: photoFrom, caption, sizeKB: Math.round(r.bytes.length / 1024),
      note: `The picture goes out right after your answer, then the caption as its own message so it can be copied. Your answer: one short line (what it shows; say if there was no photo), then offer [[כפתורים: גם ${other === 'story' ? 'סטורי' : 'פוסט'} | לשנות טקסט]]. Never say it was posted: the writer uploads it.`,
    };
  }
  return { instagram_graphic: make };
}

// ── the offer ───────────────────────────────────────────────────────────────
async function readState(db) {
  const snap = await db.collection(META[0]).doc(META[1]).get();
  return snap.exists ? (snap.data() || {}) : {};
}

/**
 * offerGraphics(db, owner, { players, matches }, now, { hour, send, job })
 * One offer when it is time and something happened. Returns { sent, key } or { skipped: why }.
 */
async function offerGraphics(db, owner, { players = [], matches = [] } = {}, now = new Date(), { hour, send = null, job = { note: () => {} } } = {}) {
  if (!(hour >= FROM_HOUR && hour <= TO_HOUR)) return { skipped: 'not the hour' };
  const state = await readState(db);
  const today = israelDate(now);
  const sentToday = state.day === today ? Number(state.sentToday) || 0 : 0;
  if (sentToday >= OFFERS_PER_DAY) return { skipped: 'enough for today' };
  const events = graphicEvents({ players, matches, offered: state.offered || {}, today });
  if (!events.length) return { skipped: 'nothing to offer' };

  // Not on top of a question of hers that he has not answered yet: an hour later instead.
  const { threadRef } = await chatOf(db, owner);
  const thread = await threadRef.get();
  const history = thread.exists && Array.isArray(thread.data().history) ? thread.data().history : [];
  const last = history[history.length - 1];
  if (last && now.getTime() - (Number(last.at) || 0) < WAIT_FOR_ANSWER_MS && awaitsAnswer(history)) return { skipped: 'waiting for an answer' };

  const e = events[0];
  const first = String(owner.name || '').trim().split(/\s+/)[0] || 'לו';
  const msg = buildGraphicOffer(first, e);
  // A birthday offer means nothing tomorrow: one still waiting for the window drops at midnight.
  const expiresAt = now.getTime() + Math.max(1, 24 - hour) * 3600000;
  await nudge(db, owner, { body: msg.text, buttons: msg.buttons, kind: 'question', remember: true, expiresAt }, { now: now.getTime(), send, job });
  const offered = Object.fromEntries(Object.entries(state.offered || {}).filter(([, on]) => daysBetween(on, today) < KEEP_OFFERED_DAYS));
  offered[e.key] = today;
  // The whole document is written (no merge), so keys dropped above are really gone.
  await db.collection(META[0]).doc(META[1]).set({ offered, day: today, sentToday: sentToday + 1, updatedAt: now.getTime() });
  job.note(`graphic offer → ${owner.email}: ${e.kind} ${e.player}`);
  return { sent: 1, key: e.key };
}

module.exports = { instagramTools, INSTAGRAM_TOOL_DEF, offerGraphics, readStoredFile, recentGoal, FROM_HOUR, TO_HOUR, OFFERS_PER_DAY };
