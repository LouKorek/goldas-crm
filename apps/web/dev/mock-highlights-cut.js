// Harness stand-in for lib/highlights-cut: acts the cutting steps so the upload
// page's states can be looked at without a match video. ?cut=real hands over to
// the real cutter (pick a real MP4 then); ?cut=fail shows a file that cannot be cut.
import { prepareCut as realCut, CutError, CUT_MESSAGES } from '../src/lib/highlights-cut.js';
import { hold, forever } from './mock-youtube.js';

const mode = new URLSearchParams(location.search).get('cut') || 'act';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTED_BYTES_PER_SECOND = 700000;

export async function prepareCut(file, moments, options = {}) {
  if (mode === 'real') return realCut(file, moments, options);
  const onProgress = options.onProgress || (() => {});
  onProgress({ step: 'reading' });
  await wait(700);
  if (hold === 'reading') await forever();
  if (mode === 'fail') throw new CutError('video_codec', CUT_MESSAGES.video_codec, { codec: 'prores' });
  for (let i = 1; i <= moments.length; i++) {
    onProgress({ step: 'cutting', clip: i, clips: moments.length });
    await wait(600);
    if (hold === 'cutting' && i === Math.min(2, moments.length)) await forever();
  }
  const duration = moments.reduce((n, m) => n + m.end - m.start + 1, 0);
  return {
    size: Math.round(duration * ACTED_BYTES_PER_SECOND), type: 'video/mp4', duration,
    clips: moments.map((m, i) => ({ from: m.start - 1, to: m.end, moments: [i] })),
    stream: () => new ReadableStream({ start(c) { c.close(); } }),
    close() {},
  };
}
