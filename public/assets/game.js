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

  function draw() {
    const cam = clamp(player.x - W / 2, 0, WORLD_WIDTH - W);

    // sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0e1726');
    sky.addColorStop(1, '#1b2a3f');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // distant skyline (parallax)
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let i = 0; i < 30; i++) {
      const bx = (i * 180 - cam * 0.3) % (WORLD_WIDTH);
      const bh = 80 + ((i * 53) % 120);
      ctx.fillRect(bx, GROUND_Y - bh, 120, bh);
    }

    ctx.save();
    ctx.translate(-cam, 0);

    // ground
    ctx.fillStyle = '#10161f';
    ctx.fillRect(0, GROUND_Y, WORLD_WIDTH, H - GROUND_Y);
    ctx.fillStyle = '#1a2230';
    ctx.fillRect(0, GROUND_Y, WORLD_WIDTH, 6);
    // sidewalk dashes
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let x = 0; x < WORLD_WIDTH; x += 60) ctx.fillRect(x, GROUND_Y + 30, 30, 4);

    // buildings
    buildings.forEach((b) => {
      const bw = 130, bh = 180;
      const bx = b.x - bw / 2, by = GROUND_Y - bh;
      ctx.fillStyle = b.color;
      ctx.fillRect(bx, by, bw, bh);
      // roof line
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(bx, by, bw, 10);
      // windows
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
          ctx.fillRect(bx + 16 + c * 36, by + 24 + r * 36, 22, 22);
      // door
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(b.x - 16, GROUND_Y - 42, 32, 42);
      // sign
      ctx.fillStyle = '#fff';
      ctx.font = '20px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.emoji, b.x, by - 16);
      ctx.font = 'bold 13px -apple-system, sans-serif';
      ctx.fillStyle = '#cdd6e2';
      ctx.fillText(b.name, b.x, by - 2);
    });

    drawStickman(player.x, GROUND_Y);

    ctx.restore();
  }

  function drawStickman(x, groundY) {
    const y = groundY - 54; // feet baseline → head area
    ctx.strokeStyle = '#f4f6f8';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    const swing = Math.sin(player.walkPhase) * 6 * ((keys.left || keys.right) ? 1 : 0);

    // head
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.stroke();
    // body
    ctx.beginPath();
    ctx.moveTo(x, y + 9);
    ctx.lineTo(x, y + 34);
    ctx.stroke();
    // arms
    ctx.beginPath();
    ctx.moveTo(x, y + 16);
    ctx.lineTo(x + 12 * player.facing, y + 24 + swing);
    ctx.moveTo(x, y + 16);
    ctx.lineTo(x - 6 * player.facing, y + 26 - swing);
    ctx.stroke();
    // legs
    ctx.beginPath();
    ctx.moveTo(x, y + 34);
    ctx.lineTo(x + 9 + swing, y + 54);
    ctx.moveTo(x, y + 34);
    ctx.lineTo(x - 9 - swing, y + 54);
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
