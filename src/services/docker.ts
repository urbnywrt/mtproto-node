import Docker from 'dockerode';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { config, TELEMT_SITE_DIR, TELEMT_VERSION, TELEMT_WEB_PORT } from '../config';
import { WebCarrier, WebSecretMode } from '../types';
import { createTar } from '../utils/tar';
import { generateSite } from './site-generator';
import { StringDecoder } from 'string_decoder';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const TELEMT_DOCKERFILE = `FROM debian:bookworm-slim

RUN apt-get update && \\
    apt-get install -y curl wget ca-certificates && \\
    rm -rf /var/lib/apt/lists/*

RUN ARCH=$(uname -m) && \\
    wget -qO- "https://github.com/telemt/telemt/releases/download/${TELEMT_VERSION}/telemt-\${ARCH}-linux-gnu.tar.gz" | tar -xz -C /usr/local/bin/ && \\
    chmod +x /usr/local/bin/telemt

RUN useradd -r -s /bin/false telemt && \\
    mkdir -p /etc/telemt /opt/telemt /var/lib/telemt/public && \\
    chown -R telemt:telemt /etc/telemt /opt/telemt /var/lib/telemt

WORKDIR /opt/telemt

USER telemt

ENV RUST_LOG=info

CMD ["/usr/local/bin/telemt", "/etc/telemt/config.toml"]
`;

export async function ensureNetwork(): Promise<void> {
  try {
    const network = docker.getNetwork(config.dockerNetwork);
    await network.inspect();
  } catch {
    await docker.createNetwork({
      Name: config.dockerNetwork,
      Driver: 'bridge',
    });
  }
}

export async function reconnectContainersToNetwork(): Promise<void> {
  const network = docker.getNetwork(config.dockerNetwork);
  const containers = await docker.listContainers({ all: true });

  const managed = containers.filter((c) =>
    c.Names.some(
      (n) =>
        n.includes(config.proxyContainerPrefix) ||
        n.includes(config.xrayContainerPrefix) ||
        n.includes(config.nginxContainerName)
    )
  );

  for (const info of managed) {
    const networks = Object.keys(info.NetworkSettings?.Networks || {});
    if (!networks.includes(config.dockerNetwork)) {
      try {
        // Skip containers using host network — they cannot join other networks
        if (networks.includes('host') || info.HostConfig?.NetworkMode === 'host') {
          continue;
        }
        await network.connect({ Container: info.Id });
        const name = info.Names[0]?.replace(/^\//, '') || info.Id.slice(0, 12);
        console.log(`Reconnected ${name} to ${config.dockerNetwork}`);
      } catch (err: any) {
        console.error(`Failed to reconnect ${info.Names[0]}:`, err.message);
      }
    }
  }
}

export async function pullImage(image: string): Promise<void> {
  // If the image already exists locally, skip pulling to avoid Docker Hub rate limits
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // Image not found locally — pull it
  }

  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2: Error | null) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

const DOCKERFILE_HASH = createHash('sha256').update(TELEMT_DOCKERFILE).digest('hex').slice(0, 12);

