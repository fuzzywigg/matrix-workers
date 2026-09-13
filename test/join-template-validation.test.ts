import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_ROOM_VERSIONS,
  validateRemoteJoinTemplate,
} from '../src/workflows/join-template-validation';

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

  it('accepts domain-suffixed event IDs and optional omitted room_id/sender', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({
          room_id: undefined,
          sender: undefined,
          auth_events: ['$auth1:example.com'],
          prev_events: ['$prev1:example.com'],
        }),
        roomId,
        userId
      )
    ).not.toThrow();
  });

  it('rejects non-object root, float/NaN/Infinity depth, and empty strings', () => {
    expect(() =>
      validateRemoteJoinTemplate(null as unknown as { room_version?: unknown }, roomId, userId)
    ).toThrow(/not an object/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: 1.5 }), roomId, userId)
    ).toThrow(/depth/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: NaN }), roomId, userId)
    ).toThrow(/depth/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: Infinity }), roomId, userId)
    ).toThrow(/depth/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ room_id: '' }), roomId, userId)
    ).toThrow(/room_id mismatch/);
  });

  it('accepts every supported Matrix room version 1–12', () => {
    for (const v of SUPPORTED_ROOM_VERSIONS) {
      expect(() =>
        validateRemoteJoinTemplate({ ...validTemplate(), room_version: v }, roomId, userId)
      ).not.toThrow();
    }
    expect(SUPPORTED_ROOM_VERSIONS.size).toBe(12);
  });

  it('rejects missing content, non-array event ID lists, and negative depth', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ content: undefined }), roomId, userId)
    ).toThrow(/membership/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ auth_events: '$only' }), roomId, userId)
    ).toThrow(/auth_events/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ prev_events: null }), roomId, userId)
    ).toThrow(/prev_events/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: -1 }), roomId, userId)
    ).toThrow(/depth/);
  });

  it('rejects invalid prev_events IDs even when auth_events are valid', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ prev_events: ['not-an-id'] }), roomId, userId)
    ).toThrow(/prev_events/);
  });

  it('rejects non-string room_version and non-object event templates', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        { room_version: 10 as unknown as string, event: validTemplate().event },
        roomId,
        userId
      )
    ).toThrow(/unsupported room_version/);
    // Arrays are typeof 'object' in JS — fall through until content.membership fails
    expect(() =>
      validateRemoteJoinTemplate({ room_version: '10', event: [] }, roomId, userId)
    ).toThrow(/membership/);
    expect(() =>
      validateRemoteJoinTemplate({ room_version: '10', event: 'nope' }, roomId, userId)
    ).toThrow(/missing event/);
  });

  it('rejects auth_events containing non-strings or whitespace IDs', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ auth_events: [123] }), roomId, userId)
    ).toThrow(/invalid event ID/);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ auth_events: ['$ bad'] }), roomId, userId)
    ).toThrow(/invalid event ID/);
  });

  it('rejects depth provided as a numeric string', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: '3' as unknown as number }), roomId, userId)
    ).toThrow(/depth/);
  });

  it('allows omitting type and state_key when the remote leaves them unset', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ type: undefined, state_key: undefined }),
        roomId,
        userId
      )
    ).not.toThrow();
  });

  it('rejects empty string room_version', () => {
    expect(() =>
      validateRemoteJoinTemplate({ ...validTemplate(), room_version: '' }, roomId, userId)
    ).toThrow(/unsupported room_version/);
  });

  it('accepts depth exactly 1 (floor is exclusive of values below 1)', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: 1 }), roomId, userId)
    ).not.toThrow();
  });

  it('rejects membership that differs only by letter case', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ content: { membership: 'Join' } }),
        roomId,
        userId
      )
    ).toThrow(/membership/);
  });
});


describe('validateRemoteJoinTemplate TOKENMAXX edge paths after #49', () => {
  it('rejects array content (typeof object) without membership join', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ content: [] }), roomId, userId)
    ).toThrow(/membership/);
  });

  it('rejects empty-string membership', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ content: { membership: '' } }),
        roomId,
        userId
      )
    ).toThrow(/membership/);
  });

  it('rejects empty-string state_key when provided', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ state_key: '' }), roomId, userId)
    ).toThrow(/state_key mismatch/);
  });

  it('accepts event IDs using the full EVENT_ID_REGEX charset', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({
          auth_events: ['$a+b/c=d_e-f'],
          prev_events: ['$A1B2C3:matrix.example.com'],
        }),
        roomId,
        userId
      )
    ).not.toThrow();
  });
});

describe('validateRemoteJoinTemplate TOKENMAXX edge paths after #50', () => {
  it('rejects undefined depth', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: undefined }), roomId, userId)
    ).toThrow(/depth/);
  });

  it('rejects empty-string sender', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ sender: '' }), roomId, userId)
    ).toThrow(/sender mismatch/);
  });

  it('rejects event IDs with empty domains', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ auth_events: ['$id:'], prev_events: ['$prev1'] }),
        roomId,
        userId
      )
    ).toThrow(/event ID/);
  });

  it('rejects non-string prev_events entries', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ prev_events: [123] }), roomId, userId)
    ).toThrow(/event ID/);
  });

  it('rejects null content', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ content: null }), roomId, userId)
    ).toThrow(/membership/);
  });

  it('rejects undefined root templates', () => {
    expect(() =>
      validateRemoteJoinTemplate(undefined as unknown as Record<string, unknown>, roomId, userId)
    ).toThrow(/not an object/);
  });
});

