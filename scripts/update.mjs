// Fetches the alliance roster from kg.dbapp.ru and updates the files in /data
// that the website reads. Runs on a schedule via GitHub Actions (see
// .github/workflows/update.yml). No npm packages needed — plain Node 20+.
//
// What it keeps track of:
//   * a "day baseline" (everyone's PvP damage total at the daily reset)
//   * a "season baseline" (the same, at the start of the season)
// Daily / season damage = total now − baseline. dbapp's total drops at each
// season start, so a total that goes down is treated as a reset. The totals are
// bigger than JavaScript numbers can hold exactly, so all subtraction uses BigInt.
//
// Test hooks (environment variables):
//   FIXTURE=path/to/api-response.json   read this instead of calling dbapp
//   FIXTURE_ACTIVITY=dir                read activity-current.json / activity-<n>.json from here
//   NOW=2026-10-22T05:00:00Z            pretend it is this time
//   DATA_DIR=path                       write somewhere other than ./data

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfill } from './backfill.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const MAX_CHANGES = 400;

// ---------- helpers ----------
const readJson = async (name, fallback) => {
  const p = path.join(DATA, name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (name, obj) => writeFile(path.join(DATA, name), JSON.stringify(obj) + '\n');

// Game day = calendar date (UTC) after shifting by the daily reset hour.
const gameDay = (d) => new Date(d.getTime() - (config.resetHourUTC || 0) * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);
const big = (v) => { try { return BigInt(String(v ?? '0')); } catch { return 0n; } };
const nonNeg = (x) => (x < 0n ? 0n : x);
// Activity score, as KG Companion and the game work it out: PvP damage ÷ max power.
const score = (dmg, maxPower) => (maxPower > 0 ? Number(dmg) / maxPower : 0);
const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;

async function fetchText(url) {
  if (process.env.FIXTURE_ACTIVITY) {
    const u = new URL(url), s = u.searchParams.get('s');
    if (u.pathname.endsWith('/compare')) return readFile(path.join(process.env.FIXTURE_ACTIVITY, 'compare.json'), 'utf8');
    if (u.pathname.endsWith('/kvk')) return readFile(path.join(process.env.FIXTURE_ACTIVITY, 'kvk.json'), 'utf8');
    return readFile(path.join(process.env.FIXTURE_ACTIVITY, `activity-${s || 'current'}.json`), 'utf8');
  }
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'alliance-stats-tracker (GitHub Actions)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchAlliance() {
  if (process.env.FIXTURE) return JSON.parse(await readFile(process.env.FIXTURE, 'utf8'));
  const url = `https://kg.dbapp.ru/api/alliance/${config.allianceId}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'alliance-stats-tracker (GitHub Actions)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
}

// ---------- main ----------
await mkdir(DATA, { recursive: true });

let api;
try {
  api = await fetchAlliance();
} catch (e) {
  // Leave existing data untouched; the site shows "last updated" so a gap is visible.
  console.warn(`Could not reach dbapp (${e.message}). Keeping previous data.`);
  process.exit(0);
}

const alliance = api?.alliance;
const members = Array.isArray(alliance?.members) ? alliance.members : [];
if (!members.length) {
  console.warn('dbapp returned no members — skipping this run so nobody is wrongly marked as leaving.');
  process.exit(0);
}

const state = await readJson('state.json', null);
const prevLatest = await readJson('latest.json', null);
const history = await readJson('history.json', { days: [], players: {} });
let changes = await readJson('changes.json', []);

// Per-day damage straight from KG Companion's Activity feed, so daily figures
// match it exactly however late a scheduled run starts. dayDamage.get(date).get(id)
// = that day's damage (several records on one day are added up; the season-start
// drop shows as a negative and counts as 0). Falls back to snapshots if unavailable.
let dayDamage = null;
try {
  const text = await fetchText(`https://kg.dbapp.ru/api/alliance/${config.allianceId}/activity`);
  const act = JSON.parse(text.replace(/"(pvpDamage|diffDamage|maxPower)":(-?\d+)/g, '"$1":"$2"'));
  if (Array.isArray(act?.activities)) {
    dayDamage = new Map();
    for (const a of act.activities) {
      const d = big(a.diffDamage); if (d <= 0n) continue;
      if (!dayDamage.has(a.date)) dayDamage.set(a.date, new Map());
      const m = dayDamage.get(a.date), id = String(a.characterID);
      m.set(id, (m.get(id) || 0n) + d);
    }
  }
} catch (e) {
  console.warn(`Activity feed unavailable (${e.message}); daily figures use snapshots this run.`);
}
const dayDmgFor = (date, id) => dayDamage ? (dayDamage.get(date)?.get(String(id)) ?? 0n) : null;

// Guard against a half-loaded response wiping the roster.
if (state && Object.keys(state.dayBaseline).length >= 20 && members.length < Object.keys(state.dayBaseline).length * 0.5) {
  console.warn(`Member count fell from ${Object.keys(state.dayBaseline).length} to ${members.length} in one run — looks like a bad response, skipping.`);
  process.exit(0);
}

const today = gameDay(now);
const season = api?.server?.season ?? null;
const snap = (m) => ({ pvp: String(m.pvpDamage ?? '0'), power: Number(m.power) || 0 });
const byId = new Map(members.map((m) => [String(m.id), m]));

// Seasons start on the same date for every server and last a fixed number of
// days, so the current season's start is worked out from one known start date.
const SEASON_LEN = config.seasonLengthDays || 28;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const curSeasonStart = config.seasonAnchorDate
  ? addDays(config.seasonAnchorDate, Math.floor(daysBetween(config.seasonAnchorDate, today) / SEASON_LEN) * SEASON_LEN)
  : null;

let st = state;
const firstRun = !st;
if (firstRun) {
  st = {
    version: 1,
    trackingSince: now.toISOString(),
    season,
    seasonKey: curSeasonStart,
    seasonStartedOn: curSeasonStart === today ? today : null,   // null = tracking began mid-season
    day: today,
    dayBaseline: {},
    seasonBaseline: {},
    known: {},
  };
  for (const [id, m] of byId) {
    st.dayBaseline[id] = snap(m);
    st.seasonBaseline[id] = { ...snap(m), since: today };
    st.known[id] = { name: m.nickname, firstSeen: today };
  }
  console.log(`First run: baselines saved for ${byId.size} members.`);
}

// Older data files predate seasonKey; adopt the current season without a rollover.
if (st.seasonKey === undefined) st.seasonKey = curSeasonStart;

// --- Season rollover: freeze the leaderboard, then start fresh.
// With a known season calendar the date decides; otherwise dbapp's season number does.
const dateRoll = !!(curSeasonStart && st.seasonKey && curSeasonStart !== st.seasonKey);
const numberRoll = !curSeasonStart && season != null && st.season != null && season !== st.season;
if (!firstRun && (dateRoll || numberRoll)) {
  const rows = [];
  for (const [id, base] of Object.entries(st.seasonBaseline)) {
    const m = byId.get(id);
    const prevRow = prevLatest?.members?.find((r) => String(r.id) === id);
    const pvpNow = m ? m.pvpDamage : prevRow?.pvp;
    if (pvpNow == null) continue;
    const power = m ? Number(m.power) : prevRow?.power ?? 0;
    const maxP = m ? Math.max(Number(m.maxPower) || 0, power) : prevRow?.maxPower ?? power;
    const dmg = nonNeg(big(pvpNow) - big(base.pvp));
    rows.push({
      id: Number(id), name: m?.nickname ?? prevRow?.name ?? st.known[id]?.name ?? id,
      rank: m?.allianceRankName ?? prevRow?.rank ?? '', power, maxPower: maxP,
      dmg: Number(dmg), score: round(score(dmg, maxP)),
      partial: base.since !== st.seasonStartedOn,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  await writeJson('prev-season.json', {
    season: st.season, from: st.seasonStartedOn ?? st.trackingSince.slice(0, 10), to: today, rows,
  });
  // dbapp may switch its season number a little early or late; never go backwards.
  const next = dateRoll ? (season != null && season > st.season ? season : st.season + 1) : season;
  console.log(`Season ${st.season} → ${next}: froze ${rows.length} rows.`);
  st.season = next;
  st.seasonKey = curSeasonStart;
  st.seasonStartedOn = curSeasonStart || today;
  st.seasonBaseline = {};
  for (const [id, m] of byId) st.seasonBaseline[id] = { ...snap(m), since: today };
}

// --- Day rollover: record yesterday into history, reset day baseline.
if (!firstRun && today !== st.day) {
  const closing = st.day;
  history.days.push(closing);
  const n = history.days.length;
  for (const [id, m] of byId) {
    const base = st.dayBaseline[id];
    const fromFeed = dayDmgFor(closing, id);
    const dmg = fromFeed != null ? Number(fromFeed) : base ? Number(nonNeg(big(m.pvpDamage) - big(base.pvp))) : null;
    const h = (history.players[id] ??= { n: m.nickname, p: [], d: [] });
    h.n = m.nickname;
    while (h.p.length < n - 1) { h.p.push(null); h.d.push(null); }
    h.p.push(Math.max(Number(m.maxPower) || 0, Number(m.power) || 0));   // max power, same as imported history
    h.d.push(dmg);
  }
  for (const h of Object.values(history.players)) {
    while (h.p.length < n) { h.p.push(null); h.d.push(null); }
  }
  // Trim to the configured window and drop players with nothing left.
  const keep = config.historyDays || 180;
  if (history.days.length > keep) {
    const cut = history.days.length - keep;
    history.days = history.days.slice(cut);
    for (const [id, h] of Object.entries(history.players)) {
      h.p = h.p.slice(cut); h.d = h.d.slice(cut);
      if (h.p.every((v) => v == null)) delete history.players[id];
    }
  }
  st.day = today;
  st.dayBaseline = {};
  for (const [id, m] of byId) st.dayBaseline[id] = snap(m);
  console.log(`New game day ${today}; closed ${closing}.`);
}

// --- Joins and leaves.
if (!firstRun) {
  for (const [id, m] of byId) {
    if (!st.known[id]) {
      st.known[id] = { name: m.nickname, firstSeen: today };
      st.dayBaseline[id] = snap(m);
      st.seasonBaseline[id] = { ...snap(m), since: today };
      changes.push({ t: now.toISOString(), type: 'join', id: Number(id), name: m.nickname, power: Number(m.power) || 0, rank: m.allianceRankName });
    } else {
      st.known[id].name = m.nickname;
      // KG Companion's total covers the last 3 seasons, so it drops when the oldest season falls off; re-baseline when it does.
      if (st.dayBaseline[id] && big(m.pvpDamage) < big(st.dayBaseline[id].pvp)) st.dayBaseline[id] = snap(m);
      if (st.seasonBaseline[id] && big(m.pvpDamage) < big(st.seasonBaseline[id].pvp)) st.seasonBaseline[id] = { ...snap(m), since: today };
    }
  }
  for (const id of Object.keys(st.known)) {
    if (!byId.has(id)) {
      const last = prevLatest?.members?.find((r) => String(r.id) === id);
      changes.push({ t: now.toISOString(), type: 'leave', id: Number(id), name: st.known[id].name, power: last?.power ?? null, rank: last?.rank ?? null });
      delete st.known[id];
      delete st.dayBaseline[id];
      delete st.seasonBaseline[id];
    }
  }
  if (changes.length > MAX_CHANGES) changes = changes.slice(-MAX_CHANGES);
}

// --- One-time import of past days from KG Companion's Activity page.
if (!st.backfilled && config.importHistory !== false) {
  try {
    const prev = await backfill({
      config, st, history, members, today, seasonStart: curSeasonStart,
      score, round, addDays, fetchText, log: (msg) => console.log(msg),
    });
    const existingPrev = await readJson('prev-season.json', null);
    if (prev && !existingPrev) await writeJson('prev-season.json', prev);
    st.backfilled = now.toISOString();
  } catch (e) {
    console.warn(`History import skipped this run (${e.message}); will try again next run.`);
  }
}

// --- Build the rows the site displays.
const rows = members.map((m) => {
  const id = String(m.id);
  const power = Number(m.power) || 0;
  const maxPower = Math.max(Number(m.maxPower) || 0, power);
  const dBase = st.dayBaseline[id];
  const sBase = st.seasonBaseline[id];
  const fromFeed = dayDmgFor(today, id);
  const daily = fromFeed != null ? fromFeed : dBase ? nonNeg(big(m.pvpDamage) - big(dBase.pvp)) : 0n;
  const seasonDmg = sBase ? nonNeg(big(m.pvpDamage) - big(sBase.pvp)) : 0n;
  return {
    id: m.id,
    name: m.nickname,
    rank: m.allianceRankName || '',
    flag: m.flag?.content || '',
    level: m.level ?? null,
    power,
    maxPower,
    pvp: String(m.pvpDamage ?? '0'),
    pvpRate: m.pvpRate ?? null,
    lastOnline: m.lastOnline || null,
    daysOffline: m.lastOnlineDays ?? null,
    deleted: !!m.deleted,
    dailyDmg: Number(daily),
    dailyScore: round(score(daily, maxPower)),
    seasonDmg: Number(seasonDmg),
    seasonScore: round(score(seasonDmg, maxPower)),
    seasonPartial: !!(sBase && st.seasonStartedOn && sBase.since !== st.seasonStartedOn) || !st.seasonStartedOn,
    firstSeen: st.known[id]?.firstSeen ?? today,
  };
});

// Week 0 is the rest week (days 1–7), then Weeks 1–3, matching the in-game calendar.
const seasonStart = curSeasonStart || config.seasonStartDate || st.seasonStartedOn;
let week = null, dayOfWeek = null, dayNumber = null;
if (seasonStart) {
  const d = daysBetween(seasonStart, today);
  if (d >= 0) { dayNumber = d + 1; week = Math.floor(d / 7); dayOfWeek = (d % 7) + 1; }
}
const countingFrom = st.seasonStartedOn || st.trackingSince.slice(0, 10);
const daysCounted = [...new Set([...history.days, today])].filter((d) => d >= countingFrom && (!seasonStart || d >= seasonStart)).sort();

// --- Adjusted score exponent: damage ÷ max power^k.
// k is chosen so account size has no overall effect on the score: it is the
// slope of log(damage) against log(max power) across the alliance. It is
// re-measured once per season, on the first run on or after day 8, from the
// last full season's final leaderboard.
function fitExponent(pairs) {
  const pts = pairs.filter(([mp, d]) => mp > 0 && d > 0).map(([mp, d]) => [Math.log(mp), Math.log(d)]);
  if (pts.length < 20) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const num = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const den = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  if (!den) return null;
  return { k: num / den, players: pts.length };
}
st.adjusted ??= { exponent: config.adjustedExponent ?? 1.4, season: st.season, computedOn: today, basedOn: null, players: null };
// Until the first day-8 re-measure, the exponent follows the starting value in config.json.
if (st.adjusted.basedOn == null && config.adjustedExponent != null) st.adjusted.exponent = config.adjustedExponent;
const recalcDay = config.adjustedRecalcDay ?? 8;
const adjExclude = new Set(config.adjustedExcludeRanks ?? ['R1']);   // alts (R1) are left out of the Adjusted score
if (dayNumber != null && dayNumber >= recalcDay && st.adjusted.season !== st.season) {
  const prev = await readJson('prev-season.json', null);
  // Adjusted leaves out the off week (days 1-7), so measure from each player's damage on days 8 onward.
  const offDays = config.adjustedSkipDays ?? 7;
  const fromDay = prev?.from ? addDays(prev.from, offDays) : null;
  const laterDmg = (id) => {
    const h = history.players[String(id)];
    if (!h || !fromDay) return null;
    const off = history.days.length - h.d.length;
    return history.days.reduce((t, d, i) => (d >= fromDay && d <= prev.to ? t + (h.d[i - off] || 0) : t), 0);
  };
  const fit = prev?.rows ? fitExponent(prev.rows.filter((r) => !adjExclude.has(r.rank) && (r.maxPower ?? r.power) >= (config.adjustedMinPowerT ?? 1) * 1e12).map((r) => [r.maxPower ?? r.power, laterDmg(r.id) ?? r.dmg])) : null;
  if (fit) {
    const k = Math.min(2, Math.max(0.5, Math.round(fit.k * 100) / 100));   // keep it within a sane range
    console.log(`Adjusted exponent re-measured from Season ${prev.season}: ${st.adjusted.exponent} → ${k} (${fit.players} players).`);
    st.adjusted = { exponent: k, season: st.season, computedOn: today, basedOn: prev.season, players: fit.players };
  } else {
    console.log('Adjusted exponent: not enough data from last season to re-measure; keeping', st.adjusted.exponent);
    st.adjusted.season = st.season;   // don't retry every run this season
  }
}

// Alliance-level figures from KG Companion's Compare factions page, for the
// Alliance Stats box. Keeps the previous figures if it can't be reached.
let allianceStats = prevLatest?.allianceStats ?? null;
try {
  const c = JSON.parse(await fetchText(`https://kg.dbapp.ru/api/compare?y=${config.allianceId}`));
  const f = (c?.factions || []).find((x) => x.code === 'y') || c?.factions?.[0];
  if (f && f.countPlayers) {
    allianceStats = {
      startPower: Number(f.startPower) || null,     // total max power when the season started
      maxPower: Number(f.maxPower) || null,         // total max power now
      activePlayers: f.activePlayers ?? null,
      countPlayers: f.countPlayers ?? null,
      pvpRate: f.pvpRate ?? null,                   // alliance-wide PvP index over the last 3 seasons
    };
  }
} catch (e) {
  console.warn(`Alliance stats unavailable (${e.message}); keeping the previous figures.`);
}

// Season wins (BL victories) for the Season highlights tab, newest first.
// Keeps the previous list if KG Companion can't be reached this run.
let wins = prevLatest?.wins ?? null;
try {
  const list = JSON.parse(await fetchText(`https://kg.dbapp.ru/api/alliance/${config.allianceId}/kvk`));
  if (Array.isArray(list)) {
    wins = list.filter((w) => w && w.season != null && w.date)
      .map((w) => ({ season: Number(w.season), date: String(w.date).slice(0, 10) }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
} catch (e) {
  console.warn(`Season wins unavailable (${e.message}); keeping the previous list.`);
}

const latest = {
  fetchedAt: now.toISOString(),
  gameDay: today,
  trackingSince: st.trackingSince,
  season: {
    number: st.season, startedOn: seasonStart || null, length: SEASON_LEN, dayNumber, week, day: dayOfWeek,
    countingFrom, partial: !st.seasonStartedOn, daysCounted,
    trackedFrom: st.seasonStartedOn ? null : st.trackingSince.slice(0, 10),
  },
  alliance: {
    id: alliance.id, name: alliance.name, tag: alliance.label, server: alliance.serverId,
    power: Number(alliance.power) || 0, members: members.length, maxMembers: alliance.maxMembers ?? null,
    techLevel: alliance.techLevel ?? null, kvkWins: alliance.kvkWins ?? null,
  },
  scoreFormula: 'damage / maxPower',
  adjusted: { ...st.adjusted, recalcDay, excludeRanks: [...adjExclude], minPowerT: config.adjustedMinPowerT ?? 1, skipDays: config.adjustedSkipDays ?? 7 },
  wins,
  allianceStats,
  inactiveDays: config.inactiveDays ?? 3,
  members: rows,
};

await writeJson('latest.json', latest);
await writeJson('state.json', st);
await writeJson('history.json', history);
await writeJson('changes.json', changes);
if (!existsSync(path.join(DATA, 'prev-season.json'))) await writeJson('prev-season.json', null);
console.log(`Updated ${rows.length} members at ${now.toISOString()} (game day ${today}, season ${st.season ?? '?'}).`);
