import { describe, expect, it } from 'vitest';
import { parseChannels } from '../src/channels';

describe('parseChannels', () => {
  it('reads name:id pairs in order', () => {
    expect([...parseChannels(' events:111, training : 222 ')]).toEqual([
      ['events', '111'],
      ['training', '222'],
    ]);
  });

  it('is empty when unset', () => {
    expect(parseChannels('').size).toBe(0);
    expect(parseChannels(undefined).size).toBe(0);
  });

  it('rejects a malformed entry by name', () => {
    expect(() => parseChannels('events')).toThrow('SEND_CHANNELS entry "events"');
    expect(() => parseChannels('events:abc')).toThrow('SEND_CHANNELS entry "events:abc"');
    expect(() => parseChannels(':111')).toThrow('SEND_CHANNELS entry ":111"');
  });

  it('rejects a repeated name', () => {
    expect(() => parseChannels('events:1,events:2')).toThrow('lists "events" twice');
  });
});
