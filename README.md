# Hood Run

A fast, top-down arcade game. Smoke detectors die one by one across the
house — sprint to each dying alarm and swap the battery before its countdown
runs out. Miss three and the run ends. Survive to get promoted to bigger
properties, grab power-ups, and bank Batteries for permanent upgrades.

It's a single static page — **no build step, no dependencies.** Just serve
`public/` over HTTP and play.

## Play
- **Move:** WASD / Arrow keys (d-pad on mobile)
- **Replace battery:** E / Space when you're close
- **Pause:** P

Detectors come in types (normal, fast, stubborn), power-ups drop on the floor
(sneakers = freeze, grape soda = slow-mo, chicken bucket = speed, heart =
life), and clearing save milestones promotes you to larger homes with a higher
score multiplier.

## Run it locally
Serve the `public/` folder over HTTP (absolute asset paths need a real server,
not `file://`):

```bash
python3 -m http.server 8000 --directory public
# then open http://localhost:8000
```

## Deploy
Host the **`public/`** folder at a domain **root** (the game uses absolute
`/assets/...` paths). No build command is required.

- **Netlify:** import the repo — `netlify.toml` sets the publish dir to `public`.
- **Vercel / Cloudflare Pages:** set the output/build directory to `public`,
  leave the build command empty.

Do **not** use a GitHub Pages *project* subpath (`/new-site/`) — it breaks the
absolute asset paths.

### Contract address
`public/assets/config.json` holds the token address shown in-game:

```json
{ "tokenCA": "" }
```

Leave it empty for a "coming soon" placeholder; paste the address after launch
and redeploy — the in-game CA pill updates automatically.

## Project layout
```
public/
  index.html            # markup + overlays (menu, pause, shop, options, guide)
  assets/
    game.js             # all game logic (vanilla JS, deterministic sim)
    styles.css
    config.json         # token CA
    img/keyart.jpg      # main-menu key art
    sprites/player.png  # directional walk-cycle sprite sheet
    audio/              # sd (alarm), music (loop), promote (stinger)
tools/
  make_player_sprite.py # regenerates the player sprite sheet
```

## Dev tools
Append to the URL (only active with `?debug`):
- `?debug` — collision boxes, reachability flood, `ROOMS REACHABLE x/y`
- `?debug&play&house=N` — jump into a seeded run at house tier N
- `?debug&shop` / `?debug&options` / `?debug&guide` — preview those screens
- `?debug&dettest` — determinism self-test (same seed + inputs ⇒ same result)

## Notes
The simulation is **deterministic** (seeded RNG + fixed timestep + recorded
input log) so a run can be re-simulated and verified server-side — the
groundwork for a future on-chain (Solana) verified leaderboard.
