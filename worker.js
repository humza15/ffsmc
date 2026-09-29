// Cloudflare Worker: reads ESPN Fantasy Football data and returns clean JSON.
// Secrets (set in Cloudflare, never in GitHub): ESPN_S2, SWID. Vars: LEAGUE_ID, ALLOW_ORIGIN.
// Routes: ?view=transactions (default), ?view=teams, ?debug=1 (raw ESPN data). Optional ?season=2026
const API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const q = new URL(req.url).searchParams;
    const season = q.get('season') || new Date().getFullYear();
    const base = `${API}/${season}/segments/0/leagues/${env.LEAGUE_ID || q.get('leagueId')}`;
    const ask = async (qs, extra = {}) => {
      const r = await fetch(base + qs, { headers: { Cookie: `espn_s2=${env.ESPN_S2 || ''}; SWID=${env.SWID || ''}`, ...extra } });
      if (!r.ok) throw new Error('ESPN responded ' + r.status);
      return r.json();
    };
    try {
      const lg = await ask('?view=mTeam&view=mTransactions2');
      if (q.get('debug')) return json(lg, cors);
      const name = {};
      (lg.teams || []).forEach(t => name[t.id] = t.name || `${t.location || ''} ${t.nickname || ''}`.trim());

      if (q.get('view') === 'teams') {
        const first = {};
        (lg.members || []).forEach(m => first[m.id] = m.firstName || m.displayName);
        return json((lg.teams || []).map(t => ({
          id: t.id, name: name[t.id], owner: (t.owners || []).map(o => first[o]).filter(Boolean).join(', ')
        })), cors);
      }

      const tx = (lg.transactions || []).filter(t => t.status === 'EXECUTED')
        .sort((a, b) => b.proposedDate - a.proposedDate).slice(0, 40);
      const ids = [...new Set(tx.flatMap(t => (t.items || []).map(i => i.playerId)))];
      const pl = {};
      if (ids.length) {
        const f = { players: { filterIds: { value: ids }, limit: ids.length } };
        const pj = await ask('?view=kona_player_info', { 'X-Fantasy-Filter': JSON.stringify(f) });
        (pj.players || []).forEach(p => pl[p.id] = (p.player && p.player.fullName) || p.fullName);
      }
      const P = i => pl[i] || 'a player';

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
        if (adds.length) parts.push(`${t.type === 'WAIVER' ? 'won' : 'added'} ${adds.join(', ')}`);
        if (drops.length) parts.push(`dropped ${drops.join(', ')}`);
        return { type: t.type === 'WAIVER' ? 'WAIVER' : adds.length ? 'ADD' : 'DROP', text: `${name[t.teamId]} ${parts.join(' and ')}`, ts: t.proposedDate };
      }).filter(Boolean);
      return json(out, cors);
    } catch (e) {
      return json({ error: String(e) }, cors, 502);
    }
  }
};

const json = (d, cors, status = 200) => new Response(JSON.stringify(d), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=120' }
});
