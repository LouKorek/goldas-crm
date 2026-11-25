// A stand-in for a match recording, for testing the highlights cut packet by
// packet (e2e/highlights.spec.js). The pictures and the sound are not real:
// every packet only carries its own number, so after a cut each packet of the
// output can be traced back to where it came from. The file is laid out the way
// cameras and phones write one that is hard to cut:
//
//   - a keyframe every two seconds (GOP = 50 pictures at 25 a second);
//   - pictures stored out of the order they are shown: after the keyframe (I)
//     comes every third picture (P), each followed by the two shown before it
//     (B), which lean on the P before and the P after them;
//   - "open" groups: the last picture of a group is shown before the next
//     keyframe but stored after it, and leans on it;
//   - the index at the end of the file, sound packets that never line up with
//     the pictures (1024 samples at 48 kHz against 25 pictures a second).
//
// It is a valid MP4 with H.264 video and AAC sound as far as a container
// reader can tell; no decoder would show anything.
import fs from 'node:fs';

// Loaded the way the page's cutter loads it, so a test and the cutter share one copy of the library.
const bunny = () => import('mediabunny');

export const FPS = 25;
export const GOP = 50;
export const SOUND = 1024 / 48000;           // seconds in one sound packet
const P_EVERY = 3;
const SOUND_BYTES = 180;
const SPS = [0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x2f, 0xf9, 0x61, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x03, 0x00, 0x3c, 0x0f, 0x16, 0x2e, 0x48];
const PPS = [0x68, 0xcb, 0x83, 0xcb, 0x20];
const AVCC = new Uint8Array([1, SPS[1], SPS[2], SPS[3], 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS]);
const VIDEO_META = { decoderConfig: { codec: 'avc1.42c01e', codedWidth: 640, codedHeight: 360, description: AVCC } };
const AUDIO_META = { decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) } };

/** What kind of picture is number f of a recording `total` pictures long. */
export function kindOf(f, total) {
  const inGroup = f % GOP;
  if (inGroup === 0) return 'I';
  if (inGroup % P_EVERY === 0 || f === total - 1) return 'P';
  return 'B';
}
/** The pictures that picture f leans on (they must be decoded before it). */
export function leansOn(f, total) {
  const kind = kindOf(f, total);
  if (kind === 'I') return [];
  let before = f - 1;
  while (kindOf(before, total) === 'B') before--;
  if (kind === 'P') return [before];
  let after = f + 1;
  while (kindOf(after, total) === 'B') after++;
  return [before, after];
}

/** The order the pictures are stored in: every I or P, then the B pictures shown before it. */
function storageOrder(total) {
  const order = [];
  let waiting = [];
  for (let f = 0; f < total; f++) {
    if (kindOf(f, total) === 'B') { waiting.push(f); continue; }
    order.push(f, ...waiting);
    waiting = [];
  }
  return order;
}

function picture(f, key, bytes, pattern) {
  const d = new Uint8Array(bytes);
  d.set(pattern.subarray(0, bytes));
  const view = new DataView(d.buffer);
  view.setUint32(0, bytes - 4);                // one NAL unit, its length in front
  d[4] = key ? 0x65 : 0x41;                    // an IDR slice, or any other slice
  view.setUint32(8, f);
  return d;
}

/** Writes the recording to `path` (straight to disk, so it can be far larger than memory). Returns its size in bytes. */
export async function writeMatch(path, { seconds, frameBytes = 8000 }) {
  const { Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket } = await bunny();
  const fd = fs.openSync(path, 'w');
  let size = 0;
  const writable = new WritableStream({
    write({ data, position }) { fs.writeSync(fd, data, 0, data.length, position); size = Math.max(size, position + data.length); },
  });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable) });
  const video = new EncodedVideoPacketSource('avc');
  const audio = new EncodedAudioPacketSource('aac');
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();
  const total = seconds * FPS;
  const pattern = Uint8Array.from({ length: frameBytes }, (_, i) => (i * 131 + 7) & 0xff);
  let sound = 0;
  for (const f of storageOrder(total)) {
    const key = kindOf(f, total) === 'I';
    await video.add(new EncodedPacket(picture(f, key, frameBytes, pattern), key ? 'key' : 'delta', f / FPS, 1 / FPS), VIDEO_META);
    for (; sound * SOUND < f / FPS; sound++) {
      const d = new Uint8Array(SOUND_BYTES);
      new DataView(d.buffer).setUint32(0, sound);
      await audio.add(new EncodedPacket(d, 'key', sound * SOUND, SOUND), AUDIO_META);
    }
  }
  await output.finalize();
  fs.closeSync(fd);
  return size;
}

/** The same recording in memory, for small ones. */
export async function matchBlob(options) {
  fs.mkdirSync(options.dir, { recursive: true });
  const path = `${options.dir}/match-${options.seconds}.mp4`;
  await writeMatch(path, options);
  const bytes = fs.readFileSync(path);
  fs.rmSync(path);
  return new Blob([bytes], { type: 'video/mp4' });
}

/**
 * Reads a cut made from such a recording: every picture and sound packet with
 * the number it carries and its time in the cut, in the order they are stored.
 */
export async function readCut(bytes) {
  const { Input, BufferSource, MP4, EncodedPacketSink } = await bunny();
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  const numberAt = (p, offset) => new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength).getUint32(offset);
  const pictures = [];
  for await (const p of new EncodedPacketSink(videoTrack).packets()) pictures.push({ frame: numberAt(p, 8), t: p.timestamp, d: p.duration, key: p.type === 'key', bytes: p.data.byteLength });
  const sounds = [];
  for await (const p of new EncodedPacketSink(audioTrack).packets()) sounds.push({ n: numberAt(p, 0), t: p.timestamp, d: p.duration });
  const out = {
    pictures, sounds,
    videoCodec: await videoTrack.getCodec(), audioCodec: await audioTrack.getCodec(),
    videoLength: await videoTrack.computeDuration(), audioLength: await audioTrack.computeDuration(),
  };
  input.dispose();
  return out;
}

/** Every packet of any MP4 with its time and a fingerprint of its bytes (`hash`: bytes -> string), to find a packet again in another file. */
export async function packetsOf(bytes, hash) {
  const { Input, BufferSource, MP4, EncodedPacketSink } = await bunny();
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  const list = async (track) => {
    const out = [];
    for await (const p of new EncodedPacketSink(track).packets()) out.push({ t: p.timestamp, d: p.duration, key: p.type === 'key', hash: hash(p.data) });
    return out;
  };
  const tracks = [await input.getPrimaryVideoTrack(), await input.getPrimaryAudioTrack()];
  const out = { codecs: [await tracks[0].getCodec(), await tracks[1].getCodec()], video: await list(tracks[0]), audio: await list(tracks[1]) };
  input.dispose();
  return out;
}
