// Daily Pulse — data refresher. Runs in GitHub Actions (Node 20+), no dependencies.
// Markets: Google Finance via the r.jina.ai reader (reachable from CI runners).
// News: Google News RSS per topic bucket. Rotates GK + Learn cards from data/banks.json by date.
// Writes data/data.json (+ data/embed.js for offline/file:// fallback).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Instruments are addressed by their Google Finance symbol (EXCHANGE-qualified).
const INDICES = [
  { g: 'SENSEX:INDEXBOM', name: 'Sensex' },
  { g: 'NIFTY_50:INDEXNSE', name: 'Nifty 50' },
  { g: 'NIFTY_BANK:INDEXNSE', name: 'Bank Nifty' },
  { g: 'NIFTY_IT:INDEXNSE', name: 'Nifty IT' },
  { g: 'USD-INR', name: 'USD/INR', fx: true },
  { g: 'BZW00:NYMEX', name: 'Brent $', fx: true }, // front-month Brent crude, USD/bbl
];
// Edit this list to change the stock watchlist. Values are Google Finance symbols.
// Note: TATAMOTORS:NSE returns a broken quote page post-demerger; TMPV (Tata Motors
// Passenger Vehicles, the car/EV arm) is the working, marketplace-relevant listing.
const WATCHLIST = [
  { g: 'RELIANCE:NSE', name: 'Reliance' },
  { g: 'TCS:NSE', name: 'TCS' },
  { g: 'HDFCBANK:NSE', name: 'HDFC Bank' },
  { g: 'INFY:NSE', name: 'Infosys' },
  { g: 'ICICIBANK:NSE', name: 'ICICI Bank' },
  { g: 'TMPV:NSE', name: 'Tata Motors' },
  { g: 'M%26M:NSE', name: 'M&M' },
  { g: 'ITC:NSE', name: 'ITC' },
];

// News buckets in Arpit's preferred order. `q` = Google News search; `topic` = curated feed.
const BUCKETS = [
  { tag: 'Business', topic: 'BUSINESS' },
  { tag: 'Share Market', q: 'sensex nifty stock market india' },
  { tag: 'Sports', topic: 'SPORTS' },
  { tag: 'Tech', topic: 'TECHNOLOGY' },
  { tag: 'AI', q: 'artificial intelligence' },
  { tag: 'Economy', q: 'india economy rbi gdp inflation' },
  { tag: 'Politics', q: 'india government parliament policy' },
  { tag: 'Jobs', q: 'india jobs hiring layoffs employment' },
  { tag: 'Crime', q: 'india crime investigation' },
  { tag: 'World', topic: 'WORLD' },
];
// Rotating "For You" picks (Arpit: BI analyst at a used-car company).
const FORYOU = [
  'data analytics industry india', 'used car market india cars24', 'power bi tableau analytics tools',
  'india job market data analyst', 'automotive industry india', 'snowflake databricks data platform',
];

const dec = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();

const OPTS = (extra, to) => ({ headers: { ...UA, ...(extra || {}) }, signal: AbortSignal.timeout(to || +(process.env.DP_FETCH_TIMEOUT_MS || 20000)) });
async function tget(url, extra, to) { const r = await fetch(url, OPTS(extra, to)); if (!r.ok) throw new Error(r.status); return r.text(); }

/* ============================ MARKET QUOTES ============================
   The reader returns markdown whose quote block reads like:
     NIFTY 50 24,334.30 _arrow_upward_ +1.09% (+261.55)
   We read price, %, and absolute change straight from that line (no fragile
   "previous close" label), derive prev = price - change, and best-effort read
   the 52-week ("Year range") band. Yahoo (blocked from datacenter IPs) and
   Stooq (now behind a proof-of-work wall) were removed as dead sources. */
const JINA_HDR = { 'x-return-format': 'markdown',
  ...(process.env.JINA_KEY ? { Authorization: 'Bearer ' + process.env.JINA_KEY } : {}) };

// plausibility bounds keyed by display name — a scraped value outside its range is garbage.
const SANE = { 'Sensex': [40000, 150000], 'Nifty 50': [15000, 60000], 'Bank Nifty': [30000, 130000],
  'Nifty IT': [20000, 90000], 'USD/INR': [60, 140], 'Brent $': [30, 200] };
function sane(name, v) { const r = SANE[name] || [0.01, 5000000]; return v >= r[0] && v <= r[1]; }

