'use strict';
/* ------------------------------------------------------------------
   Vault engine: a tiny TMDB-driven Stremio catalogue addon.
   No dependencies. Needs Node 18+ (built-in fetch).
   Env: TMDB_KEY (v3 key or v4 token), optional REGION (default US), PORT.
------------------------------------------------------------------- */
const http = require('http');

const KEY = (process.env.TMDB_KEY || process.env.TMDB_API_KEY || process.env.TMDB_TOKEN || '').trim();
const BASE = (process.env.TMDB_BASE || 'https://api.themoviedb.org/3').replace(/\/$/, '');
const REGION = (process.env.REGION || 'US').toUpperCase();
const PORT = Number(process.env.PORT) || 3000;
const PAGE = Number(process.env.PAGE_SIZE) || 20;
const ROW_TTL = 6 * 3600e3;
const STATIC_TTL = 24 * 3600e3;
const EMPTY_TTL = 10 * 60e3;
const MAX_TMDB_PAGES = 25;
const IMG = 'https://image.tmdb.org/t/p/w342';

/* ---------- what each platform is, in TMDB terms ---------- */
// Networks are resolved at startup: ids are verified by name, and if no id
// matches, the engine looks the network up through a well-known "seed" show.
const NETWORKS = {
  netflix:   { ids: [213],  match: /^netflix$/i, seeds: ['Stranger Things'] },
  prime:     { ids: [1024], match: /prime video|^amazon/i, seeds: ['The Boys'] },
  apple:     { ids: [2552], match: /^apple tv/i, seeds: ['Severance'] },
  starz:     { ids: [318],  match: /^starz/i, seeds: ['Outlander'] },
  amc:       { ids: [174, 4661], match: /^amc\+?$/i, seeds: ['Mad Men'] },
  mgm:       { ids: [],     match: /mgm|epix/i, seeds: ['From', 'Godfather of Harlem'] },
  hbo:       { ids: [49],   match: /^hbo$/i, seeds: ['Succession'] },
  max:       { ids: [3186], match: /^(hbo )?max$/i, seeds: ['Hacks'] },
  disney:    { ids: [2739], match: /^disney\+?$/i, seeds: ['The Mandalorian'] },
  hulu:      { ids: [453],  match: /^hulu$/i, seeds: ['The Handmaid\'s Tale'] },
  fx:        { ids: [88],   match: /^fx$/i, seeds: ['Fargo'] },
  natgeo:    { ids: [43],   match: /national geographic$/i, seeds: ['Genius'] },
  paramount: { ids: [4330], match: /^paramount\+?$/i, seeds: ['Star Trek: Strange New Worlds'] },
  peacock:   { ids: [3353], match: /^peacock/i, seeds: ['Poker Face'] },
  nbc:       { ids: [6],    match: /^nbc$/i, seeds: ['Law & Order: Special Victims Unit'] },
  adultswim: { ids: [80],   match: /adult swim/i, seeds: ['Rick and Morty'] },
  cartoon:   { ids: [56],   match: /^cartoon network$/i, seeds: ['Adventure Time'] },
  discovery: { ids: [64],   match: /^discovery( channel)?$/i, seeds: ['Deadliest Catch'] },
  tlc:       { ids: [84],   match: /^tlc$/i, seeds: ['90 Day Fiancé'] },
  id:        { ids: [244],  match: /investigation discovery|^id$/i, seeds: ['Homicide Hunter'] },
  hgtv:      { ids: [210],  match: /^hgtv$/i, seeds: ['Property Brothers'] },
  food:      { ids: [],     match: /^food network$/i, seeds: ['Chopped'] },
  magnolia:  { ids: [],     match: /magnolia/i, seeds: ['Magnolia Table with Joanna Gaines'] },
};
// Production companies are resolved by name through /search/company.
const COMPANIES = {
  netflix:   { names: ['Netflix', 'Netflix Animation', 'Netflix Studios'], prefix: 'netflix' },
  amazon:    { names: ['Amazon Studios', 'Amazon MGM Studios', 'Amazon Content Services'], prefix: 'amazon' },
  amsStudio: { names: ['Amazon MGM Studios', 'Metro-Goldwyn-Mayer', 'Metro-Goldwyn-Mayer Pictures', 'United Artists'] },
  apple:     { names: ['Apple Studios', 'Apple Original Films', 'Apple TV+', 'Apple'] },
  starz:     { names: ['Starz Originals', 'Starz Entertainment', 'Starz'], prefix: 'starz' },
  hbo:       { names: ['HBO Films', 'HBO', 'Max', 'HBO Max', 'HBO Documentary Films', 'Max Original'], prefix: 'hbo' },
  dc:        { names: ['DC Entertainment', 'DC Films', 'DC Studios', 'DC Comics'] },
  warner:    { names: ['Warner Bros. Pictures', 'Warner Bros.'] },
  disney:    { names: ['Walt Disney Pictures', 'Walt Disney Animation Studios', 'Disney+', 'Disneynature'] },
  pixar:     { names: ['Pixar'] },
  marvel:    { names: ['Marvel Studios'] },
  lucasfilm: { names: ['Lucasfilm Ltd.', 'Lucasfilm'] },
  natgeo:    { names: ['National Geographic Documentary Films', 'National Geographic Studios', 'National Geographic Films', 'National Geographic'], prefix: 'national geographic' },
  hulu:      { names: ['Hulu', 'Hulu Originals'], prefix: 'hulu' },
  parplus:   { names: ['Paramount+', 'Paramount Plus', 'Paramount Players', 'Paramount Animation'] },
  parpics:   { names: ['Paramount Pictures'] },
  peacock:   { names: ['Peacock Productions', 'Peacock'] },
  universal: { names: ['Universal Pictures'] },
  dreamworks:{ names: ['DreamWorks Animation'] },
  wwe:       { names: ['WWE Studios', 'WWE', 'World Wrestling Entertainment'], prefix: 'wwe' },
};
// Streaming providers (US catalogue), matched by name from TMDB's own list.
const PROVIDERS = {
  netflix:   /^netflix$/i,
  prime:     /^amazon prime video$/i,
  apple:     /^apple tv( plus|\+)$/i,
  max:       /^(hbo )?max$/i,
  disney:    /^disney( plus|\+)$/i,
  hulu:      /^hulu$/i,
  paramount: /^paramount( plus|\+)$/i,
  peacock:   /^peacock( premium)?$/i,
  starz:     /^starz$/i,
  amcplus:   /^amc\+$/i,
  mgm:       /^mgm( plus|\+)$/i,
};

