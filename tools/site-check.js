#!/usr/bin/env node
/**
 * Verification for the decoy site generator (see src/services/site-generator.ts).
 *
 * The point of the generator is that unrelated installations do not share an
 * active-probe fingerprint, so the checks here are about *divergence* between seeds
 * and about the hard constraints PUBLIC_SITE.md places on the decoy — not about
 * exact output, which is meant to change.
 *
 * Run: npm run check:site   (requires npm run build first)
 */
const path = require('path');
const { generateSite, assertWithinLimits } = require(path.resolve(__dirname, '../dist/services/site-generator'));

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Deliberately more seeds than layout variants: a generator that merely rotates a few
// whole skeletons passes at n=4 and fails here, which is the point.
const SEEDS = [
  'a1b2c3d4', 'deadbeef', '0f0f0f0f', '9c8b7a65', 'abcdef01', '11223344', 'feedface', '5a5a5a5a',
  '7e1c0de5', 'b00c1a55', 'c0ffee11', 'd15ea5e0', 'e1e2e3e4', 'f00dbabe', '1a2b3c4d', '2b3c4d5e',
];
const sites = SEEDS.map((seed) => ({ seed, files: generateSite(seed) }));

console.log('\nОграничения telemt [web.limits] и политика PUBLIC_SITE.md:');
for (const { seed, files } of sites) {
  const html = files.filter((f) => f.path.endsWith('.html'));
  const all = files.map((f) => f.content).join('\n');

  let limitsOk = true;
  try {
    assertWithinLimits(files);
  } catch (err) {
    limitsOk = false;
    console.log(`       ${err.message}`);
  }

  check(`${seed}: в пределах лимитов`, limitsOk);
  check(`${seed}: 3-5 html-страниц (без 404)`, html.length - 1 >= 3 && html.length - 1 <= 5, `${html.length - 1}`);
  check(`${seed}: есть index.html`, files.some((f) => f.path === 'index.html'));
  check(`${seed}: есть 404.html`, files.some((f) => f.path === '404.html'));
  check(`${seed}: есть внешний css`, files.some((f) => f.path.endsWith('.css')));
  check(`${seed}: есть svg-фавикон`, files.some((f) => f.path.endsWith('.svg')));
  check(`${seed}: нет inline <style>`, !/<style[\s>]/i.test(all));
  check(`${seed}: нет <script>`, !/<script[\s>]/i.test(all));
  check(`${seed}: нет style="..."`, !/\sstyle\s*=/i.test(all));
  check(`${seed}: нет форм`, !/<form[\s>]/i.test(all));
  check(`${seed}: нет фреймов`, !/<(iframe|frame|object|embed)[\s>]/i.test(all));
  check(`${seed}: нет внешних ресурсов`, !/(src|href)\s*=\s*["'](https?:)?\/\//i.test(all));
  check(
    `${seed}: не занимает зарезервированные пути`,
    !files.some((f) => f.path === 'api/v1/session' || f.path.startsWith('api/v1/'))
  );

  // <p> accepts only phrasing content. Putting flow content inside it makes the parser
  // implicitly close the paragraph, so the DOM a probe sees differs from the markup we
  // emit — an avoidable oddity on a page whose whole job is to look unremarkable.
  const badNesting = html
    .map((f) => {
      const offenders = [...f.content.matchAll(/<p>([\s\S]*?)<\/p>/g)]
        .filter(([, inner]) => /<(address|div|ul|ol|figure|section|article|h[1-6]|p)[\s>]/i.test(inner))
        .map(([block]) => block);
      return offenders.length ? `${f.path}: ${offenders[0].slice(0, 70)}` : null;
    })
    .filter(Boolean);
  check(`${seed}: нет flow-контента внутри <p>`, badNesting.length === 0, badNesting[0]);
}

console.log('\nРасхождение между установками (главное свойство генератора):');

function structure(files) {
  // Tag sequence of index.html — a coarse stand-in for what an active probe compares.
  const index = files.find((f) => f.path === 'index.html').content;
  return (index.match(/<([a-z0-9]+)[\s>]/gi) || []).join('');
}

/**
 * Demanding zero collisions on a small sample would be testing for the absence of a
 * birthday collision, which passes or fails on seed luck. What actually matters is
 * that the space is large and no single value dominates it, so measure that instead.
 */
const SAMPLE = 400;
const sample = [];
for (let i = 0; i < SAMPLE; i++) sample.push(generateSite(`probe-seed-${i}`));

function diversity(label, project, minRatio, maxSharePct) {
  const counts = new Map();
  for (const files of sample) {
    const key = project(files);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const unique = counts.size;
  const ratio = unique / SAMPLE;
  const topShare = (Math.max(...counts.values()) / SAMPLE) * 100;
  check(
    `${label}: ${unique} различных на ${SAMPLE} (доля уникальных ${(ratio * 100).toFixed(1)}%, самый частый ${topShare.toFixed(1)}%)`,
    ratio >= minRatio && topShare <= maxSharePct,
    `порог: уникальных >= ${(minRatio * 100).toFixed(0)}%, самый частый <= ${maxSharePct}%`
  );
}

diversity('структура DOM', structure, 0.9, 2);
diversity('css', (f) => f.find((x) => x.path.endsWith('.css')).content, 0.9, 2);
diversity('название', (f) => /<title>([^<]*)<\/title>/.exec(f.find((x) => x.path === 'index.html').content)[1], 0.88, 2);
diversity('набор файлов', (f) => f.map((x) => x.path).sort().join(','), 0.5, 10);

const cssNames = new Set(sample.map((f) => f.find((x) => x.path.endsWith('.css')).path));
check(`имя файла стилей не фиксировано (${cssNames.size} вариантов)`, cssNames.size >= 2);

console.log('\nДетерминированность:');
const twice = generateSite('repeatable-seed');
const again = generateSite('repeatable-seed');
check('один seed — байт-в-байт тот же сайт', JSON.stringify(twice) === JSON.stringify(again));

console.log('');
if (failures > 0) {
  console.error(`${failures} проверок провалено`);
  process.exit(1);
}
console.log('Все проверки пройдены.');
