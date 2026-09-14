import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVerificationSession,
  generateSessionId,
  generateVerificationToken,
  getValidatedSession,
  sendVerificationEmail,
  validateEmailToken,
} from '../src/services/email';
import type { Env } from '../src/types';

type SessionRow = {
  session_id: string;
  email: string;
  user_id: string | null;
  client_secret: string;
  token: string;
  send_attempt: number;
  validated: number;
  created_at: number;
  expires_at: number;
  validated_at?: number | null;
};

/** Minimal D1 stand-in for email_verification_sessions paths. */
function createEmailDb(store = new Map<string, SessionRow>()) {
  return {
    store,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                const [email, clientSecret] = args as [string, string];
                const rows = [...store.values()]
                  .filter((r) => r.email === email && r.client_secret === clientSecret)
                  .sort((a, b) => b.created_at - a.created_at);
                return (rows[0] as T) ?? null;
              }
              if (sql.includes('WHERE session_id = ? AND validated = 1')) {
                const [sessionId] = args as [string];
                const row = store.get(sessionId);
                if (!row || row.validated !== 1) return null;
                return {
                  email: row.email,
                  user_id: row.user_id,
                  client_secret: row.client_secret,
                  validated: row.validated,
                } as T;
              }
              if (sql.includes('WHERE session_id = ?')) {
                const [sessionId] = args as [string];
                return (store.get(sessionId) as T) ?? null;
              }
              return null;
            },
            async run() {
              if (sql.includes('DELETE FROM email_verification_sessions')) {
                const [sessionId] = args as [string];
                store.delete(sessionId);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO email_verification_sessions')) {
                const [
                  sessionId,
                  email,
                  userId,
                  clientSecret,
                  token,
                  sendAttempt,
                  createdAt,
                  expiresAt,
                ] = args as [
                  string,
                  string,
                  string | null,
                  string,
                  string,
                  number,
                  number,
                  number,
                ];
                store.set(sessionId, {
                  session_id: sessionId,
                  email,
                  user_id: userId,
                  client_secret: clientSecret,
                  token,
                  send_attempt: sendAttempt,
                  validated: 0,
                  created_at: createdAt,
                  expires_at: expiresAt,
                  validated_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE email_verification_sessions')) {
                const [validatedAt, sessionId] = args as [number, string];
                const row = store.get(sessionId);
                if (row) {
                  row.validated = 1;
                  row.validated_at = validatedAt;
                }
                return { meta: { changes: row ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: Map<string, SessionRow> };
}

function throwingDb(method: 'first' | 'run' = 'first'): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              if (method === 'first') throw new Error('db first boom');
              return null;
            },
            async run() {
              throw new Error('db run boom');
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('email helpers TOKENMAXX edge paths after #50', () => {
  it('generates a 6-digit verification code in the 100000–999999 range', () => {
    const code = generateVerificationToken();
    expect(code).toMatch(/^\d{6}$/);
    const n = Number(code);
    expect(n).toBeGreaterThanOrEqual(100000);
    expect(n).toBeLessThanOrEqual(999999);
  });

  it('usually produces distinct verification codes across calls', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateVerificationToken()));
    expect(codes.size).toBeGreaterThan(1);
  });

  it('generates 32-char lowercase hex session ids', async () => {
    const id = await generateSessionId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it('usually produces distinct session ids across calls', async () => {
    const a = await generateSessionId();
    const b = await generateSessionId();
    expect(a).not.toBe(b);
  });
});

describe('sendVerificationEmail', () => {
  it('fails when EMAIL binding is missing', async () => {
    const result = await sendVerificationEmail({} as Env, 'a@b.c', '123456', 'example.com');
    expect(result).toEqual({ success: false, error: 'Email service not configured' });
  });

  it('uses EMAIL_FROM when set and includes token + serverName in body', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-1' }));
    const env = {
      EMAIL_FROM: 'verify@matrix.example.com',
      EMAIL: { send },
    } as unknown as Env;

    const result = await sendVerificationEmail(env, 'user@ex.com', '654321', 'matrix.example.com');
    expect(result).toEqual({ success: true });
    expect(send).toHaveBeenCalledOnce();
    const args = send.mock.calls[0][0] as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(args.from).toBe('verify@matrix.example.com');
    expect(args.to).toBe('user@ex.com');
    expect(args.subject).toBe('Your matrix.example.com verification code');
    expect(args.html).toContain('654321');
    expect(args.html).toContain('matrix.example.com');
    expect(args.text).toContain('654321');
    expect(args.text).toContain('matrix.example.com');
  });

  it('defaults from to noreply@serverName when EMAIL_FROM unset', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-2' }));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '111111', 'homeserver.test');
    expect(send.mock.calls[0][0].from).toBe('noreply@homeserver.test');
  });

  it('returns Error.message when EMAIL.send throws an Error', async () => {
    const env = {
      EMAIL: {
        send: async () => {
          throw new Error('smtp down');
        },
      },
    } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex')).toEqual({
      success: false,
      error: 'smtp down',
    });
  });

  it('returns generic failure when EMAIL.send throws a non-Error', async () => {
    const env = {
      EMAIL: {
        send: async () => {
          throw 'nope';
        },
      },
    } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex')).toEqual({
      success: false,
      error: 'Failed to send email',
    });
  });
});

describe('createVerificationSession (clock-pinned)', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserts a new session with expires_at = now + 24h and null userId', async () => {
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 1);
    expect(result).toMatchObject({ sessionId: expect.any(String), token: expect.stringMatching(/^\d{6}$/) });
    if ('error' in result) throw new Error(result.error);

    const row = [...db.store.values()][0];
    expect(row.email).toBe('a@b.c');
    expect(row.client_secret).toBe('secret');
    expect(row.user_id).toBeNull();
    expect(row.send_attempt).toBe(1);
    expect(row.validated).toBe(0);
    expect(row.created_at).toBe(NOW);
    expect(row.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(row.session_id).toBe(result.sessionId);
    expect(row.token).toBe(result.token);
  });

  it('stores optional userId when provided', async () => {
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 1, '@alice:ex.com');
    expect('sessionId' in result).toBe(true);
    expect([...db.store.values()][0].user_id).toBe('@alice:ex.com');
  });

  it('rejects when an existing session is already validated', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 1,
      validated: 1,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      error: 'Email already validated for this session',
    });
  });

  it('returns existing sessionId with empty token on same/lower sendAttempt retry', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 3,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 3)).toEqual({
      sessionId: 'old',
      token: '',
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      sessionId: 'old',
      token: '',
    });
    expect(db.store.size).toBe(1);
  });

  it('deletes old session and inserts a fresh one on higher sendAttempt', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2);
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(result.sessionId).not.toBe('old');
    expect(result.token).toMatch(/^\d{6}$/);
    expect(db.store.has('old')).toBe(false);
    expect(db.store.size).toBe(1);
    expect([...db.store.values()][0].send_attempt).toBe(2);
  });

  it('returns error when DB first() throws', async () => {
    expect(await createVerificationSession(throwingDb('first'), 'a@b.c', 's', 1)).toEqual({
      error: 'Failed to create verification session',
    });
  });

  it('returns error when DB run() throws on insert', async () => {
    expect(await createVerificationSession(throwingDb('run'), 'a@b.c', 's', 1)).toEqual({
      error: 'Failed to create verification session',
    });
  });
});