/* ---------- small utilities ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const todayStr = () => new Date().toISOString().slice(0, 10);
const yearOf = (d) => (d ? String(d).slice(0, 4) : '');
const log = (...a) => console.log(new Date().toISOString(), ...a);

let inflight = 0;
const waiters = [];
async function acquire() {
  if (inflight < 8) { inflight++; return; }
  await new Promise((r) => waiters.push(r)); // slot is handed over directly
}
function release() {
  const next = waiters.shift();
  if (next) next(); else inflight--;
}

async function tmdb(path, params) {
  if (!KEY) throw new Error('TMDB_KEY is not set');
  const url = new URL(BASE + path);
  const headers = { accept: 'application/json' };
  if (KEY.length > 60) headers.authorization = 'Bearer ' + KEY;
  else url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let lastErr = new Error('TMDB request failed');
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    await acquire();
    try { res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); }
    catch (e) { lastErr = e; }
    finally { release(); }
    if (res) {
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      if (res.status === 401) throw new Error('TMDB rejected the API key (401)');
      lastErr = new Error('TMDB HTTP ' + res.status);
      const ra = Number(res.headers.get('retry-after')) || 0;
      await sleep(Math.max(ra * 1000, 600 * (attempt + 1)));
    } else {
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

const cache = new Map();
function memo(key, ttl, fn, emptyTtl) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.p;
  const entry = { exp: Date.now() + ttl, p: null };
  entry.p = fn().then((v) => {
    if (emptyTtl && Array.isArray(v) && v.length === 0) entry.exp = Date.now() + emptyTtl;
    return v;
  }, (e) => { cache.delete(key); throw e; });
  cache.set(key, entry);
  return entry.p;
}
const memoList = (key, fn) => memo(key, STATIC_TTL, fn, EMPTY_TTL);

/* ---------- resolvers ---------- */
function resolveNetwork(key) {
  const spec = NETWORKS[key];
  if (!spec) return Promise.reject(new Error('unknown network key: ' + key));
  return memoList('net:' + key, async () => {
    const ids = new Set();
    for (const id of spec.ids) {
      const d = await tmdb('/network/' + id);
      if (d && spec.match.test(d.name || '')) ids.add(id);
    }
    if (!ids.size) {
      for (const seed of spec.seeds || []) {
        const s = await tmdb('/search/tv', { query: seed });
        const hit = s && s.results && s.results[0];
        if (!hit) continue;
        const d = await tmdb('/tv/' + hit.id);
        for (const n of (d && d.networks) || []) if (spec.match.test(n.name || '')) ids.add(n.id);
        if (ids.size) break;
      }
    }
    return [...ids];
  });
}

