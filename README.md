# Neon Block Breaker

A "Ballz / BBTAN"-style block breaker that runs in the browser on **Mac and iPhone**.
Shoot a stream of bouncing balls at descending numbered blocks, grab powerups,
and don't let the blocks reach the cannon line.

Pure vanilla JS + HTML5 Canvas — no build step, no server required, works offline
as an installable PWA.

## How to play

- **Mac:** move the mouse to aim (the aim line follows your cursor and previews the
  first bounce), **click** to fire.
- **iPhone:** **drag** anywhere to aim, **release** to fire.
- **RECALL** button: instantly pull the balls back and skip to the next round.
- The board drops a **chunk** of rows every couple of turns (revealing layout
  patterns — tunnels, chambers, funnels…). Blocks show a number = hits to destroy.
  Collect tokens: mostly **+1 ball** and **×2 damage** (each ball keeps its own
  damage tier — a ball that grabs several 2× tokens climbs 2→4→8… and changes
  colour), plus occasional **multi-ball**, **laser**, **pierce**, **freeze**, **score ×2**.
- **Rare special blocks:** **splitters** (neon-green, marked with ↔) split into two
  smaller blocks when destroyed, and a **boss** (red 2×2) is armored everywhere except
  one glowing weak cell — funnel your balls into it.
- You lose when a block crosses the dashed line by the cannon.

## Difficulty

Difficulty scales off your **firepower** (total ball damage × a coverage bonus), not
the round number — so blocks get tankier and boards get denser exactly as you grow
stronger, and it's always a challenge no matter how many upgrades you grab. The knobs
live at the top of `js/game.js` (`HP_A`, `HP_P`, `COVERAGE`, `DENS_*`, `SPLIT_CHANCE`,
`BOSS_*`).

## Run it locally

From this folder:

```sh
python3 serve.py
```

`serve.py` disables caching so you always get the latest files. (Plain
`python3 -m http.server` caches aggressively and will keep showing you stale
versions after you edit — avoid it while developing.)

- On the Mac: open <http://localhost:8000>
- On the iPhone (same Wi-Fi): open `http://<your-mac-LAN-IP>:8000`
  (find the IP with `ipconfig getifaddr en0`). In Safari, tap **Share → Add to
  Home Screen** to install it as a fullscreen app that also works offline.

### If you edit the game and don't see the change

The app is a PWA that caches itself for offline play, so after editing you may
need to bust the cache: bump the `CACHE` version in `service-worker.js` (e.g.
`v4` → `v5`) **and** the `?v=` number on the `<script>` tag in `index.html`. On
the phone, remove and re-add the Home Screen icon to pull a fresh copy.

## Deploy (optional, so you don't need the Mac running)

It's all static files, so any static host works — e.g. GitHub Pages, Netlify, or
Cloudflare Pages. Just upload the folder; open the URL on either device and
"Add to Home Screen".

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, HUD, overlays, iOS web-app meta tags |
| `style.css` | Neon theme, fullscreen no-scroll layout, safe-area insets |
| `js/game.js` | All game logic (physics, rendering, input, rounds, powerups) |
| `manifest.webmanifest` | PWA manifest (installable, portrait) |
| `service-worker.js` | Offline caching |
| `icons/` | App icons |

Progress isn't saved between sessions except your **best score** (stored locally in
the browser via `localStorage`).
