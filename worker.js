// Cloudflare Worker: reads ESPN Fantasy Football data and returns clean JSON.
// Secrets: ESPN_S2, SWID, ANTHROPIC_API_KEY (reads the weekly Reddit chart when it is an image). Vars: LEAGUE_ID, ALLOW_ORIGIN, REDDIT_USER (poster of the weekly trade chart), REDDIT_POST (optional post id).
// Storage: bind a KV namespace named KV (votes, weekly snapshots, cached player values). Everything still runs without it, minus voting and snapshots.
// Views: transactions (default), teams, gotw, standings, totw, trades, values, votes, vote (POST), snapshot (GET/POST)
// Debug: ?debug=league|tx|comm|box|fp|reddit
const API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
const UA = 'Mozilla/5.0 (compatible; suckmacock-hub/1.0)';
const ACTIVITY = { 178: ['FREEAGENT', 'ADD'], 180: ['WAIVER', 'ADD'], 179: ['FREEAGENT', 'DROP'], 181: ['FREEAGENT', 'DROP'], 239: ['FREEAGENT', 'DROP'] };
const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const NFL = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR',
  15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH',
  29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU' };
const OUT = ['QB', 'RB', 'WR', 'TE', 'K'];
const CACHEABLE = ['teams', 'gotw', 'standings', 'totw', 'transactions', 'trades', 'values'];