function providerList(mt) {
  return memoList('provlist:' + mt, async () => {
    const d = await tmdb('/watch/providers/' + mt, { watch_region: REGION });
    return (d && d.results) || [];
  });
}
async function resolveProvider(key, mt) {
  const re = PROVIDERS[key];
  if (!re) throw new Error('unknown provider key: ' + key);
  const list = await providerList(mt);
  return list.filter((p) => re.test(p.provider_name || '')).map((p) => p.provider_id);
}

function resolveCompany(key) {
  const spec = COMPANIES[key];
  if (!spec) return Promise.reject(new Error('unknown company key: ' + key));
  return memoList('co:' + key, async () => {
    const names = (spec.names || []).map((n) => n.toLowerCase());
    const prefix = spec.prefix ? spec.prefix.toLowerCase() : '';
    const queries = new Set([...(spec.names || []), ...(spec.prefix ? [spec.prefix.trim()] : [])]);
    const ids = new Set();
    for (const q of queries) {
      const d = await tmdb('/search/company', { query: q });
      for (const c of (d && d.results) || []) {
        const nm = String(c.name || '').toLowerCase();
        if (names.includes(nm) || (prefix && nm.startsWith(prefix))) ids.add(c.id);
      }
    }
    return [...ids];
  });
}

function resolveKeywords(names, fallbackIds) {
  return memoList('kw:' + names.join('|'), async () => {
    const ids = new Set();
    for (const name of names) {
      const d = await tmdb('/search/keyword', { query: name });
      for (const k of (d && d.results) || []) if (String(k.name).toLowerCase() === name.toLowerCase()) ids.add(k.id);
    }
    if (!ids.size) for (const f of fallbackIds || []) ids.add(f);
    return [...ids];
  });
}

async function union(keys, fn) {
  const out = new Set();
  for (const k of keys) for (const id of await fn(k)) out.add(id);
  return [...out];
}

/* ---------- discover-row queries ---------- */
async function buildQuery(row) {
  const isTv = row.type === 'series';
  const p = {
    sort_by: row.sort || 'popularity.desc',
    include_adult: 'false',
    'vote_count.gte': row.minVotes !== undefined ? row.minVotes : 15,
  };
  if (row.minRating) p['vote_average.gte'] = row.minRating;
  if (row.genres) p.with_genres = row.genres.join(',');
  if (row.noGenres) p.without_genres = row.noGenres.join(',');
  if (row.lang) p.with_original_language = row.lang;
  if (row.country) p.with_origin_country = row.country;
  if (isTv && row.tvType !== undefined) p.with_type = row.tvType;
  const dateKey = isTv ? 'first_air_date' : 'primary_release_date';
  if (row.from) p[dateKey + '.gte'] = row.from;
  p[dateKey + '.lte'] = row.to || todayStr();

  if (row.net) {
    const ids = await union(row.net, resolveNetwork);
    if (!ids.length) return { empty: true, reason: 'network not found: ' + row.net.join(', ') };
    p.with_networks = ids.join('|');
  }
  if (row.co) {
    const ids = await union(row.co, resolveCompany);
    if (!ids.length) return { empty: true, reason: 'company not found: ' + row.co.join(', ') };
    p.with_companies = ids.join('|');
  }
  if (row.noCo) {
    const ids = await union(row.noCo, resolveCompany);
    if (ids.length) p.without_companies = ids.join(',');
  }
  if (row.prov) {
    const mt = isTv ? 'tv' : 'movie';
    const ids = await union(row.prov, (k) => resolveProvider(k, mt));
    if (!ids.length) return { empty: true, reason: 'streaming provider not found: ' + row.prov.join(', ') };
    p.with_watch_providers = ids.join('|');
    p.watch_region = REGION;
    p.with_watch_monetization_types = 'flatrate';
  }
  if (row.kw) {
    const ids = await resolveKeywords(row.kw, row.kwIds);
    if (ids.length) p.with_keywords = ids.join('|');
    else if (!row.kwOptional) return { empty: true, reason: 'keyword not found: ' + row.kw.join(', ') };
  }
  return { endpoint: isTv ? '/discover/tv' : '/discover/movie', params: p };
}

