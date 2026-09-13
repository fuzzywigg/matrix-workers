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

  it('rejects additional internal / metadata hostnames', () => {
    expect(validateUrl('http://metadata.google.internal/computeMetadata/v1').valid).toBe(false);
    expect(validateUrl('http://foo.internal/').valid).toBe(false);
    expect(validateUrl('http://metadata/').valid).toBe(false);
  });

  it('allows public hosts even when userinfo is present', () => {
    const result = validateUrl('https://user:pass@example.com/path');
    expect(result.valid).toBe(true);
    expect(result.sanitizedUrl).toContain('example.com');
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

  it('allows http/https default ports and rejects ftp even for preview', () => {
    expect(validateUrlForPreview('http://example.com:80').valid).toBe(true);
    expect(validateUrlForPreview('https://example.com:443').valid).toBe(true);
    expect(validateUrlForPreview('ftp://example.com').valid).toBe(false);
  });
});

describe('validateUrl additional ranges', () => {
  it('rejects 0.0.0.0 and broadcast', () => {
    expect(validateUrl('http://0.0.0.0/').valid).toBe(false);
    expect(validateUrl('http://255.255.255.255/').valid).toBe(false);
  });

  it('rejects documentation IPv6 and multicast', () => {
    expect(validateUrl('http://[2001:db8::1]/').valid).toBe(false);
    expect(validateUrl('http://[ff02::1]/').valid).toBe(false);
  });

  it('allows public 172.32.x (outside RFC1918 172.16/12)', () => {
    expect(validateUrl('http://172.32.0.1/').valid).toBe(true);
  });

  it('rejects kubernetes.default and localhost.localdomain', () => {
    expect(validateUrl('http://kubernetes.default/').valid).toBe(false);
    expect(validateUrl('http://localhost.localdomain/').valid).toBe(false);
  });

  it('rejects blocked ports used by redis/mysql/ssh', () => {
    expect(validateUrl('https://example.com:22').error).toMatch(/port/i);
    expect(validateUrl('https://example.com:3306').valid).toBe(false);
    expect(validateUrl('https://example.com:6379').valid).toBe(false);
  });

  it('rejects mail, DNS, SMB, RDP, and DB service ports', () => {
    for (const port of [25, 53, 445, 1433, 1521, 3389, 9200, 27017]) {
      expect(validateUrl(`https://example.com:${port}`).valid).toBe(false);
    }
  });

  it('rejects unspecified and site-local IPv6', () => {
    expect(validateUrl('http://[::]/').valid).toBe(false);
    expect(validateUrl('http://[fec0::1]/').valid).toBe(false);
    expect(validateUrl('http://[fed0::1]/').valid).toBe(false);
  });

  it('rejects non-http schemes used in SSRF gadgets', () => {
    expect(validateUrl('javascript:alert(1)').valid).toBe(false);
    expect(validateUrl('data:text/html,hi').valid).toBe(false);
    expect(validateUrl('gopher://example.com/1').valid).toBe(false);
  });

  it('allows public IPv4-mapped addresses that are not private', () => {
    // ::ffff:8.8.8.8 → ::ffff:808:808
    expect(validateUrl('http://[::ffff:8.8.8.8]/').valid).toBe(true);
  });
});

describe('validateUrlForPreview port edges', () => {
  it('rejects federation-default 8448 even though SSRF allow-list would pass', () => {
    expect(validateUrl('https://example.com:8448').valid).toBe(true);
    expect(validateUrlForPreview('https://example.com:8448').valid).toBe(false);
  });

  it('rejects preview targets with blocked hostnames before port checks', () => {
    expect(validateUrlForPreview('http://localhost:8080').valid).toBe(false);
    expect(validateUrlForPreview('http://metadata:443').valid).toBe(false);
  });
});