export async function ensureProxyImage(): Promise<void> {
  let needsBuild = false;
  try {
    const imageInfo = await docker.getImage(config.proxyImageName).inspect();
    const existingHash = imageInfo.Config?.Labels?.['dockerfile.hash'] || '';
    if (existingHash !== DOCKERFILE_HASH) {
      console.log(`Proxy image outdated (${existingHash || 'none'} -> ${DOCKERFILE_HASH}), rebuilding...`);
      try { await docker.getImage(config.proxyImageName).remove({ force: true }); } catch {}
      needsBuild = true;
    }
  } catch {
    needsBuild = true;
  }

  if (needsBuild) {
    const tarBuffer = createTarBuffer('Dockerfile', TELEMT_DOCKERFILE);
    const stream = Readable.from(tarBuffer);

    await new Promise<void>((resolve, reject) => {
      docker.buildImage(stream, { t: config.proxyImageName, labels: { 'dockerfile.hash': DOCKERFILE_HASH } }, (err, output) => {
        if (err) return reject(err);
        if (!output) return reject(new Error('No build stream'));
        docker.modem.followProgress(output, (err2: Error | null) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }
}

/**
 * If value is a socks5:// URL, parse it and resolve localhost to host.docker.internal.
 * Returns null if it's a plain container name.
 */
function parseSocks5Url(value: string): { host: string; port: number } | null {
  if (!value.startsWith('socks5://')) return null;
  const withoutScheme = value.slice('socks5://'.length);
  const colonIdx = withoutScheme.lastIndexOf(':');
  const rawHost = colonIdx === -1 ? withoutScheme : withoutScheme.slice(0, colonIdx);
  const port = colonIdx === -1 ? 1080 : (parseInt(withoutScheme.slice(colonIdx + 1), 10) || 1080);
  const host = (rawHost === '127.0.0.1' || rawHost === 'localhost') ? 'host.docker.internal' : rawHost;
  return { host, port };
}

async function resolveContainerIp(containerName: string): Promise<string> {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  const networks = info.NetworkSettings.Networks;
  // Prefer the shared mtproto network, fall back to any available IP
  if (networks[config.dockerNetwork]?.IPAddress) {
    return networks[config.dockerNetwork].IPAddress;
  }
  const first = Object.values(networks).find(n => n?.IPAddress);
  if (first?.IPAddress) return first.IPAddress;
  throw new Error(`Cannot resolve IP for container ${containerName}`);
}

interface TelemtProxyOptions {
  useMiddleProxy?: boolean;
  fastMode?: boolean;
  meInitRetryAttempts?: number;
  me2dcFallback?: boolean;
  me2dcFast?: boolean;
  meKeepaliveEnabled?: boolean;
  meKeepaliveIntervalSecs?: number;
  meKeepaliveJitterSecs?: number;
  meKeepalivePayloadRandom?: boolean;
  meReconnectBackoffBaseMs?: number;
  meReconnectBackoffCapMs?: number;
  meReconnectFastRetryCount?: number;
  desyncAllFull?: boolean;
  meWriterPickMode?: string;
  meWarmupStaggerEnabled?: boolean;
  meWarmupStepDelayMs?: number;
  meWarmupStepJitterMs?: number;
  beobachten?: boolean;
  beobachtenMinutes?: number;
  beobachtenFlushSecs?: number;
  beobachtenFile?: string;
  upstreamConnectRetryAttempts?: number;
  upstreamConnectRetryBackoffMs?: number;
  tgConnect?: number;
  rstOnClose?: string;
  logLevel?: string;
  unknownDcFileLogEnabled?: boolean;
  updateEvery?: number;
  networkPrefer?: string;
  stunServers?: string[];
  serverClientMss?: number;
  censorshipTlsDomain?: string;
  censorshipTlsEmulation?: boolean;
  censorshipTlsFrontDir?: string;
}

function generateConfigToml(
  secret: string,
  domain: string,
  listenPort: number,
  tag?: string,
  socks5Host?: string,
  socks5Port?: number,
  maskHost?: string,
  natIp?: string,
  options: TelemtProxyOptions = {},
): string {
  const cleanTag = tag ? tag.trim().replace(/[^0-9a-fA-F]/g, '') : '';
  const opts: Required<TelemtProxyOptions> = {
    useMiddleProxy: true,
    fastMode: true,
    meInitRetryAttempts: 5,
    me2dcFallback: true,
    me2dcFast: true,
    meKeepaliveEnabled: true,
    meKeepaliveIntervalSecs: 5,
    meKeepaliveJitterSecs: 1,
    meKeepalivePayloadRandom: true,
    meReconnectBackoffBaseMs: 200,
    meReconnectBackoffCapMs: 1000,
    meReconnectFastRetryCount: 12,
    desyncAllFull: true,
    meWriterPickMode: 'p2c',
    meWarmupStaggerEnabled: true,
    meWarmupStepDelayMs: 30,
    meWarmupStepJitterMs: 5,
    beobachten: true,
    beobachtenMinutes: 15,
    beobachtenFlushSecs: 5,
    beobachtenFile: '/tmp/telemt-beobachten.json',
    upstreamConnectRetryAttempts: 5,
    upstreamConnectRetryBackoffMs: 500,
    tgConnect: 10,
    rstOnClose: 'off',
    logLevel: 'silent',
    unknownDcFileLogEnabled: true,
    updateEvery: 30,
    networkPrefer: 'system',
    stunServers: ['stun.l.google.com:19302'],
    serverClientMss: 1360,
    censorshipTlsDomain: domain,
    censorshipTlsEmulation: true,
    censorshipTlsFrontDir: '',
    ...options,
  };

  let toml = `[general]
use_middle_proxy = ${opts.useMiddleProxy}
fast_mode = ${opts.fastMode}
me2dc_fallback = ${opts.me2dcFallback}
me2dc_fast = ${opts.me2dcFast}
me_keepalive_enabled = ${opts.meKeepaliveEnabled}
me_keepalive_interval_secs = ${opts.meKeepaliveIntervalSecs}
me_keepalive_jitter_secs = ${opts.meKeepaliveJitterSecs}
me_keepalive_payload_random = ${opts.meKeepalivePayloadRandom}
me_reconnect_backoff_base_ms = ${opts.meReconnectBackoffBaseMs}
me_reconnect_backoff_cap_ms = ${opts.meReconnectBackoffCapMs}
me_reconnect_fast_retry_count = ${opts.meReconnectFastRetryCount}
desync_all_full = ${opts.desyncAllFull}
me_writer_pick_mode = "${opts.meWriterPickMode}"
me_warmup_stagger_enabled = ${opts.meWarmupStaggerEnabled}
me_warmup_step_delay_ms = ${opts.meWarmupStepDelayMs}
me_warmup_step_jitter_ms = ${opts.meWarmupStepJitterMs}
beobachten = ${opts.beobachten}
beobachten_minutes = ${opts.beobachtenMinutes}
beobachten_flush_secs = ${opts.beobachtenFlushSecs}
beobachten_file = "${opts.beobachtenFile}"
upstream_connect_retry_attempts = ${opts.upstreamConnectRetryAttempts}
upstream_connect_retry_backoff_ms = ${opts.upstreamConnectRetryBackoffMs}
tg_connect = ${opts.tgConnect}
rst_on_close = "${opts.rstOnClose}"
log_level = "${opts.logLevel}"
unknown_dc_file_log_enabled = ${opts.unknownDcFileLogEnabled}
update_every = ${opts.updateEvery}
network_prefer = "${opts.networkPrefer}"
stun_servers = [${opts.stunServers.map((server) => `"${server}"`).join(', ')}]
server_client_mss = ${opts.serverClientMss}
me_init_retry_attempts = ${opts.meInitRetryAttempts}
`;

  // VPN mode: tell ME servers to expect connections from the VPN exit IP.
  // ME traffic uses direct routing; host iptables marks port-8888 packets
  // and routes them via tun0 so the source IP seen by ME servers = natIp.
  if (natIp) {
    toml += `middle_proxy_nat_ip = "${natIp}"\n`;
  }

  if (cleanTag.length === 32) {
    toml += `ad_tag = "${cleanTag}"\n`;
  }

  toml += `
[general.modes]
classic = false
secure = false
tls = true

[server]
port = ${listenPort || 443}

[censorship]
tls_domain = "${opts.censorshipTlsDomain}"
mask = true
`;

  toml += `tls_emulation = ${opts.censorshipTlsEmulation}
`;

  if (opts.censorshipTlsFrontDir) {
    toml += `tls_front_dir = "${opts.censorshipTlsFrontDir}"
`;
  }

  if (maskHost) {
    toml += `mask_host = "${maskHost}"\n`;
  }

  toml += `
[access.users]
user1 = "${secret}"
`;

  if (natIp && socks5Host && socks5Port) {
    // Hybrid mode: ME goes direct (host routes it via tun0 → EU IP for KDF);
    // DC traffic goes through xray/SOCKS5 to bypass RKN.
    toml += `
[[upstreams]]
type = "direct"
scopes = "me"

[[upstreams]]
type = "socks5"
address = "${socks5Host}:${socks5Port}"
`;
  } else if (!natIp && socks5Host && socks5Port) {
    // Legacy mode: ME and fetch go direct; DC goes through SOCKS5.
    toml += `
[[upstreams]]
type = "direct"
scopes = "me, fetch"

[[upstreams]]
type = "socks5"
address = "${socks5Host}:${socks5Port}"
`;
  }
  // natIp only (no socks5): all traffic direct via tun0 — simple mode.

  return toml;
}

/**
 * Gateway address of the mtproto-net bridge.
 *
 * nginx runs with host networking and dials the container's bridge address, so from
 * inside the container every request from nginx appears to come from this gateway.
 * telemt's WEB listener needs it as its trusted-proxy boundary.
 */
export async function getNetworkGateway(): Promise<string> {
  const network = docker.getNetwork(config.dockerNetwork);
  const info = await network.inspect();
  const ipam = info?.IPAM?.Config?.[0];

  if (ipam?.Gateway) return `${ipam.Gateway}/32`;
  // Slightly looser but still bounded to the bridge; telemt rejects an empty list.
  if (ipam?.Subnet) return ipam.Subnet;

  throw new Error(
    `Не удалось определить шлюз сети ${config.dockerNetwork} для web_trusted_proxy_cidrs`
  );
}

/**
 * Port telemt is configured to listen on inside an existing container, read from its
 * own config.toml. Ground truth for backfilling containerPort on upgrade, and immune
 * to NGINX_PORT having been changed in the meantime. Null when it cannot be read —
 * a stopped container, or one predating this layout.
 */
export async function readContainerListenPort(containerName: string): Promise<number | null> {
  try {
    const container = docker.getContainer(containerName);
    const exec = await container.exec({
      Cmd: ['grep', '-m1', '-E', '^port = [0-9]+', '/etc/telemt/config.toml'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = (await exec.start({})) as unknown as NodeJS.ReadableStream;
    const output = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });

    const match = /port\s*=\s*(\d+)/.exec(output);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export interface WebProxyConfigOptions {
  secret: string;
  domain: string;
  /** Public IP the domain resolves to; participates in telemt's inner relay tuple. */
  publicIp: string;
  carrier: WebCarrier;
  secretMode: WebSecretMode;
  trustedProxyCidr: string;
  /** Mode 1 shares nginx's stream listener, which hides the real client address. */
  neutralizePerIpLimits: boolean;
  socks5Host?: string;
  socks5Port?: number;
  natIp?: string;
  options?: TelemtProxyOptions;
}

/**
 * config.toml for a WEB proxy.
 *
 * Deliberately different from the fake TLS config rather than a variation of it:
 *
 * - No [censorship]. That section configures the fake-TLS masking path, which WEB
 *   traffic never enters ("invalid inner handshakes close only their logical stream
 *   and never enter the TCP masking path"). Pointing tls_domain at the operator's real
 *   domain would be actively wrong.
 * - No [general.modes]. telemt's documented minimal WEB config omits it; the inner
 *   handshake is selected by the profile's secret_mode instead.
 * - No [server] port. The listener is declared explicitly with transport = "web".
 */
export function generateWebConfigToml(opts: WebProxyConfigOptions): string {
  const o = opts.options || {};
  const bool = (value: boolean | undefined, fallback: boolean) => (value === undefined ? fallback : value);

  let toml = `[general]
use_middle_proxy = ${bool(o.useMiddleProxy, true)}
fast_mode = ${bool(o.fastMode, true)}
log_level = "${o.logLevel || 'silent'}"
`;

  if (opts.natIp) {
    toml += `middle_proxy_nat_ip = "${opts.natIp}"\n`;
  }

  toml += `
[access.users]
user1 = "${opts.secret}"

[[server.listeners]]
ip = "0.0.0.0"
port = ${TELEMT_WEB_PORT}
transport = "web"
proxy_protocol = false
reuse_allow = false
web_client_ip_source = "x_forwarded_for"
web_trusted_proxy_cidrs = ["${opts.trustedProxyCidr}"]

[web]
enabled = true
carrier = "${opts.carrier}"
`;

  if (opts.neutralizePerIpLimits) {
    // nginx terminates TLS behind its shared stream listener here, so telemt sees one
    // address for every client. Left at their defaults the per-IP caps would apply to
    // the whole proxy at once (16 sessions total). Real per-IP limiting is done in the
    // nginx stream block, where $remote_addr is the actual client. See PLAN.md §3.
    toml += `
[web.limits]
max_sessions_per_ip = 128
max_bootstraps_per_ip = 512
`;
  }

  toml += `
[[web.vhosts]]
host = "${opts.domain}"
public_addr = "${opts.publicIp}:443"

[web.vhosts.decoy]
mode = "static_directory"
directory = "${TELEMT_SITE_DIR}"
index = "index.html"

[[web.vhosts.profiles]]
user = "user1"
secret_mode = "${opts.secretMode}"
`;

  // Outbound routing is independent of listener transport, so VLESS/SOCKS5 works for
  // WEB proxies exactly as it does for fake TLS ones.
  if (opts.natIp && opts.socks5Host && opts.socks5Port) {
    toml += `
[[upstreams]]
type = "direct"
scopes = "me"

[[upstreams]]
type = "socks5"
address = "${opts.socks5Host}:${opts.socks5Port}"
`;
  } else if (!opts.natIp && opts.socks5Host && opts.socks5Port) {
    toml += `
[[upstreams]]
type = "direct"
scopes = "me, fetch"

[[upstreams]]
type = "socks5"
address = "${opts.socks5Host}:${opts.socks5Port}"
`;
  }

  return toml;
}

export async function createProxyContainer(
  containerName: string,
  secret: string,
  domain: string,
  listenPort: number,
  tag?: string,
  socks5Host?: string,
  maskHost?: string,
  natIp?: string,
  options: TelemtProxyOptions = {},
): Promise<string> {
  await ensureNetwork();
  await ensureProxyImage();

  // Resolve socks5:// URL vs container name, determine host/port for native upstream
  const directSocks5 = socks5Host ? parseSocks5Url(socks5Host) : null;
  let resolvedSocks5Host: string | undefined;
  let resolvedSocks5Port: number | undefined;
  if (socks5Host) {
    if (directSocks5) {
      resolvedSocks5Host = directSocks5.host;
      resolvedSocks5Port = directSocks5.port;
    } else {
      resolvedSocks5Host = await resolveContainerIp(socks5Host);
      resolvedSocks5Port = 10808;
    }
  }

  // Resolve maskHost: replace loopback with host.docker.internal
  let resolvedMaskHost: string | undefined;
  let needsHostGateway = directSocks5?.host === 'host.docker.internal';
  if (resolvedSocks5Host === 'host.docker.internal') needsHostGateway = true;
  if (maskHost) {
    const colonIdx = maskHost.lastIndexOf(':');
    const mHost = colonIdx === -1 ? maskHost : maskHost.slice(0, colonIdx);
    const mPort = colonIdx === -1 ? '' : maskHost.slice(colonIdx);
    if (mHost === '127.0.0.1' || mHost === 'localhost') {
      resolvedMaskHost = `host.docker.internal${mPort}`;
      needsHostGateway = true;
    } else {
      resolvedMaskHost = maskHost;
    }
  }

  const container = await docker.createContainer({
    Image: config.proxyImageName,
    name: containerName,
    HostConfig: {
      NetworkMode: config.dockerNetwork,
      RestartPolicy: { Name: 'unless-stopped' },
      CapAdd: ['NET_BIND_SERVICE'],
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '5m', 'max-file': '2' },
      },
      ...(needsHostGateway ? { ExtraHosts: ['host.docker.internal:host-gateway'] } : {}),
    },
  });

  // Inject config.toml into the container before starting
  const configContent = generateConfigToml(secret, domain, listenPort, tag, resolvedSocks5Host, resolvedSocks5Port, resolvedMaskHost, natIp, options);
  const tarBuffer = createTarBuffer('config.toml', configContent);
  await container.putArchive(tarBuffer, { path: '/etc/telemt' });

  await container.start();
  return container.id;
}

export interface CreateWebProxyOptions {
  containerName: string;
  /** Seed for the decoy site; stable per proxy so its fingerprint does not drift. */
  siteSeed: string;
  secret: string;
  domain: string;
  publicIp: string;
  carrier: WebCarrier;
  secretMode: WebSecretMode;
  neutralizePerIpLimits: boolean;
  socks5Host?: string;
  natIp?: string;
  options?: TelemtProxyOptions;
}

/**
 * Create a WEB proxy container.
 *
 * Separate from createProxyContainer rather than a branch inside it: the fake TLS path
 * is in production on every node and must keep producing byte-identical configs, so it
 * is left untouched.
 */
export async function createWebProxyContainer(opts: CreateWebProxyOptions): Promise<string> {
  await ensureNetwork();
  await ensureProxyImage();

  const directSocks5 = opts.socks5Host ? parseSocks5Url(opts.socks5Host) : null;
  let resolvedSocks5Host: string | undefined;
  let resolvedSocks5Port: number | undefined;
  if (opts.socks5Host) {
    if (directSocks5) {
      resolvedSocks5Host = directSocks5.host;
      resolvedSocks5Port = directSocks5.port;
    } else {
      resolvedSocks5Host = await resolveContainerIp(opts.socks5Host);
      resolvedSocks5Port = 10808;
    }
  }
  const needsHostGateway = resolvedSocks5Host === 'host.docker.internal';

  const trustedProxyCidr = await getNetworkGateway();

  const container = await docker.createContainer({
    Image: config.proxyImageName,
    name: opts.containerName,
    HostConfig: {
      NetworkMode: config.dockerNetwork,
      RestartPolicy: { Name: 'unless-stopped' },
      // No NET_BIND_SERVICE: the WEB listener binds 18080, not a privileged port.
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '5m', 'max-file': '2' },
      },
      ...(needsHostGateway ? { ExtraHosts: ['host.docker.internal:host-gateway'] } : {}),
    },
  });

  const configContent = generateWebConfigToml({
    secret: opts.secret,
    domain: opts.domain,
    publicIp: opts.publicIp,
    carrier: opts.carrier,
    secretMode: opts.secretMode,
    trustedProxyCidr,
    neutralizePerIpLimits: opts.neutralizePerIpLimits,
    socks5Host: resolvedSocks5Host,
    socks5Port: resolvedSocks5Port,
    natIp: opts.natIp,
    options: opts.options,
  });
  await container.putArchive(createTarBuffer('config.toml', configContent), { path: '/etc/telemt' });

  // telemt loads the static snapshot at startup, so the site must be in place first.
  const site = generateSite(opts.siteSeed);
  await container.putArchive(
    createTar(site.map((f) => ({ name: f.path, content: f.content }))),
    { path: TELEMT_SITE_DIR }
  );

  await container.start();
  return container.id;
}

export async function removeProxyContainer(containerName: string): Promise<void> {
  try {
    const container = docker.getContainer(containerName);
    try {
      await container.stop();
    } catch {
      // Container might already be stopped
    }
    await container.remove();
  } catch {
    // Container might not exist
  }
}

export async function getContainerStats(containerName: string): Promise<{
  cpuPercent: string;
  memoryUsage: string;
  memoryLimit: string;
  networkRx: string;
  networkTx: string;
  networkRxBytes: number;
  networkTxBytes: number;
}> {
  const container = docker.getContainer(containerName);
  const stats = await container.stats({ stream: false });

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus || 1;
  const cpuPercent = systemDelta > 0 ? ((cpuDelta / systemDelta) * cpuCount * 100).toFixed(2) : '0.00';

  const memUsage = stats.memory_stats.usage || 0;
  const memLimit = stats.memory_stats.limit || 0;

  let netRx = 0;
  let netTx = 0;
  if (stats.networks) {
    for (const iface of Object.values(stats.networks) as any[]) {
      netRx += iface.rx_bytes || 0;
      netTx += iface.tx_bytes || 0;
    }
  }

  return {
    cpuPercent: `${cpuPercent}%`,
    memoryUsage: formatBytes(memUsage),
    memoryLimit: formatBytes(memLimit),
    networkRx: formatBytes(netRx),
    networkTx: formatBytes(netTx),
    networkRxBytes: netRx,
    networkTxBytes: netTx,
  };
}

export async function getContainerStatus(containerName: string): Promise<string> {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    return info.State.Status;
  } catch {
    return 'not_found';
  }
}

export async function getContainerUptime(containerName: string): Promise<string> {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const startedAt = new Date(info.State.StartedAt);
    const now = new Date();
    const diff = now.getTime() - startedAt.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  } catch {
    return 'unknown';
  }
}

export async function restartContainer(containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);
  await container.restart();
}

export async function pauseContainer(containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);
  await container.pause();
}

