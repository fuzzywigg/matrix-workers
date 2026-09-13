import { describe, it, expect } from 'vitest';
import { SUPPORTED_ROOM_VERSIONS as JOIN_SUPPORTED } from '../src/workflows/join-template-validation';
import { getSupportedRoomVersions, isRoomVersionSupported } from '../src/services/room-versions';
import { isModernRoomVersion } from '../src/api/federation';

/**
 * Cross-module room-version consistency for federation join / auth paths.
 * Keeps make_join validation aligned with the room-versions registry and the
 * modern-hash gate used by federation event validation.
 */
describe('federation room-version module alignment', () => {
  it('keeps make_join and room-versions registries in sync for 1–12', () => {
    const registry = getSupportedRoomVersions();
    const registryKeys = Object.keys(registry).sort((a, b) => Number(a) - Number(b));
    const joinKeys = [...JOIN_SUPPORTED].sort((a, b) => Number(a) - Number(b));
    expect(joinKeys).toEqual(registryKeys);
    for (const v of joinKeys) {
      expect(isRoomVersionSupported(v)).toBe(true);
    }
  });

  it('treats every make_join-supported version ≥3 as modern for content hashes', () => {
    for (const v of JOIN_SUPPORTED) {
      const n = parseInt(v, 10);
      expect(isModernRoomVersion(v)).toBe(n >= 3);
    }
  });

  it('keeps legacy v1/v2 outside the modern-hash gate', () => {
    expect(JOIN_SUPPORTED.has('1')).toBe(true);
    expect(JOIN_SUPPORTED.has('2')).toBe(true);
    expect(isModernRoomVersion('1')).toBe(false);
    expect(isModernRoomVersion('2')).toBe(false);
  });

  it('rejects unknown versions from both registries and still fail-closes modern-hash', () => {
    expect(JOIN_SUPPORTED.has('13')).toBe(false);
    expect(isRoomVersionSupported('13')).toBe(false);
    expect(isModernRoomVersion('13')).toBe(true);
  });
});
