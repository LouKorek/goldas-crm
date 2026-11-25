// Cutting a match video down to its highlights, in the browser.
//
// The upload page (pages/YouTubeUpload.jsx) gets a list of moments from the
// upload job and the full match file from the phone. This file copies the
// moments out of that file into one new MP4 and hands it over as a stream of
// bytes that goes straight into the YouTube upload, so the match file never
// leaves the phone and no more than a few megabytes sit in memory at a time.
//
// Nothing is re-encoded: the compressed pictures and sound are copied as they
// are (mediabunny reads and writes the containers). That is why
//   - a moment starts at the keyframe at or before its start, so it may begin
//     a second or two early (a picture can only be decoded from a keyframe);
//   - moments are joined with hard cuts, no fades and no titles;
//   - a file whose video or sound is in a format an MP4 cannot hold as it is
//     gets refused with a plain sentence (CutError) and nothing is uploaded.
//
// How one cut runs (prepareCut):
//   1. open    read the file's index, check container and codecs
//   2. plan    walk the index only (no media is read): which pictures and
//              sound packets belong to each moment, where every moment really
//              starts and ends, how many packets there are
//   3. rehearse  write the whole output once into a counter that keeps only
//              the file's header. This gives the exact size (YouTube wants it
//              up front, and the progress bar needs it) and the finished
//              header, which an MP4 only knows at the end.
//   4. check   read that header back: it must describe the plan.
//   5. stream  (cut.stream()) write the output a second time, now in order:
//              the finished header first, then the media. Before the last
//              piece is released the second run must have produced the same
//              header as the first; otherwise the stream fails and YouTube
//              never gets a complete file.
//
// mediabunny is loaded here, on demand, so only this page pays for it.

import { formatClock } from '@goldas/domain';

// Named one by one, so the bundler leaves out the parts of the library that are not used here.
const lib = async () => {
  const {
    Input, BlobSource, BufferSource, MP4, QTFF, EncodedPacketSink,
    Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource,
  } = await import('mediabunny');
  return {
    Input, BlobSource, BufferSource, MP4, QTFF, EncodedPacketSink,
    Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource,
  };
};

/**
 * The one place that decides what kind of file goes to YouTube.
 *   'mp4'   an ordinary MP4 with its index at the front ("fast start"), which
 *           is the layout YouTube's upload guidelines ask for. The default.
 *   'fmp4'  a fragmented MP4. Kept as a switch: if a live test ever shows
 *           YouTube mishandling the ordinary file, change DEFAULT_CONTAINER.
 * Both go through the same two runs, so nothing else changes with it.
 */
export const DEFAULT_CONTAINER = 'mp4';
export const OUTPUT_MIME = 'video/mp4';
function outputFormat(m, container) {
  return new m.Mp4OutputFormat({ fastStart: container === 'fmp4' ? 'fragmented' : 'reserve' });
}

/** Sound formats that are copied packet by packet (each packet stands alone). */
const AUDIO_COPYABLE = ['aac', 'opus', 'mp3'];
/** How many packets ahead to look for a picture that is shown before the cut but stored after it. */
const LOOKAHEAD = 8;
/** Spare room in the header for packets the plan did not count. */
const PACKET_HEADROOM = 64;
/** The start of the output that the rehearsal keeps as it was first written (the file-type box sits here). */
const KEEP_HEAD = 4096;
/** How far the written length may differ from the plan, in seconds, before the output is refused. */
const DURATION_SLACK = 0.5;
/**
 * The furthest a clip may start before its moment, in seconds. Cameras and
 * phones store a keyframe every second or two; a file with keyframes further
 * apart than this would give highlights that open on long stretches nobody
 * asked for. The server refuses a longer cut too (youtube-upload.js, CUT_LEAD).
 */
const MAX_LEAD = 30;
/** Two times closer than this, in seconds, count as the same time (times are fractions that do not divide evenly). */
const TIE = 0.0005;
/** How long the cut may run, in milliseconds, before it lets the page draw and answer a touch. */
const BREATH_EVERY = 40;
/** A file whose first picture is later than this is on its own clock (a recording cut from a stream): moments count from its first picture. */
const OWN_CLOCK_FROM = 1;

/**
 * Something about the file or the moments that stops the cut. `message` is an
 * English sentence that is also the key of its Hebrew translation
 * (i18n/he.js); `vars` fills its {placeholders}.
 */
