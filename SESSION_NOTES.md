# Session notes — Stick City

Last updated: 2026-06-20

## What this project is
A browser life-sim game (inspired by Stick RPG) that will be the live website.
Walk a stick figure around a city, work for money, train stats, buy the
penthouse to win. Pure static site — no build step, no backend, no dependencies.
Designed so currency can later become a real Solana token (play-to-earn) without
rewriting the game.

## Repos / locations
- **This game:** `~/CascadeProjects/new-site` → GitHub `jmelvin92/new-site` (private)
- **Separate, unrelated tool:** `~/CascadeProjects/Bundle` = `pf-snipe` Solana bot
  (kept fully segregated from this game; has its own double-click launcher
  `Start pf-snipe.command`).

## Tooling state (already set up)
- git ✓, GitHub CLI ✓ (logged in as `jmelvin92`), Node v22 ✓
- We can build + commit + push directly from the terminal.

## Files
```
new-site/
  public/index.html            # HUD, canvas, building modal, win screen, touch controls
  public/assets/styles.css      # all styling
  public/assets/game.js         # the whole game (state, Bank, buildings, render loop)
  README.md
  SESSION_NOTES.md              # this file
```

## What's DONE
1. Project scaffolded, git repo created, pushed to GitHub.
2. Full game built ("Stick City"):
   - Move ← →, enter buildings with ↑/Enter, touch controls on mobile.
   - Stats: Energy, Health, Intelligence, Strength, Charm + Money + day/clock.
   - Buildings: Apartment (sleep/rent), Office (3 job tiers), Gym (Str),
     College (Int), Bar (Chr), Shop (coffee/meal/penthouse).
   - Win goal: own the Penthouse ($3000) AND have $5000 banked.
   - Saves to localStorage; Save/Reset buttons.
   - `Bank` object isolates all money flow → future Solana SPL token swap point.
3. **Renderer overhaul (visual glow-up):** day/night cycle tied to the clock,
   sun/moon arc, stars, drifting clouds, parallax skyline, real road with curb +
   lamps that glow at night, trees/bench/hydrant, themed buildings with awnings
   and lit windows, nicer animated stick figure with shadow.

## Git status to know
- Commit 1: scaffold. Commit 2: "Build Stick City" (game + first renderer).
- **The renderer overhaul (glow-up) is NOT committed yet.** Next session, either
  commit it or keep iterating first.

## How to run locally
```
cd ~/CascadeProjects/new-site
npx serve public
```
Open the printed URL. Hard-refresh (Cmd+Shift+R) after code changes.

## Possible next steps (not started)
- Commit the renderer overhaul.
- More polish: passing cars, weather, custom player look/avatar.
- Go live: connect repo to Cloudflare Pages / Netlify / GitHub Pages (free) so
  every `git push` auto-deploys to a public URL.
- (Later, lawyer-gated) reintroduce play-to-earn via the `Bank` abstraction with
  a real Solana token + anti-bot defenses.

## Important guardrails agreed this session
- No real-money lottery / random-payout "tip jar" (illegal unlicensed gambling +
  money transmission).
- No throwaway memecoin-site factory / rug patterns.
- Play-to-earn only with in-game (no-cash-value) token for v1; real tradeable
  token is a later, legally-reviewed decision.
```
