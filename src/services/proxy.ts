import { v4 as uuidv4 } from 'uuid';
import { config, FAKE_TLS_DOMAINS } from '../config';
import { ProxyConfig, ProxyCreateRequest, ProxyStats, ProxyType, ProxyUpdateRequest, ConnectedIpInfo, StatsSnapshot, IpHistoryEntry } from '../types';
import { generateSecret, getRandomElement, getRandomPort, buildFullSecret } from '../utils/crypto';
import * as store from '../store';
import * as acmeService from './acme';
import * as dockerService from './docker';
import * as nginxService from './nginx';
import * as preflightService from './preflight';
import * as xrayService from './xray';

/**
 * WEB proxies take a separate path: the domain is the operator's own rather than one
 * drawn from the fake TLS pool, creation is gated on preflight, and a certificate has
 * to exist before nginx will publish the vhost.
 */
async function createWebProxy(req: ProxyCreateRequest): Promise<ProxyConfig> {
  if (!req.domain) {
    throw new Error('Для WEB-прокси нужен собственный домен: из пула fake TLS он не берётся.');
  }
  if (!req.acmeEmail) {
    throw new Error('Для WEB-прокси нужен email для ACME.');
  }

  // Runs before any container, certificate or DNS record exists, so a failure here
  // leaves nothing behind to clean up.
  const { targetIp } = await preflightService.preflightWebProxy({
    domain: req.domain,
    nodeIp: req.nodeIp,
    acmeDnsToken: req.acmeDnsToken,
  });

  const id = uuidv4().split('-')[0];
  const secret = req.secret || generateSecret();
  const containerName = `${config.proxyContainerPrefix}${id}`;

  let port = req.port || 0;
  if (!port) {
    do {
      port = getRandomPort(config.portRangeStart, config.portRangeEnd);
    } while (store.isPortUsed(port));
  } else if (store.isPortUsed(port)) {
    throw new Error(`Port ${port} is already in use`);
  }

  let vpnContainerName: string | undefined;
  let socks5Host: string | undefined;
  if (req.vpnSubscription) {
    vpnContainerName = `${config.xrayContainerPrefix}${id}`;
    const vlessConfig = await xrayService.fetchAndParseSubscription(req.vpnSubscription);
    await xrayService.createXrayContainer(vpnContainerName, vlessConfig);
    socks5Host = vpnContainerName;
  }

  const { nodeIp: _nodeIp, ...persistable } = req;
  const natIp = req.natIp || config.natIp || undefined;

  const proxy: ProxyConfig = {
    // Spread first: a null or undefined `port`/`secret` in the request must not clobber
    // the values generated above.
    ...persistable,
    id,
    name: req.name || `Proxy ${id}`,
    note: req.note || '',
    port,
    secret,
    domain: req.domain,
    containerName,
    status: 'running',
    createdAt: new Date().toISOString(),
    trafficUp: 0,
    trafficDown: 0,
    connectedIps: [],
    vpnContainerName,
    type: 'web',
    webCarrier: req.webCarrier || 'https-lanes',
    webSecretMode: req.webSecretMode || 'plain',
    certStatus: 'pending',
    natIp,
    tunnelInterface: req.tunnelInterface || config.tunnelInterface || undefined,
  };

  let stored = false;
  try {
    await dockerService.createWebProxyContainer({
      containerName,
      siteSeed: id,
      secret,
      domain: req.domain,
      publicIp: targetIp,
      carrier: proxy.webCarrier!,
      secretMode: proxy.webSecretMode!,
      // Mode 1 shares nginx's stream listener, so telemt cannot see real client IPs.
      neutralizePerIpLimits: !config.webBindIp,
      socks5Host,
      natIp,
      options: req,
    });
    store.addProxy(proxy);
    stored = true;

    // Best effort: ACME failures are commonly transient (propagation, rate limits), and
    // discarding a fully created proxy over one would be worse than reporting it. The
    // vhost stays unpublished until a certificate exists, and the renewal timer retries.
    await acmeService.ensureCertificate(proxy);

    await nginxService.updateNginxConfig(store.getAllProxies());
    return store.getProxyById(id) || proxy;
  } catch (error) {
    if (stored) store.removeProxy(id);
    await dockerService.removeProxyContainer(containerName);
    if (vpnContainerName) await xrayService.removeXrayContainer(vpnContainerName);
    acmeService.removeCertificate(req.domain);
    // Put nginx back in step with the store after the rollback.
    await nginxService.updateNginxConfig(store.getAllProxies()).catch(() => {});
    throw error;
  }
}

