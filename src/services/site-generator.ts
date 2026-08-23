/**
 * Generator for the decoy site served by a WEB proxy's telemt vhost.
 *
 * PUBLIC_SITE.md is explicit that no shared starter site may be used: identical bodies
 * across unrelated relay hosts are trivially recognised by an active probe, and
 * "merely changing a title or color in a widely reused template leaves most of the
 * active-probe fingerprint shared". So the variation here is structural — different
 * page sets, different DOM shapes, different CSS systems, different class-naming
 * conventions and asset names — not a palette swap over one skeleton.
 *
 * Constraints enforced by construction (see PUBLIC_SITE.md and telemt's decoy policy):
 * external stylesheet only, no inline <style> or <script>, no remote resources,
 * no forms, no frames, no workers, no client-side router.
 *
 * Output is deterministic in `seed` so that regenerating a proxy's site does not
 * silently change its fingerprint.
 */

export interface SiteFile {
  path: string;
  content: string;
}

// --- deterministic RNG ------------------------------------------------------

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface Rng {
  next(): number;
  pick<T>(items: readonly T[]): T;
  sample<T>(items: readonly T[], count: number): T[];
  int(min: number, max: number): number;
  bool(probability?: number): boolean;
}

function createRng(seed: string): Rng {
  let state = hashSeed(seed);

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)],
    sample: <T>(items: readonly T[], count: number) => {
      const pool = [...items];
      const out: T[] = [];
      while (out.length < count && pool.length > 0) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      }
      return out;
    },
    bool: (probability = 0.5) => next() < probability,
  };
}

// --- content banks ----------------------------------------------------------

interface Archetype {
  kind: string;
  names: readonly string[];
  taglines: readonly string[];
  sentences: readonly string[];
  sections: readonly string[];
  extraPages: readonly { slug: string; title: string }[];
}