export async function unpauseContainer(containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);
  await container.unpause();
}

export async function connectContainerToNetwork(containerName: string): Promise<void> {
  const network = docker.getNetwork(config.dockerNetwork);
  await network.connect({ Container: containerName });
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

export async function getContainerConnectedIps(containerName: string): Promise<string[]> {
  try {
    const container = docker.getContainer(containerName);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: 500,
    });
    const logStr = logs.toString('utf-8');
    const ipSet = new Set<string>();
    const ipRegex = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
    let match;
    while ((match = ipRegex.exec(logStr)) !== null) {
      const ip = match[1];
      // Filter out private, loopback, and Telegram DC IPs
      if (
        !ip.startsWith('127.') &&
        !ip.startsWith('172.') &&
        !ip.startsWith('10.') &&
        !ip.startsWith('192.168.') &&
        ip !== '0.0.0.0' &&
        !isTelegramIp(ip)
      ) {
        ipSet.add(ip);
      }
    }
    return Array.from(ipSet);
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function createTarBuffer(filename: string, content: string): Buffer {
  const contentBuffer = Buffer.from(content, 'utf-8');
  const header = Buffer.alloc(512);

  header.write(filename, 0, 100);
  header.write('0000644\0', 100, 8);
  header.write('0000000\0', 108, 8);
  header.write('0000000\0', 116, 8);
  header.write(contentBuffer.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  header.write('        ', 148, 8);
  header.write('0', 156, 1);

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  const padding = 512 - (contentBuffer.length % 512);
  const paddingBuffer = padding < 512 ? Buffer.alloc(padding) : Buffer.alloc(0);
  const endBlock = Buffer.alloc(1024);

  return Buffer.concat([header, contentBuffer, paddingBuffer, endBlock]);
}