/* ---------- list rows (franchises, collections, searches) ---------- */
const isListRow = (r) => !!(r.collections || r.collectionSearch || r.titles || r.shows || r.searches);

function pickByTitle(results, wanted, getName) {
  const w = norm(wanted);
  return results.find((r) => norm(getName(r)) === w) ||
         results.find((r) => norm(getName(r)).includes(w)) || null;
}

function collectionParts(name) {
  return memoList('colname:' + name, async () => {
    const d = await tmdb('/search/collection', { query: name });
    const hit = pickByTitle((d && d.results) || [], name, (c) => c.name);
    if (!hit) return [];
    const c = await tmdb('/collection/' + hit.id);
    return (c && c.parts) || [];
  });
}
function collectionsMatching(q, pattern) {
  return memoList('colsearch:' + q + '|' + pattern, async () => {
    const re = new RegExp(pattern, 'i');
    const d = await tmdb('/search/collection', { query: q });
    const out = [];
    for (const c of ((d && d.results) || []).filter((x) => re.test(x.name || ''))) {
      const full = await tmdb('/collection/' + c.id);
      for (const part of (full && full.parts) || []) out.push(part);
    }
    return out;
  });
}
function findMovie(t, y) {
  return memoList('movie:' + t + '|' + (y || ''), async () => {
    const d = await tmdb('/search/movie', { query: t, primary_release_year: y });
    const hit = pickByTitle((d && d.results) || [], t, (m) => m.title);
    return hit ? [hit] : [];
  });
}
function findShow(spec) {
  const t = typeof spec === 'string' ? spec : spec.t;
  const y = typeof spec === 'string' ? undefined : spec.y;
  return memoList('show:' + t + '|' + (y || ''), async () => {
    const d = await tmdb('/search/tv', { query: t, first_air_date_year: y });
    const hit = pickByTitle((d && d.results) || [], t, (s) => s.name);
    return hit ? [hit] : [];
  });
}
function searchMatching(s, type) {
  return memoList('search:' + type + '|' + s.q + '|' + s.match + '|' + (s.pages || 1), async () => {
    const re = new RegExp(s.match || '.', 'i');
    const out = [];
    for (let page = 1; page <= (s.pages || 1); page++) {
      const d = await tmdb('/search/' + (type === 'series' ? 'tv' : 'movie'), { query: s.q, page });
      for (const r of (d && d.results) || []) if (re.test(r.title || r.name || '')) out.push(r);
      if (!d || page >= (d.total_pages || 1)) break;
    }
    return out;
  });
}

// Returns { found: [tmdb result objects], missing: [names not found] }
function collectList(row) {
  return memo('list:' + row.id, ROW_TTL, async () => {
    const isTv = row.type === 'series';
    const found = new Map();
    const missing = [];
    const add = (r) => { if (r && r.id && !found.has(r.id)) found.set(r.id, r); };
    if (!isTv) {
      for (const name of row.collections || []) {
        const parts = await collectionParts(name);
        if (!parts.length) missing.push('collection: ' + name);
        parts.forEach(add);
      }
      for (const c of row.collectionSearch || []) {
        const parts = await collectionsMatching(c.q, c.match);
        if (!parts.length) missing.push('collection search: ' + c.q);
        parts.forEach(add);
      }
      for (const t of row.titles || []) {
        const r = await findMovie(t.t, t.y);
        if (!r.length) missing.push('movie: ' + t.t + (t.y ? ' (' + t.y + ')' : ''));
        r.forEach(add);
      }
    } else {
      for (const s of row.shows || []) {
        const r = await findShow(s);
        if (!r.length) missing.push('show: ' + (typeof s === 'string' ? s : s.t));
        r.forEach(add);
      }
    }
    for (const s of row.searches || []) {
      const r = await searchMatching(s, row.type);
      if (!r.length) missing.push('search: ' + s.q);
      r.forEach(add);
    }
    const today = todayStr();
    const dateOf = (r) => r.release_date || r.first_air_date || '';
    let list = [...found.values()].filter((r) => dateOf(r) && dateOf(r) <= today);
    list.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    if (row.order === 'newest') list.reverse();
    return { found: list, missing };
  });
}

