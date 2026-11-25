/* eslint-disable ts-patterns/no-magic-numbers -- test fixtures are literal times in seconds */
import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_LIMITS, parseClock, formatClock, formatMoment, clockTimesIn, parseHighlightMoments, checkHighlightMoments,
  highlightProblemText, highlightsTotal,
} from '../highlights.js';

const moments = (input: unknown) => {
  const r = parseHighlightMoments(input);
  if (!r.ok) throw new Error(`expected moments, got ${r.problem.code}`);
  return r;
};
const problem = (input: unknown) => {
  const r = parseHighlightMoments(input);
  if (r.ok) throw new Error('expected a problem');
  return r.problem;
};

describe('highlight moments', () => {
  it('reads a time as minutes:seconds of the video file, with hours when there are three parts', () => {
    expect(parseClock('12:30')).toBe(750);
    expect(parseClock(' 0:05 ')).toBe(5);
    expect(parseClock('71:05')).toBe(4265);
    expect(parseClock('1:12:30')).toBe(4350);
    expect(parseClock('12:3')).toBe(null);
    expect(parseClock('12:75')).toBe(null);
    expect(parseClock('12.30')).toBe(null);
    expect(parseClock('1230')).toBe(null);
    expect(parseClock('1:75:00')).toBe(null);
    expect(parseClock('')).toBe(null);
    expect(parseClock(null)).toBe(null);
  });

  it('writes a time back the same way', () => {
    expect(formatClock(750)).toBe('12:30');
    expect(formatClock(4265)).toBe('71:05');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(4350.9)).toBe('72:30');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatMoment({ start: 750, end: 770 })).toBe('12:30–12:50');
  });

  it("reads the owner's line: ranges and single times, in one string or as a list", () => {
    const line = moments('12:30-12:50, 44:10-44:40, 71:05');
    expect(line.moments).toEqual([
      { start: 750, end: 770 },
      { start: 2650, end: 2680 },
      { start: 4265 - HIGHLIGHT_LIMITS.before, end: 4265 + HIGHLIGHT_LIMITS.after },
    ]);
    expect(line.total).toBe(20 + 30 + 18);
    expect(line.merged).toBe(0);
    expect(line.reordered).toBe(false);
    expect(moments(['12:30-12:50', '44:10-44:40', '71:05']).moments).toEqual(line.moments);
    expect(moments('12:30 – 12:50; 44:10 עד 44:40\n1:11:05 to 1:11:20').moments).toEqual([
      { start: 750, end: 770 }, { start: 2650, end: 2680 }, { start: 4265, end: 4280 },
    ]);
  });

  it('a single time gets the default length, and never starts before the file does', () => {
    expect(HIGHLIGHT_LIMITS.before).toBe(6);
    expect(HIGHLIGHT_LIMITS.after).toBe(12);
    expect(moments('0:03').moments).toEqual([{ start: 0, end: 15 }]);
    expect(moments('10:00').moments).toEqual([{ start: 594, end: 612 }]);
  });

  it('puts the moments in order of time and joins the ones that overlap or touch', () => {
    const r = moments(['44:10-44:40', '12:30-12:50', '12:45-13:05', '13:05-13:10']);
    expect(r.moments).toEqual([{ start: 750, end: 790 }, { start: 2650, end: 2680 }]);
    expect(r.merged).toBe(2);
    expect(r.reordered).toBe(true);
    expect(highlightsTotal(r.moments)).toBe(70);
    // Two single times six seconds apart are one moment, not the same seconds twice.
    expect(moments('20:00, 20:06').moments).toEqual([{ start: 1194, end: 1218 }]);
  });

  it('says what is wrong with a moment it cannot use', () => {
    expect(problem('')).toEqual({ code: 'empty' });
    expect(problem([])).toEqual({ code: 'empty' });
    expect(problem('12:30-abc')).toEqual({ code: 'unreadable', text: '12:30-abc' });
    expect(problem('minute 71')).toEqual({ code: 'unreadable', text: 'minute 71' });
    expect(problem('12:50-12:30')).toEqual({ code: 'backwards', text: '12:50-12:30' });
    expect(problem('12:30-12:30')).toEqual({ code: 'backwards', text: '12:30-12:30' });
    expect(problem('12:30-12:31')).toEqual({ code: 'too_short', text: '12:30-12:31', seconds: 1 });
    expect(problem('12:30-15:31')).toEqual({ code: 'too_long', text: '12:30-15:31', seconds: 181 });
    expect(problem('5:59:50-6:00:10')).toEqual({ code: 'too_late', text: '5:59:50-6:00:10' });
    expect(moments('12:30-15:30').total).toBe(HIGHLIGHT_LIMITS.maxLength);
  });

  it('bounds how many moments and how long the whole video is', () => {
    const every = (n: number, step: number, length: number) => Array.from({ length: n }, (_, i) => `${formatClock(i * step)}-${formatClock(i * step + length)}`);
    expect(moments(every(30, 60, 10)).moments).toHaveLength(HIGHLIGHT_LIMITS.maxMoments);
    expect(problem(every(31, 60, 10))).toEqual({ code: 'too_many', count: 31 });
    expect(moments(every(5, 200, 180)).total).toBe(HIGHLIGHT_LIMITS.maxTotal);
    expect(problem(every(6, 200, 180))).toEqual({ code: 'total_too_long', seconds: 1080 });
  });

  it('checks stored moments again: numbers, in order, apart, within the bounds', () => {
    const stored = moments('12:30-12:50, 44:10-44:40, 71:05').moments;
    expect(checkHighlightMoments(stored)).toEqual({ ok: true, moments: stored, total: 68 });
    const bad = (input: unknown) => {
      const r = checkHighlightMoments(input);
      return r.ok ? null : r.problem.code;
    };
    expect(bad(undefined)).toBe('empty');
    expect(bad([])).toBe('empty');
    expect(bad([{ start: '750', end: 770 }])).toBe('unreadable');
    expect(bad([{ start: 750, end: Infinity }])).toBe('unreadable');
    expect(bad([{ start: -1, end: 5 }])).toBe('unreadable');
    expect(bad([null])).toBe('unreadable');
    expect(bad([{ start: 770, end: 750 }])).toBe('backwards');
    expect(bad([{ start: 750, end: 751 }])).toBe('too_short');
    expect(bad([{ start: 2650, end: 2680 }, { start: 750, end: 770 }])).toBe('out_of_order');
    expect(bad([{ start: 750, end: 770 }, { start: 770, end: 790 }])).toBe('out_of_order');
    expect(bad([{ start: 0, end: 901 }])).toBe('total_too_long');
    expect(bad([{ start: 21590, end: 21610 }])).toBe('too_late');
    expect(bad(Array.from({ length: 31 }, (_, i) => ({ start: i * 10, end: i * 10 + 5 })))).toBe('too_many');
    // Two moments joined by the reader may pass three minutes; the total still bounds them.
    expect(checkHighlightMoments([{ start: 0, end: 300 }]).ok).toBe(true);
    // Whatever else was stored beside start and end does not come back.
    expect(checkHighlightMoments([{ start: 1, end: 9, note: 'x' }])).toEqual({ ok: true, moments: [{ start: 1, end: 9 }], total: 8 });
  });

  it('finds the times written inside a message', () => {
    expect(clockTimesIn('רגעים נבחרים של נועם: 12:30-12:50, 44:10-44:40, 71:05')).toEqual([750, 770, 2650, 2680, 4265]);
    expect(clockTimesIn('the goal at 1:12:30, the save (07:15)')).toEqual([4350, 435]);
    expect(clockTimesIn('no times here, 12.30 and 1230 are not times')).toEqual([]);
    expect(clockTimesIn(null)).toEqual([]);
  });

  it('explains every problem in a sentence', () => {
    expect(highlightProblemText({ code: 'unreadable', text: 'x' })).toContain('"x"');
    expect(highlightProblemText({ code: 'too_long', text: '1:00-5:00', seconds: 240 })).toContain('at most 3:00');
    expect(highlightProblemText({ code: 'total_too_long', seconds: 1080 })).toContain('18:00');
    expect(highlightProblemText({ code: 'too_many', count: 31 })).toContain('30');
    const codes = ['empty', 'backwards', 'too_short', 'too_late', 'out_of_order'] as const;
    const texts = codes.map((code) => highlightProblemText({ code, text: 't', seconds: 1 } as never));
    expect(texts.every((s) => s.length > 10)).toBe(true);
  });
});
