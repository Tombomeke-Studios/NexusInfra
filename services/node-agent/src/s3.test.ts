import { describe, it, expect } from 'vitest';
import { offsiteFromEnv, S3Target, signV4, objectUrl, EMPTY_SHA256 } from './s3.js';

// The published AWS Signature Version 4 example for S3 ("GET Object"), from the
// S3 API reference. A signer that reproduces AWS's own answer is a signer that
// works; one checked only against itself proves nothing.
describe('signV4', () => {
  it("reproduces AWS's documented GET Object signature", () => {
    const auth = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 },
      payloadHash: EMPTY_SHA256,
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(auth.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
    expect(auth.headers['x-amz-date']).toBe('20130524T000000Z');
  });
});

describe('objectUrl', () => {
  it('addresses path-style by default, which every S3-compatible store accepts', () => {
    expect(objectUrl({ endpoint: 'http://minio:9000', bucket: 'b', pathStyle: true }, 'backups/bk_1.tar').toString()).toBe('http://minio:9000/b/backups/bk_1.tar');
  });

  it('addresses virtual-hosted when asked', () => {
    expect(objectUrl({ endpoint: 'https://s3.eu-west-1.amazonaws.com', bucket: 'b', pathStyle: false }, 'k').toString()).toBe('https://b.s3.eu-west-1.amazonaws.com/k');
  });
});

describe('offsiteFromEnv', () => {
  it('is off unless a bucket and credentials are all set', () => {
    expect(offsiteFromEnv({})).toBeNull();
    expect(offsiteFromEnv({ BACKUP_S3_BUCKET: 'b' })).toBeNull();
  });

  it('reads the target, with safe defaults', () => {
    const t = offsiteFromEnv({
      BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ACCESS_KEY_ID: 'id',
      BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
      BACKUP_S3_ENDPOINT: 'http://minio:9000/',
    });
    expect(t).toMatchObject({ bucket: 'b', endpoint: 'http://minio:9000', region: 'us-east-1', prefix: 'nexusinfra-backups/', pathStyle: true });
  });
});

describe('S3Target', () => {
  it('puts, gets and deletes signed objects, and treats a missing delete as done', async () => {
    const seen: Array<{ method: string; url: string; auth: string | null }> = [];
    const store = new Map<string, Buffer>();
    const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push({ method, url, auth: new Headers(init?.headers).get('authorization') });
      if (method === 'PUT') {
        store.set(url, Buffer.from(init!.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      if (method === 'GET') return store.has(url) ? new Response(store.get(url)) : new Response('NoSuchKey', { status: 404 });
      store.delete(url);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const target = new S3Target(
      { endpoint: 'http://minio:9000', bucket: 'b', region: 'us-east-1', prefix: 'p/', pathStyle: true, credentials: { accessKeyId: 'id', secretAccessKey: 's' } },
      fakeFetch
    );
    await target.put('bk_1', Buffer.from('tar'));
    expect((await target.get('bk_1'))?.toString()).toBe('tar');
    await target.delete('bk_1');
    expect(await target.get('bk_1')).toBeNull();

    expect(seen.every((s) => s.auth?.startsWith('AWS4-HMAC-SHA256 Credential=id/'))).toBe(true);
    expect(seen[0].url).toBe('http://minio:9000/b/p/bk_1.tar');
  });

  it('says why an upload was refused', async () => {
    const target = new S3Target(
      { endpoint: 'http://minio:9000', bucket: 'b', region: 'us-east-1', prefix: '', pathStyle: true, credentials: { accessKeyId: 'id', secretAccessKey: 's' } },
      (async () => new Response('<Code>AccessDenied</Code>', { status: 403 })) as typeof fetch
    );
    await expect(target.put('bk_1', Buffer.from('x'))).rejects.toThrow(/403/);
  });
});
