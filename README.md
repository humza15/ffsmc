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