export class CutError extends Error {
  constructor(code, message, vars = null) {
    super(message);
    this.name = 'CutError';
    this.code = code;
    this.vars = vars;
  }
}
const MESSAGES = {
  format: 'This file is not a kind of video that can be cut here. Pick the original MP4 or MOV recording.',
  no_video: 'There is no video in this file. Pick the match recording.',
  video_codec: 'The video in this file is in a format ({codec}) that cannot be cut without converting it. Pick an MP4 or MOV recording.',
  audio_codec: 'The sound in this file is in a format ({codec}) that cannot be copied as it is. Export the video as MP4 and pick that file.',
  past_end: 'Moment {n} starts at {at}, but this video is only {length} long. Check that this is the right file.',
  no_keyframe: 'This video has no point to cut at. Pick the original recording.',
  sparse: 'This video can only be cut {seconds} seconds before moment {n}, which is too early. Export it again as MP4 and pick that file.',
  broken: 'The cut did not come out right, so nothing was uploaded. Pick the video again.',
};
const fail = (code, vars) => new CutError(code, MESSAGES[code], vars);
export const CUT_MESSAGES = MESSAGES;

// ── 1. open ──────────────────────────────────────────────────────────────────
async function openSource(m, file, container) {
  const input = new m.Input({ source: new m.BlobSource(file), formats: [m.MP4, m.QTFF] });
  try {
    if (!(await input.canRead())) throw fail('format');
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw fail('no_video');
    const format = outputFormat(m, container);
    const supported = format.getSupportedCodecs();
    const named = async (track) => (await track.getCodec()) || String((await track.getInternalCodecId()) || '?');
    const videoCodec = await video.getCodec();
    const videoConfig = videoCodec && supported.includes(videoCodec) ? await video.getDecoderConfig() : null;
    if (!videoConfig) throw fail('video_codec', { codec: await named(video) });
    const audio = await input.getPrimaryAudioTrack();
    const audioCodec = audio ? await audio.getCodec() : null;
    let audioConfig = null;
    if (audio) {
      audioConfig = audioCodec && AUDIO_COPYABLE.includes(audioCodec) && supported.includes(audioCodec) ? await audio.getDecoderConfig() : null;
      if (!audioConfig) throw fail('audio_codec', { codec: await named(audio) });
    }
    const first = await video.getFirstTimestamp();
    return {
      input, video, audio, videoCodec, audioCodec, videoConfig, audioConfig,
      base: first > OWN_CLOCK_FROM ? first : 0,
      end: await video.computeDuration(),          // where the last picture ends, on the file's clock
      matrix: await video.getTransformationMatrix(), // a phone held upright stores its turn here
    };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

// ── the walk: the same packets in the same order, every time ────────────────
/**
 * One turn of the browser's event loop. The cut is thousands of small steps
 * that can follow one another without a pause; without this the page would not
 * draw its progress line or answer a touch until a clip is done. Not a timer:
 * timers are slowed down in a tab that is not in front.
 */
const breath = () => new Promise((resolve) => {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { port1.close(); resolve(); };
  port2.postMessage(0);
});

/**
 * Reads one track packet by packet, with a look at the next packet before
 * taking it. A packet is read only when it is asked for. (The library's own
 * packet loop reads ahead, the sound far ahead of the pictures, which drags
 * the file reader back and forth over the same bytes and past the end of a
 * clip.) Read this way, pictures and sound together, the file is read once,
 * front to back.
 */
function reader(sink, first, options) {
  let held = first, last = null;
  return {
    async peek() {
      if (!held && last) { held = await sink.getNextPacket(last, options); if (!held) last = null; }
      return held;
    },
    take() { last = held; held = null; return last; },
  };
}

/** Is a picture that is shown before `end` stored after this packet? (Pictures are not always stored in the order they are shown.) */
async function shownEarlierFollows(sink, packet, end) {
  let current = packet;
  for (let i = 0; i < LOOKAHEAD; i++) {
    current = await sink.getNextPacket(current, { metadataOnly: true });
    if (!current || current.type === 'key') return false;
    if (current.timestamp < end) return true;
  }
  return false;
}

/**
 * The pictures of one moment, in the order they are stored: from the keyframe
 * on, up to the end. Pictures that are stored after the keyframe but shown
 * before it lean on what came before the cut, so they are left out. At the
 * end, a picture shown after the cut is kept only if earlier pictures lean on
 * it; then the pictures up to it are kept too, so nothing is skipped.
 */
async function* picturesOf(sink, key, end, options) {
  let closing = null;
  for (let p = key; p; p = await sink.getNextPacket(p, options)) {     // one at a time, see reader()
    if (p.timestamp < key.timestamp) continue;
    if (closing) {
      if (p.timestamp > closing.timestamp) return;
    } else if (p.timestamp >= end && p.sequenceNumber !== key.sequenceNumber) {
      if (!(await shownEarlierFollows(sink, p, end))) return;
      closing = p;
    }
    yield p;
  }
}

/**
 * Walks every clip, handing each packet with its place on the output's clock
 * to `onVideo` / `onAudio`, pictures and sound interleaved by time (the writer
 * keeps whatever runs ahead in memory, so neither track may run ahead).
 *
 * Picture timing: clip i starts at `at` on the output clock; a picture shown
 * at t in the source is shown at t - clip.from + at.
 * Sound timing: packets are laid end to end, so the sound never has a hole or
 * an overlap at a join. Which packets a clip takes is chosen so that the sound
 * is never more than half a packet (about a hundredth of a second) away from
 * its picture, and the error does not add up from clip to clip.
 */
async function walk(src, clips, { data, onVideo, onAudio, onClip }) {
  const options = data ? {} : { metadataOnly: true };
  const vsink = src.sinks.video, asink = src.sinks.audio;
  let at = 0;            // where the current clip starts on the output clock
  let soundEnd = 0;      // where the sound laid so far ends
  let breathed = Date.now();
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (onClip) { await onClip(i); await breath(); breathed = Date.now(); }   // the page shows which clip it is on
    const key = await vsink.getKeyPacket(clip.keyAt, options);
    if (!key) throw fail('broken');
    const start = at;
    const map = (t) => t - clip.from + start;
    const firstSound = asink ? (await asink.getPacket(clip.from, options)) || (await asink.getFirstPacket(options)) : null;
    const sound = firstSound ? reader(asink, firstSound, options) : null;
    // One sound packet, if the next one belongs before `limit` on the output clock.
    const soundUpTo = async (limit, whole) => {
      for (;;) {
        const a = sound && await sound.peek();
        if (!a) return false;
        const ideal = map(a.timestamp), half = a.duration / 2;
        if (ideal < soundEnd - half - TIE) { sound.take(); continue; }      // belongs to what was already laid
        if ((whole ? ideal + a.duration : ideal + half) > limit + TIE) return false;
        sound.take();
        if (ideal > soundEnd + half + TIE) soundEnd = ideal;                // the source has no sound here: leave the hole
        await onAudio(a, soundEnd);
        soundEnd += a.duration;
        return true;
      }
    };
    let shown = start, to = clip.from;
    for await (const p of picturesOf(vsink, key, clip.end, options)) {
      const t = map(p.timestamp);
      await onVideo(p, t);
      shown = Math.max(shown, t);
      to = Math.max(to, p.timestamp + p.duration);
      while (await soundUpTo(shown, true)) { /* sound catches up with the pictures */ }
      if (Date.now() - breathed >= BREATH_EVERY) { await breath(); breathed = Date.now(); }
    }
    at = map(to);
    while (await soundUpTo(at, false)) { /* the rest of this clip's sound */ }
    clip.to = to;
  }
  return { duration: Math.max(at, soundEnd) };
}

// ── 2. plan ──────────────────────────────────────────────────────────────────
/** Moments → clips: each with its keyframe. A moment whose keyframe falls inside the clip before it is joined to that clip. */
async function planClips(src, moments) {
  const sink = src.sinks.video;
  const clips = [];
  for (let n = 0; n < moments.length; n++) {
    const start = moments[n].start + src.base, end = Math.min(moments[n].end + src.base, src.end);
    if (start >= src.end || end <= start) throw fail('past_end', { n: n + 1, at: formatClock(moments[n].start), length: formatClock(src.end - src.base) });
    const key = (await sink.getKeyPacket(start, { verifyKeyPackets: true })) || (await sink.getFirstKeyPacket({ verifyKeyPackets: true }));
    if (!key || key.timestamp >= end) throw fail('no_keyframe');
    if (start - key.timestamp > MAX_LEAD) throw fail('sparse', { n: n + 1, seconds: Math.round(start - key.timestamp) });
    const last = clips[clips.length - 1];
    if (last && key.timestamp <= last.end) { last.end = Math.max(last.end, end); last.moments.push(n); continue; }
    clips.push({ keyAt: key.timestamp, from: key.timestamp, end, to: end, moments: [n] });
  }
  return clips;
}

// ── 3. rehearse and 5. stream: one writer, two ways of receiving its bytes ───
/**
 * The writer does not write the file front to back: it leaves room at the
 * front and fills it in at the end. These two sinks turn that into a plain
 * forward stream.
 *
 * counter()  first run. Keeps only what was written out of order (`patches`,
 *            in the order they came) and the first bytes; everything else is
 *            counted and dropped.
 * replay()   second run. Sends the bytes on in order, with the first run's
 *            patches laid over them, and holds back the last piece until the
 *            writer is done. What the second run writes out of order must
 *            equal the first run's patches, or the two runs differed.
 */
function counter() {
  let high = 0;
  const patches = [], head = new Uint8Array(KEEP_HEAD);
  let headLength = 0;
  return {
    writable: new WritableStream({
      write({ data, position }) {
        const late = Math.max(0, Math.min(data.length, high - position));
        if (late) patches.push({ position, data: data.slice(0, late) });
        if (position + late < KEEP_HEAD && late < data.length) {
          const part = data.subarray(late, late + KEEP_HEAD - (position + late));
          head.set(part, position + late);
          headLength = Math.max(headLength, position + late + part.length);
        }
        high = Math.max(high, position + data.length);
      },
    }),
    result: () => ({ size: high, patches, head: head.subarray(0, headLength) }),
  };
}

const overlay = (bytes, position, patches) => {
  for (const p of patches) {
    const from = Math.max(position, p.position), to = Math.min(position + bytes.length, p.position + p.data.length);
    if (from < to) bytes.set(p.data.subarray(from - p.position, to - p.position), from - position);
  }
};
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function replay(first, push) {
  let high = 0, late = 0, same = true, held = null;
  const expected = first.patches;
  return {
    writable: new WritableStream({
      async write({ data, position }) {
        const lateLength = Math.max(0, Math.min(data.length, high - position));
        if (lateLength) {
          const want = expected[late++];
          if (!want || want.position !== position || !sameBytes(want.data, data.subarray(0, lateLength))) same = false;
        }
        if (lateLength === data.length) return;
        if (position + lateLength !== high) { same = false; return; }
        const fresh = data.slice(lateLength);
        overlay(fresh, high, expected);
        high += fresh.length;
        const ready = held;
        held = fresh;
        if (ready) await push(ready);
      },
    }),
    /** After the writer finished: release the last piece, or refuse it. */
    async finish() {
      if (!same || late !== expected.length || high !== first.size) throw fail('broken');
      if (held) await push(held);
    },
  };
}

/**
 * The front of the finished file as one block, for reading it back: the first
 * bytes as they were first written, with what was filled in at the end laid
 * over them, as far as the two join up without a hole. The file-type box and
 * the whole index sit in it (the index is filled in right after the file-type
 * box); the unused part of the room left for the index comes after and is not
 * needed.
 */
function headerOf(first) {
  const parts = [{ position: 0, length: first.head.length }, ...first.patches.map((p) => ({ position: p.position, length: p.data.length }))]
    .sort((a, b) => a.position - b.position);
  const covered = parts.reduce((n, p) => (p.position <= n ? Math.max(n, p.position + p.length) : n), 0);
  const out = new Uint8Array(covered);
  out.set(first.head.subarray(0, Math.min(first.head.length, covered)));
  overlay(out, 0, first.patches);
  return out;
}

async function write(m, src, plan, writable, onClip) {
  const output = new m.Output({ format: outputFormat(m, plan.container), target: new m.StreamTarget(writable) });
  const video = new m.EncodedVideoPacketSource(src.videoCodec);
  output.addVideoTrack(video, { transformationMatrix: src.matrix, maximumPacketCount: plan.pictures + PACKET_HEADROOM });
  const audio = src.audio ? new m.EncodedAudioPacketSource(src.audioCodec) : null;
  if (audio) output.addAudioTrack(audio, { maximumPacketCount: plan.sounds + PACKET_HEADROOM });
  // The same date in both runs, so both write the same header.
  output.setMetadataTags({ creationTime: plan.createdAt });
  await output.start();
  const videoMeta = { decoderConfig: src.videoConfig }, audioMeta = { decoderConfig: src.audioConfig };
  try {
    await walk(src, plan.clips, {
      data: true, onClip,
      onVideo: (p, t) => video.add(p.clone({ timestamp: t }), videoMeta),
      onAudio: (p, t) => audio.add(p.clone({ timestamp: t }), audioMeta),
    });
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
}

// ── 4. check ─────────────────────────────────────────────────────────────────
/** Reads the finished header back: one video track (and sound, if the source has it) of the planned length and packet counts. */
async function checkHeader(m, src, plan, first) {
  if (plan.container !== 'mp4') return;
  const bytes = headerOf(first);
  const input = new m.Input({ source: new m.BufferSource(bytes), formats: [m.MP4] });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video || (await video.getCodec()) !== src.videoCodec || !!audio !== !!src.audio) throw fail('broken');
    const pictures = (await video.computePacketStats()).packetCount;
    const sounds = audio ? (await audio.computePacketStats()).packetCount : 0;
    const length = await video.computeDuration();
    if (pictures !== plan.pictures || sounds !== plan.sounds || Math.abs(length - plan.duration) > DURATION_SLACK) throw fail('broken');
  } catch (e) {
    throw e instanceof CutError ? e : fail('broken');
  } finally { input.dispose(); }
}