export async function createProxy(req: ProxyCreateRequest): Promise<ProxyConfig> {
  if (req.type === 'web') return createWebProxy(req);

  const id = uuidv4().split('-')[0];
  const secret = req.secret || generateSecret();

  let domain: string;
  if (req.domain) {
    if (store.isDomainUsed(req.domain)) {
      throw new Error(`Domain ${req.domain} is already in use by another proxy`);
    }
    domain = req.domain;
  } else {
    const usedDomains = new Set(store.getUsedDomains());
    const customDomains = store.getCustomDomains();
    const domainPool = customDomains.length > 0 ? customDomains : FAKE_TLS_DOMAINS;
    const available = domainPool.filter((d) => !usedDomains.has(d));
    if (available.length === 0) {
      throw new Error('No available domains left. Delete a proxy or specify a custom domain.');
    }
    domain = getRandomElement(available);
  }

  let port = req.port || 0;
  if (!port) {
    do {
      port = getRandomPort(config.portRangeStart, config.portRangeEnd);
    } while (store.isPortUsed(port));
  } else if (store.isPortUsed(port)) {
    throw new Error(`Port ${port} is already in use`);
  }

  const containerName = `${config.proxyContainerPrefix}${id}`;

  // Handle VPN subscription
  let vpnContainerName: string | undefined;
  let socks5Host: string | undefined;
  if (req.vpnSubscription) {
    vpnContainerName = `${config.xrayContainerPrefix}${id}`;
    const vlessConfig = await xrayService.fetchAndParseSubscription(req.vpnSubscription);
    await xrayService.createXrayContainer(vpnContainerName, vlessConfig);
    socks5Host = vpnContainerName;
  }

  // nodeIp is a request-only hint used for preflight checks; it must not be persisted.
  const { nodeIp: _nodeIp, ...persistable } = req;

  const proxy: ProxyConfig = {
    id,
    name: req.name || `Proxy ${id}`,
    note: req.note || '',
    port,
    secret,
    domain,
    containerName,
    status: 'running',
    createdAt: new Date().toISOString(),
    trafficUp: 0,
    trafficDown: 0,
    connectedIps: [],
    vpnContainerName,
    ...persistable,
    type: req.type || 'faketls',
    natIp: req.natIp || config.natIp || undefined,
    tunnelInterface: req.tunnelInterface || config.tunnelInterface || undefined,
  };

  try {
    await dockerService.createProxyContainer(containerName, secret, domain, req.listenPort || config.nginxPort, req.tag, socks5Host, req.maskHost, req.natIp || config.natIp || undefined, req);
    store.addProxy(proxy);
    await nginxService.updateNginxConfig(store.getAllProxies());
    return proxy;
  } catch (error) {
    await dockerService.removeProxyContainer(containerName);
    if (vpnContainerName) await xrayService.removeXrayContainer(vpnContainerName);
    throw error;
  }
}

export async function listProxies(): Promise<ProxyConfig[]> {
  const proxies = store.getAllProxies();

  // Update status from Docker
  for (const proxy of proxies) {
    const status = await dockerService.getContainerStatus(proxy.containerName);
    if (status === 'running') {
      proxy.status = 'running';
    } else if (status === 'paused') {
      proxy.status = 'paused';
    } else if (status === 'not_found') {
      proxy.status = 'error';
    } else {
      proxy.status = 'stopped';
    }
  }

  // Attach nginxPort so clients can display the effective connection port
  return proxies.map((p) => ({ ...p, nginxPort: config.nginxPort }));
}

export async function getProxy(id: string): Promise<ProxyConfig | undefined> {
  const proxy = store.getProxyById(id);
  if (proxy) {
    const status = await dockerService.getContainerStatus(proxy.containerName);
    if (status === 'running') proxy.status = 'running';
    else if (status === 'paused') proxy.status = 'paused';
    else if (status === 'not_found') proxy.status = 'error';
    else proxy.status = 'stopped';
  }
  return proxy;
}

