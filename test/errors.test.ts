import { describe, it, expect, vi } from 'vitest';
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


describe('errors TOKENMAXX edge paths after #55', () => {
  it('maps non-Error throws to M_UNKNOWN 500', async () => {
    const res = await withErrorHandler(async () => {
      throw 'boom';
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
    await expect((res as Response).json()).resolves.toMatchObject({
      errcode: 'M_UNKNOWN',
    });
  });
});


describe('errors TOKENMAXX leftovers after #226', () => {
  it('MatrixApiError sets name and defaults status to 400', () => {
    const err = new MatrixApiError(ErrorCodes.M_BAD_JSON, 'bad');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MatrixApiError');
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('pins exact default factory messages and statuses', () => {
    expect(Errors.forbidden().message).toBe('Forbidden');
    expect(Errors.unknownToken().message).toBe('Unknown token');
    expect(Errors.missingToken().message).toBe('Missing access token');
    expect(Errors.badJson().message).toBe('Could not parse request body as JSON');
    expect(Errors.notJson().message).toBe('Content-Type must be application/json');
    expect(Errors.notFound().message).toBe('Not found');
    expect(Errors.limitExceeded().message).toBe('Rate limit exceeded');
    expect(Errors.limitExceeded().status).toBe(429);
    expect(Errors.unknown().message).toBe('An unknown error occurred');
    expect(Errors.unrecognized().message).toBe('Unrecognized request');
    expect(Errors.unauthorized().message).toBe('Unauthorized');
    expect(Errors.userDeactivated().message).toBe('User account has been deactivated');
    expect(Errors.userInUse().message).toBe('User ID already taken');
    expect(Errors.invalidUsername().message).toBe('Invalid username');
    expect(Errors.roomInUse().message).toBe('Room alias already taken');
    expect(Errors.invalidRoomState().message).toBe('Invalid room state');
    expect(Errors.unsupportedRoomVersion().message).toBe('Unsupported room version');
    expect(Errors.guestAccessForbidden().message).toBe('Guest access forbidden');
    expect(Errors.tooLarge().message).toBe('Request too large');
    expect(Errors.conflict().message).toBe('State changed concurrently; retry the operation');
    expect(Errors.conflict('race').message).toBe('race');
  });

  it('includes retry_after_ms for any truthy retryAfterMs including negatives', () => {
    const err = new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'slow', 429, -1);
    expect(err.toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
      retry_after_ms: -1,
    });
  });

  it('withErrorHandler logs unexpected Error throws before mapping to M_UNKNOWN', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await withErrorHandler(async () => {
      throw new Error('unexpected-path');
    });
    expect((res as Response).status).toBe(500);
    expect(spy).toHaveBeenCalledWith('Unexpected error:', expect.any(Error));
    spy.mockRestore();
  });

  it('jsonResponse serializes nested objects, arrays, and null', async () => {
    const res = jsonResponse({ a: [1, null, { b: true }] }, 202);
    expect(res.status).toBe(202);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({ a: [1, null, { b: true }] });
  });

  it('toResponse Content-Type is application/json and body matches toJSON', async () => {
    const err = Errors.missingParam('device_id');
    const res = err.toResponse();
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual(err.toJSON());
    expect(err.toJSON()).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: device_id',
    });
  });

  it('withErrorHandler returns MatrixApiError.toResponse verbatim for factories', async () => {
    const res = (await withErrorHandler(async () => {
      throw Errors.conflict('lost race');
    })) as Response;
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'lost race',
    });
  });
});

describe('errors TOKENMAXX leftovers after #232', () => {
  it('omits retry_after_ms for NaN and includes it for Infinity / 1', () => {
    // `if (this.retryAfterMs)` treats NaN as falsy
    expect(new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'x', 429, Number.NaN).toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'x',
    });
    expect(
      new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'x', 429, Number.POSITIVE_INFINITY).toJSON()
    ).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'x',
      retry_after_ms: Number.POSITIVE_INFINITY,
    });
    expect(Errors.limitExceeded('x', 1).toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'x',
      retry_after_ms: 1,
    });
    expect(Errors.limitExceeded('x', 0).toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'x',
    });
  });

  it('pins exact errcodes for every Errors factory', () => {
    expect(Errors.forbidden().errcode).toBe(ErrorCodes.M_FORBIDDEN);
    expect(Errors.unknownToken().errcode).toBe(ErrorCodes.M_UNKNOWN_TOKEN);
    expect(Errors.missingToken().errcode).toBe(ErrorCodes.M_MISSING_TOKEN);
    expect(Errors.badJson().errcode).toBe(ErrorCodes.M_BAD_JSON);
    expect(Errors.notJson().errcode).toBe(ErrorCodes.M_NOT_JSON);
    expect(Errors.notFound().errcode).toBe(ErrorCodes.M_NOT_FOUND);
    expect(Errors.limitExceeded().errcode).toBe(ErrorCodes.M_LIMIT_EXCEEDED);
    expect(Errors.unknown().errcode).toBe(ErrorCodes.M_UNKNOWN);
    expect(Errors.unrecognized().errcode).toBe(ErrorCodes.M_UNRECOGNIZED);
    expect(Errors.unauthorized().errcode).toBe(ErrorCodes.M_UNAUTHORIZED);
    expect(Errors.userDeactivated().errcode).toBe(ErrorCodes.M_USER_DEACTIVATED);
    expect(Errors.userInUse().errcode).toBe(ErrorCodes.M_USER_IN_USE);
    expect(Errors.invalidUsername().errcode).toBe(ErrorCodes.M_INVALID_USERNAME);
    expect(Errors.roomInUse().errcode).toBe(ErrorCodes.M_ROOM_IN_USE);
    expect(Errors.invalidRoomState().errcode).toBe(ErrorCodes.M_INVALID_ROOM_STATE);
    expect(Errors.unsupportedRoomVersion().errcode).toBe(ErrorCodes.M_UNSUPPORTED_ROOM_VERSION);
    expect(Errors.guestAccessForbidden().errcode).toBe(ErrorCodes.M_GUEST_ACCESS_FORBIDDEN);
    expect(Errors.missingParam('p').errcode).toBe(ErrorCodes.M_MISSING_PARAM);
    expect(Errors.invalidParam('p').errcode).toBe(ErrorCodes.M_INVALID_PARAM);
    expect(Errors.tooLarge().errcode).toBe(ErrorCodes.M_TOO_LARGE);
    expect(Errors.conflict().errcode).toBe(ErrorCodes.M_CONFLICT);
  });

  it('invalidParam default message embeds the parameter name exactly', () => {
    expect(Errors.invalidParam('limit').message).toBe('Invalid parameter: limit');
    expect(Errors.invalidParam('user_id', 'must be MXID').message).toBe('must be MXID');
  });

  it('withErrorHandler passes through limitExceeded retry_after_ms in the Response body', async () => {
    const res = (await withErrorHandler(async () => {
      throw Errors.limitExceeded('slow', 1500);
    })) as Response;
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
      retry_after_ms: 1500,
    });
  });

  it('withErrorHandler returns a successful Response value as-is', async () => {
    const ok = jsonResponse({ ok: true }, 201);
    const res = await withErrorHandler(async () => ok);
    expect(res).toBe(ok);
    expect((res as Response).status).toBe(201);
  });

  it('jsonResponse with undefined yields an empty body; null serializes as JSON null', async () => {
    // JSON.stringify(undefined) is undefined → Response body is empty
    const undef = jsonResponse(undefined);
    expect(undef.status).toBe(200);
    await expect(undef.text()).resolves.toBe('');
    const res = jsonResponse(null, 200);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toBeNull();
  });

  it('emptyResponse always sets application/json Content-Type', () => {
    expect(emptyResponse().headers.get('Content-Type')).toBe('application/json');
    expect(emptyResponse(201).headers.get('Content-Type')).toBe('application/json');
  });

  it('Errors factories return distinct MatrixApiError instances each call', () => {
    const a = Errors.forbidden();
    const b = Errors.forbidden();
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(MatrixApiError);
    expect(a).toBeInstanceOf(Error);
  });

  it('withErrorHandler maps null throws to M_UNKNOWN and logs them', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = (await withErrorHandler(async () => {
      throw null;
    })) as Response;
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(spy).toHaveBeenCalledWith('Unexpected error:', null);
    spy.mockRestore();
  });
});

