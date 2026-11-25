// Golda's two YouTube tools.
//
//   youtube_style   how Lou's videos look (title, description, playlist, cover,
//                   privacy), learned from the channel; refresh re-reads it
//   youtube_upload  a player's video to the channel, in that style:
//                     draft    → what would go up (nothing is sent yet)
//                     confirm  → only in a LATER message, after the writer agreed:
//                                the server uploads the video it got on WhatsApp,
//                                or the writer gets a link to a page that sends a
//                                big file from the phone straight to YouTube
//                     cover    → use the image sent with this message as the cover
//                     status / cancel
//                   After the upload the record's videoLink is replaced with the
//                   new address (lib/youtube-jobs.js) and the writer is told the
//                   old one.
//
// Highlights (draft with `moments`): only when the writer asked for chosen
// moments and wrote their times. The same draft and the same yes; after it the
// writer always gets the page, which cuts the moments out of the full match on
// the phone and uploads only them. Two things keep it "only on request":
// Golda's instructions (never offer it), and a check here in code: every time
// she passes must be written in the writer's own messages, so she cannot come
// up with moments herself.
//
// Publishing on Lou's channel is an act outside the CRM, so it follows the
// same rule as deleting: the yes comes in its own message.
const { parseHighlightMoments, highlightProblemText, clockTimesIn, formatClock, HIGHLIGHT_LIMITS } = require('@goldas/domain');
const { internalHeaders } = require('./auth.js');
const ytAuth = require('./youtube-auth.js');
const ytStyle = require('./youtube-style.js');
const jobs = require('./youtube-jobs.js');

const TARGETS = ['players', 'pipeline_men', 'pipeline_women', 'pipeline_youth', 'pipeline_jewish'];
const ADMIN_PAGE = 'https://goldas-crm.netlify.app/admin/youtube';

