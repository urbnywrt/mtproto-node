import path from 'path';

// Pinned explicitly instead of "latest": the WEB carrier protocol is days old and
// breaking changes are likely. Bumping this string changes the Dockerfile hash and
// triggers an image rebuild (see ensureProxyImage).
export const TELEMT_VERSION = '3.5.2';

// Fixed port of the private WEB listener inside each telemt container. Every proxy
// container has its own network namespace, so a single constant cannot collide.
// Deliberately outside 10001-19999, which is used by proxy.port and limitPortMap.
export const TELEMT_WEB_PORT = 18080;

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
