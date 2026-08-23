import Docker from 'dockerode';
import { config, NGINX_WEB_L7_PORT, TELEMT_WEB_PORT } from '../config';
import { ProxyConfig, ConnectedIpInfo } from '../types';
import { pullImage } from './docker';
import { createTar } from '../utils/tar';
import * as acme from './acme';
import * as store from '../store';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Resolve container IP in the mtproto-net bridge network
async function resolveContainerIp(containerName: string): Promise<string> {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  const networks = info.NetworkSettings.Networks;
  if (networks[config.dockerNetwork]?.IPAddress) {
    return networks[config.dockerNetwork].IPAddress;
  }
  const first = Object.values(networks).find((n) => n?.IPAddress);
  if (first?.IPAddress) return first.IPAddress;
  throw new Error(`Cannot resolve IP for container ${containerName}`);
}

export interface NginxRenderOptions {
  /**
   * WEB domains that actually have a certificate on disk. A vhost referencing a missing
   * ssl_certificate makes nginx reject the whole config, which would take the fake TLS
   * proxies down with it — so a WEB proxy is simply not served until its cert exists.
   */
  certifiedDomains?: Set<string>;
  /**
   * nginx >= 1.25.1 wants `http2 on;`; older builds only understand the `http2`
   * parameter on `listen`. Emitting the wrong one is a fatal config error, and
   * pullImage keeps whatever nginx:latest was cached when the node was first set up.
   */
  http2Directive?: boolean;
}

