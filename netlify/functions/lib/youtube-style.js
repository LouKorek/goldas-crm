// How Lou's YouTube videos look, learned from the channel itself, so the
// videos Golda uploads match: the title pattern, the description pattern,
// tags, privacy, category, the playlist a video is filed in, and the cover
// (thumbnail) layout.
//
//   learnStyle(db, {token})   reads the latest uploads (and looks at their
//                             covers), asks the model for one style guide and
//                             stores it in app_meta/youtubeStyle
//   getStyle(db)              the stored guide, or null
//   valuesFor(record, opts)   the {placeholders} a player or prospect fills
//   draftFor(style, record)   title, description, tags, privacy, playlist…
//                             for a new video
//
// The patterns are made of the PLACEHOLDERS below; each is one fact from the
// player's record in one of the shapes the channel writes it in.
const { playerName, flagEmoji, POSITIONS } = require('@goldas/domain');
const yt = require('./youtube.js');
const { fill, DEFAULT_SPEC, LAYOUTS } = require('./youtube-thumb.js');

const { effortForTask } = require('./golda-effort.js');
const cost = require('./golda-cost.js');

const { model: MODEL, effort: EFFORT } = effortForTask('style');
const MAX_TOKENS = 8000;
const DOC = ['app_meta', 'youtubeStyle'];
const COVERS_SHOWN = 6;

// name → an example of what it becomes (the examples go to the model as is).
const PLACEHOLDER_EXAMPLES = {
  name: 'Noam Barzilay', firstName: 'Noam', lastName: 'Barzilay',
  position: 'LB', positions: 'LB / CB',
  club: 'Hapoel Hod Hasharon',
  age: '18', birthYear: '2008', birthDate: 'Feb 14, 2008', birthDateDMY: '14/02/2008', birthDateDots: '14.02.2008',
  foot: 'Left', footShort: 'L',
  nationality: 'Israel, Germany', nationalityFlags: 'Israel 🇮🇱 Germany 🇩🇪', flags: '🇮🇱 🇩🇪',
  height: '1.84m', heightM: '1.84', heightCm: '184',
  season: '2025/26', seasonLong: '2025-2026', year: '2026', date: '2026-06-26',
  agency: 'Gold A&S', extra: 'vs Maccabi Haifa',
};
const PLACEHOLDERS = Object.keys(PLACEHOLDER_EXAMPLES);
const AUDIENCES = ['men', 'women', 'youth', 'all'];

// What Lou's channel looked like when Golda first read it (November 2026):
// the starting point when the channel cannot be read or the model fails.
const FALLBACK_STYLE = {
  summaryHe: 'תבנית הבסיס של הערוץ: כותרת "שם | עמדות | עונה", תיאור בשורות עם אימוג\'י (אזרחות, תאריך לידה, עמדות, גובה, רגל), וקאבר עם השם בגדול ושורות פרטים.',
  title: { template: '{name} | {positions} | {season}', notes: '' },
  description: { template: '{name}\n🌍 {nationality}\n🗓️ {birthDate} ({age})\n📍 {positions}\n📏 {height}\n🦵 {footShort}', notes: '' },
  tags: [],
  privacy: 'unlisted', categoryId: '17', language: '', madeForKids: false,
  positionAliases: {},
  playlists: [],
  thumbnail: { ...DEFAULT_SPEC, custom: true, notes: '' },
};

