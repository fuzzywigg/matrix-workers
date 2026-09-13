import { describe, it, expect } from 'vitest';
import { validateStateEvent } from '../src/api/rooms';

describe('validateStateEvent', () => {
  it('rejects non-objects and missing type/content', () => {
    expect(validateStateEvent(null, 0).valid).toBe(false);
    expect(validateStateEvent({ content: {} }, 1).error).toMatch(/type/);
    expect(validateStateEvent({ type: 'm.room.name' }, 2).error).toMatch(/content/);
  });

  it('rejects non-string state_key', () => {
    expect(
      validateStateEvent({ type: 'm.room.name', state_key: 1, content: { name: 'x' } }, 0).valid
    ).toBe(false);
  });

  it('rejects auto-created event types', () => {
    for (const type of ['m.room.create', 'm.room.member', 'm.room.power_levels']) {
      expect(validateStateEvent({ type, content: {} }, 0).valid).toBe(false);
    }
  });

  it('validates m.room.encryption algorithm', () => {
    expect(
      validateStateEvent({ type: 'm.room.encryption', content: {} }, 0).error
    ).toMatch(/algorithm/);
    expect(
      validateStateEvent(
        { type: 'm.room.encryption', content: { algorithm: 'm.bad' } },
        0
      ).error
    ).toMatch(/unsupported algorithm/);
    expect(
      validateStateEvent(
        { type: 'm.room.encryption', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        0
      ).valid
    ).toBe(true);
  });

  it('accepts name/topic with empty state_key', () => {
    expect(
      validateStateEvent({ type: 'm.room.name', state_key: '', content: { name: 'General' } }, 0)
        .valid
    ).toBe(true);
  });

  it('accepts topic and join_rules events', () => {
    expect(
      validateStateEvent(
        { type: 'm.room.topic', state_key: '', content: { topic: 'hello' } },
        0
      ).valid
    ).toBe(true);
    expect(
      validateStateEvent(
        { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'public' } },
        0
      ).valid
    ).toBe(true);
  });

  it('rejects whitespace-only type and non-object content', () => {
    expect(validateStateEvent({ type: '   ', content: {} }, 0).valid).toBe(false);
    expect(
      validateStateEvent({ type: 'm.room.name', content: ['not', 'an', 'object'] }, 0).valid
    ).toBe(false);
  });

  it('accepts guest_access, history_visibility, and avatar events', () => {
    expect(
      validateStateEvent(
        { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'can_join' } },
        0
      ).valid
    ).toBe(true);
    expect(
      validateStateEvent(
        {
          type: 'm.room.history_visibility',
          state_key: '',
          content: { history_visibility: 'shared' },
        },
        0
      ).valid
    ).toBe(true);
    expect(
      validateStateEvent(
        { type: 'm.room.avatar', state_key: '', content: { url: 'mxc://example.com/abc' } },
        3
      ).valid
    ).toBe(true);
  });

  it('includes the index in error messages', () => {
    expect(validateStateEvent(null, 7).error).toMatch(/initial_state\[7\]/);
  });

  it('rejects encryption with non-string algorithm values', () => {
    expect(
      validateStateEvent(
        { type: 'm.room.encryption', content: { algorithm: null } },
        0
      ).error
    ).toMatch(/algorithm/);
    expect(
      validateStateEvent(
        { type: 'm.room.encryption', content: { algorithm: 1 } },
        0
      ).error
    ).toMatch(/algorithm/);
  });

  it('rejects non-object event values such as arrays and strings', () => {
    expect(validateStateEvent([], 0).valid).toBe(false);
    expect(validateStateEvent('m.room.name', 1).valid).toBe(false);
  });

  it('accepts unknown custom state types with object content', () => {
    expect(
      validateStateEvent(
        { type: 'org.example.custom', state_key: 'k', content: { ok: true } },
        0
      ).valid
    ).toBe(true);
  });
});