const ARCHETYPES: readonly Archetype[] = [
  {
    kind: 'ceramics',
    names: ['Kiln & Clay', 'Northfield Pottery', 'Slow Wheel Studio', 'Ashgrove Ceramics', 'Two Hands Pottery'],
    taglines: ['Hand-thrown stoneware, fired in small batches', 'A working pottery studio and teaching space', 'Functional pots for everyday tables'],
    sentences: [
      'Every piece is thrown on the wheel and trimmed by hand, so no two are quite alike.',
      'We fire a gas reduction kiln roughly once a month, weather permitting.',
      'Our glazes are mixed in the studio from raw materials, without commercial premixes.',
      'Studio seconds are set aside and sold at a discount during the open weekends.',
      'Classes run in six-week blocks and are capped at eight people per bench.',
      'The clay body we use most is a mid-fire stoneware with a little grog for texture.',
      'Wholesale enquiries are handled through the studio directly rather than a rep.',
    ],
    sections: ['In the studio', 'Current work', 'Firing schedule', 'Visiting', 'Classes'],
    extraPages: [
      { slug: 'studio', title: 'The studio' },
      { slug: 'classes', title: 'Classes' },
      { slug: 'stockists', title: 'Stockists' },
    ],
  },
  {
    kind: 'bakery',
    names: ['Millstone Bakehouse', 'Copper Lane Bakery', 'The Long Proof', 'Harrow Street Bread', 'Field & Grain'],
    taglines: ['Naturally leavened bread, baked daily', 'A neighbourhood bakery and small mill', 'Slow ferments, simple ingredients'],
    sentences: [
      'The starter has been kept alive since the bakery opened and is refreshed twice a day.',
      'We mill part of our flour on site, which changes the crumb more than people expect.',
      'Loaves come out of the deck oven from six in the morning until they run out.',
      'Saturday is the only day we bake the rye, and it usually goes before noon.',
      'Everything is mixed the afternoon before and retarded overnight in the cold room.',
      'We keep the menu short on purpose so that nothing sits around.',
      'Bulk orders for cafés and restaurants need two days of notice.',
    ],
    sections: ['What we bake', 'Opening hours', 'The mill', 'Wholesale', 'Where to find us'],
    extraPages: [
      { slug: 'bread', title: 'Bread' },
      { slug: 'hours', title: 'Hours' },
      { slug: 'wholesale', title: 'Wholesale' },
    ],
  },
  {
    kind: 'surveying',
    names: ['Hallward Land Surveys', 'Meridian Survey Group', 'Blackwood Geomatics', 'Trent Valley Surveys', 'Pike & Associates'],
    taglines: ['Boundary and topographic surveying since 1998', 'Land surveying for builders, architects and owners', 'Measured surveys and setting out'],
    sentences: [
      'We work mostly on residential subdivisions, boundary retracements and topographic detail.',
      'Field crews run GNSS and total stations, with drone photogrammetry where the site suits it.',
      'Deliverables come as DWG and PDF, with point clouds supplied on request.',
      'Turnaround for a standard boundary survey is usually two to three weeks from instruction.',
      'We are happy to attend site meetings before quoting on anything unusual.',
      'Historic title research is handled in house rather than subcontracted.',
      'Our licences cover the whole of the county and the two neighbouring districts.',
    ],
    sections: ['Services', 'How we work', 'Deliverables', 'Coverage', 'Recent projects'],
    extraPages: [
      { slug: 'services', title: 'Services' },
      { slug: 'projects', title: 'Projects' },
      { slug: 'contact', title: 'Contact' },
    ],
  },
  {
    kind: 'bikeshop',
    names: ['Cogset Cycles', 'Fairweather Bicycle Works', 'The Spoke Room', 'Ridgeway Bikes', 'Hollow Crank Workshop'],
    taglines: ['Repairs, builds and honest advice', 'A small workshop for everyday bicycles', 'Servicing, wheelbuilding and restoration'],
    sentences: [
      'The workshop takes walk-in repairs in the morning and booked servicing in the afternoon.',
      'Wheels are built by hand and tensioned properly rather than run out of the jig hot.',
      'We keep a decent stock of older standards, so bring the odd bottom bracket in.',
      'Restorations are quoted per job because nothing about them is ever standard.',
      'A basic service covers gears, brakes, bearings and a full safety check.',
      'We do not sell new bikes; we would rather keep the ones already out there running.',
      'Loan bikes are available while yours is in for anything longer than a day.',
    ],
    sections: ['Workshop', 'Servicing', 'Wheelbuilding', 'Opening times', 'Getting here'],
    extraPages: [
      { slug: 'servicing', title: 'Servicing' },
      { slug: 'workshop', title: 'Workshop' },
      { slug: 'visit', title: 'Visit' },
    ],
  },
  {
    kind: 'archive',
    names: ['Westgate Local Archive', 'The Ferry Road Collection', 'Ashby Historical Trust', 'Old Harbour Records', 'Cranmere Local History'],
    taglines: ['Documenting the parish since 1873', 'A volunteer-run local history collection', 'Photographs, maps and parish records'],
    sentences: [
      'The collection holds around fourteen thousand photographs, most of them uncatalogued.',
      'Volunteers meet on Tuesday mornings to scan, describe and rehouse material.',
      'Reading room access is by appointment because the room only seats four.',
      'Copies of parish registers are available on microfilm for the years before 1900.',
      'We accept donations of local material but cannot take general household papers.',
      'The map series is the most consulted part of the collection by a wide margin.',
      'Digitised items are added to the online index in batches as they are described.',
    ],
    sections: ['The collection', 'Visiting the reading room', 'Volunteering', 'Donations', 'Index'],
    extraPages: [
      { slug: 'collection', title: 'Collection' },
      { slug: 'visiting', title: 'Visiting' },
      { slug: 'volunteer', title: 'Volunteering' },
    ],
  },
  {
    kind: 'translation',
    names: ['Verbatim Language Services', 'Halden Translation', 'Two Rivers Localisation', 'Sarto & Kelly Translators', 'Northline Language Office'],
    taglines: ['Technical and legal translation', 'Certified translation and interpreting', 'Documents, contracts and technical manuals'],
    sentences: [
      'We work between eleven language pairs, with sworn translators for six of them.',
      'Legal and patent work is reviewed by a second translator before delivery.',
      'Certified copies are issued on headed paper with a stamped statement of accuracy.',
      'Rates are quoted per source word, with a minimum charge for very short documents.',
      'Urgent work is possible but we would rather be honest about what is realistic.',
      'Glossaries and translation memories stay with the client and are handed over on request.',
      'Interpreting is arranged for hearings, notary appointments and site inspections.',
    ],
    sections: ['Services', 'Languages', 'Certification', 'Rates', 'Working with us'],
    extraPages: [
      { slug: 'services', title: 'Services' },
      { slug: 'languages', title: 'Languages' },
      { slug: 'rates', title: 'Rates' },
    ],
  },
  {
    kind: 'nursery',
    names: ['Hedgerow Plant Nursery', 'Cold Frame Nursery', 'Barrowfield Plants', 'The Walled Garden Nursery', 'Sedge & Fern'],
    taglines: ['Hardy perennials grown outdoors', 'A small nursery on heavy clay', 'Peat-free, grown from seed and cuttings'],
    sentences: [
      'Everything is grown outdoors and never forced, so plants leave here properly hardened.',
      'We are peat-free throughout and mix our own compost with bark, loam and grit.',
      'The list changes constantly; what is ready is what is on the bench.',
      'Bare-root stock is lifted between November and March depending on the ground.',
      'We can hold an order for collection for up to two weeks in the shade tunnel.',
      'Advice on the site conditions matters more than the plant list, in our experience.',
      'The nursery sits on heavy clay, which shapes a lot of what we choose to grow.',
    ],
    sections: ['What we grow', 'Opening', 'Peat-free growing', 'Ordering', 'Finding us'],
    extraPages: [
      { slug: 'plants', title: 'Plants' },
      { slug: 'growing', title: 'Growing' },
      { slug: 'visit', title: 'Visit' },
    ],
  },
  {
    kind: 'chamber',
    names: ['Ellingham Chamber Players', 'The Vasari Quartet', 'Riverside Chamber Music', 'Aldgate Consort', 'The Fenwick Ensemble'],
    taglines: ['Chamber music in unusual rooms', 'A string quartet and its friends', 'Concerts, workshops and recordings'],
    sentences: [
      'The group formed after a summer course and has played together since.',
      'Programmes usually pair one familiar work with something the audience has not heard.',
      'We play in churches, halls and occasionally in rooms that were never meant for music.',
      'Workshops for local schools run alongside most of the touring dates.',
      'Recordings are made in a single room with minimal editing between takes.',
      'Tickets are sold on the door as well as in advance, and students pay less.',
      'The autumn series is built around late Beethoven and takes in six venues.',
    ],
    sections: ['The ensemble', 'Concerts', 'Recordings', 'Workshops', 'Booking'],
    extraPages: [
      { slug: 'concerts', title: 'Concerts' },
      { slug: 'recordings', title: 'Recordings' },
      { slug: 'about', title: 'About' },
    ],
  },
];

