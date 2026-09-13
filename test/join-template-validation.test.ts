import { describe, it, expect } from 'vitest';
import { validateRemoteJoinTemplate } from '../src/workflows/join-template-validation';

const roomId = '!room:example.com';
const userId = '@alice:example.com';

function validTemplate(overrides: Record<string, unknown> = {}) {
  return {
    room_version: '10',
    event: {
      room_id: roomId,
      sender: userId,
      state_key: userId,
      type: 'm.room.member',
      content: { membership: 'join' },
      auth_events: ['$auth1'],
      prev_events: ['$prev1'],
      depth: 3,
      ...overrides,
    },
  };
}

describe('validateRemoteJoinTemplate', () => {
  it('accepts a well-formed template', () => {
    expect(() => validateRemoteJoinTemplate(validTemplate(), roomId, userId)).not.toThrow();
  });

  it('rejects unsupported room versions and missing events', () => {
    expect(() =>
      validateRemoteJoinTemplate({ room_version: '99', event: validTemplate().event }, roomId, userId)
    ).toThrow(/unsupported room_version/);
    expect(() =>
      validateRemoteJoinTemplate({ room_version: '10' }, roomId, userId)
    ).toThrow(/missing event/);
  });

  it('rejects room_id / sender / state_key spoofing', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ room_id: '!other:example.com' }), roomId, userId)
    ).toThrow(/room_id mismatch/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ sender: '@eve:example.com' }), roomId, userId)
    ).toThrow(/sender mismatch/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ state_key: '@eve:example.com' }), roomId, userId)
    ).toThrow(/state_key mismatch/);
  });

  it('rejects non-join membership and bad event type', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ content: { membership: 'invite' } }),
        roomId,
        userId
      )
    ).toThrow(/membership/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ type: 'm.room.message' }), roomId, userId)
    ).toThrow(/m.room.member/);
  });

  it('rejects empty/invalid auth_events, prev_events, or depth', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ auth_events: [] }), roomId, userId)
    ).toThrow(/auth_events/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ auth_events: ['bad'] }), roomId, userId)
    ).toThrow(/invalid event ID/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ prev_events: [] }), roomId, userId)
    ).toThrow(/prev_events/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: 0 }), roomId, userId)
    ).toThrow(/depth/);
  });
});
