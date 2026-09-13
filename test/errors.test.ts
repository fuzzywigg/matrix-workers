import { describe, it, expect } from 'vitest';
import {
  MatrixApiError,
  Errors,
  withErrorHandler,
  jsonResponse,
  emptyResponse,
} from '../src/utils/errors';
import { ErrorCodes } from '../src/types';

describe('MatrixApiError', () => {
  it('serializes errcode and message', () => {
    const err = new MatrixApiError(ErrorCodes.M_FORBIDDEN, 'nope', 403);
    expect(err.toJSON()).toEqual({ errcode: 'M_FORBIDDEN', error: 'nope' });
  });

  it('includes retry_after_ms when set', () => {
    const err = Errors.limitExceeded('slow down', 2500);
    expect(err.status).toBe(429);
    expect(err.toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow down',
      retry_after_ms: 2500,
    });
  });

  it('builds a JSON Response', async () => {
    const res = Errors.notFound('missing').toResponse();
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'missing',
    });
  });
});

describe('Errors factory', () => {
  it('maps common Matrix statuses', () => {
    expect(Errors.forbidden().status).toBe(403);
    expect(Errors.unknownToken().status).toBe(401);
    expect(Errors.missingToken().status).toBe(401);
    expect(Errors.badJson().errcode).toBe(ErrorCodes.M_BAD_JSON);
    expect(Errors.notJson().errcode).toBe(ErrorCodes.M_NOT_JSON);
    expect(Errors.unauthorized().status).toBe(401);
    expect(Errors.userDeactivated().status).toBe(403);
    expect(Errors.userInUse().errcode).toBe(ErrorCodes.M_USER_IN_USE);
    expect(Errors.invalidUsername().errcode).toBe(ErrorCodes.M_INVALID_USERNAME);
    expect(Errors.roomInUse().errcode).toBe(ErrorCodes.M_ROOM_IN_USE);
    expect(Errors.invalidRoomState().errcode).toBe(ErrorCodes.M_INVALID_ROOM_STATE);
    expect(Errors.unsupportedRoomVersion().errcode).toBe(ErrorCodes.M_UNSUPPORTED_ROOM_VERSION);
    expect(Errors.guestAccessForbidden().status).toBe(403);
    expect(Errors.tooLarge().status).toBe(413);
    expect(Errors.unknown().status).toBe(500);
    expect(Errors.unrecognized().status).toBe(400);
  });

  it('formats missing/invalid param messages', () => {
    expect(Errors.missingParam('user_id').message).toContain('user_id');
    expect(Errors.invalidParam('limit', 'must be positive').message).toBe('must be positive');
    expect(Errors.invalidParam('limit').message).toContain('limit');
  });

  it('exposes documented M_CONFLICT for concurrent state races', () => {
    const err = Errors.conflict();
    expect(err.status).toBe(409);
    expect(err.errcode).toBe(ErrorCodes.M_CONFLICT);
  });

  it('uses default messages when factory args are omitted', () => {
    expect(Errors.forbidden().message).toBeTruthy();
    expect(Errors.notFound().message).toBeTruthy();
    expect(Errors.unknownToken().message).toBeTruthy();
  });
});

describe('response helpers', () => {
  it('jsonResponse and emptyResponse set JSON content type', async () => {
    const json = jsonResponse({ ok: true }, 201);
    expect(json.status).toBe(201);
    await expect(json.json()).resolves.toEqual({ ok: true });

    const empty = emptyResponse();
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({});
  });

  it('withErrorHandler returns MatrixApiError responses', async () => {
    const res = await withErrorHandler(async () => {
      throw Errors.forbidden('denied');
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it('withErrorHandler maps unexpected errors to M_UNKNOWN', async () => {
    const res = await withErrorHandler(async () => {
      throw new Error('boom');
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
    await expect((res as Response).json()).resolves.toMatchObject({
      errcode: 'M_UNKNOWN',
    });
  });

  it('withErrorHandler returns successful values', async () => {
    await expect(withErrorHandler(async () => 42)).resolves.toBe(42);
  });
});

describe('Errors federation / media-adjacent factories', () => {
  it('maps unsupported room version and too-large media errors', () => {
    expect(Errors.unsupportedRoomVersion('99').message).toContain('99');
    expect(Errors.tooLarge('upload').status).toBe(413);
    expect(Errors.tooLarge('upload').errcode).toBe(ErrorCodes.M_TOO_LARGE);
  });

  it('preserves custom messages on unauthorized/forbidden', () => {
    expect(Errors.unauthorized('nope').message).toBe('nope');
    expect(Errors.forbidden('denied').message).toBe('denied');
  });
});


describe('errors TOKENMAXX edge paths after #49', () => {
  it('omits retry_after_ms when retryAfterMs is zero (falsy)', () => {
    const err = new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'slow', 429, 0);
    expect(err.toJSON()).toEqual({ errcode: 'M_LIMIT_EXCEEDED', error: 'slow' });
  });

  it('allows custom emptyResponse status codes with a JSON body', async () => {
    // 204/205/304 forbid bodies in the Fetch Response constructor
    const res = emptyResponse(201);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({});
  });
});

describe('errors TOKENMAXX edge paths after #50', () => {
  it('omits retry_after_ms when Errors.limitExceeded is called without retry', () => {
    expect(Errors.limitExceeded('x').toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'x',
    });
  });

  it('defaults jsonResponse status to 200', async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
