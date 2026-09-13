import { describe, it, expect } from 'vitest';
import { validateUrl, validateUrlForPreview } from '../src/utils/url-validator';

describe('validateUrl SSRF protection', () => {
  it('allows public http(s) URLs', () => {
    expect(validateUrl('https://example.com/path').valid).toBe(true);
    expect(validateUrl('http://matrix.org').valid).toBe(true);
  });

  it('rejects non-http protocols', () => {
    expect(validateUrl('ftp://example.com').valid).toBe(false);
    expect(validateUrl('file:///etc/passwd').valid).toBe(false);
  });

  it('rejects localhost and internal hostnames', () => {
    expect(validateUrl('http://localhost/admin').valid).toBe(false);
    expect(validateUrl('http://metadata.google.internal/').valid).toBe(false);
    expect(validateUrl('http://svc.local/').valid).toBe(false);
    expect(validateUrl('http://db.internal/').valid).toBe(false);
  });

  it('rejects private and link-local IPv4 ranges', () => {
    expect(validateUrl('http://127.0.0.1/').valid).toBe(false);
    expect(validateUrl('http://10.0.0.5/').valid).toBe(false);
    expect(validateUrl('http://192.168.1.1/').valid).toBe(false);
    expect(validateUrl('http://172.16.0.1/').valid).toBe(false);
    expect(validateUrl('http://169.254.169.254/latest').valid).toBe(false);
  });

  it('rejects blocked IPv6 addresses', () => {
    expect(validateUrl('http://[::1]/').valid).toBe(false);
    expect(validateUrl('http://[fc00::1]/').valid).toBe(false);
    expect(validateUrl('http://[fe80::1]/').valid).toBe(false);
    // WHATWG URL normalizes dotted ::ffff:127.0.0.1 → ::ffff:7f00:1
    expect(validateUrl('http://[::ffff:127.0.0.1]/').valid).toBe(false);
    expect(validateUrl('http://[::ffff:7f00:1]/').valid).toBe(false);
  });

  it('rejects common internal service ports', () => {
    expect(validateUrl('https://example.com:22').valid).toBe(false);
    expect(validateUrl('https://example.com:3306').valid).toBe(false);
    expect(validateUrl('https://example.com:6379').valid).toBe(false);
  });

  it('rejects invalid URL strings', () => {
    expect(validateUrl('not a url').valid).toBe(false);
  });

  it('returns a sanitized URL on success', () => {
    const result = validateUrl('https://example.com/a');
    expect(result.valid).toBe(true);
    expect(result.sanitizedUrl).toBe('https://example.com/a');
  });
});

describe('validateUrlForPreview', () => {
  it('allows standard preview ports', () => {
    expect(validateUrlForPreview('https://example.com').valid).toBe(true);
    expect(validateUrlForPreview('http://example.com:8080').valid).toBe(true);
    expect(validateUrlForPreview('https://example.com:8443').valid).toBe(true);
  });

  it('rejects unusual ports even when SSRF-safe', () => {
    expect(validateUrlForPreview('https://example.com:9000').valid).toBe(false);
  });

  it('still rejects SSRF targets', () => {
    expect(validateUrlForPreview('http://127.0.0.1').valid).toBe(false);
  });
});