const YOUTUBE_TOOL_DEFS = [
  { name: 'youtube_style', description: "How the agency's YouTube videos are titled, described and covered, learned from Lou's channel: the title and description patterns, the usual privacy, the playlists videos are filed in, the cover layout and a few recent examples. Read it before drafting an upload or when asked how videos are published. refresh=true re-reads the channel (after Lou changed his style).",
    input_schema: { type: 'object', properties: { refresh: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'youtube_upload', description: "Upload a player's or prospect's video to Lou's YouTube channel in the channel's style, then replace the record's videoLink with the new address. action=draft (collection + id required): prepares the title, description, privacy, playlist and cover and returns them; nothing is uploaded. Show the writer the draft and ask for a yes. action=confirm: only after the writer agreed in a LATER message. If the video came with the draft message on WhatsApp it uploads in the background and the writer gets the link there; otherwise you get a page link to send the writer: they open it on the phone, pick the video and it goes straight to YouTube (for files too big for WhatsApp, which stops at 16 MB). Highlights, ONLY when the writer asked for chosen moments (רגעים נבחרים, היילייטס, תחתכי…) and wrote the times themselves: pass them in moments with action=draft. Never offer highlights, never propose or guess times, never turn a normal upload into one. The draft then lists the moments; after the yes the writer gets the page, picks the FULL match video there, and the phone cuts the moments and uploads only them (nothing is cut on a server, and a video sent on WhatsApp or a download link is not used). action=cover: the image sent with THIS message becomes the cover of the writer's latest upload: as it is when it is a finished cover, or with cover=style when it is a plain photo of the player, so the name and the facts are drawn on it in the channel style. action=status: where the latest upload stands. action=cancel: drop the open draft.",
    input_schema: { type: 'object', properties: {
      action: { type: 'string', enum: ['draft', 'confirm', 'cover', 'status', 'cancel'] },
      collection: { type: 'string', enum: TARGETS }, id: { type: 'string', description: 'The record the video belongs to' },
      title: { type: 'string', description: 'Only to override the styled title (max 100 chars)' },
      description: { type: 'string', description: 'Only to override the styled description' },
      extra: { type: 'string', description: 'The free part of the title pattern: opponent, competition, "vs …", season part' },
      privacy: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'Only when the writer asked; default is what the channel uses' },
      playlist: { type: 'string', description: 'Only when the writer asked: the name of another playlist of the channel, or "none". Default is the playlist the channel uses for this kind of player.' },
      cover: { type: 'string', enum: ['style', 'none'], description: 'With draft: style = a cover drawn in the channel style on a frame of the video; none = YouTube picks a frame; default follows the channel. With action=cover: style = draw the name and facts on the sent photo; leave out to use the sent image exactly as it is.' },
      sourceUrl: { type: 'string', description: 'A direct download link to the video file, when the writer gave one instead of sending the file' },
      moments: { type: 'array', items: { type: 'string' }, description: `Highlights only, and only the times the writer wrote: one string per moment, a range "12:30-12:50" or a single time "71:05" (a single time is cut from ${HIGHLIGHT_LIMITS.before} seconds before it to ${HIGHLIGHT_LIMITS.after} seconds after). Times are minutes:seconds from the start of the video FILE (hours:minutes:seconds also reads), not the match clock. Copy them as written; do not invent, shift or round them.` },
      jobId: { type: 'string' },
    }, required: ['action'], additionalProperties: false } },
];

const isVideo = (m) => !!m && /^video\//.test(m.mimeType || '');
const isImage = (m) => !!m && /^image\/(jpeg|png|webp)$/.test(m.mimeType || '');

/**
 * The moments the writer asked for, read and bounded. Refuses any time that is
 * not written in the writer's own messages (`writerTexts`: this message and
 * the earlier ones of this conversation).
 */
function readMoments(input, writerTexts) {
  const asked = Array.isArray(input.moments) ? input.moments.map(String) : input.moments;
  const r = parseHighlightMoments(asked);
  if (!r.ok) throw new Error(`${highlightProblemText(r.problem)}. Ask the writer; do not fix the times yourself.`);
  const written = new Set(clockTimesIn((writerTexts || []).join('\n')));
  const foreign = [...new Set(clockTimesIn([].concat(asked).join('\n')))].filter((t) => !written.has(t));
  if (foreign.length) {
    throw new Error(`Highlights are cut only when the writer asked for them and wrote the times. These times are not in the writer's messages: ${foreign.map(formatClock).join(', ')}. Do not come up with moments: ask the writer to write them as minutes:seconds of the video file (for example 12:30-12:50, 71:05).`);
  }
  return r;
}

function youtubeTools({ db, admin, identity, media, session, channel = 'whatsapp', role, resolve, kick = defaultKick, writerTexts = [] }) {
  const by = { email: identity.email || '', name: identity.name || '', phone: identity.phone || '', phoneId: media?.phoneId || identity.phoneId || null, channel };
  const turn = Number(session?.turn) || 0;

  async function mayUpload() {
    if (role === 'admin') return;
    const pub = await ytAuth.publicStatus(db);
    if (role === 'manager' && pub.managersMayUpload) return;
    throw new Error(`${identity.name || 'the writer'} may not upload to the YouTube channel; only an admin can (or a manager, once Lou allows it in System › YouTube)`);
  }
  async function connected() {
    const pub = await ytAuth.publicStatus(db);
    if (!pub.connected) throw new Error(`YouTube is not connected yet. An admin connects it once in the app: ${ADMIN_PAGE}`);
    return pub;
  }
  const brief = (doc) => ({
    learnedAt: doc.learnedAt ? new Date(doc.learnedAt).toISOString().slice(0, 10) : null, fromVideos: doc.fromVideos || 0,
    summaryHe: doc.style?.summaryHe || '', titlePattern: doc.style?.title?.template || '', titleNotes: doc.style?.title?.notes || '',
    descriptionPattern: doc.style?.description?.template || '', privacy: doc.style?.privacy || '', tags: doc.style?.tags || [],
    playlists: (doc.style?.playlists || []).map((l) => ({ title: l.title, for: l.for })),
    otherPlaylists: (doc.channelPlaylists || []).map((l) => l.title).filter((t) => !(doc.style?.playlists || []).some((l) => l.title === t)),
    cover: doc.style?.thumbnail?.custom
      ? { designed: true, layout: doc.style.thumbnail.layout, name: doc.style.thumbnail.nameLines, facts: doc.style.thumbnail.rows, notes: doc.style.thumbnail.notes || '' }
      : { designed: false, note: "the channel's covers are plain frames of the video" },
    examples: (doc.examples || []).slice(0, 4).map((e) => ({ title: e.title, privacy: e.privacy, link: `https://youtu.be/${e.id}` })),
  });

  async function style({ refresh } = {}) {
    const pub = await connected();
    let doc = await ytStyle.getStyle(db);
    if (refresh || !doc) {
      if (refresh) await mayUpload();
      const token = await ytAuth.accessToken(db);
      doc = await ytStyle.learnStyle(db, { token, channel: pub.channel });
    }
    return { channel: pub.channel?.title || '', ...brief(doc), ...(pub.playlistsAllowed ? {} : { playlistNote: 'Golda has no permission for playlists yet, so she cannot file a video in one (an admin can allow it in System › YouTube).' }) };
  }

  async function draft(input) {
    await mayUpload();
    const pub = await connected();
    if (!input.collection || !input.id) throw new Error('collection and id are required for a draft: find the player first');
    const record = await resolve(input.collection, input.id);
    let styleDoc = await ytStyle.getStyle(db);
    if (!styleDoc) styleDoc = await ytStyle.learnStyle(db, { token: await ytAuth.accessToken(db), channel: pub.channel });
    const d = ytStyle.draftFor(styleDoc, record, input);
    const { values, playlist, ...meta } = d;
    const wantsMoments = input.moments !== undefined && input.moments !== null && String(input.moments).length > 0;
    const highlights = wantsMoments ? readMoments(input, writerTexts) : null;
    if (highlights && input.sourceUrl) throw new Error('highlights are cut on the phone from the match file the writer picks on the upload page; a download link cannot be used for them. Draft again without sourceUrl.');
    // Highlights always go through the page: the cut happens on the phone, from the full match.
    let source = { kind: 'page' };
    if (highlights) { /* stays the page, whatever came with the message */ }
    else if (isVideo(media) && media.mediaId) source = { kind: 'whatsapp', mediaId: media.mediaId, phoneId: media.phoneId || null, mimeType: media.mimeType, size: media.buffer?.length || 0, filename: media.filename || '' };
    else if (input.sourceUrl) {
      if (!/^https:\/\/[^\s]+$/.test(input.sourceUrl)) throw new Error('sourceUrl must be an https link');
      source = { kind: 'url', url: input.sourceUrl };
    }
    const designed = !!styleDoc.style?.thumbnail?.custom;
    const coverMode = input.cover || (designed ? 'style' : 'none');
    const job = await jobs.createDraft(db, {
      record, target: { collection: input.collection, physical: 'players', id: input.id, name: values.name },
      meta, values, source, cover: { mode: coverMode }, playlist: pub.playlistsAllowed ? playlist : null, highlights, by: { ...by, draftTurn: turn },
    });
    const shown = highlights ? jobs.highlightsText(highlights) : null;
    return {
      drafted: true, jobId: job.id, channel: pub.channel?.title || '', player: values.name,
      title: meta.title, description: meta.description, privacy: meta.privacy, tags: meta.tags,
      playlist: !playlist ? '(none)' : pub.playlistsAllowed ? playlist.title : `(not filed: Golda has no permission for playlists; the channel would use "${playlist.title}")`,
      cover: coverMode === 'style' ? 'drawn in the channel style (the name large and the player\'s facts) on a frame of the video; set a few minutes after the upload, when YouTube finished processing. The writer may send a photo of the player to use as the picture instead.' : "YouTube's own frame (the channel's covers are plain frames); the writer may send an image to use instead",
      ...(highlights ? { highlights: {
        moments: shown.moments, total: shown.total,
        ...(highlights.reordered ? { reordered: 'the moments were put in the order they come in the video' } : {}),
        ...(highlights.merged ? { joined: `${highlights.merged} moment(s) that overlapped or touched were joined` } : {}),
        note: `Times are minutes:seconds from the start of the video file. Each moment starts at the nearest point before it where the video can be cut, so it may begin a second or two early. Hard cuts, no titles.${isVideo(media) ? ' The video sent with this message is not used: highlights are cut from the full match on the upload page.' : ''}`,
      } } : {}),
      video: highlights ? 'not received yet: after the yes the writer gets a link to a page; they pick the FULL match video there and the phone cuts the moments and uploads only them' : source.kind === 'whatsapp' ? `the video sent with this message (${Math.round(source.size / 1048576 * 10) / 10} MB)` : source.kind === 'url' ? 'the download link the writer gave' : 'not received yet: after the yes the writer gets a link to a page that uploads it from the phone',
      currentVideoLink: record.videoLink || '(none)',
      instruction: highlights
        ? 'Show the writer the title, the description, the privacy, the playlist and the cover, then the list of moments exactly as returned and their total length, and say the current video link will be replaced by the highlights video. Ask for a yes. Only after they agree in a NEW message call youtube_upload with action=confirm. To change something (a moment too), call draft again with the full list of moments the writer wants.'
        : 'Show the writer the title, the description, the privacy, the playlist and the cover, and say the current video link will be replaced. Ask for a yes. Only after they agree in a NEW message call youtube_upload with action=confirm. To change something, call draft again with the override.',
    };
  }

  async function pick(input, statuses) {
    const job = input.jobId ? await jobs.getJob(db, input.jobId) : await jobs.latestOpen(db, by.email, statuses);
    if (!job || (input.jobId && job.by?.email !== by.email && role !== 'admin')) throw new Error('no such upload');
    return job;
  }

  async function confirm(input) {
    await mayUpload();
    await connected();
    const job = await pick(input, ['draft']);
    if (job.status !== 'draft') throw new Error(`this upload is already ${job.status}`);
    if (!(turn > (job.by?.draftTurn ?? turn))) throw new Error('the writer has not answered the draft yet: show it, ask, and confirm only after their yes in a later message');
    const r = await jobs.confirm(db, job);
    if (r.mode === 'server') {
      await kick({ phase: 'upload', jobId: job.id });
      return { started: true, player: job.target.name, note: 'Uploading in the background. When YouTube has it, the writer gets a WhatsApp message with the new link, the record is updated and the old link is reported. Say so; do not promise a time.' };
    }
    if (job.highlights) {
      return { awaitingFile: true, highlights: true, player: job.target.name, page: r.page,
        instruction: 'Send the writer this link as is. They open it on the phone, pick the FULL match video and leave the page open: the phone cuts the moments and uploads only the highlights to YouTube; the match file itself is not uploaded anywhere. The link works for 48 hours. When it is up they get a WhatsApp message with the new link and the record is updated.' };
    }
    return { awaitingFile: true, player: job.target.name, page: r.page,
      instruction: 'Send the writer this link as is. They open it on the phone, pick the video file and leave the page open until it finishes; the file goes straight to YouTube. The link works for 48 hours. When it is up they get a WhatsApp message with the new link and the record is updated.' };
  }

  async function cover(input) {
    await mayUpload();
    if (!isImage(media) || !media.mediaId) throw new Error('no image came with this message; ask the writer to send the cover image (JPG or PNG) with the request');
    const job = await pick(input, ['draft', 'awaiting_file', 'uploading', 'uploaded', 'done']);
    const c = { mode: 'image', mediaId: media.mediaId, phoneId: media.phoneId || null, withText: input.cover === 'style' };
    if (job.status === 'uploaded' || job.status === 'done') {
      await jobs.patchJob(db, job.id, { cover: c, status: 'uploaded', finishTries: 0 });
      await kick({ phase: 'finish', jobId: job.id });
      return { coverQueued: true, player: job.target.name, drawn: c.withText ? 'the name and facts are drawn on it in the channel style' : 'used as it is', note: 'The image is being set as the cover now; the writer gets a WhatsApp message when it is on.' };
    }
    await jobs.patchJob(db, job.id, { cover: c });
    return { coverSaved: true, player: job.target.name, drawn: c.withText ? 'the name and facts will be drawn on it in the channel style' : 'used as it is', note: 'The image will be the cover once the video is up.' };
  }

  async function status(input) {
    const job = await pick(input, ['draft', 'awaiting_file', 'uploading', 'uploaded', 'done', 'failed']);
    return { jobId: job.id, player: job.target?.name, status: job.status, title: job.meta?.title, link: job.videoUrl || null, previousLink: job.oldLink || null,
      cover: job.coverSet ? 'set' : job.coverError ? `not set: ${job.coverError}` : job.cover?.mode === 'none' ? "YouTube's frame" : 'pending',
      ...(job.status === 'awaiting_file' ? { page: jobs.pageUrl(job) } : {}), ...(job.error ? { error: job.error } : {}),
      ...(highlightsShown(job) ? { highlights: highlightsShown(job) } : {}) };
  }

  async function cancel(input) {
    const job = await pick(input, ['draft', 'awaiting_file']);
    if (!['draft', 'awaiting_file'].includes(job.status)) throw new Error(`an upload that is ${job.status} cannot be cancelled here`);
    await jobs.patchJob(db, job.id, { status: 'cancelled' });
    return { cancelled: true, player: job.target?.name };
  }

  const highlightsShown = (job) => {
    const h = jobs.highlightsOf(job);
    return h && h.ok ? jobs.highlightsText(h) : null;
  };

  const actions = { draft, confirm, cover, status, cancel };
  return {
    youtube_style: style,
    youtube_upload: async (input) => {
      const fn = actions[input.action];
      if (!fn) throw new Error(`unknown action ${input.action}`);
      return fn(input);
    },
  };
}

async function defaultKick(body) {
  const base = (process.env.URL || 'https://goldas-crm.netlify.app').replace(/\/$/, '');
  const res = await fetch(`${base}/.netlify/functions/youtube-upload-background`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('golda-youtube')) }, body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) throw new Error(`the upload did not start (${res.status})`);
}

module.exports = { youtubeTools, YOUTUBE_TOOL_DEFS, TARGETS };
