/* Hood Run — a tiny top-down arcade game.
 * Vanilla JS, no build step, no dependencies. Deploys as a static file.
 *
 * A smoke detector's battery dies → its room flashes red and chirps. Run there
 * and replace the battery before the countdown ring empties. Miss it and the
 * alarm blows; three misses ends the run. Deaths speed up as you go.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const BEST_KEY = 'smokerush.best.v1';

  // ---------- Canvas ----------
  // W/H are the logical view (gameplay zoom). The backing store is oversampled
  // by DPR so the canvas stays crisp when scaled up to a big display.
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const W = 960, H = 600;
  const DPR = Math.max(2, Math.min(2.5, (window.devicePixelRatio || 1) * 1.5));
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);

  // ---------- Determinism (for verifiable replays / on-chain leaderboard) ----------
  // The simulation is fully deterministic: given the same seed + the same input
  // log, it reproduces the same run bit-for-bit. A server can re-run it to verify
  // a submitted score. Keep ALL gameplay randomness on rng() (never Math.random)
  // and ALL gameplay distance checks on squared values or Math.sqrt (never
  // Math.hypot, which isn't bit-stable across JS engines).
  const SIM_VERSION = 'hr-sim-1';
  const FIXED_DT = 1 / 60;                 // fixed simulation timestep
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = mulberry32(1);                 // replaced per-run in resetGame()
  let runSeed = 1, simTick = 0, simAcc = 0;
  let inputLog = [];                       // [ [tick, code, down], ... ]
  let pendingInputs = [];                  // inputs queued since the last sim step
  let lastRun = null;                      // run record assembled at game over
  // input codes: 0 left, 1 right, 2 up, 3 down, 4 action
  function clearInputs() { pendingInputs.length = 0; keys.left = keys.right = keys.up = keys.down = false; }
  function queueInput(code, down) { pendingInputs.push([code, down ? 1 : 0]); }
  function applyInput(code, down) {
    if (code === 0) keys.left = !!down;
    else if (code === 1) keys.right = !!down;
    else if (code === 2) keys.up = !!down;
    else if (code === 3) keys.down = !!down;
    else if (code === 4 && down) tryReplace();
  }

  // ---------- House geometry (rebuilt per house size) ----------
  const HX = 24, HY = 24;                           // house top-left margin (world units)
  const ROOM_W = 304, ROOM_H = 276;                 // fixed room size
  const WALLT = 14;                                 // wall thickness
  const DOOR = 78;                                  // doorway gap
  const REACH = 64;                                 // base replace radius (perks extend it)

  let COLS = 3, ROWS = 2;                           // current grid — set by buildHouse()
  let roomW = ROOM_W, roomH = ROOM_H;
  let HW = COLS * ROOM_W, HH = ROWS * ROOM_H;
  let rooms = [], walls = [], detectors = [];

  // Properties you get promoted through as you survive (endless, escalating).
  const HOUSES = [
    { name: 'Apartment', cols: 2, rows: 2, mult: 1.0 },
    { name: 'House',      cols: 3, rows: 2, mult: 1.3 },
    { name: 'Big House',  cols: 3, rows: 3, mult: 1.7 },
    { name: 'Mansion',    cols: 4, rows: 3, mult: 2.2 },
    { name: 'Tower',      cols: 4, rows: 4, mult: 3.0 },
  ];
  const PROMOTE_AT = [0, 8, 20, 36, 56];            // saves needed for each house index
  let houseIdx = 0;

  const THEMES = [
    { name: 'Kitchen',     emoji: '🍳', floor: '#54564a', floorStyle: 'tile' },
    { name: 'Living Room', emoji: '🛋️', floor: '#6b5238', floorStyle: 'plank' },
    { name: 'Bedroom',     emoji: '🛏️', floor: '#5e544a', floorStyle: 'carpet' },
    { name: 'Bathroom',    emoji: '🛁', floor: '#46585b', floorStyle: 'tileSm' },
    { name: 'Office',      emoji: '💻', floor: '#63502f', floorStyle: 'plank' },
    { name: 'Garage',      emoji: '🚗', floor: '#43464c', floorStyle: 'concrete' },
  ];

  // Where each room's ceiling detector hangs — over the room's focal fixture
  // (island, sofa, bed, car…), as room fractions. Verified reachable via ?debug.
  const DET_SPOTS = {
    'Kitchen': [0.50, 0.32], 'Living Room': [0.50, 0.46], 'Bedroom': [0.37, 0.50],
    'Bathroom': [0.50, 0.44], 'Office': [0.50, 0.44], 'Garage': [0.30, 0.42],
  };

  // Rooms + their detector positions (rebuilt by buildHouse)
  function buildRooms() {
    rooms = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const rx = HX + c * roomW, ry = HY + r * roomH;
        const theme = THEMES[i % THEMES.length];
        const spot = DET_SPOTS[theme.name] || [0.5, 0.12];
        rooms.push({
          i, theme,
          x: rx + WALLT / 2, y: ry + WALLT / 2, w: roomW - WALLT, h: roomH - WALLT,
          cx: rx + roomW / 2, cy: ry + roomH / 2,
          detX: rx + roomW * spot[0], detY: ry + roomH * spot[1],
        });
      }
    }
  }

  // ---------- Walls (as solid rectangles, with doorway gaps) ----------
  function vWall(x, y0, y1, gaps) {
    const out = [], sorted = gaps.slice().sort((a, b) => a - b);
    let cur = y0;
    for (const gc of sorted) {
      const gs = gc - DOOR / 2, ge = gc + DOOR / 2;
      if (gs > cur) out.push({ x, y: cur, w: WALLT, h: gs - cur });
      cur = ge;
    }
    if (cur < y1) out.push({ x, y: cur, w: WALLT, h: y1 - cur });
    return out;
  }
  function hWall(y, x0, x1, gaps) {
    const out = [], sorted = gaps.slice().sort((a, b) => a - b);
    let cur = x0;
    for (const gc of sorted) {
      const gs = gc - DOOR / 2, ge = gc + DOOR / 2;
      if (gs > cur) out.push({ x: cur, y, w: gs - cur, h: WALLT });
      cur = ge;
    }
    if (cur < x1) out.push({ x: cur, y, w: x1 - cur, h: WALLT });
    return out;
  }

  function buildWalls() {
    let out = [
      { x: HX, y: HY, w: HW, h: WALLT },                        // top
      { x: HX, y: HY + HH - WALLT, w: HW, h: WALLT },           // bottom
      { x: HX, y: HY, w: WALLT, h: HH },                        // left
      { x: HX + HW - WALLT, y: HY, w: WALLT, h: HH },           // right
    ];
    for (let c = 1; c < COLS; c++) {                            // interior vertical walls
      const wx = HX + c * roomW - WALLT / 2, gaps = [];
      for (let r = 0; r < ROWS; r++) gaps.push(HY + r * roomH + roomH / 2);
      out = out.concat(vWall(wx, HY, HY + HH, gaps));
    }
    for (let r = 1; r < ROWS; r++) {                            // interior horizontal walls
      const wy = HY + r * roomH - WALLT / 2, gaps = [];
      for (let c = 0; c < COLS; c++) gaps.push(HX + c * roomW + roomW / 2);
      out = out.concat(hWall(wy, HX, HX + HW, gaps));
    }
    return out;
  }

  // ---------- Furniture collision ----------
  // Furniture geometry is the single source of truth: each room's builder pushes
  // footprint rects, which feed BOTH the renderer (drawFurniture) and the solid
  // obstacle list below. We then carve a walkable channel out of every doorway
  // so big furniture can never seal a room off.
  const solids = [];
  const DEBUG = /[?&]debug/.test(location.search);
  const R = (a) => ({ x: a[0], y: a[1], w: a[2], h: a[3] });

  function buildDoorZones() {
    const z = [], PASS = 72, half = DOOR / 2;
    for (let c = 1; c < COLS; c++) {                 // vertical walls -> horizontal passages
      const wx = HX + c * roomW - WALLT / 2;
      for (let r = 0; r < ROWS; r++) {
        const gc = HY + r * roomH + roomH / 2;
        z.push({ x: wx - PASS, y: gc - half, w: WALLT + 2 * PASS, h: DOOR });
      }
    }
    for (let r = 1; r < ROWS; r++) {                 // horizontal walls -> vertical passages
      const wy = HY + r * roomH - WALLT / 2;
      for (let c = 0; c < COLS; c++) {
        const gc = HX + c * roomW + roomW / 2;
        z.push({ x: gc - half, y: wy - PASS, w: DOOR, h: WALLT + 2 * PASS });
      }
    }
    return z;
  }

  function subtractRect(s, z) {
    const ix0 = Math.max(s.x, z.x), iy0 = Math.max(s.y, z.y);
    const ix1 = Math.min(s.x + s.w, z.x + z.w), iy1 = Math.min(s.y + s.h, z.y + z.h);
    if (ix0 >= ix1 || iy0 >= iy1) return [s];        // no overlap
    const out = [];
    if (s.y < iy0) out.push({ x: s.x, y: s.y, w: s.w, h: iy0 - s.y });
    if (iy1 < s.y + s.h) out.push({ x: s.x, y: iy1, w: s.w, h: s.y + s.h - iy1 });
    if (s.x < ix0) out.push({ x: s.x, y: iy0, w: ix0 - s.x, h: iy1 - iy0 });
    if (ix1 < s.x + s.w) out.push({ x: ix1, y: iy0, w: s.x + s.w - ix1, h: iy1 - iy0 });
    return out;
  }
  function subtractZones(s, zones) {
    let cur = [s];
    for (const z of zones) { const nxt = []; for (const c of cur) nxt.push(...subtractRect(c, z)); cur = nxt; }
    return cur;
  }

  function furnitureFor(rm, S) {
    switch (rm.theme.name) {
      case 'Kitchen': rKitchen(rm, S); break;
      case 'Living Room': rLiving(rm, S); break;
      case 'Bedroom': rBedroom(rm, S); break;
      case 'Bathroom': rBathroom(rm, S); break;
      case 'Office': rOffice(rm, S); break;
      case 'Garage': rGarage(rm, S); break;
    }
  }
  function buildSolids() {
    solids.length = 0;
    const raw = [];
    for (const rm of rooms) furnitureFor(rm, raw);
    const zones = buildDoorZones();
    for (const s of raw) {
      for (const piece of subtractZones(s, zones)) {
        if (piece.w > 6 && piece.h > 6) solids.push(piece);
      }
    }
  }

  // ---------- Detectors ----------
  function makeDetectors() {
    detectors = rooms.map((rm) => ({
      room: rm, x: rm.detX, y: rm.detY, state: 'ok', fuse: 0, grace: 0,
      chirpsLeft: 0, chirpTimer: 0, type: 'normal', presses: 1,
    }));
  }

  // Rebuild the whole house at a given grid size (used at boot + on promotion).
  function buildHouse(cols, rows) {
    COLS = cols; ROWS = rows; roomW = ROOM_W; roomH = ROOM_H;
    HW = COLS * ROOM_W; HH = ROWS * ROOM_H;
    buildRooms(); walls = buildWalls(); buildSolids(); makeDetectors();
    reachInfo = null;
  }
  const worldW = () => HX * 2 + HW;
  const worldH = () => HY * 2 + HH;

  // ---------- Player ----------
  const player = { x: HX + HW / 2, y: HY + HH / 2, speed: 250, facing: 1, dir: 'down', walkPhase: 0, radius: 12 };

  // ---------- Camera (follows player for houses bigger than the viewport) ----------
  const cam = { x: 0, y: 0 };
  function updateCamera() {
    const ww = worldW(), wh = worldH();
    cam.x = ww <= W ? (ww - W) / 2 : clamp(player.x - W / 2, 0, ww - W);
    cam.y = wh <= H ? (wh - H) / 2 : clamp(player.y - H / 2, 0, wh - H);
  }

  // ---------- Persistent economy + perks ----------
  const BANK_KEY = 'smokerush.bank.v1', PERK_KEY = 'smokerush.perks.v1';
  const EARN_RATE = 0.3;              // Batteries banked per point of score
  let bank = +(localStorage.getItem(BANK_KEY) || 0);
  const PERKS = [
    { key: 'speed', name: 'Fast Feet',    desc: '+8% move speed',   max: 5, cost: (l) => 120 + l * 110 },
    { key: 'grace', name: 'Steady Hands', desc: '+0.6s to react',   max: 4, cost: (l) => 150 + l * 120 },
    { key: 'reach', name: 'Long Arms',    desc: '+10 reach radius', max: 4, cost: (l) => 110 + l * 100 },
    { key: 'lives', name: 'Nine Lives',   desc: '+1 starting life', max: 2, cost: (l) => 400 + l * 400 },
  ];
  let perks = loadPerks();
  function loadPerks() {
    let p = {}; try { p = JSON.parse(localStorage.getItem(PERK_KEY) || '{}'); } catch (e) {}
    for (const d of PERKS) p[d.key] = p[d.key] || 0;
    return p;
  }
  function saveProgress() {
    try { localStorage.setItem(BANK_KEY, String(bank)); localStorage.setItem(PERK_KEY, JSON.stringify(perks)); } catch (e) {}
  }

  // ---------- Power-ups ----------
  const POWERUPS = {
    freeze: { icon: '👟', color: '#5bd6ff' },
    speed:  { icon: '🍗', color: '#ffd24a' },
    slow:   { icon: '🥤', color: '#b98cff' },
    heart:  { icon: '❤', color: '#ff7b7b' },
  };

  // ---------- Game state ----------
  let mode = 'start';                 // 'start' | 'play' | 'over'
  let score = 0, saved = 0, lives = 3, maxLives = 3, combo = 0, bestCombo = 0;
  let best = +(localStorage.getItem(BEST_KEY) || 0);
  let spawnTimer = 0;                  // seconds until next battery dies
  let muted = false;
  let powerups = [], powerupTimer = 9;
  const effects = { freeze: 0, speed: 0, slow: 0 };

  function baseSpeed() { return 250 * (1 + 0.08 * perks.speed); }
  function effReach() { return REACH + perks.reach * 10; }
  function startLives() { return 3 + perks.lives; }
  function houseMult() { return HOUSES[houseIdx].mult; }
  function level() { return 1 + Math.floor(saved / 6); }
  function spawnInterval() { return clamp(5.4 - level() * 0.45, 1.4, 5.4); }
  function graceTime() { return clamp(9 - level() * 0.5, 4, 9) + perks.grace * 0.6; }
  function multiChance() { return level() >= 3 ? clamp((level() - 2) * 0.1, 0, 0.55) : 0; }

  function resetGame() {
    stopPromote();
    // fresh deterministic run: new seed, fresh rng, empty input log
    runSeed = (Math.random() * 4294967296) >>> 0;
    rng = mulberry32(runSeed);
    simTick = 0; inputLog = []; simAcc = 0; lastRun = null;
    clearInputs();
    houseIdx = 0; buildHouse(HOUSES[0].cols, HOUSES[0].rows);
    score = 0; saved = 0; combo = 0; bestCombo = 0;
    maxLives = startLives(); lives = maxLives;
    powerups = []; powerupTimer = 9; effects.freeze = 0; effects.speed = 0; effects.slow = 0;
    player.speed = baseSpeed();
    const sp = safeSpawn(); player.x = sp.x; player.y = sp.y;
    spawnTimer = 2.2;
    syncHUD();
  }

  function startGame() {
    ensureAudio();
    resetGame();
    mode = 'play';
    $('startscreen').classList.add('hidden');
    $('overscreen').classList.add('hidden');
    $('shopscreen').classList.add('hidden');
    $('pausescreen').classList.add('hidden');
    $('optionsscreen').classList.add('hidden');
    $('guidescreen').classList.add('hidden');
  }

  // ---------- Pause / main menu ----------
  function pauseGame() {
    if (mode !== 'play') return;
    mode = 'paused';
    $('pausescreen').classList.remove('hidden');
  }
  function resumeGame() {
    if (mode !== 'paused') return;
    mode = 'play';
    $('pausescreen').classList.add('hidden');
  }
  function togglePause() {
    if (mode === 'play') pauseGame();
    else if (mode === 'paused') resumeGame();
  }
  function goMainMenu() {
    // leaving a run mid-flight still banks what you earned
    if (mode === 'play' || mode === 'paused') { bank += Math.round(score * EARN_RATE); saveProgress(); }
    stopPromote();
    mode = 'start';
    $('pausescreen').classList.add('hidden');
    $('overscreen').classList.add('hidden');
    $('shopscreen').classList.add('hidden');
    $('optionsscreen').classList.add('hidden');
    $('guidescreen').classList.add('hidden');
    $('startscreen').classList.remove('hidden');
  }

  function gameOver() {
    mode = 'over';
    stopPromote();
    // verifiable run record: a server can re-simulate (seed + inputs) to confirm.
    lastRun = { v: SIM_VERSION, seed: runSeed, ticks: simTick, score: score, saved: saved, inputs: inputLog };
    window.__lastRun = lastRun;
    const earned = Math.round(score * EARN_RATE);
    bank += earned; saveProgress();
    if (score > best) { best = score; try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} }
    $('over-text').innerHTML =
      `You replaced <b>${saved}</b> batteries for <b>${score}</b> points` +
      (bestCombo > 1 ? ` (best streak ×${bestCombo})` : '') +
      `.<br>Earned <b>${earned}</b> batteries — banked <b>${bank}</b>.<br>Best score: <b>${best}</b>`;
    $('overscreen').classList.remove('hidden');
    syncHUD();
  }

  // ---------- Promotion to bigger houses ----------
  function maybePromote() {
    let target = 0;
    for (let i = 0; i < PROMOTE_AT.length; i++) if (saved >= PROMOTE_AT[i]) target = i;
    if (target > houseIdx) {
      houseIdx = target;
      const hd = HOUSES[houseIdx];
      buildHouse(hd.cols, hd.rows);
      const sp = safeSpawn(); player.x = sp.x; player.y = sp.y;
      powerups = []; spawnTimer = 1.4;
      flash('🏠 Promoted to ' + hd.name + '!  ×' + hd.mult + ' score', 'good');
      pulse($('house'), 'promote');
      playPromote();
    }
  }

  // ---------- Power-up spawn / collect ----------
  function spawnPowerup() {
    if (powerups.length >= 2) return;
    const pool = Object.keys(POWERUPS).filter((k) => k !== 'heart' || lives < maxLives);
    const key = pool[(rng() * pool.length) | 0];
    for (let t = 0; t < 30; t++) {
      const rm = rooms[(rng() * rooms.length) | 0];
      const x = rm.x + 24 + rng() * (rm.w - 48);
      const y = rm.y + 24 + rng() * (rm.h - 48);
      if (!blocked(x, y)) { powerups.push({ key, x, y, ttl: 11, bob: rng() * 6 }); return; }
    }
  }
  function collectPowerup(p) {
    if (p.key === 'freeze') effects.freeze = 4;
    else if (p.key === 'speed') effects.speed = 5;
    else if (p.key === 'slow') effects.slow = 7;
    else if (p.key === 'heart') { lives = Math.min(maxLives, lives + 1); syncHUD(); pulse($('lives'), 'heal'); }
    success();
    flash(POWERUPS[p.key].icon + ' ' + p.key.toUpperCase() + '!', 'good');
  }

  // ---------- Spawning + dying ----------
  // normal → 1 press. fast → shorter fuse (red). stubborn → 2 presses (purple).
  function pickType() {
    const lv = level(), r = rng();
    if (lv >= 4 && r < 0.18) return 'stubborn';
    if (lv >= 2 && r < 0.40) return 'fast';
    return 'normal';
  }
  function killRandomDetector() {
    const alive = detectors.filter((d) => d.state === 'ok');
    if (!alive.length) return;
    const d = alive[(rng() * alive.length) | 0];
    d.type = pickType();
    d.grace = graceTime() * (d.type === 'fast' ? 0.6 : 1);
    d.fuse = d.grace;
    d.presses = d.type === 'stubborn' ? 2 : 1;
    d.state = 'dead';
    d.chirpsLeft = 2; d.chirpTimer = 0;   // sd.mp3 goes off exactly twice per cycle
    blip(false);
  }

  // ---------- Audio (WebAudio) ----------
  const MVOL_KEY = 'smokerush.musicvol.v1', SVOL_KEY = 'smokerush.sfxvol.v1';
  const readVol = (v, dflt) => { v = parseFloat(v); return isFinite(v) ? clamp(v, 0, 1) : dflt; };
  let musicVol = readVol(localStorage.getItem(MVOL_KEY), 0.32);
  let sfxVol = readVol(localStorage.getItem(SVOL_KEY), 0.85);
  let actx = null, master = null, sfxGain = null, sdBuffer = null, sdLoading = false;
  let musicGain = null, musicBuf = null, musicSrc = null, musicLoading = false;
  let promoteBuf = null, promoteLoading = false, promoteSrc = null;
  function ensureAudio() {
    if (!actx) {
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        master = actx.createGain(); master.gain.value = 1; master.connect(actx.destination);
        sfxGain = actx.createGain(); sfxGain.gain.value = muted ? 0 : sfxVol; sfxGain.connect(master);
        musicGain = actx.createGain(); musicGain.gain.value = muted ? 0 : musicVol; musicGain.connect(master);
      } catch (e) {}
    }
    if (actx && actx.state === 'suspended') actx.resume();
    loadSd();
    loadMusic();
    loadPromote();
  }
  function applyVolumes() {
    if (sfxGain) sfxGain.gain.value = muted ? 0 : sfxVol;
    if (musicGain) musicGain.gain.value = muted ? 0 : musicVol;
  }
  function saveVolumes() {
    try { localStorage.setItem(MVOL_KEY, String(musicVol)); localStorage.setItem(SVOL_KEY, String(sfxVol)); } catch (e) {}
  }
  function loadSd() {
    if (sdBuffer || sdLoading || !actx) return;
    sdLoading = true;
    fetch('/assets/audio/sd.mp3')
      .then((r) => r.arrayBuffer())
      .then((b) => actx.decodeAudioData(b))
      .then((buf) => { sdBuffer = buf; })
      .catch(() => { sdLoading = false; });
  }
  const sdReady = () => !!sdBuffer;

  // ---------- Background music (gapless WebAudio loop) ----------
  function loadMusic() {
    if (musicBuf) { startMusic(); return; }
    if (musicLoading || !actx) return;
    musicLoading = true;
    fetch('/assets/audio/music.mp3')
      .then((r) => r.arrayBuffer())
      .then((b) => actx.decodeAudioData(b))
      .then((buf) => { musicBuf = buf; startMusic(); })
      .catch(() => { musicLoading = false; });
  }
  function startMusic() {
    if (!actx || !musicBuf || musicSrc) return;       // already playing
    musicSrc = actx.createBufferSource();
    musicSrc.buffer = musicBuf; musicSrc.loop = true;
    musicSrc.connect(musicGain); musicSrc.start();
  }
  // Promotion stinger — a one-shot vocal played over the music on advancement.
  function loadPromote() {
    if (promoteBuf || promoteLoading || !actx) return;
    promoteLoading = true;
    fetch('/assets/audio/promote.mp3')
      .then((r) => r.arrayBuffer())
      .then((b) => actx.decodeAudioData(b))
      .then((buf) => { promoteBuf = buf; })
      .catch(() => { promoteLoading = false; });
  }
  function stopPromote() { if (promoteSrc) { try { promoteSrc.stop(); } catch (e) {} promoteSrc = null; } }
  function playPromote() {
    if (muted || !actx || !promoteBuf) return;
    stopPromote();                                     // restart if one is still going
    promoteSrc = actx.createBufferSource(); promoteSrc.buffer = promoteBuf;
    const g = actx.createGain(); g.gain.value = 0.4;   // sits under the music, doesn't overpower
    promoteSrc.connect(g); g.connect(sfxGain); promoteSrc.start();
    promoteSrc.onended = () => { promoteSrc = null; };
  }
  function playSample(buf, vol) {
    if (muted || !actx || !buf) return;
    const s = actx.createBufferSource(); s.buffer = buf;
    const g = actx.createGain(); g.gain.value = vol == null ? 1 : vol;
    s.connect(g); g.connect(sfxGain); s.start();
  }
  // A tone with a near-instant attack, flat sustain, and fast cutoff — like a
  // piezo buzzer rather than a soft fading blip.
  function beep(freq, dur, opts) {
    if (muted || !actx) return;
    opts = opts || {};
    const vol = opts.vol != null ? opts.vol : 0.08;
    const atk = opts.attack != null ? opts.attack : 0.002;
    const rel = opts.release != null ? opts.release : 0.01;
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = opts.type || 'square';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + atk);
    g.gain.setValueAtTime(vol, t + Math.max(atk, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(sfxGain);
    o.start(t); o.stop(t + dur + 0.02);
  }
  // Low-battery chirp: the recorded sd.mp3 sample is the only smoke-detector
  // sound. If it hasn't loaded yet, stay silent rather than synthesizing one.
  function chirp() {
    if (sdReady()) playSample(sdBuffer, 0.9);
  }
  function success() { beep(880, 0.07, { type: 'sine', vol: 0.11 }); setTimeout(() => beep(1320, 0.09, { type: 'sine', vol: 0.09 }), 70); }
  function blip() { beep(560, 0.06, { type: 'triangle', vol: 0.05 }); }

  // ---------- Input ----------
  const keys = { up: false, down: false, left: false, right: false };

  function onAction() {
    if (!$('shopscreen').classList.contains('hidden')) return;
    if (!$('optionsscreen').classList.contains('hidden')) return;
    if (!$('guidescreen').classList.contains('hidden')) return;
    if (mode === 'paused') return;
    if (mode === 'start' || mode === 'over') { startGame(); return; }
    tryReplace();
  }

  function tryReplace() {
    let pick = null, bestD2 = effReach() * effReach();
    for (const d of detectors) {
      if (d.state !== 'dead') continue;
      const ddx = d.x - player.x, ddy = d.y - player.y, dist2 = ddx * ddx + ddy * ddy;
      if (dist2 < bestD2) { bestD2 = dist2; pick = d; }
    }
    if (!pick) return;
    if (pick.presses > 1) { pick.presses--; blip(false); flash('🔩 Stuck — press again!', ''); return; }
    pick.state = 'ok';
    pick.chirpsLeft = 0;
    saved++;
    combo++;
    bestCombo = Math.max(bestCombo, combo);
    const timeBonus = Math.round((pick.fuse / pick.grace) * 10);
    const gained = Math.round((10 + timeBonus + (combo - 1) * 2) * houseMult());
    score += gained;
    success();
    flash('+' + gained + (combo > 1 ? '  ×' + combo : ''), 'good');
    maybePromote();
    syncHUD();
    pulse($('score'), 'bump');
    if (combo > 1) pulse($('combo'), 'pop');
  }

  // Gameplay inputs go through the deterministic queue; UI keys act immediately.
  function moveInput(code, down) { if (mode === 'play') queueInput(code, down); }
  function actionInput() { if (mode === 'play') queueInput(4, true); else onAction(); }

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') moveInput(0, true);
    else if (k === 'arrowright' || k === 'd') moveInput(1, true);
    else if (k === 'arrowup' || k === 'w') moveInput(2, true);
    else if (k === 'arrowdown' || k === 's') moveInput(3, true);
    else if (k === 'enter' || k === 'e' || k === ' ') { e.preventDefault(); if (!e.repeat) actionInput(); }
    else if (k === 'm') toggleMute();
    else if (k === 'p' || k === 'escape') togglePause();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') moveInput(0, false);
    else if (k === 'arrowright' || k === 'd') moveInput(1, false);
    else if (k === 'arrowup' || k === 'w') moveInput(2, false);
    else if (k === 'arrowdown' || k === 's') moveInput(3, false);
  });

  const TOUCH_CODE = { left: 0, right: 1, up: 2, down: 3 };
  document.querySelectorAll('#touch button').forEach((btn) => {
    const k = btn.dataset.key;
    const press = (v) => {
      if (k === 'action') { if (v) actionInput(); return; }
      if (TOUCH_CODE[k] != null) moveInput(TOUCH_CODE[k], v);
    };
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); press(true); }, { passive: false });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); press(false); }, { passive: false });
    btn.addEventListener('mousedown', () => press(true));
    btn.addEventListener('mouseup', () => press(false));
    btn.addEventListener('mouseleave', () => press(false));
  });

  const ICON_SOUND_ON = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_SOUND_OFF = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function toggleMute() {
    muted = !muted;
    $('btn-mute').innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    applyVolumes();
  }
  $('btn-mute').addEventListener('click', toggleMute);

  function toggleFullscreen() {
    const el = $('app');
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    }
  }
  $('btn-full').addEventListener('click', toggleFullscreen);
  $('btn-restart').addEventListener('click', () => { ensureAudio(); startGame(); });
  $('btn-start').addEventListener('click', startGame);
  $('btn-again').addEventListener('click', startGame);

  // ---------- Shop ----------
  function openShop() { renderShop(); $('shopscreen').classList.remove('hidden'); }
  function closeShop() { $('shopscreen').classList.add('hidden'); }
  function renderShop() {
    $('shop-bank').textContent = bank;
    const list = $('shop-list'); list.innerHTML = '';
    for (const d of PERKS) {
      const lvl = perks[d.key], maxed = lvl >= d.max, cost = d.cost(lvl);
      const row = document.createElement('div');
      row.className = 'perk' + (maxed ? ' maxed' : '');
      row.innerHTML =
        `<div class="perk-info"><div class="perk-name">${d.name}</div>` +
        `<div class="perk-desc">${d.desc}</div>` +
        `<div class="perk-pips">${'●'.repeat(lvl) + '○'.repeat(d.max - lvl)}</div></div>`;
      const btn = document.createElement('button');
      if (maxed) { btn.textContent = 'MAX'; btn.disabled = true; }
      else { btn.textContent = String(cost); btn.disabled = bank < cost; btn.onclick = () => buyPerk(d.key); }
      row.appendChild(btn);
      list.appendChild(row);
    }
  }
  function buyPerk(key) {
    const d = PERKS.find((p) => p.key === key); const lvl = perks[key];
    if (lvl >= d.max) return;
    const cost = d.cost(lvl);
    if (bank < cost) return;
    bank -= cost; perks[key]++; saveProgress(); renderShop();
  }
  $('btn-shop').addEventListener('click', openShop);
  $('btn-shop2').addEventListener('click', openShop);
  $('btn-shop-close').addEventListener('click', closeShop);

  $('btn-pause').addEventListener('click', togglePause);
  $('btn-resume').addEventListener('click', resumeGame);
  $('btn-pause-restart').addEventListener('click', startGame);
  $('btn-pause-menu').addEventListener('click', goMainMenu);
  $('btn-over-menu').addEventListener('click', goMainMenu);

  // ---------- Options (volume) ----------
  function syncOptionsUI() {
    $('vol-music').value = Math.round(musicVol * 100);
    $('vol-sfx').value = Math.round(sfxVol * 100);
    $('vol-music-val').textContent = Math.round(musicVol * 100) + '%';
    $('vol-sfx-val').textContent = Math.round(sfxVol * 100) + '%';
  }
  function openOptions() { syncOptionsUI(); $('optionsscreen').classList.remove('hidden'); }
  function closeOptions() { $('optionsscreen').classList.add('hidden'); }
  $('btn-options').addEventListener('click', openOptions);
  $('btn-pause-options').addEventListener('click', openOptions);
  $('btn-options-close').addEventListener('click', closeOptions);

  // ---------- How to Play ----------
  function openGuide() { $('guidescreen').classList.remove('hidden'); }
  function closeGuide() { $('guidescreen').classList.add('hidden'); }
  $('btn-guide').addEventListener('click', openGuide);
  $('btn-guide-close').addEventListener('click', closeGuide);

  // ---------- Token contract address (loaded from config.json post-launch) ----------
  function applyCA(addr) {
    addr = (addr || '').trim();
    document.querySelectorAll('.ca-pill').forEach((el) => {
      el.classList.remove('hidden');
      const addrEl = el.querySelector('.ca-addr');
      const copyEl = el.querySelector('.ca-copy');
      if (!addr) {                                   // pre-launch placeholder
        addrEl.textContent = 'coming soon';
        el.dataset.ca = '';
        el.classList.add('ca-empty');
        if (copyEl) copyEl.style.display = 'none';
        el.title = 'Contract address — available at launch';
        return;
      }
      const short = addr.length > 12 ? addr.slice(0, 4) + '…' + addr.slice(-4) : addr;
      addrEl.textContent = short;
      el.dataset.ca = addr;
      el.classList.remove('ca-empty');
      if (copyEl) copyEl.style.display = '';
      el.title = 'Copy contract address: ' + addr;
    });
  }
  applyCA('');                                       // show the placeholder by default
  document.querySelectorAll('.ca-pill').forEach((el) => {
    el.addEventListener('click', () => {
      const addr = el.dataset.ca; if (!addr) return;
      if (navigator.clipboard) navigator.clipboard.writeText(addr).catch(() => {});
      const c = el.querySelector('.ca-copy'); const prev = c.textContent;
      c.textContent = 'copied!'; setTimeout(() => { c.textContent = prev; }, 1200);
    });
  });
  if (window.HOODRUN_CA) applyCA(window.HOODRUN_CA);
  fetch('/assets/config.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => { if (c && c.tokenCA) applyCA(String(c.tokenCA)); })
    .catch(() => {});
  $('vol-music').addEventListener('input', (e) => {
    ensureAudio(); musicVol = e.target.value / 100; applyVolumes(); saveVolumes();
    $('vol-music-val').textContent = e.target.value + '%';
  });
  $('vol-sfx').addEventListener('input', (e) => {
    ensureAudio(); sfxVol = e.target.value / 100; applyVolumes(); saveVolumes();
    $('vol-sfx-val').textContent = e.target.value + '%';
    blip(false);   // audible preview of the new level
  });

  // ---------- Collision ----------
  function hitRect(x, y, r, w) {
    return x + r > w.x && x - r < w.x + w.w && y + r > w.y && y - r < w.y + w.h;
  }
  function blocked(x, y) {
    const r = player.radius;
    for (const w of walls) if (hitRect(x, y, r, w)) return true;
    for (const s of solids) if (hitRect(x, y, r, s)) return true;
    return false;
  }
  // A guaranteed-open floor point (house center can land on a wall junction for
  // even grids), used to place the player on (re)start and promotion.
  function safeSpawn() {
    for (const rm of rooms) {
      for (let gy = rm.y + 24; gy < rm.y + rm.h - 24; gy += 16)
        for (let gx = rm.x + 24; gx < rm.x + rm.w - 24; gx += 16)
          if (!blocked(gx, gy)) return { x: gx, y: gy };
    }
    return { x: HX + roomW / 2, y: HY + roomH / 2 };
  }

  // ---------- HUD ----------
  // ---- HUD animation helpers ----
  const numTweens = new Map();
  function animateNumber(el, to, dur) {
    if (!el) return;
    const from = parseInt((el.textContent || '0').replace(/\D/g, ''), 10) || 0;
    if (from === to) { el.textContent = to; return; }
    if (numTweens.has(el)) cancelAnimationFrame(numTweens.get(el));
    const start = performance.now(), span = to - from;
    const step = (now) => {
      const t = Math.min(1, (now - start) / (dur || 450));
      const e = 1 - Math.pow(1 - t, 3);                 // easeOutCubic
      el.textContent = Math.round(from + span * e);
      if (t < 1) numTweens.set(el, requestAnimationFrame(step)); else numTweens.delete(el);
    };
    numTweens.set(el, requestAnimationFrame(step));
  }
  function pulse(el, cls) {                              // restartable one-shot animation class
    if (!el) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  }

  function syncHUD() {
    animateNumber($('score'), score);
    animateNumber($('best'), best);
    $('level').textContent = level();
    $('house').textContent = HOUSES[houseIdx].name;
    $('lives').textContent = '♥'.repeat(Math.max(0, lives)) + '♡'.repeat(Math.max(0, maxLives - lives));
    $('combo').textContent = combo > 1 ? 'COMBO ×' + combo : '';
    const mb = $('menu-best'); if (mb) mb.textContent = best;
  }

  let toastTimer = null;
  function flash(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = kind ? kind : '';
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1100);
  }

  // ---------- Update ----------
  function update(dt) {
    // active power-up effects tick down
    if (effects.freeze > 0) effects.freeze = Math.max(0, effects.freeze - dt);
    if (effects.speed > 0) effects.speed = Math.max(0, effects.speed - dt);
    if (effects.slow > 0) effects.slow = Math.max(0, effects.slow - dt);

    // movement (Speed power-up gives a burst)
    const spd = baseSpeed() * (effects.speed > 0 ? 1.55 : 1);
    let dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    let dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (dx || dy) {
      const l = Math.sqrt(dx * dx + dy * dy); dx /= l; dy /= l;
      const nx = player.x + dx * spd * dt;
      const ny = player.y + dy * spd * dt;
      if (!blocked(nx, player.y)) player.x = nx;
      if (!blocked(player.x, ny)) player.y = ny;
      player.x = clamp(player.x, HX + WALLT, HX + HW - WALLT);
      player.y = clamp(player.y, HY + WALLT, HY + HH - WALLT);
      if (dx > 0) player.facing = 1; else if (dx < 0) player.facing = -1;
      // cardinal facing for the directional sprite: dominant axis wins,
      // ties go to the horizontal (side) view.
      if (Math.abs(dx) >= Math.abs(dy)) player.dir = dx > 0 ? 'right' : 'left';
      else player.dir = dy > 0 ? 'down' : 'up';
      player.walkPhase += dt * 12;
    }

    // spawn dying detectors
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      killRandomDetector();
      if (rng() < multiChance()) killRandomDetector();
      spawnTimer = spawnInterval() * (0.8 + rng() * 0.5);
    }

    // power-ups: spawn on a timer, collect on contact, expire on TTL
    powerupTimer -= dt;
    if (powerupTimer <= 0) { spawnPowerup(); powerupTimer = 13 + rng() * 7; }
    for (let i = powerups.length - 1; i >= 0; i--) {
      const p = powerups[i];
      p.ttl -= dt;
      const pdx = p.x - player.x, pdy = p.y - player.y;
      if (pdx * pdx + pdy * pdy < 24 * 24) { collectPowerup(p); powerups.splice(i, 1); continue; }
      if (p.ttl <= 0) powerups.splice(i, 1);
    }

    // count down fuses; misses cost a life (Freeze pauses the countdown)
    for (const d of detectors) {
      if (d.state !== 'dead') continue;
      if (effects.freeze <= 0) d.fuse -= dt * (effects.slow > 0 ? 0.4 : 1);

      // sd.mp3 goes off exactly twice over the detector's cycle: once when the
      // battery dies, then again roughly halfway through the grace period.
      if (d.chirpsLeft > 0) {
        d.chirpTimer -= dt;
        if (d.chirpTimer <= 0) {
          chirp();
          d.chirpsLeft--;
          d.chirpTimer = d.grace * 0.45;
        }
      }

      if (d.fuse <= 0) {
        d.state = 'ok';
        d.chirpsLeft = 0;
        lives--;
        combo = 0;
        flash('🚨 Missed the ' + d.room.theme.name + '!', 'bad');
        syncHUD();
        pulse($('lives'), 'hit');
        if (lives <= 0) { gameOver(); return; }
      }
    }
  }

  // ---------- Drawing ----------
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- Room interiors ----------
  // Small drawing helpers: filled furniture box (soft drop shadow by default)
  // and a filled ellipse. roundRect() above builds the path we fill/stroke.
  function furn(x, y, w, h, fill, opts) {
    opts = opts || {};
    ctx.save();
    if (opts.shadow !== false) {
      ctx.shadowColor = 'rgba(0,0,0,0.40)'; ctx.shadowBlur = opts.blur || 7; ctx.shadowOffsetY = 3;
    }
    ctx.fillStyle = fill;
    const r = opts.r || 0;
    if (r) { roundRect(x, y, w, h, r); ctx.fill(); } else ctx.fillRect(x, y, w, h);
    ctx.restore();
    if (opts.stroke) {
      ctx.strokeStyle = opts.stroke; ctx.lineWidth = opts.lw || 1.5;
      if (r) { roundRect(x, y, w, h, r); ctx.stroke(); } else ctx.strokeRect(x, y, w, h);
    }
  }
  function oval(cx, cy, rx, ry, fill, opts) {
    opts = opts || {};
    ctx.save();
    if (opts.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.40)'; ctx.shadowBlur = opts.blur || 6; ctx.shadowOffsetY = 2; }
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function ring(cx, cy, r, color, lw) {
    ctx.strokeStyle = color; ctx.lineWidth = lw || 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }

  function drawFloor(rm) {
    const x = rm.x, y = rm.y, w = rm.w, h = rm.h, s = rm.theme.floorStyle;
    ctx.fillStyle = rm.theme.floor; ctx.fillRect(x, y, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    if (s === 'plank') {
      let row = 0;
      for (let yy = y; yy < y + h; yy += 24, row++) {
        ctx.strokeStyle = 'rgba(0,0,0,0.20)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.beginPath(); ctx.moveTo(x, yy + 1); ctx.lineTo(x + w, yy + 1); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.13)';
        for (let xx = x + ((row % 2) ? 70 : 10); xx < x + w; xx += 120) {
          ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 24); ctx.stroke();
        }
      }
    } else if (s === 'tile' || s === 'tileSm') {
      const g = s === 'tileSm' ? 22 : 38;
      ctx.lineWidth = 1;
      for (let xx = x; xx < x + w; xx += g) {
        ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.moveTo(xx + 1, y); ctx.lineTo(xx + 1, y + h); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      for (let yy = y; yy < y + h; yy += g) { ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke(); }
    } else if (s === 'carpet') {
      ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1;
      for (let yy = y + 3; yy < y + h; yy += 5) { ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke(); }
    } else { // concrete
      ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + w * 0.30, y); ctx.lineTo(x + w * 0.42, y + h * 0.5); ctx.lineTo(x + w * 0.36, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + w * 0.70, y + h * 0.2); ctx.lineTo(x + w * 0.62, y + h); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      for (let yy = y + 40; yy < y + h; yy += 80) { ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke(); }
    }
    ctx.restore();
  }

  function drawFurniture(rm) { furnitureFor(rm); }

  function drawLabel(rm) {
    const t = rm.theme.name;
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = 'rgba(10,12,16,0.55)';
    roundRect(rm.x + 8, rm.y + 8, tw + 14, 20, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(t, rm.x + 15, rm.y + 22);
  }

  // a small potted-plant accent (decorative, never solid)
  function plant(px, py) {
    furn(px - 9, py - 4, 18, 13, '#7a5a3a', { r: 3 });
    oval(px, py - 12, 13, 12, '#3f7d4a', { shadow: true });
    oval(px - 5, py - 16, 7, 7, '#4f9a5b', { shadow: false });
  }

  // Each room: footprints define solids (pushed to S when collecting) AND the
  // shapes we draw. Big pieces hug door-free walls so they never block a doorway.
  function rKitchen(rm, S) {
    const { x, y, w, h } = rm;
    const fridge = [x + 14, y + 14, 48, 60];
    const counter = [x + 74, y + 12, w - 90, 40];        // along the top wall
    const island = [x + w / 2 - 50, y + h / 2 + 10, 100, 46];
    if (S) { S.push(R(fridge), R(counter), R(island)); return; }
    const cab = '#5e4a30', top = '#cfd4d9', steel = '#9aa2ab', dark = '#33363b';
    furn(counter[0], counter[1], counter[2], counter[3], cab, { r: 4 });
    furn(counter[0], counter[1] + 6, counter[2], counter[3] - 6, top, { r: 4, shadow: false });
    const stove = [counter[0] + 10, counter[1] + 12, 46, counter[3] - 18];
    furn(stove[0], stove[1], stove[2], stove[3], dark, { r: 3, shadow: false });
    for (let i = 0; i < 4; i++) ring(stove[0] + 12 + (i % 2) * 22, stove[1] + 7 + (i < 2 ? 0 : 11), 4, '#5b6066', 2);
    const sink = [counter[0] + counter[2] - 56, counter[1] + 12, 48, counter[3] - 18];
    furn(sink[0], sink[1], sink[2], sink[3], steel, { r: 4, shadow: false });
    furn(sink[0] + 6, sink[1] + 4, sink[2] - 12, sink[3] - 8, '#7c848d', { r: 3, shadow: false });
    furn(fridge[0], fridge[1], fridge[2], fridge[3], '#dde1e5', { r: 6 });
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(fridge[0], fridge[1] + 24); ctx.lineTo(fridge[0] + fridge[2], fridge[1] + 24); ctx.stroke();
    furn(fridge[0] + fridge[2] - 6, fridge[1] + 30, 4, 16, '#9aa2ab', { shadow: false });
    furn(island[0], island[1], island[2], island[3], cab, { r: 6 });
    furn(island[0] + 4, island[1] + 4, island[2] - 8, island[3] - 8, top, { r: 5, shadow: false });
  }

  function rLiving(rm, S) {
    const { x, y, w, h } = rm, cx = x + w / 2, cy = y + h / 2;
    const sofa = [cx - 78, y + 12, 156, 42];
    const chair = [x + w - 62, y + 12, 46, 46];
    const tv = [x + 14, y + 12, 60, 26];
    if (S) { S.push(R(sofa), R(chair), R(tv)); return; }
    const sofaC = '#475071', cushion = '#525d83', wood = '#5a4632';
    furn(cx - 74, cy - 26, 148, 96, '#7e4a44', { r: 10, shadow: false });            // rug
    furn(cx - 66, cy - 18, 132, 80, '#8c5650', { r: 8, shadow: false });
    furn(cx - 34, cy + 2, 68, 30, wood, { r: 6 });                                   // coffee table
    furn(sofa[0], sofa[1], sofa[2], sofa[3], sofaC, { r: 12 });                      // sofa
    for (let i = 0; i < 3; i++) furn(sofa[0] + 10 + i * (sofa[2] - 20) / 3, sofa[1] + sofa[3] - 26, (sofa[2] - 20) / 3 - 6, 22, cushion, { r: 6, shadow: false });
    furn(tv[0], tv[1], tv[2], tv[3], '#2c2f33', { r: 3 });                           // TV console
    furn(tv[0] + 8, tv[1] + tv[3] - 8, tv[2] - 16, 5, '#0d0f12', { shadow: false });
    furn(chair[0], chair[1], chair[2], chair[3], sofaC, { r: 12 });                  // armchair
    furn(chair[0] + 6, chair[1] + chair[3] - 22, chair[2] - 12, 18, cushion, { r: 6, shadow: false });
    plant(x + 24, y + h - 22);
  }

  function rBedroom(rm, S) {
    const { x, y, w, h } = rm, cy = y + h / 2;
    const bed = [x + w - 106, cy - 76, 92, 152];
    const night = [x + w - 150, cy - 72, 34, 34];
    const dresser = [x + 14, y + 12, 84, 28];
    if (S) { S.push(R(bed), R(night), R(dresser)); return; }
    const duvet = '#5566a6', wood = '#5a4632', pillow = '#e9eef2';
    furn(x + w / 2 - 56, cy - 6, 112, 70, '#6c6450', { r: 8, shadow: false });       // rug
    furn(bed[0], bed[1], bed[2], bed[3], duvet, { r: 10 });                          // duvet
    furn(bed[0] + bed[2] - 20, bed[1], 20, bed[3], '#41509a', { r: 6, shadow: false }); // headboard (at wall)
    furn(bed[0] + 8, bed[1] + 8, bed[2] - 34, 30, pillow, { r: 7, shadow: false });  // pillow
    furn(bed[0] + 8, bed[1] + 44, bed[2] - 34, 30, pillow, { r: 7, shadow: false });
    furn(night[0], night[1], night[2], night[3], wood, { r: 4 });                    // nightstand
    oval(night[0] + night[2] / 2, night[1] + night[3] / 2, 8, 8, '#ffd98a', { shadow: false });
    furn(dresser[0], dresser[1], dresser[2], dresser[3], wood, { r: 4 });            // dresser
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(dresser[0] + dresser[2] / 2, dresser[1]); ctx.lineTo(dresser[0] + dresser[2] / 2, dresser[1] + dresser[3]); ctx.stroke();
    plant(x + 24, y + h - 22);
  }

  function rBathroom(rm, S) {
    const { x, y, w, h } = rm;
    const tub = [x + 14, y + h - 60, w - 130, 46];
    const toilet = [x + w - 50, y + h - 66, 34, 52];
    const vanity = [x + 14, y + 14, 30, 64];
    if (S) { S.push(R(tub), R(toilet), R(vanity)); return; }
    const por = '#e8edf1', water = '#bfe0ea', wood = '#5a4632';
    furn(x + w / 2 - 26, y + h / 2 + 6, 56, 28, '#6aa3a8', { r: 6, shadow: false }); // bath mat
    furn(tub[0], tub[1], tub[2], tub[3], por, { r: 12 });                            // tub
    furn(tub[0] + 8, tub[1] + 8, tub[2] - 16, tub[3] - 16, water, { r: 8, shadow: false });
    furn(toilet[0], toilet[1], toilet[2], toilet[3] - 30, por, { r: 4 });            // tank
    oval(toilet[0] + toilet[2] / 2, toilet[1] + toilet[3] - 16, 16, 18, por, { shadow: true });
    oval(toilet[0] + toilet[2] / 2, toilet[1] + toilet[3] - 16, 10, 12, '#cfd9de', { shadow: false });
    furn(vanity[0], vanity[1], vanity[2], vanity[3], wood, { r: 4 });                // vanity
    oval(vanity[0] + vanity[2] / 2, vanity[1] + 18, 11, 9, por, { shadow: false });
  }

  function rOffice(rm, S) {
    const { x, y, w, h } = rm, cx = x + w / 2;
    const desk = [cx - 92, y + h - 54, 184, 40];
    const chair = [cx - 18, y + h - 88, 36, 30];
    const shelf = [x + 14, y + h - 84, 24, 70];
    if (S) { S.push(R(desk), R(chair), R(shelf)); return; }
    const wood = '#5a4632', dark = '#26282c';
    furn(cx - 46, y + h / 2 - 4, 92, 46, '#4a5560', { r: 6, shadow: false });        // rug
    furn(desk[0], desk[1], desk[2], desk[3], wood, { r: 5 });                        // desk
    furn(desk[0] + desk[2] / 2 - 26, desk[1] + 4, 52, 18, dark, { r: 3, shadow: false });
    furn(desk[0] + desk[2] / 2 - 22, desk[1] + 6, 44, 14, '#3a6ea5', { r: 2, shadow: false }); // screen
    furn(desk[0] + desk[2] / 2 - 26, desk[1] + 26, 52, 8, '#cfd4d9', { r: 2, shadow: false }); // keyboard
    oval(chair[0] + chair[2] / 2, chair[1] + 18, 18, 15, dark, { shadow: true });    // chair seat
    furn(chair[0], chair[1], chair[2], 12, '#33363b', { r: 6, shadow: false });      // chair back
    furn(shelf[0], shelf[1], shelf[2], shelf[3], wood, { r: 3 });                    // bookshelf
    const cols = ['#a14b3a', '#3a6ea5', '#4a8c5a', '#caa15a'];
    for (let i = 0; i < 4; i++) furn(shelf[0] + 4, shelf[1] + 5 + i * 16, shelf[2] - 8, 12, cols[i], { r: 1, shadow: false });
    plant(x + w - 24, y + 28);
  }

  function rGarage(rm, S) {
    const { x, y, w, h } = rm, cx = x + w / 2, cy = y + h / 2;
    const car = [cx - 46, cy - 72, 92, 144];
    const bench = [x + 14, y + h - 44, 100, 30];
    const shelf = [x + w - 36, y + 14, 22, 64];
    const boxes = [x + w - 58, y + h - 44, 36, 30];
    if (S) { S.push(R(car), R(bench), R(shelf), R(boxes)); return; }
    const carC = '#9a3b34', carSh = '#7d2f29', glass = '#9fb6c4', metal = '#4a4e55';
    furn(car[0], car[1], car[2], car[3], carC, { r: 22 });                           // body (nose up)
    furn(car[0] + 10, car[1] + 22, car[2] - 20, 24, glass, { r: 8, shadow: false }); // windshield
    furn(car[0] + 10, car[1] + car[3] - 46, car[2] - 20, 24, glass, { r: 8, shadow: false }); // rear window
    furn(car[0] + 12, cy - 16, car[2] - 24, 32, carSh, { r: 8, shadow: false });     // roof
    oval(car[0] + 14, car[1] + 8, 6, 4, '#fff4c2', { shadow: false });
    oval(car[0] + car[2] - 14, car[1] + 8, 6, 4, '#fff4c2', { shadow: false });
    furn(bench[0], bench[1], bench[2], bench[3], '#5a4632', { r: 3 });               // workbench
    furn(bench[0], bench[1], bench[2], 8, '#7a6038', { r: 3, shadow: false });
    furn(shelf[0], shelf[1], shelf[2], shelf[3], metal, { r: 2 });                   // wall shelf
    furn(boxes[0], boxes[1], boxes[2], boxes[3], '#b58b50', { r: 2 });               // boxes
    furn(boxes[0] + 8, boxes[1] - 14, 24, 18, '#caa15a', { r: 2 });
  }

  // Windows set into the outer (perimeter) walls. wy/wx is the wall's near edge.
  function windowH(cx, wy) {
    const ww = 50, x = cx - ww / 2;
    ctx.fillStyle = '#2a3340'; ctx.fillRect(x - 3, wy - 1, ww + 6, WALLT + 2);     // frame
    ctx.fillStyle = '#9fc4d8'; ctx.fillRect(x, wy + 2, ww, WALLT - 4);             // glass
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x, wy + 2, ww, 2);
    ctx.strokeStyle = '#2a3340'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, wy + 2); ctx.lineTo(cx, wy + WALLT - 2); ctx.stroke();
  }
  function windowV(cy, wx) {
    const wh = 50, y = cy - wh / 2;
    ctx.fillStyle = '#2a3340'; ctx.fillRect(wx - 1, y - 3, WALLT + 2, wh + 6);     // frame
    ctx.fillStyle = '#9fc4d8'; ctx.fillRect(wx + 2, y, WALLT - 4, wh);             // glass
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(wx + 2, y, 2, wh);
    ctx.strokeStyle = '#2a3340'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(wx + 2, cy); ctx.lineTo(wx + WALLT - 2, cy); ctx.stroke();
  }
  function drawWindows() {
    for (let c = 0; c < COLS; c++) {
      const cx = HX + c * roomW + roomW / 2;
      windowH(cx, HY);                       // top wall
      windowH(cx, HY + HH - WALLT);          // bottom wall
    }
    for (let r = 0; r < ROWS; r++) {
      const cy = HY + r * roomH + roomH / 2;
      windowV(cy, HX);                        // left wall
      windowV(cy, HX + HW - WALLT);           // right wall
    }
  }

  function drawThresholds() {
    const half = DOOR / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let c = 1; c < COLS; c++) {
      const wx = HX + c * roomW - WALLT / 2;
      for (let r = 0; r < ROWS; r++) { const gc = HY + r * roomH + roomH / 2; ctx.fillRect(wx - 2, gc - half, WALLT + 4, DOOR); }
    }
    for (let r = 1; r < ROWS; r++) {
      const wy = HY + r * roomH - WALLT / 2;
      for (let c = 0; c < COLS; c++) { const gc = HX + c * roomW + roomW / 2; ctx.fillRect(gc - half, wy - 2, DOOR, WALLT + 4); }
    }
  }

  // ---- debug overlay (open with ?debug): shows solids + flood-fill reachability
  let reachInfo = null;
  function computeReach() {
    const step = 8, cols = Math.ceil(worldW() / step), rows = Math.ceil(worldH() / step);
    const vis = new Uint8Array(cols * rows);
    const idx = (a, b) => b * cols + a;
    const sa = Math.round(player.x / step), sb = Math.round(player.y / step);
    const stack = [[sa, sb]]; vis[idx(sa, sb)] = 1;
    while (stack.length) {
      const [a, b] = stack.pop();
      for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const na = a + da, nb = b + db;
        if (na < 0 || nb < 0 || na >= cols || nb >= rows) continue;
        const k = idx(na, nb);
        if (vis[k] || blocked(na * step, nb * step)) continue;
        vis[k] = 1; stack.push([na, nb]);
      }
    }
    let ok = 0;
    for (const d of detectors) {
      let reach = false;
      for (let a = 0; a < cols && !reach; a++) for (let b = 0; b < rows; b++)
        if (vis[idx(a, b)] && Math.hypot(a * step - d.x, b * step - d.y) < effReach()) { reach = true; break; }
      if (reach) ok++;
    }
    reachInfo = { step, cols, rows, vis, ok, total: detectors.length };
  }
  function drawDebugWorld() {                 // drawn inside the camera transform
    if (!reachInfo) computeReach();
    const { step, cols, rows, vis } = reachInfo;
    ctx.fillStyle = 'rgba(60,220,120,0.18)';
    for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) if (vis[b * cols + a]) ctx.fillRect(a * step, b * step, step, step);
    ctx.strokeStyle = 'rgba(0,230,255,0.9)'; ctx.lineWidth = 1;
    for (const s of solids) ctx.strokeRect(s.x, s.y, s.w, s.h);
  }
  function drawDebugText() {                  // drawn screen-fixed
    if (!reachInfo) computeReach();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`ROOMS REACHABLE ${reachInfo.ok}/${reachInfo.total}`, 12, 96);
  }

  // screen-fixed active-effect pills (top-left of the viewport)
  function drawEffects() {
    const items = [];
    if (effects.freeze > 0) items.push(['👟 ' + effects.freeze.toFixed(1) + 's', '#5bd6ff']);
    if (effects.speed > 0) items.push(['🍗 ' + effects.speed.toFixed(1) + 's', '#ffd24a']);
    if (effects.slow > 0) items.push(['🥤 ' + effects.slow.toFixed(1) + 's', '#b98cff']);
    let y = 10;
    ctx.font = 'bold 13px -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const [t, c] of items) {
      const w = ctx.measureText(t).width + 16;
      ctx.fillStyle = 'rgba(8,10,14,0.7)'; roundRect(10, y, w, 22, 7); ctx.fill();
      ctx.fillStyle = c; ctx.fillText(t, 18, y + 5);
      y += 26;
    }
  }

  // Edge arrows pointing to dying detectors that are off-screen (big houses).
  function drawOffscreenIndicators(time) {
    if (mode !== 'play') return;
    const margin = 30;
    for (const d of detectors) {
      if (d.state !== 'dead') continue;
      const sx = d.x - cam.x, sy = d.y - cam.y;
      if (sx >= -6 && sx <= W + 6 && sy >= -6 && sy <= H + 6) continue;   // already visible
      const ix = clamp(sx, margin, W - margin), iy = clamp(sy, margin, H - margin);
      const ang = Math.atan2(sy - H / 2, sx - W / 2);
      const frac = clamp(d.fuse / d.grace, 0, 1);
      const col = d.type === 'fast' ? '#ff5a3c' : d.type === 'stubborn' ? '#b07cff'
        : (frac > 0.4 ? '#ffd24a' : '#ff4b3e');
      const pulse = 1 + 0.12 * Math.sin(time * (6 + (1 - frac) * 10));
      ctx.save();
      ctx.translate(ix, iy);
      ctx.scale(pulse, pulse);
      // arrow chevron pointing toward the detector
      ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(23, 0); ctx.lineTo(12, -7); ctx.lineTo(12, 7); ctx.closePath(); ctx.fill();
      ctx.rotate(-ang);
      // badge circle centered on the indicator
      ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#10141a';
      ctx.font = 'bold 14px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const glyph = d.type === 'fast' ? '⚡' : d.type === 'stubborn' ? String(d.presses) : '!';
      ctx.fillText(glyph, 0, 1);
      ctx.restore();
    }
  }

  // The Speed power-up is a bucket of fried chicken (drumsticks poking out of a
  // red-and-white striped bucket). Drawn centered on (cx, cy).
  function drawChickenBucket(cx, cy) {
    const topW = 24, botW = 15, h = 16, topY = cy - 1, botY = cy - 1 + h;
    const drum = (dx, dy, rot) => {
      ctx.save(); ctx.translate(cx + dx, cy + dy); ctx.rotate(rot);
      ctx.fillStyle = '#c98a4b'; ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 0, 5, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f3efe6'; ctx.beginPath(); ctx.arc(0, -7, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    drum(-6, -8, -0.45); drum(6, -8, 0.45); drum(0, -11, 0);     // pieces poking out
    ctx.beginPath();                                              // bucket body (trapezoid)
    ctx.moveTo(cx - topW / 2, topY); ctx.lineTo(cx + topW / 2, topY);
    ctx.lineTo(cx + botW / 2, botY); ctx.lineTo(cx - botW / 2, botY); ctx.closePath();
    ctx.fillStyle = '#e23b34'; ctx.fill();
    ctx.save(); ctx.clip();                                       // white stripes
    ctx.fillStyle = '#f4f4f4';
    for (let i = -2; i <= 2; i++) ctx.fillRect(cx + i * 8 - 2, topY - 1, 4, h + 2);
    ctx.restore();
    ctx.fillStyle = '#f7f7f7';                                    // rim
    ctx.beginPath(); ctx.ellipse(cx, topY, topW / 2, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9a2a24'; ctx.beginPath(); ctx.ellipse(cx, topY, topW / 2 - 3, 2.1, 0, 0, Math.PI * 2); ctx.fill();
  }

  // The Slow-Time power-up is a can of grape soda.
  function drawSodaCan(cx, cy) {
    const w = 15, h = 26, x = cx - w / 2, top = cy - h / 2;
    roundRect(x, top, w, h, 4); ctx.fillStyle = '#7b3fb0'; ctx.fill();      // body
    ctx.save(); roundRect(x, top, w, h, 4); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.20)'; ctx.fillRect(x + 2, top, 3, h); // highlight
    ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(x + w - 4, top, 4, h);  // shade
    ctx.fillStyle = '#c9a3ff'; ctx.fillRect(x, cy - 5, w, 13);              // label band
    ctx.fillStyle = '#54237f';                                             // grape cluster
    const gx = cx, gy = cy + 1;
    for (const [dx, dy] of [[-3, -1], [0, -2], [3, -1], [-1.5, 1.5], [1.5, 1.5], [0, 4]])
      { ctx.beginPath(); ctx.arc(gx + dx, gy + dy, 1.8, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    ctx.fillStyle = '#cfd3d8'; ctx.beginPath(); ctx.ellipse(cx, top + 1, w / 2, 3, 0, 0, Math.PI * 2); ctx.fill(); // top rim
    ctx.fillStyle = '#9aa0a8'; ctx.beginPath(); ctx.ellipse(cx, top + 1, w / 2 - 2, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(cx, top + h - 1, w / 2 - 1, 2, 0, 0, Math.PI * 2); ctx.fill(); // base
  }

  // The Freeze power-up is a pair of sneakers (white upper, black swoosh).
  function drawSneaker(x, y, s) {
    ctx.fillStyle = '#f2f3f5';                                  // sole
    roundRect(x - 11 * s, y + 2 * s, 22 * s, 6 * s, 3 * s); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + 10 * s, y + 3 * s, 3 * s, 4 * s, 0, 0, Math.PI * 2); ctx.fill(); // toe
    ctx.fillStyle = '#fcfdff';                                  // upper
    ctx.beginPath();
    ctx.moveTo(x - 11 * s, y + 3 * s);
    ctx.lineTo(x - 9 * s, y - 5 * s);
    ctx.quadraticCurveTo(x - 2 * s, y - 8 * s, x + 6 * s, y - 4 * s);
    ctx.lineTo(x + 12 * s, y + 2 * s);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#dfe6ee';                                  // ankle collar
    ctx.beginPath(); ctx.ellipse(x - 7 * s, y - 4 * s, 3 * s, 3 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 2 * s; ctx.lineCap = 'round';   // swoosh
    ctx.beginPath(); ctx.moveTo(x - 4 * s, y - 1 * s); ctx.quadraticCurveTo(x + 3 * s, y + 1 * s, x + 9 * s, y - 4 * s); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1;    // midsole seam
    ctx.beginPath(); ctx.moveTo(x - 11 * s, y + 2.5 * s); ctx.lineTo(x + 11 * s, y + 1.5 * s); ctx.stroke();
    ctx.lineCap = 'butt';
  }
  function drawSneakers(cx, cy) {
    ctx.globalAlpha = 0.7; drawSneaker(cx - 5, cy - 4, 0.62); ctx.globalAlpha = 1;  // back shoe
    drawSneaker(cx + 3, cy + 3, 0.72);                                              // front shoe
  }

  function drawPowerups(time) {
    for (const p of powerups) {
      const yy = p.y - 6 - Math.sin(time * 3 + p.bob) * 3;
      const c = POWERUPS[p.key].color;
      if (p.key === 'freeze') {
        ctx.save(); ctx.shadowColor = c; ctx.shadowBlur = 14;
        drawSneakers(p.x, yy);
        ctx.restore();
      } else if (p.key === 'speed') {
        ctx.save(); ctx.shadowColor = c; ctx.shadowBlur = 14;
        drawChickenBucket(p.x, yy);
        ctx.restore();
      } else if (p.key === 'slow') {
        ctx.save(); ctx.shadowColor = c; ctx.shadowBlur = 14;
        drawSodaCan(p.x, yy);
        ctx.restore();
      } else {
        ctx.save();
        ctx.shadowColor = c; ctx.shadowBlur = 16;
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p.x, yy, 13, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#10141a'; ctx.font = 'bold 15px -apple-system, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(POWERUPS[p.key].icon, p.x, yy + 1);
      }
      ctx.strokeStyle = c; ctx.globalAlpha = 0.5; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, yy, 18, -Math.PI / 2, -Math.PI / 2 + (p.ttl / 11) * Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function draw(time) {
    // base transform: scale logical coords up to the oversampled backing store
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // outside / yard
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, W, H);

    updateCamera();
    ctx.save();
    ctx.translate(-Math.round(cam.x), -Math.round(cam.y));

    // room floors + furniture + labels
    for (const rm of rooms) {
      drawFloor(rm);
      // baseboard: a soft inset frame so the floor reads as enclosed
      ctx.strokeStyle = 'rgba(0,0,0,0.20)'; ctx.lineWidth = 3;
      ctx.strokeRect(rm.x + 1.5, rm.y + 1.5, rm.w - 3, rm.h - 3);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
      ctx.strokeRect(rm.x + 3.5, rm.y + 3.5, rm.w - 7, rm.h - 7);
      drawFurniture(rm);
      drawLabel(rm);
    }

    // dead rooms flash red (urgency = faster pulse as the fuse drains)
    for (const d of detectors) {
      if (d.state !== 'dead') continue;
      const urg = 1 - d.fuse / d.grace;
      const pulse = Math.sin(time * (5 + urg * 12)) * 0.5 + 0.5;
      ctx.fillStyle = `rgba(225,46,46,${0.10 + 0.30 * pulse})`;
      ctx.fillRect(d.room.x, d.room.y, d.room.w, d.room.h);
    }

    // walls
    for (const w of walls) {
      ctx.fillStyle = '#5b6573';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(w.x, w.y, w.w, Math.min(4, w.h));            // top highlight
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(w.x, w.y + w.h - Math.min(4, w.h), w.w, Math.min(4, w.h)); // bottom shade
    }

    // windows in the outer walls + doorway thresholds
    drawWindows();
    drawThresholds();

    // detectors
    for (const d of detectors) drawDetector(d, time);

    // power-ups
    drawPowerups(time);

    // player
    drawPlayer(player.x, player.y);

    if (DEBUG) drawDebugWorld();

    ctx.restore();   // end camera transform — overlays below are screen-fixed

    drawOffscreenIndicators(time);
    if (mode === 'play') drawEffects();
    if (DEBUG) drawDebugText();

    // prompt (DOM) when near a dead detector
    let near = null, nd = effReach();
    for (const d of detectors) {
      if (d.state !== 'dead') continue;
      const dist = Math.hypot(d.x - player.x, d.y - player.y);
      if (dist < nd) { nd = dist; near = d; }
    }
    const prompt = $('prompt');
    if (near && mode === 'play') {
      prompt.textContent = '🔋 Replace battery (E)';
      prompt.classList.remove('hidden');
    } else prompt.classList.add('hidden');
  }

  function drawDetector(d, time) {
    const x = d.x, y = d.y;
    const dead = d.state === 'dead';
    // mounting plate
    ctx.fillStyle = '#cfd6de';
    ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#aeb6c0';
    ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.stroke();
    // vents
    ctx.strokeStyle = '#8d96a2'; ctx.lineWidth = 1.5;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6);
      ctx.lineTo(x + Math.cos(a) * 11, y + Math.sin(a) * 11);
      ctx.stroke();
    }
    // LED
    if (dead) {
      const blink = Math.sin(time * 14) > 0;
      ctx.fillStyle = blink ? '#ff3b30' : '#7a1410';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      if (blink) { ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0; }

      // sound waves
      ctx.strokeStyle = `rgba(255,80,70,${0.5 + 0.4 * Math.sin(time * 10)})`;
      ctx.lineWidth = 2;
      for (let k = 1; k <= 2; k++) {
        ctx.beginPath(); ctx.arc(x, y, 15 + k * 7 + (Math.sin(time * 8) + 1) * 2, -0.8, 0.8); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 15 + k * 7 + (Math.sin(time * 8) + 1) * 2, Math.PI - 0.8, Math.PI + 0.8); ctx.stroke();
      }

      // countdown ring — colored by detector type
      const frac = clamp(d.fuse / d.grace, 0, 1);
      const ringC = d.type === 'fast' ? '#ff5a3c' : d.type === 'stubborn' ? '#b07cff'
        : (frac > 0.4 ? '#ffd24a' : '#ff4b3e');
      ctx.strokeStyle = ringC;
      ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, y, 21, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
      ctx.lineCap = 'butt';

      // type bubble above: ⚡ fast, press-count for stubborn, otherwise !
      const by = y - 40 - (Math.sin(time * 8) + 1) * 2;
      const glyph = d.type === 'fast' ? '⚡' : d.type === 'stubborn' ? String(d.presses) : '!';
      ctx.fillStyle = d.type === 'stubborn' ? '#7d4bd6' : d.type === 'fast' ? '#ff5a3c' : '#ff3b30';
      roundRect(x - 11, by - 13, 22, 24, 6); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x - 5, by + 9); ctx.lineTo(x + 5, by + 9); ctx.lineTo(x, by + 16); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(glyph, x, by);
    } else {
      const blink = Math.sin(time * 2.2) > 0.9; // occasional healthy blip
      ctx.fillStyle = blink ? '#9dffb0' : '#3ad65f';
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------- Player sprite ----------
  // Drop a sprite GRID at the path below: `cols` equal-width frames across,
  // `rows` directional views down. Column 0 = standing still; columns 1..N-1 =
  // the walk cycle. Each row is a view: front (walking toward you), side
  // (facing right — mirrored for left), and back (walking away). Until the
  // image loads (or if it 404s) the game falls back to the stick figure.
  const PLAYER_SPRITE = {
    src: '/assets/sprites/player.png',
    cols: 6,          // frames per row (col 0 idle, 1..N-1 walk cycle)
    rows: 3,          // directional views, in this order: front, side, back
    height: 60,       // on-screen draw height in px (width keeps source aspect)
    fps: 10,          // walk-cycle animation speed
    pixelArt: false,  // true = crisp/nearest-neighbour; false = smooth scaling
    // which row each direction uses; 'left' reuses the side row, mirrored
    rowFor: { down: 0, right: 1, left: 1, up: 2 },
  };
  const playerImg = new Image();
  playerImg.src = PLAYER_SPRITE.src;

  function drawPlayer(x, y) {
    if (!playerImg.complete || !playerImg.naturalWidth) { drawStickFigure(x, y); return; }

    const cols = PLAYER_SPRITE.cols, rows = PLAYER_SPRITE.rows;
    const fw = playerImg.naturalWidth / cols;                  // source frame size
    const fh = playerImg.naturalHeight / rows;
    const walking = (keys.up || keys.down || keys.left || keys.right) && mode === 'play';

    const dir = player.dir || 'down';
    const row = PLAYER_SPRITE.rowFor[dir] != null ? PLAYER_SPRITE.rowFor[dir] : 0;
    const mirror = dir === 'left' ? -1 : 1;

    let col = 0;
    if (walking && cols > 1) {
      const cycle = cols - 1;                                  // columns 1..N-1
      col = 1 + (Math.floor(player.walkPhase / 12 * PLAYER_SPRITE.fps) % cycle);
    }

    const drawH = PLAYER_SPRITE.height;
    const drawW = drawH * (fw / fh);

    // keep the soft ground shadow from the original look
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath(); ctx.ellipse(x, y + 2, drawW * 0.30, 4, 0, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(mirror, 1);                                      // mirror side view for left
    ctx.imageSmoothingEnabled = !PLAYER_SPRITE.pixelArt;
    ctx.drawImage(playerImg, col * fw, row * fh, fw, fh, -drawW / 2, -drawH + 4, drawW, drawH);
    ctx.restore();
  }

  function drawStickFigure(x, y) {
    const walking = (keys.up || keys.down || keys.left || keys.right) && mode === 'play';
    const swing = Math.sin(player.walkPhase) * 5 * (walking ? 1 : 0);
    const bob = walking ? Math.abs(Math.sin(player.walkPhase)) * 1.5 : 0;
    const head = y - 30 - bob;

    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath(); ctx.ellipse(x, y + 2, 12, 4, 0, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = '#f4f6f8'; ctx.fillStyle = '#f4f6f8';
    ctx.lineWidth = 3.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    ctx.beginPath(); ctx.arc(x, head, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x, head + 6); ctx.lineTo(x, head + 22); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, head + 11); ctx.lineTo(x + 9 * player.facing, head + 17 + swing);
    ctx.moveTo(x, head + 11); ctx.lineTo(x - 5 * player.facing, head + 18 - swing);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, head + 22); ctx.lineTo(x + 7 + swing, y);
    ctx.moveTo(x, head + 22); ctx.lineTo(x - 7 - swing, y);
    ctx.stroke();
  }

  // ---------- Loop ----------
  // One deterministic simulation tick: record + apply this tick's queued inputs,
  // then advance the sim by the fixed timestep. Re-running these ticks with the
  // same seed + recorded inputs reproduces the run exactly (for server verify).
  function stepSim() {
    for (const ev of pendingInputs) { inputLog.push([simTick, ev[0], ev[1]]); applyInput(ev[0], ev[1]); }
    pendingInputs.length = 0;
    update(FIXED_DT);
    simTick++;
  }

  let lastTs = 0;
  function loop(ts) {
    const real = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    if (mode === 'play') {
      simAcc += Math.min(0.25, real);                 // clamp after tab-away
      let steps = 0;
      while (simAcc >= FIXED_DT && steps < 8) { stepSim(); simAcc -= FIXED_DT; steps++; }
      if (steps === 8) simAcc = 0;                     // drop unrecoverable backlog
    } else {
      simAcc = 0;
    }
    draw(ts / 1000);
    requestAnimationFrame(loop);
  }

  // ---------- Determinism self-test (dev-only) ----------
  function simStateHash() {
    let h = 2166136261 >>> 0;
    const add = (n) => { h ^= (Math.round(n * 1000) | 0); h = Math.imul(h, 16777619) >>> 0; };
    add(player.x); add(player.y); add(score); add(saved); add(lives); add(simTick); add(spawnTimer); add(powerupTimer);
    for (const d of detectors) { add(d.state === 'dead' ? 1 : 0); add(d.fuse); add(d.presses); }
    for (const p of powerups) { add(p.x); add(p.y); add(p.ttl); }
    return h >>> 0;
  }
  function runDetTest() {
    const SEED = 12345, TICKS = 900;
    const once = () => {
      runSeed = SEED; rng = mulberry32(runSeed); simTick = 0; inputLog = []; simAcc = 0; clearInputs();
      houseIdx = 0; buildHouse(HOUSES[0].cols, HOUSES[0].rows);
      score = 0; saved = 0; combo = 0; bestCombo = 0; maxLives = startLives(); lives = maxLives;
      powerups = []; powerupTimer = 9; effects.freeze = 0; effects.speed = 0; effects.slow = 0;
      player.speed = baseSpeed(); const sp = safeSpawn(); player.x = sp.x; player.y = sp.y; spawnTimer = 2.2;
      mode = 'play';
      for (let t = 0; t < TICKS; t++) {
        pendingInputs.length = 0;
        if (t === 0) pendingInputs.push([1, 1]);
        if (t === 180) { pendingInputs.push([1, 0]); pendingInputs.push([3, 1]); }
        if (t === 360) { pendingInputs.push([3, 0]); pendingInputs.push([0, 1]); }
        if (t % 50 === 0) pendingInputs.push([4, 1]);
        stepSim();
      }
      return simStateHash();
    };
    const a = once(), b = once();
    mode = 'start';
    return { a, b, ok: a === b };
  }

  // ---------- Boot ----------
  buildHouse(HOUSES[houseIdx].cols, HOUSES[houseIdx].rows);
  syncHUD();
  // kick off audio + music on the first user interaction (autoplay policy)
  window.addEventListener('pointerdown', ensureAudio, { once: true });
  window.addEventListener('keydown', ensureAudio, { once: true });
  requestAnimationFrame(loop);

  // dev-only: ?debug&dettest runs the determinism self-test and shows the result
  if (DEBUG && /[?&]dettest/.test(location.search)) {
    const r = runDetTest();
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;z-index:999;top:50%;left:50%;transform:translate(-50%,-50%);font:bold 26px monospace;color:#fff;background:rgba(0,0,0,0.85);padding:22px 34px;border-radius:14px;text-align:center';
    el.innerHTML = (r.ok ? '✅ DETERMINISM OK' : '❌ DETERMINISM FAIL') + '<br><span style="font-size:16px;color:#9aa4b2">hashes ' + r.a + ' / ' + r.b + '</span>';
    document.body.appendChild(el);
  }
  // dev-only: ?debug&shop previews the shop with a full wallet
  if (DEBUG && /[?&]shop/.test(location.search)) { bank = 800; openShop(); }
  // dev-only: ?debug&options previews the options menu
  if (DEBUG && /[?&]options/.test(location.search)) openOptions();
  // dev-only: ?debug&guide previews the how-to-play screen
  if (DEBUG && /[?&]guide/.test(location.search)) openGuide();
  // dev-only: ?debug&house=N&play seeds a live scene for screenshots
  if (DEBUG && /[?&]play/.test(location.search)) {
    startGame();
    const m = location.search.match(/house=(\d)/);
    if (m) { houseIdx = clamp(+m[1], 0, HOUSES.length - 1); const hd = HOUSES[houseIdx]; buildHouse(hd.cols, hd.rows); const sp = safeSpawn(); player.x = sp.x; player.y = sp.y; saved = PROMOTE_AT[houseIdx]; syncHUD(); }
    for (let k = 0; k < Math.min(3, detectors.length); k++) killRandomDetector();
    detectors[0] && (detectors[0].type = 'fast');
    if (detectors[1]) { detectors[1].type = 'stubborn'; detectors[1].presses = 2; }
    powerups.push({ key: 'freeze', x: player.x + 50, y: player.y, ttl: 11, bob: 0 });
    powerups.push({ key: 'slow', x: player.x + 100, y: player.y, ttl: 11, bob: 2 });
    powerups.push({ key: 'speed', x: player.x + 150, y: player.y, ttl: 11, bob: 1 });
    effects.freeze = 4; effects.slow = 7;
    if (/[?&]paused/.test(location.search)) pauseGame();
  }
})();
