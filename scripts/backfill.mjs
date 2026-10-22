// One-time import of past daily PvP from KG Companion's alliance "Activity" page.
// Runs automatically from update.mjs until it has succeeded once (state.backfilled).
//
// What it fills in:
//   * history.json   — daily damage and power for every member back through
//                      the last few seasons, so player charts aren't empty
//   * season totals  — the current season counted from its first day instead
//                      of from the day tracking started
//   * prev-season.json — the last finished season, if we didn't record it ourselves
//
// dbapp's activity feed has one record per player per day they changed:
//   { date, pvpDamage (running total), diffDamage (that day's damage), maxPower, characterID }
// Days with no record mean no change. Its running total drops at each season
// start, which shows up as a negative diffDamage; those are treated as 0.

const ACTIVITY = (id, season) =>
  `https://kg.dbapp.ru/api/alliance/${id}/activity${season ? `?s=${season}` : ''}`;

// The totals are too big for normal JavaScript numbers, so quote them before parsing.
const parseBig = (text) =>
  JSON.parse(text.replace(/"(pvpDamage|diffDamage|maxPower)":(-?\d+)/g, '"$1":"$2"'));

const big = (v) => { try { return BigInt(String(v ?? '0')); } catch { return 0n; } };

async function fetchActivity(config, season, fetchText) {
  const text = await fetchText(ACTIVITY(config.allianceId, season));
  const j = parseBig(text);
  if (!Array.isArray(j?.activities)) throw new Error('unexpected activity response');
  return j;
}

/**
 * Mutates st (state) and history in place; returns prev-season data or null.
 * ctx: { config, st, history, members, today, seasonStart, score, round, addDays, fetchText, log }
 */
