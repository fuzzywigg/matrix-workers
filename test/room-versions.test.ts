import { describe, it, expect } from 'vitest';
import {
  getRoomVersion,
  isRoomVersionSupported,
  getDefaultRoomVersion,
  getSupportedRoomVersions,
  getRedactionAllowedKeys,
} from '../src/services/room-versions';

describe('room version registry', () => {
  it('defaults to stable room version 10', () => {
    expect(getDefaultRoomVersion()).toBe('10');
    expect(getRoomVersion('10')?.stable).toBe(true);
  });

  it('supports Matrix room versions 1 through 12', () => {
    for (let v = 1; v <= 12; v++) {
      expect(isRoomVersionSupported(String(v))).toBe(true);
      expect(getRoomVersion(String(v))).not.toBeNull();
    }
    expect(isRoomVersionSupported('99')).toBe(false);
    expect(getRoomVersion('99')).toBeNull();
  });

  it('marks all registered versions stable for clients', () => {
    const supported = getSupportedRoomVersions();
    expect(Object.keys(supported).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i + 1))
    );
    expect(Object.values(supported).every((s) => s === 'stable')).toBe(true);
  });

  it('tracks capability gates across versions', () => {
    expect(getRoomVersion('6')?.knockingSupported).toBe(false);
    expect(getRoomVersion('7')?.knockingSupported).toBe(true);
    expect(getRoomVersion('7')?.restrictedJoinsSupported).toBe(false);
    expect(getRoomVersion('8')?.restrictedJoinsSupported).toBe(true);
    expect(getRoomVersion('9')?.integerPowerLevels).toBe(false);
    expect(getRoomVersion('10')?.integerPowerLevels).toBe(true);
    expect(getRoomVersion('10')?.knockRestrictedSupported).toBe(true);
    expect(getRoomVersion('10')?.updatedRedactionRules).toBe(false);
    expect(getRoomVersion('11')?.updatedRedactionRules).toBe(true);
  });

  it('uses expected event ID / state resolution algorithms', () => {
    expect(getRoomVersion('1')?.stateResolution).toBe('v1');
    expect(getRoomVersion('1')?.eventIdFormat).toBe('v1');
    expect(getRoomVersion('2')?.stateResolution).toBe('v2');
    expect(getRoomVersion('3')?.eventIdFormat).toBe('v3');
    expect(getRoomVersion('4')?.eventIdFormat).toBe('v4');
    expect(getRoomVersion('12')?.eventIdFormat).toBe('v4');
  });
});

describe('getRedactionAllowedKeys', () => {
  it('always preserves core event envelope keys', () => {
    const v10 = getRoomVersion('10')!;
    const keys = getRedactionAllowedKeys('m.room.message', v10);
    expect(keys).toEqual(
      expect.arrayContaining(['event_id', 'type', 'room_id', 'sender', 'signatures', 'hashes'])
    );
  });

  it('preserves membership content keys and expands them for v11+', () => {
    const v10 = getRoomVersion('10')!;
    const v11 = getRoomVersion('11')!;
    expect(getRedactionAllowedKeys('m.room.member', v10)).toEqual(
      expect.arrayContaining(['membership', 'join_authorised_via_users_server'])
    );
    expect(getRedactionAllowedKeys('m.room.member', v10)).not.toContain('third_party_invite');
    expect(getRedactionAllowedKeys('m.room.member', v11)).toContain('third_party_invite');
    expect(getRedactionAllowedKeys('m.room.create', v11)).toEqual(
      expect.arrayContaining(['creator', 'room_version'])
    );
    expect(getRedactionAllowedKeys('m.room.redaction', v11)).toContain('redacts');
  });

  it('preserves join_rules, power_levels, and history_visibility content keys', () => {
    const v10 = getRoomVersion('10')!;
    const v11 = getRoomVersion('11')!;
    expect(getRedactionAllowedKeys('m.room.join_rules', v10)).toEqual(
      expect.arrayContaining(['join_rule', 'allow'])
    );
    expect(getRedactionAllowedKeys('m.room.history_visibility', v10)).toContain(
      'history_visibility'
    );
    expect(getRedactionAllowedKeys('m.room.power_levels', v10)).toEqual(
      expect.arrayContaining(['ban', 'kick', 'users', 'users_default'])
    );
    expect(getRedactionAllowedKeys('m.room.power_levels', v10)).not.toContain('notifications');
    expect(getRedactionAllowedKeys('m.room.power_levels', v11)).toContain('notifications');
  });

  it('tracks redactionAlgorithm v1 vs v11', () => {
    expect(getRoomVersion('10')?.redactionAlgorithm).toBe('v1');
    expect(getRoomVersion('11')?.redactionAlgorithm).toBe('v11');
    expect(getRoomVersion('12')?.redactionAlgorithm).toBe('v11');
  });

  it('returns only envelope keys for ordinary message types', () => {
    const v10 = getRoomVersion('10')!;
    const keys = getRedactionAllowedKeys('m.room.message', v10);
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('msgtype');
  });

  it('marks v12 knock_restricted capability like v10+', () => {
    expect(getRoomVersion('12')?.knockRestrictedSupported).toBe(true);
    expect(getRoomVersion('12')?.integerPowerLevels).toBe(true);
    expect(getRoomVersion('12')?.updatedRedactionRules).toBe(true);
  });

  it('returns envelope-only keys for unknown event types on both redaction algorithms', () => {
    const v10 = getRoomVersion('10')!;
    const v11 = getRoomVersion('11')!;
    for (const behavior of [v10, v11]) {
      const keys = getRedactionAllowedKeys('m.room.message', behavior);
      expect(keys).toContain('event_id');
      expect(keys).not.toContain('body');
    }
  });

  it('keeps v10 create without room_version and redaction without redacts', () => {
    const v10 = getRoomVersion('10')!;
    expect(getRedactionAllowedKeys('m.room.create', v10)).toContain('creator');
    expect(getRedactionAllowedKeys('m.room.create', v10)).not.toContain('room_version');
    expect(getRedactionAllowedKeys('m.room.redaction', v10)).not.toContain('redacts');
    // Envelope keys are still present for redaction events
    expect(getRedactionAllowedKeys('m.room.redaction', v10)).toContain('event_id');
  });
});