describe('validateRemoteJoinTemplate TOKENMAXX edge paths after #53', () => {
  it('rejects empty-string type (defined but not m.room.member)', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ type: '' }), roomId, userId)
    ).toThrow(/m.room.member/);
  });

  it('rejects content objects missing membership', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ content: {} }), roomId, userId)
    ).toThrow(/membership/);
  });

  it('rejects mixed null entries mid auth_events list', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ auth_events: ['$ok', null], prev_events: ['$prev1'] }),
        roomId,
        userId
      )
    ).toThrow(/event ID/);
  });

  it('rejects event IDs whose domain has underscore characters', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ auth_events: ['$id:bad_host'], prev_events: ['$prev1'] }),
        roomId,
        userId
      )
    ).toThrow(/event ID/);
  });
});


describe('validateRemoteJoinTemplate TOKENMAXX edge paths after #54', () => {
  it('accepts opaque event IDs without a domain suffix', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({
          auth_events: ['$opaqueOnly'],
          prev_events: ['$alsoOpaque'],
        }),
        roomId,
        userId
      )
    ).not.toThrow();
  });

  it('accepts provided room_id and sender when they equal the expected values', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ room_id: roomId, sender: userId }),
        roomId,
        userId
      )
    ).not.toThrow();
  });

  it('accepts large safe-integer depths', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: Number.MAX_SAFE_INTEGER }), roomId, userId)
    ).not.toThrow();
  });
});


describe('validateRemoteJoinTemplate TOKENMAXX edge paths after #55', () => {
  it('rejects event IDs whose domain segment contains a port colon', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({
          auth_events: ['$opaque:matrix.example.com:8448'],
          prev_events: ['$prev1'],
        }),
        roomId,
        userId
      )
    ).toThrow(/event ID/);
  });
});

describe('validateRemoteJoinTemplate TOKENMAXX leftovers after #81 (remote join)', () => {
  it('snapshots SUPPORTED_ROOM_VERSIONS membership for Matrix Spec v1.17', () => {
    expect([...SUPPORTED_ROOM_VERSIONS].sort((a, b) => Number(a) - Number(b))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
    ]);
  });

  it('accepts join content with extra non-membership fields', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({
          content: { membership: 'join', displayname: 'Alice', avatar_url: 'mxc://ex/a' },
        }),
        roomId,
        userId
      )
    ).not.toThrow();
  });

  it('accepts opaque event IDs with base64url alphabet (+ / = _ - .)', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({
          auth_events: ['$abc+/=_-.XYZ'],
          prev_events: ['$Zz9._-+=/'],
        }),
        roomId,
        userId
      )
    ).not.toThrow();
  });

  it('rejects auth_events IDs that omit the leading $', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ auth_events: ['auth1:example.com'], prev_events: ['$prev1'] }),
        roomId,
        userId
      )
    ).toThrow(/invalid event ID/);
  });

  it('rejects prev_events containing an empty string mid-list', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ auth_events: ['$ok'], prev_events: ['$prev1', ''] }),
        roomId,
        userId
      )
    ).toThrow(/invalid event ID/);
  });

  it('rejects room_version null and boolean via unsupported path', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        { room_version: null, event: validTemplate().event },
        roomId,
        userId
      )
    ).toThrow(/unsupported room_version/);
    expect(() =>
      validateRemoteJoinTemplate(
        { room_version: true as unknown as string, event: validTemplate().event },
        roomId,
        userId
      )
    ).toThrow(/unsupported room_version/);
  });

  it('rejects content that is a non-null primitive (string)', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ content: 'join' as unknown as { membership: string } }),
        roomId,
        userId
      )
    ).toThrow(/membership/);
  });

  it('rejects depth -0 the same as 0 (relational compare treats -0 as 0)', () => {
    // Number.isInteger(-0) is true; -0 < 1 is true → rejected like depth 0
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: -0 }), roomId, userId)
    ).toThrow(/depth/);
  });

  it('rejects depth Number.MIN_SAFE_INTEGER', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ depth: Number.MIN_SAFE_INTEGER }),
        roomId,
        userId
      )
    ).toThrow(/depth/);
  });

  it('accepts omitted room_id/sender/state_key/type together', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({
          room_id: undefined,
          sender: undefined,
          state_key: undefined,
          type: undefined,
        }),
        roomId,
        userId
      )
    ).not.toThrow();
  });

  it('rejects state_key spoof when sender matches', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ sender: userId, state_key: '@eve:example.com' }),
        roomId,
        userId
      )
    ).toThrow(/state_key mismatch/);
  });

  it('interpolates got room_version into the unsupported error string', () => {
    expect(() =>
      validateRemoteJoinTemplate(
        { room_version: '13', event: validTemplate().event },
        roomId,
        userId
      )
    ).toThrow(/unsupported room_version 13/);
  });

  it('rejects auth_events that are empty after a valid-looking first check short-circuit', () => {
    // empty array already covered; ensure sparse-looking list with only undefined fails
    expect(() =>
      validateRemoteJoinTemplate(
        validTemplate({ auth_events: [undefined as unknown as string], prev_events: ['$p'] }),
        roomId,
        userId
      )
    ).toThrow(/invalid event ID/);
  });

  it('rejects type m.room.member with trailing whitespace', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ type: 'm.room.member ' }), roomId, userId)
    ).toThrow(/m.room.member/);
  });
});