describe('errors TOKENMAXX leftovers after #241', () => {
  it('limitExceeded.toResponse includes retry_after_ms in the JSON body', async () => {
    const res = Errors.limitExceeded('slow', 2500).toResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
      retry_after_ms: 2500,
    });
  });

  it('toResponse omits retry_after_ms when retryAfterMs is 0 (falsy)', async () => {
    const res = new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'slow', 429, 0).toResponse();
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
    });
  });

  it('withErrorHandler does not console.error MatrixApiError throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = (await withErrorHandler(async () => {
      throw Errors.forbidden('denied');
    })) as Response;
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'denied',
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('pins status 400 for missingParam / invalidParam and custom guestAccessForbidden message', () => {
    expect(Errors.missingParam('user_id').status).toBe(400);
    expect(Errors.invalidParam('limit').status).toBe(400);
    expect(Errors.guestAccessForbidden('no guests').message).toBe('no guests');
    expect(Errors.guestAccessForbidden('no guests').status).toBe(403);
  });

  it('jsonResponse serializes primitive string and number bodies', async () => {
    await expect(jsonResponse('ok', 200).json()).resolves.toBe('ok');
    await expect(jsonResponse(7, 201).json()).resolves.toBe(7);
    expect(jsonResponse(7, 201).status).toBe(201);
  });

  it('emptyResponse body matches jsonResponse({}) at the same status', async () => {
    const a = emptyResponse(201);
    const b = jsonResponse({}, 201);
    expect(a.status).toBe(b.status);
    expect(a.headers.get('Content-Type')).toBe(b.headers.get('Content-Type'));
    await expect(a.json()).resolves.toEqual(await b.json());
  });

  it('withErrorHandler maps undefined throws to M_UNKNOWN and logs them', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = (await withErrorHandler(async () => {
      throw undefined;
    })) as Response;
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(spy).toHaveBeenCalledWith('Unexpected error:', undefined);
    spy.mockRestore();
  });
});

describe('errors TOKENMAXX residual leftovers after #252', () => {
  it('toJSON omits retry_after_ms when retryAfterMs is undefined', () => {
    const err = new MatrixApiError(ErrorCodes.M_FORBIDDEN, 'nope', 403);
    expect(err.toJSON()).toEqual({ errcode: 'M_FORBIDDEN', error: 'nope' });
    expect(err.toJSON()).not.toHaveProperty('retry_after_ms');
  });

  it('conflict factory pins 409 / M_CONFLICT with custom message', () => {
    const err = Errors.conflict('race');
    expect(err.status).toBe(409);
    expect(err.errcode).toBe(ErrorCodes.M_CONFLICT);
    expect(err.message).toBe('race');
    expect(err.toJSON()).toEqual({ errcode: 'M_CONFLICT', error: 'race' });
  });

  it('withErrorHandler passes through non-Response success values', async () => {
    await expect(withErrorHandler(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(withErrorHandler(async () => 42)).resolves.toBe(42);
  });

  it('tooLarge default message and status', async () => {
    const err = Errors.tooLarge();
    expect(err.status).toBe(413);
    expect(err.errcode).toBe(ErrorCodes.M_TOO_LARGE);
    expect(err.message).toBe('Request too large');
    const res = err.toResponse();
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_TOO_LARGE',
      error: 'Request too large',
    });
  });

  it('jsonResponse default status is 200 when omitted', async () => {
    const res = jsonResponse({ a: 1 });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ a: 1 });
  });

  it('withErrorHandler maps string throws to M_UNKNOWN and logs the string', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = (await withErrorHandler(async () => {
      throw 'boom';
    })) as Response;
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(spy).toHaveBeenCalledWith('Unexpected error:', 'boom');
    spy.mockRestore();
  });
});