const SYSTEM = [
  "You study a football agency's YouTube channel (Gold A&S, Israel) so that new player videos can be uploaded in exactly the same style.",
  'You get the latest uploads as JSON (id, title, description, tags, privacy, category, language, the playlists each is in), the channel\'s playlists, and the cover images of the newest videos.',
  'Work out the pattern the owner follows for PLAYER videos and call save_style once with it. Rules:',
  '- Some uploads may have nothing to do with players (old tests, private drafts on other subjects). Ignore them completely and list only the player videos in playerVideoIds.',
  `- Patterns are made of these placeholders only (each shown with an example of what it becomes): ${PLACEHOLDERS.map((p) => `{${p}} → "${PLACEHOLDER_EXAMPLES[p]}"`).join('; ')}. {extra} is a free part the uploader may add (opponent, competition, "vs …"). Pick the placeholder whose shape matches what the owner writes (a date written "14.02.2008" is {birthDateDots}, "1.84m" is {height}, "L" is {footShort}). Keep the owner's exact separators, order, capitalisation, language, emojis, fixed phrases, links, contact lines and hashtags.`,
  '- The description template is the whole description, line breaks included, with the fixed parts verbatim.',
  '- When the videos do not share one pattern, the newest player video decides; say so in the notes.',
  `- positionAliases: the CRM writes positions as ${POSITIONS.join(', ')}. If the owner writes one differently (for example DM for CDM), map the CRM code to the owner's spelling; otherwise leave it empty.`,
  '- playlists: which of the channel\'s playlists a new player video should be added to. One entry per playlist the owner really uses for player videos, with "for": men, women, youth, or all (every player video). Use the playlist ids you were given, nothing else. Empty when the player videos are in no playlist.',
  '- privacy: what most of the player videos use.',
  '- thumbnail.custom: true when the covers are designed (text or graphics drawn on them); false when they are plain frames of the video. When true, describe the NEWEST player cover with the given fields. The cover is redrawn by a program with three layouts:',
  '    bars: the picture fills the cover; the name very large on one side (side: left, right or center) and under it one fact per line, each on a coloured bar (barColor, barOpacity).',
  '    panel: the picture on one half and a light paper panel on the other (side = where the panel is); on the panel a small top line (topLine, e.g. the season), the name in two lines (the first in nameAccentColor, the second in panelTextColor) and the facts as centred lines.',
  '    band: the picture with a dark band at the bottom holding the name and one line of facts.',
  '  nameLines are the name\'s lines top to bottom as placeholder patterns (for example ["{lastName}", "{firstName}"]); rows are the fact lines top to bottom, each with its fixed words and one or more placeholders (for example "Date Of Birth : {birthDateDots}", "{club}", "{heightM} CM"). Copy the wording, order and upper/lower case you see; give colours as hex. font: display for tall condensed capitals, sans for a regular bold face. logo: the corner of an agency logo, or none.',
  '- summaryHe: 2 to 4 short Hebrew sentences for the owner describing the style you found (title, description, playlist, cover, privacy).',
].join('\n');

const hex = { type: 'string', description: 'hex colour, e.g. #1E5BB8' };
const STYLE_TOOL = {
  name: 'save_style',
  description: 'Save the style guide learned from the channel.',
  input_schema: {
    type: 'object',
    required: ['summaryHe', 'playerVideoIds', 'title', 'description', 'privacy', 'thumbnail'],
    properties: {
      summaryHe: { type: 'string' },
      playerVideoIds: { type: 'array', items: { type: 'string' }, description: 'ids of the uploads that are player videos' },
      title: { type: 'object', required: ['template'], properties: { template: { type: 'string' }, notes: { type: 'string' } } },
      description: { type: 'object', required: ['template'], properties: { template: { type: 'string' }, notes: { type: 'string' } } },
      tags: { type: 'array', items: { type: 'string' } },
      privacy: { type: 'string', enum: ['public', 'unlisted', 'private'] },
      categoryId: { type: 'string' },
      language: { type: 'string', description: 'BCP-47 code the videos declare, or ""' },
      madeForKids: { type: 'boolean' },
      positionAliases: { type: 'object', additionalProperties: { type: 'string' }, description: 'CRM position code → how the owner writes it, only where they differ' },
      playlists: { type: 'array', items: { type: 'object', required: ['id', 'for'], properties: { id: { type: 'string' }, for: { type: 'string', enum: AUDIENCES } } } },
      thumbnail: {
        type: 'object', required: ['custom'],
        properties: {
          custom: { type: 'boolean' },
          layout: { type: 'string', enum: LAYOUTS },
          side: { type: 'string', enum: ['left', 'right', 'center'] },
          topLine: { type: 'string', description: 'a small line above the name, as a pattern, or ""' },
          nameLines: { type: 'array', items: { type: 'string' }, description: '1 or 2 patterns, top to bottom' },
          rows: { type: 'array', items: { type: 'string' }, description: 'up to 6 fact lines, top to bottom, as patterns' },
          uppercase: { type: 'boolean' },
          font: { type: 'string', enum: ['display', 'sans'] },
          nameColor: hex, nameAccentColor: hex, rowColor: hex, barColor: hex, barOpacity: { type: 'number' },
          panelColor: hex, panelTextColor: hex,
          logo: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none'] },
          notes: { type: 'string' },
        },
      },
    },
  },
};

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));
const isHex = (c) => /^#[0-9a-f]{3,8}$/i.test(String(c || ''));
const patterns = (list, max, fallback) => {
  const rows = (Array.isArray(list) ? list : []).map((t) => clip(String(t || '').trim(), 80)).filter(Boolean).slice(0, max);
  return rows.length ? rows : fallback;
};

