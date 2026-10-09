#!/usr/bin/env node
/**
 * Download real Premier League squads from API-Football (v3) into data/pl/<season>.json
 *
 *   API_FOOTBALL_KEY=your-key node tools/fetch-pl-data.mjs --from 2023 --to 2023
 *
 * Works on the free plan: it asks for one club at a time (about 2 pages each), because the free plan
 * only allows pages 1-3 of any list. Roughly 40 requests per season.
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
 *   --probe          only test which seasons your plan allows (about 1 request each), download nothing
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
const PROBE = !!args.probe;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let remaining = null, lastCall = 0;
const notes = [];            // why a season was not downloaded
let wrote = 0, already = 0;

class QuotaStop extends Error {}

async function api(endpoint, params = {}) {
  if (remaining !== null && remaining <= RESERVE) throw new QuotaStop('daily request limit nearly used');
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

const clean = x => String(x || '').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
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

/** cached GET: a page already saved on disk costs no request */
async function cached(file, endpoint, params) {
  if (await exists(file)) return readJson(file);
  const json = await api(endpoint, params);
  await fs.writeFile(file, JSON.stringify(json));
  return json;
}

async function main() {
  await fs.mkdir(path.join(OUT, '.cache'), { recursive: true });

  // 1) which seasons have player data (one request)
  const coverage = {};
  try {
    const lg = await api('/leagues', { id: LEAGUE });
    for (const s of (lg.response?.[0]?.seasons || [])) coverage[s.year] = !!s.coverage?.players;
    console.log(`Plan check: ${remaining ?? '?'} requests left today.`);
  } catch (e) { console.warn('Could not read league coverage (continuing):', e.message); }

  if (PROBE) {
    const have = Object.entries(coverage).filter(([, v]) => v).map(([y]) => +y).sort((a, b) => a - b);
    if (have.length) console.log(`The API lists player data for ${have[0]} to ${have[have.length - 1]} (${have.length} seasons).`);
    const ok = [], blocked = [];
    for (let season = FROM; season <= TO; season++) {
      try { await api('/teams', { league: LEAGUE, season }); ok.push(season); console.log(`${season}/${String(season + 1).slice(-2)}: allowed on your plan`); }
      catch (e) {
        if (e instanceof QuotaStop) { console.log('Stopped: daily request limit nearly used.'); break; }
        blocked.push(season); console.log(`${season}/${String(season + 1).slice(-2)}: NOT available (${e.message})`);
      }
    }
    console.log(`\nAllowed: ${ok.length ? ok.join(', ') : 'none'}`);
    console.log(`Not allowed: ${blocked.length ? blocked.join(', ') : 'none'}`);
    console.log(`Requests left today: ${remaining ?? 'unknown'}.`);
    return;
  }

  for (let season = FROM; season <= TO; season++) {
    const outFile = path.join(OUT, `${season}.json`);
    if (!FORCE && await exists(outFile)) { console.log(`${season}: already downloaded, skipping`); already++; continue; }
    if (coverage[season] === false) { const m = `${season}: the API lists no player data for this season`; console.log(m + ', skipping'); notes.push(m); continue; }

    console.log(`${season}/${String(season + 1).slice(-2)}: downloading clubs and players...`);
    const teams = [];
    try {
      // 2) the clubs in that season (one request)
      const tj = await cached(path.join(OUT, '.cache', `${season}-teams.json`), '/teams', { league: LEAGUE, season });
      const clubs = (tj.response || []).map(r => ({ id: r.team.id, name: r.team.name }));
      if (!clubs.length) throw new Error('the API returned no clubs for this season');
      console.log(`  ${clubs.length} clubs`);

      // 3) each club's players, 20 per page (a club fits in 1-2 pages, inside the free plan's limit of 3)
      for (const club of clubs) {
        const players = [];
        let page = 1, total = 1;
        while (page <= total) {
          const json = await cached(path.join(OUT, '.cache', `${season}-t${club.id}-p${page}.json`), '/players', { team: club.id, league: LEAGUE, season, page });
          total = json.paging?.total || 1;
          for (const r of (json.response || [])) {
            for (const st of (r.statistics || [])) {
              if (st.league?.id !== LEAGUE || st.team?.id !== club.id) continue;
              const pos = mapPos(st.games?.position);
              if (!pos) continue;
              const minutes = st.games?.minutes || 0;
              players.push({
                id: r.player.id,
                name: clean(r.player.name),
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
          page++;
        }
        // squad fillers who never played add nothing to the game and double the file size
        const played = players.filter(p => p.minutes > 0);
        teams.push({ id: club.id, name: club.name, players: played.sort((a, b) => b.minutes - a.minutes) });
        process.stdout.write(`  ${club.name}: ${players.length} players  (requests left today: ${remaining ?? 'unknown'})\n`);
      }
    } catch (e) {
      if (e instanceof QuotaStop) {
        notes.push(`${season}: stopped because the daily request limit is nearly used (re-run tomorrow; fetched pages are cached)`);
        console.log(`\nStopped: daily request limit nearly used. Re-run tomorrow to finish ${season}; pages already fetched are cached.`);
        break;
      }
      console.log(`\n${season}: ${e.message}`);
      notes.push(`${season}: ${e.message}`);
      if (/season/i.test(e.message) && e.apiErrors?.plan) console.log('  -> your plan does not include this season; try other seasons.');
      continue;
    }

    teams.sort((a, b) => a.name.localeCompare(b.name));
    await fs.writeFile(outFile, JSON.stringify({ season, league: LEAGUE, fetchedAt: new Date().toISOString(), teams }));
    wrote++;
    console.log(`${season}: wrote ${outFile}  (${teams.length} clubs, ${teams.reduce((n, t) => n + t.players.length, 0)} player entries)`);
  }

  if (!wrote && !already) {
    console.error('\nNo season files were written, so nothing will be committed. Reasons:');
    (notes.length ? notes : ['(no error was reported; check the key and the season range)']).forEach(n => console.error('  - ' + n));
    process.exit(2);
  }

  // 4) small index so the game knows which seasons have real data
  const files = (await fs.readdir(OUT)).filter(f => /^\d{4}\.json$/.test(f)).sort();
  const index = [];
  for (const f of files) { const j = await readJson(path.join(OUT, f)); index.push({ season: j.season, clubs: j.teams.length }); }
  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  console.log(`Index: ${index.length} season(s) available. Requests left today: ${remaining ?? 'unknown'}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