describe('errors TOKENMAXX residual leftovers after #264', () => {
  it('includes retry_after_ms for Number.NEGATIVE_INFINITY (truthy)', () => {
    const err = new MatrixApiError(
      ErrorCodes.M_LIMIT_EXCEEDED,
      'slow',
      429,
      Number.NEGATIVE_INFINITY
    );
    expect(err.toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
      retry_after_ms: Number.NEGATIVE_INFINITY,
    });
  });

  it('concurrent withErrorHandler isolates MatrixApiError vs success vs unknown', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [conflict, ok, unknown] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.conflict('race');
      }),
      withErrorHandler(async () => jsonResponse({ ok: true }, 201)),
      withErrorHandler(async () => {
        throw new Error('boom');
      }),
    ]);
    expect((conflict as Response).status).toBe(409);
    await expect((conflict as Response).json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'race',
    });
    expect(ok).toBeInstanceOf(Response);
    expect((ok as Response).status).toBe(201);
    expect((unknown as Response).status).toBe(500);
    await expect((unknown as Response).json()).resolves.toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(spy).toHaveBeenCalledWith('Unexpected error:', expect.any(Error));
    spy.mockRestore();
  });

  it('Errors.conflict / tooLarge / unknown produce distinct Response bodies under race', async () => {
    const [c, t, u] = await Promise.all([
      Promise.resolve(Errors.conflict().toResponse()),
      Promise.resolve(Errors.tooLarge('upload').toResponse()),
      Promise.resolve(Errors.unknown('oops').toResponse()),
    ]);
    expect(c).not.toBe(t);
    expect(c.status).toBe(409);
    expect(t.status).toBe(413);
    expect(u.status).toBe(500);
    await expect(c.json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'State changed concurrently; retry the operation',
    });
    await expect(t.json()).resolves.toEqual({ errcode: 'M_TOO_LARGE', error: 'upload' });
    await expect(u.json()).resolves.toEqual({ errcode: 'M_UNKNOWN', error: 'oops' });
  });

  it('jsonResponse serializes boolean false and empty array under concurrent calls', async () => {
    const [f, arr, obj] = await Promise.all([
      Promise.resolve(jsonResponse(false, 200)),
      Promise.resolve(jsonResponse([], 202)),
      Promise.resolve(jsonResponse({ a: false }, 200)),
    ]);
    expect(f.status).toBe(200);
    await expect(f.json()).resolves.toBe(false);
    expect(arr.status).toBe(202);
    await expect(arr.json()).resolves.toEqual([]);
    await expect(obj.json()).resolves.toEqual({ a: false });
  });

  it('withErrorHandler passes limitExceeded retry_after_ms through concurrent throws', async () => {
    const [a, b] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.limitExceeded('a', 100);
      }),
      withErrorHandler(async () => {
        throw Errors.limitExceeded('b', 200);
      }),
    ]);
    await expect((a as Response).json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'a',
      retry_after_ms: 100,
    });
    await expect((b as Response).json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'b',
      retry_after_ms: 200,
    });
  });

  it('emptyResponse and jsonResponse({}) stay independent Response instances', async () => {
    const [e, j] = await Promise.all([
      Promise.resolve(emptyResponse(201)),
      Promise.resolve(jsonResponse({}, 201)),
    ]);
    expect(e).not.toBe(j);
    expect(e.status).toBe(201);
    expect(j.status).toBe(201);
    await expect(e.json()).resolves.toEqual({});
    await expect(j.json()).resolves.toEqual({});
  });
});

describe('errors TOKENMAXX residual leftovers after #272', () => {
  it('toJSON omits retry_after_ms for falsy -0 while including NEGATIVE_INFINITY', () => {
    const omit = new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'neg-zero', 429, Number(-0));
    const keep = new MatrixApiError(ErrorCodes.M_LIMIT_EXCEEDED, 'neg-inf', 429, Number.NEGATIVE_INFINITY);
    expect(omit.toJSON()).toEqual({ errcode: 'M_LIMIT_EXCEEDED', error: 'neg-zero' });
    expect(Object.prototype.hasOwnProperty.call(omit.toJSON(), 'retry_after_ms')).toBe(false);
    expect(keep.toJSON()).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'neg-inf',
      retry_after_ms: Number.NEGATIVE_INFINITY,
    });
  });

  it('withErrorHandler passes through fulfilled undefined alongside a MatrixApiError race', async () => {
    const [undef, conflict] = await Promise.all([
      withErrorHandler(async () => undefined),
      withErrorHandler(async () => {
        throw Errors.conflict('race');
      }),
    ]);
    expect(undef).toBeUndefined();
    expect(conflict).toBeInstanceOf(Response);
    expect((conflict as Response).status).toBe(409);
    await expect((conflict as Response).json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'race',
    });
  });

  it('userInUse / roomInUse / guestAccessForbidden / invalidRoomState stay isolated under race', async () => {
    const [u, r, g, i] = await Promise.all([
      Promise.resolve(Errors.userInUse('u').toResponse()),
      Promise.resolve(Errors.roomInUse('r').toResponse()),
      Promise.resolve(Errors.guestAccessForbidden('g').toResponse()),
      Promise.resolve(Errors.invalidRoomState('i').toResponse()),
    ]);
    expect(u).not.toBe(r);
    expect(u.status).toBe(400);
    expect(r.status).toBe(400);
    expect(g.status).toBe(403);
    expect(i.status).toBe(400);
    await expect(u.json()).resolves.toEqual({ errcode: 'M_USER_IN_USE', error: 'u' });
    await expect(r.json()).resolves.toEqual({ errcode: 'M_ROOM_IN_USE', error: 'r' });
    await expect(g.json()).resolves.toEqual({ errcode: 'M_GUEST_ACCESS_FORBIDDEN', error: 'g' });
    await expect(i.json()).resolves.toEqual({ errcode: 'M_INVALID_ROOM_STATE', error: 'i' });
  });

  it('emptyResponse() default 200 races with emptyResponse(202)', async () => {
    const [def, custom] = await Promise.all([
      Promise.resolve(emptyResponse()),
      Promise.resolve(emptyResponse(202)),
    ]);
    expect(def).not.toBe(custom);
    expect(def.status).toBe(200);
    expect(custom.status).toBe(202);
    await expect(def.json()).resolves.toEqual({});
    await expect(custom.json()).resolves.toEqual({});
  });
});

