# Stick City

A tiny stick-figure life sim in the browser — inspired by Stick RPG. Walk around
a small city, work for money, train your stats, and buy your way to the
penthouse. Pure static site: no build step, no dependencies, no backend.

## Play locally

```
npx serve public
```

Then open the URL it prints (e.g. http://localhost:3000).

## Controls

- **← / →** (or A/D) — walk
- **↑ / Enter** (or W) — go inside the building you're standing at
- On-screen buttons appear on touch devices

## Goal

Buy the **Penthouse** ($3000) and reach **$5000** in the bank.

## How it works

```
public/
  index.html          # HUD, canvas, modals
  assets/styles.css   # styling
  assets/game.js      # the whole game (state, render loop, buildings)
```

Stats: Energy, Health, Intelligence, Strength, Charm. Actions cost time/energy/
money; sleeping starts a new day (and charges rent). Progress saves to your
browser's localStorage.

## Future: play-to-earn (not enabled)

All in-game cash flows through the `Bank` object in `game.js`. It's just a number
today. To later back it with a real Solana SPL token, reimplement
`Bank.balance / earn / spend / canAfford` against the player's token account —
nothing else in the game touches money. Deliberately kept that way.

## Deploy

Static — hosts free on Cloudflare Pages, Netlify, or GitHub Pages. Push to
GitHub and connect the repo, or serve `public/` from any static host.