describe('validateEmailToken (clock-pinned)', () => {
  const NOW = 1_700_000_100_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(
    overrides: Partial<SessionRow> = {}
  ): D1Database & { store: Map<string, SessionRow> } {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
      ...overrides,
    });
    return db;
  }

  it('returns Session not found for unknown sessionId', async () => {
    expect(await validateEmailToken(createEmailDb(), 'missing', 's', 't')).toEqual({
      success: false,
      error: 'Session not found',
    });
  });

  it('short-circuits success when already validated without checking token', async () => {
    const db = seed({ validated: 1, token: 'other' });
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
  });

  it('treats expires_at === now as still valid (strict >)', async () => {
    const db = seed({ expires_at: NOW });
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated).toBe(1);
    expect(db.store.get('sid')!.validated_at).toBe(NOW);
  });

  it('rejects just after expiry', async () => {
    const db = seed({ expires_at: NOW - 1 });
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({
      success: false,
      error: 'Session expired',
    });
  });

  it('rejects mismatched client_secret', async () => {
    expect(await validateEmailToken(seed(), 'sid', 'wrong', '654321')).toEqual({
      success: false,
      error: 'Invalid client_secret',
    });
  });

  it('rejects mismatched token', async () => {
    expect(await validateEmailToken(seed(), 'sid', 'secret', '000000')).toEqual({
      success: false,
      error: 'Invalid token',
    });
  });

  it('marks validated with validated_at pinned to now on success', async () => {
    const db = seed();
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({ success: true });
    expect(db.store.get('sid')).toMatchObject({ validated: 1, validated_at: NOW });
  });

  it('returns Validation failed when DB throws', async () => {
    expect(await validateEmailToken(throwingDb('first'), 'sid', 's', 't')).toEqual({
      success: false,
      error: 'Validation failed',
    });
  });
});

describe('getValidatedSession', () => {
  it('returns null when session missing or not validated', async () => {
    const db = createEmailDb();
    expect(await getValidatedSession(db, 'missing', 'secret')).toBeNull();

    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 0,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toBeNull();
  });

  it('returns null when client_secret mismatches a validated session', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'wrong')).toBeNull();
  });

  it('returns email and userId when validated', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: '@u:ex.com',
    });
  });

  it('omits userId when user_id is null', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: undefined,
    });
  });
});

describe('email helpers TOKENMAXX HEAVY crypto pinning after #89', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps getRandomValues(0) → verification token "100000"', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 0;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
  });

  it('maps getRandomValues(899999) → verification token "999999"', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 899_999;
      return arr;
    });
    expect(generateVerificationToken()).toBe('999999');
  });

  it('wraps getRandomValues(900000) via % 900000 back to "100000"', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 900_000;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
  });

  it('wraps getRandomValues(1_800_000) → "100000" and 900_001 → "100001"', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    spy.mockImplementationOnce(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 1_800_000;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
    spy.mockImplementationOnce(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 900_001;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100001');
  });

  it('maps all-zero session bytes to 32 hex zeros', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) arr.fill(0);
      return arr;
    });
    expect(await generateSessionId()).toBe('0'.repeat(32));
  });

  it('maps all-0xff session bytes to 32 hex "ff" chars', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) arr.fill(0xff);
      return arr;
    });
    expect(await generateSessionId()).toBe('ff'.repeat(16));
  });

  it('zero-pads single-nibble session bytes (0x0a → "0a")', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) {
        for (let i = 0; i < arr.length; i++) arr[i] = 0x0a;
      }
      return arr;
    });
    expect(await generateSessionId()).toBe('0a'.repeat(16));
  });

  it('encodes ascending session bytes as contiguous lowercase hex', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint8Array) {
        for (let i = 0; i < arr.length; i++) arr[i] = i;
      }
      return arr;
    });
    expect(await generateSessionId()).toBe('000102030405060708090a0b0c0d0e0f');
  });
});

describe('sendVerificationEmail TOKENMAXX HEAVY body/from edges after #89', () => {
  it('treats empty-string EMAIL_FROM as falsy and falls back to noreply@serverName', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-empty-from' }));
    const env = {
      EMAIL_FROM: '',
      EMAIL: { send },
    } as unknown as Env;
    await sendVerificationEmail(env, 'user@ex.com', '424242', 'matrix.fuzzywigg.com');
    expect(send.mock.calls[0][0].from).toBe('noreply@matrix.fuzzywigg.com');
  });

  it('pins exact subject / html / text copy including 24h expiry wording', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-copy' }));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '777777', 'homeserver.test');
    const args = send.mock.calls[0][0] as {
      subject: string;
      html: string;
      text: string;
      from: string;
      to: string;
    };
    expect(args.subject).toBe('Your homeserver.test verification code');
    expect(args.from).toBe('noreply@homeserver.test');
    expect(args.to).toBe('u@ex.com');
    expect(args.html).toContain('<div class="code">777777</div>');
    expect(args.html).toContain('Your verification code for homeserver.test is:');
    expect(args.html).toContain('This code will expire in 24 hours.');
    expect(args.html).toContain('This email was sent from homeserver.test');
    expect(args.html).toContain("If you didn't request this code, you can safely ignore this email.");
    expect(args.text).toContain('Your verification code for homeserver.test is: 777777');
    expect(args.text).toContain('This code will expire in 24 hours.');
    expect(args.text).toContain('This email was sent from homeserver.test');
    expect(args.text).toContain('Email Verification');
  });

  it('interpolates unusual serverName characters into subject and bodies', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-weird' }));
    const env = {
      EMAIL_FROM: 'from@custom.example',
      EMAIL: { send },
    } as unknown as Env;
    await sendVerificationEmail(env, 'to@ex.com', '000001', 'srv:with/slash');
    const args = send.mock.calls[0][0] as { subject: string; html: string; text: string; from: string };
    expect(args.from).toBe('from@custom.example');
    expect(args.subject).toBe('Your srv:with/slash verification code');
    expect(args.html).toContain('srv:with/slash');
    expect(args.text).toContain('000001');
  });
});