describe('errors TOKENMAXX residual second-wave leftovers after #282', () => {
  it('remaining auth/json/notFound factories stay isolated under race', async () => {
    const [nj, bj, unauth, missTok, deact, unsup, unrec, missP, nf] = await Promise.all([
      Promise.resolve(Errors.notJson('nj').toResponse()),
      Promise.resolve(Errors.badJson('bj').toResponse()),
      Promise.resolve(Errors.unauthorized('ua').toResponse()),
      Promise.resolve(Errors.missingToken('mt').toResponse()),
      Promise.resolve(Errors.userDeactivated('ud').toResponse()),
      Promise.resolve(Errors.unsupportedRoomVersion('urv').toResponse()),
      Promise.resolve(Errors.unrecognized('ur').toResponse()),
      Promise.resolve(Errors.missingParam('device_id').toResponse()),
      Promise.resolve(Errors.notFound('gone').toResponse()),
    ]);
    expect(new Set([nj, bj, unauth, missTok, deact, unsup, unrec, missP, nf]).size).toBe(9);
    expect(nj.status).toBe(400);
    expect(bj.status).toBe(400);
    expect(unauth.status).toBe(401);
    expect(missTok.status).toBe(401);
    expect(deact.status).toBe(403);
    expect(unsup.status).toBe(400);
    expect(unrec.status).toBe(400);
    expect(missP.status).toBe(400);
    expect(nf.status).toBe(404);
    await expect(nj.json()).resolves.toEqual({ errcode: 'M_NOT_JSON', error: 'nj' });
    await expect(bj.json()).resolves.toEqual({ errcode: 'M_BAD_JSON', error: 'bj' });
    await expect(unauth.json()).resolves.toEqual({ errcode: 'M_UNAUTHORIZED', error: 'ua' });
    await expect(missTok.json()).resolves.toEqual({ errcode: 'M_MISSING_TOKEN', error: 'mt' });
    await expect(deact.json()).resolves.toEqual({ errcode: 'M_USER_DEACTIVATED', error: 'ud' });
    await expect(unsup.json()).resolves.toEqual({
      errcode: 'M_UNSUPPORTED_ROOM_VERSION',
      error: 'urv',
    });
    await expect(unrec.json()).resolves.toEqual({ errcode: 'M_UNRECOGNIZED', error: 'ur' });
    await expect(missP.json()).resolves.toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: device_id',
    });
    await expect(nf.json()).resolves.toEqual({ errcode: 'M_NOT_FOUND', error: 'gone' });
  });

  it('withErrorHandler races notJson + missingToken + unexpected throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [a, b, c] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.notJson('race-nj');
      }),
      withErrorHandler(async () => {
        throw Errors.missingToken('race-mt');
      }),
      withErrorHandler(async () => {
        throw new Error('boom-sw');
      }),
    ]);
    expect(a).toBeInstanceOf(Response);
    expect(b).toBeInstanceOf(Response);
    expect(c).toBeInstanceOf(Response);
    expect((a as Response).status).toBe(400);
    expect((b as Response).status).toBe(401);
    expect((c as Response).status).toBe(500);
    await expect((a as Response).json()).resolves.toEqual({
      errcode: 'M_NOT_JSON',
      error: 'race-nj',
    });
    await expect((b as Response).json()).resolves.toEqual({
      errcode: 'M_MISSING_TOKEN',
      error: 'race-mt',
    });
    await expect((c as Response).json()).resolves.toEqual({
      errcode: 'M_UNKNOWN',
      error: 'An unknown error occurred',
    });
    expect(spy).toHaveBeenCalledWith('Unexpected error:', expect.any(Error));
    spy.mockRestore();
  });
});

describe('errors TOKENMAXX residual tertiary leftovers after #290', () => {
  it('forbidden / unknownToken / invalidUsername / invalidParam stay isolated under race', async () => {
    const [forb, tok, user, param, paramCustom] = await Promise.all([
      Promise.resolve(Errors.forbidden('nope').toResponse()),
      Promise.resolve(Errors.unknownToken('bad').toResponse()),
      Promise.resolve(Errors.invalidUsername('badname').toResponse()),
      Promise.resolve(Errors.invalidParam('limit').toResponse()),
      Promise.resolve(Errors.invalidParam('user_id', 'must be MXID').toResponse()),
    ]);
    expect(new Set([forb, tok, user, param, paramCustom]).size).toBe(5);
    expect(forb.status).toBe(403);
    expect(tok.status).toBe(401);
    expect(user.status).toBe(400);
    expect(param.status).toBe(400);
    expect(paramCustom.status).toBe(400);
    await expect(forb.json()).resolves.toEqual({ errcode: 'M_FORBIDDEN', error: 'nope' });
    await expect(tok.json()).resolves.toEqual({ errcode: 'M_UNKNOWN_TOKEN', error: 'bad' });
    await expect(user.json()).resolves.toEqual({ errcode: 'M_INVALID_USERNAME', error: 'badname' });
    await expect(param.json()).resolves.toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid parameter: limit',
    });
    await expect(paramCustom.json()).resolves.toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'must be MXID',
    });
  });

  it('withErrorHandler races forbidden + invalidParam + unknownToken', async () => {
    const [a, b, c] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.forbidden('denied');
      }),
      withErrorHandler(async () => {
        throw Errors.invalidParam('device_id');
      }),
      withErrorHandler(async () => {
        throw Errors.unknownToken('gone');
      }),
    ]);
    expect((a as Response).status).toBe(403);
    expect((b as Response).status).toBe(400);
    expect((c as Response).status).toBe(401);
    await expect((a as Response).json()).resolves.toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'denied',
    });
    await expect((b as Response).json()).resolves.toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid parameter: device_id',
    });
    await expect((c as Response).json()).resolves.toEqual({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'gone',
    });
  });

  it('Errors.unknown default ∥ custom message produce distinct bodies under race', async () => {
    const [def, custom] = await Promise.all([
      Promise.resolve(Errors.unknown().toResponse()),
      Promise.resolve(Errors.unknown('boom-tertiary').toResponse()),
    ]);
    expect(def).not.toBe(custom);
    expect(def.status).toBe(500);
    expect(custom.status).toBe(500);
    await expect(def.json()).resolves.toEqual({
      errcode: 'M_UNKNOWN',
      error: 'An unknown error occurred',
    });
    await expect(custom.json()).resolves.toEqual({
      errcode: 'M_UNKNOWN',
      error: 'boom-tertiary',
    });
  });
});