describe('room-versions TOKENMAXX edge paths after #49', () => {
  it('rejects empty and non-numeric version strings', () => {
    expect(isRoomVersionSupported('')).toBe(false);
    expect(isRoomVersionSupported('v10')).toBe(false);
    expect(getRoomVersion('')).toBeNull();
  });

  it('preserves allow list keys for join_rules under v11 redaction rules', () => {
    const v11 = getRoomVersion('11')!;
    expect(getRedactionAllowedKeys('m.room.join_rules', v11)).toEqual(
      expect.arrayContaining(['join_rule', 'allow'])
    );
  });
});

describe('room-versions TOKENMAXX edge paths after #50', () => {
  it('exposes authRuleVariant transitions across v7/v8/v10', () => {
    expect(getRoomVersion('7')?.authRuleVariant).toBe('v1');
    expect(getRoomVersion('8')?.authRuleVariant).toBe('v8');
    expect(getRoomVersion('10')?.authRuleVariant).toBe('v10');
  });

  it('preserves redacts on redaction events for v12 like v11', () => {
    const v12 = getRoomVersion('12')!;
    expect(getRedactionAllowedKeys('m.room.redaction', v12)).toContain('redacts');
  });

  it('marks v3 eventIdFormat as v3', () => {
    expect(getRoomVersion('3')?.eventIdFormat).toBe('v3');
  });
});


