#!/usr/bin/env node
/**
 * Download real Premier League squads from API-Football (v3) into data/pl/<season>.json
 *
 *   API_FOOTBALL_KEY=your-key node tools/fetch-pl-data.mjs --from 2023 --to 2023
 *
 * Needs Node 18+ (built-in fetch). The key is read from the environment, never written to a file.
 *
 * Options
 *   --from 2023      first season (the year the season STARTS, e.g. 2023 = 2023/24)
 *   --to 2023        last season (inclusive). Default: same as --from
 *   --out data/pl    output folder
 *   --delay 6500     milliseconds between requests (stay under the per-minute limit)
 *   --reserve 3      stop cleanly when this many daily requests are left
 *   --force          re-download seasons that already have a file
 *
 * Safe to stop and re-run: pages are cached under <out>/.cache, finished seasons are skipped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY  = process.env.API_FOOTBALL_KEY;
const BASE = process.env.API_BASE || 'https://v3.football.api-sports.io';
const LEAGUE = 39; // Premier League

if (!KEY) { console.error('Set API_FOOTBALL_KEY first, e.g.  API_FOOTBALL_KEY=xxxx node tools/fetch-pl-data.mjs --from 2023'); process.exit(1); }

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => {
  if (x.startsWith('--')) a.push([x.slice(2), (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true]);
  return a;
}, []));
const FROM = +(args.from || new Date().getFullYear() - 1);
const TO = +(args.to || FROM);
const OUT = args.out || 'data/pl';
const DELAY = +(args.delay || 6500);
const RESERVE = +(args.reserve || 3);
const FORCE = !!args.force;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let remaining = null, lastCall = 0;

async function api(endpoint, params = {}) {
  const wait = DELAY - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = new URL(BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  // GET only, and only the one header the API allows
  const res = await fetch(url, { headers: { 'x-apisports-key': KEY } });
  const left = res.headers.get('x-ratelimit-requests-remaining');
  if (left !== null) remaining = +left;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
  const json = await res.json();
  const errs = json.errors;
  const hasErr = Array.isArray(errs) ? errs.length > 0 : errs && Object.keys(errs).length > 0;
  if (hasErr) { const e = new Error(Object.values(errs).join(' | ')); e.apiErrors = errs; throw e; }
  return json;
}

const mapPos = p => ({ Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Attacker: 'FWD' })[p] || null;

/** API average match rating (about 6.0 to 8.0) -> game rating 54..94, pulled toward average for small samples */
function gameRating(apiRating, minutes) {
  const r = apiRating ? parseFloat(apiRating) : NaN;
  const w = Math.min(1, (minutes || 0) / 1800);
  const base = 6.6;
  const blended = Number.isFinite(r) ? w * r + (1 - w) * base : base;
  return Math.max(54, Math.min(94, Math.round(58 + (blended - 6.3) * (32 / 1.3))));
}

async function exists(f) { try { await fs.access(f); return true; } catch { return false; } }
async function readJson(f) { return JSON.parse(await fs.readFile(f, 'utf8')); }

async function main() {
  await fs.mkdir(path.join(OUT, '.cache'), { recursive: true });

  // 1) which seasons exist and have player data (one request)
  let coverage = {};
  try {
    const lg = await api('/leagues', { id: LEAGUE });
    for (const s of (lg.response?.[0]?.seasons || [])) coverage[s.year] = !!s.coverage?.players;
    console.log(`Plan check: ${remaining ?? '?'} requests left today.`);
  } catch (e) { console.warn('Could not read league coverage (continuing):', e.message); }

  for (let season = FROM; season <= TO; season++) {
    const outFile = path.join(OUT, `${season}.json`);
    if (!FORCE && await exists(outFile)) { console.log(`${season}: already downloaded, skipping`); continue; }
    if (coverage[season] === false) { console.log(`${season}: the API lists no player data for this season, skipping`); continue; }

    console.log(`${season}/${String(season + 1).slice(-2)}: downloading players...`);
    const rows = [];
    let page = 1, total = 1, stopped = false;
    try {
      while (page <= total) {
        const cache = path.join(OUT, '.cache', `${season}-p${page}.json`);
        let json;
        if (await exists(cache)) json = await readJson(cache);
        else {
          if (remaining !== null && remaining <= RESERVE) { stopped = true; break; }
          json = await api('/players', { league: LEAGUE, season, page });
          await fs.writeFile(cache, JSON.stringify(json));
        }
        total = json.paging?.total || 1;
        rows.push(...(json.response || []));
        process.stdout.write(`  page ${page}/${total}  (requests left today: ${remaining ?? 'unknown'})\r`);
        page++;
      }
    } catch (e) {
      console.log(`\n${season}: ${e.message}`);
      if (e.apiErrors?.plan) console.log('  -> your plan does not include this season; try other seasons.');
      continue;
    }
    if (stopped) { console.log(`\nStopped: daily request limit nearly used. Re-run tomorrow to finish ${season}; pages already fetched are cached.`); break; }

    // 2) group by club (a player who moved mid-season has stats for each club)
    const clubs = new Map();
    for (const r of rows) {
      for (const st of (r.statistics || [])) {
        if (st.league?.id !== LEAGUE) continue;
        const pos = mapPos(st.games?.position);
        if (!pos) continue;
        const id = st.team.id;
        if (!clubs.has(id)) clubs.set(id, { id, name: st.team.name, players: [] });
        const minutes = st.games?.minutes || 0;
        clubs.get(id).players.push({
          id: r.player.id,
          name: r.player.name,
          nat: r.player.nationality,
          age: r.player.age,
          pos,
          apps: st.games?.appearences || 0,       // (sic) the API spells it this way
          minutes,
          apiRating: st.games?.rating ? +parseFloat(st.games.rating).toFixed(2) : null,
          goals: st.goals?.total || 0,
          assists: st.goals?.assists || 0,
          rating: gameRating(st.games?.rating, minutes)
        });
      }
    }
    const teams = [...clubs.values()]
      .map(c => ({ ...c, players: c.players.sort((a, b) => b.minutes - a.minutes) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    await fs.writeFile(outFile, JSON.stringify({ season, league: LEAGUE, fetchedAt: new Date().toISOString(), teams }, null, 1));
    console.log(`\n${season}: wrote ${outFile}  (${teams.length} clubs, ${teams.reduce((n, t) => n + t.players.length, 0)} player entries)`);
  }

  // 3) small index so the game knows which seasons have real data
  const files = (await fs.readdir(OUT)).filter(f => /^\d{4}\.json$/.test(f)).sort();
  const index = [];
  for (const f of files) { const j = await readJson(path.join(OUT, f)); index.push({ season: j.season, clubs: j.teams.length }); }
  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  console.log(`Index: ${index.length} season(s) available. Requests left today: ${remaining ?? 'unknown'}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
