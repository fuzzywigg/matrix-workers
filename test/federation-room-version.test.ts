import { describe, it, expect } from 'vitest';
import { isModernRoomVersion } from '../src/api/federation';

describe('isModernRoomVersion', () => {
  it('treats v1 and v2 as legacy', () => {
    expect(isModernRoomVersion('1')).toBe(false);
    expect(isModernRoomVersion('2')).toBe(false);
  });

  it('treats v3+ as modern', () => {
    for (const v of ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']) {
      expect(isModernRoomVersion(v)).toBe(true);
    }
  });

  it('fail-closes on non-numeric custom versions', () => {
    expect(isModernRoomVersion('org.example.custom')).toBe(true);
    expect(isModernRoomVersion('')).toBe(true);
  });

  it('parses leading-zero numeric versions via parseInt', () => {
    expect(isModernRoomVersion('03')).toBe(true);
    expect(isModernRoomVersion('0')).toBe(false);
  });

  it('treats floats as their integer prefix', () => {
    // parseInt('2.5', 10) === 2 → legacy
    expect(isModernRoomVersion('2.5')).toBe(false);
    expect(isModernRoomVersion('3.9')).toBe(true);
  });
});