export async function updateProxy(id: string, req: ProxyUpdateRequest): Promise<ProxyConfig | undefined> {
  const proxy = store.getProxyById(id);
  if (!proxy) return undefined;

  let needsRestart = !!(req.domain && req.domain !== proxy.domain);
  const updates: Partial<ProxyConfig> = {};

  if (req.domain) updates.domain = req.domain;
  if (req.tag !== undefined) {
    updates.tag = req.tag;
    if (req.tag !== (proxy.tag || '')) needsRestart = true;
  }
  if (req.name !== undefined) updates.name = req.name;
  if (req.note !== undefined) updates.note = req.note;
  if (req.maxConnections !== undefined) updates.maxConnections = req.maxConnections;
  if (req.listenPort !== undefined && req.listenPort !== proxy.listenPort) {
    updates.listenPort = req.listenPort;
    needsRestart = true;
  }

  // Only keys that exist on both sides are copyable; this excludes request-only
  // hints such as nodeIp, which are used for validation and never persisted.
  const advancedProxyKeys: Array<keyof ProxyUpdateRequest & keyof ProxyConfig> = [
    'useMiddleProxy',
    'fastMode',
    'me2dcFallback',
    'me2dcFast',
    'meKeepaliveEnabled',
    'meKeepaliveIntervalSecs',
    'meKeepaliveJitterSecs',
    'meKeepalivePayloadRandom',
    'meReconnectBackoffBaseMs',
    'meReconnectBackoffCapMs',
    'meReconnectFastRetryCount',
    'desyncAllFull',
    'meWriterPickMode',
    'meWarmupStaggerEnabled',
    'meWarmupStepDelayMs',
    'meWarmupStepJitterMs',
    'beobachten',
    'beobachtenMinutes',
    'beobachtenFlushSecs',
    'beobachtenFile',
    'upstreamConnectRetryAttempts',
    'upstreamConnectRetryBackoffMs',
    'tgConnect',
    'rstOnClose',
    'logLevel',
    'unknownDcFileLogEnabled',
    'updateEvery',
    'networkPrefer',
    'stunServers',
    'serverClientMss',
    'censorshipTlsDomain',
    'censorshipTlsEmulation',
    'censorshipTlsFrontDir',
    'meInitRetryAttempts',
  ];
  for (const key of advancedProxyKeys) {
    if (req[key] !== undefined && req[key] !== proxy[key]) {
      updates[key] = req[key] as any;
      needsRestart = true;
    }
  }

  // Handle maskHost change
  if (req.maskHost !== undefined && req.maskHost !== proxy.maskHost) {
    updates.maskHost = req.maskHost;
    needsRestart = true;
  }

  // Handle natIp / tunnelInterface changes
  if (req.natIp !== undefined && req.natIp !== (proxy.natIp || '')) {
    updates.natIp = req.natIp || undefined;
    needsRestart = true;
  }
  if (req.tunnelInterface !== undefined) {
    updates.tunnelInterface = req.tunnelInterface || undefined;
  }

  // Handle VPN subscription change
  let newSocks5Host: string | undefined = proxy.vpnContainerName;
  if (req.vpnSubscription !== undefined && req.vpnSubscription !== proxy.vpnSubscription) {
    // Remove old xray container
    if (proxy.vpnContainerName) {
      await xrayService.removeXrayContainer(proxy.vpnContainerName);
      updates.vpnContainerName = undefined;
      newSocks5Host = undefined;
    }

    if (req.vpnSubscription) {
      const newVpnName = `${config.xrayContainerPrefix}${id}`;
      const vlessConfig = await xrayService.fetchAndParseSubscription(req.vpnSubscription);
      await xrayService.createXrayContainer(newVpnName, vlessConfig);
      updates.vpnContainerName = newVpnName;
      updates.vpnSubscription = req.vpnSubscription;
      newSocks5Host = newVpnName;
    } else {
      updates.vpnSubscription = '';
    }
    needsRestart = true;
  }

  if (needsRestart) {
    await dockerService.removeProxyContainer(proxy.containerName);
    const effectiveNatIp = updates.natIp !== undefined ? updates.natIp : (proxy.natIp || config.natIp || undefined);
    await dockerService.createProxyContainer(
      proxy.containerName,
      proxy.secret,
      updates.domain || proxy.domain,
      proxy.listenPort || config.nginxPort,
      updates.tag !== undefined ? updates.tag : proxy.tag,
      newSocks5Host,
      updates.maskHost !== undefined ? updates.maskHost : proxy.maskHost,
      effectiveNatIp,
      Object.assign({}, proxy, req)
    );
  }

  const updated = store.updateProxy(id, updates);
  await nginxService.updateNginxConfig(store.getAllProxies());
  return updated;
}

