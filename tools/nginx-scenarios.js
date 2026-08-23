/** Shared fake TLS scenarios for the byte-identity fixture and its check. */
const P = (o) => Object.assign({
  id: o.id, name: 'n', note: '', port: 10000, secret: 'a'.repeat(32),
  containerName: 'mtproto-proxy-' + o.id, status: 'running', createdAt: 'x',
  trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'faketls',
}, o);

const SCENARIOS = {
  empty: [],
  sniOnly: [
    P({ id: 'a1', domain: 'www.google.com' }),
    P({ id: 'b2', domain: 'www.apple.com' }),
    P({ id: 'c3', domain: 'cdn.jsdelivr.net' }),
  ],
  connectionLimits: [
    P({ id: 'a1', domain: 'www.google.com', maxConnections: 20 }),
    P({ id: 'b2', domain: 'www.apple.com' }),
    P({ id: 'c3', domain: 'www.bing.com', maxConnections: 5 }),
  ],
  dedicatedPorts: [
    P({ id: 'a1', domain: 'www.google.com' }),
    P({ id: 'd4', domain: 'www.ebay.com', listenPort: 8443 }),
    P({ id: 'e5', domain: 'www.paypal.com', listenPort: 9443, maxConnections: 10 }),
  ],
  stoppedExcluded: [
    P({ id: 'a1', domain: 'www.google.com' }),
    P({ id: 'f6', domain: 'www.reddit.com', status: 'stopped' }),
  ],
};

const ipMap = new Map([
  ['mtproto-proxy-a1', '172.18.0.11'], ['mtproto-proxy-b2', '172.18.0.12'],
  ['mtproto-proxy-c3', '172.18.0.13'], ['mtproto-proxy-d4', '172.18.0.14'],
  ['mtproto-proxy-e5', '172.18.0.15'], ['mtproto-proxy-f6', '172.18.0.16'],
]);

module.exports = { P, SCENARIOS, ipMap };