export function generateNginxConfig(
  proxies: ProxyConfig[],
  ipMap: Map<string, string> = new Map(),
  opts: NginxRenderOptions = {}
): string {
  const runningProxies = proxies.filter((p) => p.status === 'running');
  const certified = opts.certifiedDomains ?? new Set<string>();
  const http2Directive = opts.http2Directive ?? true;

  // WEB proxies are terminated at L7 and never appear as fake TLS stream backends.
  const webProxies = runningProxies.filter((p) => p.type === 'web' && certified.has(p.domain));
  const streamProxies = runningProxies.filter((p) => p.type !== 'web');

  // Split into SNI-based (nginxPort) vs dedicated-port proxies
  const nginxPort = config.nginxPort;
  const sniProxies = streamProxies.filter((p) => !p.listenPort || p.listenPort === nginxPort);
  const portProxies = streamProxies.filter((p) => p.listenPort && p.listenPort !== nginxPort);

  // Helper: get target address for a proxy container
  const target = (p: ProxyConfig, port: number) => {
    const ip = ipMap.get(p.containerName);
    return ip ? `${ip}:${port}` : `${p.containerName}:${port}`;
  };

  // For SNI proxies with connection limits, assign internal loopback ports (10001+)
  const limitSniProxies = sniProxies.filter((p) => p.maxConnections && p.maxConnections > 0);
  const limitPortMap = new Map<string, number>();
  limitSniProxies.forEach((p, i) => {
    limitPortMap.set(p.domain, 10001 + i);
  });

  // SNI map entries (nginxPort)
  const mapEntries = sniProxies
    .map((p) => {
      const internalPort = limitPortMap.get(p.domain);
      if (internalPort) {
        return `        ${p.domain} 127.0.0.1:${internalPort};`;
      }
      return `        ${p.domain} ${target(p, nginxPort)};`;
    })
    .join('\n');

  // Mode 1 routes WEB domains out of the shared stream listener by SNI into a loopback
  // L7 vhost. Mode 2 binds its own public IP and never touches the stream block.
  const webViaStream = !config.webBindIp;
  const webMapEntries = webViaStream
    ? webProxies.map((p) => `        ${p.domain} 127.0.0.1:${NGINX_WEB_L7_PORT};`).join('\n')
    : '';
  const allMapEntries = [mapEntries, webMapEntries].filter(Boolean).join('\n');

  const webListen = config.webBindIp
    ? `${config.webBindIp}:443`
    : `127.0.0.1:${NGINX_WEB_L7_PORT}`;

  const webServerBlocks = webProxies
    .map((p, i) => {
      // With the legacy syntax the http2 flag is a property of the listen socket, so
      // repeating it on every server sharing that address is a duplicate-option error.
      const legacyHttp2 = !http2Directive && i === 0 ? ' http2' : '';
      return `    server {
        listen ${webListen} ssl${legacyHttp2};
${http2Directive ? '        http2 on;\n' : ''}        server_name ${p.domain};

        # Bridge capabilities ride in the query string and bootstrap/session bearers in
        # Authorization; telemt's deployment invariants forbid logging either.
        access_log off;

        ssl_certificate     /etc/nginx/certs/${p.domain}/fullchain.pem;
        ssl_certificate_key /etc/nginx/certs/${p.domain}/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;

        # Must be >= web.limits.max_body_bytes (2 MiB).
        client_max_body_size 2m;

        # The entire vhost goes to telemt. Splitting carrier paths from the decoy site
        # here would make authenticated and ordinary traffic observably different, which
        # is precisely what an active probe measures.
        location / {
            proxy_pass http://${target(p, TELEMT_WEB_PORT)};
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header Connection "";

            proxy_connect_timeout 5s;
            # Both must exceed web.timeouts.long_poll_secs (25s) or long polls are cut.
            proxy_send_timeout 35s;
            proxy_read_timeout 35s;
            proxy_request_buffering off;
            proxy_buffering off;
            # The bridge retries through its own sequence protocol; upstream retries
            # would replay a batch telemt has already committed.
            proxy_next_upstream off;
        }
    }`;
    })
    .join('\n\n');

  const webHttpSection = webServerBlocks ? `\n${webServerBlocks}\n` : '';

  // Default backend: HTML fallback
  const defaultBackend = '127.0.0.1:8088';

  // Blacklisted IPs
  const blacklistedIps = store.getBlacklistedIps();
  const denyEntries = blacklistedIps.map((ip) => `        deny ${ip};`).join('\n');

  // Main SNI server block on nginxPort
  const mainServer = `    server {
        listen ${nginxPort};
        proxy_pass $backend;
        ssl_preread on;
        proxy_connect_timeout 10s;
        proxy_timeout 300s;
${denyEntries ? denyEntries + '\n' : ''}    }`;

  // Per-domain limit server blocks (loopback, for SNI proxies with limits)
  const limitBlocks = limitSniProxies
    .map((p) => {
      const zoneName = p.domain.replace(/\./g, '_');
      const internalPort = limitPortMap.get(p.domain)!;
      return `    limit_conn_zone $remote_addr zone=${zoneName}:1m;
    server {
        listen 127.0.0.1:${internalPort};
        proxy_pass ${target(p, nginxPort)};
        proxy_connect_timeout 10s;
        proxy_timeout 300s;
        limit_conn ${zoneName} ${p.maxConnections};
    }`;
    })
    .join('\n\n');

  // Group port proxies by listenPort to avoid duplicate server blocks on the same port
  const portGroups = new Map<number, ProxyConfig>();
  for (const p of portProxies) {
    if (!portGroups.has(p.listenPort!)) {
      portGroups.set(p.listenPort!, p);
    }
  }

  // Dedicated port server blocks — one per unique port
  const portBlocks = Array.from(portGroups.values())
    .map((p) => {
      if (p.maxConnections && p.maxConnections > 0) {
        return `
    limit_conn_zone $remote_addr zone=port_${p.listenPort}:1m;
    server {
        listen ${p.listenPort};
        proxy_pass ${target(p, p.listenPort!)};
        ssl_preread on;
        proxy_connect_timeout 10s;
        proxy_timeout 300s;
${denyEntries ? denyEntries + '\n' : ''}        limit_conn port_${p.listenPort} ${p.maxConnections};
    }`;
      }
      return `
    server {
        listen ${p.listenPort};
        proxy_pass ${target(p, p.listenPort!)};
        ssl_preread on;
        proxy_connect_timeout 10s;
        proxy_timeout 300s;
${denyEntries ? denyEntries + '\n' : ''}    }`;
    })
    .join('\n');

  // HTML fallback page served when no SNI/port match
  const fallbackHtml = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Welcome</title></head>'
    + '<body style="font-family:sans-serif;text-align:center;padding:60px">'
    + '<h1>Welcome</h1><p>This server is operating normally.</p>'
    + '</body></html>';

  // When using host network we resolve IPs directly — no need for Docker DNS resolver
  const useResolver = ipMap.size === 0;

  return `user nginx;
worker_processes auto;

error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 4096;
}

http {
    server {
        listen 127.0.0.1:8088;
        server_name _;
        location / {
            default_type "text/html";
            return 200 '${fallbackHtml}';
        }
    }
${webHttpSection}}

stream {
${useResolver ? '    resolver 127.0.0.11 valid=10s;\n' : ''}    log_format proxy '$remote_addr [$time_local] $ssl_preread_server_name $status';
    access_log /dev/stdout proxy;

    map $ssl_preread_server_name $backend {
${allMapEntries}
        default ${defaultBackend};
    }

${mainServer}

${limitBlocks ? limitBlocks + '\n' : ''}${portBlocks ? portBlocks + '\n' : ''}}
`;
}