/* ---------- ids and items ---------- */
const imdbCache = new Map();
function imdbOf(type, tmdbId) {
  const k = type + ':' + tmdbId;
  if (imdbCache.has(k)) return imdbCache.get(k);
  const p = tmdb('/' + (type === 'series' ? 'tv' : 'movie') + '/' + tmdbId + '/external_ids')
    .then((d) => (d && d.imdb_id) || null)
    .catch(() => { imdbCache.delete(k); return null; });
  imdbCache.set(k, p);
  return p;
}
async function toItem(type, r) {
  if (!r.poster_path) return null;
  const imdb = await imdbOf(type, r.id);
  if (!imdb) return null;
  return {
    id: imdb,
    type,
    name: r.title || r.name,
    poster: IMG + r.poster_path,
    posterShape: 'poster',
    releaseInfo: yearOf(r.release_date || r.first_air_date),
  };
}

/* ---------- row state (resolved lists, built lazily, cached 6h) ---------- */
let ROWS = [];
const ROW_BY_KEY = new Map();
const states = new Map();

function stateFor(row) {
  let s = states.get(row.id);
  if (!s || s.exp < Date.now()) {
    s = { items: [], seen: new Set(), tmdbIds: new Set(), page: 0, done: false, exp: Date.now() + ROW_TTL, lock: Promise.resolve(), reason: '' };
    states.set(row.id, s);
  }
  return s;
}

async function excludedIds(row) {
  const out = new Set();
  for (const id of row.exclude || []) {
    const other = ROWS.find((r) => r.id === id);
    if (!other || !isListRow(other)) continue;
    const { found } = await collectList(other);
    found.forEach((r) => out.add(r.id));
  }
  return out;
}

// A "mixed" row (row.prepend) shows a second kind of title first (for example
// documentary movies) and then continues with the row's own type.
async function fillPrepend(row, s) {
  s.preDone = true;
  const prow = Object.assign({}, row.prepend, { id: row.id + ':pre' });
  const q = await buildQuery(prow);
  if (q.empty) { log('mixed row part empty:', row.id, q.reason); return; }
  for (let page = 1; page <= 5; page++) {
    const d = await tmdb(q.endpoint, Object.assign({}, q.params, { page }));
    const results = (d && d.results) || [];
    const mapped = await Promise.all(results.map((r) => toItem(prow.type, r)));
    for (const it of mapped) if (it && !s.seen.has(it.id)) { s.seen.add(it.id); s.items.push(it); }
    if (!results.length || page >= (d.total_pages || 1)) break;
  }
}

async function fill(row, s, need) {
  if (s.done || s.items.length >= need) return;
  if (row.prepend && !s.preDone) await fillPrepend(row, s);
  if (s.items.length >= need) return;
  if (isListRow(row)) {
    const { found } = await collectList(row);
    const mapped = await Promise.all(found.map(async (r) => { s.tmdbIds.add(r.id); return toItem(row.type, r); }));
    for (const it of mapped) if (it && !s.seen.has(it.id)) { s.seen.add(it.id); s.items.push(it); }
    s.done = true;
    return;
  }
  if (!s.q) {
    s.q = await buildQuery(row);
    if (s.q.empty) { s.done = true; s.reason = s.q.reason; log('row empty:', row.id, s.reason); return; }
    s.ex = row.exclude ? await excludedIds(row) : null;
  }
  while (s.items.length < need && !s.done && s.page < MAX_TMDB_PAGES) {
    s.page++;
    const d = await tmdb(s.q.endpoint, Object.assign({}, s.q.params, { page: s.page }));
    const results = (d && d.results) || [];
    if (!results.length || s.page >= (d.total_pages || 1)) s.done = true;
    const cand = results.filter((r) => !(s.ex && s.ex.has(r.id)));
    const mapped = await Promise.all(cand.map((r) => toItem(row.type, r)));
    for (const it of mapped) if (it && !s.seen.has(it.id)) { s.seen.add(it.id); s.items.push(it); }
  }
  if (s.page >= MAX_TMDB_PAGES) s.done = true;
}

async function ensure(row, need) {
  const s = stateFor(row);
  const run = s.lock.then(() => fill(row, s, need));
  s.lock = run.catch(() => {});
  await run;
  return s;
}

async function catalogPage(type, id, skip) {
  const row = ROW_BY_KEY.get(type + ':' + id);
  if (!row) return null;
  const s = await ensure(row, skip + PAGE);
  return s.items.slice(skip, skip + PAGE);
}

