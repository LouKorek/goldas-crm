// Highlights: the upload page cuts chosen moments out of a match video in the
// browser and uploads only them (apps/web/src/lib/highlights-cut.js).
//
// What is checked here, against the real build in a real Chromium:
//   1. the rules of the cut, packet by packet, on a stand-in recording that is
//      hard to cut (pictures stored out of order, open groups; see
//      highlights-source.js): every clip starts at the keyframe at or before
//      its moment, nothing a kept picture leans on is missing, no picture is
//      skipped inside a clip, the sound has no hole and stays with its picture;
//   2. the same through the page, with the output caught on its way to
//      YouTube, for a recording far larger than what the reader keeps in
//      memory: the page reads little more than the moments and its memory
//      does not follow the size of the file;
//   3. a real video (VP9 + Opus, made in the page with a frame counter drawn
//      on every picture and a beep every second): the cut is decoded again in
//      the browser, the counters come out in the right order and the beeps
//      where the pictures say they should be;
//   4. a file that cannot be cut is refused with a sentence, and nothing is sent.
//   5. a connection that drops in the middle of the upload: the cut is made
//      only once, so the page must go on from inside the piece it still holds.
//
// Not checked here, because it cannot be: iPhone Safari, real 4-6 GB phone
// recordings (HEVC in MOV), the screen going to sleep, and what YouTube makes
// of the file. Chromium here has no H.264 or AAC encoder, so the real video is
// VP9 + Opus; H.264 + AAC is covered by the stand-in recording only.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { prepareCut } from '../apps/web/src/lib/highlights-cut.js';
import { writeMatch, matchBlob, readCut, packetsOf, leansOn, FPS, GOP, SOUND } from './highlights-source.js';

const TOKEN = 'b'.repeat(48);
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=HIGHLIGHTS';
const MB = 1024 * 1024;
const PIECE = 8 * MB;
const TINY = 0.0006;                          // times are fractions; this is "the same time"

// Four moments, each chosen for what its edges land on (pictures are numbered from 0, 25 a second):
//   1. starts between keyframes, ends on a P picture
//   2. starts exactly on a keyframe (the picture stored after it but shown before it must go),
//      ends on the last picture of an open group, which leans on the NEXT keyframe
//   3. ends on a B picture, which leans on a P picture shown after the end
//   4. an ordinary one near the end
const MOMENTS = [{ start: 10.3, end: 25.1 }, { start: 40, end: 55.98 }, { start: 71.5, end: 86.05 }, { start: 100.9, end: 115 }];
const LAST_SHOWN = [627, 1400, 2153, 2874];   // the last picture each clip must hold, by the rules above
const shifted = (seconds) => MOMENTS.map((m) => ({ start: m.start + seconds, end: m.end + seconds }));

