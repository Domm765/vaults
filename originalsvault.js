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