const json = (d, cors, status = 200, ttl = 300) => new Response(JSON.stringify(d), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': status === 200 && ttl ? `max-age=${ttl}` : 'no-store' }
});
const kvGet = async (env, k) => { if (!env.KV) return null; try { return await env.KV.get(k, 'json'); } catch (e) { return null; } };
const kvPut = async (env, k, v, ttl) => { if (!env.KV) return false; try { await env.KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : {}); return true; } catch (e) { return false; } };
const norm = s => String(s || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const gradeOf = s => s >= .30 ? 'A+' : s >= .20 ? 'A' : s >= .12 ? 'A-' : s >= .06 ? 'B+' : s > -.06 ? 'B' : s >= -.12 ? 'B-' : s >= -.20 ? 'C+' : s >= -.30 ? 'C' : s >= -.40 ? 'C-' : s >= -.55 ? 'D' : 'F';
const r1 = x => Math.round(x * 10) / 10;

// ---------- player value sources ----------
function extractJSON(text, marker) {
  let i = text.indexOf('var ' + marker); if (i < 0) i = text.indexOf(marker + ' =');
  if (i < 0) return null;
  const s = text.indexOf('{', i); if (s < 0) return null;
  let d = 0, str = false, esc = false;
  for (let k = s; k < text.length; k++) {
    const c = text[k];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if (c === '{') d++; else if (c === '}' && --d === 0) return JSON.parse(text.slice(s, k + 1));
  }
  return null;
}
async function fetchFP(scoring) {
  const path = scoring === 'std' ? 'ros-overall' : scoring === 'half' ? 'ros-half-point-ppr-overall' : 'ros-ppr-overall';
  const r = await fetch(`https://www.fantasypros.com/nfl/rankings/${path}.php`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!r.ok) throw new Error('FantasyPros responded ' + r.status);
  const d = extractJSON(await r.text(), 'ecrData');
  const rows = ((d && d.players) || []).map(p => ({ name: p.player_name, rank: +(p.rank_ecr || p.rank_ave), pos: p.pos_rank || '' })).filter(p => p.name && p.rank);
  if (!rows.length) throw new Error('FantasyPros page format changed');
  return rows;
}
function parseChart(text) {
  const rows = []; let vi = -1;
  const clean = s => s.replace(/\*+|~~/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  for (const raw of text.split('\n')) {
    const line = clean(raw); if (!line) continue;
    const tag = (/\b(buy|sell|hold)\b/i.exec(line) || [])[1];
    if (line.includes('|')) {
      const c = line.replace(/^\||\|$/g, '').split('|').map(x => x.trim());
      if (c.every(x => /^:?-{2,}:?$/.test(x))) continue;
      const hi = c.findIndex(x => /^(trade\s*)?(value|score)/i.test(x));
      if (hi >= 0 && !c.some(x => /^\d/.test(x))) { vi = hi; continue; }
      const ni = c.findIndex(x => /^[A-Za-z][A-Za-z'.\-]*(\s+[A-Za-z][A-Za-z'.\-]+)+/.test(x) && !/^(player|name|buy|sell|hold)/i.test(x));
      if (ni < 0) continue;
      const cand = vi >= 0 ? c[vi] : c.find((x, i) => i !== ni && /^\d+(\.\d+)?$/.test(x));
      const v = parseFloat(cand);
      if (isFinite(v)) rows.push({ name: c[ni].replace(/\s*\(.*$/, ''), value: v, tag: tag && tag.toLowerCase() });
    } else {
      const m = /^(?:\d+[.)]\s*)?([A-Z][A-Za-z'.\-]*(?:\s+[A-Za-z][A-Za-z'.\-]+)+?)(?:\s*\([^)]*\))?\s*[-–:]\s*(\d+(?:\.\d+)?)/.exec(line);
      if (m) rows.push({ name: m[1], value: parseFloat(m[2]), tag: tag && tag.toLowerCase() });
    }
  }
  return rows;
}
function imageUrls(post) {
  const dec = u => String(u || '').replace(/&amp;/g, '&');
  const out = [];
  if (post.is_gallery && post.gallery_data && post.media_metadata) {
    for (const it of post.gallery_data.items || []) {
      const m = post.media_metadata[it.media_id];
      if (m && m.m) out.push(`https://i.redd.it/${it.media_id}.${m.m.split('/')[1].replace('jpeg', 'jpg')}`);
    }
  }
  if (!out.length && /\.(jpe?g|png|webp)(\?|$)/i.test(post.url || '')) out.push(dec(post.url));
  if (!out.length) for (const m of String(post.selftext || '').match(/https?:\/\/[^\s)\]]+\.(?:jpe?g|png|webp)/gi) || []) out.push(dec(m));
  if (!out.length) { const s = post.preview && post.preview.images && post.preview.images[0] && post.preview.images[0].source; if (s) out.push(dec(s.url)); }
  return out.slice(0, 6);
}
// The weekly chart is a picture, so Claude reads it once a week and the result is saved in KV.
async function readChartImages(env, urls) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('the chart is an image: add an ANTHROPIC_API_KEY secret so the Worker can read it');
  const prompt = 'These images are a fantasy football trade value chart. List every player shown. Reply with JSON only, no other text, shaped like ' +
    '{"players":[{"name":"Full Name","pos":"WR","value":52.5,"tag":"buy"}]}. "value" is the main trade value or rating number shown for that player ' +
    '(if several number columns exist, use the one labelled value, rating or score). "tag" is buy, sell or hold only if the chart shows one, otherwise omit it. Include all players on every image.';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 8000,
      messages: [{ role: 'user', content: [...urls.map(u => ({ type: 'image', source: { type: 'url', url: u } })), { type: 'text', text: prompt }] }] })
  });
  if (!r.ok) throw new Error('Claude responded ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const text = ((await r.json()).content || []).map(c => c.text || '').join('').replace(/```(?:json)?/g, '');
  const s = text.search(/[\[{]/); if (s < 0) throw new Error('Claude did not return a chart');
  const d = JSON.parse(text.slice(s, Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1));
  return (Array.isArray(d) ? d : d.players || []).map(p => ({ name: p.name, value: +p.value, tag: p.tag && String(p.tag).toLowerCase() })).filter(p => p.name && isFinite(p.value));
}
async function fetchReddit(env, week) {
  const get = async path => {
    let err;
    for (const h of ['https://www.reddit.com', 'https://old.reddit.com']) {
      try { const r = await fetch(h + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); if (r.ok) return await r.json(); err = 'Reddit responded ' + r.status; }
      catch (e) { err = String(e); }
    }
    throw new Error(err);
  };
  const wk = p => { const m = /week\s*(\d+)/i.exec(p.title || ''); return m ? +m[1] : 0; };
  const user = env.REDDIT_USER || 'KyonFantasyFootball';
  let post = null, used = null;
  if (user) {
    const j = await get(`/user/${encodeURIComponent(user)}/submitted.json?limit=100&sort=new`);
    // the newest chart at or before this week (so Week 7's chart is used once it drops, Week 6's until then)
    const posts = ((j.data && j.data.children) || []).map(c => c.data).filter(p => /trade value/i.test(p.title) && wk(p) && wk(p) <= week).sort((a, b) => wk(b) - wk(a));
    if (posts[0]) { post = posts[0]; used = wk(post); }
  }
  if (!post && env.REDDIT_POST) { const j = await get(`/comments/${env.REDDIT_POST}.json`); post = j[0].data.children[0].data; used = wk(post) || null; }
  if (!post) throw new Error('no Reddit post found (set REDDIT_USER)');
  let rows = parseChart(post.selftext || '');
  if (rows.length < 10) {
    try {
      const c = await get(`/comments/${post.id}.json?limit=50`);
      rows = parseChart(((c[1].data && c[1].data.children) || []).map(x => x.data).filter(x => x.author === post.author).map(x => x.body || '').join('\n'));
    } catch (e) { /* ignore */ }
  }
  if (rows.length < 10) {
    const urls = imageUrls(post);
    if (urls.length) {
      const key = `chart:${post.id}`;
      rows = (await kvGet(env, key)) || [];
      if (rows.length < 10) {
        if (!env.KV) throw new Error('the chart is an image; reading it needs the KV storage binding so it is only read once');
        rows = await readChartImages(env, urls);
        if (rows.length >= 10) await kvPut(env, key, rows, 60 * 86400);
      }
    }
  }
  if (rows.length < 10) throw new Error('could not read a chart from the post (it may be an image): ' + (post.url || ''));
  return { week: used, title: post.title, url: post.url, rows };
}
// One table of player values: FantasyPros rank turned into a 0-100 value, the Reddit chart scaled to 0-100, averaged 50/50.
async function getValues(env, week, scoring) {
  const key = `values:${week}:${scoring}`;
  const hit = await kvGet(env, key);
  if (hit) return hit;
  const [fp, rd] = await Promise.allSettled([fetchFP(scoring), fetchReddit(env, week)]);
  const t = { week, scoring, sources: {}, players: {} };
  const P = n => (t.players[norm(n)] = t.players[norm(n)] || {});
  if (fp.status === 'fulfilled') { t.sources.fp = fp.value.length; fp.value.forEach(p => { const e = P(p.name); e.fp = r1(100 * Math.exp(-0.028 * (p.rank - 1))); e.rk = p.pos; }); }
  else t.sources.fpError = String(fp.reason && fp.reason.message || fp.reason).slice(0, 160);
  if (rd.status === 'fulfilled') {
    t.sources.reddit = rd.value.week;
    const mx = Math.max(...rd.value.rows.map(r => r.value), 1);
    rd.value.rows.forEach(r => { const e = P(r.name); e.rd = r1(100 * r.value / mx); if (r.tag) e.tag = r.tag; });
  } else t.sources.redditError = String(rd.reason && rd.reason.message || rd.reason).slice(0, 200);
  const fpOn = t.sources.fp != null, rdOn = t.sources.reddit != null;
  for (const e of Object.values(t.players)) {
    const a = e.fp != null ? e.fp : fpOn ? 1 : null, b = e.rd != null ? e.rd : rdOn ? 2 : null;
    e.v = a != null && b != null ? r1((a + b) / 2) : a != null ? a : b;
  }
  if (Object.keys(t.players).length) await kvPut(env, key, t, 6 * 3600);
  return t;
}

export default {
  async fetch(req, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const q = new URL(req.url).searchParams;
    const view = q.get('view') || 'transactions', debug = q.get('debug');
    const season = q.get('season') || new Date().getFullYear();
    const safe = s => String(s || '').replace(/[^\w-]/g, '').slice(0, 64);
    const tally = v => { const c = [0, 0, 0, 0, 0]; Object.values(v).forEach(x => { if (c[x] != null) c[x]++; }); return c; };

    try {
      // ----- storage-only routes (no ESPN needed) -----
      if (view === 'votes') {
        if (!env.KV) return json({ enabled: false }, cors);
        const out = {}, voter = safe(q.get('voter'));
        for (const id of (q.get('ids') || '').split(',').map(safe).filter(Boolean).slice(0, 30)) {
          const v = (await kvGet(env, `vote:${season}:${id}`)) || {};
          out[id] = { counts: tally(v), mine: v[voter] != null ? v[voter] : null };
        }
        return json({ enabled: true, votes: out }, cors, 200, 0);
      }
      if (view === 'vote' && req.method === 'POST') {
        if (!env.KV) return json({ enabled: false }, cors);
        const b = await req.json(), k = `vote:${season}:${safe(b.trade)}`, voter = safe(b.voter);
        if (!voter) return json({ error: 'no voter' }, cors, 400);
        const v = (await kvGet(env, k)) || {};
        if (b.choice === null) delete v[voter]; else if (Number.isInteger(b.choice) && b.choice >= 0 && b.choice <= 4) v[voter] = b.choice;
        await kvPut(env, k, v);
        return json({ counts: tally(v), mine: v[voter] != null ? v[voter] : null }, cors, 200, 0);
      }
      if (view === 'snapshot') {
        if (!env.KV) return json({ enabled: false }, cors);
        const k = `snap:${season}:${safe(q.get('week'))}`;
        if (req.method === 'POST') {
          if (!(await kvGet(env, k))) {   // first snapshot of the week wins
            const b = await req.json();
            await kvPut(env, k, { at: Date.now(), teams: (b.teams || []).slice(0, 40).map(t => ({ id: +t.id, rank: +t.rank, pct: +t.pct })) });
          }
          return json({ ok: true }, cors, 200, 0);
        }
        return json({ enabled: true, snap: await kvGet(env, k) }, cors, 200, 0);
      }
      if (debug === 'fp') { const rows = await fetchFP(q.get('scoring') || 'ppr'); return json({ count: rows.length, sample: rows.slice(0, 5) }, cors); }
      if (debug === 'reddit') {
        const r = await fetchReddit(env, +q.get('week') || 4);
        return json({ week: r.week, title: r.title, url: r.url, count: r.rows.length, sample: r.rows.slice(0, 6) }, cors);
      }

      const cache = !debug && CACHEABLE.includes(view) && typeof caches !== 'undefined' ? caches.default : null;
      if (cache) { const hit = await cache.match(req.url); if (hit) return hit; }
      const done = res => { if (cache && ctx && res.status === 200) ctx.waitUntil(cache.put(req.url, res.clone())); return res; };

      // ----- ESPN data -----
      const base = `${API}/${season}/segments/0/leagues/${env.LEAGUE_ID || q.get('leagueId')}`;
      const ask = async (qs, extra = {}) => {
        const r = await fetch(base + qs, { headers: { Cookie: `espn_s2=${env.ESPN_S2 || ''}; SWID=${env.SWID || ''}`, ...extra } });
        if (!r.ok) throw new Error('ESPN responded ' + r.status + ' ' + (await r.text()).slice(0, 200));
        return r.json();
      };
      const commFilter = { topics: { filterType: { value: ['ACTIVITY_TRANSACTIONS'] }, limit: 50, limitPerMessageSet: { value: 50 }, offset: 0,
        sortMessageDate: { direction: 'DESC', sortPriority: 1 }, sortFor: { direction: 'DESC', sortPriority: 2 } } };
      const comm = () => ask('/communication/?view=kona_league_communication', { 'X-Fantasy-Filter': JSON.stringify(commFilter) });
      if (debug === 'comm') return json(await comm(), cors);

      const lg = await ask('?view=mTeam&view=mRoster');
      if (debug === 'league') return json(lg, cors);
      const cur = Math.max(1, Math.min(18, lg.scoringPeriodId || (lg.status && lg.status.currentMatchupPeriod) || 1));
      if (debug === 'tx') return json(await ask('?view=mTransactions2&scoringPeriodId=' + cur), cors);

      const name = {};
      (lg.teams || []).forEach(t => name[t.id] = t.name || `${t.location || ''} ${t.nickname || ''}`.trim());
      const first = {};
      (lg.members || []).forEach(m => first[m.id] = m.firstName || m.displayName);
      const info = t => {
        const r = (t.record && t.record.overall) || {};
        const g = (r.wins || 0) + (r.losses || 0) + (r.ties || 0);
        return { id: t.id, team: name[t.id], gm: (t.owners || []).map(o => first[o]).filter(Boolean).join(', '),
          record: `${r.wins || 0}-${r.losses || 0}` + (r.ties ? `-${r.ties}` : ''), wins: r.wins || 0,
          ppg: g ? Math.round((r.pointsFor || 0) / g * 10) / 10 : 0 };
      };
      const byId = {};
      (lg.teams || []).forEach(t => byId[t.id] = info(t));

      const allTx = async () => {
        const weeks = await Promise.all(Array.from({ length: cur + 1 }, (_, w) =>
          ask(`?view=mTransactions2&scoringPeriodId=${w}`).then(j => j.transactions || []).catch(() => [])));
        const seen = new Set();
        return weeks.flat().filter(t => t.status === 'EXECUTED' && (!t.id || (!seen.has(t.id) && seen.add(t.id))));
      };
      const resolvePlayers = async ids => {
        const out = {};
        (lg.teams || []).forEach(t => ((t.roster && t.roster.entries) || []).forEach(en => {
          const p = en.playerPoolEntry && en.playerPoolEntry.player;
          if (p) out[p.id] = { name: p.fullName, pos: POS[p.defaultPositionId] || '', nfl: NFL[p.proTeamId] || '' };
        }));
        const need = ids.filter(i => !out[i]);
        if (need.length) {
          const f = { players: { filterIds: { value: need }, filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, limit: need.length } };
          for (const v2 of ['kona_playercard', 'kona_player_info']) {
            try {
              const pj = await ask('?view=' + v2, { 'X-Fantasy-Filter': JSON.stringify(f) });
              (pj.players || []).forEach(p => { const pp = p.player || p; out[p.id] = { name: pp.fullName, pos: POS[pp.defaultPositionId] || '', nfl: NFL[pp.proTeamId] || '' }; });
              break;
            } catch (e) { /* try the next view */ }
          }
        }
        return out;
      };
      const nm = (P, i) => (P[i] && P[i].name) || (i < 0 ? 'a team defense' : 'player #' + i);
      const scoringKind = async () => {
        try {
          const sj = await ask('?view=mSettings');
          const it = (((sj.settings || {}).scoringSettings || {}).scoringItems || []).find(i => i.statId === 53);
          const pts = it ? +it.points : 1;
          return pts >= 1 ? 'ppr' : pts > 0 ? 'half' : 'std';
        } catch (e) { return 'ppr'; }
      };

      if (view === 'values') {
        const wk = +q.get('week') || cur;
        const t = await getValues(env, wk, await scoringKind());
        return json({ week: wk, sources: t.sources, count: Object.keys(t.players).length }, cors, 200, 600);
      }

      if (view === 'teams') {
        return done(json(Object.values(byId).map(t => ({ id: t.id, name: t.team, owner: t.gm, record: t.record, ppg: t.ppg })), cors));
      }

      if (view === 'gotw') {
        const week = +q.get('week') || cur;
        const mj = await ask(`?view=mMatchupScore&scoringPeriodId=${week}`);
        const games = (mj.schedule || [])
          .filter(m => m.matchupPeriodId === week && m.home && m.away && byId[m.home.teamId] && byId[m.away.teamId])
          .map(m => { const a = byId[m.home.teamId], b = byId[m.away.teamId];
            return { a, b, score: (a.wins + b.wins) * 100 - Math.abs(a.ppg - b.ppg) + (a.ppg + b.ppg) / 10 }; })
          .sort((x, y) => y.score - x.score);
        if (!games.length) return json({ error: 'no matchups found for week ' + week }, cors, 404);
        return done(json({ week, a: games[0].a, b: games[0].b, games: games.length }, cors));
      }

      if (view === 'standings') {
        const sj = await ask('?view=mSettings&view=mMatchupScore');
        const ss = (sj.settings && sj.settings.scheduleSettings) || {};
        const regWeeks = ss.matchupPeriodCount || 14;
        const remaining = (sj.schedule || [])
          .filter(m => m.winner === 'UNDECIDED' && m.matchupPeriodId <= regWeeks && m.home && m.away)
          .map(m => ({ a: m.home.teamId, b: m.away.teamId, w: m.matchupPeriodId }));
        const teams = (lg.teams || []).map(t => {
          const r = (t.record && t.record.overall) || {};
          return { ...byId[t.id], losses: r.losses || 0, ties: r.ties || 0, pf: r1(r.pointsFor || 0),
            pa: r1(r.pointsAgainst || 0), games: (r.wins || 0) + (r.losses || 0) + (r.ties || 0) };
        });
        return done(json({ week: cur, regWeeks, playoffTeams: ss.playoffTeamCount || 6, teams, remaining }, cors));
      }

      if (view === 'totw') {
        const week = +q.get('week') || Math.max(1, cur - 1);
        const bj = await ask(`?view=mMatchup&view=mMatchupScore&view=mBoxscore&scoringPeriodId=${week}`);
        if (debug === 'box') return json(bj, cors);
        const pool = [];
        for (const m of bj.schedule || []) {
          if (m.matchupPeriodId !== week) continue;
          for (const side of [m.home, m.away]) {
            if (!side) continue;
            const entries = (side.rosterForCurrentScoringPeriod || side.rosterForMatchupPeriod || {}).entries || [];
            for (const e of entries) {
              const pe = e.playerPoolEntry || {}, p = pe.player || {}, pos = POS[p.defaultPositionId];
              if (!pos) continue;
              pool.push({ pos, name: p.fullName, pts: r1(pe.appliedStatTotal || 0), nfl: NFL[p.proTeamId] || '', teamId: side.teamId,
                team: name[side.teamId], gm: (byId[side.teamId] || {}).gm || '', started: ![20, 21].includes(e.lineupSlotId) });
            }
          }
        }
        const take = (pos, n) => pool.filter(x => x.pos === pos).sort((a, b) => b.pts - a.pts).slice(0, n);
        const lineup = [...take('QB', 1), ...take('RB', 2), ...take('WR', 2), ...take('TE', 1), ...take('K', 1)];
        return done(json({ week, lineup, scanned: pool.length }, cors));
      }

      // ----- trades: who sent whom to whom, graded, with a note about each roster -----
      if (view === 'trades') {
        const trades = (await allTx()).filter(t => t.type === 'TRADE_ACCEPTED').sort((a, b) => b.proposedDate - a.proposedDate).slice(0, 12);
        const wk = +q.get('week') || cur;
        const vt = await getValues(env, wk, await scoringKind());
        const have = Object.keys(vt.players).length > 0;
        const parts = [];
        if (vt.sources.fp) parts.push('FantasyPros ROS rankings');
        if (vt.sources.reddit) parts.push(`r/fantasyfootball Week ${vt.sources.reddit} trade chart`);
        const source = parts.length === 2 ? `Grades blend ${parts[0]} and the ${parts[1]}, weighted 50/50.`
          : parts.length === 1 ? `Grades use ${parts[0]} only because the other source could not be read.` : 'Grades unavailable: no ranking source could be read.';
        const P = await resolvePlayers([...new Set(trades.flatMap(t => (t.items || []).map(i => i.playerId)))].filter(i => i != null));
        const val = n => { const p = vt.players[norm(n)]; return p && p.v != null ? p : { v: 3, rk: '' }; };
        const rosters = {};
        (lg.teams || []).forEach(t => rosters[t.id] = ((t.roster && t.roster.entries) || []).map(en => {
          const p = (en.playerPoolEntry && en.playerPoolEntry.player) || {};
          return { name: p.fullName, pos: POS[p.defaultPositionId] || '', v: val(p.fullName).v };
        }));
        const DEPTH = [1, .8, .6, .45, .35];
        const tot = a => a.slice().sort((x, y) => y.v - x.v).reduce((s, x, i) => s + x.v * DEPTH[Math.min(i, 4)], 0);

        const out = trades.map(t => {
          const sides = {};
          for (const i of t.items || []) {
            if (i.playerId == null) continue;
            const v = val(nm(P, i.playerId));
            const p = { name: nm(P, i.playerId), pos: (P[i.playerId] || {}).pos || '', nfl: (P[i.playerId] || {}).nfl || '', v: r1(v.v), rk: v.rk || '', tag: v.tag };
            (sides[i.toTeamId] = sides[i.toTeamId] || { gets: [], gives: [] }).gets.push(p);
            (sides[i.fromTeamId] = sides[i.fromTeamId] || { gets: [], gives: [] }).gives.push(p);
          }
          const list = Object.entries(sides).map(([tid, sd]) => {
            const R = tot(sd.gets), S = tot(sd.gives), s = (R - S) / Math.max(R, S, 1);
            const gm = (byId[tid] || {}).gm || name[tid];
            const roster = rosters[tid] || [], got = new Set(sd.gets.map(g => g.name)), bits = [];
            for (const pos of OUT) {
              const a = sd.gets.filter(g => g.pos === pos).sort((x, y) => y.v - x.v)[0];
              if (!a) continue;
              const best = roster.filter(r => r.pos === pos && !got.has(r.name)).sort((x, y) => y.v - x.v)[0];
              if (a.v >= 60 && best && best.v >= 55) bits.push(`stacks the ${pos} room by pairing ${a.name} with ${best.name}`);
              else if (a.v >= 50 && (!best || best.v < 35)) bits.push(`fills a real hole at ${pos} with ${a.name}`);
            }
            for (const pos of OUT) {
              const g = sd.gives.filter(x => x.pos === pos).sort((x, y) => y.v - x.v)[0];
              if (!g || g.v < 50) continue;
              const left = roster.filter(r => r.pos === pos).sort((x, y) => y.v - x.v)[0];
              if (!left || left.v < 40) bits.push(`thins out the ${pos} room by sending away ${g.name}`);
            }
            const gt = sd.gets.slice().sort((x, y) => y.v - x.v)[0], gg = sd.gives.slice().sort((x, y) => y.v - x.v)[0];
            if (gt && gg && sd.gets.length < sd.gives.length && gt.v >= gg.v && !bits.some(b => b.includes(gt.name))) bits.push(`consolidates depth into ${gt.name}`);
            else if (gt && gg && sd.gets.length > sd.gives.length && gt.v < gg.v) bits.push(`swaps a top piece for quantity`);
            const note = bits.length ? `${gm} ${bits.slice(0, 2).join(' and ')}.` : `${gm} makes a depth move that should not change much.`;
            return { teamId: +tid, id: +tid, team: name[tid], gm, gets: sd.gets, total: have ? r1(R) : null, grade: have ? gradeOf(s) : null, note: have ? note : '', s, R, S };
          });
          let verdict = '';
          if (have && list.length === 2) {
            const w = list[0].s >= list[1].s ? list[0] : list[1];
            verdict = Math.abs(w.s) < .06 ? 'Close to a fair swap on the numbers.' : `${w.gm} wins on value, coming out about ${Math.round(w.R - w.S)} points ahead.`;
          }
          return { id: String(t.id), ts: t.proposedDate, verdict, sides: list.map(({ s, R, S, ...rest }) => rest) };
        });
        return done(json({ trades: out, source, sources: vt.sources }, cors));
      }

      // ----- transactions -----
      let tx = await allTx();
      if (!tx.length) {
        try {
          const cj = await comm();
          (cj.topics || []).forEach(tp => (tp.messages || []).forEach(m => {
            const a = ACTIVITY[m.messageTypeId];
            if (!a) return;
            tx.push({ status: 'EXECUTED', type: a[0], teamId: m.for != null ? m.for : m.to, proposedDate: m.date || tp.date, items: [{ type: a[1], playerId: m.targetId }] });
          }));
        } catch (e) { /* feed unavailable */ }
      }
      tx = tx.sort((a, b) => b.proposedDate - a.proposedDate).slice(0, 40);
      const P = await resolvePlayers([...new Set(tx.flatMap(t => (t.items || []).map(i => i.playerId)))].filter(i => i != null));
      const out = tx.map(t => {
        const items = t.items || [];
        if (t.type === 'TRADE_ACCEPTED') {
          const sides = {};
          items.forEach(i => (sides[i.fromTeamId] = sides[i.fromTeamId] || []).push(nm(P, i.playerId)));
          return { type: 'TRADE', text: 'Trade: ' + Object.entries(sides).map(([id, ps]) => `${name[id]} sends ${ps.join(', ')}`).join('; '), ts: t.proposedDate };
        }
        const adds = items.filter(i => i.type === 'ADD').map(i => nm(P, i.playerId));
        const drops = items.filter(i => i.type === 'DROP').map(i => nm(P, i.playerId));
        if (!adds.length && !drops.length) return null;
        const w = String(t.type).startsWith('WAIVER'), parts = [];
        if (adds.length) parts.push(`${w ? 'won' : 'added'} ${adds.join(', ')}`);
        if (drops.length) parts.push(`dropped ${drops.join(', ')}`);
        return { type: w ? 'WAIVER' : adds.length ? 'ADD' : 'DROP', text: `${name[t.teamId]} ${parts.join(' and ')}`, ts: t.proposedDate };
      }).filter(Boolean);
      return done(json(out, cors));
    } catch (e) {
      return json({ error: String(e && e.message || e) }, cors, 502);
    }
  }
};