export async function restartProxy(id: string): Promise<ProxyConfig | undefined> {
  const proxy = store.getProxyById(id);
  if (!proxy) return undefined;

  // Удаляем старый контейнер если существует
  await dockerService.removeProxyContainer(proxy.containerName).catch(() => {});

  // Создаём контейнер заново (с VPN если настроен)
  await dockerService.createProxyContainer(
    proxy.containerName,
    proxy.secret,
    proxy.domain,
    proxy.listenPort || config.nginxPort,
    proxy.tag,
    proxy.vpnContainerName,
    proxy.maskHost,
    config.natIp || undefined,
    proxy
  );

  const updated = store.updateProxy(id, { status: 'running' });
  await nginxService.updateNginxConfig(store.getAllProxies());
  return updated;
}

export async function deleteProxy(id: string): Promise<boolean> {
  const proxy = store.getProxyById(id);
  if (!proxy) return false;

  await dockerService.removeProxyContainer(proxy.containerName);
  if (proxy.vpnContainerName) {
    await xrayService.removeXrayContainer(proxy.vpnContainerName);
  }
  if (proxy.type === 'web') {
    // Otherwise a later proxy on the same domain would inherit this certificate and
    // listCertifiedDomains would keep reporting a domain nothing serves.
    acmeService.removeCertificate(proxy.domain);
  }
  store.removeProxy(id);
  store.removeStatsHistory(id);
  store.removeIpHistory(id);
  await nginxService.updateNginxConfig(store.getAllProxies());
  return true;
}

export async function pauseProxy(id: string): Promise<ProxyConfig | undefined> {
  const proxy = store.getProxyById(id);
  if (!proxy) return undefined;

  await dockerService.pauseContainer(proxy.containerName);
  return store.updateProxy(id, { status: 'paused' });
}

export async function unpauseProxy(id: string): Promise<ProxyConfig | undefined> {
  const proxy = store.getProxyById(id);
  if (!proxy) return undefined;

  await dockerService.unpauseContainer(proxy.containerName);
  return store.updateProxy(id, { status: 'running' });
}

export async function getProxyStats(id: string): Promise<ProxyStats | null> {
  const proxy = store.getProxyById(id);
  if (!proxy) return null;

  try {
    const status = await dockerService.getContainerStatus(proxy.containerName);
    if (status !== 'running') {
      return {
        id: proxy.id,
        containerName: proxy.containerName,
        status,
        cpuPercent: '0%',
        memoryUsage: '0 B',
        memoryLimit: '0 B',
        networkRx: '0 B',
        networkTx: '0 B',
        networkRxBytes: 0,
        networkTxBytes: 0,
        uptime: '0h 0m',
        connectedIps: [] as ConnectedIpInfo[],
      };
    }

    const stats = await dockerService.getContainerStats(proxy.containerName);
    const uptime = await dockerService.getContainerUptime(proxy.containerName);
    const connectedIps = await nginxService.getNginxConnectedIps(proxy.domain);

    // Update stored traffic and IPs
    store.updateProxy(id, {
      trafficUp: stats.networkTxBytes,
      trafficDown: stats.networkRxBytes,
      connectedIps: connectedIps.map((c) => c.ip),
    });

    // Save stats snapshot (throttled to 5-min intervals in store)
    const cpuNum = parseFloat(stats.cpuPercent.replace('%', '')) || 0;
    const memMatch = stats.memoryUsage.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
    let memBytes = 0;
    if (memMatch) {
      const val = parseFloat(memMatch[1]);
      const unit = memMatch[2].toUpperCase();
      memBytes = unit === 'GB' ? val * 1073741824 : unit === 'MB' ? val * 1048576 : unit === 'KB' ? val * 1024 : val;
    }
    store.addStatsSnapshot(id, {
      timestamp: new Date().toISOString(),
      cpuPercent: cpuNum,
      memoryBytes: memBytes,
      networkRxBytes: stats.networkRxBytes,
      networkTxBytes: stats.networkTxBytes,
      connectedCount: connectedIps.length,
    });

    // Update IP history
    if (connectedIps.length > 0) {
      store.updateIpHistory(id, connectedIps);
    }

    return {
      id: proxy.id,
      containerName: proxy.containerName,
      status,
      ...stats,
      uptime,
      connectedIps,
    };
  } catch {
    return {
      id: proxy.id,
      containerName: proxy.containerName,
      status: 'error',
      cpuPercent: '0%',
      memoryUsage: '0 B',
      memoryLimit: '0 B',
      networkRx: '0 B',
      networkTx: '0 B',
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptime: 'unknown',
      connectedIps: [] as ConnectedIpInfo[],
    };
  }
}