describe('createVerificationSession TOKENMAXX HEAVY session edges after #89', () => {
  const NOW = 1_700_000_200_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats same email + different client_secret as independent sessions', async () => {
    const db = createEmailDb();
    const a = await createVerificationSession(db, 'a@b.c', 'secret-a', 1);
    const b = await createVerificationSession(db, 'a@b.c', 'secret-b', 1);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected error');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(db.store.size).toBe(2);
  });

  it('treats different email + same client_secret as independent sessions', async () => {
    const db = createEmailDb();
    const a = await createVerificationSession(db, 'one@ex.com', 'shared', 1);
    const b = await createVerificationSession(db, 'two@ex.com', 'shared', 1);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected error');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(db.store.size).toBe(2);
  });

  it('ORDER BY created_at DESC picks newest row for retry / validated checks', async () => {
    const db = createEmailDb();
    db.store.set('older', {
      session_id: 'older',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 5000,
      expires_at: NOW + 1000,
    });
    db.store.set('newer', {
      session_id: 'newer',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '222222',
      send_attempt: 5,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    // sendAttempt 5 matches newest → retry empty token
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 5)).toEqual({
      sessionId: 'newer',
      token: '',
    });
    // mark newest validated → reject even though older is not validated
    db.store.get('newer')!.validated = 1;
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 6)).toEqual({
      error: 'Email already validated for this session',
    });
  });

  it('send_attempt 0 existing + sendAttempt 0 is a retry (empty token)', async () => {
    const db = createEmailDb();
    db.store.set('z', {
      session_id: 'z',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '999999',
      send_attempt: 0,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 0)).toEqual({
      sessionId: 'z',
      token: '',
    });
    expect(db.store.size).toBe(1);
  });

  it('sendAttempt === existing.send_attempt + 1 deletes old and inserts fresh token', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 4,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 5);
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(result.sessionId).not.toBe('old');
    expect(result.token).toMatch(/^\d{6}$/);
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].send_attempt).toBe(5);
    expect([...db.store.values()][0].token).toBe(result.token);
  });

  it('stores empty-string userId as null via userId || null', async () => {
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 1, '');
    expect('sessionId' in result).toBe(true);
    expect([...db.store.values()][0].user_id).toBeNull();
  });

  it('returns error when DELETE throws after higher sendAttempt', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                  return {
                    session_id: 'old',
                    send_attempt: 1,
                    validated: 0,
                  } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM email_verification_sessions')) {
                  throw new Error('delete boom');
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      error: 'Failed to create verification session',
    });
  });

  it('pins expires_at exactly 24h ahead on fresh insert after delete path', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 999,
      expires_at: NOW + 1,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2, '@bob:ex.com');
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    const row = [...db.store.values()][0];
    expect(row.created_at).toBe(NOW);
    expect(row.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(row.user_id).toBe('@bob:ex.com');
    expect(row.validated).toBe(0);
  });
});

describe('validateEmailToken TOKENMAXX HEAVY error-precedence after #89', () => {
  const NOW = 1_700_000_300_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(
    overrides: Partial<SessionRow> = {}
  ): D1Database & { store: Map<string, SessionRow> } {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
      ...overrides,
    });
    return db;
  }

  it('expired + wrong client_secret → Session expired (expiry before secret)', async () => {
    expect(
      await validateEmailToken(seed({ expires_at: NOW - 1 }), 'sid', 'wrong', '654321')
    ).toEqual({ success: false, error: 'Session expired' });
  });

  it('expired + wrong token → Session expired (expiry before token)', async () => {
    expect(
      await validateEmailToken(seed({ expires_at: NOW - 1 }), 'sid', 'secret', '000000')
    ).toEqual({ success: false, error: 'Session expired' });
  });

  it('valid expiry + wrong secret + wrong token → Invalid client_secret (secret before token)', async () => {
    expect(await validateEmailToken(seed(), 'sid', 'wrong', '000000')).toEqual({
      success: false,
      error: 'Invalid client_secret',
    });
  });

  it('already validated short-circuits success without UPDATE even when expired', async () => {
    const db = seed({ validated: 1, expires_at: NOW - 1, token: 'other' });
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated_at ?? null).toBeNull();
  });

  it('success pins validated_at; second call short-circuits without changing validated_at', async () => {
    const db = seed();
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated_at).toBe(NOW);

    vi.setSystemTime(NOW + 10_000);
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated_at).toBe(NOW);
  });

  it('returns Validation failed when UPDATE run() throws after credential match', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE session_id = ?')) {
                  return {
                    session_id: 'sid',
                    email: 'a@b.c',
                    client_secret: 'secret',
                    token: '654321',
                    validated: 0,
                    expires_at: NOW + 60_000,
                  } as T;
                }
                return null;
              },
              async run() {
                throw new Error('update boom');
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({
      success: false,
      error: 'Validation failed',
    });
  });

  it('rejects at expires_at + 1ms and accepts at exact expires_at boundary', async () => {
    const exact = seed({ expires_at: NOW });
    expect(await validateEmailToken(exact, 'sid', 'secret', '654321')).toEqual({ success: true });

    const justPast = seed({ expires_at: NOW - 1 });
    expect(await validateEmailToken(justPast, 'sid', 'secret', '654321')).toEqual({
      success: false,
      error: 'Session expired',
    });
  });
});

describe('getValidatedSession TOKENMAXX HEAVY userId edges after #89', () => {
  it('maps empty-string user_id to userId: undefined via || undefined', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: undefined,
    });
  });

  it('preserves truthy non-null user_id "0"', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '0',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: '0',
    });
  });

  it('does not leak token / client_secret in the returned object', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'leak@ex.com',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: 'top-secret-token',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    const result = await getValidatedSession(db, 'sid', 'secret');
    expect(result).toEqual({ email: 'leak@ex.com', userId: '@u:ex.com' });
    expect(JSON.stringify(result)).not.toContain('top-secret-token');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('returns null for validated=1 row queried with wrong session id', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'other', 'secret')).toBeNull();
  });
});