async function coverBlock(url, fetchImpl) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1000 || bytes.length > 4 * 1024 * 1024) return null;
    return { type: 'image', source: { type: 'base64', media_type: type, data: bytes.toString('base64') } };
  } catch { return null; }
}

/** The cover part of a style, with only values the drawing code understands. */
function cleanThumb(th = {}) {
  const pick = (k, ok) => (ok(th[k]) ? th[k] : DEFAULT_SPEC[k]);
  return {
    custom: !!th.custom,
    layout: pick('layout', (v) => LAYOUTS.includes(v)),
    side: pick('side', (v) => ['left', 'right', 'center'].includes(v)),
    topLine: clip(String(th.topLine || '').trim(), 60),
    nameLines: patterns(th.nameLines, 2, DEFAULT_SPEC.nameLines),
    rows: Array.isArray(th.rows) ? patterns(th.rows, 6, []) : DEFAULT_SPEC.rows,
    uppercase: th.uppercase !== false,
    font: th.font === 'sans' ? 'sans' : 'display',
    nameColor: pick('nameColor', isHex), nameAccentColor: pick('nameAccentColor', isHex), rowColor: pick('rowColor', isHex),
    barColor: pick('barColor', isHex), barOpacity: Number.isFinite(Number(th.barOpacity)) && th.barOpacity !== '' && th.barOpacity != null ? Math.max(0, Math.min(1, Number(th.barOpacity))) : DEFAULT_SPEC.barOpacity,
    panelColor: pick('panelColor', isHex), panelTextColor: pick('panelTextColor', isHex),
    logo: pick('logo', (v) => ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'none'].includes(v)),
    notes: clip(th.notes, 400),
  };
}

/** A playlist's audience from its name, for when the model named none. */
function audienceOfTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/women|ladies|girls|נשים|בנות/.test(t)) return 'women';
  if (/youth|academy|u-?\d\d|נוער|נערים|ילדים/.test(t)) return 'youth';
  if (/\bmen|גברים|בוגרים/.test(t)) return 'men';
  return null;
}