const INTRO_HEADINGS = ['Welcome', 'About us', 'Overview', 'Introduction', 'What we do', 'Who we are'] as const;

const STREETS = ['Mill Lane', 'Fenwick Road', 'Harbour Street', 'Ashby Row', 'Cranmere Way', 'Blackwood Close', 'Trent Street', 'Old Ferry Road'];
const TOWNS = ['Westgate', 'Ashby', 'Cranmere', 'Northfield', 'Hallward', 'Ellingham', 'Barrowfield', 'Fenwick'];

/**
 * Curated names alone are too few: a repeated business name across two installations
 * is a cheap cross-host signal even when everything else differs. These compose with
 * the per-archetype suffixes below into a name space large enough that collisions are
 * unlikely rather than expected.
 */
const PLACE_WORDS = [
  'Ashby', 'Cranmere', 'Fenwick', 'Harrow', 'Millstone', 'Northfield', 'Redgate', 'Silverdale',
  'Blackwood', 'Hallward', 'Ellingham', 'Barrowfield', 'Westgate', 'Thornbury', 'Greystone', 'Marlow',
  'Coldharbour', 'Ravensden', 'Whitlock', 'Penhale', 'Aldbury', 'Sedgemoor', 'Kingsfold', 'Brackenhill',
  'Netherby', 'Oakmere', 'Standen', 'Yarrow', 'Cawdale', 'Rushmere', 'Fairholt', 'Longmoor',
  'Wexbury', 'Ingleby', 'Tarnwood', 'Bexhill', 'Alderney', 'Croftlea', 'Dunstall', 'Elmsworth',
] as const;

const SUFFIXES: Record<string, readonly string[]> = {
  ceramics: ['Pottery', 'Ceramics', 'Clayworks', 'Kiln', 'Studio Pottery', 'Wheel & Kiln', 'Stoneware Studio', 'Glaze Works'],
  bakery: ['Bakehouse', 'Bakery', 'Bread', 'Mill & Bakery', 'Bakers', 'Bread & Mill', 'Oven Room', 'Flour House'],
  surveying: ['Land Surveys', 'Surveying', 'Geomatics', 'Survey Group', 'Surveyors', 'Survey Partners', 'Land & Levels', 'Boundary Surveys'],
  bikeshop: ['Cycles', 'Bicycle Works', 'Bikes', 'Cycle Workshop', 'Bicycle Repairs', 'Cycle Works', 'Wheel Room', 'Bike Workshop'],
  archive: ['Local Archive', 'Historical Trust', 'Local History', 'Records Office', 'Heritage Collection', 'Parish Records', 'History Society', 'Archive Trust'],
  translation: ['Language Services', 'Translation', 'Localisation', 'Translators', 'Language Office', 'Translation Bureau', 'Language Works', 'Interpreters'],
  nursery: ['Plant Nursery', 'Nursery', 'Plants', 'Garden Nursery', 'Growers', 'Perennials', 'Nursery Gardens', 'Plant Works'],
  chamber: ['Chamber Players', 'Ensemble', 'Consort', 'Chamber Music', 'Quartet', 'Music Society', 'Players', 'Chamber Group'],
};

