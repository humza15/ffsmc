# The League (Suckmacock Hub)

Installable iPhone web app on GitHub Pages, backed by one Cloudflare Worker (`worker/worker.js`).

## Files you edit
- `data/league.json`: season, `seasonStart` (the Tuesday before Week 1), Game of the Week override, ESPN Worker URL.
- `data/champions.json`: one entry per season.
- `data/previews.json`: hand-written Game of the Week previews, keyed like `"2026-5"`. They win over the AI preview.
- `data/commish-thoughts.json`: commissioner notes by trade id (see COMMISH.md).
- `rankings/`: power ranking images named like `2026-week-05.jpg`.
Each data file also has a built-in copy in `index.html`, used only if the file can't be found.

## Releasing an update
Change `APP_VERSION` in `index.html` and `VERSION` in `sw.js` to match, commit, and users see an Update banner.
Weeks roll over every Tuesday at 8 AM Eastern.

## Worker setup (Cloudflare)
- Secrets: `ESPN_S2`, `SWID` (ESPN login cookies), `GEMINI_API_KEY` (aistudio.google.com/apikey).
- Variables: `LEAGUE_ID` = 1944871, `ALLOW_ORIGIN` = `*` (later your Pages address), optional `GEMINI_MODEL` (default `gemini-2.5-flash`).
- KV: create a namespace and bind it to the Worker with the variable name `KV`.
- Checks: `?debug=gemini` tests the AI key. `?debug=tradelog&season=2026&week=5` lists every trade record, the activity feed, and the trades the app shows.

## What the Worker does
| View | Used for | Notes |
|---|---|---|
| `transactions` | Home and League tab lists | adds, drops, waivers, trades |
| `teams` | team picker, Game of the Week names | |
| `standings` | standings table, playoff odds, snapshots | odds are computed in the app |
| `totw` | Team of the Week | best lineup of the last completed week |
| `gotw` | Game of the Week pick | best combined records |
| `values` | warms FantasyPros values | own request to keep trades light |
| `trades` | Trades section | completed trades, grades from FantasyPros values |
| `tradeai` | trade summary | Gemini, only for trades on screen, saved per trade |
| `gotwai` | Game of the Week preview | Gemini, only when the preview is opened, saved per week |
| `snapshot` | rank and odds arrows | one snapshot per week |

Trade values come only from FantasyPros. If FantasyPros can't be read, trades still list but without grades or AI summaries, and the card says why.

## KV keys the Worker uses
`txhist:<season>` (finished weeks of transactions, saved once), `players` (names of every player seen), `fp:<week>:<scoring>` (FantasyPros values, 6 hours),
`tradectx` (details for AI summaries, newest 40), `ai:trade:<id>:<sig>` and `ai:gotw:<season>:<week>:<a>:<b>` (AI text), `snap:<season>:<week>`.
Leftovers from older versions that can be deleted in the Cloudflare dashboard (KV > your namespace > View): keys starting with `vote:`, `chart:` and `values:`.
You can also delete the `ANTHROPIC_API_KEY` secret and any `REDDIT_USER`, `REDDIT_POST` or `CLAUDE_MODEL` variables.

## Backup
The version before this cleanup is in `backup-0.7.1/` (outside the site folder).
