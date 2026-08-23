#!/usr/bin/env node
/**
 * Regression guard for the nginx config generator.
 *
 * The hard requirement of the WEB feature is that proxies already running in
 * production keep working untouched. The strongest way to state that is byte identity:
 * with no WEB proxies present, generateNginxConfig must produce exactly what master
 * produced. The fixture was captured from master (f8d3b14) — regenerate it only when
 * a change to the fake TLS path is genuinely intended.
 *
 * Run: npm run check:nginx   (requires npm run build first)
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nginx-check-'));
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'fixtures/nginx-faketls-master.json'), 'utf-8')
);

// The generator reads the IP blacklist from the store, so reproduce the exact state the
// fixture was captured with.
fs.writeFileSync(
  path.join(DATA_DIR, 'store.json'),
  JSON.stringify({ proxies: [], blacklistedIps: fixture.blacklistedIps })
);
process.env.DATA_DIR = DATA_DIR;
process.env.NGINX_PORT = '443';
delete process.env.WEB_BIND_IP;

const { SCENARIOS, ipMap, P } = require('./nginx-scenarios');
const { generateNginxConfig } = require(path.resolve(__dirname, '../dist/services/nginx'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

function firstDiff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return `строка ${i + 1}\n       master: ${JSON.stringify(al[i])}\n       наш:    ${JSON.stringify(bl[i])}`;
    }
  }
  return 'длина различается';
}

console.log('\nПобайтовая идентичность fake TLS с master:');
for (const [name, proxies] of Object.entries(SCENARIOS)) {
  const expected = fixture.cases[name];
  const gotWith = generateNginxConfig(proxies, ipMap);
  const gotWithout = generateNginxConfig(proxies, new Map());
  check(`${name} (с ipMap)`, gotWith === expected.withIpMap, firstDiff(expected.withIpMap, gotWith));
  check(`${name} (без ipMap)`, gotWithout === expected.withoutIpMap, firstDiff(expected.withoutIpMap, gotWithout));
}

console.log('\nWEB-vhost появляется только когда должен:');
const webProxy = P({ id: 'w1', domain: 'proxy.example.com', type: 'web' });
const mixed = [...SCENARIOS.sniOnly, webProxy];
const webIpMap = new Map([...ipMap, ['mtproto-proxy-w1', '172.18.0.21']]);

const noCert = generateNginxConfig(mixed, webIpMap, { certifiedDomains: new Set() });
check(
  'без сертификата vhost не публикуется',
  !noCert.includes('proxy.example.com'),
  'домен без сертификата попал в конфиг — nginx отверг бы его целиком и уронил faketls'
);
check('без сертификата вывод равен faketls-эталону', noCert === fixture.cases.sniOnly.withIpMap);

const certified = { certifiedDomains: new Set(['proxy.example.com']) };
const withCert = generateNginxConfig(mixed, webIpMap, certified);
check('с сертификатом появляется server-блок', withCert.includes('server_name proxy.example.com;'));
check('ссылается на сертификат', withCert.includes('/etc/nginx/certs/proxy.example.com/fullchain.pem'));
check('проксирует на WEB-порт telemt', withCert.includes('proxy_pass http://172.18.0.21:18080;'));
check('весь vhost целиком, без сплита путей', !/location\s+[^{\s]*\/api\/v1/.test(withCert));
check('access_log отключён', withCert.includes('access_log off;'));
check('таймауты выше long_poll (25s)', withCert.includes('proxy_read_timeout 35s;'));
check('client_max_body_size >= max_body_bytes', withCert.includes('client_max_body_size 2m;'));
check('WEB-домен не попал в faketls-бэкенды', !withCert.includes('proxy.example.com 172.18.0.21:443'));

console.log('\nРежим 1: маршрут через stream по SNI');
check('есть запись в SNI-map на loopback L7', withCert.includes('proxy.example.com 127.0.0.1:8089;'));
check('L7 слушает loopback', withCert.includes('listen 127.0.0.1:8089 ssl'));

console.log('\nРежим 2: отдельный публичный IP, stream не задействован');
process.env.WEB_BIND_IP = '203.0.113.77';
process.env.NGINX_PORT = '8443';
for (const k of Object.keys(require.cache)) delete require.cache[k];
const mode2 = require(path.resolve(__dirname, '../dist/services/nginx')).generateNginxConfig(
  mixed,
  webIpMap,
  certified
);
check('L7 слушает выделенный IP на 443', mode2.includes('listen 203.0.113.77:443 ssl'));
check('в SNI-map WEB-домена нет', !/proxy\.example\.com 127\.0\.0\.1/.test(mode2));

console.log('\nСинтаксис http2');
check('современный: отдельная директива', withCert.includes('http2 on;'));
const legacy = generateNginxConfig(mixed, webIpMap, { ...certified, http2Directive: false });
check('legacy: параметр listen', legacy.includes('ssl http2;') && !legacy.includes('http2 on;'));

fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`${failures} проверок провалено`);
  process.exit(1);
}
console.log('Все проверки пройдены.');