/**
 * Prepares the highlights of `file`.
 *   moments     [{ start, end }] in seconds of the video file, in order (from the upload job)
 *   onProgress  ({ step: 'reading' }) then ({ step: 'cutting', clip, clips }) for every clip
 *   container   only tests pass it; see DEFAULT_CONTAINER
 *
 * Resolves with
 *   size      the exact number of bytes the output has
 *   type      its MIME type
 *   duration  its length in seconds
 *   clips     [{ from, to, moments }] what was really cut, in seconds of the source
 *             (from is the keyframe, so it may be a little before the moment)
 *   stream()  a ReadableStream of the output's bytes, in order; call it once
 *   close()   lets go of the file
 * or rejects with a CutError.
 */
export async function prepareCut(file, moments, { onProgress = () => {}, container = DEFAULT_CONTAINER } = {}) {
  const m = await lib();
  onProgress({ step: 'reading' });
  let src;
  try {
    src = await openSource(m, file, container);
  } catch (e) {
    throw e instanceof CutError ? e : fail('format');
  }
  try {
    src.sinks = { video: new m.EncodedPacketSink(src.video), audio: src.audio ? new m.EncodedPacketSink(src.audio) : null };
    const clips = await planClips(src, moments);
    const plan = { container, clips, pictures: 0, sounds: 0, duration: 0, createdAt: new Date(Math.floor(Date.now() / 1000) * 1000) };
    plan.duration = (await walk(src, clips, { data: false, onVideo: () => { plan.pictures++; }, onAudio: () => { plan.sounds++; } })).duration;
    if (!plan.pictures) throw fail('no_keyframe');

    const count = counter();
    await write(m, src, plan, count.writable, (i) => onProgress({ step: 'cutting', clip: i + 1, clips: clips.length }));
    const first = count.result();
    await checkHeader(m, src, plan, first);

    let streamed = false;
    return {
      size: first.size,
      type: OUTPUT_MIME,
      duration: plan.duration,
      clips: clips.map((c) => ({ from: c.from - src.base, to: c.to - src.base, moments: c.moments })),
      stream() {
        if (streamed) throw new Error('the cut was already streamed');
        streamed = true;
        // A small buffer between the writer and whoever reads: the writer waits when the reader is slow.
        const pipe = new TransformStream({}, new ByteLengthQueuingStrategy({ highWaterMark: 1 }), new ByteLengthQueuingStrategy({ highWaterMark: 1 }));
        const out = pipe.writable.getWriter();
        const again = replay(first, (bytes) => out.write(bytes));
        write(m, src, plan, again.writable, null)
          .then(() => again.finish())
          .then(() => out.close())
          .catch((e) => out.abort(e instanceof CutError ? e : fail('broken')).catch(() => {}));
        return pipe.readable;
      },
      close() { src.input.dispose(); },
    };
  } catch (e) {
    src.input.dispose();
    if (e instanceof CutError) throw e;
    console.error('[highlights] cut failed:', e);
    throw fail('broken');
  }
}
