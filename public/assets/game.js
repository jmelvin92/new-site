/* Stick City — a tiny stick-figure life sim.
 * Vanilla JS, no build step, no dependencies. Deploys as a static file.
 *
 * Move around a city, work for money, train your stats, buy upgrades.
 *
 * NOTE (future play-to-earn): all currency flows through the Bank object below.
 * Today it's just a number in localStorage. To make the in-game cash a real
 * Solana SPL token later, you only have to reimplement Bank.balance/earn/spend
 * (e.g. read the player's token account, send mints from a faucet wallet).
 * The rest of the game never touches money directly. Keep it that way.
 */
(function () {
  'use strict';

  const SAVE_KEY = 'stickcity.save.v1';
  const DAY_START_HOUR = 8;
  const SLEEP_RENT = 20; // daily rent charged on waking

  // ---------- Game state ----------
  const defaultState = () => ({
    day: 1,
    hour: DAY_START_HOUR,
    money: 50,
    energy: 100,
    health: 100,
    int: 10,
    str: 10,
    chr: 10,
    ownsPenthouse: false,
    won: false,
  });

  let state = load() || defaultState();

  // ---------- Bank (currency abstraction — swap for Solana token later) ----------
  const Bank = {
    get balance() { return state.money; },
    earn(n) { state.money += n; },
    canAfford(n) { return state.money >= n; },
    spend(n) { if (state.money < n) return false; state.money -= n; return true; },
  };

  // ---------- Helpers ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const $ = (id) => document.getElementById(id);

  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); flash('Saved'); } catch (e) {}
  }
  function load() {
    try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function resetGame() {
    state = defaultState();
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
    closeModal();
    $('winscreen').classList.add('hidden');
    updateHUD();
    flash('New game');
  }

  function fmtTime(h) {
    const hr = Math.floor(h) % 24;
    return String(hr).padStart(2, '0') + ':00';
  }

  let toastTimer = null;
  function flash(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1400);
  }

  // Advance the clock; roll the day over and force-sleep if it gets too late.
  function advanceTime(hours) {
    state.hour += hours;
    if (state.hour >= 24) {
      // stayed out past midnight — crash and lose a bit of health
      state.health = clamp(state.health - 10, 0, 100);
      sleep(true);
    }
  }

  function sleep(forced) {
    state.day += 1;
    state.hour = DAY_START_HOUR;
    state.energy = 100;
    state.health = clamp(state.health + (forced ? 5 : 25), 0, 100);
    if (!Bank.spend(SLEEP_RENT)) {
      // can't pay rent — penalty
      state.money = 0;
      state.health = clamp(state.health - 10, 0, 100);
      flash('Couldn’t pay rent! −health');
    }
  }

  function checkWin() {
    if (state.won) return;
    if (state.ownsPenthouse && Bank.balance >= 5000) {
      state.won = true;
      $('win-text').textContent =
        `You bought the penthouse and stacked $${Bank.balance} on Day ${state.day}. ` +
        `Int ${state.int} · Str ${state.str} · Chr ${state.chr}.`;
      $('winscreen').classList.remove('hidden');
      save();
    }
  }

  // ---------- Buildings + actions ----------
  // x is the building's center in world coordinates.
  const buildings = [
    {
      id: 'home', name: 'Apartment', emoji: '🏠', x: 220, color: '#3b4a5a',
      desc: 'Your place. Sleep to start a new day (rent $' + SLEEP_RENT + '/day).',
      actions: [
        { label: 'Sleep until morning', hint: 'Restores energy & some health',
          cost: { time: 0 }, can: () => true,
          run: () => { sleep(false); } },
      ],
    },
    {
      id: 'job', name: 'Office', emoji: '🏢', x: 620, color: '#2f5d62',
      desc: 'Earn money. Better-paying jobs need higher stats.',
      actions: [
        { label: 'Hand out flyers', hint: 'No requirements',
          cost: { time: 2, energy: 15 }, pay: () => 25,
          can: () => true, run: jobRun(25) },
        { label: 'Office clerk', hint: 'Needs Int 25',
          cost: { time: 3, energy: 20 }, pay: () => 60 + state.int,
          can: () => state.int >= 25, run: jobRun(() => 60 + state.int) },
        { label: 'Executive', hint: 'Needs Int 50 & Chr 40',
          cost: { time: 4, energy: 25 }, pay: () => 160 + state.int + state.chr * 2,
          can: () => state.int >= 50 && state.chr >= 40,
          run: jobRun(() => 160 + state.int + state.chr * 2) },
      ],
    },
    {
      id: 'gym', name: 'Gym', emoji: '💪', x: 1020, color: '#6b3b3b',
      desc: 'Build Strength.',
      actions: [
        { label: 'Work out', hint: '+3 Strength',
          cost: { time: 2, energy: 12, money: 10 }, can: () => Bank.canAfford(10),
          run: () => { state.str = clamp(state.str + 3, 0, 100); } },
      ],
    },
    {
      id: 'college', name: 'College', emoji: '🎓', x: 1420, color: '#3b4f6b',
      desc: 'Raise Intelligence.',
      actions: [
        { label: 'Study', hint: '+3 Intelligence',
          cost: { time: 3, energy: 12, money: 15 }, can: () => Bank.canAfford(15),
          run: () => { state.int = clamp(state.int + 3, 0, 100); } },
      ],
    },
    {
      id: 'bar', name: 'Bar', emoji: '🍺', x: 1820, color: '#5a4b2f',
      desc: 'Socialize for Charm (it’s tiring).',
      actions: [
        { label: 'Socialize', hint: '+3 Charm, costs energy',
          cost: { time: 2, energy: 18, money: 20 }, can: () => Bank.canAfford(20),
          run: () => { state.chr = clamp(state.chr + 3, 0, 100); } },
      ],
    },
    {
      id: 'shop', name: 'Shop', emoji: '🛒', x: 2220, color: '#3f5a3f',
      desc: 'Restock and buy the big upgrade.',
      actions: [
        { label: 'Coffee', hint: '+25 Energy',
          cost: { time: 0, money: 5 }, can: () => Bank.canAfford(5),
          run: () => { state.energy = clamp(state.energy + 25, 0, 100); } },
        { label: 'Hot meal', hint: '+20 Health',
          cost: { time: 1, money: 15 }, can: () => Bank.canAfford(15),
          run: () => { state.health = clamp(state.health + 20, 0, 100); } },
        { label: 'Buy the Penthouse 🏆', hint: 'Win goal — needs $3000',
          cost: { time: 0, money: 3000 },
          can: () => !state.ownsPenthouse && Bank.canAfford(3000),
          run: () => { state.ownsPenthouse = true; flash('Penthouse purchased!'); } },
      ],
    },
  ];

  // Build a job runner that pays out (fixed amount or function).
  function jobRun(pay) {
    return function () { Bank.earn(typeof pay === 'function' ? pay() : pay); };
  }

  const WORLD_WIDTH = 2440;
  const GROUND_Y = 460;

  // ---------- Player ----------
  const player = { x: 220, speed: 3.2, facing: 1, walkPhase: 0 };

  // ---------- Input ----------
  const keys = { left: false, right: false };
  let modalOpen = false;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = true;
    else if (e.key === 'ArrowRight' || e.key === 'd') keys.right = true;
    else if (e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'w') {
      if (modalOpen) return;
      const b = nearBuilding();
      if (b) openModal(b);
    } else if (e.key === 'Escape') {
      closeModal();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') keys.left = false;
    else if (e.key === 'ArrowRight' || e.key === 'd') keys.right = false;
  });

  // Touch controls
  document.querySelectorAll('#touch button').forEach((btn) => {
    const k = btn.dataset.key;
    const press = (v) => {
      if (k === 'left') keys.left = v;
      else if (k === 'right') keys.right = v;
      else if (k === 'enter' && v) { const b = nearBuilding(); if (b) openModal(b); }
    };
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); press(true); }, { passive: false });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); press(false); }, { passive: false });
    btn.addEventListener('mousedown', () => press(true));
    btn.addEventListener('mouseup', () => press(false));
    btn.addEventListener('mouseleave', () => press(false));
  });

  function nearBuilding() {
    return buildings.find((b) => Math.abs(b.x - player.x) < 70) || null;
  }

  // ---------- Modal ----------
  let activeBuilding = null;

  function costLabel(c) {
    const parts = [];
    if (c.money) parts.push(`<span class="minus">−$${c.money}</span>`);
    if (c.energy) parts.push(`<span class="minus">−${c.energy}⚡</span>`);
    if (c.time) parts.push(`<span class="minus">${c.time}h</span>`);
    return parts.join(' ');
  }

  function payLabel(a) {
    if (!a.pay) return '';
    const amt = typeof a.pay === 'function' ? a.pay() : a.pay;
    return `<span class="plus">+$${amt}</span> `;
  }

  function openModal(b) {
    activeBuilding = b;
    modalOpen = true;
    keys.left = keys.right = false;
    $('modal-title').textContent = `${b.emoji} ${b.name}`;
    $('modal-desc').textContent = b.desc;
    renderActions();
    $('modal').classList.remove('hidden');
  }

  function renderActions() {
    const b = activeBuilding;
    const wrap = $('modal-actions');
    wrap.innerHTML = '';
    b.actions.forEach((a, i) => {
      const enough = (!a.cost.energy || state.energy >= a.cost.energy);
      const ok = a.can() && enough;
      const btn = document.createElement('button');
      btn.className = 'action';
      btn.disabled = !ok;
      btn.innerHTML =
        `<span class="a-main"><span class="a-label">${a.label}</span>` +
        `<span class="a-hint">${a.hint}${!enough ? ' · too tired' : ''}</span></span>` +
        `<span class="a-cost">${payLabel(a)}${costLabel(a.cost)}</span>`;
      btn.addEventListener('click', () => doAction(a));
      wrap.appendChild(btn);
    });
  }

  function doAction(a) {
    const enough = (!a.cost.energy || state.energy >= a.cost.energy);
    if (!a.can() || !enough) return;
    if (a.cost.money) { if (!Bank.spend(a.cost.money)) return; }
    if (a.cost.energy) state.energy = clamp(state.energy - a.cost.energy, 0, 100);
    a.run();
    if (a.cost.time) advanceTime(a.cost.time);
    updateHUD();
    checkWin();
    if (state.won) { closeModal(); return; }
    renderActions(); // refresh affordability/requirements so you can act again
  }

  function closeModal() {
    modalOpen = false;
    activeBuilding = null;
    $('modal').classList.add('hidden');
  }

  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('btn-save').addEventListener('click', save);
  $('btn-reset').addEventListener('click', () => { if (confirm('Start over? This wipes your save.')) resetGame(); });
  $('win-restart').addEventListener('click', resetGame);

  // ---------- HUD ----------
  function updateHUD() {
    $('day').textContent = state.day;
    $('clock').textContent = fmtTime(state.hour);
    $('money').textContent = state.money;
    $('bar-energy').style.width = state.energy + '%';
    $('bar-health').style.width = state.health + '%';
    $('bar-int').style.width = state.int + '%';
    $('bar-str').style.width = state.str + '%';
    $('bar-chr').style.width = state.chr + '%';
  }

  // ---------- Rendering ----------
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  function update() {
    if (!modalOpen) {
      if (keys.left) { player.x -= player.speed; player.facing = -1; player.walkPhase += 0.3; }
      if (keys.right) { player.x += player.speed; player.facing = 1; player.walkPhase += 0.3; }
      player.x = clamp(player.x, 40, WORLD_WIDTH - 40);
    }
    // prompt when near a door
    const b = nearBuilding();
    const prompt = $('prompt');
    if (b && !modalOpen) {
      prompt.textContent = `↑ Enter ${b.name}`;
      prompt.classList.remove('hidden');
    } else {
      prompt.classList.add('hidden');
    }
  }

  // ---------- Visual helpers ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  function hexRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function mix(c1, c2, t) { return `rgb(${Math.round(lerp(c1[0], c2[0], t))},${Math.round(lerp(c1[1], c2[1], t))},${Math.round(lerp(c1[2], c2[2], t))})`; }
  function shade(h, amt) { const c = hexRgb(h); return `rgb(${clamp(c[0] + amt, 0, 255)},${clamp(c[1] + amt, 0, 255)},${clamp(c[2] + amt, 0, 255)})`; }
  function rrect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 0 = bright noon, 1 = deep night
  function darkness() {
    const h = state.hour;
    if (h >= 7 && h <= 17) return 0;
    if (h > 17 && h < 20) return (h - 17) / 3;       // dusk
    if (h >= 20 || h < 5) return 1;                  // night
    return 1 - (h - 5) / 2;                           // dawn 5–7
  }

  // Per-building art treatment
  const STYLE = {
    home:    { body: '#9a6b57', trim: '#6f4a3b', awning: '#d98a5c', h: 175 },
    job:     { body: '#3f6e8c', trim: '#2b4d63', awning: '#6fb1d6', h: 232 },
    gym:     { body: '#a14d4d', trim: '#723535', awning: '#e87b7b', h: 158 },
    college: { body: '#4f5fa8', trim: '#374373', awning: '#8a98e6', h: 210 },
    bar:     { body: '#977244', trim: '#6b5130', awning: '#dcae72', h: 150 },
    shop:    { body: '#4f9461', trim: '#367544', awning: '#74da92', h: 178 },
  };

  const props = [
    { type: 'tree', x: 110 }, { type: 'lamp', x: 410 }, { type: 'hydrant', x: 800 },
    { type: 'lamp', x: 820 }, { type: 'tree', x: 1210 }, { type: 'lamp', x: 1230 },
    { type: 'bench', x: 1610 }, { type: 'tree', x: 2010 }, { type: 'lamp', x: 2030 },
    { type: 'tree', x: 2390 },
  ];

  function draw() {
    const cam = clamp(player.x - W / 2, 0, WORLD_WIDTH - W);
    const dk = darkness();

    // ----- Sky -----
    const skyTop = mix([120, 178, 235], [10, 13, 32], dk);
    const skyBot = mix([205, 226, 246], [32, 42, 74], dk);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, skyTop);
    sky.addColorStop(1, skyBot);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // stars at night
    if (dk > 0.4) {
      ctx.fillStyle = `rgba(255,255,255,${(dk - 0.4) * 0.9})`;
      for (let i = 0; i < 60; i++) {
        const sx = ((i * 137) % W);
        const sy = ((i * 89) % (GROUND_Y - 120));
        ctx.fillRect(sx, sy, 2, 2);
      }
    }

    // sun / moon arc across the day
    const dayT = clamp((state.hour - 6) / 12, 0, 1); // 6:00→18:00
    const cx = lerp(60, W - 60, dayT);
    const cy = GROUND_Y - 120 - Math.sin(dayT * Math.PI) * 180;
    if (dk < 0.6) {
      ctx.fillStyle = '#ffd86b';
      ctx.shadowColor = 'rgba(255,216,107,0.6)'; ctx.shadowBlur = 30;
      ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = '#e6ecff';
      ctx.beginPath(); ctx.arc(W - 120, 80, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = skyTop;
      ctx.beginPath(); ctx.arc(W - 112, 74, 16, 0, Math.PI * 2); ctx.fill();
    }

    // drifting clouds (parallax, only when light)
    if (dk < 0.7) {
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - dk)})`;
      for (let i = 0; i < 6; i++) {
        const cxx = ((i * 520 + state.day * 40 - cam * 0.2) % (WORLD_WIDTH)) ;
        const cyy = 60 + (i * 37) % 120;
        cloud(cxx, cyy);
      }
    }

    // distant skyline silhouette (parallax)
    ctx.fillStyle = mix([150, 170, 200], [18, 24, 44], Math.max(dk, 0.25));
    for (let i = 0; i < 40; i++) {
      const bx = ((i * 150 - cam * 0.4) % (WORLD_WIDTH + 300)) - 150;
      const bh = 70 + ((i * 53) % 130);
      ctx.fillRect(bx, GROUND_Y - bh, 110, bh);
    }

    ctx.save();
    ctx.translate(-cam, 0);

    // ----- Street -----
    // sidewalk
    ctx.fillStyle = mix([176, 184, 196], [40, 48, 62], dk);
    ctx.fillRect(0, GROUND_Y, WORLD_WIDTH, 32);
    // curb
    ctx.fillStyle = mix([150, 158, 170], [28, 34, 46], dk);
    ctx.fillRect(0, GROUND_Y + 32, WORLD_WIDTH, 4);
    // road
    ctx.fillStyle = mix([56, 60, 70], [14, 16, 22], dk);
    ctx.fillRect(0, GROUND_Y + 36, WORLD_WIDTH, H - (GROUND_Y + 36));
    // center dashes
    ctx.fillStyle = mix([230, 200, 90], [120, 105, 50], dk);
    for (let x = 0; x < WORLD_WIDTH; x += 70) ctx.fillRect(x, GROUND_Y + 64, 38, 5);
    // sidewalk seams
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1;
    for (let x = 0; x < WORLD_WIDTH; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, GROUND_Y); ctx.lineTo(x, GROUND_Y + 30); ctx.stroke();
    }

    // ----- Buildings -----
    buildings.forEach((b, idx) => drawBuilding(b, idx, dk));

    // ----- Props -----
    props.forEach((p) => {
      if (p.type === 'tree') drawTree(p.x, dk);
      else if (p.type === 'lamp') drawLamp(p.x, dk);
      else if (p.type === 'bench') drawBench(p.x, dk);
      else if (p.type === 'hydrant') drawHydrant(p.x);
    });

    drawStickman(player.x, GROUND_Y);

    ctx.restore();

    // night vignette
    if (dk > 0.3) {
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.9);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, `rgba(0,0,10,${(dk - 0.3) * 0.5})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function cloud(x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.arc(x + 22, y + 4, 22, 0, Math.PI * 2);
    ctx.arc(x + 48, y, 16, 0, Math.PI * 2);
    ctx.rect(x, y, 48, 18);
    ctx.fill();
  }

  function drawBuilding(b, idx, dk) {
    const st = STYLE[b.id] || { body: b.color, trim: '#222', awning: '#888', h: 180 };
    const bw = 150, bh = st.h;
    const bx = b.x - bw / 2, by = GROUND_Y - bh;

    // shadow on sidewalk
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(bx - 4, GROUND_Y, bw + 8, 8);

    // body with subtle vertical gradient
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    g.addColorStop(0, shade(st.body, 18));
    g.addColorStop(1, shade(st.body, -22));
    ctx.fillStyle = g;
    ctx.fillRect(bx, by, bw, bh);

    // night-darken the facade a touch
    if (dk > 0) { ctx.fillStyle = `rgba(10,12,28,${dk * 0.35})`; ctx.fillRect(bx, by, bw, bh); }

    // cornice / roof trim
    ctx.fillStyle = st.trim;
    ctx.fillRect(bx - 7, by - 14, bw + 14, 18);
    ctx.fillStyle = shade(st.trim, -25);
    ctx.fillRect(bx - 7, by + 2, bw + 14, 3);

    // windows
    const cols = 3, rows = Math.max(2, Math.floor((bh - 70) / 40));
    const wW = 26, wH = 26, gapX = (bw - cols * wW) / (cols + 1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = bx + gapX + c * (wW + gapX);
        const wy = by + 18 + r * 40;
        const lit = ((r * 7 + c * 3 + idx * 5) % 4) !== 0;
        if (dk > 0.25 && lit) {
          ctx.fillStyle = `rgba(255,214,130,${0.35 + 0.55 * dk})`;
        } else {
          ctx.fillStyle = `rgba(150,195,225,${0.18 + 0.12 * (1 - dk)})`;
        }
        rrect(wx, wy, wW, wH, 3); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // awning over the door (striped)
    const awW = 64, awX = b.x - awW / 2, awY = GROUND_Y - 52;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? '#f4f6f8' : st.awning;
      ctx.beginPath();
      ctx.moveTo(awX + i * (awW / 4), awY);
      ctx.lineTo(awX + (i + 1) * (awW / 4), awY);
      ctx.lineTo(awX + (i + 1) * (awW / 4) - 4, awY + 14);
      ctx.lineTo(awX + i * (awW / 4) - 4, awY + 14);
      ctx.closePath(); ctx.fill();
    }

    // door
    ctx.fillStyle = shade(st.trim, -35);
    rrect(b.x - 17, GROUND_Y - 44, 34, 44, 4); ctx.fill();
    ctx.fillStyle = `rgba(255,220,150,${0.15 + 0.45 * dk})`;
    rrect(b.x - 12, GROUND_Y - 38, 24, 32, 3); ctx.fill();
    ctx.fillStyle = '#ffd86b';
    ctx.beginPath(); ctx.arc(b.x + 7, GROUND_Y - 22, 1.8, 0, Math.PI * 2); ctx.fill();

    // sign plaque
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    rrect(b.x - 56, by - 12, 112, 26, 6); ctx.fill();
    ctx.textAlign = 'center';
    ctx.font = '16px -apple-system, sans-serif';
    ctx.fillText(b.emoji, b.x - 34, by + 6);
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(b.name, b.x + 8, by + 5);
  }

  function drawLamp(x, dk) {
    ctx.strokeStyle = '#2b2f38'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, GROUND_Y); ctx.lineTo(x, GROUND_Y - 70); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, GROUND_Y - 70); ctx.lineTo(x + 14, GROUND_Y - 70); ctx.stroke();
    if (dk > 0.3) {
      ctx.fillStyle = 'rgba(255,221,130,0.9)';
      ctx.shadowColor = 'rgba(255,221,130,0.8)'; ctx.shadowBlur = 24 * dk;
      ctx.beginPath(); ctx.arc(x + 14, GROUND_Y - 66, 6, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // pool of light
      const lg = ctx.createRadialGradient(x + 14, GROUND_Y, 4, x + 14, GROUND_Y, 70);
      lg.addColorStop(0, `rgba(255,221,130,${0.18 * dk})`);
      lg.addColorStop(1, 'rgba(255,221,130,0)');
      ctx.fillStyle = lg; ctx.fillRect(x - 56, GROUND_Y - 60, 140, 90);
    } else {
      ctx.fillStyle = '#cfd6e0';
      ctx.beginPath(); ctx.arc(x + 14, GROUND_Y - 66, 5, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawTree(x, dk) {
    ctx.fillStyle = '#5a3f2c';
    ctx.fillRect(x - 4, GROUND_Y - 34, 8, 34);
    const green = mix([74, 150, 90], [30, 70, 45], dk);
    ctx.fillStyle = green;
    [[0, -52, 22], [-16, -42, 18], [16, -42, 18], [0, -68, 16]].forEach(([dx, dy, r]) => {
      ctx.beginPath(); ctx.arc(x + dx, GROUND_Y + dy, r, 0, Math.PI * 2); ctx.fill();
    });
  }

  function drawBench(x, dk) {
    ctx.fillStyle = mix([120, 90, 60], [60, 45, 30], dk);
    ctx.fillRect(x - 22, GROUND_Y - 16, 44, 6);
    ctx.fillRect(x - 22, GROUND_Y - 28, 44, 5);
    ctx.fillStyle = '#2b2f38';
    ctx.fillRect(x - 18, GROUND_Y - 10, 5, 10);
    ctx.fillRect(x + 13, GROUND_Y - 10, 5, 10);
  }

  function drawHydrant(x) {
    ctx.fillStyle = '#d6483a';
    rrect(x - 7, GROUND_Y - 22, 14, 22, 4); ctx.fill();
    ctx.fillRect(x - 11, GROUND_Y - 14, 22, 5);
    ctx.beginPath(); ctx.arc(x, GROUND_Y - 24, 5, 0, Math.PI * 2); ctx.fill();
  }

  function drawStickman(x, groundY) {
    const y = groundY - 54;
    const walking = (keys.left || keys.right) && !modalOpen;
    const swing = Math.sin(player.walkPhase) * 7 * (walking ? 1 : 0);
    const bob = walking ? Math.abs(Math.sin(player.walkPhase)) * 2 : 0;
    const yy = y - bob;

    // soft shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(x, groundY, 14, 4, 0, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = '#0d0f14';
    ctx.fillStyle = '#0d0f14';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';

    // head
    ctx.beginPath(); ctx.arc(x, yy, 9, 0, Math.PI * 2); ctx.fill();
    // body
    ctx.beginPath(); ctx.moveTo(x, yy + 9); ctx.lineTo(x, yy + 34); ctx.stroke();
    // arms
    ctx.beginPath();
    ctx.moveTo(x, yy + 16); ctx.lineTo(x + 12 * player.facing, yy + 24 + swing);
    ctx.moveTo(x, yy + 16); ctx.lineTo(x - 6 * player.facing, yy + 26 - swing);
    ctx.stroke();
    // legs
    ctx.beginPath();
    ctx.moveTo(x, yy + 34); ctx.lineTo(x + 9 + swing, groundY);
    ctx.moveTo(x, yy + 34); ctx.lineTo(x - 9 - swing, groundY);
    ctx.stroke();
  }

  // ---------- Loop ----------
  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- Boot ----------
  if (state.won) $('winscreen').classList.remove('hidden');
  updateHUD();
  loop();
})();
