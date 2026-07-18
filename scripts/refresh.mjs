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
  { g: 'GCW00:COMEX', name: 'Gold $', fx: true },  // gold futures, USD/oz
  { g: 'SIW00:COMEX', name: 'Silver $', fx: true }, // silver futures, USD/oz
];
// Edit this list to change the stock watchlist. Values are Google Finance symbols.
// Note: TATAMOTORS:NSE returns a broken quote page post-demerger; TMPV (Tata Motors
// Passenger Vehicles, the car/EV arm) is the working, marketplace-relevant listing.
const WATCHLIST = [
  { g: 'RELIANCE:NSE', name: 'Reliance', sec: 'Energy' },
  { g: 'TCS:NSE', name: 'TCS', sec: 'IT' },
  { g: 'HDFCBANK:NSE', name: 'HDFC Bank', sec: 'Bank' },
  { g: 'INFY:NSE', name: 'Infosys', sec: 'IT' },
  { g: 'ICICIBANK:NSE', name: 'ICICI Bank', sec: 'Bank' },
  { g: 'SBIN:NSE', name: 'SBI', sec: 'Bank' },
  { g: 'BHARTIARTL:NSE', name: 'Bharti Airtel', sec: 'Telecom' },
  { g: 'LT:NSE', name: 'L&T', sec: 'Infra' },
  { g: 'TMPV:NSE', name: 'Tata Motors', sec: 'Auto' },
  { g: 'M%26M:NSE', name: 'M&M', sec: 'Auto' },
  { g: 'MARUTI:NSE', name: 'Maruti Suzuki', sec: 'Auto' },
  { g: 'ITC:NSE', name: 'ITC', sec: 'FMCG' },
  { g: 'HINDUNILVR:NSE', name: 'HUL', sec: 'FMCG' },
  { g: 'SUNPHARMA:NSE', name: 'Sun Pharma', sec: 'Pharma' },
  { g: 'BAJFINANCE:NSE', name: 'Bajaj Finance', sec: 'NBFC' },
  { g: 'ADANIENT:NSE', name: 'Adani Ent', sec: 'Infra' },
];
// Sector indices — powers the "which sectors are hot/cold" heatmap.
const SECTORS = [
  { g: 'NIFTY_AUTO:INDEXNSE', name: 'Auto' },
  { g: 'NIFTY_BANK:INDEXNSE', name: 'Bank' },
  { g: 'NIFTY_IT:INDEXNSE', name: 'IT' },
  { g: 'NIFTY_PHARMA:INDEXNSE', name: 'Pharma' },
  { g: 'NIFTY_FMCG:INDEXNSE', name: 'FMCG' },
  { g: 'NIFTY_ENERGY:INDEXNSE', name: 'Energy' },
  { g: 'NIFTY_METAL:INDEXNSE', name: 'Metal' },
  { g: 'NIFTY_REALTY:INDEXNSE', name: 'Realty' },
];
// Global cues (matter for the Indian open) + volatility gauge.
const GLOBAL = [
  { g: '.DJI:INDEXDJX', name: 'Dow Jones' },
  { g: '.IXIC:INDEXNASDAQ', name: 'Nasdaq' },
  { g: '.INX:INDEXSP', name: 'S&P 500' },
  { g: 'NI225:INDEXNIKKEI', name: 'Nikkei 225' },
  { g: 'HSI:INDEXHANGSENG', name: 'Hang Seng' },
  { g: 'UKX:INDEXFTSE', name: 'FTSE 100' },
];
const VIX = [{ g: 'INDIA_VIX:INDEXNSE', name: 'India VIX' }];
// ETFs — what Indian retail actually buys for passive/thematic exposure.
const ETFS = [
  { g: 'NIFTYBEES:NSE', name: 'Nifty BeES', sub: 'Nifty 50 ETF' },
  { g: 'BANKBEES:NSE', name: 'Bank BeES', sub: 'Bank Nifty ETF' },
  { g: 'JUNIORBEES:NSE', name: 'Nifty Next 50', sub: 'Next 50 ETF' },
  { g: 'GOLDBEES:NSE', name: 'Gold BeES', sub: 'Gold ETF' },
  { g: 'SILVERBEES:NSE', name: 'Silver BeES', sub: 'Silver ETF' },
  { g: 'MON100:NSE', name: 'Nasdaq 100', sub: 'US tech ETF (₹)' },
];
// Popular mutual funds (NAV via AMFI-backed api.mfapi.in). Direct-Growth plans.
const MFUNDS = [
  { code: '120716', name: 'UTI Nifty 50 Index', cat: 'Index' },
  { code: '122639', name: 'Parag Parikh Flexi Cap', cat: 'Flexi Cap' },
  { code: '119598', name: 'SBI Large Cap', cat: 'Large Cap' },
  { code: '118989', name: 'HDFC Mid Cap', cat: 'Mid Cap' },
  { code: '125354', name: 'Axis Small Cap', cat: 'Small Cap' },
  { code: '120503', name: 'Axis ELSS Tax Saver', cat: 'ELSS · 80C' },
];
async function mfQuote(code) {
  try {
    const j = await (await fetch('https://api.mfapi.in/mf/' + code, OPTS(null, 15000))).json();
    const d = j.data || []; if (!d[0]) return null;
    const nav = +d[0].nav, prev = d[1] ? +d[1].nav : nav;
    return { nav: +nav.toFixed(2), pct: prev ? +(((nav - prev) / prev) * 100).toFixed(2) : 0, date: d[0].date };
  } catch (e) { console.error('mf fail', code, e.message); return null; }
}

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
  'Nifty IT': [20000, 90000], 'USD/INR': [60, 140], 'Brent $': [30, 200],
  'Gold $': [1500, 7000], 'Silver $': [12, 150] };
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
  const pe = md.match(/P\/E ratio\s*([\d.,]+)/i);
  if (pe) { const v = +pe[1].replace(/,/g, ''); if (v > 0 && v < 1000) q.pe = +v.toFixed(1); }
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
  if (q.pe) out.pe = q.pe;
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
  const sectors = await quoteList(SECTORS, byName(pm.sectors));
  const global = await quoteList(GLOBAL, byName(pm.global));
  const vix = (await quoteList(VIX, byName(pm.vix ? [pm.vix] : [])))[0];
  const etf = await quoteList(ETFS, byName(pm.etf));
  const mf = [];
  for (const f of MFUNDS) { const q = await mfQuote(f.code); mf.push(q ? { name: f.name, cat: f.cat, nav: q.nav, pct: q.pct, date: q.date, ok: true } : { name: f.name, cat: f.cat, ok: false }); await sleep(250); }
  const watchlist = await quoteList(WATCHLIST, byName(pm.watchlist));

  const live = watchlist.filter((w) => w.ok);
  const liveSec = sectors.filter((s) => s.ok);
  const ranked = [...live].sort((a, b) => b.pct - a.pct);
  const gainers = ranked.filter((w) => w.pct > 0).slice(0, 5);
  const losers = [...ranked].reverse().filter((w) => w.pct < 0).slice(0, 5);
  const up = live.filter((w) => w.pct > 0).length;
  const secRank = [...liveSec].sort((a, b) => b.pct - a.pct);
  const breadth = { up, total: live.length };

  const insights = [];
  if (live.length) {
    const mood = up / live.length;
    insights.push(`Breadth: ${up}/${live.length} stocks up — ${mood > 0.65 ? 'broadly bullish' : mood < 0.35 ? 'broadly weak' : 'mixed'} today`);
    if (ranked[0]) insights.push(`Top mover: ${ranked[0].name} ${ranked[0].pct >= 0 ? '+' : ''}${ranked[0].pct}%`);
    if (ranked[ranked.length - 1] && ranked[ranked.length - 1].pct < 0) insights.push(`Weakest: ${ranked[ranked.length - 1].name} ${ranked[ranked.length - 1].pct}%`);
  }
  if (secRank.length) {
    insights.push(`Hot sector: ${secRank[0].name} ${secRank[0].pct >= 0 ? '+' : ''}${secRank[0].pct}% · Cold: ${secRank[secRank.length - 1].name} ${secRank[secRank.length - 1].pct}%`);
    insights.push(`${liveSec.filter((s) => s.pct > 0).length}/${liveSec.length} sectors green today`);
  }
  const nf = indices.find((i) => i.name === 'Nifty 50');
  if (nf && nf.ok) insights.push(`Nifty 50 ${nf.pct >= 0 ? 'up' : 'down'} ${Math.abs(nf.pct)}% — ${nf.pct > 0.5 ? 'bullish' : nf.pct < -0.5 ? 'bearish' : 'flat'} session`);
  const rich = live.filter((w) => w.pe && w.pe > 45);
  if (rich.length) insights.push(`Rich valuations: ${rich.slice(0, 2).map((w) => `${w.name} P/E ${w.pe}`).join(', ')}`);
  if (vix && vix.ok) insights.push(`India VIX ${vix.price} — ${vix.price > 20 ? 'elevated fear' : vix.price < 13 ? 'calm markets' : 'moderate volatility'}`);
  const gLive = global.filter((g) => g.ok);
  if (gLive.length) { const gs = [...gLive].sort((a, b) => b.pct - a.pct); insights.push(`Global cues: ${gs[0].name} ${gs[0].pct >= 0 ? '+' : ''}${gs[0].pct}%, ${gs[gs.length - 1].name} ${gs[gs.length - 1].pct >= 0 ? '+' : ''}${gs[gs.length - 1].pct}%`); }

  // Educational market context — general principles anchored to today's data. NOT personalised advice.
  const context = [];
  if (live.length) { const mood2 = up / live.length;
    context.push(mood2 > 0.65 ? 'Broad buying today — most large-caps rose. Broad-based rallies are generally healthier than a narrow one led by 1–2 heavyweights.'
      : mood2 < 0.35 ? 'Broad selling today — most large-caps fell. Down days are exactly when disciplined SIP investors keep buying units cheaper.'
      : 'A mixed, stock-specific day with no clear index direction — the kind of day where individual names matter more than the headline number.'); }
  if (secRank.length) context.push(`Money rotated into ${secRank[0].name} and out of ${secRank[secRank.length - 1].name}. Sector leadership shifts often — chasing last month's hottest sector is a classic beginner trap.`);
  if (vix && vix.ok) context.push(vix.price > 20 ? `India VIX is elevated (${vix.price}) — the market is pricing in bigger swings. High-volatility phases suit staggered buying over big lump sums.`
    : `India VIX is low (${vix.price}) — calm, low expected volatility. Calm markets breed complacency; a good time to check your asset allocation, not to chase risk.`);

  // IPO watch — pull broadly across two queries, dedupe, keep up to 10.
  const ipoA = await rss({ tag: 'IPO', q: 'IPO india price band GMP listing subscription' });
  const ipoB = await rss({ tag: 'IPO', q: 'upcoming IPO india SME mainboard open date' });
  const seenIpo = new Set(); const ipo = [];
  for (const it of [...ipoA, ...ipoB]) { const k = it.title.toLowerCase().slice(0, 40); if (seenIpo.has(k)) continue; seenIpo.add(k); const f = ipoFields(it.title); ipo.push(f ? { ...it, f } : it); if (ipo.length >= 10) break; }

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
    markets: { indices, sectors, global, vix, etf, mf, watchlist, gainers, losers, breadth, trending: false, ipo, insights, context },
    news: news.length ? news : (prev.news || []),
    browse: browse.length ? browse : (prev.browse || []),
    gk, gkMore, learn,
  };
  writeFileSync(prevPath, JSON.stringify(data, null, 1));

  // embed.js — data + the light skills INDEX inlined so the app renders even without fetch
  // (file:// or first offline open). Full per-track lessons live in data/skills/<id>.json, lazy-loaded.
  const skillsIdx = readFileSync(join(ROOT, 'data', 'skills-index.json'), 'utf8');
  writeFileSync(join(ROOT, 'data', 'embed.js'),
    'window.EMBED_DATA=' + JSON.stringify(data) + ';\nwindow.EMBED_SKILLS=' + skillsIdx.trim() + ';\n');

  // .notify — created only when the top headline changed; the workflow sends it as a phone push
  const prevTop = prev.news && prev.news[0] && prev.news[0].title;
  const newTop = data.news[0] && data.news[0].title;
  if (newTop && newTop !== prevTop) writeFileSync(join(ROOT, 'data', '.notify'), `${data.news[0].tag}: ${newTop}`);

  const okIdx = indices.filter((i) => i.ok).length, okWl = watchlist.filter((i) => i.ok).length;
  console.log(`written: ${news.length} news, ${okIdx}/${indices.length} indices, ${okWl}/${watchlist.length} stocks, ipo=${ipo.length}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
