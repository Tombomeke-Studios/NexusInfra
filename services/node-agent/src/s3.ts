import { createHash, createHmac } from 'crypto';

// Off-site backups (#232): an S3-compatible bucket — AWS, MinIO, Backblaze B2,
// Wasabi, Cloudflare R2 — that a node copies each backup to.
//
// Backups kept only on the node do not protect against the failure backups
// exist for, which is losing that node. Hand-rolled rather than the AWS SDK:
// three operations need one signing function (~50 lines, checked against AWS's
// own published example), and the SDK is tens of megabytes in an image people
// pull onto every host they run.

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface OffsiteConfig {
  endpoint: string;
  bucket: string;
  region: string;
  /** Key prefix inside the bucket, so one bucket can serve several installations. */
  prefix: string;
  /** `endpoint/bucket/key` rather than `bucket.endpoint/key` — what MinIO and most self-hosted stores want. */
  pathStyle: boolean;
  credentials: S3Credentials;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: only unreserved characters stay literal. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 for one request. `headers` are the extra headers to
 * sign (lower-case names); `host` and `x-amz-date` are added here.
 */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  credentials: S3Credentials;
  region: string;
  now?: Date;
  service?: string;
}): { authorization: string; headers: Record<string, string> } {
  const service = input.service ?? 's3';
  const amzDate = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = { ...input.headers, host: input.url.host, 'x-amz-date': amzDate };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');

  // Each path segment encoded once; S3 does not normalise the path.
  const canonicalUri = input.url.pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, input.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    headers,
  };
}

export function objectUrl(target: Pick<OffsiteConfig, 'endpoint' | 'bucket' | 'pathStyle'>, key: string): URL {
  const base = new URL(target.endpoint);
  const path = key.split('/').map(encode).join('/');
  if (target.pathStyle) return new URL(`${base.origin}/${encode(target.bucket)}/${path}`);
  return new URL(`${base.protocol}//${target.bucket}.${base.host}/${path}`);
}

/** The node's off-site target, or null when it has none — off-site is optional. */
export function offsiteFromEnv(env: Record<string, string | undefined> = process.env): OffsiteConfig | null {
  const bucket = env.BACKUP_S3_BUCKET?.trim();
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const region = env.BACKUP_S3_REGION?.trim() || 'us-east-1';
  const endpoint = (env.BACKUP_S3_ENDPOINT?.trim() || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
  const rawPrefix = env.BACKUP_S3_PREFIX ?? 'nexusinfra-backups/';
  const prefix = rawPrefix && !rawPrefix.endsWith('/') ? `${rawPrefix}/` : rawPrefix;
  return { endpoint, bucket, region, prefix, pathStyle: env.BACKUP_S3_PATH_STYLE !== 'false', credentials: { accessKeyId, secretAccessKey } };
}

/** Put / get / delete one backup tar in the off-site bucket. */
export class S3Target {
  constructor(
    private readonly config: OffsiteConfig,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private key(ref: string): string {
    return `${this.config.prefix}${ref}.tar`;
  }

  private async send(method: string, ref: string, body?: Buffer): Promise<Response> {
    const url = objectUrl(this.config, this.key(ref));
    const payloadHash = body ? sha256(body) : EMPTY_SHA256;
    const signed = signV4({
      method,
      url,
      headers: { 'x-amz-content-sha256': payloadHash, ...(body ? { 'content-length': String(body.length) } : {}) },
      payloadHash,
      credentials: this.config.credentials,
      region: this.config.region,
    });
    const { host: _host, ...headers } = signed.headers;
    void _host;
    return this.doFetch(url.toString(), {
      method,
      headers: { ...headers, authorization: signed.authorization },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  private static async failure(what: string, r: Response): Promise<Error> {
    const text = await r.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    return new Error(`off-site ${what} failed (${r.status}${code ? ` ${code}` : ''})`);
  }

  async put(ref: string, tar: Buffer): Promise<void> {
    const r = await this.send('PUT', ref, tar);
    if (!r.ok) throw await S3Target.failure('upload', r);
  }

  /** The stored tar, or null when the bucket has no such backup. */
  async get(ref: string): Promise<Buffer | null> {
    const r = await this.send('GET', ref);
    if (r.status === 404) return null;
    if (!r.ok) throw await S3Target.failure('download', r);
    return Buffer.from(await r.arrayBuffer());
  }

  async delete(ref: string): Promise<void> {
    const r = await this.send('DELETE', ref);
    // Deleting something already gone is the outcome that was asked for.
    if (!r.ok && r.status !== 404) throw await S3Target.failure('delete', r);
  }
}
