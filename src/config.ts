import path from 'path';

const DEFAULT_TELEMT_VERSION = '3.5.2';

/**
 * Pinned explicitly instead of "latest".
 *
 * "latest" never actually updated anything here: ensureProxyImage rebuilds only when
 * the Dockerfile text hash changes, and a Dockerfile containing the literal string
 * "releases/latest/download" is constant — so the version was resolved once, on the
 * node's very first image build, and frozen forever. Different nodes silently ran
 * different unknown versions, and a node built before 3.5.0 could never pick up WEB
 * support at all.
 *
 * With an explicit version the opposite is true: changing it changes the hash, which
 * is what makes an upgrade actually propagate.
 *
 * TELEMT_VERSION overrides it per node, so a new release can be rolled out to one node
 * and verified before the default is bumped for everyone.
 */
export const TELEMT_VERSION = resolveTelemtVersion();

function resolveTelemtVersion(): string {
  const override = (process.env.TELEMT_VERSION || '').trim();
  if (!override) return DEFAULT_TELEMT_VERSION;
  // The value is interpolated into a Dockerfile RUN line, so keep it to a bare version.
  if (!/^\d+\.\d+\.\d+$/.test(override)) {
    console.warn(
      `TELEMT_VERSION="${override}" не похоже на версию вида X.Y.Z, использую ${DEFAULT_TELEMT_VERSION}`
    );
    return DEFAULT_TELEMT_VERSION;
  }
  return override;
}

// Fixed port of the private WEB listener inside each telemt container. Every proxy
// container has its own network namespace, so a single constant cannot collide.
// Deliberately outside 10001-19999, which is used by proxy.port and limitPortMap.
export const TELEMT_WEB_PORT = 18080;

/** Where the generated decoy site is unpacked inside a WEB proxy container. */
export const TELEMT_SITE_DIR = '/var/lib/telemt/public';

/**
 * Loopback port where nginx terminates TLS for WEB vhosts in mode 1, reached from the
 * stream block by SNI. Not 8443: docker publishes the service node's own API there on
 * the host, and nginx runs with host networking.
 */
export const NGINX_WEB_L7_PORT = 8089;

export const config = {
  port: parseInt(process.env.PORT || '8443', 10),
  nginxPort: parseInt(process.env.NGINX_PORT || '443', 10),
  // Second public IP dedicated to WEB proxies, used when 443 on the main IP is taken
  // by another service (typically a remnawave/Xray node). Empty = WEB shares the main
  // nginx listener. See PLAN.md §3.
  webBindIp: process.env.WEB_BIND_IP || '',
  // Cloudflare API token (Zone:DNS:Edit) for ACME DNS-01. Can be overridden per proxy.
  cfApiToken: process.env.CF_API_TOKEN || '',
  // Let's Encrypt staging directory — no rate limits, untrusted certs. For testing only.
  acmeStaging: process.env.ACME_STAGING === '1',
  // Renew once fewer than this many days remain on the certificate.
  certRenewDays: parseInt(process.env.CERT_RENEW_DAYS || '30', 10),
  authToken: process.env.AUTH_TOKEN || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  dockerNetwork: 'mtproto-net',
  nginxContainerName: 'mtproto-nginx',
  proxyImageName: 'telemt-proxy-v4',
  proxyContainerPrefix: 'mtproto-proxy-',
  xrayContainerPrefix: 'mtproto-xray-',
  portRangeStart: 10001,
  portRangeEnd: 19999,
  // Tunnel mode defaults (can be overridden per proxy from the panel).
  // NAT_IP: public IP of the tunnel exit node (EU VPS).
  // TUNNEL_INTERFACE: TUN/TAP interface name, e.g. tun0.
  natIp: process.env.NAT_IP || '',
  tunnelInterface: process.env.TUNNEL_INTERFACE || '',
};

export const FAKE_TLS_DOMAINS = [
  // Google
  'www.google.com',
  'ajax.googleapis.com',
  'fonts.googleapis.com',
  'update.googleapis.com',
  'maps.googleapis.com',
  'play.google.com',
  'apis.google.com',
  'accounts.google.com',
  'ssl.gstatic.com',
  'fonts.gstatic.com',
  // Microsoft
  'www.microsoft.com',
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'outlook.office365.com',
  'cdn.office.net',
  'www.bing.com',
  'assets.msn.com',
  // Apple
  'www.apple.com',
  'support.apple.com',
  'developer.apple.com',
  // CDN / Infra
  'www.cloudflare.com',
  'cdnjs.cloudflare.com',
  'static.cloudflareinsights.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdn.akamai.com',
  'fastly.net',
  // Social / Media
  'static.xx.fbcdn.net',
  'www.reddit.com',
  'www.linkedin.com',
  // E-commerce / Services
  'www.amazon.com',
  'images-na.ssl-images-amazon.com',
  'www.ebay.com',
  'www.paypal.com',
  // Dev / Tech
  'www.github.com',
  'raw.githubusercontent.com',
  'stackoverflow.com',
  'cdn.stackoverflow.com',
  // Reference
  'www.wikipedia.org',
  'en.wikipedia.org',
  'upload.wikimedia.org',
  // News / Other
  'www.bbc.com',
  'www.reuters.com',
  'www.nytimes.com',
  'www.theguardian.com',
  'www.forbes.com',
];