describe('validateStateEvent TOKENMAXX edge paths after #49', () => {
  it('rejects empty-string types and null content', () => {
    expect(validateStateEvent({ type: '', content: {} }, 0).valid).toBe(false);
    expect(validateStateEvent({ type: 'm.room.name', content: null }, 1).error).toMatch(/content/);
  });
});

describe('validateStateEvent TOKENMAXX edge paths after #50', () => {
  it('accepts events that omit state_key', () => {
    expect(
      validateStateEvent({ type: 'm.room.name', content: { name: 'General' } }, 0).valid
    ).toBe(true);
  });

  it('rejects boolean state_key values', () => {
    expect(
      validateStateEvent(
        { type: 'm.room.name', state_key: true, content: { name: 'x' } },
        0
      ).valid
    ).toBe(false);
  });

  it('accepts encryption events with extra rotation fields', () => {
    expect(
      validateStateEvent(
        {
          type: 'm.room.encryption',
          content: { algorithm: 'm.megolm.v1.aes-sha2', rotation_period_ms: 1 },
        },
        0
      ).valid
    ).toBe(true);
  });
});


describe('validateStateEvent TOKENMAXX edge paths after #69', () => {
  it('rejects disallowed auto-created types with exact indexed error strings', () => {
    expect(validateStateEvent({ type: 'm.room.create', content: {} }, 2)).toEqual({
      valid: false,
      error: "initial_state[2]: 'm.room.create' cannot be set via initial_state",
    });
    expect(validateStateEvent({ type: 'm.room.member', content: { membership: 'join' } }, 0)).toEqual({
      valid: false,
      error: "initial_state[0]: 'm.room.member' cannot be set via initial_state",
    });
    expect(validateStateEvent({ type: 'm.room.power_levels', content: {} }, 9)).toEqual({
      valid: false,
      error: "initial_state[9]: 'm.room.power_levels' cannot be set via initial_state",
    });
  });

  it('rejects encryption missing algorithm with exact message', () => {
    expect(validateStateEvent({ type: 'm.room.encryption', content: {} }, 4)).toEqual({
      valid: false,
      error: "initial_state[4]: m.room.encryption requires 'algorithm'",
    });
  });

  it('rejects unsupported encryption algorithms with the algorithm quoted', () => {
    expect(
      validateStateEvent(
        { type: 'm.room.encryption', content: { algorithm: 'm.olm.v1.curve25519-aes-sha2' } },
        1
      )
    ).toEqual({
      valid: false,
      error: "initial_state[1]: unsupported algorithm 'm.olm.v1.curve25519-aes-sha2'",
    });
  });

  it('rejects number / boolean / function event roots', () => {
    expect(validateStateEvent(0, 0).error).toMatch(/must be an object/);
    expect(validateStateEvent(false, 1).error).toMatch(/must be an object/);
    expect(validateStateEvent(() => ({}), 2).error).toMatch(/must be an object/);
  });

  it('rejects non-string type values including numbers and objects', () => {
    expect(validateStateEvent({ type: 1, content: {} }, 0).error).toMatch(/type/);
    expect(validateStateEvent({ type: { t: 'm.room.name' }, content: {} }, 0).error).toMatch(
      /type/
    );
  });

  it('accepts empty-string state_key for encryption and custom types', () => {
    expect(
      validateStateEvent(
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
        0
      ).valid
    ).toBe(true);
    expect(
      validateStateEvent(
        { type: 'com.example.widget', state_key: '', content: { url: 'https://x' } },
        0
      ).valid
    ).toBe(true);
  });

  it('rejects content provided as a string or number', () => {
    expect(
      validateStateEvent({ type: 'm.room.name', content: 'General' }, 0).error
    ).toMatch(/content/);
    expect(validateStateEvent({ type: 'm.room.name', content: 3 }, 0).error).toMatch(/content/);
  });
});