describe('email helpers TOKENMAXX HEAVY leftover edges after #89', () => {
  const NOW = 1_700_000_400_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats any truthy validated (e.g. 2) as already-validated on create', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 1,
      validated: 2,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 9)).toEqual({
      error: 'Email already validated for this session',
    });
  });

  it('treats validated: 2 as already validated on validateEmailToken', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 2,
      created_at: NOW - 1000,
      expires_at: NOW - 1,
    });
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
  });

  it('negative sendAttempt against existing attempt 0 is a retry (sendAttempt <= existing)', async () => {
    const db = createEmailDb();
    db.store.set('z', {
      session_id: 'z',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 0,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', -1)).toEqual({
      sessionId: 'z',
      token: '',
    });
  });

  it('empty client_secret sessions are keyed independently from non-empty secrets', async () => {
    const db = createEmailDb();
    const empty = await createVerificationSession(db, 'a@b.c', '', 1);
    const nonempty = await createVerificationSession(db, 'a@b.c', 'x', 1);
    expect('sessionId' in empty && 'sessionId' in nonempty).toBe(true);
    if ('error' in empty || 'error' in nonempty) throw new Error('unexpected');
    expect(empty.sessionId).not.toBe(nonempty.sessionId);
    expect(db.store.size).toBe(2);
  });

  it('matching empty client_secret + token validates successfully', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: '',
      token: '',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
    });
    expect(await validateEmailToken(db, 'sid', '', '')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated).toBe(1);
  });

  it('getValidatedSession accepts empty client_secret when it matches', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'empty@ex.com',
      user_id: null,
      client_secret: '',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', '')).toEqual({
      email: 'empty@ex.com',
      userId: undefined,
    });
    expect(await getValidatedSession(db, 'sid', 'not-empty')).toBeNull();
  });

  it('sendVerificationEmail still succeeds when messageId is missing from send result', async () => {
    const send = vi.fn(async () => ({}));
    const env = { EMAIL: { send } } as unknown as Env;
    await expect(
      sendVerificationEmail(env, 'u@ex.com', '123456', 'ex.com')
    ).resolves.toEqual({ success: true });
  });

  it('createVerificationSession uses pinned crypto for both session id and token', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 42; // → 100042
      if (arr instanceof Uint8Array) arr.fill(0xab);
      return arr;
    });
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'pin@ex.com', 'sec', 1);
    expect(result).toEqual({
      sessionId: 'ab'.repeat(16),
      token: '100042',
    });
  });
});


describe('email helpers TOKENMAXX leftover edges after #92/#103', () => {
  const NOW = 1_700_000_500_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('getValidatedSession returns expired-but-validated sessions (no expiry check)', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'old@ex.com',
      user_id: '@u:ex.com',
      client_secret: 'sec',
      token: '123456',
      send_attempt: 1,
      validated: 1,
      created_at: NOW - 10_000,
      expires_at: NOW - 1,
    });
    expect(await getValidatedSession(db, 'sid', 'sec')).toEqual({
      email: 'old@ex.com',
      userId: '@u:ex.com',
    });
  });

  it('createVerificationSession retries expired unvalidated session without consulting expires_at', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 3,
      validated: 0,
      created_at: NOW - 10_000,
      expires_at: NOW - 1,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      sessionId: 'old',
      token: '',
    });
  });

  it('getValidatedSession rejects when first() throws (no try/catch)', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error('db down');
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(getValidatedSession(db, 'sid', 'sec')).rejects.toThrow('db down');
  });

  it('createVerificationSession with validated:0 and higher attempt replaces session', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 7;
      if (arr instanceof Uint8Array) arr.fill(0xcd);
      return arr;
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2);
    expect(result).toEqual({
      sessionId: 'cd'.repeat(16),
      token: '100007',
    });
    expect(db.store.has('old')).toBe(false);
    expect(db.store.has('cd'.repeat(16))).toBe(true);
  });
});

