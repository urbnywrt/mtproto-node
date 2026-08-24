const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

/** Raised when the request never reached Cloudflare, as opposed to being refused by it. */
export class CloudflareUnreachableError extends Error {}

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${CF_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string>),
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err: any) {
    // fetch throws the same opaque "fetch failed" for a blocked port, a refused
    // connection and a name that does not resolve. Reporting that as a rejected token
    // sends the operator hunting for a problem that is not there.
    const cause = err?.cause?.code || err?.cause?.message || err?.name || '';
    throw new CloudflareUnreachableError(
      `не удалось связаться с api.cloudflare.com${cause ? ` (${cause})` : ''}. ` +
        'Проверьте, что с ноды работает разрешение имён и исходящий HTTPS.'
    );
  }

  const body = (await response.json()) as CfResponse<T>;
  if (!response.ok || !body.success) {
    const detail = body.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API ${path} failed — ${detail}`);
  }
  return body.result;
}

/** Verifies the token is live and usable. Used by preflight before creating a proxy. */
export async function verifyToken(token: string): Promise<void> {
  await cf<{ status: string }>(token, '/user/tokens/verify');
}

/**
 * Resolve which zone hosts a domain by trying progressively shorter suffixes:
 * `a.b.example.com` -> `a.b.example.com`, `b.example.com`, `example.com`.
 * A delegated subdomain zone therefore wins over its parent, which is what we want.
 */
export async function findZoneId(token: string, domain: string): Promise<string> {
  const labels = domain.split('.');

  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const zones = await cf<Array<{ id: string; name: string }>>(
      token,
      `/zones?name=${encodeURIComponent(candidate)}`
    );
    if (zones.length > 0) return zones[0].id;
  }

  throw new Error(
    `Не найдена зона Cloudflare для домена ${domain}. ` +
      'Проверьте, что домен добавлен в аккаунт и токен имеет доступ к его зоне.'
  );
}

/** Ids of every TXT record currently sitting at `name`. */
export async function listTxtRecords(token: string, zoneId: string, name: string): Promise<string[]> {
  const records = await cf<Array<{ id: string }>>(
    token,
    `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`
  );
  return records.map((r) => r.id);
}

export async function createTxtRecord(
  token: string,
  zoneId: string,
  name: string,
  content: string
): Promise<string> {
  const record = await cf<{ id: string }>(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'TXT', name, content, ttl: 60 }),
  });
  return record.id;
}

export async function deleteRecord(token: string, zoneId: string, recordId: string): Promise<void> {
  await cf<unknown>(token, `/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
}

/**
 * Cloudflare edge ranges, used to detect an A record served through the orange cloud.
 * A proxied record terminates TLS at Cloudflare, which breaks the WEB carrier outright,
 * so preflight must reject it rather than let the operator debug a dead link later.
 */
const CF_PROXY_V4_RANGES: Array<[string, number]> = [
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
  ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
  ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function isCloudflareProxiedIp(ip: string): boolean {
  const address = ipv4ToInt(ip);
  if (address === null) return false;

  return CF_PROXY_V4_RANGES.some(([network, bits]) => {
    const base = ipv4ToInt(network);
    if (base === null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (address & mask) === (base & mask);
  });
}
