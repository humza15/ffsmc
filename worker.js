// Cloudflare Worker: reads ESPN Fantasy Football data and returns clean JSON.
// Secrets (set in Cloudflare, never in GitHub): ESPN_S2, SWID. Vars: LEAGUE_ID, ALLOW_ORIGIN.
// Routes: ?view=transactions (default), ?view=teams, optional ?season=2026
// Debug: ?debug=league | ?debug=tx | ?debug=comm show raw ESPN data.
const API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
// ESPN "recent activity" message codes (fallback feed)
const ACTIVITY = { 178: ['FREEAGENT', 'ADD'], 180: ['WAIVER', 'ADD'], 179: ['FREEAGENT', 'DROP'], 181: ['FREEAGENT', 'DROP'], 239: ['FREEAGENT', 'DROP'] };

export default {
  async fetch(req, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const q = new URL(req.url).searchParams;
    const debug = q.get('debug');
    const cache = !debug && typeof caches !== 'undefined' ? caches.default : null;
    if (cache) { const hit = await cache.match(req.url); if (hit) return hit; }

    const season = q.get('season') || new Date().getFullYear();
    const base = `${API}/${season}/segments/0/leagues/${env.LEAGUE_ID || q.get('leagueId')}`;
    const ask = async (qs, extra = {}) => {
      const r = await fetch(base + qs, { headers: { Cookie: `espn_s2=${env.ESPN_S2 || ''}; SWID=${env.SWID || ''}`, ...extra } });
      if (!r.ok) throw new Error('ESPN responded ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return r.json();
    };
    const commFilter = { topics: { filterType: { value: ['ACTIVITY_TRANSACTIONS'] }, limit: 50, limitPerMessageSet: { value: 50 }, offset: 0,
      sortMessageDate: { direction: 'DESC', sortPriority: 1 }, sortFor: { direction: 'DESC', sortPriority: 2 } } };
    const comm = () => ask('/communication/?view=kona_league_communication', { 'X-Fantasy-Filter': JSON.stringify(commFilter) });
    const done = res => { if (cache && ctx && res.status === 200) ctx.waitUntil(cache.put(req.url, res.clone())); return res; };

    try {
      if (debug === 'comm') return json(await comm(), cors);
      const lg = await ask('?view=mTeam&view=mRoster');
      if (debug === 'league') return json(lg, cors);
      const cur = Math.max(1, Math.min(18, lg.scoringPeriodId || (lg.status && lg.status.currentMatchupPeriod) || 1));
      if (debug === 'tx') return json(await ask('?view=mTransactions2&scoringPeriodId=' + cur), cors);

      const name = {};
      (lg.teams || []).forEach(t => name[t.id] = t.name || `${t.location || ''} ${t.nickname || ''}`.trim());

      if (q.get('view') === 'teams') {
        const first = {};
        (lg.members || []).forEach(m => first[m.id] = m.firstName || m.displayName);
        return done(json((lg.teams || []).map(t => ({
          id: t.id, name: name[t.id], owner: (t.owners || []).map(o => first[o]).filter(Boolean).join(', ')
        })), cors));
      }

      // ESPN only returns transactions when asked one scoring period (week) at a time. Week 0 is the preseason.
      const weeks = await Promise.all(Array.from({ length: cur + 1 }, (_, w) =>
        ask(`?view=mTransactions2&scoringPeriodId=${w}`).then(j => j.transactions || []).catch(() => [])));
      const seen = new Set();
      let tx = weeks.flat().filter(t => t.status === 'EXECUTED' && (!t.id || (!seen.has(t.id) && seen.add(t.id))));

      // Fallback: the "recent activity" feed the ESPN app uses.
      if (!tx.length) {
        try {
          const cj = await comm();
          (cj.topics || []).forEach(tp => (tp.messages || []).forEach(m => {
            const a = ACTIVITY[m.messageTypeId];
            if (!a) return;
            tx.push({ status: 'EXECUTED', type: a[0], teamId: m.for != null ? m.for : m.to, proposedDate: m.date || tp.date,
              items: [{ type: a[1], playerId: m.targetId }] });
          }));
        } catch (e) { /* feed unavailable */ }
      }
      tx = tx.sort((a, b) => b.proposedDate - a.proposedDate).slice(0, 40);

      const ids = [...new Set(tx.flatMap(t => (t.items || []).map(i => i.playerId)))].filter(i => i != null);
      const pl = {};
      (lg.teams || []).forEach(t => ((t.roster && t.roster.entries) || []).forEach(en => {
        const p = en.playerPoolEntry && en.playerPoolEntry.player;
        if (p) pl[p.id] = p.fullName;
      }));
      const need = ids.filter(i => !pl[i]);
      if (need.length) {
        const f = { players: { filterIds: { value: need }, filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, limit: need.length } };
        for (const view of ['kona_playercard', 'kona_player_info']) {
          try {
            const pj = await ask('?view=' + view, { 'X-Fantasy-Filter': JSON.stringify(f) });
            (pj.players || []).forEach(p => pl[p.id] = (p.player && p.player.fullName) || p.fullName);
            break;
          } catch (e) { /* try the next view */ }
        }
      }
      const P = i => pl[i] || (i < 0 ? 'a team defense' : 'player #' + i);

      const out = tx.map(t => {
        const items = t.items || [];
        if (t.type === 'TRADE_ACCEPTED') {
          const sides = {};
          items.forEach(i => (sides[i.fromTeamId] = sides[i.fromTeamId] || []).push(P(i.playerId)));
          const text = 'Trade: ' + Object.entries(sides).map(([id, ps]) => `${name[id]} sends ${ps.join(', ')}`).join('; ');
          return { type: 'TRADE', text, ts: t.proposedDate };
        }
        const adds = items.filter(i => i.type === 'ADD').map(i => P(i.playerId));
        const drops = items.filter(i => i.type === 'DROP').map(i => P(i.playerId));
        if (!adds.length && !drops.length) return null;
        const parts = [];
        if (adds.length) parts.push(`${String(t.type).startsWith('WAIVER') ? 'won' : 'added'} ${adds.join(', ')}`);
        if (drops.length) parts.push(`dropped ${drops.join(', ')}`);
        return { type: String(t.type).startsWith('WAIVER') ? 'WAIVER' : adds.length ? 'ADD' : 'DROP', text: `${name[t.teamId]} ${parts.join(' and ')}`, ts: t.proposedDate };
      }).filter(Boolean);
      return done(json(out, cors));
    } catch (e) {
      return json({ error: String(e) }, cors, 502);
    }
  }
};

const json = (d, cors, status = 200) => new Response(JSON.stringify(d), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': status === 200 ? 'max-age=300' : 'no-store' }
});