describe('errors TOKENMAXX residual quaternary leftovers after #310', () => {
  it('tooLarge / conflict / limitExceeded default exact bodies stay isolated under race', async () => {
    const [large, conflict, lim, limRetry] = await Promise.all([
      Promise.resolve(Errors.tooLarge().toResponse()),
      Promise.resolve(Errors.conflict().toResponse()),
      Promise.resolve(Errors.limitExceeded().toResponse()),
      Promise.resolve(Errors.limitExceeded('slow', 900).toResponse()),
    ]);
    expect(new Set([large, conflict, lim, limRetry]).size).toBe(4);
    expect(large.status).toBe(413);
    expect(conflict.status).toBe(409);
    expect(lim.status).toBe(429);
    expect(limRetry.status).toBe(429);
    await expect(large.json()).resolves.toEqual({
      errcode: 'M_TOO_LARGE',
      error: 'Request too large',
    });
    await expect(conflict.json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'State changed concurrently; retry the operation',
    });
    await expect(lim.json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Rate limit exceeded',
    });
    await expect(limRetry.json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
      retry_after_ms: 900,
    });
  });

  it('withErrorHandler races tooLarge + conflict + limitExceeded(retry)', async () => {
    const [a, b, c] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.tooLarge('huge');
      }),
      withErrorHandler(async () => {
        throw Errors.conflict('lost');
      }),
      withErrorHandler(async () => {
        throw Errors.limitExceeded('wait', 42);
      }),
    ]);
    expect((a as Response).status).toBe(413);
    expect((b as Response).status).toBe(409);
    expect((c as Response).status).toBe(429);
    await expect((a as Response).json()).resolves.toEqual({
      errcode: 'M_TOO_LARGE',
      error: 'huge',
    });
    await expect((b as Response).json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'lost',
    });
    await expect((c as Response).json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'wait',
      retry_after_ms: 42,
    });
  });

  it('jsonResponse ∥ emptyResponse default/custom statuses stay independent under race', async () => {
    const [jsonDef, jsonCustom, emptyDef, emptyCustom] = await Promise.all([
      Promise.resolve(jsonResponse({ ok: true })),
      Promise.resolve(jsonResponse({ ok: false }, 201)),
      Promise.resolve(emptyResponse()),
      Promise.resolve(emptyResponse(202)),
    ]);
    expect(new Set([jsonDef, jsonCustom, emptyDef, emptyCustom]).size).toBe(4);
    expect(jsonDef.status).toBe(200);
    expect(jsonCustom.status).toBe(201);
    expect(emptyDef.status).toBe(200);
    expect(emptyCustom.status).toBe(202);
    await expect(jsonDef.json()).resolves.toEqual({ ok: true });
    await expect(jsonCustom.json()).resolves.toEqual({ ok: false });
    await expect(emptyDef.json()).resolves.toEqual({});
    await expect(emptyCustom.json()).resolves.toEqual({});
    expect(jsonDef.headers.get('Content-Type')).toBe('application/json');
    expect(emptyCustom.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('errors TOKENMAXX residual quinary leftovers after #319', () => {
  it('userInUse/roomInUse/guestAccess/invalidRoomState/unsupportedRoomVersion default exacts under race', async () => {
    const [user, room, guest, state, ver] = await Promise.all([
      Promise.resolve(Errors.userInUse().toResponse()),
      Promise.resolve(Errors.roomInUse().toResponse()),
      Promise.resolve(Errors.guestAccessForbidden().toResponse()),
      Promise.resolve(Errors.invalidRoomState().toResponse()),
      Promise.resolve(Errors.unsupportedRoomVersion().toResponse()),
    ]);
    expect(new Set([user, room, guest, state, ver]).size).toBe(5);
    expect(user.status).toBe(400);
    expect(room.status).toBe(400);
    expect(guest.status).toBe(403);
    expect(state.status).toBe(400);
    expect(ver.status).toBe(400);
    await expect(user.json()).resolves.toEqual({
      errcode: 'M_USER_IN_USE',
      error: 'User ID already taken',
    });
    await expect(room.json()).resolves.toEqual({
      errcode: 'M_ROOM_IN_USE',
      error: 'Room alias already taken',
    });
    await expect(guest.json()).resolves.toEqual({
      errcode: 'M_GUEST_ACCESS_FORBIDDEN',
      error: 'Guest access forbidden',
    });
    await expect(state.json()).resolves.toEqual({
      errcode: 'M_INVALID_ROOM_STATE',
      error: 'Invalid room state',
    });
    await expect(ver.json()).resolves.toEqual({
      errcode: 'M_UNSUPPORTED_ROOM_VERSION',
      error: 'Unsupported room version',
    });
  });

  it('withErrorHandler success ∥ MatrixApiError ∥ unexpected throw stay isolated under race', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [ok, err, boom] = await Promise.all([
      withErrorHandler(async () => ({ ok: true, n: 1 })),
      withErrorHandler(async () => {
        throw Errors.userInUse('taken');
      }),
      withErrorHandler(async () => {
        throw new TypeError('boom-quinary');
      }),
    ]);
    expect(ok).toEqual({ ok: true, n: 1 });
    expect(err).toBeInstanceOf(Response);
    expect(boom).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(400);
    expect((boom as Response).status).toBe(500);
    await expect((err as Response).json()).resolves.toEqual({
      errcode: 'M_USER_IN_USE',
      error: 'taken',
    });
    await expect((boom as Response).json()).resolves.toEqual({
      errcode: 'M_UNKNOWN',
      error: 'An unknown error occurred',
    });
    expect(spy).toHaveBeenCalledWith('Unexpected error:', expect.any(TypeError));
    spy.mockRestore();
  });

  it('limitExceeded retryAfterMs 0 omit ∥ positive include ∥ toJSON under race', async () => {
    const [omit, keep, keepNeg] = await Promise.all([
      Promise.resolve(Errors.limitExceeded('zero', 0).toResponse()),
      Promise.resolve(Errors.limitExceeded('pos', 2500).toResponse()),
      Promise.resolve(Errors.limitExceeded('neg', -1).toJSON()),
    ]);
    expect(omit.status).toBe(429);
    expect(keep.status).toBe(429);
    await expect(omit.json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'zero',
    });
    await expect(keep.json()).resolves.toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'pos',
      retry_after_ms: 2500,
    });
    expect(keepNeg).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'neg',
      retry_after_ms: -1,
    });
  });

  it('withErrorHandler races userInUse + roomInUse + guestAccessForbidden defaults', async () => {
    const [a, b, c] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.userInUse();
      }),
      withErrorHandler(async () => {
        throw Errors.roomInUse();
      }),
      withErrorHandler(async () => {
        throw Errors.guestAccessForbidden();
      }),
    ]);
    expect((a as Response).status).toBe(400);
    expect((b as Response).status).toBe(400);
    expect((c as Response).status).toBe(403);
    await expect((a as Response).json()).resolves.toEqual({
      errcode: 'M_USER_IN_USE',
      error: 'User ID already taken',
    });
    await expect((b as Response).json()).resolves.toEqual({
      errcode: 'M_ROOM_IN_USE',
      error: 'Room alias already taken',
    });
    await expect((c as Response).json()).resolves.toEqual({
      errcode: 'M_GUEST_ACCESS_FORBIDDEN',
      error: 'Guest access forbidden',
    });
  });

  it('jsonResponse nested/null/array bodies ∥ emptyResponse custom stay independent under race', async () => {
    const [nested, nul, arr, empty] = await Promise.all([
      Promise.resolve(jsonResponse({ a: { b: [1, null] } }, 200)),
      Promise.resolve(jsonResponse(null, 200)),
      Promise.resolve(jsonResponse([1, 2, 3], 202)),
      Promise.resolve(emptyResponse(201)),
    ]);
    expect(new Set([nested, nul, arr, empty]).size).toBe(4);
    expect(nested.status).toBe(200);
    expect(nul.status).toBe(200);
    expect(arr.status).toBe(202);
    expect(empty.status).toBe(201);
    await expect(nested.json()).resolves.toEqual({ a: { b: [1, null] } });
    await expect(nul.json()).resolves.toBeNull();
    await expect(arr.json()).resolves.toEqual([1, 2, 3]);
    await expect(empty.json()).resolves.toEqual({});
  });
});

