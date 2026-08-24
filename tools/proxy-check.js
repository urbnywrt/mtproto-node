#!/usr/bin/env node
/**
 * Checks for link generation and WEB domain validation.
 *
 * The link format is normative (tproxy-server README): WEB clients ignore any port and
 * always connect on 443, and only plain/dd secrets are accepted — ee is a fake TLS
 * secret and is not valid for WEB. Getting this wrong produces a link that looks fine
 * and silently never connects, so it is worth pinning down.
 *
 * Run: npm run check:proxy   (requires npm run build first)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-check-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NGINX_PORT = '443';

const SECRET = '0123456789abcdef0123456789abcdef';
const proxies = [
  {
    id: 'ft1', name: 'faketls', note: '', port: 10001, secret: SECRET,
    domain: 'www.google.com', containerName: 'c1', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'faketls',
  },
  {
    id: 'ft2', name: 'faketls-port', note: '', port: 10002, secret: SECRET,
    domain: 'www.apple.com', containerName: 'c2', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'faketls', listenPort: 8443, natIp: '198.51.100.9',
  },
  {
    id: 'w1', name: 'web-plain', note: '', port: 10003, secret: SECRET,
    domain: 'proxy.example.com', containerName: 'c3', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'web', webSecretMode: 'plain', webPublicIp: '203.0.113.10',
  },
  {
    id: 'w2', name: 'web-dd', note: '', port: 10004, secret: SECRET,
    domain: 'web2.example.net', containerName: 'c4', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'web', webSecretMode: 'dd',
  },
  {
    // Created before webPublicIp was recorded — the case that broke on the first node.
    id: 'w3', name: 'web-legacy', note: '', port: 10005, secret: SECRET,
    domain: 'legacy.example.com', containerName: 'c5', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'web',
  },
  {
    id: 'w4', name: 'web-unresolvable', note: '', port: 10006, secret: SECRET,
    domain: 'gone.example.com', containerName: 'c6', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'web',
  },
];
fs.writeFileSync(path.join(DATA_DIR, 'store.json'), JSON.stringify({ proxies }));

// Container creation is stubbed out: these checks are about which generator a code path
// picks, which is exactly what cannot be seen from the outside once a container is
// running — a WEB proxy rebuilt as fake TLS looks alive and answers 502 to everything.
const calls = [];
let dnsAnswer = ['203.0.113.55'];
function stub(rel, exports) {
  const id = require.resolve(path.resolve(__dirname, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../dist/services/docker', {
  removeProxyContainer: async (name) => { calls.push({ kind: 'remove', name }); },
  createProxyContainer: async (...args) => { calls.push({ kind: 'faketls', args }); return 'id'; },
  createWebProxyContainer: async (opts) => { calls.push({ kind: 'web', opts }); return 'id'; },
});
stub('../dist/services/nginx', { updateNginxConfig: async () => {} });
stub('../dist/services/dns', { lookupA: async () => dnsAnswer, lookupTxt: async () => [] });
stub('../dist/services/acme', {
  ensureCertificate: async () => {},
  removeCertificate: () => {},
  listCertifiedDomains: () => [],
});
stub('../dist/services/xray', {
  removeXrayContainer: async () => {},
  createXrayContainer: async () => {},
  fetchAndParseSubscription: async () => ({}),
});

const { getProxyLink } = require(path.resolve(__dirname, '../dist/services/proxy'));
const proxyService = require(path.resolve(__dirname, '../dist/services/proxy'));
const { isValidWebDomain } = require(path.resolve(__dirname, '../dist/services/preflight'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('\nСсылки:');
const ftLink = getProxyLink('ft1', '203.0.113.10');
check('faketls формат не изменился', ftLink === `tg://proxy?server=203.0.113.10&port=443&secret=ee${SECRET}${Buffer.from('www.google.com').toString('hex')}`, ftLink);
check('faketls учитывает listenPort', getProxyLink('ft2', '203.0.113.10').includes('&port=8443&'));

const webPlain = getProxyLink('w1', '203.0.113.10');
const webDd = getProxyLink('w2', '203.0.113.10');
check('web использует t.me/webproxy', webPlain.startsWith('https://t.me/webproxy?'), webPlain);
check('web не использует tg://proxy', !webPlain.startsWith('tg://'));
check('web берёт хост из домена, а не из адреса ноды', webPlain.includes('server=proxy.example.com') && !webPlain.includes('203.0.113.10'));
check('в web-ссылке нет порта — клиент всегда идёт на 443', !/[?&]port=/.test(webPlain));
check('plain: ровно 32 hex', /&secret=[0-9a-f]{32}$/.test(webPlain), webPlain);
check('dd: префикс и 34 hex', /&secret=dd[0-9a-f]{32}$/.test(webDd), webDd);
check('в web-ссылке нет ee-секрета', !webPlain.includes('ee' + SECRET) && !webDd.includes('ee' + SECRET));

console.log('\nВалидация WEB-домена:');
const valid = ['proxy.example.com', 'a.b.c.example.org', 'xn--80ak6aa92e.com', 'my-proxy.example.co.uk'];
const invalid = [
  '', 'Proxy.Example.com', 'proxy.example.com.', 'proxy.example.com:443',
  'https://proxy.example.com', 'proxy example.com', 'localhost', 'example',
  '192.0.2.1', '-bad.example.com', 'proxy..example.com', 'proxy.example.com/path',
];
for (const d of valid) check(`валиден: ${d}`, isValidWebDomain(d) === true);
for (const d of invalid) check(`отвергнут: ${JSON.stringify(d)}`, isValidWebDomain(d) === false);

const built = () => calls.filter((c) => c.kind !== 'remove');

(async () => {
  console.log('\nПересборка контейнера выбирает генератор по типу:');

  calls.length = 0;
  await proxyService.restartProxy('w1');
  check('restart WEB-прокси идёт через WEB-генератор', built().length === 1 && built()[0].kind === 'web',
    JSON.stringify(calls.map((c) => c.kind)));
  check('restart WEB сохраняет домен и публичный IP',
    !!(built()[0] && built()[0].kind === 'web' && built()[0].opts.domain === 'proxy.example.com' && built()[0].opts.publicIp === '203.0.113.10'),
    JSON.stringify(built()[0] && built()[0].opts));
  check('restart WEB сохраняет seed сайта-прикрытия', !!(built()[0] && built()[0].opts && built()[0].opts.siteSeed === 'w1'));

  calls.length = 0;
  await proxyService.restartProxy('ft1');
  check('restart fake TLS идёт через прежний генератор', built().length === 1 && built()[0].kind === 'faketls',
    JSON.stringify(calls.map((c) => c.kind)));

  calls.length = 0;
  await proxyService.restartProxy('ft2');
  check('restart сохраняет NAT IP самого прокси', !!(built()[0] && built()[0].args && built()[0].args[7] === '198.51.100.9'),
    JSON.stringify(built()[0] && built()[0].args[7]));

  calls.length = 0;
  await proxyService.updateProxy('w1', { natIp: '198.51.100.7' });
  check('update WEB-прокси идёт через WEB-генератор', built().length === 1 && built()[0].kind === 'web',
    JSON.stringify(calls.map((c) => c.kind)));

  calls.length = 0;
  await proxyService.restartProxy('w3');
  check('WEB без webPublicIp берёт адрес из A-записи домена',
    !!(built()[0] && built()[0].opts && built()[0].opts.publicIp === '203.0.113.55'),
    JSON.stringify(built()[0] && built()[0].opts && built()[0].opts.publicIp));

  calls.length = 0;
  dnsAnswer = [];
  let threw = false;
  try { await proxyService.restartProxy('w4'); } catch (e) { threw = true; }
  dnsAnswer = ['203.0.113.55'];
  check('без публичного IP пересборка отказывает', threw);
  check('отказ не удаляет работающий контейнер', calls.length === 0,
    JSON.stringify(calls.map((c) => c.kind)));

  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} проверок провалено`);
    process.exit(1);
  }
  console.log('Все проверки пройдены.');
})();
