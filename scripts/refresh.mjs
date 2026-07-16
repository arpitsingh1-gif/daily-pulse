// Daily Pulse — data refresher. Runs in GitHub Actions (Node 20+), no dependencies.
// Fetches: Yahoo Finance quotes (indices + watchlist) and Google News RSS per topic bucket.
// Rotates 10 GK + 8 Learn cards from data/banks.json by date. Writes data/data.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };

const INDICES = [
  { sym: '^BSESN', name: 'Sensex' },
  { sym: '^NSEI', name: 'Nifty 50' },
  { sym: '^NSEBANK', name: 'Bank Nifty' },
  { sym: '^CNXIT', name: 'Nifty IT' },
  { sym: 'USDINR=X', name: 'USD/INR', fx: true },
  { sym: 'BZ=F', name: 'Brent $', fx: true },
];
// Edit this list to change the stock watchlist.
const WATCHLIST = [
  { sym: 'RELIANCE.NS', name: 'Reliance' },
  { sym: 'TCS.NS', name: 'TCS' },
  { sym: 'HDFCBANK.NS', name: 'HDFC Bank' },
  { sym: 'INFY.NS', name: 'Infosys' },
  { sym: 'ICICIBANK.NS', name: 'ICICI Bank' },
  { sym: 'TATAMOTORS.NS', name: 'Tata Motors' },
  { sym: 'M&M.NS', name: 'M&M' },
  { sym: 'ITC.NS', name: 'ITC' },
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

const OPTS = () => ({ headers: UA, signal: AbortSignal.timeout(+(process.env.DP_FETCH_TIMEOUT_MS||15000)) });
async function jget(url) { const r = await fetch(url, OPTS()); if (!r.ok) throw new Error(r.status); return r.json(); }
async function tget(url) { const r = await fetch(url, OPTS()); if (!r.ok) throw new Error(r.status); return r.text(); }

async function quote({ sym, name, fx }) {
  try {
    const j = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`);
    const res = j.chart.result[0];
    const price = res.meta.regularMarketPrice;
    const closes = (res.indicators.quote[0].close || []).filter((x) => x != null);
    const prev = res.meta.chartPreviousClose ?? closes[closes.length - 2] ?? price;
    const chg = price - prev, pct = prev ? (chg / prev) * 100 : 0;
    const out = { name, sym, price: +price.toFixed(2), chg: +chg.toFixed(2), pct: +pct.toFixed(2),
      spark: closes.slice(-5).map((x) => +x.toFixed(2)), fx: !!fx, ok: true };
    if (res.meta.fiftyTwoWeekHigh) out.hi52 = +res.meta.fiftyTwoWeekHigh.toFixed(2);
    if (res.meta.fiftyTwoWeekLow) out.lo52 = +res.meta.fiftyTwoWeekLow.toFixed(2);
    return out;
  } catch (e) {
    console.error('quote fail', sym, e.message);
    return { name, sym, ok: false };
  }
}

// Yahoo "trending in India" tickers — the closest free proxy to "most searched" stocks.
// Falls back to the static WATCHLIST when unavailable.
async function trendingIN() {
  try {
    const j = await jget('https://query1.finance.yahoo.com/v1/finance/trending/IN?count=14');
    const syms = ((j.finance.result[0] || {}).quotes || []).map((q) => q.symbol)
      .filter((s) => /\.(NS|BO)$/.test(s)).slice(0, 8);
    if (syms.length < 4) return null;
    return syms.map((s) => ({ sym: s, name: s.replace(/\.(NS|BO)$/, '').replace(/[-_]/g, ' ') }));
  } catch (e) { console.error('trending fail', e.message); return null; }
}

async function rss(bucket) {
  const base = 'https://news.google.com/rss';
  const url = bucket.topic
    ? `${base}/headlines/section/topic/${bucket.topic}?hl=en-IN&gl=IN&ceid=IN:en`
    : `${base}/search?q=${encodeURIComponent(bucket.q)}+when:1d&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const xml = await tget(url);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4).map((m) => {
      const b = m[1];
      const g = (re) => (b.match(re) || [])[1] || '';
      let title = dec(g(/<title>([\s\S]*?)<\/title>/));
      const source = dec(g(/<source[^>]*>([\s\S]*?)<\/source>/));
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(' - ' + source).length);
      return { title, url: dec(g(/<link>([\s\S]*?)<\/link>/)), src: source, at: dec(g(/<pubDate>([\s\S]*?)<\/pubDate>/)) };
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

  const trend = await trendingIN();
  const wlDefs = trend || WATCHLIST;
  const [indices, watchlist] = await Promise.all([
    Promise.all(INDICES.map(quote)), Promise.all(wlDefs.map(quote)),
  ]);

  const live = watchlist.filter((w) => w.ok);
  const insights = [];
  if (live.length) {
    const up = live.filter((w) => w.pct > 0).length;
    const best = [...live].sort((a, b) => b.pct - a.pct)[0];
    const worst = [...live].sort((a, b) => a.pct - b.pct)[0];
    insights.push(`${up} of ${live.length} ${trend ? 'trending' : 'watchlist'} stocks advancing`);
    insights.push(`Top: ${best.name} ${best.pct >= 0 ? '+' : ''}${best.pct}%`);
    insights.push(`Weakest: ${worst.name} ${worst.pct >= 0 ? '+' : ''}${worst.pct}%`);
    const near = live.find((w) => w.hi52 && w.price >= w.hi52 * 0.98);
    if (near) insights.push(`${near.name} within 2% of its 52-week high`);
    const it = indices.find((i) => i.name === 'Nifty IT'), nf = indices.find((i) => i.name === 'Nifty 50');
    if (it?.ok && nf?.ok) insights.push(`Nifty IT ${it.pct > nf.pct ? 'outperforming' : 'lagging'} Nifty (${it.pct}% vs ${nf.pct}%)`);
  }

  // IPO watch: headlines with price bands / listings / GMP
  const ipo = (await rss({ tag: 'IPO', q: 'IPO india price band listing subscription' })).slice(0, 4);

  const newsArrays = await Promise.all(BUCKETS.map(rss));
  const news = [];
  BUCKETS.forEach((b, i) => {
    newsArrays[i].slice(0, b.tag === 'Share Market' || b.tag === 'AI' ? 2 : 1)
      .forEach((it) => news.push({ tag: b.tag, ...it }));
  });
  const fy = await rss({ tag: 'For You', q: FORYOU[seed % FORYOU.length] });
  fy.slice(0, 1).forEach((it) => news.push({ tag: 'For You', ...it }));

  const banks = JSON.parse(readFileSync(join(ROOT, 'data', 'banks.json'), 'utf8'));
  const gk = rotate(banks.gk, 10, seed, 3);
  const learn = rotate(banks.learn, 8, seed, 11);

  const prevPath = join(ROOT, 'data', 'data.json');
  let prev = {}; try { prev = JSON.parse(readFileSync(prevPath, 'utf8')); } catch {}
  const istHM = String(ist.getUTCHours()).padStart(2, '0') + ':' + String(ist.getUTCMinutes()).padStart(2, '0');
  const data = {
    generatedAt: now.toISOString(),
    label: ist.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + istHM + ' IST',
    markets: { indices, watchlist, trending: !!trend, ipo, insights },
    news: news.length ? news : (prev.news || []),
    gk, learn,
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

  console.log(`written: ${news.length} news, ${indices.filter((i) => i.ok).length}/${indices.length} indices, ${live.length}/${watchlist.length} stocks, trending=${!!trend}, ipo=${ipo.length}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