function buildName(rng: Rng, archetype: Archetype): string {
  if (rng.bool(0.1)) return rng.pick(archetype.names);
  const suffixes = SUFFIXES[archetype.kind] || ['Studio'];
  const place = rng.pick(PLACE_WORDS);
  const suffix = rng.pick(suffixes);
  return rng.bool(0.15) ? `The ${place} ${suffix}` : `${place} ${suffix}`;
}

// --- naming conventions -----------------------------------------------------

type Namer = (base: string) => string;

const NAMERS: readonly Namer[] = [
  (base) => base,
  (base) => `site-${base}`,
  (base) => base.replace(/-(.)/g, (_, c: string) => c.toUpperCase()),
  (base) => `c-${base}`,
  (base) => base.split('-').map((p) => p.slice(0, 3)).join('_'),
];

// --- stylesheet variants ----------------------------------------------------

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  rule: string;
  surface: string;
}

const PALETTES: readonly Palette[] = [
  { bg: '#fbfaf7', fg: '#1f1d1a', muted: '#6b665e', accent: '#8a4b2a', rule: '#e2ddd3', surface: '#f3f0e9' },
  { bg: '#ffffff', fg: '#16202b', muted: '#5c6b7a', accent: '#1f5f8b', rule: '#dfe5ea', surface: '#f3f6f8' },
  { bg: '#f7f7f9', fg: '#22212b', muted: '#65636f', accent: '#4a3a8c', rule: '#e0dee6', surface: '#eeecf3' },
  { bg: '#fdfcf6', fg: '#232a1e', muted: '#5f6b56', accent: '#3f6b34', rule: '#e0e4d7', surface: '#f0f3e8' },
  { bg: '#1c1b1a', fg: '#eceae5', muted: '#a49f96', accent: '#d8a24a', rule: '#383532', surface: '#262422' },
  { bg: '#fffdf9', fg: '#2b1f1a', muted: '#7a6a5f', accent: '#9c3d3d', rule: '#e8ddd2', surface: '#f6eee4' },
  { bg: '#f4f6f5', fg: '#1a2422', muted: '#5b6b66', accent: '#0f6b5c', rule: '#dbe3e0', surface: '#e8eeec' },
  { bg: '#faf9fc', fg: '#241f2b', muted: '#6a6275', accent: '#7a3f6d', rule: '#e5e0ea', surface: '#f0ecf5' },
];

/** Numeric jitter shared by every stylesheet variant, so palettes are not the only axis. */
interface Metrics {
  fontSize: number;
  lineHeight: string;
  scale: string;
}

function buildMetrics(rng: Rng): Metrics {
  return {
    fontSize: rng.int(15, 17),
    lineHeight: (1.5 + rng.int(0, 5) * 0.05).toFixed(2),
    scale: (1.0 + rng.int(0, 6) * 0.125).toFixed(3),
  };
}

const FONT_STACKS: readonly string[] = [
  'Georgia, "Times New Roman", serif',
  '"Helvetica Neue", Helvetica, Arial, sans-serif',
  '"Iowan Old Style", Palatino, "Palatino Linotype", serif',
  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  '"Charter", "Bitstream Charter", Cambria, serif',
  '"Lucida Grande", "Lucida Sans Unicode", Verdana, sans-serif',
  'Cambria, "Hoefler Text", "Liberation Serif", serif',
  '"Trebuchet MS", "Segoe UI", Tahoma, sans-serif',
];

type CssVariant = (rng: Rng, palette: Palette, n: Namer, m: Metrics) => string;

