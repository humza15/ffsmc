# Suckmacock Hub

iOS web app (PWA) for ESPN league 1944871.

## Deploy on GitHub Pages
1. Create a repo and upload everything in this folder (keep the folder structure).
2. Repo Settings > Pages > Deploy from branch > `main` / root.
3. Open the Pages URL in Safari, tap Share > Add to Home Screen.

## Update content (no code)
- Weekly rankings: upload the image to `rankings/`, add an entry to `data/league.json`.
- Champions and history: edit `data/league.json`.
- Content changes show up the next time the app opens with a connection.

## Push an app update with a prompt
1. Change `VERSION` in `sw.js` and `APP_VERSION` + `CHANGELOG` in `index.html`.
2. Commit. Users see the "A new version is ready" banner and tap Update.

## Live ESPN transactions
Transactions show sample data until `espnProxy` in `data/league.json` points to a proxy.
ESPN blocks direct browser requests (CORS), and private leagues need your `espn_s2` and `SWID` cookies,
so a small Cloudflare Worker holds them and returns JSON: `[{ "type": "ADD", "text": "...", "ts": 1760000000000 }]`.
Never put those cookies in this repo.

## Power rankings folder
Upload images to `rankings/` named like `2026-week-04.jpg`. The app lists the folder through GitHub's API
(auto-detected on `username.github.io/repo`; on a custom domain set `githubRepo` to `username/repo` in `data/league.json`).
Home shows the newest name, the Rankings tab shows all.

## ESPN Worker setup (worker/)
1. Sign in to ESPN Fantasy on a computer browser, open developer tools > Application (or Storage) > Cookies > espn.com,
   and copy the values of `espn_s2` and `SWID`.
2. In Cloudflare (free account): Workers & Pages > Create > Worker. Paste `worker/worker.js`. Deploy.
   Or use the CLI: `wrangler secret put ESPN_S2`, `wrangler secret put SWID`, `wrangler deploy`.
3. In the Worker's Settings > Variables: add secrets `ESPN_S2` and `SWID`, plus text vars `LEAGUE_ID` = 1944871 and `ALLOW_ORIGIN` = `*`.
4. Test in Safari: `YOUR-WORKER-URL/?view=teams&season=2026`, then `?debug=1` if anything looks off.
5. Put the Worker URL in `espnProxy` in `data/league.json`. The SAMPLE badge disappears and team names fill the Game of the Week.
Later, set `ALLOW_ORIGIN` to your Pages origin (for example `https://username.github.io`).

## Files you edit
- `data/league.json`: week number, Game of the Week, team list, ESPN Worker URL.
- `data/champions.json`: one entry per season (add the new champion at the top).
Each is separate, so a typo in one can't break the other. The app shows a red bar if a file can't be read.

## Releasing an update
Change `APP_VERSION` in `index.html` (and `VERSION` in `sw.js` to match), commit, and users see an Update banner.
"Check for updates" in the ESPN tab compares against the version on GitHub and tells you the result.

## Where the data files can live
The app looks for `data/league.json` and `data/champions.json` first, then `league.json` and `champions.json` in the main folder.
If the app shows a red bar, it lists the exact addresses it tried.

## Transaction checks
Each phone asks the Worker at most once every 4 hours (about morning, afternoon, evening and night) and remembers the last result.
The Moves tab has a Refresh now button. To change the timing, edit `TX_TTL` in `index.html`.

## Themes
Settings > Themes: Dark, Light, Bengals Orange, Bengals Black, Ravens Purple, Ravens Black. Each phone remembers its choice.

## Week and Game of the Week
- The week in the header rolls over every Tuesday at 6 AM. Set `seasonStart` in `data/league.json` to the Tuesday before Week 1 each season.
- Game of the Week is picked by the Worker each week (best combined records, similar scoring breaks ties).
  To hand-pick one, set `gameOfTheWeek` in `data/league.json` with a matching `week`.
- Tapping the banner opens a preview. Add your own text to `data/previews.json` under `"season-week"` (for example `"2026-5"`).
  Without one, the app builds a short preview from records and scoring.