export async function backfill(ctx) {
  const { config, st, history, members, today, score, round, addDays, fetchText, log } = ctx;
  const current = await fetchActivity(config, null, fetchText);
  const seasons = (current.seasons || []).slice().sort((a, b) => b.season - a.season);
  const cur = seasons.find((s) => s.current) || seasons[0];
  if (!cur) throw new Error('no season list in activity response');

  // Pull every season dbapp lists (normally the current one plus three before it).
  const records = new Map();   // dedupe by record id
  const add = (list) => { for (const a of list) records.set(a.id ?? `${a.characterID}|${a.date}|${a.pvpDamage}`, a); };
  add(current.activities);
  for (const s of seasons) {
    if (s.season === current.selected) continue;
    try { add((await fetchActivity(config, s.season, fetchText)).activities); }
    catch (e) { log(`Could not fetch season ${s.season} activity: ${e.message}`); }
  }

  const memberIds = new Set(members.map((m) => String(m.id)));
  // byPlayer[id] = sorted list of { date, total, diff, maxPower }
  const byPlayer = new Map();
  for (const a of records.values()) {
    const id = String(a.characterID);
    if (!memberIds.has(id)) continue;
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push({ date: a.date, total: big(a.pvpDamage), diff: big(a.diffDamage), maxPower: Number(a.maxPower) || 0 });
  }
  for (const list of byPlayer.values()) list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.total < y.total ? -1 : 1)));

  // ---- daily damage per player per day (several records on one day are added up)
  const daily = new Map();     // id -> Map(date -> BigInt)
  const power = new Map();     // id -> Map(date -> number)
  for (const [id, list] of byPlayer) {
    const d = new Map(), p = new Map();
    for (const r of list) {
      d.set(r.date, (d.get(r.date) || 0n) + (r.diff > 0n ? r.diff : 0n));
      p.set(r.date, r.maxPower);
    }
    daily.set(id, d); power.set(id, p);
  }

  // ---- history.json: add every past day we don't already have
  const keepDays = config.historyDays || 180;
  const allDates = [...new Set([...records.values()].map((a) => a.date))].sort();
  const firstDate = allDates.find((d) => d >= addDays(today, -keepDays)) || allDates[0];
  if (firstDate) {
    const have = new Set(history.days);
    const newDays = [];
    for (let d = firstDate; d < today; d = addDays(d, 1)) if (!have.has(d)) newDays.push(d);
    if (newDays.length) {
      // Rebuild history as date -> value maps, merge, then back to aligned arrays.
      const merged = {};
      for (const [id, h] of Object.entries(history.players)) {
        merged[id] = { n: h.n, p: new Map(), d: new Map() };
        history.days.forEach((day, i) => { merged[id].p.set(day, h.p[i]); merged[id].d.set(day, h.d[i]); });
      }
      for (const m of members) {
        const id = String(m.id);
        const dmap = daily.get(id), pmap = power.get(id);
        if (!dmap) continue;
        const firstSeen = byPlayer.get(id)[0].date;
        const h = (merged[id] ??= { n: m.nickname, p: new Map(), d: new Map() });
        let lastPower = null;
        for (const d of [...newDays, ...history.days].sort()) {
          if (pmap.has(d)) lastPower = pmap.get(d);
          if (!newDays.includes(d) || d < firstSeen) continue;
          h.d.set(d, Number(dmap.get(d) || 0n));
          h.p.set(d, lastPower);
        }
      }
      const days = [...new Set([...history.days, ...newDays])].sort().slice(-keepDays);
      history.days = days;
      history.players = {};
      for (const [id, h] of Object.entries(merged)) {
        const p = days.map((d) => h.p.get(d) ?? null), dd = days.map((d) => h.d.get(d) ?? null);
        if (p.some((v) => v != null) || dd.some((v) => v != null)) history.players[id] = { n: h.n, p, d: dd };
      }
      log(`History: added ${newDays.length} past days (${newDays[0]} to ${newDays.at(-1)}).`);
    }
  }

  // ---- current season: count from its first day
  const seasonStart = cur.dateStart;
  if (seasonStart && seasonStart <= today) {
    let fixed = 0;
    for (const m of members) {
      const id = String(m.id);
      const list = (byPlayer.get(id) || []).filter((r) => r.date >= seasonStart);
      const now = big(m.pvpDamage);
      let base;
      if (list.length) {
        // Add up each day's damage, as KG Companion's own "Season total" does,
        // and set the baseline so total now − baseline equals that sum.
        const sum = list.reduce((s, r) => s + (r.diff > 0n ? r.diff : 0n), 0n);
        base = now - sum;
      } else {
        base = st.seasonBaseline[id] ? big(st.seasonBaseline[id].pvp) : now;
      }
      if (base > now) base = now;                  // never show negative damage
      st.seasonBaseline[id] = { pvp: base.toString(), power: Number(m.power) || 0, since: seasonStart };
      fixed++;
    }
    st.seasonStartedOn = seasonStart;
    st.seasonKey = ctx.seasonStart || seasonStart;
    if (cur.season != null) st.season = cur.season;
    log(`Season ${cur.season}: totals now count from ${seasonStart} for ${fixed} members.`);
  }

  // ---- previous season leaderboard
  const prevInfo = seasons.find((s) => !s.current && s.season === (cur.season - 1));
  let prev = null;
  if (prevInfo) {
    const rows = [];
    for (const m of members) {
      const id = String(m.id);
      const list = (byPlayer.get(id) || []).filter((r) => r.date >= prevInfo.dateStart && r.date < prevInfo.dateEnd);
      if (!list.length) continue;
      const dmg = list.reduce((s, r) => s + (r.diff > 0n ? r.diff : 0n), 0n);
      const pw = list.at(-1).maxPower || Number(m.power) || 0;
      rows.push({ id: m.id, name: m.nickname, rank: m.allianceRankName || '', power: pw, dmg: Number(dmg), score: round(score(dmg, pw)), partial: false });
    }
    rows.sort((a, b) => b.score - a.score);
    prev = { season: prevInfo.season, from: prevInfo.dateStart, to: addDays(prevInfo.dateEnd, -1), rows, source: 'KG Companion' };
    log(`Season ${prevInfo.season}: built final leaderboard for ${rows.length} members.`);
  }

  return prev;
}