const CSS_VARIANTS: readonly CssVariant[] = [
  // Centred single column, generous measure.
  (rng, p, n, m) => {
    const body = rng.pick(FONT_STACKS);
    const measure = rng.int(34, 42);
    return `:root{--bg:${p.bg};--fg:${p.fg};--muted:${p.muted};--accent:${p.accent};--rule:${p.rule}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:${m.fontSize}px/${m.lineHeight} ${body};-webkit-text-size-adjust:100%}
.${n('wrap')}{max-width:${measure}em;margin:0 auto;padding:calc(2.5rem * ${m.scale}) 1.25rem 4rem}
.${n('site-head')}{padding-bottom:1.25rem;border-bottom:1px solid var(--rule);margin-bottom:2.5rem}
.${n('site-title')}{font-size:1.5rem;margin:0 0 .35rem;letter-spacing:.01em}
.${n('site-title')} a{color:inherit;text-decoration:none}
.${n('tagline')}{color:var(--muted);margin:0}
.${n('nav')} ul{list-style:none;display:flex;gap:1.5rem;padding:0;margin:1.25rem 0 0;flex-wrap:wrap}
.${n('nav')} a{color:var(--accent);text-decoration:none}
.${n('nav')} a:hover{text-decoration:underline}
h2{font-size:1.15rem;margin:2.5rem 0 .75rem;font-weight:600}
p{margin:0 0 1.1rem}
.${n('note')}{color:var(--muted);font-size:.925rem}
.${n('site-foot')}{margin-top:4rem;padding-top:1.25rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.9rem}
@media (max-width:34rem){.${n('wrap')}{padding:1.75rem 1rem 3rem}}
`;
  },
  // Two-column grid: sticky sidebar nav, content on the right.
  (rng, p, n, m) => {
    const body = rng.pick(FONT_STACKS);
    const side = rng.int(11, 15);
    return `:root{--bg:${p.bg};--fg:${p.fg};--muted:${p.muted};--accent:${p.accent};--rule:${p.rule};--surface:${p.surface}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:${m.fontSize}px/${m.lineHeight} ${body}}
.${n('shell')}{display:grid;grid-template-columns:${side}rem minmax(0,1fr);gap:3rem;max-width:64rem;margin:0 auto;padding:calc(3rem * ${m.scale}) 1.5rem}
.${n('rail')}{position:sticky;top:3rem;align-self:start}
.${n('brand')}{font-size:1.2rem;margin:0 0 .5rem}
.${n('brand')} a{color:inherit;text-decoration:none}
.${n('rail')} p{color:var(--muted);font-size:.9rem;margin:0 0 1.5rem}
.${n('rail')} ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.55rem}
.${n('rail')} a{color:var(--accent);text-decoration:none}
.${n('rail')} a:hover{text-decoration:underline}
.${n('main')} h1{font-size:1.7rem;margin:0 0 1.25rem;font-weight:600}
.${n('main')} h2{font-size:1.05rem;margin:2.25rem 0 .6rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.${n('main')} p{margin:0 0 1rem;max-width:38em}
.${n('panel')}{background:var(--surface);padding:1.25rem 1.4rem;border-radius:3px;margin:1.75rem 0}
.${n('panel')} p:last-child{margin-bottom:0}
.${n('foot')}{grid-column:1/-1;border-top:1px solid var(--rule);padding-top:1.25rem;color:var(--muted);font-size:.875rem}
@media (max-width:52rem){.${n('shell')}{grid-template-columns:1fr;gap:2rem}.${n('rail')}{position:static}.${n('rail')} ul{flex-direction:row;flex-wrap:wrap;gap:1.1rem}}
`;
  },
  // Wide banner header, card grid below.
  (rng, p, n, m) => {
    const body = rng.pick(FONT_STACKS);
    const radius = rng.pick(['0', '2px', '6px']);
    return `:root{--bg:${p.bg};--fg:${p.fg};--muted:${p.muted};--accent:${p.accent};--rule:${p.rule};--surface:${p.surface}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:${m.fontSize}px/${m.lineHeight} ${body}}
.${n('banner')}{background:var(--surface);border-bottom:1px solid var(--rule);padding:calc(3.5rem * ${m.scale}) 1.5rem 2.5rem}
.${n('banner-inner')},.${n('body-inner')}{max-width:56rem;margin:0 auto}
.${n('banner')} h1{margin:0 0 .5rem;font-size:2rem;font-weight:600}
.${n('banner')} h1 a{color:inherit;text-decoration:none}
.${n('banner')} p{margin:0;color:var(--muted);font-size:1.05rem}
.${n('menu')}{margin-top:1.75rem}
.${n('menu')} ul{list-style:none;display:flex;gap:1.75rem;padding:0;margin:0;flex-wrap:wrap}
.${n('menu')} a{color:var(--accent);text-decoration:none;font-size:.95rem}
.${n('menu')} a:hover{text-decoration:underline}
.${n('body-inner')}{padding:2.75rem 1.5rem 4rem}
.${n('cards')}{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1.5rem;margin:2rem 0}
.${n('card')}{border:1px solid var(--rule);border-radius:${radius};padding:1.25rem 1.35rem}
.${n('card')} h2{margin:0 0 .5rem;font-size:1.05rem}
.${n('card')} p{margin:0;color:var(--muted);font-size:.95rem}
p{margin:0 0 1.05rem;max-width:40em}
h2{font-size:1.2rem;margin:2rem 0 .7rem}
.${n('closing')}{border-top:1px solid var(--rule);margin-top:3rem;padding-top:1.25rem;color:var(--muted);font-size:.9rem}
@media (max-width:34rem){.${n('banner')}{padding:2.25rem 1rem 1.75rem}.${n('banner')} h1{font-size:1.6rem}}
`;
  },
  // Compact editorial: small type, rules between sections.
  (rng, p, n, m) => {
    const body = rng.pick(FONT_STACKS);
    return `:root{--bg:${p.bg};--fg:${p.fg};--muted:${p.muted};--accent:${p.accent};--rule:${p.rule}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:${m.fontSize}px/${m.lineHeight} ${body}}
.${n('col')}{max-width:44rem;margin:0 auto;padding:calc(2rem * ${m.scale}) 1.25rem 3.5rem}
.${n('masthead')}{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap;border-bottom:2px solid var(--fg);padding-bottom:.6rem}
.${n('masthead')} h1{font-size:1.3rem;margin:0;font-weight:700;letter-spacing:-.01em}
.${n('masthead')} h1 a{color:inherit;text-decoration:none}
.${n('masthead')} nav ul{list-style:none;display:flex;gap:1.1rem;padding:0;margin:0}
.${n('masthead')} nav a{color:var(--fg);text-decoration:none;font-size:.85rem;text-transform:uppercase;letter-spacing:.06em}
.${n('masthead')} nav a:hover{color:var(--accent)}
.${n('lede')}{font-size:1.1rem;color:var(--muted);margin:1.75rem 0 2rem}
.${n('block')}+.${n('block')}{border-top:1px solid var(--rule);margin-top:2rem;padding-top:2rem}
.${n('block')} h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.09em;color:var(--accent);margin:0 0 .7rem}
p{margin:0 0 1rem}
.${n('colophon')}{margin-top:3rem;border-top:2px solid var(--fg);padding-top:.75rem;font-size:.8rem;color:var(--muted);display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
@media (max-width:30rem){.${n('masthead')}{display:block}.${n('masthead')} nav ul{margin-top:.6rem;flex-wrap:wrap}}
`;
  },
];