export function getProxyLink(id: string, serverIp: string): string | null {
  const proxy = store.getProxyById(id);
  if (!proxy) return null;

  if (proxy.type === 'web') {
    // Telegram Desktop ignores any port in a WEB link and always connects on 443, so
    // the host is the proxy's own domain rather than the node address passed in.
    // The secret is the plain 16-byte value, or dd-prefixed; ee (fake TLS) is not
    // supported by WEB mode.
    const secret = proxy.webSecretMode === 'dd' ? `dd${proxy.secret}` : proxy.secret;
    return `https://t.me/webproxy?server=${encodeURIComponent(proxy.domain)}&secret=${secret}`;
  }

  const fullSecret = buildFullSecret(proxy.secret, proxy.domain);
  const port = proxy.listenPort || config.nginxPort;
  return `tg://proxy?server=${encodeURIComponent(serverIp)}&port=${port}&secret=${fullSecret}`;
}

/** Re-attempt certificate issuance for a WEB proxy after the operator fixes DNS. */
export async function renewProxyCertificate(id: string): Promise<ProxyConfig | undefined> {
  const proxy = store.getProxyById(id);
  if (!proxy) return undefined;
  if (proxy.type !== 'web') throw new Error('Сертификат нужен только WEB-прокси');

  await acmeService.ensureCertificate(proxy);
  await nginxService.updateNginxConfig(store.getAllProxies());
  return store.getProxyById(id);
}

export function getProxyStatsHistory(id: string): StatsSnapshot[] {
  return store.getStatsHistory(id);
}

export function getProxyIpHistory(id: string): IpHistoryEntry[] {
  return store.getIpHistory(id);
}

export function clearProxyHistory(id: string): boolean {
  const proxy = store.getProxyById(id);
  if (!proxy) return false;
  store.removeStatsHistory(id);
  store.removeIpHistory(id);
  return true;
}

export interface ExportedProxy {
  name: string;
  note: string;
  secret: string;
  domain: string;
  port: number;
  /** Absent in bundles exported before WEB support — imported as 'faketls'. */
  type?: ProxyType;
  listenPort?: number;
  tag?: string;
  maxConnections?: number;
  vpnSubscription?: string;
  maskHost?: string;
  natIp?: string;
  tunnelInterface?: string;
  useMiddleProxy?: boolean;
  fastMode?: boolean;
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
  meInitRetryAttempts?: number;
}

export interface ExportBundle {
  version: number;
  exportedAt: string;
  proxies: ExportedProxy[];
}

export function exportProxies(): ExportBundle {
  const proxies = store.getAllProxies();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    proxies: proxies.map((p) => ({
      name: p.name,
      note: p.note,
      secret: p.secret,
      domain: p.domain,
      port: p.port,
      type: p.type,
      listenPort: p.listenPort,
      tag: p.tag,
      maxConnections: p.maxConnections,
      vpnSubscription: p.vpnSubscription,
      maskHost: p.maskHost,
      natIp: p.natIp,
      tunnelInterface: p.tunnelInterface,
      useMiddleProxy: p.useMiddleProxy,
      fastMode: p.fastMode,
      me2dcFallback: p.me2dcFallback,
      me2dcFast: p.me2dcFast,
      meKeepaliveEnabled: p.meKeepaliveEnabled,
      meKeepaliveIntervalSecs: p.meKeepaliveIntervalSecs,
      meKeepaliveJitterSecs: p.meKeepaliveJitterSecs,
      meKeepalivePayloadRandom: p.meKeepalivePayloadRandom,
      meReconnectBackoffBaseMs: p.meReconnectBackoffBaseMs,
      meReconnectBackoffCapMs: p.meReconnectBackoffCapMs,
      meReconnectFastRetryCount: p.meReconnectFastRetryCount,
      desyncAllFull: p.desyncAllFull,
      meWriterPickMode: p.meWriterPickMode,
      meWarmupStaggerEnabled: p.meWarmupStaggerEnabled,
      meWarmupStepDelayMs: p.meWarmupStepDelayMs,
      meWarmupStepJitterMs: p.meWarmupStepJitterMs,
      beobachten: p.beobachten,
      beobachtenMinutes: p.beobachtenMinutes,
      beobachtenFlushSecs: p.beobachtenFlushSecs,
      beobachtenFile: p.beobachtenFile,
      upstreamConnectRetryAttempts: p.upstreamConnectRetryAttempts,
      upstreamConnectRetryBackoffMs: p.upstreamConnectRetryBackoffMs,
      tgConnect: p.tgConnect,
      rstOnClose: p.rstOnClose,
      logLevel: p.logLevel,
      unknownDcFileLogEnabled: p.unknownDcFileLogEnabled,
      updateEvery: p.updateEvery,
      networkPrefer: p.networkPrefer,
      stunServers: p.stunServers,
      serverClientMss: p.serverClientMss,
      censorshipTlsDomain: p.censorshipTlsDomain,
      censorshipTlsEmulation: p.censorshipTlsEmulation,
      censorshipTlsFrontDir: p.censorshipTlsFrontDir,
      meInitRetryAttempts: p.meInitRetryAttempts,
    })),
  };
}