describe('errors TOKENMAXX residual senary leftovers after #330', () => {
  it('missingParam/invalidParam/conflict/tooLarge/unrecognized default exacts under race', async () => {
    const [miss, inv, conf, large, unrec] = await Promise.all([
      Promise.resolve(Errors.missingParam('user_id').toResponse()),
      Promise.resolve(Errors.invalidParam('limit').toResponse()),
      Promise.resolve(Errors.conflict().toResponse()),
      Promise.resolve(Errors.tooLarge().toResponse()),
      Promise.resolve(Errors.unrecognized().toResponse()),
    ]);
    expect(new Set([miss, inv, conf, large, unrec]).size).toBe(5);
    expect(miss.status).toBe(400);
    expect(inv.status).toBe(400);
    expect(conf.status).toBe(409);
    expect(large.status).toBe(413);
    expect(unrec.status).toBe(400);
    await expect(miss.json()).resolves.toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: user_id',
    });
    await expect(inv.json()).resolves.toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid parameter: limit',
    });
    await expect(conf.json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'State changed concurrently; retry the operation',
    });
    await expect(large.json()).resolves.toEqual({
      errcode: 'M_TOO_LARGE',
      error: 'Request too large',
    });
    await expect(unrec.json()).resolves.toEqual({
      errcode: 'M_UNRECOGNIZED',
      error: 'Unrecognized request',
    });
  });

  it('withErrorHandler races missingParam + conflict + tooLarge + unrecognized customs', async () => {
    const [a, b, c, d] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.missingParam('device_id');
      }),
      withErrorHandler(async () => {
        throw Errors.conflict('lost-race');
      }),
      withErrorHandler(async () => {
        throw Errors.tooLarge('huge');
      }),
      withErrorHandler(async () => {
        throw Errors.unrecognized('nope');
      }),
    ]);
    expect((a as Response).status).toBe(400);
    expect((b as Response).status).toBe(409);
    expect((c as Response).status).toBe(413);
    expect((d as Response).status).toBe(400);
    await expect((a as Response).json()).resolves.toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: device_id',
    });
    await expect((b as Response).json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'lost-race',
    });
    await expect((c as Response).json()).resolves.toEqual({
      errcode: 'M_TOO_LARGE',
      error: 'huge',
    });
    await expect((d as Response).json()).resolves.toEqual({
      errcode: 'M_UNRECOGNIZED',
      error: 'nope',
    });
  });

  it('MatrixApiError.name ∥ errcode ∥ custom status stay independent under race', async () => {
    const [a, b, c] = await Promise.all([
      Promise.resolve(new MatrixApiError(ErrorCodes.M_FORBIDDEN, 'x', 403)),
      Promise.resolve(new MatrixApiError(ErrorCodes.M_NOT_FOUND, 'y', 404)),
      Promise.resolve(new MatrixApiError(ErrorCodes.M_UNKNOWN, 'z', 502)),
    ]);
    expect(a.name).toBe('MatrixApiError');
    expect(b.name).toBe('MatrixApiError');
    expect(c.name).toBe('MatrixApiError');
    expect(a.errcode).toBe(ErrorCodes.M_FORBIDDEN);
    expect(b.errcode).toBe(ErrorCodes.M_NOT_FOUND);
    expect(c.errcode).toBe(ErrorCodes.M_UNKNOWN);
    expect(a.status).toBe(403);
    expect(b.status).toBe(404);
    expect(c.status).toBe(502);
    const [ra, rb, rc] = await Promise.all([
      Promise.resolve(a.toResponse()),
      Promise.resolve(b.toResponse()),
      Promise.resolve(c.toResponse()),
    ]);
    expect(ra.status).toBe(403);
    expect(rb.status).toBe(404);
    expect(rc.status).toBe(502);
    await expect(ra.json()).resolves.toEqual({ errcode: 'M_FORBIDDEN', error: 'x' });
    await expect(rb.json()).resolves.toEqual({ errcode: 'M_NOT_FOUND', error: 'y' });
    await expect(rc.json()).resolves.toEqual({ errcode: 'M_UNKNOWN', error: 'z' });
  });

  it('invalidParam custom ∥ missingParam ∥ conflict custom toJSON under race', async () => {
    const [inv, miss, conf] = await Promise.all([
      Promise.resolve(Errors.invalidParam('room_id', 'must be room id').toJSON()),
      Promise.resolve(Errors.missingParam('access_token').toJSON()),
      Promise.resolve(Errors.conflict('retry').toJSON()),
    ]);
    expect(inv).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'must be room id',
    });
    expect(miss).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: access_token',
    });
    expect(conf).toEqual({
      errcode: 'M_CONFLICT',
      error: 'retry',
    });
  });

  it('jsonResponse primitive bodies ∥ emptyResponse 203 stay independent under race', async () => {
    const [num, str, bool, empty] = await Promise.all([
      Promise.resolve(jsonResponse(0, 200)),
      Promise.resolve(jsonResponse('hi', 201)),
      Promise.resolve(jsonResponse(false, 202)),
      Promise.resolve(emptyResponse(203)),
    ]);
    expect(new Set([num, str, bool, empty]).size).toBe(4);
    expect(num.status).toBe(200);
    expect(str.status).toBe(201);
    expect(bool.status).toBe(202);
    expect(empty.status).toBe(203);
    await expect(num.json()).resolves.toBe(0);
    await expect(str.json()).resolves.toBe('hi');
    await expect(bool.json()).resolves.toBe(false);
    await expect(empty.json()).resolves.toEqual({});
  });
});