// Nginx runs with host networking — no port bindings needed.
// Adding new listen ports only requires a config reload, not container recreation.
export async function ensureNginxContainer(): Promise<void> {
  const containerName = config.nginxContainerName;

  try {
    const existing = docker.getContainer(containerName);
    const info = await existing.inspect();

    // Check if container uses host network (migrated)
    const isHostNetwork = info.HostConfig?.NetworkMode === 'host';

    if (isHostNetwork && info.State.Running) {
      return; // Already running with host network — nothing to do
    }

    if (isHostNetwork && !info.State.Running) {
      await existing.start();
      return;
    }

    // Old container with bridge network — remove and recreate with host network
    console.log('Migrating nginx container to host network mode...');
    await existing.stop().catch(() => {});
    await existing.remove({ force: true });
    // Wait for docker-proxy to release port bindings
    await new Promise((r) => setTimeout(r, 3000));
  } catch {
    // Container doesn't exist — will create below
  }

  await pullImage('nginx:latest');

  const container = await docker.createContainer({
    Image: 'nginx:latest',
    name: containerName,
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      Ulimits: [{ Name: 'nofile', Soft: 65536, Hard: 65536 }],
    },
  });

  // Inject minimal config BEFORE starting
  const initialConf = generateNginxConfig([]);
  const tar = createTarBuffer('nginx.conf', initialConf);
  await container.putArchive(tar, { path: '/etc/nginx' });

  // Retry start in case ports are still being released
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await container.start();
      console.log('nginx container created with host network');
      return;
    } catch (err: any) {
      if (attempt < 3 && err?.statusCode === 500) {
        console.warn(`nginx start attempt ${attempt} failed, retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        throw err;
      }
    }
  }
}

const CERTS_PATH = '/etc/nginx/certs';

async function execCollect(containerName: string, cmd: string[]): Promise<string> {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = (await exec.start({})) as unknown as NodeJS.ReadableStream;

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

/** Map of port -> set of bind addresses declared by `listen` directives. */
export function extractListens(conf: string): Map<string, Set<string>> {
  const listens = new Map<string, Set<string>>();
  // Strip comments so a directive mentioned in prose cannot be picked up as real.
  const cleaned = conf.replace(/#[^\n]*/g, '');

  for (const match of cleaned.matchAll(/\blisten\s+([^;{}]+);/g)) {
    const target = match[1].trim().split(/\s+/)[0];
    const idx = target.lastIndexOf(':');
    const address = idx === -1 ? '0.0.0.0' : target.slice(0, idx);
    const port = idx === -1 ? target : target.slice(idx + 1);
    if (!listens.has(port)) listens.set(port, new Set());
    listens.get(port)!.add(address);
  }

  return listens;
}

/**
 * Sockets nginx is actually listening on, read from /proc/net/tcp inside its container.
 *
 * nginx uses host networking, so its /proc/net/tcp is the host's. This is ground truth,
 * which the config file on disk is not: if a previous reload failed to bind, the file
 * says one thing and the running process another — precisely the state this check has
 * to detect. The image has no ss or netstat, hence /proc.
 */
async function getBoundListeners(): Promise<Map<string, Set<string>>> {
  const bound = new Map<string, Set<string>>();
  const raw = await execCollect(config.nginxContainerName, ['cat', '/proc/net/tcp']).catch(() => '');

  for (const line of raw.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    // st == 0A is TCP_LISTEN.
    if (fields[3] !== '0A') continue;

    const [hexIp, hexPort] = fields[1].split(':');
    if (!hexIp || !hexPort || hexIp.length !== 8) continue;

    // The address is little-endian, so the octets read back to front.
    const octets = [6, 4, 2, 0].map((i) => parseInt(hexIp.slice(i, i + 2), 16));
    if (octets.some(Number.isNaN)) continue;
    const address = octets.join('.');
    const port = String(parseInt(hexPort, 16));

    if (!bound.has(port)) bound.set(port, new Set());
    bound.get(port)!.add(address);
  }

  return bound;
}

/**
 * Whether applying `next` requires restarting nginx rather than reloading it.
 *
 * A reload cannot rebind a port whose address changed: the old workers still hold the
 * socket, so binding e.g. 213.165.44.205:443 while 0.0.0.0:443 is held fails with
 * EADDRINUSE. nginx then keeps the old configuration — and `nginx -s reload` still
 * exits 0, with the error going only to the master's stderr. Silent, and exactly what
 * happens when a node switches between the two 443 schemes.
 *
 * Ports that only appear on one side are fine: adding a brand-new listener or dropping
 * an old one is something reload handles.
 */
export function requiresRestart(current: string | Map<string, Set<string>>, next: string): boolean {
  const before = typeof current === 'string' ? extractListens(current) : current;
  const after = extractListens(next);

  for (const [port, addresses] of after) {
    const previous = before.get(port);
    if (!previous) continue;
    if (previous.size !== addresses.size || [...addresses].some((a) => !previous.has(a))) {
      return true;
    }
  }

  return false;
}

let http2DirectiveCache: boolean | null = null;

/**
 * Whether the installed nginx wants `http2 on;` (>= 1.25.1) rather than the `http2`
 * parameter on `listen`. Emitting the wrong form is a fatal config error, and pullImage
 * skips the pull when an image is already present — so a long-lived node can still be
 * running whatever nginx:latest meant when it was first set up.
 */
async function supportsHttp2Directive(): Promise<boolean> {
  if (http2DirectiveCache !== null) return http2DirectiveCache;

  try {
    const output = await execCollect(config.nginxContainerName, ['nginx', '-v']);
    const match = /nginx\/(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (match) {
      const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const version = major * 1_000_000 + minor * 1_000 + patch;
      http2DirectiveCache = version >= 1_025_001;
      console.log(`nginx ${match[1]}.${match[2]}.${match[3]} — http2 ${http2DirectiveCache ? 'directive' : 'listen parameter'}`);
    } else {
      console.warn('Не удалось разобрать версию nginx, использую современный синтаксис http2');
      http2DirectiveCache = true;
    }
  } catch {
    http2DirectiveCache = true;
  }

  return http2DirectiveCache;
}

/**
 * Copy stored certificates into the nginx container.
 *
 * Certificates live in DATA_DIR (already a mounted volume) and are pushed with
 * putArchive, the same way nginx.conf is. That deliberately avoids adding a bind mount,
 * which would require recreating the production nginx container.
 *
 * Must run before every reload that references a certificate, and after the container
 * is recreated, since the container filesystem is not persistent.
 */
export async function pushCertificates(domains: string[]): Promise<void> {
  if (domains.length === 0) return;

  const container = docker.getContainer(config.nginxContainerName);

  for (const domain of domains) {
    const stored = acme.readCertificate(domain);
    if (!stored) {
      console.warn(`Нет сертификата для ${domain}, пропускаю`);
      continue;
    }

    // putArchive extracts into an existing directory, so create it first.
    // execCollect drains the stream to its end, which is what actually waits for the
    // command to finish: exec.start() resolves as soon as the stream exists, so a bare
    // await here would let putArchive run before mkdir had created anything.
    await execCollect(config.nginxContainerName, ['mkdir', '-p', `${CERTS_PATH}/${domain}`]);

    const tar = createTar([
      { name: 'fullchain.pem', content: stored.cert },
      { name: 'privkey.pem', content: stored.key, mode: 0o600 },
    ]);
    await container.putArchive(tar, { path: `${CERTS_PATH}/${domain}` });
  }
}

export async function updateNginxConfig(proxies: ProxyConfig[]): Promise<void> {
  // Filter out proxies whose containers don't exist (stale data)
  const aliveProxies: ProxyConfig[] = [];
  for (const p of proxies) {
    try {
      const container = docker.getContainer(p.containerName);
      await container.inspect();
      aliveProxies.push(p);
    } catch {
      console.warn(`Skipping proxy ${p.id}: container ${p.containerName} not found, excluding from nginx config`);
    }
  }

  await ensureNginxContainer();

  // Resolve container IPs (nginx uses host network, can't use Docker DNS)
  const ipMap = new Map<string, string>();
  for (const p of aliveProxies) {
    try {
      const ip = await resolveContainerIp(p.containerName);
      ipMap.set(p.containerName, ip);
    } catch (err) {
      console.warn(`Cannot resolve IP for ${p.containerName}, skipping from nginx config`);
    }
  }
  // Only include proxies whose IP we could resolve
  const reachableProxies = aliveProxies.filter((p) => ipMap.has(p.containerName));

  // Certificates must be in place before a config that references them is loaded.
  // ensureNginxContainer above may have just recreated the container, whose filesystem
  // starts empty, so this re-pushes unconditionally rather than only on change.
  const webDomains = reachableProxies.filter((p) => p.type === 'web').map((p) => p.domain);
  await pushCertificates(webDomains);

  const certifiedDomains = new Set(acme.listCertifiedDomains());
  for (const domain of webDomains) {
    if (!certifiedDomains.has(domain)) {
      console.warn(`WEB-прокси ${domain} пока без сертификата — vhost не публикуется`);
    }
  }

  const nginxConf = generateNginxConfig(reachableProxies, ipMap, {
    certifiedDomains,
    http2Directive: await supportsHttp2Directive(),
  });
  const container = docker.getContainer(config.nginxContainerName);

  // Compare against the sockets nginx actually holds, not the config file: after a
  // failed reload the file already describes a state the process never reached.
  const boundNow = await getBoundListeners();
  const mustRestart = boundNow.size > 0 && requiresRestart(boundNow, nginxConf);

  const tarStream = createTarBuffer('nginx.conf', nginxConf);
  await container.putArchive(tarStream, { path: '/etc/nginx' });

  // nginx validates before applying, so a bad config leaves the running one in place.
  // Check explicitly anyway: otherwise the failure is silent and the node keeps serving
  // a stale config while believing it applied a new one.
  const test = await execCollect(config.nginxContainerName, ['nginx', '-t']);
  if (!/syntax is ok/i.test(test) || !/test is successful/i.test(test)) {
    throw new Error(`nginx отверг конфигурацию, изменения не применены:\n${test.trim()}`);
  }

  if (mustRestart) {
    console.log('Набор слушающих адресов nginx изменился — рестарт вместо reload');
    await container.restart();
    return;
  }

  // Same reason as above: wait for the reload to actually run, not just to be started.
  await execCollect(config.nginxContainerName, ['nginx', '-s', 'reload']);
}

// Telegram DC IP ranges to filter out
const TELEGRAM_DC_RANGES = [
  '149.154.160.', '149.154.161.', '149.154.162.', '149.154.163.',
  '149.154.164.', '149.154.165.', '149.154.166.', '149.154.167.',
  '149.154.168.', '149.154.169.', '149.154.170.', '149.154.171.',
  '149.154.172.', '149.154.173.', '149.154.174.', '149.154.175.',
  '91.108.4.', '91.108.5.', '91.108.6.', '91.108.7.', '91.108.8.',
  '91.108.9.', '91.108.10.', '91.108.11.', '91.108.12.', '91.108.13.',
  '91.108.16.', '91.108.17.', '91.108.18.', '91.108.19.', '91.108.20.',
  '91.108.56.', '91.108.57.', '91.108.58.', '91.108.59.',
  '91.105.192.', '91.105.193.', '91.105.194.', '91.105.195.',
  '185.76.151.',
  '95.161.64.',
];

function isTelegramIp(ip: string): boolean {
  return TELEGRAM_DC_RANGES.some((prefix) => ip.startsWith(prefix));
}

// Simple in-memory geo cache to avoid hammering the API
const geoCache = new Map<string, { country: string; countryCode: string; ts: number }>();
const GEO_CACHE_TTL = 3600000; // 1 hour

async function lookupGeo(ips: string[]): Promise<Map<string, { country: string; countryCode: string }>> {
  const result = new Map<string, { country: string; countryCode: string }>();
  const toFetch: string[] = [];

  for (const ip of ips) {
    const cached = geoCache.get(ip);
    if (cached && Date.now() - cached.ts < GEO_CACHE_TTL) {
      result.set(ip, { country: cached.country, countryCode: cached.countryCode });
    } else {
      toFetch.push(ip);
    }
  }

  if (toFetch.length > 0) {
    try {
      const resp = await fetch('http://ip-api.com/batch?fields=query,country,countryCode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toFetch.map((ip) => ({ query: ip }))),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json() as Array<{ query: string; country?: string; countryCode?: string }>;
        for (const entry of data) {
          if (entry.country && entry.countryCode) {
            geoCache.set(entry.query, { country: entry.country, countryCode: entry.countryCode, ts: Date.now() });
            result.set(entry.query, { country: entry.country, countryCode: entry.countryCode });
          }
        }
      }
    } catch {
      // Geo lookup failed — return without country info
    }
  }

  return result;
}

export async function getNginxConnectedIps(domain: string): Promise<ConnectedIpInfo[]> {
  try {
    const container = docker.getContainer(config.nginxContainerName);
    const logs = await container.logs({
      stdout: true,
      stderr: false,
      tail: 2000,
    });
    const logStr = logs.toString('utf-8');
    const ipSet = new Set<string>();
    const blacklisted = new Set(store.getBlacklistedIps());
    // Log format: "<ip> [<date>] <domain> <status>"
    // Docker stream header (8 bytes) may prefix each line
    for (const line of logStr.split('\n')) {
      if (!line.includes(domain)) continue;
      const match = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (match) {
        const ip = match[1];
        if (
          !ip.startsWith('127.') &&
          !ip.startsWith('172.') &&
          !ip.startsWith('10.') &&
          !ip.startsWith('192.168.') &&
          ip !== '0.0.0.0' &&
          !isTelegramIp(ip) &&
          !blacklisted.has(ip)
        ) {
          ipSet.add(ip);
        }
      }
    }

    const ips = Array.from(ipSet);
    const geoMap = await lookupGeo(ips);

    return ips.map((ip) => {
      const geo = geoMap.get(ip);
      return {
        ip,
        country: geo?.country,
        countryCode: geo?.countryCode,
      };
    });
  } catch {
    return [];
  }
}

function createTarBuffer(filename: string, content: string): Buffer {
  const contentBuffer = Buffer.from(content, 'utf-8');
  const header = Buffer.alloc(512);

  // Filename
  header.write(filename, 0, 100);
  // File mode
  header.write('0000644\0', 100, 8);
  // Owner UID
  header.write('0000000\0', 108, 8);
  // Group GID
  header.write('0000000\0', 116, 8);
  // File size in octal
  header.write(contentBuffer.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  // Modification time
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  // Blank checksum
  header.write('        ', 148, 8);
  // Type flag - normal file
  header.write('0', 156, 1);

  // Calculate checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  // Pad content to 512-byte boundary
  const padding = 512 - (contentBuffer.length % 512);
  const paddingBuffer = padding < 512 ? Buffer.alloc(padding) : Buffer.alloc(0);
  const endBlock = Buffer.alloc(1024);

  return Buffer.concat([header, contentBuffer, paddingBuffer, endBlock]);
}

// --- Real-time IP watcher via nginx log streaming ---

// Cache domain→proxyId to avoid reading disk on every log line
let domainToProxyCache: Map<string, string> = new Map();
let domainCacheTs = 0;

function getProxyIdByDomain(domain: string): string | undefined {
  if (Date.now() - domainCacheTs > 30000) {
    const proxies = store.getAllProxies();
    domainToProxyCache = new Map(proxies.map((p) => [p.domain, p.id]));
    domainCacheTs = Date.now();
  }
  return domainToProxyCache.get(domain);
}

function processNginxLogLine(line: string): void {
  // Log format: "<ip> [<date>] <domain> <status>"
  const match = line.match(
    /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+\[.*?\]\s+(\S+)/
  );
  if (!match) return;
  const [, ip, domain] = match;

  if (
    ip.startsWith('127.') ||
    ip.startsWith('172.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip === '0.0.0.0' ||
    isTelegramIp(ip)
  ) return;

  if (domain === '-' || domain === '') return;

  const proxyId = getProxyIdByDomain(domain);
  if (!proxyId) return;

  if (store.getBlacklistedIps().includes(ip)) return;

  // Geo lookup is async; record immediately without geo, then update with geo
  store.updateIpHistory(proxyId, [{ ip }]);
  lookupGeo([ip]).then((geoMap) => {
    const geo = geoMap.get(ip);
    if (geo) store.updateIpHistory(proxyId, [{ ip, country: geo.country, countryCode: geo.countryCode }]);
  }).catch(() => {});
}

async function watchNginxLogs(): Promise<void> {
  const container = docker.getContainer(config.nginxContainerName);
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: false,
    since: Math.floor(Date.now() / 1000),
  }) as unknown as NodeJS.ReadableStream;

  // Docker multiplexed log stream: each frame has an 8-byte header
  // [stream_type(1), padding(3), payload_size(4 BE)] followed by payload bytes.
  // The size bytes can contain printable ASCII digits (e.g. 0x34='4') which
  // would corrupt IP addresses if we naively convert the whole chunk to string.
  let rawBuf = Buffer.alloc(0);
  let textBuf = '';
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      // Consume complete frames from rawBuf
      while (rawBuf.length >= 8) {
        const payloadSize = rawBuf.readUInt32BE(4);
        if (rawBuf.length < 8 + payloadSize) break; // wait for more data
        textBuf += rawBuf.slice(8, 8 + payloadSize).toString('utf-8');
        rawBuf = rawBuf.slice(8 + payloadSize);
        // Process complete lines
        const lines = textBuf.split('\n');
        textBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) processNginxLogLine(trimmed);
        }
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

export function startNginxLogWatcher(): void {
  const reconnect = (delay = 0) => {
    setTimeout(async () => {
      try {
        await watchNginxLogs();
      } catch {
        // container not ready yet or stream ended — will retry
      }
      reconnect(5000);
    }, delay);
  };
  reconnect(3000); // small initial delay to let nginx fully start
}
