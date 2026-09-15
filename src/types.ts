export interface ConnectedIpInfo {
  ip: string;
  country?: string;
  countryCode?: string;
}

/**
 * 'faketls' — MTProxy over fake TLS, routed by SNI through the nginx stream block.
 * 'web'     — Telegram WEB proxy (telemt >= 3.5.1): HTTPS carrier terminated by nginx
 *             and forwarded as plain HTTP/1.1 to a private telemt WEB listener.
 * Absent in stored records predating WEB support — normalized to 'faketls' on read.
 */
export type ProxyType = 'faketls' | 'web';

export type WebCarrier = 'https' | 'https-lanes';

/** Telegram Desktop secret representation. 'ee' (fake TLS) is not supported by WEB mode. */
export type WebSecretMode = 'plain' | 'dd';

export type CertStatus = 'pending' | 'active' | 'error';

/** Fields that only apply when type === 'web'. */
export interface WebProxyFields {
  acmeEmail?: string;
  /** Per-proxy override for the node-wide CF_API_TOKEN. Never returned to clients. */
  acmeDnsToken?: string;
  webCarrier?: WebCarrier;
  webSecretMode?: WebSecretMode;
}

/** Resolved at creation and reused on update: telemt bakes it into public_addr. */
export interface WebRuntimeFields {
  webPublicIp?: string;
}

export interface ProxyConfig extends WebProxyFields, WebRuntimeFields {
  id: string;
  name: string;
  note: string;
  port: number;
  secret: string;
  /**
   * SNI this proxy answers to. For 'faketls' — a domain from the fake TLS pool;
   * for 'web' — the operator's own domain with a real certificate.
   */
  domain: string;
  type: ProxyType;
  /**
   * Port telemt listens on inside its container, fixed when the container was created.
   * nginx must target this rather than the current NGINX_PORT: changing NGINX_PORT
   * later would otherwise point the upstream at a port nothing is listening on, and
   * every existing fake TLS proxy on the node would silently stop answering.
   * Absent on records created before this field existed.
   */
  containerPort?: number;
  certStatus?: CertStatus;
  certExpiresAt?: string;
  certLastError?: string;
  containerName: string;
  status: 'running' | 'stopped' | 'paused' | 'error';
  /** telemt version inside the running container. Filled on read, never stored. */
  telemtVersion?: string | null;
  /** The container runs a different telemt than the node builds — recreate it to update. */
  telemtOutdated?: boolean;
  createdAt: string;
  tag?: string;
  trafficUp: number;
  trafficDown: number;
  connectedIps: string[];
  maxConnections?: number;
  nginxPort?: number;        // effective nginx listen port (config.nginxPort)
  listenPort?: number;       // if set and != 443, proxy gets its own TCP port
  vpnSubscription?: string;  // VLESS subscription URL
  vpnContainerName?: string; // xray container name when VPN is active
  maskHost?: string;         // self-steal fallback host:port (non-MTProto traffic redirect)
  natIp?: string;            // tunnel exit node public IP (overrides node-level NAT_IP)
  tunnelInterface?: string;  // tunnel interface name, e.g. tun0 (for reference/future automation)
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
  meWriterPickMode?: 'sorted_rr' | 'p2c' | string;
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

export interface ProxyCreateRequest extends WebProxyFields {
  type?: ProxyType;
  /** Public IP the panel knows for this node; checked against the domain's A record. */
  nodeIp?: string;
  port?: number;
  secret?: string;
  domain?: string;
  tag?: string;
  name?: string;
  note?: string;
  maxConnections?: number;
  listenPort?: number;
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
  meWriterPickMode?: 'sorted_rr' | 'p2c' | string;
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

export interface ProxyUpdateRequest extends WebProxyFields {
  nodeIp?: string;
  domain?: string;
  tag?: string;
  name?: string;
  note?: string;
  maxConnections?: number;
  listenPort?: number;
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
  meWriterPickMode?: 'sorted_rr' | 'p2c' | string;
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
  censorshipTlsEmulation?: string;
  censorshipTlsFrontDir?: string;
  meInitRetryAttempts?: number;
}

export interface ProxyStats {
  id: string;
  containerName: string;
  status: string;
  cpuPercent: string;
  memoryUsage: string;
  memoryLimit: string;
  networkRx: string;
  networkTx: string;
  networkRxBytes: number;
  networkTxBytes: number;
  uptime: string;
  connectedIps: ConnectedIpInfo[];
}

export interface StoreData {
  proxies: ProxyConfig[];
  customDomains?: string[];
  blacklistedIps?: string[];
}

export interface StatsSnapshot {
  timestamp: string;
  cpuPercent: number;
  memoryBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  connectedCount: number;
}

export interface IpHistoryEntry {
  ip: string;
  country?: string;
  countryCode?: string;
  firstSeen: string;
  lastSeen: string;
}

export interface StatsHistoryData {
  [proxyId: string]: StatsSnapshot[];
}

export interface IpHistoryData {
  [proxyId: string]: IpHistoryEntry[];
}