/** The model's answer with only what the rest of the code understands. `lists` = the channel's real playlists. */
function cleanStyle(raw, { lists = [] } = {}) {
  const s = raw || {};
  const byId = new Map(lists.map((l) => [l.id, l]));
  const seen = new Set();
  const playlists = (Array.isArray(s.playlists) ? s.playlists : [])
    .filter((p) => p && byId.has(p.id) && AUDIENCES.includes(p.for) && !seen.has(p.for) && seen.add(p.for))
    .map((p) => ({ id: p.id, title: clip(byId.get(p.id).title, 120), for: p.for }));
  const aliases = {};
  for (const [k, v] of Object.entries(s.positionAliases && typeof s.positionAliases === 'object' ? s.positionAliases : {})) {
    if (POSITIONS.includes(k) && /^[A-Za-z]{1,5}$/.test(String(v || '')) && v !== k) aliases[k] = String(v);
  }
  return {
    summaryHe: clip(s.summaryHe, 900),
    title: { template: clip(s.title?.template || FALLBACK_STYLE.title.template, 200), notes: clip(s.title?.notes, 400) },
    description: { template: clip(s.description?.template || '', 4500), notes: clip(s.description?.notes, 400) },
    tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => clip(t, 60)).filter(Boolean).slice(0, 30),
    privacy: ['public', 'unlisted', 'private'].includes(s.privacy) ? s.privacy : 'unlisted',
    categoryId: /^\d{1,3}$/.test(String(s.categoryId || '')) ? String(s.categoryId) : '17',
    language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(s.language || '')) ? s.language : '',
    madeForKids: !!s.madeForKids,
    positionAliases: aliases,
    playlists,
    thumbnail: cleanThumb(s.thumbnail || {}),
  };
}