/** Checks a cut of a stand-in recording against the rules. Returns what it found, for the report. */
function checkCut(cut, moments, total, lastShown) {
  const shift = Math.round(moments[0].start - MOMENTS[0].start) * FPS;
  // The pictures, clip by clip, in the order they are stored.
  let at = 0, from = 0;
  const starts = [];
  moments.forEach((m, k) => {
    const key = Math.floor((m.start * FPS + TINY) / GOP) * GOP;
    const last = lastShown[k] + shift;
    const clip = cut.pictures.slice(from, from + last - key + 1);
    from += clip.length;
    starts.push({ key, at, lead: m.start - key / FPS });
    const frames = clip.map((p) => p.frame);
    // It starts at the keyframe at or before the moment, and that keyframe is stored first.
    expect(key / FPS, `clip ${k + 1} starts at or before its moment`).toBeLessThanOrEqual(m.start);
    expect(m.start - key / FPS, `clip ${k + 1} starts less than one group early`).toBeLessThan(GOP / FPS);
    expect([clip[0].frame, clip[0].key], `clip ${k + 1} opens with its keyframe`).toEqual([key, true]);
    // Every picture from the keyframe to the end, each once: nothing skipped, nothing from before the cut.
    expect([...frames].sort((a, b) => a - b), `clip ${k + 1} holds every picture once`).toEqual(Array.from({ length: last - key + 1 }, (_, i) => key + i));
    // It reaches the end of the moment, and goes past it only as far as a kept picture needs.
    expect((last + 1) / FPS, `clip ${k + 1} reaches the end of its moment`).toBeGreaterThanOrEqual(m.end - TINY);
    // Every kept picture can be decoded: what it leans on is in the clip, stored before it.
    const placed = new Map(frames.map((f, i) => [f, i]));
    const broken = frames.filter((f) => leansOn(f, total).some((need) => !(placed.get(need) < placed.get(f))));
    expect(broken, `clip ${k + 1}: pictures whose reference is missing or stored later`).toEqual([]);
    // Each picture is shown where it was, counted from the start of its clip.
    const late = clip.filter((p) => Math.abs(p.t - (at + (p.frame - key) / FPS)) > TINY);
    expect(late, `clip ${k + 1}: pictures at the wrong time`).toEqual([]);
    at += (last - key + 1) / FPS;
  });
  expect(cut.pictures.length, 'no pictures beyond the clips').toBe(from);
  expect(Math.abs(cut.videoLength - at), 'the video is as long as its clips').toBeLessThan(TINY);

  // The sound: one packet after another with no hole and no overlap ...
  const holes = cut.sounds.filter((s, i) => i && Math.abs(s.t - (cut.sounds[i - 1].t + SOUND)) > TINY);
  expect(holes, 'holes or overlaps in the sound').toEqual([]);
  expect(Math.abs(cut.sounds[0].t), 'the sound starts with the video').toBeLessThan(TINY);
  // ... each packet within half a packet of the picture it belongs to, in every clip (so the error does not add up) ...
  let clipOf = 0;
  const drift = cut.sounds.map((s, i) => {
    if (i && s.n !== cut.sounds[i - 1].n + 1) clipOf++;
    const c = starts[clipOf];
    return s.t - (s.n * SOUND - c.key / FPS + c.at);
  });
  expect(clipOf, 'one run of sound per clip').toBe(moments.length - 1);
  const worst = Math.max(...drift.map(Math.abs));
  expect(worst, 'sound further than half a packet from its picture').toBeLessThanOrEqual(SOUND / 2 + TINY);
  // ... and as long as the pictures, to within a packet.
  expect(Math.abs(cut.audioLength - cut.videoLength), 'sound and video end together').toBeLessThanOrEqual(SOUND + TINY);
  return { seconds: at, pictures: from, sounds: cut.sounds.length, worstSyncMs: Math.round(worst * 10000) / 10, leads: starts.map((s) => Math.round(s.lead * 100) / 100) };
}

async function bytesOf(stream) {
  const parts = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

/** The server and YouTube, stood in for: gives the page its moments and catches what it uploads. */
async function standIns(page, moments) {
  const seen = { sessions: [], pieces: [], done: [] };
  await page.route('**/.netlify/functions/youtube-upload**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ json: {
        status: 'awaiting_file', player: 'Noam Barzilay', title: 'Noam Barzilay | Highlights | 2026/27', privacy: 'unlisted', link: null,
        highlights: { moments, total: moments.reduce((n, m) => n + m.end - m.start, 0) },
      } });
    }
    const body = JSON.parse(req.postData());
    if (body.action === 'session') { seen.sessions.push(body); return route.fulfill({ json: { uploadUrl: UPLOAD } }); }
    seen.done.push(body);
    return route.fulfill({ json: { link: `https://youtu.be/${body.videoId}` } });
  });
  await page.route('https://www.googleapis.com/upload/**', async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Range' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': 'content-range' } });
    const [, from, to, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(route.request().headers()['content-range']).map(Number);
    seen.pieces.push({ from, to, total, bytes: route.request().postDataBuffer() });
    if (to + 1 === total) return route.fulfill({ status: 200, headers: cors, json: { id: 'HIGHvideo01' } });
    return route.fulfill({ status: 308, headers: { ...cors, range: `bytes=0-${to}` } });
  });
  return seen;
}

/** What went to YouTube, as one file; the pieces must follow one another and add up to the announced size. */
function uploaded(seen) {
  const total = seen.sessions[0].size;
  let at = 0;
  for (const p of seen.pieces) {
    expect([p.from, p.total, p.bytes.length], 'each piece follows the one before').toEqual([at, total, p.to - p.from + 1]);
    at = p.to + 1;
  }
  expect(at, 'the pieces add up to the size announced up front').toBe(total);
  return Buffer.concat(seen.pieces.map((p) => p.bytes));
}