function parseGF(mdRaw) {
  const md = mdRaw.replace(/\\/g, '');           // the reader escapes underscores as \_
  const m = md.match(/([\d,]+\.\d+)\s*_arrow_(upward|downward)_\s*([+-]?[\d.]+)%\s*\(([+-]?[\d,]+\.\d+)\)/);
  if (!m) return null;
  const price = +m[1].replace(/,/g, '');
  const dir = m[2] === 'downward' ? -1 : 1;
  const chg = +(dir * Math.abs(+m[4].replace(/,/g, ''))).toFixed(2);
  const q = { price, chg, pct: +(dir * Math.abs(+m[3])).toFixed(2), prev: +(price - chg).toFixed(2) };
  const yr = md.match(/Year range[\s₹$]*([\d,]+\.\d+)\s*[-–]\s*[₹$]?\s*([\d,]+\.\d+)/i);
  if (yr) { q.lo52 = +yr[1].replace(/,/g, ''); q.hi52 = +yr[2].replace(/,/g, ''); }
  return q;
}
// Hard cap so a jina outage can never blow the Action's 10-min budget; past it, everything
// falls through to carry-forward instead of retrying.
const DEADLINE = Date.now() + 7 * 60 * 1000;
// A too-short reader response is a rate-limit / interstitial page — retry a couple of times.
async function gfQuote(g) {
  for (let a = 0; a < 2; a++) {
    if (Date.now() > DEADLINE) return null;
    try {
      const md = await tget('https://r.jina.ai/https://www.google.com/finance/quote/' + g + '?hl=en', JINA_HDR, 12000);
      const q = parseGF(md);
      if (q) return q;
    } catch (e) { console.error('gf fail', g, e.message); }
    await sleep(2000);
  }
  return null;
}
function shape(inst, q) {
  if (!q || !sane(inst.name, q.price)) { if (q) console.error('rejected', inst.name, q.price); return null; }
  const out = { name: inst.name, g: inst.g, price: +q.price.toFixed(2), chg: q.chg, pct: q.pct,
    spark: [q.prev, q.price], fx: !!inst.fx, ok: true };
  if (q.lo52 && q.hi52 && sane(inst.name, q.lo52) && sane(inst.name, q.hi52)) { out.lo52 = q.lo52; out.hi52 = q.hi52; }
  return out;
}
// Sequential (the reader rate-limits parallel bursts). Carry forward last-good on failure
// so a transient miss shows the last known price instead of "awaiting refresh".
async function quoteList(list, prevByName) {
  const out = [];
  for (const inst of list) {
    const s = shape(inst, await gfQuote(inst.g));
    if (s) { out.push(s); }
    else {
      const p = prevByName[inst.name];
      out.push(p && p.ok ? { ...p, stale: true } : { name: inst.name, g: inst.g, fx: !!inst.fx, ok: false });
    }
    await sleep(1200);
  }
  return out;
}
const byName = (arr) => Object.fromEntries((arr || []).map((x) => [x.name, x]));

// Best-effort structured fields pulled from an IPO news headline — conservative:
// only emit a field when the value is unambiguously present (headlines often name the
// word "GMP"/"Price Band" without a value, so loose matching would print garbage).
function ipoFields(title) {
  const f = {};
  const band = title.match(/₹\s?(\d[\d,]*\d|\d)\s*(?:[-–]|to)\s*₹?\s?(\d[\d,]*\d|\d)/);
  if (band) { const lo = +band[1].replace(/,/g, ''), hi = +band[2].replace(/,/g, '');
    if (lo >= 10 && hi <= 9999 && hi > lo) f.band = '₹' + band[1] + '–₹' + band[2]; } // per-share band, not crore issue size
  const gmp = title.match(/GMP\s*:?\s*₹\s?(\d[\d,]*\d|\d)/i);      // require ₹ + digit right after GMP
  if (gmp) f.gmp = 'GMP ₹' + gmp[1];
  if (/subscri/i.test(title)) { const s = title.match(/(\d[\d.]*)\s?x\b/i); if (s) f.sub = s[1] + 'x subscribed'; }
  return Object.keys(f).length ? f : null;
}

