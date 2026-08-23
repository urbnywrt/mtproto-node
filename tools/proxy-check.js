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
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'faketls', listenPort: 8443,
  },
  {
    id: 'w1', name: 'web-plain', note: '', port: 10003, secret: SECRET,
    domain: 'proxy.example.com', containerName: 'c3', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'web', webSecretMode: 'plain',
  },
  {
    id: 'w2', name: 'web-dd', note: '', port: 10004, secret: SECRET,
    domain: 'web2.example.net', containerName: 'c4', status: 'running', createdAt: 'x',
    trafficUp: 0, trafficDown: 0, connectedIps: [], type: 'web', webSecretMode: 'dd',
  },
];
fs.writeFileSync(path.join(DATA_DIR, 'store.json'), JSON.stringify({ proxies }));

const { getProxyLink } = require(path.resolve(__dirname, '../dist/services/proxy'));
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

fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`${failures} проверок провалено`);
  process.exit(1);
}
console.log('Все проверки пройдены.');