/** Counts the bytes the page really reads from the picked file, and writes down what the progress line says. Once for a page: it stays for every load. */
async function instrument(page) {
  await page.addInitScript(() => {
    window.__read = { bytes: 0 };
    const stream = Blob.prototype.stream;
    Blob.prototype.stream = function counted() {
      const inner = stream.call(this).getReader();
      return new ReadableStream({
        async pull(c) { const r = await inner.read(); if (r.done) c.close(); else { window.__read.bytes += r.value.byteLength; c.enqueue(r.value); } },
        cancel: (reason) => inner.cancel(reason),
      }, { highWaterMark: 0 });
    };
    window.__said = [];
    new MutationObserver(() => {
      const text = document.querySelector('p[aria-live]')?.textContent;
      if (text && window.__said[window.__said.length - 1] !== text) window.__said.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

/** The most memory the page holds while it works: what is still alive after a collection, sampled ten times a second. */
async function watchMemory(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  let peak = 0, on = true;
  const loop = (async () => {
    while (on) {
      await cdp.send('HeapProfiler.collectGarbage');
      const use = await cdp.send('Runtime.getHeapUsage');
      peak = Math.max(peak, use.usedSize + (use.backingStorageSize || 0));
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return { stop: async () => { on = false; await loop; await cdp.detach(); return peak; } };
}

/** Opens the page for a highlights job, picks `file`, waits until it says the highlights are up. Call instrument(page) first. */
async function cutThroughThePage(page, moments, file) {
  const seen = await standIns(page, moments);
  await page.goto(`/yt/${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'העלאת רגעים נבחרים ליוטיוב' })).toBeVisible();
  const memory = await watchMemory(page);
  await page.setInputFiles('input[type=file]', file);
  await expect(page.getByRole('heading', { name: 'הרגעים הנבחרים עלו' })).toBeVisible({ timeout: 120_000 });
  const peak = await memory.stop();
  const read = await page.evaluate(() => window.__read.bytes);
  const said = await page.evaluate(() => window.__said);
  return { seen, peak, read, said, bytes: uploaded(seen) };
}

test.describe('highlights', () => {
  test.setTimeout(240_000);
  // The app's service worker would answer for the stand-ins below; the cut does not depend on it.
  test.use({ serviceWorkers: 'block' });

  test('the rules of the cut hold packet by packet, in both kinds of MP4', async ({}, info) => {
    const seconds = 120;
    const match = await matchBlob({ dir: info.outputDir, seconds, frameBytes: 2000 });
    const found = {};
    for (const container of ['mp4', 'fmp4']) {
      const steps = [];
      const cut = await prepareCut(match, MOMENTS, { container, onProgress: (p) => steps.push(p.step === 'cutting' ? `${p.clip}/${p.clips}` : p.step) });
      expect(steps).toEqual(['reading', '1/4', '2/4', '3/4', '4/4']);
      const bytes = await bytesOf(cut.stream());
      expect(bytes.length, `${container}: the size promised before the upload is the size delivered`).toBe(cut.size);
      const read = await readCut(bytes);
      expect([read.videoCodec, read.audioCodec]).toEqual(['avc', 'aac']);
      found[container] = { read, report: checkCut(read, MOMENTS, seconds * FPS, LAST_SHOWN) };
      expect(cut.clips.map((c) => [c.from, c.moments]), 'the page is told where each clip really starts').toEqual([[10, [0]], [40, [1]], [70, [2]], [100, [3]]]);
      expect(Math.abs(cut.duration - found[container].report.seconds)).toBeLessThan(SOUND + TINY);
      cut.close();
    }
    // The ordinary MP4 has its index at the front (YouTube asks for that) and no fragments.
    const head = (await bytesOf((await prepareCut(match, MOMENTS)).stream())).subarray(0, 64).toString('latin1');
    expect(head.indexOf('moov'), 'the index comes right after the file type').toBeGreaterThan(0);
    expect(head.indexOf('moov')).toBeLessThan(48);
    // Both kinds hold the same pictures and sound at the same times.
    const plain = (c) => [c.read.pictures.map((p) => [p.frame, Math.round(p.t * 1000)]), c.read.sounds.map((s) => [s.n, Math.round(s.t * 1000)])];
    expect(plain(found.fmp4)).toEqual(plain(found.mp4));
    info.annotations.push({ type: 'cut', description: JSON.stringify(found.mp4.report) });
    console.log('[highlights] rules:', JSON.stringify(found.mp4.report));
  });

  test('moments whose keyframes run into each other become one clip; a moment past the end is refused', async ({}, info) => {
    const match = await matchBlob({ dir: info.outputDir, seconds: 60, frameBytes: 1500 });
    // The second moment's keyframe (20.0) lies inside the first clip, which ends at 20.5. The joined clip ends at
    // 26.0, on a keyframe: that keyframe (650) is kept, because the picture shown just before it leans on it.
    const cut = await prepareCut(match, [{ start: 12.2, end: 20.5 }, { start: 21.5, end: 26 }, { start: 40.1, end: 44 }]);
    expect(cut.clips.map((c) => [c.from, c.moments])).toEqual([[12, [0, 1]], [40, [2]]]);
    const read = await readCut(await bytesOf(cut.stream()));
    const shown = read.pictures.map((p) => p.frame).sort((a, b) => a - b);
    expect([shown[0], shown.indexOf(1000) - 1, shown[shown.indexOf(1000) - 1]], 'one run from 12.0 to 26.0, nothing twice').toEqual([300, 350, 650]);
    expect(new Set(shown).size).toBe(shown.length);
    cut.close();
    await expect(prepareCut(match, [{ start: 12, end: 20 }, { start: 4259, end: 4277 }])).rejects.toMatchObject({ name: 'CutError', code: 'past_end', vars: { n: 2, at: '70:59', length: '1:00' } });
  });

  test('through the page: a recording far larger than memory is cut by reading little more than the moments', async ({ page }, info) => {
    const small = info.outputPath('match-2min.mp4'), large = info.outputPath('match-20min.mp4');
    const sizes = { small: await writeMatch(small, { seconds: 120 }), large: await writeMatch(large, { seconds: 1200 }) };
    expect(sizes.small, 'even the small one is larger than what the reader keeps (8 MB)').toBeGreaterThan(2 * PIECE);
    expect(sizes.large).toBeGreaterThan(9 * sizes.small);

    await instrument(page);
    const runs = {};
    for (const [name, file, moments, total] of [['small', small, MOMENTS, 120 * FPS], ['large', large, MOMENTS, 1200 * FPS], ['largeLate', large, shifted(1000), 1200 * FPS]]) {
      const run = await cutThroughThePage(page, moments, file);
      const report = checkCut(await readCut(run.bytes), moments, total, LAST_SHOWN);
      runs[name] = { ...run, report };
      // The server was told what was cut, and that is what went up: an MP4 of the cut's length, in pieces.
      expect(run.seen.sessions).toEqual([{ t: TOKEN, action: 'session', size: run.bytes.length, type: 'video/mp4', cut: { seconds: expect.closeTo(report.seconds, 1), clips: 4 } }]);
      expect(run.seen.pieces.map((p) => p.to - p.from + 1), 'two pieces: 8 MB and the rest').toEqual([PIECE, run.bytes.length - PIECE]);
      expect(run.seen.done).toEqual([{ t: TOKEN, action: 'done', videoId: 'HIGHvideo01' }]);
      // The page said what it was doing: reading, each clip, then the upload.
      expect(run.said[0]).toBe('קורא את הסרטון…');
      expect(run.said.filter((s) => s.startsWith('חותך את הרגעים')).map((s) => s.slice(-3))).toEqual(['1/4', '2/4', '3/4', '4/4']);
      expect(run.said.some((s) => /^מעלה את הרגעים · \d+% · /.test(s))).toBe(true);
      await page.unrouteAll({ behavior: 'wait' });
      await page.goto('about:blank');
    }
    // The same moments give the same cut wherever they sit and however long the recording is.
    expect(runs.large.bytes.length).toBe(runs.small.bytes.length);
    expect(runs.large.report).toEqual(runs.small.report);

    const numbers = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { fileMB: Math.round(sizes[k === 'small' ? 'small' : 'large'] / MB), cutMB: Math.round(r.bytes.length / MB * 10) / 10, readMB: Math.round(r.read / MB * 10) / 10, peakMemoryMB: Math.round(r.peak / MB * 10) / 10 }]));
    console.log('[highlights] through the page:', JSON.stringify(numbers));
    info.annotations.push({ type: 'memory', description: JSON.stringify(numbers) });
    // Reading: the moments twice (once to measure, once to send), the index, and what the file reader takes past
    // the end of a clip (it reads in blocks of up to 4 MB); not the recording.
    const cutSize = runs.small.bytes.length;
    for (const name of ['large', 'largeLate']) {
      expect(runs[name].read, `${name}: reads about the moments twice`).toBeLessThan(2 * cutSize + 3 * PIECE);
      expect(runs[name].read, `${name}: reads a small part of the recording`).toBeLessThan(sizes.large / 4);
      // Memory: a ten times larger recording may cost its larger index, not its size.
      expect(runs[name].peak - runs.small.peak, `${name}: memory does not follow the size of the recording`).toBeLessThan(40 * MB);
      expect(runs[name].peak, `${name}: memory stays far below the recording`).toBeLessThan(sizes.large / 3);
    }
    fs.rmSync(small); fs.rmSync(large);
  });

  test('a dropped connection: the upload of the cut goes on from where YouTube says it stopped', async ({ page }, info) => {
    const file = info.outputPath('match.mp4');
    await writeMatch(file, { seconds: 120 });
    const seen = await standIns(page, MOMENTS);
    // A YouTube that keeps only 5 MB of the first piece, then loses the connection one more MB into the next.
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Range' };
    const sent = [];
    let got = null, held = 0;
    await page.route('https://www.googleapis.com/upload/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': 'content-range' } });
      const range = req.headers()['content-range'];
      const stillThere = () => route.fulfill({ status: 308, headers: { ...cors, range: `bytes=0-${held - 1}` } });
      if (/^bytes \*\/\d+$/.test(range)) { sent.push('how much arrived?'); return stillThere(); }
      const [, from, to, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range).map(Number);
      const body = req.postDataBuffer();
      const nth = sent.filter((x) => x !== 'how much arrived?').length;
      sent.push([from, to + 1 - from]);
      expect(from, 'a piece starts where YouTube stopped').toBe(held);
      got ||= Buffer.alloc(total);
      const keep = nth === 0 ? 5 * MB : nth === 1 ? MB : body.length;
      body.copy(got, from, 0, keep);
      held = from + keep;
      if (nth === 1) return route.abort('connectionreset');
      if (held === total) return route.fulfill({ status: 200, headers: cors, json: { id: 'HIGHvideo01' } });
      return stillThere();
    });
    await page.goto(`/yt/${TOKEN}`);
    await page.setInputFiles('input[type=file]', file);
    await expect(page.getByRole('heading', { name: 'הרגעים הנבחרים עלו' })).toBeVisible({ timeout: 60_000 });
    const total = seen.sessions[0].size;
    expect(sent, 'the first piece, the rest from 5 MB, a question, the rest from 6 MB').toEqual([[0, PIECE], [5 * MB, total - 5 * MB], 'how much arrived?', [6 * MB, total - 6 * MB]]);
    // What YouTube holds in the end is the whole cut, and it is right.
    checkCut(await readCut(got), MOMENTS, 120 * FPS, LAST_SHOWN);
    expect(seen.done).toEqual([{ t: TOKEN, action: 'done', videoId: 'HIGHvideo01' }]);
    fs.rmSync(file);
  });

  test('a real video: the cut decodes, the frame counters are in order and the beeps are where the pictures are', async ({ page }, info) => {
    const fps = 25, seconds = 24, keyEvery = 2;
    const moments = [{ start: 3.3, end: 6.1 }, { start: 10, end: 12.3 }, { start: 17.9, end: 21.02 }];
    await page.route('**/__mediabunny.mjs', (route) => route.fulfill({ path: 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', contentType: 'text/javascript' }));
    const seen = await standIns(page, moments);
    await page.goto(`/yt/${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'העלאת רגעים נבחרים ליוטיוב' })).toBeVisible();

    // Make the video in the page: every picture carries its number as sixteen bars (and in digits), a keyframe
    // every two seconds; the sound is a quiet hiss with a short beep half a second into every second.
    const made = await page.evaluate(async ({ fps, seconds, keyEvery }) => {
      const M = await import('/__mediabunny.mjs');
      const canvas = new OffscreenCanvas(320, 180);
      const ctx = canvas.getContext('2d');
      const target = new M.BufferTarget();
      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: false }), target });
      const video = new M.CanvasSource(canvas, { codec: 'vp9', bitrate: 600000, keyFrameInterval: keyEvery });
      const audio = new M.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
      output.addVideoTrack(video, { frameRate: fps });
      output.addAudioTrack(audio);
      await output.start();
      const rate = 48000;
      let seed = 12345;
      for (let s = 0; s < seconds; s++) {
        const buffer = new AudioBuffer({ length: rate, sampleRate: rate, numberOfChannels: 1 });
        const data = buffer.getChannelData(0);
        for (let i = 0; i < rate; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const beep = i >= rate / 2 && i < rate / 2 + rate / 100;
          data[i] = beep ? 0.8 * Math.sin((2 * Math.PI * 2000 * i) / rate) : (seed / 0x7fffffff - 0.5) * 0.02;
        }
        await audio.add(buffer);
        for (let f = s * fps; f < (s + 1) * fps; f++) {
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = '#fff';
          for (let bit = 0; bit < 16; bit++) if ((f >> bit) & 1) ctx.fillRect(bit * 20, 0, 20, 90);
          ctx.font = '48px sans-serif'; ctx.fillText(String(f), 20, 150);
          await video.add(f / fps, 1 / fps);
        }
      }
      await output.finalize();
      const bytes = new Uint8Array(target.buffer);
      let text = '';
      for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(text);
    }, { fps, seconds, keyEvery });
    const source = Buffer.from(made, 'base64');
    const file = info.outputPath('real.mp4');
    fs.writeFileSync(file, source);

    await page.setInputFiles('input[type=file]', file);
    await expect(page.getByRole('heading', { name: 'הרגעים הנבחרים עלו' })).toBeVisible({ timeout: 120_000 });
    const cut = uploaded(seen);

    // Packet by packet: the cut holds the source's own packets, untouched, found again by their bytes.
    const sha = (data) => crypto.createHash('sha1').update(data).digest('hex');
    const src = await packetsOf(source, sha), out = await packetsOf(cut, sha);
    expect(src.codecs).toEqual(['vp9', 'opus']);
    expect(out.codecs).toEqual(['vp9', 'opus']);
    const keys = src.video.filter((p) => p.key).map((p) => p.t);
    expect(keys, 'the source has a keyframe every two seconds').toEqual(Array.from({ length: seconds / keyEvery }, (_, i) => i * keyEvery));
    // What the rules say the cut must hold.
    let at = 0;
    const clips = moments.map((m) => {
      const key = Math.max(...keys.filter((k) => k <= m.start + TINY));
      const pictures = src.video.filter((p) => p.t >= key - TINY && p.t < m.end - TINY);
      const clip = { key, at, pictures, to: pictures[pictures.length - 1].t + 1 / fps };
      at += clip.to - key;
      return clip;
    });
    expect(clips.map((c) => c.key), 'each clip starts at the keyframe at or before its moment').toEqual([2, 10, 16]);
    const wanted = clips.flatMap((c) => c.pictures.map((p) => ({ hash: p.hash, t: p.t - c.key + c.at })));
    expect(out.video.map((p) => p.hash), 'the pictures of the three clips, byte for byte, in order').toEqual(wanted.map((p) => p.hash));
    expect(out.video.filter((p, i) => Math.abs(p.t - wanted[i].t) > TINY), 'pictures at the wrong time').toEqual([]);
    // The sound: source packets, one after another, each within half a packet of its picture's clock.
    const soundAt = new Map(src.audio.map((p) => [p.hash, p.t]));
    expect(soundAt.size, 'every sound packet of the source is different, so it can be found again').toBe(src.audio.length);
    expect(out.audio.filter((p, i) => i && Math.abs(p.t - (out.audio[i - 1].t + out.audio[i - 1].d)) > TINY), 'holes in the sound').toEqual([]);
    const packet = src.audio[1].t - src.audio[0].t;
    let clipOf = 0;
    const drift = out.audio.map((p, i) => {
      const was = soundAt.get(p.hash);
      expect(was, 'a sound packet that is not in the source').not.toBeUndefined();
      if (i && was - soundAt.get(out.audio[i - 1].hash) > 1) clipOf++;
      return p.t - (was - clips[clipOf].key + clips[clipOf].at);
    });
    expect(clipOf).toBe(2);
    expect(Math.max(...drift.map(Math.abs)), 'sound further than half a packet from its picture').toBeLessThanOrEqual(packet / 2 + TINY);

    // Decoded again in the browser: the counter on every picture, and when the beeps sound.
    const decoded = await page.evaluate(async (base64) => {
      const M = await import('/__mediabunny.mjs');
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const input = new M.Input({ source: new M.BufferSource(bytes), formats: [M.MP4] });
      const canvas = new OffscreenCanvas(320, 180);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const frames = [];
      for await (const sample of new M.VideoSampleSink(await input.getPrimaryVideoTrack()).samples()) {
        sample.draw(ctx, 0, 0, 320, 180);
        const row = ctx.getImageData(0, 45, 320, 1).data;
        let number = 0;
        for (let bit = 0; bit < 16; bit++) if (row[(bit * 20 + 10) * 4] > 128) number |= 1 << bit;
        frames.push([number, sample.timestamp]);
        sample.close();
      }
      const beeps = [];
      let lastLoud = -1;
      for await (const sample of new M.AudioSampleSink(await input.getPrimaryAudioTrack()).samples()) {
        const data = sample.toAudioBuffer().getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          if (Math.abs(data[i]) < 0.3) continue;
          const t = sample.timestamp + i / sample.sampleRate;
          if (t - lastLoud > 0.2) beeps.push(t);
          lastLoud = t;
        }
        sample.close();
      }
      return { frames, beeps };
    }, cut.toString('base64'));
    // Every picture decodes (also the first of each clip, which has nothing before it) and shows the right number at the right time.
    const numbers = clips.flatMap((c) => c.pictures.map((p) => [Math.round(p.t * fps), p.t - c.key + c.at]));
    expect(decoded.frames.map((f) => f[0]), 'the counters read from the decoded pictures').toEqual(numbers.map((n) => n[0]));
    expect(decoded.frames.filter((f, i) => Math.abs(f[1] - numbers[i][1]) > TINY)).toEqual([]);
    // Every beep of the source that falls inside a clip is heard where its picture is shown (to a fortieth of a second).
    const expectedBeeps = clips.flatMap((c) => Array.from({ length: seconds }, (_, s) => s + 0.5).filter((b) => b > c.key && b < c.to).map((b) => b - c.key + c.at));
    expect(decoded.beeps.length, 'as many beeps as the clips hold').toBe(expectedBeeps.length);
    const off = decoded.beeps.map((b, i) => Math.abs(b - expectedBeeps[i]));
    expect(Math.max(...off), 'a beep away from its picture').toBeLessThan(1 / 40);
    const report = { sourceKB: Math.round(source.length / 1024), cutKB: Math.round(cut.length / 1024), pictures: out.video.length, cutSeconds: Math.round(at * 100) / 100, beeps: decoded.beeps.length, worstBeepMs: Math.round(Math.max(...off) * 10000) / 10, worstPacketMs: Math.round(Math.max(...drift.map(Math.abs)) * 10000) / 10 };
    console.log('[highlights] real video:', JSON.stringify(report));
    info.annotations.push({ type: 'real', description: JSON.stringify(report) });
  });

  test('a file that cannot be cut is refused in a sentence, and nothing is sent', async ({ page }, info) => {
    const seen = await standIns(page, MOMENTS);
    await page.goto(`/yt/${TOKEN}`);
    await expect(page.locator('main')).toContainText('0:10–0:25');             // the moments, as times in the file
    await expect(page.locator('main')).toContainText('בערך 0:59');
    // Not a video container at all.
    await page.setInputFiles('input[type=file]', { name: 'match.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(300000, 7) });
    await expect(page.getByRole('alert')).toHaveText('אי אפשר לחתוך כאן קובץ מהסוג הזה. בחר את הצילום המקורי, בפורמט MP4 או MOV.');
    // A real container that is too short for the moments: the wrong file.
    const short = info.outputPath('short.mp4');
    await writeMatch(short, { seconds: 30, frameBytes: 1000 });
    await page.setInputFiles('input[type=file]', short);
    await expect(page.getByRole('alert')).toHaveText('רגע 2 מתחיל ב-0:40, אבל הסרטון הזה באורך 0:30 בלבד. בדוק שזה הקובץ הנכון.');
    await expect(page.getByRole('button', { name: 'בחר את סרטון המשחק' })).toBeVisible();
    expect([seen.sessions.length, seen.pieces.length, seen.done.length], 'YouTube was never opened').toEqual([0, 0, 0]);
    fs.rmSync(short);
  });
});