export async function importProxies(bundle: ExportBundle): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;

  for (const p of bundle.proxies) {
    try {
        await createProxy({
        secret: p.secret,
        domain: p.domain,
        name: p.name,
        note: p.note,
        listenPort: p.listenPort,
        tag: p.tag,
        maxConnections: p.maxConnections,
        vpnSubscription: p.vpnSubscription,
        maskHost: p.maskHost,
        natIp: p.natIp,
        tunnelInterface: p.tunnelInterface,
        useMiddleProxy: p.useMiddleProxy,
        fastMode: p.fastMode,
        me2dcFallback: p.me2dcFallback,
        me2dcFast: p.me2dcFast,
        meKeepaliveEnabled: p.meKeepaliveEnabled,
        meKeepaliveIntervalSecs: p.meKeepaliveIntervalSecs,
        meKeepaliveJitterSecs: p.meKeepaliveJitterSecs,
        meKeepalivePayloadRandom: p.meKeepalivePayloadRandom,
        meReconnectBackoffBaseMs: p.meReconnectBackoffBaseMs,
        meReconnectBackoffCapMs: p.meReconnectBackoffCapMs,
        meReconnectFastRetryCount: p.meReconnectFastRetryCount,
        desyncAllFull: p.desyncAllFull,
        meWriterPickMode: p.meWriterPickMode,
        meWarmupStaggerEnabled: p.meWarmupStaggerEnabled,
        meWarmupStepDelayMs: p.meWarmupStepDelayMs,
        meWarmupStepJitterMs: p.meWarmupStepJitterMs,
        beobachten: p.beobachten,
        beobachtenMinutes: p.beobachtenMinutes,
        beobachtenFlushSecs: p.beobachtenFlushSecs,
        beobachtenFile: p.beobachtenFile,
        upstreamConnectRetryAttempts: p.upstreamConnectRetryAttempts,
        upstreamConnectRetryBackoffMs: p.upstreamConnectRetryBackoffMs,
        tgConnect: p.tgConnect,
        rstOnClose: p.rstOnClose,
        logLevel: p.logLevel,
        unknownDcFileLogEnabled: p.unknownDcFileLogEnabled,
        updateEvery: p.updateEvery,
        networkPrefer: p.networkPrefer,
        stunServers: p.stunServers,
        serverClientMss: p.serverClientMss,
        censorshipTlsDomain: p.censorshipTlsDomain,
        censorshipTlsEmulation: p.censorshipTlsEmulation,
        censorshipTlsFrontDir: p.censorshipTlsFrontDir,
        meInitRetryAttempts: p.meInitRetryAttempts,
      });
      imported++;
    } catch (err: any) {
      errors.push(`${p.name || p.secret}: ${err.message}`);
    }
  }

  return { imported, errors };
}

// Background collector: gather stats + IPs for ALL running proxies
export async function collectAllProxyStats(): Promise<void> {
  const proxies = store.getAllProxies();
  for (const proxy of proxies) {
    try {
      await getProxyStats(proxy.id);
    } catch {
      // skip failed proxies silently
    }
  }
}
