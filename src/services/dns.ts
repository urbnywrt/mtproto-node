import { Resolver } from 'dns/promises';

/**
 * DNS lookups that work on hosts where outbound UDP/53 is blocked.
 *
 * Nodes in this fleet sit behind networks that drop direct queries to public resolvers:
 * a container reaches names only through Docker's embedded DNS, which forwards from the
 * host. Anything querying 1.1.1.1 itself times out. Both paths are therefore tried in
 * parallel — DNS-over-HTTPS on 443, which the node already needs for the Cloudflare API,
 * and the classic resolver for hosts where it does work.
 */

const DOH_ENDPOINTS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

const RECORD_TYPE = { A: 1, TXT: 16 } as const;

async function queryOverHttps(name: string, type: keyof typeof RECORD_TYPE): Promise<string[]> {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      const response = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;

      const body = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
      const values = (body.Answer || [])
        .filter((a) => a.type === RECORD_TYPE[type])
        // TXT values arrive quoted, and long ones as several quoted chunks.
        .map((a) => (type === 'TXT' ? a.data.replace(/"\s+"/g, '').replace(/^"|"$/g, '') : a.data));
      if (values.length > 0) return values;
    } catch {
      // Try the next endpoint.
    }
  }
  return [];
}

async function queryOverUdp(name: string, type: keyof typeof RECORD_TYPE): Promise<string[]> {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  try {
    if (type === 'A') return await resolver.resolve4(name);
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

async function lookup(name: string, type: keyof typeof RECORD_TYPE): Promise<string[]> {
  const [doh, udp] = await Promise.all([queryOverHttps(name, type), queryOverUdp(name, type)]);
  return [...new Set([...doh, ...udp])];
}

/** A records for `name`. Empty when the name does not resolve or no path works. */
export function lookupA(name: string): Promise<string[]> {
  return lookup(name, 'A');
}

/** TXT values at `name`. Empty when the name does not resolve or no path works. */
export function lookupTxt(name: string): Promise<string[]> {
  return lookup(name, 'TXT');
}
