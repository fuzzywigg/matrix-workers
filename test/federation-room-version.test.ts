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

  it('treats NaN-producing strings as modern (fail-closed)', () => {
    expect(isModernRoomVersion('v10')).toBe(true);
    expect(isModernRoomVersion('ten')).toBe(true);
    expect(isModernRoomVersion(' ')).toBe(true);
  });

  it('treats very large numeric versions as modern', () => {
    expect(isModernRoomVersion('100')).toBe(true);
    expect(isModernRoomVersion('9999')).toBe(true);
  });

  it('treats leading-plus numeric strings via parseInt', () => {
    expect(isModernRoomVersion('+3')).toBe(true);
    expect(isModernRoomVersion('+2')).toBe(false);
  });

  it('treats negative numeric prefixes as modern when parseInt yields negative', () => {
    // parseInt('-1', 10) === -1 → Number.isFinite → n >= 3 is false
    expect(isModernRoomVersion('-1')).toBe(false);
  });

  it('uses parseInt alphanumeric prefix semantics', () => {
    // parseInt('2abc', 10) === 2 → legacy; parseInt('3foo', 10) === 3 → modern
    expect(isModernRoomVersion('2abc')).toBe(false);
    expect(isModernRoomVersion('3foo')).toBe(true);
  });
});


describe('isModernRoomVersion TOKENMAXX edge paths after #49', () => {
  it('skips leading whitespace via parseInt before comparing to 3', () => {
    expect(isModernRoomVersion(' 3')).toBe(true);
    // parseInt('\t2', 10) === 2 → legacy
    expect(isModernRoomVersion('\t2')).toBe(false);
    expect(isModernRoomVersion('  10')).toBe(true);
  });
});