/* ---------- diagnostics (/debug) ---------- */
async function diagnoseRow(row) {
  try {
    if (isListRow(row)) {
      const { found, missing } = await collectList(row);
      return { ok: found.length > 0, count: found.length, note: missing.length ? 'not found: ' + missing.join('; ') : '' };
    }
    let extra = 0;
    let extraNote = '';
    if (row.prepend) {
      const pq = await buildQuery(Object.assign({}, row.prepend, { id: row.id + ':pre' }));
      if (pq.empty) extraNote = 'movie part empty: ' + pq.reason;
      else {
        const pd = await tmdb(pq.endpoint, Object.assign({}, pq.params, { page: 1 }));
        extra = (pd && pd.total_results) || 0;
        extraNote = 'includes ' + extra + ' ' + row.prepend.type + 's first';
      }
    }
    const q = await buildQuery(row);
    if (q.empty) return { ok: extra > 0, count: extra, note: q.reason + (extraNote ? '; ' + extraNote : '') };
    const d = await tmdb(q.endpoint, Object.assign({}, q.params, { page: 1 }));
    const total = ((d && d.total_results) || 0) + extra;
    const thin = total && total < 15 ? 'thin row' : '';
    return { ok: total > 0, count: total, note: [thin, extraNote].filter(Boolean).join('; ') };
  } catch (e) {
    return { ok: false, count: 0, note: 'error: ' + e.message };
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}
async function debugReport(cfg) {
  const lines = [];
  lines.push(cfg.name + ' v' + cfg.version + ' - diagnostics');
  lines.push('TMDB key set: ' + (KEY ? 'yes' : 'NO - set TMDB_KEY on Render'));
  lines.push('Region: ' + REGION + '   Rows: ' + ROWS.length);
  lines.push('');
  if (!KEY) return lines.join('\n');
  const res = await mapLimit(ROWS, 4, diagnoseRow);
  let bad = 0;
  ROWS.forEach((r, i) => {
    const d = res[i];
    if (!d.ok) bad++;
    lines.push((d.ok ? (/thin row/.test(d.note) ? 'THIN ' : 'OK    ') : 'EMPTY ') + String(d.count).padStart(6) + '  ' + r.type.padEnd(6) + ' ' + r.name + (d.note ? '   <- ' + d.note : ''));
  });
  lines.push('');
  lines.push(bad ? bad + ' row(s) EMPTY - send me this page and I will fix the rules.' : 'All rows returned results.');
  return lines.join('\n');
}

/* ---------- http server ---------- */
function start(cfg) {
  ROWS = cfg.rows;
  for (const r of ROWS) ROW_BY_KEY.set(r.type + ':' + r.id, r);
  const manifest = {
    id: cfg.id,
    version: cfg.version,
    name: cfg.name,
    description: cfg.description,
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: ROWS.map((r) => ({ type: r.type, id: r.id, name: r.name, extra: [{ name: 'skip' }] })),
    behaviorHints: { configurable: false },
  };

  const send = (res, code, body, type, extra) => {
    res.writeHead(code, Object.assign({
      'content-type': type || 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
    }, extra || {}));
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const u = new URL(req.url, 'http://x');
      const path = decodeURIComponent(u.pathname);
      if (path === '/manifest.json') return send(res, 200, manifest, null, { 'cache-control': 'public, max-age=300' });
      if (path === '/health') return send(res, 200, 'ok', 'text/plain');
      if (path === '/debug') return send(res, 200, await debugReport(cfg), 'text/plain; charset=utf-8');
      if (path === '/') {
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const html = '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>' + cfg.name + '</title>' +
          '<body style="font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px">' +
          '<h2>' + cfg.name + '</h2><p>' + cfg.description + '</p><p>' + ROWS.length + ' catalogues.</p>' +
          (KEY ? '' : '<p style="color:#b00"><b>TMDB_KEY is not set on this server.</b></p>') +
          '<p><a href="stremio://' + host + '/manifest.json" style="display:inline-block;padding:12px 18px;background:#6b4fe0;color:#fff;border-radius:8px;text-decoration:none">Install in Stremio</a></p>' +
          '<p>Or paste this in Stremio (Addons, search box):<br><code>' + proto + '://' + host + '/manifest.json</code></p>' +
          '<p><a href="/debug">Check all rows</a></p></body>';
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      const m = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
      if (m) {
        const extra = new URLSearchParams(m[3] || '');
        const skip = Math.max(0, parseInt(extra.get('skip') || '0', 10) || 0);
        const metas = await catalogPage(m[1], m[2], skip);
        if (metas === null) return send(res, 404, { metas: [] });
        return send(res, 200, { metas }, null, { 'cache-control': metas.length ? 'public, max-age=900' : 'no-store' });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      log('request error:', req.url, e.message);
      send(res, 200, { metas: [] }, null, { 'cache-control': 'no-store' });
    }
  });
  server.listen(PORT, () => log(cfg.name + ' listening on ' + PORT + ' with ' + ROWS.length + ' catalogues'));
}

/* ---- addon config ---- */
start({
 "id": "community.originalsvault",
 "name": "OriginalsVault",
 "version": "1.1.0",
 "description": "Netflix, Prime Video, Apple TV+, Starz, AMC and MGM+ originals.",
 "rows": [
  {
   "id": "netflix-originalsseries",
   "name": "🔴 Netflix Originals",
   "type": "series",
   "net": [
    "netflix"
   ]
  },
  {
   "id": "netflix-originalsmovie",
   "name": "🔴 Netflix Originals",
   "type": "movie",
   "co": [
    "netflix"
   ],
   "prov": [
    "netflix"
   ]
  },
  {
   "id": "netflix-animeseries",
   "name": "🔴 Netflix Anime",
   "type": "series",
   "net": [
    "netflix"
   ],
   "genres": [
    16
   ],
   "lang": "ja"
  },
  {
   "id": "netflix-limited-seriesseries",
   "name": "🔴 Netflix Limited Series",
   "type": "series",
   "net": [
    "netflix"
   ],
   "tvType": 2
  },
  {
   "id": "netflix-supernaturalseries",
   "name": "🔴 Netflix Supernatural",
   "type": "series",
   "net": [
    "netflix"
   ],
   "kw": [
    "supernatural"
   ]
  },
  {
   "id": "netflix-based-on-booksseries",
   "name": "🔴 Netflix Based on Books",
   "type": "series",
   "net": [
    "netflix"
   ],
   "kw": [
    "based on novel or book"
   ],
   "kwIds": [
    818
   ]
  },
  {
   "id": "netflix-award-winningseries",
   "name": "🔴 Netflix Award-Winning",
   "type": "series",
   "net": [
    "netflix"
   ],
   "minRating": 7.6,
   "minVotes": 400,
   "sort": "vote_average.desc"
  },
  {
   "id": "netflix-asian-seriesseries",
   "name": "🔴 Netflix Asian Series",
   "type": "series",
   "net": [
    "netflix"
   ],
   "country": "KR|JP|CN|TH|TW|HK|IN|ID|PH|VN|MY|SG"
  },
  {
   "id": "netflix-animatedmovie",
   "name": "🔴 Netflix Animated",
   "type": "movie",
   "co": [
    "netflix"
   ],
   "prov": [
    "netflix"
   ],
   "genres": [
    16
   ]
  },
  {
   "id": "netflix-documentariesseries",
   "name": "🔴 Netflix Documentaries",
   "type": "series",
   "net": [
    "netflix"
   ],
   "genres": [
    99
   ],
   "prepend": {
    "type": "movie",
    "co": [
     "netflix"
    ],
    "prov": [
     "netflix"
    ],
    "genres": [
     99
    ],
    "minVotes": 5
   }
  },
  {
   "id": "netflix-stand-upmovie",
   "name": "🔴 Netflix Stand-up",
   "type": "movie",
   "co": [
    "netflix"
   ],
   "prov": [
    "netflix"
   ],
   "kw": [
    "stand-up comedy"
   ]
  },
  {
   "id": "netflix-true-storymovie",
   "name": "🔴 Netflix True Story",
   "type": "movie",
   "co": [
    "netflix"
   ],
   "prov": [
    "netflix"
   ],
   "kw": [
    "based on true story",
    "biography"
   ]
  },
  {
   "id": "amazon-mgm-studiosmovie",
   "name": "📦 Amazon MGM Studios",
   "type": "movie",
   "co": [
    "amsStudio"
   ],
   "minVotes": 100
  },
  {
   "id": "prime-originalsseries",
   "name": "📦 Prime Originals",
   "type": "series",
   "net": [
    "prime"
   ]
  },
  {
   "id": "prime-originalsmovie",
   "name": "📦 Prime Originals",
   "type": "movie",
   "co": [
    "amazon"
   ],
   "prov": [
    "prime"
   ]
  },
  {
   "id": "prime-award-winningseries",
   "name": "📦 Prime Award-Winning",
   "type": "series",
   "net": [
    "prime"
   ],
   "minRating": 7.6,
   "minVotes": 400,
   "sort": "vote_average.desc"
  },
  {
   "id": "prime-documentariesmovie",
   "name": "📦 Prime Documentaries",
   "type": "movie",
   "co": [
    "amazon"
   ],
   "prov": [
    "prime"
   ],
   "genres": [
    99
   ]
  },
  {
   "id": "prime-internationalseries",
   "name": "📦 Prime International",
   "type": "series",
   "net": [
    "prime"
   ],
   "country": "GB|FR|DE|ES|IT|IN|JP|KR|BR|MX|AU|CA|SE|NO|DK|FI|NL|BE|PL|TR|CN|TH|TW|AR|CO|CL|ZA|NG|EG|SA|AE|IE|NZ|IL|PT|RU|UA|CZ|AT|CH|ID|PH"
  },
  {
   "id": "prime-animeseries",
   "name": "📦 Prime Anime",
   "type": "series",
   "net": [
    "prime"
   ],
   "genres": [
    16
   ],
   "lang": "ja"
  },
  {
   "id": "prime-animatedmovie",
   "name": "📦 Prime Animated",
   "type": "movie",
   "co": [
    "amazon"
   ],
   "prov": [
    "prime"
   ],
   "genres": [
    16
   ]
  },
  {
   "id": "apple-originalsseries",
   "name": "🍎 Apple Originals",
   "type": "series",
   "net": [
    "apple"
   ]
  },
  {
   "id": "apple-originalsmovie",
   "name": "🍎 Apple Originals",
   "type": "movie",
   "co": [
    "apple"
   ],
   "prov": [
    "apple"
   ]
  },
  {
   "id": "apple-documentariesmovie",
   "name": "🍎 Apple Documentaries",
   "type": "movie",
   "co": [
    "apple"
   ],
   "prov": [
    "apple"
   ],
   "genres": [
    99
   ]
  },
  {
   "id": "apple-limited-seriesseries",
   "name": "🍎 Apple Limited Series",
   "type": "series",
   "net": [
    "apple"
   ],
   "tvType": 2
  },
  {
   "id": "apple-internationalseries",
   "name": "🍎 Apple International",
   "type": "series",
   "net": [
    "apple"
   ],
   "country": "GB|FR|DE|ES|IT|IN|JP|KR|BR|MX|AU|CA|SE|NO|DK|FI|NL|BE|PL|TR|CN|TH|TW|AR|CO|CL|ZA|NG|EG|SA|AE|IE|NZ|IL|PT|RU|UA|CZ|AT|CH|ID|PH"
  },
  {
   "id": "apple-award-winningseries",
   "name": "🍎 Apple Award-Winning",
   "type": "series",
   "net": [
    "apple"
   ],
   "minRating": 7.6,
   "minVotes": 400,
   "sort": "vote_average.desc"
  },
  {
   "id": "apple-animated-seriesseries",
   "name": "🍎 Apple Animated Series",
   "type": "series",
   "net": [
    "apple"
   ],
   "genres": [
    16
   ]
  },
  {
   "id": "starz-originalsseries",
   "name": "⭐ Starz Originals",
   "type": "series",
   "net": [
    "starz"
   ]
  },
  {
   "id": "starz-originalsmovie",
   "name": "⭐ Starz Originals",
   "type": "movie",
   "co": [
    "starz"
   ],
   "prov": [
    "starz"
   ],
   "minVotes": 5
  },
  {
   "id": "amc-originalsseries",
   "name": "🎬 AMC Originals",
   "type": "series",
   "net": [
    "amc"
   ],
   "exclude": [
    "the-walking-dead-universe-s"
   ]
  },
  {
   "id": "amc-limited-seriesseries",
   "name": "🎬 AMC Limited Series",
   "type": "series",
   "net": [
    "amc"
   ],
   "tvType": 2,
   "exclude": [
    "the-walking-dead-universe-s"
   ]
  },
  {
   "id": "the-walking-dead-universe-s",
   "name": "🎬 The Walking Dead Universe",
   "type": "series",
   "shows": [
    "The Walking Dead",
    "Fear the Walking Dead",
    "The Walking Dead: World Beyond",
    "Tales of the Walking Dead",
    "The Walking Dead: Dead City",
    "The Walking Dead: Daryl Dixon",
    "The Walking Dead: The Ones Who Live"
   ]
  },
  {
   "id": "mgm-originalsseries",
   "name": "🎬 MGM+ Originals",
   "type": "series",
   "net": [
    "mgm"
   ]
  },
  {
   "id": "mgm-limited-seriesseries",
   "name": "🎬 MGM+ Limited Series",
   "type": "series",
   "net": [
    "mgm"
   ],
   "tvType": 2
  }
 ]
});