/** The most used value of `key` among rows, or null. */
function usual(rows, key) {
  const counts = {};
  for (const r of rows) if (r[key]) counts[r[key]] = (counts[r[key]] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** Read the channel and store its style. Returns the stored document. */
async function learnStyle(db, { token, channel, anthropic, fetchImpl = fetch, now = Date.now(), max = 12 }) {
  const videos = await yt.recentUploads(token, channel?.uploads, max, { fetchImpl });
  const lists = videos.length ? await yt.playlists(token, { among: videos.map((v) => v.id), fetchImpl }).catch(() => []) : [];
  const inLists = (id) => lists.filter((l) => l.videoIds.includes(id));
  const example = (v) => ({ id: v.id, title: v.title, privacy: v.privacy, cover: v.cover, description: clip(v.description, 600) });
  const base = { learnedAt: now, channelId: channel?.id || null, fromVideos: videos.length,
    channelPlaylists: lists.map((l) => ({ id: l.id, title: clip(l.title, 120), count: l.count })),
    examples: videos.slice(0, 5).map(example) };
  if (!videos.length) {
    const doc = { ...base, style: FALLBACK_STYLE, learned: false };
    await db.collection(DOC[0]).doc(DOC[1]).set(doc);
    return doc;
  }
  const covers = (await Promise.all(videos.slice(0, COVERS_SHOWN).map((v) => (v.cover ? coverBlock(v.cover, fetchImpl) : null))));
  const content = [{ type: 'text', text: [
    `The channel "${channel?.title || ''}": its ${videos.length} latest uploads, newest first.`,
    JSON.stringify(videos.map((v) => ({ id: v.id, title: v.title, description: clip(v.description, 1500), tags: v.tags.slice(0, 20), privacy: v.privacy, categoryId: v.categoryId, language: v.language, madeForKids: v.madeForKids, publishedAt: v.publishedAt, duration: v.duration, playlists: inLists(v.id).map((l) => l.title) })), null, 1),
    `The channel's playlists: ${JSON.stringify(lists.map((l) => ({ id: l.id, title: l.title, videos: l.count })))}`,
  ].join('\n') }];
  covers.forEach((c, i) => { if (c) content.push({ type: 'text', text: `Cover of video ${i + 1} ("${clip(videos[i].title, 80)}"):` }, c); });
  let style = null, problem = null, playerIds = [];
  try {
    const client = anthropic || new (require('@anthropic-ai/sdk'))();
    const msg = await client.beta.messages.stream({
      model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
      system: SYSTEM, tools: [STYLE_TOOL], messages: [{ role: 'user', content }],
    }).finalMessage();
    await cost.record(db, { kind: 'other', model: MODEL, usage: msg.usage, now });
    const call = (msg.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_style');
    if (call?.input) {
      style = cleanStyle(call.input, { lists });
      const known = new Set(videos.map((v) => v.id));
      playerIds = (Array.isArray(call.input.playerVideoIds) ? call.input.playerVideoIds : []).filter((id) => known.has(id));
    } else problem = 'the model returned no style';
  } catch (e) { problem = String(e.message).slice(0, 200); }

  // Whatever the model did, privacy and playlists follow what the channel really does.
  const players = playerIds.length ? videos.filter((v) => playerIds.includes(v.id)) : videos;
  const privacy = usual(players, 'privacy');
  const doc = { ...base, style: style || { ...FALLBACK_STYLE }, learned: !!style, playerVideos: players.length, examples: players.slice(0, 5).map(example), ...(problem ? { problem } : {}) };
  if (privacy && !players.some((v) => v.privacy === doc.style.privacy)) doc.style = { ...doc.style, privacy };
  if (!style && privacy) doc.style = { ...doc.style, privacy };
  if (!doc.style.playlists?.length) {
    // The playlists the player videos sit in, by their names.
    const used = lists.filter((l) => players.some((v) => l.videoIds.includes(v.id)));
    const seen = new Set();
    doc.style = { ...doc.style, playlists: used.map((l) => ({ id: l.id, title: clip(l.title, 120), for: audienceOfTitle(l.title) || (used.length === 1 ? 'all' : null) })).filter((p) => p.for && !seen.has(p.for) && seen.add(p.for)) };
  }
  await db.collection(DOC[0]).doc(DOC[1]).set(doc);
  return doc;
}

async function getStyle(db) {
  const snap = await db.collection(DOC[0]).doc(DOC[1]).get();
  return snap.exists ? snap.data() : null;
}

/** "2026/27" for a date: the football season it falls in (July to June). */
function seasonOf(date = new Date()) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth();
  const start = m >= 6 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');

/** A height the CRM holds as centimetres ("184", 184) or metres ("1.84") → centimetres, or null. */
function heightCm(h) {
  const n = parseFloat(String(h ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const cm = n < 3 ? n * 100 : n;
  return cm >= 120 && cm <= 230 ? Math.round(cm) : null;
}

/** Every placeholder's value for one record; '' where the record does not say. */
function valuesFor(record = {}, { now = new Date(), extra = '', aliases = {} } = {}) {
  const dob = /^\d{4}-\d{2}-\d{2}/.test(String(record.dob || '')) ? new Date(`${String(record.dob).slice(0, 10)}T12:00:00Z`) : null;
  let age = '';
  if (dob) { age = now.getUTCFullYear() - dob.getUTCFullYear(); if (now < new Date(Date.UTC(now.getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate()))) age -= 1; }
  const name = playerName(record);
  const words = name.split(/\s+/).filter(Boolean);
  const pos = (p) => aliases[p] || p;
  const all = [record.primaryPosition, ...(Array.isArray(record.secondaryPositions) ? record.secondaryPositions : [])].filter(Boolean);
  const positions = [...new Set(all)].map(pos);
  const nats = (Array.isArray(record.nationalities) ? record.nationalities : []).map((n) => String(n || '').trim()).filter(Boolean);
  const cm = heightCm(record.height);
  const season = seasonOf(now);
  const start = Number(season.slice(0, 4));
  const d = dob ? { y: dob.getUTCFullYear(), m: dob.getUTCMonth(), d: dob.getUTCDate() } : null;
  return {
    name, firstName: words[0] || '', lastName: words.slice(1).join(' '),
    position: record.primaryPosition ? pos(record.primaryPosition) : '',
    positions: positions.join(' / '),
    club: record.currentClub || '',
    age: age === '' ? '' : String(age),
    birthYear: d ? String(d.y) : '',
    birthDate: d ? `${MONTHS[d.m]} ${d.d}, ${d.y}` : '',
    birthDateDMY: d ? `${two(d.d)}/${two(d.m + 1)}/${d.y}` : '',
    birthDateDots: d ? `${two(d.d)}.${two(d.m + 1)}.${d.y}` : '',
    foot: record.foot || '',
    footShort: record.foot === 'Left' ? 'L' : record.foot === 'Right' ? 'R' : record.foot === 'Both' ? 'R / L' : '',
    nationality: nats.join(', '),
    nationalityFlags: nats.map((n) => `${n} ${flagEmoji(n)}`.trim()).join(' '),
    flags: nats.map((n) => flagEmoji(n)).filter(Boolean).join(' '),
    height: cm ? `${(cm / 100).toFixed(2)}m` : '',
    heightM: cm ? (cm / 100).toFixed(2) : '',
    heightCm: cm ? String(cm) : '',
    season,
    seasonLong: `${start}-${start + 1}`,
    year: String(now.getUTCFullYear()),
    date: now.toISOString().slice(0, 10),
    agency: 'Gold A&S',
    extra: String(extra || '').trim(),
  };
}

/** Fill a multi-line template; a line that ends up with no value in it is dropped. */
function fillLines(template, values) {
  return String(template || '').split('\n').map((line) => {
    if (!/\{\w+\}/.test(line)) return line;
    const used = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (used.every((k) => !values[k])) return null;
    return fill(line, values);
  }).filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Which kind of playlist a record's video belongs in. */
function audienceOf(record = {}, collection = '') {
  if (collection === 'pipeline_women' || record.gender === 'Women') return 'women';
  if (collection === 'pipeline_youth') return 'youth';
  return 'men';
}

/**
 * The playlist a new video of this record goes in: the one for its audience,
 * (the men's for youth when there is no youth one), else the one for all.
 * `wanted`: 'none', or part of a playlist's name the writer asked for.
 */
function playlistFor(styleDoc, record, collection, wanted = '') {
  const lists = styleDoc?.style?.playlists || [];
  const w = String(wanted || '').trim().toLowerCase();
  if (w === 'none') return null;
  if (w) {
    const every = [...lists, ...(styleDoc?.channelPlaylists || [])];
    const hit = every.find((l) => String(l.title || '').toLowerCase() === w) || every.find((l) => String(l.title || '').toLowerCase().includes(w));
    if (!hit) throw new Error(`the channel has no playlist called "${wanted}"; its playlists: ${(styleDoc?.channelPlaylists || []).map((l) => l.title).join(', ') || 'none'}`);
    return { id: hit.id, title: hit.title };
  }
  const a = audienceOf(record, collection);
  const hit = lists.find((l) => l.for === a) || (a === 'youth' ? lists.find((l) => l.for === 'men') : null) || lists.find((l) => l.for === 'all');
  return hit ? { id: hit.id, title: hit.title } : null;
}

/** What a new video of this player gets, in the channel's style. Explicit fields win. */
function draftFor(styleDoc, record, { title, description, privacy, tags, extra, playlist, collection, now = new Date() } = {}) {
  const style = styleDoc?.style || FALLBACK_STYLE;
  const values = valuesFor(record, { now, extra, aliases: style.positionAliases || {} });
  return {
    title: clip(String(title || '').trim() || fill(style.title?.template, values) || values.name, 100),
    description: clip(description != null && String(description).trim() ? String(description) : fillLines(style.description?.template, values), 4900),
    tags: (Array.isArray(tags) && tags.length ? tags : [...(style.tags || []), values.name, values.club].filter(Boolean)).slice(0, 30),
    privacy: ['public', 'unlisted', 'private'].includes(privacy) ? privacy : style.privacy || 'unlisted',
    categoryId: style.categoryId || '17',
    language: style.language || '',
    madeForKids: !!style.madeForKids,
    playlist: playlistFor(styleDoc, record, collection, playlist),
    values,
  };
}

module.exports = {
  learnStyle, getStyle, draftFor, valuesFor, fillLines, seasonOf, cleanStyle, cleanThumb, playlistFor, audienceOf, audienceOfTitle, heightCm,
  FALLBACK_STYLE, PLACEHOLDERS, PLACEHOLDER_EXAMPLES, STYLE_TOOL, _internal: { SYSTEM },
};