async function rss(bucket) {
  const base = 'https://news.google.com/rss';
  const url = bucket.topic
    ? `${base}/headlines/section/topic/${bucket.topic}?hl=en-IN&gl=IN&ceid=IN:en`
    : `${base}/search?q=${encodeURIComponent(bucket.q)}+when:1d&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const xml = await tget(url);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((m) => {
      const b = m[1];
      const g = (re) => (b.match(re) || [])[1] || '';
      let title = dec(g(/<title>([\s\S]*?)<\/title>/));
      const source = dec(g(/<source[^>]*>([\s\S]*?)<\/source>/));
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(' - ' + source).length);
      let at = dec(g(/<pubDate>([\s\S]*?)<\/pubDate>/));
      const d = new Date(at);
      if (!isNaN(d)) { const i = new Date(d.getTime() + 330 * 60000);
        at = i.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', '
          + String(i.getUTCHours()).padStart(2, '0') + ':' + String(i.getUTCMinutes()).padStart(2, '0'); }
      return { title, url: dec(g(/<link>([\s\S]*?)<\/link>/)), src: source, at };
    }).filter((x) => x.title && x.url);
    return items;
  } catch (e) { console.error('rss fail', bucket.tag, e.message); return []; }
}

function rotate(bank, n, seed, salt) {
  // take n consecutive items starting at a daily-rotating offset — always terminates
  const L = bank.length; const off = ((seed * 13 + salt * 7) % L + L) % L;
  return Array.from({ length: Math.min(n, L) }, (_, i) => bank[(off + i) % L]);
}

const main = async () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  const seed = Math.floor(ist.getTime() / 86400000);

  const prevPath = join(ROOT, 'data', 'data.json');
  let prev = {}; try { prev = JSON.parse(readFileSync(prevPath, 'utf8')); } catch {}
  const pm = prev.markets || {};

  // Markets first (sequential, with carry-forward from the previous run).
  const indices = await quoteList(INDICES, byName(pm.indices));
  const watchlist = await quoteList(WATCHLIST, byName(pm.watchlist));

  const live = watchlist.filter((w) => w.ok);
  const insights = [];
  if (live.length) {
    const up = live.filter((w) => w.pct > 0).length;
    const ranked = [...live].sort((a, b) => b.pct - a.pct);
    const best = ranked[0], worst = ranked[ranked.length - 1];
    insights.push(`${up} of ${live.length} watchlist stocks advancing`);
    if (best) insights.push(`Top: ${best.name} ${best.pct >= 0 ? '+' : ''}${best.pct}%`);
    if (worst && worst.name !== best.name) insights.push(`Weakest: ${worst.name} ${worst.pct >= 0 ? '+' : ''}${worst.pct}%`);
    const near = live.find((w) => w.hi52 && w.price >= w.hi52 * 0.98);
    if (near) insights.push(`${near.name} within 2% of its 52-week high`);
    const it = indices.find((i) => i.name === 'Nifty IT'), nf = indices.find((i) => i.name === 'Nifty 50');
    if (it && it.ok && nf && nf.ok) insights.push(`Nifty IT ${it.pct > nf.pct ? 'outperforming' : 'lagging'} Nifty (${it.pct}% vs ${nf.pct}%)`);
  }

  // IPO watch: current IPO headlines, with band/GMP/subscription pulled out when present.
  const ipoRaw = await rss({ tag: 'IPO', q: 'IPO india price band GMP listing subscription' });
  const ipo = ipoRaw.slice(0, 5).map((it) => { const f = ipoFields(it.title); return f ? { ...it, f } : it; });

  const newsArrays = [];
  for (const b of BUCKETS) { newsArrays.push(await rss(b)); await sleep(200); }
  const news = [];      // top cards for the swipe deck (1-2 per bucket)
  const browse = [];    // full per-segment lists (up to 6 per bucket)
  BUCKETS.forEach((b, i) => {
    newsArrays[i].slice(0, b.tag === 'Share Market' || b.tag === 'AI' ? 2 : 1)
      .forEach((it) => news.push({ tag: b.tag, ...it }));
    if (newsArrays[i].length) browse.push({ tag: b.tag, items: newsArrays[i].slice(0, 6) });
  });
  const fy = await rss({ tag: 'For You', q: FORYOU[seed % FORYOU.length] });
  fy.slice(0, 1).forEach((it) => news.push({ tag: 'For You', ...it }));
  if (fy.length) browse.push({ tag: 'For You', items: fy.slice(0, 6) });

  const banks = JSON.parse(readFileSync(join(ROOT, 'data', 'banks.json'), 'utf8'));
  const gk = rotate(banks.gk, 10, seed, 3);
  const gkMore = rotate(banks.gk, 10, seed + 917, 5)
    .filter((c) => !gk.some((g) => g.t === c.t)).slice(0, 10);
  const learn = rotate(banks.learn, 8, seed, 11);

  const istHM = String(ist.getUTCHours()).padStart(2, '0') + ':' + String(ist.getUTCMinutes()).padStart(2, '0');
  const data = {
    generatedAt: now.toISOString(),
    label: ist.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + istHM + ' IST',
    markets: { indices, watchlist, trending: false, ipo, insights },
    news: news.length ? news : (prev.news || []),
    browse: browse.length ? browse : (prev.browse || []),
    gk, gkMore, learn,
  };
  writeFileSync(prevPath, JSON.stringify(data, null, 1));

  // embed.js — same data inlined so the app renders even without fetch (file:// or first offline open)
  const skillsRaw = readFileSync(join(ROOT, 'data', 'skills-bank.json'), 'utf8');
  writeFileSync(join(ROOT, 'data', 'embed.js'),
    'window.EMBED_DATA=' + JSON.stringify(data) + ';\nwindow.EMBED_SKILLS=' + skillsRaw.trim() + ';\n');

  // .notify — created only when the top headline changed; the workflow sends it as a phone push
  const prevTop = prev.news && prev.news[0] && prev.news[0].title;
  const newTop = data.news[0] && data.news[0].title;
  if (newTop && newTop !== prevTop) writeFileSync(join(ROOT, 'data', '.notify'), `${data.news[0].tag}: ${newTop}`);

  const okIdx = indices.filter((i) => i.ok).length, okWl = watchlist.filter((i) => i.ok).length;
  console.log(`written: ${news.length} news, ${okIdx}/${indices.length} indices, ${okWl}/${watchlist.length} stocks, ipo=${ipo.length}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