describe('room-versions TOKENMAXX edge paths after #69', () => {
  it('exposes the full capability matrix for versions 1–12', () => {
    const expected: Record<
      string,
      {
        stateResolution: string;
        eventIdFormat: string;
        redactionAlgorithm: string;
        knockingSupported: boolean;
        restrictedJoinsSupported: boolean;
        integerPowerLevels: boolean;
        updatedRedactionRules: boolean;
        authRuleVariant: string;
        knockRestrictedSupported: boolean;
      }
    > = {
      '1': {
        stateResolution: 'v1',
        eventIdFormat: 'v1',
        redactionAlgorithm: 'v1',
        knockingSupported: false,
        restrictedJoinsSupported: false,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v1',
        knockRestrictedSupported: false,
      },
      '2': {
        stateResolution: 'v2',
        eventIdFormat: 'v1',
        redactionAlgorithm: 'v1',
        knockingSupported: false,
        restrictedJoinsSupported: false,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v1',
        knockRestrictedSupported: false,
      },
      '3': {
        stateResolution: 'v2',
        eventIdFormat: 'v3',
        redactionAlgorithm: 'v1',
        knockingSupported: false,
        restrictedJoinsSupported: false,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v1',
        knockRestrictedSupported: false,
      },
      '4': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v1',
        knockingSupported: false,
        restrictedJoinsSupported: false,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v1',
        knockRestrictedSupported: false,
      },
      '5': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v1',
        knockingSupported: false,
        restrictedJoinsSupported: false,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v1',
        knockRestrictedSupported: false,
      },
      '6': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v1',
        knockingSupported: false,
        restrictedJoinsSupported: false,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v1',
        knockRestrictedSupported: false,
      },
      '7': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v1',
        knockingSupported: true,
        restrictedJoinsSupported: false,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v1',
        knockRestrictedSupported: false,
      },
      '8': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v1',
        knockingSupported: true,
        restrictedJoinsSupported: true,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v8',
        knockRestrictedSupported: false,
      },
      '9': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v1',
        knockingSupported: true,
        restrictedJoinsSupported: true,
        integerPowerLevels: false,
        updatedRedactionRules: false,
        authRuleVariant: 'v8',
        knockRestrictedSupported: false,
      },
      '10': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v1',
        knockingSupported: true,
        restrictedJoinsSupported: true,
        integerPowerLevels: true,
        updatedRedactionRules: false,
        authRuleVariant: 'v10',
        knockRestrictedSupported: true,
      },
      '11': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v11',
        knockingSupported: true,
        restrictedJoinsSupported: true,
        integerPowerLevels: true,
        updatedRedactionRules: true,
        authRuleVariant: 'v10',
        knockRestrictedSupported: true,
      },
      '12': {
        stateResolution: 'v2',
        eventIdFormat: 'v4',
        redactionAlgorithm: 'v11',
        knockingSupported: true,
        restrictedJoinsSupported: true,
        integerPowerLevels: true,
        updatedRedactionRules: true,
        authRuleVariant: 'v10',
        knockRestrictedSupported: true,
      },
    };

    for (const [version, caps] of Object.entries(expected)) {
      const behavior = getRoomVersion(version)!;
      expect(behavior.version).toBe(version);
      expect(behavior.stable).toBe(true);
      for (const [k, v] of Object.entries(caps)) {
        expect(behavior[k as keyof typeof behavior]).toBe(v);
      }
    }
  });

  it('returns exact v10 vs v11 power_levels / member / create redaction content keys', () => {
    const v10 = getRoomVersion('10')!;
    const v11 = getRoomVersion('11')!;
    const envelope = [
      'event_id',
      'type',
      'room_id',
      'sender',
      'state_key',
      'hashes',
      'signatures',
      'depth',
      'prev_events',
      'auth_events',
      'origin_server_ts',
    ];

    expect(getRedactionAllowedKeys('m.room.power_levels', v10)).toEqual([
      ...envelope,
      'ban',
      'events',
      'events_default',
      'invite',
      'kick',
      'redact',
      'state_default',
      'users',
      'users_default',
    ]);
    expect(getRedactionAllowedKeys('m.room.power_levels', v11)).toEqual([
      ...envelope,
      'ban',
      'events',
      'events_default',
      'invite',
      'kick',
      'redact',
      'state_default',
      'users',
      'users_default',
      'notifications',
    ]);
    expect(getRedactionAllowedKeys('m.room.member', v10)).toEqual([
      ...envelope,
      'membership',
      'join_authorised_via_users_server',
    ]);
    expect(getRedactionAllowedKeys('m.room.member', v11)).toEqual([
      ...envelope,
      'membership',
      'join_authorised_via_users_server',
      'third_party_invite',
    ]);
    expect(getRedactionAllowedKeys('m.room.create', v10)).toEqual([...envelope, 'creator']);
    expect(getRedactionAllowedKeys('m.room.create', v11)).toEqual([
      ...envelope,
      'creator',
      'room_version',
    ]);
    expect(getRedactionAllowedKeys('m.room.redaction', v10)).toEqual(envelope);
    expect(getRedactionAllowedKeys('m.room.redaction', v11)).toEqual([...envelope, 'redacts']);
    expect(getRedactionAllowedKeys('m.room.join_rules', v10)).toEqual([
      ...envelope,
      'join_rule',
      'allow',
    ]);
    expect(getRedactionAllowedKeys('m.room.history_visibility', v10)).toEqual([
      ...envelope,
      'history_visibility',
    ]);
  });

  it('returns envelope-only keys for encrypted and custom event types on v10 and v12', () => {
    const v10 = getRoomVersion('10')!;
    const v12 = getRoomVersion('12')!;
    for (const type of ['m.room.encrypted', 'm.reaction', 'org.example.custom']) {
      for (const behavior of [v10, v12]) {
        const keys = getRedactionAllowedKeys(type, behavior);
        expect(keys).toContain('event_id');
        expect(keys).toContain('origin_server_ts');
        expect(keys).not.toContain('ciphertext');
        expect(keys).not.toContain('body');
        expect(keys).not.toContain('redacts');
      }
    }
  });

  it('keeps getSupportedRoomVersions keys aligned with isRoomVersionSupported', () => {
    const supported = getSupportedRoomVersions();
    for (const v of Object.keys(supported)) {
      expect(isRoomVersionSupported(v)).toBe(true);
      expect(getRoomVersion(v)?.stable).toBe(true);
    }
    expect(Object.keys(supported)).toHaveLength(12);
  });

  it('rejects leading-zero and whitespace version strings as unsupported', () => {
    expect(isRoomVersionSupported('010')).toBe(false);
    expect(isRoomVersionSupported(' 10')).toBe(false);
    expect(isRoomVersionSupported('10 ')).toBe(false);
    expect(getRoomVersion('10.0')).toBeNull();
  });
});