describe('errors TOKENMAXX residual septenary leftovers after #336', () => {
  it('unknown/notFound/badJson/notJson/unknownToken default exacts under race', async () => {
    const [unk, nf, bj, nj, ut] = await Promise.all([
      Promise.resolve(Errors.unknown().toResponse()),
      Promise.resolve(Errors.notFound().toResponse()),
      Promise.resolve(Errors.badJson().toResponse()),
      Promise.resolve(Errors.notJson().toResponse()),
      Promise.resolve(Errors.unknownToken().toResponse()),
    ]);
    expect(new Set([unk, nf, bj, nj, ut]).size).toBe(5);
    expect(unk.status).toBe(500);
    expect(nf.status).toBe(404);
    expect(bj.status).toBe(400);
    expect(nj.status).toBe(400);
    expect(ut.status).toBe(401);
    await expect(unk.json()).resolves.toEqual({
      errcode: 'M_UNKNOWN',
      error: 'An unknown error occurred',
    });
    await expect(nf.json()).resolves.toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'Not found',
    });
    await expect(bj.json()).resolves.toEqual({
      errcode: 'M_BAD_JSON',
      error: 'Could not parse request body as JSON',
    });
    await expect(nj.json()).resolves.toEqual({
      errcode: 'M_NOT_JSON',
      error: 'Content-Type must be application/json',
    });
    await expect(ut.json()).resolves.toEqual({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'Unknown token',
    });
  });

  it('withErrorHandler races unknown + notFound + badJson + unknownToken customs', async () => {
    const [a, b, c, d] = await Promise.all([
      withErrorHandler(async () => {
        throw Errors.unknown('boom');
      }),
      withErrorHandler(async () => {
        throw Errors.notFound('gone');
      }),
      withErrorHandler(async () => {
        throw Errors.badJson('parse');
      }),
      withErrorHandler(async () => {
        throw Errors.unknownToken('revoked');
      }),
    ]);
    expect((a as Response).status).toBe(500);
    expect((b as Response).status).toBe(404);
    expect((c as Response).status).toBe(400);
    expect((d as Response).status).toBe(401);
    await expect((a as Response).json()).resolves.toEqual({
      errcode: 'M_UNKNOWN',
      error: 'boom',
    });
    await expect((b as Response).json()).resolves.toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'gone',
    });
    await expect((c as Response).json()).resolves.toEqual({
      errcode: 'M_BAD_JSON',
      error: 'parse',
    });
    await expect((d as Response).json()).resolves.toEqual({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'revoked',
    });
  });

  it('toResponse Content-Type ∥ status stay independent under race', async () => {
    const [a, b, c] = await Promise.all([
      Promise.resolve(Errors.forbidden('x').toResponse()),
      Promise.resolve(Errors.notFound('y').toResponse()),
      Promise.resolve(Errors.unknown('z').toResponse()),
    ]);
    expect(a.headers.get('Content-Type')).toBe('application/json');
    expect(b.headers.get('Content-Type')).toBe('application/json');
    expect(c.headers.get('Content-Type')).toBe('application/json');
    expect(a.status).toBe(403);
    expect(b.status).toBe(404);
    expect(c.status).toBe(500);
  });

  it('limitExceeded default omit retry ∥ custom include toJSON under race', async () => {
    const [def, withRetry, zero] = await Promise.all([
      Promise.resolve(Errors.limitExceeded().toJSON()),
      Promise.resolve(Errors.limitExceeded('slow', 1200).toJSON()),
      Promise.resolve(Errors.limitExceeded('zero', 0).toJSON()),
    ]);
    expect(def).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Rate limit exceeded',
    });
    expect(Object.prototype.hasOwnProperty.call(def, 'retry_after_ms')).toBe(false);
    expect(withRetry).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
      retry_after_ms: 1200,
    });
    expect(zero).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'zero',
    });
    expect(Object.prototype.hasOwnProperty.call(zero, 'retry_after_ms')).toBe(false);
  });

  it('jsonResponse default 200 ∥ emptyResponse default 200 stay independent under race', async () => {
    const [j, e, j2, e2] = await Promise.all([
      Promise.resolve(jsonResponse({ ok: true })),
      Promise.resolve(emptyResponse()),
      Promise.resolve(jsonResponse({})),
      Promise.resolve(emptyResponse()),
    ]);
    expect(new Set([j, e, j2, e2]).size).toBe(4);
    expect(j.status).toBe(200);
    expect(e.status).toBe(200);
    expect(j2.status).toBe(200);
    expect(e2.status).toBe(200);
    await expect(j.json()).resolves.toEqual({ ok: true });
    await expect(e.json()).resolves.toEqual({});
    await expect(j2.json()).resolves.toEqual({});
    await expect(e2.json()).resolves.toEqual({});
    expect(j.headers.get('Content-Type')).toBe('application/json');
    expect(e.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('errors TOKENMAXX residual octonary leftovers after #356', () => {
  it('forbidden/missingToken/unauthorized/userDeactivated default exacts under race', async () => {
    const [forb, miss, unauth, deact] = await Promise.all([
      Promise.resolve(Errors.forbidden().toResponse()),
      Promise.resolve(Errors.missingToken().toResponse()),
      Promise.resolve(Errors.unauthorized().toResponse()),
      Promise.resolve(Errors.userDeactivated().toResponse()),
    ]);
    expect(new Set([forb, miss, unauth, deact]).size).toBe(4);
    expect(forb.status).toBe(403);
    expect(miss.status).toBe(401);
    expect(unauth.status).toBe(401);
    expect(deact.status).toBe(403);
    await expect(forb.json()).resolves.toEqual({ errcode: 'M_FORBIDDEN', error: 'Forbidden' });
    await expect(miss.json()).resolves.toEqual({
      errcode: 'M_MISSING_TOKEN',
      error: 'Missing access token',
    });
    await expect(unauth.json()).resolves.toEqual({
      errcode: 'M_UNAUTHORIZED',
      error: 'Unauthorized',
    });
    await expect(deact.json()).resolves.toEqual({
      errcode: 'M_USER_DEACTIVATED',
      error: 'User account has been deactivated',
    });
  });

  it('invalidUsername/userInUse/roomInUse/guestAccessForbidden defaults under race', async () => {
    const [inv, use, room, guest] = await Promise.all([
      Promise.resolve(Errors.invalidUsername().toResponse()),
      Promise.resolve(Errors.userInUse().toResponse()),
      Promise.resolve(Errors.roomInUse().toResponse()),
      Promise.resolve(Errors.guestAccessForbidden().toResponse()),
    ]);
    expect(inv.status).toBe(400);
    expect(use.status).toBe(400);
    expect(room.status).toBe(400);
    expect(guest.status).toBe(403);
    await expect(inv.json()).resolves.toEqual({
      errcode: 'M_INVALID_USERNAME',
      error: 'Invalid username',
    });
    await expect(use.json()).resolves.toEqual({
      errcode: 'M_USER_IN_USE',
      error: 'User ID already taken',
    });
    await expect(room.json()).resolves.toEqual({
      errcode: 'M_ROOM_IN_USE',
      error: 'Room alias already taken',
    });
    await expect(guest.json()).resolves.toEqual({
      errcode: 'M_GUEST_ACCESS_FORBIDDEN',
      error: 'Guest access forbidden',
    });
  });

  it('withErrorHandler success pass-through ∥ forbidden ∥ missingToken customs', async () => {
    const [ok, forb, miss] = await Promise.all([
      withErrorHandler(async () => ({ ok: true })),
      withErrorHandler(async () => {
        throw Errors.forbidden('nope');
      }),
      withErrorHandler(async () => {
        throw Errors.missingToken('gone');
      }),
    ]);
    expect(ok).toEqual({ ok: true });
    expect((forb as Response).status).toBe(403);
    expect((miss as Response).status).toBe(401);
    await expect((forb as Response).json()).resolves.toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'nope',
    });
    await expect((miss as Response).json()).resolves.toEqual({
      errcode: 'M_MISSING_TOKEN',
      error: 'gone',
    });
  });

  it('invalidRoomState/unsupportedRoomVersion customs ∥ toJSON under race', async () => {
    const [irs, urv, irsDef, urvDef] = await Promise.all([
      Promise.resolve(Errors.invalidRoomState('bad-state').toJSON()),
      Promise.resolve(Errors.unsupportedRoomVersion('99').toJSON()),
      Promise.resolve(Errors.invalidRoomState().toJSON()),
      Promise.resolve(Errors.unsupportedRoomVersion().toJSON()),
    ]);
    expect(irs).toEqual({ errcode: 'M_INVALID_ROOM_STATE', error: 'bad-state' });
    expect(urv).toEqual({ errcode: 'M_UNSUPPORTED_ROOM_VERSION', error: '99' });
    expect(irsDef).toEqual({
      errcode: 'M_INVALID_ROOM_STATE',
      error: 'Invalid room state',
    });
    expect(urvDef).toEqual({
      errcode: 'M_UNSUPPORTED_ROOM_VERSION',
      error: 'Unsupported room version',
    });
  });

  it('jsonResponse nested ∥ emptyResponse 203 ∥ jsonResponse null under race', async () => {
    const [nested, empty, nul] = await Promise.all([
      Promise.resolve(jsonResponse({ a: { b: [1, null] } }, 201)),
      Promise.resolve(emptyResponse(203)),
      Promise.resolve(jsonResponse(null, 200)),
    ]);
    expect(new Set([nested, empty, nul]).size).toBe(3);
    expect(nested.status).toBe(201);
    expect(empty.status).toBe(203);
    expect(nul.status).toBe(200);
    await expect(nested.json()).resolves.toEqual({ a: { b: [1, null] } });
    await expect(empty.json()).resolves.toEqual({});
    await expect(nul.json()).resolves.toBeNull();
  });
});

describe('errors TOKENMAXX residual nonary leftovers after #372', () => {
  it('unknownToken/badJson/notJson/notFound default exacts under race', async () => {
    const [tok, bad, notJ, nf] = await Promise.all([
      Promise.resolve(Errors.unknownToken().toResponse()),
      Promise.resolve(Errors.badJson().toResponse()),
      Promise.resolve(Errors.notJson().toResponse()),
      Promise.resolve(Errors.notFound().toResponse()),
    ]);
    expect(new Set([tok, bad, notJ, nf]).size).toBe(4);
    expect(tok.status).toBe(401);
    expect(bad.status).toBe(400);
    expect(notJ.status).toBe(400);
    expect(nf.status).toBe(404);
    await expect(tok.json()).resolves.toEqual({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'Unknown token',
    });
    await expect(bad.json()).resolves.toEqual({
      errcode: 'M_BAD_JSON',
      error: 'Could not parse request body as JSON',
    });
    await expect(notJ.json()).resolves.toEqual({
      errcode: 'M_NOT_JSON',
      error: 'Content-Type must be application/json',
    });
    await expect(nf.json()).resolves.toEqual({ errcode: 'M_NOT_FOUND', error: 'Not found' });
  });

  it('tooLarge/conflict/unrecognized/unknown default exacts under race', async () => {
    const [large, conf, unrec, unk] = await Promise.all([
      Promise.resolve(Errors.tooLarge().toResponse()),
      Promise.resolve(Errors.conflict().toResponse()),
      Promise.resolve(Errors.unrecognized().toResponse()),
      Promise.resolve(Errors.unknown().toResponse()),
    ]);
    expect(large.status).toBe(413);
    expect(conf.status).toBe(409);
    expect(unrec.status).toBe(400);
    expect(unk.status).toBe(500);
    await expect(large.json()).resolves.toEqual({
      errcode: 'M_TOO_LARGE',
      error: 'Request too large',
    });
    await expect(conf.json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'State changed concurrently; retry the operation',
    });
    await expect(unrec.json()).resolves.toEqual({
      errcode: 'M_UNRECOGNIZED',
      error: 'Unrecognized request',
    });
    await expect(unk.json()).resolves.toEqual({
      errcode: 'M_UNKNOWN',
      error: 'An unknown error occurred',
    });
  });

  it('withErrorHandler success ∥ tooLarge ∥ conflict customs under race', async () => {
    const [ok, large, conf] = await Promise.all([
      withErrorHandler(async () => ({ ok: true, n: 1 })),
      withErrorHandler(async () => {
        throw Errors.tooLarge('payload');
      }),
      withErrorHandler(async () => {
        throw Errors.conflict('retry-me');
      }),
    ]);
    expect(ok).toEqual({ ok: true, n: 1 });
    expect((large as Response).status).toBe(413);
    expect((conf as Response).status).toBe(409);
    await expect((large as Response).json()).resolves.toEqual({
      errcode: 'M_TOO_LARGE',
      error: 'payload',
    });
    await expect((conf as Response).json()).resolves.toEqual({
      errcode: 'M_CONFLICT',
      error: 'retry-me',
    });
  });

  it('missingParam/invalidParam/limitExceeded toJSON under race', async () => {
    const [miss, inv, lim, limRetry] = await Promise.all([
      Promise.resolve(Errors.missingParam('user_id').toJSON()),
      Promise.resolve(Errors.invalidParam('limit', 'must be positive').toJSON()),
      Promise.resolve(Errors.limitExceeded().toJSON()),
      Promise.resolve(Errors.limitExceeded('slow', 1500).toJSON()),
    ]);
    expect(miss).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: user_id',
    });
    expect(inv).toEqual({ errcode: 'M_INVALID_PARAM', error: 'must be positive' });
    expect(lim).toEqual({ errcode: 'M_LIMIT_EXCEEDED', error: 'Rate limit exceeded' });
    expect(limRetry).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'slow',
      retry_after_ms: 1500,
    });
  });

  it('jsonResponse array ∥ emptyResponse 204 ∥ jsonResponse false under race', async () => {
    const [arr, empty, falsy] = await Promise.all([
      Promise.resolve(jsonResponse([1, null, false], 202)),
      Promise.resolve(emptyResponse(204)),
      Promise.resolve(jsonResponse(false, 200)),
    ]);
    expect(new Set([arr, empty, falsy]).size).toBe(3);
    expect(arr.status).toBe(202);
    expect(empty.status).toBe(204);
    expect(falsy.status).toBe(200);
    await expect(arr.json()).resolves.toEqual([1, null, false]);
    await expect(empty.json()).resolves.toEqual({});
    await expect(falsy.json()).resolves.toBe(false);
  });
});