describe('email helpers TOKENMAXX HEAVY leftovers after #226', () => {
  const NOW = 1_700_000_600_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('maps getRandomValues(0xFFFFFFFF) via % 900000 to a pinned 6-digit token', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 0xffff_ffff;
      return arr;
    });
    expect(generateVerificationToken()).toBe(String((0xffff_ffff % 900_000) + 100_000));
    expect(generateVerificationToken()).toBe('267295');
  });

  it('maps getRandomValues(899998) → "999998" (last interior wrap boundary)', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 899_998;
      return arr;
    });
    expect(generateVerificationToken()).toBe('999998');
  });

  it('treats whitespace-only EMAIL_FROM as truthy (does not fall back to noreply@)', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-ws' }));
    const env = {
      EMAIL_FROM: ' ',
      EMAIL: { send },
    } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '123456', 'homeserver.test');
    expect(send.mock.calls[0][0].from).toBe(' ');
  });

  it('treats EMAIL: null the same as missing (service not configured)', async () => {
    const env = { EMAIL: null, EMAIL_FROM: 'from@ex.com' } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex.com')).toEqual({
      success: false,
      error: 'Email service not configured',
    });
  });

  it('returns TypeError.message when EMAIL is present but send is not a function', async () => {
    const env = { EMAIL: {} } as unknown as Env;
    const result = await sendVerificationEmail(env, 'u@ex.com', '1', 'ex.com');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not a function|send/i);
  });

  it('interpolates raw token/serverName into HTML (no escaping)', async () => {
    const send = vi.fn(async () => ({}));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '<script>1</script>', 'srv<x>');
    const html = send.mock.calls[0][0].html as string;
    const text = send.mock.calls[0][0].text as string;
    expect(html).toContain('<div class="code"><script>1</script></div>');
    expect(html).toContain('Your verification code for srv<x> is:');
    expect(text).toContain('Your verification code for srv<x> is: <script>1</script>');
  });

  it('discards pre-generated sessionId/token on already-validated create path', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 1;
      if (arr instanceof Uint8Array) arr.fill(0x11);
      return arr;
    });
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '123456',
      send_attempt: 1,
      validated: 1,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 9)).toEqual({
      error: 'Email already validated for this session',
    });
    expect(db.store.has('11'.repeat(16))).toBe(false);
    expect(db.store.size).toBe(1);
    expect(db.store.get('old')!.token).toBe('123456');
  });

  it('discards pre-generated sessionId/token on same-or-lower sendAttempt retry', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 2;
      if (arr instanceof Uint8Array) arr.fill(0x22);
      return arr;
    });
    const db = createEmailDb();
    db.store.set('keep', {
      session_id: 'keep',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '555555',
      send_attempt: 4,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 4)).toEqual({
      sessionId: 'keep',
      token: '',
    });
    expect(db.store.has('22'.repeat(16))).toBe(false);
    expect(db.store.get('keep')!.token).toBe('555555');
  });

  it('returns error when INSERT throws after a successful DELETE on higher sendAttempt', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                  return {
                    session_id: 'old',
                    send_attempt: 1,
                    validated: 0,
                  } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM email_verification_sessions')) {
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('INSERT INTO email_verification_sessions')) {
                  throw new Error('insert boom');
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      error: 'Failed to create verification session',
    });
  });

  it('treats emails that differ only by case as independent sessions', async () => {
    const db = createEmailDb();
    const a = await createVerificationSession(db, 'User@ex.com', 'sec', 1);
    const b = await createVerificationSession(db, 'user@ex.com', 'sec', 1);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(db.store.size).toBe(2);
  });

  it('jumps send_attempt from 1 to 100 (any strictly greater attempt replaces)', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 100);
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].send_attempt).toBe(100);
  });

  it('getValidatedSession requires validated === 1 (validated: 2 is create-truthy but SQL-miss)', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 2,
      created_at: 1,
      expires_at: 2,
    });
    // create path: truthy validated rejects
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 9)).toEqual({
      error: 'Email already validated for this session',
    });
    // validate path: truthy validated short-circuits success
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
    // getValidatedSession SQL is validated = 1 → miss
    expect(await getValidatedSession(db, 'sid', 'secret')).toBeNull();
  });

  it('validateEmailToken is exact-string on token/secret (whitespace mismatch is invalid)', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
    });
    expect(await validateEmailToken(db, 'sid', 'secret ', '654321')).toEqual({
      success: false,
      error: 'Invalid client_secret',
    });
    expect(await validateEmailToken(db, 'sid', 'secret', '654321 ')).toEqual({
      success: false,
      error: 'Invalid token',
    });
    expect(db.store.get('sid')!.validated).toBe(0);
  });

  it('getValidatedSession is exact-string on client_secret (leading/trailing space fails)', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', ' secret')).toBeNull();
    expect(await getValidatedSession(db, 'sid', 'secret\t')).toBeNull();
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: '@u:ex.com',
    });
  });

  it('concurrent first-create TOCTOU can insert two rows for the same email+secret', async () => {
    vi.useRealTimers();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWaiters = 0;
    const store = new Map<string, SessionRow>();

    const db = {
      store,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                  firstWaiters += 1;
                  if (firstWaiters <= 2) await firstGate;
                  const [email, clientSecret] = args as [string, string];
                  const rows = [...store.values()]
                    .filter((r) => r.email === email && r.client_secret === clientSecret)
                    .sort((a, b) => b.created_at - a.created_at);
                  return (rows[0] as T) ?? null;
                }
                return null;
              },
              async run() {
                if (sql.includes('INSERT INTO email_verification_sessions')) {
                  const [
                    sessionId,
                    email,
                    userId,
                    clientSecret,
                    token,
                    sendAttempt,
                    createdAt,
                    expiresAt,
                  ] = args as [
                    string,
                    string,
                    string | null,
                    string,
                    string,
                    number,
                    number,
                    number,
                  ];
                  store.set(sessionId, {
                    session_id: sessionId,
                    email,
                    user_id: userId,
                    client_secret: clientSecret,
                    token,
                    send_attempt: sendAttempt,
                    validated: 0,
                    created_at: createdAt,
                    expires_at: expiresAt,
                    validated_at: null,
                  });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database & { store: Map<string, SessionRow> };

    const p1 = createVerificationSession(db, 'race@ex.com', 'sec', 1);
    const p2 = createVerificationSession(db, 'race@ex.com', 'sec', 1);
    await vi.waitFor(() => {
      expect(firstWaiters).toBe(2);
    });
    releaseFirst!();
    const [a, b] = await Promise.all([p1, p2]);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected error');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(store.size).toBe(2);
  });

  it('concurrent validateEmailToken both read unvalidated and both mark success (lost-update OK)', async () => {
    vi.useRealTimers();
    const wall = Date.now();
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: wall - 1000,
      expires_at: wall + 60_000,
    });

    const [x, y] = await Promise.all([
      validateEmailToken(db, 'sid', 'secret', '654321'),
      validateEmailToken(db, 'sid', 'secret', '654321'),
    ]);
    expect(x).toEqual({ success: true });
    expect(y).toEqual({ success: true });
    expect(db.store.get('sid')!.validated).toBe(1);
    expect(db.store.get('sid')!.validated_at).toBeGreaterThanOrEqual(wall);
  });

  it('concurrent getValidatedSession is isolated across matching and mismatching secrets', async () => {
    vi.useRealTimers();
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    const results = await Promise.all([
      getValidatedSession(db, 'sid', 'secret'),
      getValidatedSession(db, 'sid', 'wrong'),
      getValidatedSession(db, 'other', 'secret'),
      getValidatedSession(db, 'sid', 'secret'),
    ]);
    expect(results[0]).toEqual({ email: 'a@b.c', userId: '@u:ex.com' });
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
    expect(results[3]).toEqual({ email: 'a@b.c', userId: '@u:ex.com' });
  });

  it('sendVerificationEmail concurrent success∥Error∥non-Error stay isolated', async () => {
    vi.useRealTimers();
    const ok = vi.fn(async () => ({ messageId: 'ok' }));
    const results = await Promise.all([
      sendVerificationEmail({ EMAIL: { send: ok } } as unknown as Env, 'a@ex.com', '111111', 'ex.com'),
      sendVerificationEmail(
        {
          EMAIL: {
            send: async () => {
              throw new Error('boom');
            },
          },
        } as unknown as Env,
        'b@ex.com',
        '222222',
        'ex.com'
      ),
      sendVerificationEmail(
        {
          EMAIL: {
            send: async () => {
              throw 42;
            },
          },
        } as unknown as Env,
        'c@ex.com',
        '333333',
        'ex.com'
      ),
      sendVerificationEmail({} as Env, 'd@ex.com', '444444', 'ex.com'),
    ]);
    expect(results[0]).toEqual({ success: true });
    expect(results[1]).toEqual({ success: false, error: 'boom' });
    expect(results[2]).toEqual({ success: false, error: 'Failed to send email' });
    expect(results[3]).toEqual({ success: false, error: 'Email service not configured' });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('create then validate then getValidatedSession happy path', async () => {
    const db = createEmailDb();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 321;
      if (arr instanceof Uint8Array) arr.fill(0x44);
      return arr;
    });

    const created = await createVerificationSession(db, 'ok@ex.com', 'sec', 1, '@alice:ex.com');
    expect(created).toEqual({ sessionId: '44'.repeat(16), token: '100321' });
    if ('error' in created) throw new Error(created.error);

    expect(await getValidatedSession(db, created.sessionId, 'sec')).toBeNull();
    expect(await validateEmailToken(db, created.sessionId, 'sec', '100321')).toEqual({ success: true });
    expect(await getValidatedSession(db, created.sessionId, 'sec')).toEqual({
      email: 'ok@ex.com',
      userId: '@alice:ex.com',
    });
  });

  it('generateSessionId requests exactly 16 bytes from getRandomValues', async () => {
    const lengths: number[] = [];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      lengths.push(arr.byteLength);
      if (arr instanceof Uint8Array) arr.fill(0x0f);
      return arr;
    });
    expect(await generateSessionId()).toBe('0f'.repeat(16));
    expect(lengths).toEqual([16]);
  });

  it('generateVerificationToken requests a single Uint32', () => {
    const kinds: string[] = [];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      kinds.push(arr.constructor.name);
      if (arr instanceof Uint32Array) {
        expect(arr.length).toBe(1);
        arr[0] = 0;
      }
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
    expect(kinds).toEqual(['Uint32Array']);
  });
});

