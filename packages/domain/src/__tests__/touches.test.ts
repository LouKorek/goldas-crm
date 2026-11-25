import { describe, it, expect } from 'vitest';
import { lastTouch, touchesOf, contactSchema, touchSchema, TOUCH_CHANNELS } from '../schemas';

const T = (id: string, at: string, extra = {}) => ({ id, at, channel: 'whatsapp' as const, by: 'lou@x.com', playerId: '', dealId: '', note: 'x', ...extra });

describe('lastTouch', () => {
  it('is null for a contact without touches', () => {
    expect(lastTouch({})).toBeNull();
    expect(lastTouch({ touches: [] })).toBeNull();
    expect(lastTouch(null)).toBeNull();
    expect(lastTouch({ touches: 'nonsense' })).toBeNull();
  });
  it('is the newest by time, whatever the order in the array', () => {
    const c = { touches: [T('a', '2026-11-20T10:00:00.000Z'), T('c', '2026-11-24T08:00:00.000Z'), T('b', '2026-11-22T09:00:00.000Z')] };
    expect(lastTouch(c)?.id).toBe('c');
    expect(touchesOf(c).map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });
  it('skips entries without a readable time', () => {
    const c = { touches: [T('bad', 'yesterday'), null, T('ok', '2026-01-01T00:00:00.000Z')] };
    expect(lastTouch(c)?.id).toBe('ok');
    expect(touchesOf(c)).toHaveLength(1);
  });
});

describe('touch schema', () => {
  it('a contact without touches gets an empty list', () => {
    expect(contactSchema.parse({ contactName: 'Avi' }).touches).toEqual([]);
  });
  it('accepts the shared shape and refuses an unknown channel', () => {
    expect(touchSchema.parse(T('a', '2026-11-25T10:00:00.000Z', { channel: 'call' })).channel).toBe('call');
    expect(() => touchSchema.parse(T('a', '2026-11-25T10:00:00.000Z', { channel: 'fax' }))).toThrow();
    expect(TOUCH_CHANNELS).toContain('whatsapp');
  });
});