// --- page rendering ---------------------------------------------------------

/**
 * Independent structural toggles, drawn once per site.
 *
 * Picking from a handful of whole layouts is not enough on its own: with only four
 * skeletons, two unrelated installations land on the same DOM shape often enough for
 * that shape to be a usable probe signal. These combine multiplicatively with the
 * layout choice, so the space of shapes is large rather than enumerable.
 */
interface Ornaments {
  /** Index of the block rendered as a list instead of a paragraph, or null. */
  listBlock: number | null;
  figure: boolean;
  footerNav: boolean;
  addressTag: boolean;
  extraWrapper: boolean;
  established: number | null;
  blockHeading: 'h2' | 'h3';
  sectionTag: 'section' | 'div';
}

interface SiteContext {
  rng: Rng;
  archetype: Archetype;
  siteName: string;
  tagline: string;
  n: Namer;
  cssFile: string;
  faviconFile: string;
  pages: Array<{ slug: string; title: string }>;
  address: string;
  ornaments: Ornaments;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function paragraphs(ctx: SiteContext, count: number): string[] {
  return ctx.rng.sample(ctx.archetype.sentences, Math.min(count * 2, ctx.archetype.sentences.length))
    .reduce<string[][]>((acc, sentence, i) => {
      const bucket = Math.floor(i / 2);
      (acc[bucket] ||= []).push(sentence);
      return acc;
    }, [])
    .map((group) => group.join(' '));
}

function navHtml(ctx: SiteContext, current: string): string {
  const items = ctx.pages
    .map((page) => {
      const href = page.slug === 'index' ? '/' : `/${page.slug}`;
      const label = escapeHtml(page.title);
      return page.slug === current
        ? `<li><a href="${href}" aria-current="page">${label}</a></li>`
        : `<li><a href="${href}">${label}</a></li>`;
    })
    .join('');
  return `<ul>${items}</ul>`;
}

interface Block {
  title: string;
  body: string;
}

/** Split a paragraph into list items, so a block can render as <ul> instead of <p>. */
function asList(body: string): string {
  const items = body
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function blockHeading(ctx: SiteContext, title: string): string {
  const tag = ctx.ornaments.blockHeading;
  return `<${tag}>${escapeHtml(title)}</${tag}>`;
}

function renderBlockBody(ctx: SiteContext, block: Block, index: number): string {
  return ctx.ornaments.listBlock === index ? asList(block.body) : `<p>${escapeHtml(block.body)}</p>`;
}

/** Optional standalone elements injected into the main flow. */
function renderExtras(ctx: SiteContext): string {
  const parts: string[] = [];
  if (ctx.ornaments.figure) {
    parts.push(
      `<figure><figcaption>${escapeHtml(ctx.rng.pick(ctx.archetype.sections))}</figcaption></figure>`
    );
  }
  if (ctx.ornaments.established) {
    parts.push(`<p><time datetime="${ctx.ornaments.established}">Established ${ctx.ornaments.established}</time></p>`);
  }
  return parts.join('\n');
}

function renderAddress(ctx: SiteContext): string {
  const text = escapeHtml(ctx.address);
  return ctx.ornaments.addressTag ? `<address>${text}</address>` : `<span>${text}</span>`;
}

function renderFooterNav(ctx: SiteContext, current: string): string {
  return ctx.ornaments.footerNav ? `<nav>${navHtml(ctx, current)}</nav>` : '';
}

type BodyRenderer = (ctx: SiteContext, page: { slug: string; title: string }, heading: string, blocks: Block[]) => string;

const BODY_VARIANTS: readonly BodyRenderer[] = [
  // matches CSS variant 0
  (ctx, page, heading, blocks) => `<div class="${ctx.n('wrap')}">
<header class="${ctx.n('site-head')}">
<h1 class="${ctx.n('site-title')}"><a href="/">${escapeHtml(ctx.siteName)}</a></h1>
<p class="${ctx.n('tagline')}">${escapeHtml(ctx.tagline)}</p>
<nav class="${ctx.n('nav')}">${navHtml(ctx, page.slug)}</nav>
</header>
<main>
<h2>${escapeHtml(heading)}</h2>
${ctx.ornaments.extraWrapper ? `<div class="${ctx.n('inner')}">` : ''}
${blocks.map((b, i) => `${blockHeading(ctx, b.title)}\n${renderBlockBody(ctx, b, i)}`).join('\n')}
${ctx.ornaments.extraWrapper ? '</div>' : ''}
${renderExtras(ctx)}
</main>
<footer class="${ctx.n('site-foot')}">
<div>${escapeHtml(ctx.siteName)} &middot; ${renderAddress(ctx)}</div>
${renderFooterNav(ctx, page.slug)}
</footer>
</div>`,

  // matches CSS variant 1
  (ctx, page, heading, blocks) => `<div class="${ctx.n('shell')}">
<aside class="${ctx.n('rail')}">
<h2 class="${ctx.n('brand')}"><a href="/">${escapeHtml(ctx.siteName)}</a></h2>
<p>${escapeHtml(ctx.tagline)}</p>
<nav>${navHtml(ctx, page.slug)}</nav>
</aside>
<main class="${ctx.n('main')}">
<h1>${escapeHtml(heading)}</h1>
${blocks
  .map((b, i) =>
    i === 1
      ? `<div class="${ctx.n('panel')}">${blockHeading(ctx, b.title)}${renderBlockBody(ctx, b, i)}</div>`
      : `${blockHeading(ctx, b.title)}\n${renderBlockBody(ctx, b, i)}`
  )
  .join('\n')}
${renderExtras(ctx)}
</main>
<footer class="${ctx.n('foot')}">${renderAddress(ctx)}${renderFooterNav(ctx, page.slug)}</footer>
</div>`,

  // matches CSS variant 2
  (ctx, page, heading, blocks) => `<header class="${ctx.n('banner')}">
<div class="${ctx.n('banner-inner')}">
<h1><a href="/">${escapeHtml(ctx.siteName)}</a></h1>
<p>${escapeHtml(ctx.tagline)}</p>
<nav class="${ctx.n('menu')}">${navHtml(ctx, page.slug)}</nav>
</div>
</header>
<main class="${ctx.n('body-inner')}">
<h2>${escapeHtml(heading)}</h2>
<div class="${ctx.n('cards')}">
${blocks.map((b, i) => `<article class="${ctx.n('card')}">${blockHeading(ctx, b.title)}${renderBlockBody(ctx, b, i)}</article>`).join('\n')}
</div>
${renderExtras(ctx)}
<div class="${ctx.n('closing')}">${renderAddress(ctx)}${renderFooterNav(ctx, page.slug)}</div>
</main>`,

  // matches CSS variant 3
  (ctx, page, heading, blocks) => `<div class="${ctx.n('col')}">
<header class="${ctx.n('masthead')}">
<h1><a href="/">${escapeHtml(ctx.siteName)}</a></h1>
<nav>${navHtml(ctx, page.slug)}</nav>
</header>
<p class="${ctx.n('lede')}">${escapeHtml(heading)} &mdash; ${escapeHtml(ctx.tagline)}</p>
<main>
${blocks.map((b, i) => `<${ctx.ornaments.sectionTag} class="${ctx.n('block')}">${blockHeading(ctx, b.title)}${renderBlockBody(ctx, b, i)}</${ctx.ornaments.sectionTag}>`).join('\n')}
${renderExtras(ctx)}
</main>
<footer class="${ctx.n('colophon')}"><span>${escapeHtml(ctx.siteName)}</span>${renderAddress(ctx)}${renderFooterNav(ctx, page.slug)}</footer>
</div>`,
];

function renderPage(ctx: SiteContext, variant: number, page: { slug: string; title: string }, heading: string, blocks: Array<{ title: string; body: string }>): string {
  const title = page.slug === 'index' ? ctx.siteName : `${page.title} — ${ctx.siteName}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/${ctx.cssFile}">
<link rel="icon" href="/${ctx.faviconFile}" type="image/svg+xml">
</head>
<body>
${BODY_VARIANTS[variant](ctx, page, heading, blocks)}
</body>
</html>
`;
}

// --- favicon ----------------------------------------------------------------

function renderFavicon(rng: Rng, palette: Palette): string {
  const shape = rng.int(0, 3);
  const size = 64;
  let body: string;

  if (shape === 0) {
    const r = rng.int(16, 24);
    body = `<circle cx="32" cy="32" r="${r}" fill="${palette.accent}"/>`;
  } else if (shape === 1) {
    const inset = rng.int(10, 18);
    body = `<rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${rng.int(0, 6)}" fill="${palette.accent}"/>`;
  } else if (shape === 2) {
    const w = rng.int(6, 11);
    body = `<path d="M14 50 L32 14 L50 50 Z" fill="none" stroke="${palette.accent}" stroke-width="${w}" stroke-linejoin="round"/>`;
  } else {
    const gap = rng.int(8, 14);
    body = `<rect x="12" y="${32 - gap}" width="40" height="${rng.int(5, 8)}" fill="${palette.accent}"/><rect x="12" y="${32 + gap - 6}" width="40" height="${rng.int(5, 8)}" fill="${palette.fg}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${palette.bg}"/>${body}</svg>
`;
}

// --- entry point ------------------------------------------------------------

export function generateSite(seed: string): SiteFile[] {
  const rng = createRng(seed);
  const archetype = rng.pick(ARCHETYPES);
  const palette = rng.pick(PALETTES);
  const namer = rng.pick(NAMERS);
  const variant = rng.int(0, CSS_VARIANTS.length - 1);
  const metrics = buildMetrics(rng);

  // Asset filenames vary too: a fixed /styles.css across hosts is itself a marker.
  const cssFile = rng.pick(['styles.css', 'main.css', 'site.css', 'screen.css', 'base.css']);
  const faviconFile = rng.pick(['favicon.svg', 'icon.svg', 'mark.svg']);

  const extraPages = rng.sample(archetype.extraPages, rng.int(2, 3));
  const pages = [{ slug: 'index', title: 'Home' }, ...extraPages];

  const ctx: SiteContext = {
    rng,
    archetype,
    siteName: buildName(rng, archetype),
    tagline: rng.pick(archetype.taglines),
    n: namer,
    cssFile,
    faviconFile,
    pages,
    address: `${rng.int(1, 90)} ${rng.pick(STREETS)}, ${rng.pick(TOWNS)}`,
    ornaments: {
      listBlock: rng.bool(0.55) ? rng.int(0, 2) : null,
      figure: rng.bool(0.45),
      footerNav: rng.bool(0.5),
      addressTag: rng.bool(0.5),
      extraWrapper: rng.bool(0.4),
      established: rng.bool(0.5) ? rng.int(1946, 2019) : null,
      blockHeading: rng.bool(0.5) ? 'h2' : 'h3',
      sectionTag: rng.bool(0.5) ? 'section' : 'div',
    },
  };

  const files: SiteFile[] = [
    { path: cssFile, content: CSS_VARIANTS[variant](rng, palette, namer, metrics) },
    { path: faviconFile, content: renderFavicon(rng, palette) },
    { path: 'robots.txt', content: `User-agent: *\nDisallow:\n` },
  ];

  for (const page of pages) {
    const sectionTitles = rng.sample(archetype.sections, rng.int(2, 4));
    const bodies = paragraphs(ctx, sectionTitles.length);
    const blocks = sectionTitles.map((title, i) => ({
      title,
      body: bodies[i] || bodies[0] || archetype.sentences[0],
    }));
    const heading = page.slug === 'index' ? rng.pick(INTRO_HEADINGS) : page.title;
    files.push({
      path: page.slug === 'index' ? 'index.html' : `${page.slug}.html`,
      content: renderPage(ctx, variant, page, heading, blocks),
    });
  }

  files.push({
    path: '404.html',
    content: renderPage(ctx, variant, { slug: '404', title: 'Not found' }, 'Page not found', [
      { title: 'Nothing here', body: 'The page you asked for does not exist. Try the navigation above.' },
    ]),
  });

  return files;
}

// --- limits (see telemt [web.limits]) ---------------------------------------

export const SITE_LIMITS = {
  maxFiles: 4096,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

/** Throws when a generated site would be rejected by telemt's static snapshot limits. */
export function assertWithinLimits(files: SiteFile[]): void {
  if (files.length > SITE_LIMITS.maxFiles) {
    throw new Error(`Сайт содержит ${files.length} файлов при лимите ${SITE_LIMITS.maxFiles}`);
  }
  let total = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content, 'utf-8');
    if (size > SITE_LIMITS.maxFileBytes) {
      throw new Error(`Файл ${file.path} занимает ${size} Б при лимите ${SITE_LIMITS.maxFileBytes}`);
    }
    total += size;
  }
  if (total > SITE_LIMITS.maxTotalBytes) {
    throw new Error(`Сайт занимает ${total} Б при лимите ${SITE_LIMITS.maxTotalBytes}`);
  }
}