describe('email helpers TOKENMAXX HEAVY leftovers after #232', () => {
  const NOW = 1_700_000_700_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('maps getRandomValues(899999) → "999999" and 900000 wraps to "100000" (adjacent boundaries)', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    spy.mockImplementationOnce(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 899_999;
      return arr;
    });
    expect(generateVerificationToken()).toBe('999999');
    spy.mockImplementationOnce(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 900_000;
      return arr;
    });
    expect(generateVerificationToken()).toBe('100000');
  });

  it('createVerificationSession generates sessionId before token (Uint8Array then Uint32Array order)', async () => {
    const kinds: string[] = [];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      kinds.push(arr.constructor.name);
      if (arr instanceof Uint8Array) arr.fill(0x55);
      if (arr instanceof Uint32Array) arr[0] = 5;
      return arr;
    });
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'ord@ex.com', 'sec', 1);
    expect(result).toEqual({ sessionId: '55'.repeat(16), token: '100005' });
    expect(kinds).toEqual(['Uint8Array', 'Uint32Array']);
  });

  it('NaN sendAttempt against an existing session takes the replace path (NaN <= n is false)', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 3,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 9;
      if (arr instanceof Uint8Array) arr.fill(0x66);
      return arr;
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', Number.NaN);
    expect(result).toEqual({ sessionId: '66'.repeat(16), token: '100009' });
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].send_attempt).toBeNaN();
  });

  it('Infinity sendAttempt replaces any finite existing send_attempt', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 999,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', Number.POSITIVE_INFINITY);
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].send_attempt).toBe(Number.POSITIVE_INFINITY);
  });

  it('treats validated: -1 as already-validated (truthy) on create and validate', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: -1,
      created_at: NOW - 1000,
      expires_at: NOW - 1,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 9)).toEqual({
      error: 'Email already validated for this session',
    });
    expect(await validateEmailToken(db, 'sid', 'wrong', 'wrong')).toEqual({ success: true });
    // getValidatedSession SQL still requires validated = 1
    expect(await getValidatedSession(db, 'sid', 'secret')).toBeNull();
  });

  it('stores whitespace-only userId as-is (truthy → not coerced to null)', async () => {
    const db = createEmailDb();
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 1, ' ');
    expect('sessionId' in result).toBe(true);
    expect([...db.store.values()][0].user_id).toBe(' ');
  });

  it('getValidatedSession returns empty-string email when stored email is ""', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: '',
      user_id: null,
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: '',
      userId: undefined,
    });
  });

  it('getValidatedSession preserves whitespace-only user_id', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: ' ',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'a@b.c',
      userId: ' ',
    });
  });

  it('EMAIL_FROM "0" is truthy and used as from (no noreply fallback)', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-0' }));
    const env = { EMAIL_FROM: '0', EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '123456', 'homeserver.test');
    expect(send.mock.calls[0][0].from).toBe('0');
  });

  it('pins full HTML skeleton markers (DOCTYPE, charset, code class, footer)', async () => {
    const send = vi.fn(async () => ({}));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '424242', 'homeserver.test');
    const html = send.mock.calls[0][0].html as string;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<h2>Email Verification</h2>');
    expect(html).toContain('<div class="code">424242</div>');
    expect(html).toContain('Enter this code in your Matrix client to verify your email address.');
    expect(html).toContain('class="footer"');
  });

  it('pins exact plaintext body including blank lines around the code line', async () => {
    const send = vi.fn(async () => ({}));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '424242', 'homeserver.test');
    const text = send.mock.calls[0][0].text as string;
    expect(text).toBe(`
Email Verification

Your verification code for homeserver.test is: 424242

Enter this code in your Matrix client to verify your email address.

This code will expire in 24 hours.

If you didn't request this code, you can safely ignore this email.

This email was sent from homeserver.test
`);
  });

  it('plus-addressed emails are distinct session keys from the base address', async () => {
    const db = createEmailDb();
    const a = await createVerificationSession(db, 'user@ex.com', 'sec', 1);
    const b = await createVerificationSession(db, 'user+tag@ex.com', 'sec', 1);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(db.store.size).toBe(2);
  });

  it('higher sendAttempt replace stores the new userId, not the old row userId', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: '@old:ex.com',
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2, '@new:ex.com');
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].user_id).toBe('@new:ex.com');
  });

  it('validateEmailToken rejects wrong secret even when token matches and expiry is exact boundary', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW,
    });
    expect(await validateEmailToken(db, 'sid', 'nope', '654321')).toEqual({
      success: false,
      error: 'Invalid client_secret',
    });
    expect(db.store.get('sid')!.validated).toBe(0);
  });

  it('concurrent higher-sendAttempt TOCTOU can delete once then double-insert', async () => {
    vi.useRealTimers();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWaiters = 0;
    const store = new Map<string, SessionRow>();
    store.set('old', {
      session_id: 'old',
      email: 'race@ex.com',
      user_id: null,
      client_secret: 'sec',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: Date.now() - 1000,
      expires_at: Date.now() + 60_000,
    });

    const db = {
      store,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                  firstWaiters += 1;
                  if (firstWaiters <= 2) await firstGate;
                  const [email, clientSecret] = args as [string, string];
                  const rows = [...store.values()]
                    .filter((r) => r.email === email && r.client_secret === clientSecret)
                    .sort((a, b) => b.created_at - a.created_at);
                  return (rows[0] as T) ?? null;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM email_verification_sessions')) {
                  const [sessionId] = args as [string];
                  store.delete(sessionId);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('INSERT INTO email_verification_sessions')) {
                  const [
                    sessionId,
                    email,
                    userId,
                    clientSecret,
                    token,
                    sendAttempt,
                    createdAt,
                    expiresAt,
                  ] = args as [
                    string,
                    string,
                    string | null,
                    string,
                    string,
                    number,
                    number,
                    number,
                  ];
                  store.set(sessionId, {
                    session_id: sessionId,
                    email,
                    user_id: userId,
                    client_secret: clientSecret,
                    token,
                    send_attempt: sendAttempt,
                    validated: 0,
                    created_at: createdAt,
                    expires_at: expiresAt,
                    validated_at: null,
                  });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database & { store: Map<string, SessionRow> };

    const p1 = createVerificationSession(db, 'race@ex.com', 'sec', 2);
    const p2 = createVerificationSession(db, 'race@ex.com', 'sec', 2);
    await vi.waitFor(() => {
      expect(firstWaiters).toBe(2);
    });
    releaseFirst!();
    const [a, b] = await Promise.all([p1, p2]);
    expect('sessionId' in a && 'sessionId' in b).toBe(true);
    if ('error' in a || 'error' in b) throw new Error('unexpected');
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(store.has('old')).toBe(false);
    expect(store.size).toBe(2);
  });

  it('concurrent validate wrong∥right∥expired stay isolated', async () => {
    vi.useRealTimers();
    const wall = Date.now();
    const db = createEmailDb();
    db.store.set('ok', {
      session_id: 'ok',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: wall - 1000,
      expires_at: wall + 60_000,
    });
    db.store.set('exp', {
      session_id: 'exp',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: wall - 1000,
      expires_at: wall - 1,
    });

    const results = await Promise.all([
      validateEmailToken(db, 'ok', 'secret', '000000'),
      validateEmailToken(db, 'ok', 'secret', '654321'),
      validateEmailToken(db, 'exp', 'secret', '654321'),
      validateEmailToken(db, 'missing', 'secret', '654321'),
    ]);
    expect(results[0]).toEqual({ success: false, error: 'Invalid token' });
    expect(results[1]).toEqual({ success: true });
    expect(results[2]).toEqual({ success: false, error: 'Session expired' });
    expect(results[3]).toEqual({ success: false, error: 'Session not found' });
    expect(db.store.get('ok')!.validated).toBe(1);
    expect(db.store.get('exp')!.validated).toBe(0);
  });

  it('create∥validate∥getValidatedSession soft flood across distinct secrets stays isolated', async () => {
    vi.useRealTimers();
    const db = createEmailDb();
    const secrets = Array.from({ length: 8 }, (_, i) => `sec_${i}`);
    const created = await Promise.all(
      secrets.map((sec, i) => createVerificationSession(db, `u${i}@ex.com`, sec, 1, `@u${i}:ex.com`))
    );
    for (const c of created) {
      expect('sessionId' in c).toBe(true);
      if ('error' in c) throw new Error(c.error);
    }

    const validated = await Promise.all(
      created.map((c, i) => {
        if ('error' in c) throw new Error(c.error);
        return validateEmailToken(db, c.sessionId, secrets[i], c.token);
      })
    );
    expect(validated.every((v) => v.success)).toBe(true);

    const got = await Promise.all(
      created.map((c, i) => {
        if ('error' in c) throw new Error(c.error);
        return getValidatedSession(db, c.sessionId, secrets[i]);
      })
    );
    for (let i = 0; i < got.length; i++) {
      expect(got[i]).toEqual({ email: `u${i}@ex.com`, userId: `@u${i}:ex.com` });
    }
    // wrong secret soft flood
    const wrong = await Promise.all(
      created.map((c) => {
        if ('error' in c) throw new Error(c.error);
        return getValidatedSession(db, c.sessionId, 'nope');
      })
    );
    expect(wrong.every((v) => v === null)).toBe(true);
  });

  it('sendVerificationEmail with empty serverName still builds noreply@ and subject', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-empty-srv' }));
    const env = { EMAIL: { send } } as unknown as Env;
    await sendVerificationEmail(env, 'u@ex.com', '111111', '');
    const args = send.mock.calls[0][0] as { from: string; subject: string; html: string };
    expect(args.from).toBe('noreply@');
    expect(args.subject).toBe('Your  verification code');
    expect(args.html).toContain('Your verification code for  is:');
  });

  it('createVerificationSession retry does not advance expires_at on the existing row', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 2,
      validated: 0,
      created_at: NOW - 5000,
      expires_at: NOW + 1234,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2)).toEqual({
      sessionId: 'old',
      token: '',
    });
    expect(db.store.get('old')).toMatchObject({
      expires_at: NOW + 1234,
      created_at: NOW - 5000,
      token: '111111',
      send_attempt: 2,
    });
  });

  it('validateEmailToken Session not found does not mutate an unrelated validated row', async () => {
    const db = createEmailDb();
    db.store.set('other', {
      session_id: 'other',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: 1,
      created_at: NOW - 1000,
      expires_at: NOW + 1000,
      validated_at: NOW - 500,
    });
    expect(await validateEmailToken(db, 'missing', 'secret', '654321')).toEqual({
      success: false,
      error: 'Session not found',
    });
    expect(db.store.get('other')).toMatchObject({ validated: 1, validated_at: NOW - 500 });
  });
});

describe('email helpers TOKENMAXX HEAVY leftovers after #241', () => {
  const NOW = 1_700_000_800_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('NEGATIVE_INFINITY sendAttempt is a retry (-Infinity <= n is true)', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 3,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    expect(
      await createVerificationSession(db, 'a@b.c', 'secret', Number.NEGATIVE_INFINITY)
    ).toEqual({
      sessionId: 'old',
      token: '',
    });
    expect(db.store.size).toBe(1);
    expect(db.store.get('old')!.token).toBe('111111');
  });

  it('float sendAttempt: 2.9 retries against 3; 3.5 replaces (strict <=)', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 3,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', 2.9)).toEqual({
      sessionId: 'old',
      token: '',
    });
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 8;
      if (arr instanceof Uint8Array) arr.fill(0x77);
      return arr;
    });
    const replaced = await createVerificationSession(db, 'a@b.c', 'secret', 3.5);
    expect(replaced).toEqual({ sessionId: '77'.repeat(16), token: '100008' });
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].send_attempt).toBe(3.5);
  });

  it('validated: null is falsy → create replace path (not already-validated)', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: null as unknown as number,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 11;
      if (arr instanceof Uint8Array) arr.fill(0x88);
      return arr;
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2);
    expect(result).toEqual({ sessionId: '88'.repeat(16), token: '100011' });
    expect(db.store.has('old')).toBe(false);
  });

  it('validateEmailToken with validated: null proceeds past short-circuit and can succeed', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '654321',
      send_attempt: 1,
      validated: null as unknown as number,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
    });
    expect(await validateEmailToken(db, 'sid', 'secret', '654321')).toEqual({ success: true });
    expect(db.store.get('sid')!.validated).toBe(1);
  });

  it('returns empty-string error when EMAIL.send throws Error("")', async () => {
    const env = {
      EMAIL: {
        send: async () => {
          throw new Error('');
        },
      },
    } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex.com')).toEqual({
      success: false,
      error: '',
    });
  });

  it('still calls EMAIL.send when toEmail is empty string', async () => {
    const send = vi.fn(async () => ({ messageId: 'mid-empty-to' }));
    const env = { EMAIL: { send } } as unknown as Env;
    expect(await sendVerificationEmail(env, '', '123456', 'homeserver.test')).toEqual({
      success: true,
    });
    expect(send.mock.calls[0][0].to).toBe('');
  });

  it('plain object throw from EMAIL.send → generic Failed to send email', async () => {
    const env = {
      EMAIL: {
        send: async () => {
          throw { message: 'obj' };
        },
      },
    } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex.com')).toEqual({
      success: false,
      error: 'Failed to send email',
    });
  });

  it('leading/trailing space in email are distinct session keys (no trim)', async () => {
    const db = createEmailDb();
    const a = await createVerificationSession(db, ' a@b.c', 'sec', 1);
    const b = await createVerificationSession(db, 'a@b.c', 'sec', 1);
    const c = await createVerificationSession(db, 'a@b.c ', 'sec', 1);
    expect('sessionId' in a && 'sessionId' in b && 'sessionId' in c).toBe(true);
    if ('error' in a || 'error' in b || 'error' in c) throw new Error('unexpected');
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
    expect(db.store.size).toBe(3);
  });

  it('-0 sendAttempt against existing 0 is a retry (Object.is not used)', async () => {
    const db = createEmailDb();
    db.store.set('z', {
      session_id: 'z',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '999999',
      send_attempt: 0,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    expect(await createVerificationSession(db, 'a@b.c', 'secret', -0)).toEqual({
      sessionId: 'z',
      token: '',
    });
  });

  it('DELETE changes:0 still proceeds to INSERT on higher sendAttempt', async () => {
    const store = new Map<string, SessionRow>();
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('WHERE email = ? AND client_secret = ?')) {
                  return {
                    session_id: 'old',
                    send_attempt: 1,
                    validated: 0,
                  } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM email_verification_sessions')) {
                  // pretend miss — product ignores meta.changes
                  return { meta: { changes: 0 } };
                }
                if (sql.includes('INSERT INTO email_verification_sessions')) {
                  const [
                    sessionId,
                    email,
                    userId,
                    clientSecret,
                    token,
                    sendAttempt,
                    createdAt,
                    expiresAt,
                  ] = args as [
                    string,
                    string,
                    string | null,
                    string,
                    string,
                    number,
                    number,
                    number,
                  ];
                  store.set(sessionId, {
                    session_id: sessionId,
                    email,
                    user_id: userId,
                    client_secret: clientSecret,
                    token,
                    send_attempt: sendAttempt,
                    validated: 0,
                    created_at: createdAt,
                    expires_at: expiresAt,
                    validated_at: null,
                  });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
      if (arr instanceof Uint32Array) arr[0] = 13;
      if (arr instanceof Uint8Array) arr.fill(0x99);
      return arr;
    });
    const result = await createVerificationSession(db, 'a@b.c', 'secret', 2);
    expect(result).toEqual({ sessionId: '99'.repeat(16), token: '100013' });
    expect(store.size).toBe(1);
  });

  it('MAX_SAFE_INTEGER sendAttempt replaces a finite existing attempt', async () => {
    const db = createEmailDb();
    db.store.set('old', {
      session_id: 'old',
      email: 'a@b.c',
      user_id: null,
      client_secret: 'secret',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 100,
      expires_at: NOW + 1000,
    });
    const result = await createVerificationSession(
      db,
      'a@b.c',
      'secret',
      Number.MAX_SAFE_INTEGER
    );
    expect('sessionId' in result).toBe(true);
    if ('error' in result) throw new Error(result.error);
    expect(db.store.has('old')).toBe(false);
    expect([...db.store.values()][0].send_attempt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('getValidatedSession preserves unicode email as stored (no normalize)', async () => {
    const db = createEmailDb();
    db.store.set('sid', {
      session_id: 'sid',
      email: 'üser@ex.com',
      user_id: '@u:ex.com',
      client_secret: 'secret',
      token: '1',
      send_attempt: 1,
      validated: 1,
      created_at: 1,
      expires_at: 2,
    });
    expect(await getValidatedSession(db, 'sid', 'secret')).toEqual({
      email: 'üser@ex.com',
      userId: '@u:ex.com',
    });
  });

  it('TypeError subclass message is forwarded from EMAIL.send', async () => {
    const env = {
      EMAIL: {
        send: async () => {
          throw new TypeError('send exploded');
        },
      },
    } as unknown as Env;
    expect(await sendVerificationEmail(env, 'u@ex.com', '1', 'ex.com')).toEqual({
      success: false,
      error: 'send exploded',
    });
  });

  it('concurrent -Inf retry∥float replace∥validated-null replace stay isolated', async () => {
    vi.useRealTimers();
    const db = createEmailDb();
    db.store.set('retry', {
      session_id: 'retry',
      email: 'retry@ex.com',
      user_id: null,
      client_secret: 'sec',
      token: '111111',
      send_attempt: 5,
      validated: 0,
      created_at: Date.now() - 100,
      expires_at: Date.now() + 60_000,
    });
    db.store.set('float', {
      session_id: 'float',
      email: 'float@ex.com',
      user_id: null,
      client_secret: 'sec',
      token: '222222',
      send_attempt: 3,
      validated: 0,
      created_at: Date.now() - 100,
      expires_at: Date.now() + 60_000,
    });
    db.store.set('nullv', {
      session_id: 'nullv',
      email: 'nullv@ex.com',
      user_id: null,
      client_secret: 'sec',
      token: '333333',
      send_attempt: 1,
      validated: null as unknown as number,
      created_at: Date.now() - 100,
      expires_at: Date.now() + 60_000,
    });

    const [a, b, c] = await Promise.all([
      createVerificationSession(db, 'retry@ex.com', 'sec', Number.NEGATIVE_INFINITY),
      createVerificationSession(db, 'float@ex.com', 'sec', 3.5),
      createVerificationSession(db, 'nullv@ex.com', 'sec', 2),
    ]);
    expect(a).toEqual({ sessionId: 'retry', token: '' });
    expect('sessionId' in b && b.sessionId !== 'float').toBe(true);
    expect('sessionId' in c && c.sessionId !== 'nullv').toBe(true);
    expect(db.store.has('retry')).toBe(true);
    expect(db.store.has('float')).toBe(false);
    expect(db.store.has('nullv')).toBe(false);
  });

  it('sendVerificationEmail empty-to ∥ empty-Error ∥ object-throw soft flood', async () => {
    vi.useRealTimers();
    const ok = vi.fn(async () => ({ messageId: 'ok' }));
    const results = await Promise.all([
      sendVerificationEmail({ EMAIL: { send: ok } } as unknown as Env, '', '1', 'ex.com'),
      sendVerificationEmail(
        {
          EMAIL: {
            send: async () => {
              throw new Error('');
            },
          },
        } as unknown as Env,
        'u@ex.com',
        '1',
        'ex.com'
      ),
      sendVerificationEmail(
        {
          EMAIL: {
            send: async () => {
              throw { x: 1 };
            },
          },
        } as unknown as Env,
        'u@ex.com',
        '1',
        'ex.com'
      ),
    ]);
    expect(results[0]).toEqual({ success: true });
    expect(results[1]).toEqual({ success: false, error: '' });
    expect(results[2]).toEqual({ success: false, error: 'Failed to send email' });
    expect(ok).toHaveBeenCalledOnce();
    expect(ok.mock.calls[0][0].to).toBe('');
  });
});
