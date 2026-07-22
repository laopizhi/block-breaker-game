/* =====================================================================
   NEON BLOCK BREAKER  —  vanilla JS + Canvas 2D
   A "Ballz / BBTAN"-style shooter. Fire a stream of bouncing balls at
   descending numbered blocks. Collect powerups. Don't let blocks reach
   the cannon line.
   ===================================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  const COLS = 9;               // grid columns
  const GAP_FRAC = 0.06;        // gap between cells (fraction of cell)
  const BALL_R_FRAC = 0.13;     // ball radius (fraction of cell)
  const SPEED_FRAC = 20;        // ball speed = cell * this (px/sec)
  const FIRE_INTERVAL = 0.05;   // seconds between balls in a stream
  const MAX_LEVEL = 6;          // ball damage level cap (dmg = 2**level -> up to 64x)
  const CHUNK = 2;              // rows that drop/spawn at once, every CHUNK turns
                                // (avg descent stays 1 row/turn, so difficulty is unchanged)

  // --- Difficulty scales off the player's FIREPOWER, not the round number ---
  // Firepower F = total ball damage (sum of 2**level) * a small coverage bonus.
  const COVERAGE = 0.015;       // per extra ball, how much coverage adds to firepower
  const HP_A = 0.9;             // block hp = HP_A * F**HP_P + HP_B  (scales blocks to your power)
  const HP_P = 1.08;            // >1 so the board slowly outpaces raw firepower (gentle ramp)
  const HP_B = 1;               // flat hp floor
  const HP_BIG = 1.9;           // "big" block hp multiplier
  const DENS_START = 6;         // firepower at which boards begin to thicken
  const DENS_SCALE = 90;        // firepower span over which density climbs to DENS_MAX
  const DENS_MAX = 0.45;        // max extra fill probability from density
  // Rare "spice" special blocks (flat frequency at all stages)
  const SPLIT_CHANCE = 0.05;    // chance per spawned row to make one block a splitter
  const BOSS_CHANCE = 0.10;     // chance per chunk to spawn a boss (if allowed)
  const BOSS_COOLDOWN = 12;     // min rounds between bosses
  const BOSS_HP_MULT = 4;       // boss weak-point hp = blockHp() * this
  const AIM_MIN_UP = 0.16;      // min upward component of aim direction
  const TOUCH_SENS = 0.005;     // touch aim: radians of tilt per pixel of horizontal drag
                                // (small = low sensitivity). Lower this to make it calmer.
  const BOARD_ASPECT = 0.62;    // board width / height (portrait, but roomy)
  const HUD_INSET = 54;         // px reserved at top for the HUD

  const COLORS = {
    bg: '#0a0a12',
    ball: '#e9fbff',
    ballGlow: 'rgba(120,240,255,0.9)',
    aim: 'rgba(120,240,255,0.85)',
    aimBounce: 'rgba(255,120,200,0.8)',
    cannon: '#33e6ff'
  };

  // Ball damage tiers: index by level (0 = 1x normal ... 6 = 64x). Higher = hotter.
  const TIER_COLORS = ['#e9fbff', '#ffd23e', '#ff8a3e', '#ff3e6e', '#ff3ea5', '#c58bff', '#ffffff'];
  function tierColor(level) { return TIER_COLORS[Math.min(level, TIER_COLORS.length - 1)]; }
  function radiusForLevel(level) { return layout.ballR * (1 + Math.min(level, MAX_LEVEL) * 0.12); }

  // Powerup / block type ids
  const T = {
    BLOCK: 'block',
    BOMB: 'bomb',
    BALL: 'p_ball',        // +1 ball
    DAMAGE: 'p_damage',    // x2 damage (run)
    MULTI: 'p_multi',      // scatter of temp balls
    LASER: 'p_laser',      // clear a row
    PIERCE: 'p_pierce',    // balls pass through blocks
    FREEZE: 'p_freeze',    // skip descent one round
    MULT: 'p_mult',        // x2 score for a few rounds
    SHIELD: 'p_shield',    // one-time save
    SPLIT: 'split',        // splits into two smaller blocks when destroyed
    BOSS: 'boss'           // 2x2 armored block, only its weak-point cell takes damage
  };
  const POWERUPS = [T.BALL, T.DAMAGE, T.MULTI, T.LASER, T.PIERCE, T.FREEZE, T.MULT, T.SHIELD];

  // ---------------------------------------------------------------------
  // Canvas & layout
  // ---------------------------------------------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const layout = {
    dpr: 1, W: 0, H: 0,                    // full canvas CSS size (window)
    boardX: 0, boardY: 0, boardW: 0, boardH: 0, // phone-shaped play area
    cell: 0, gap: 0, ballR: 0,
    gridTop: 0, cannonY: 0,
    deathRow: 0
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    layout.dpr = dpr;
    layout.W = w;
    layout.H = h;

    // Phone-shaped portrait board: centered, letterboxed on wide screens.
    const topInset = HUD_INSET;
    const bottomInset = 10;
    const availH = Math.max(200, h - topInset - bottomInset);
    const availW = w * 0.98;
    let bw = Math.min(availW, availH * BOARD_ASPECT);
    let bh = bw / BOARD_ASPECT;
    if (bh > availH) { bh = availH; bw = bh * BOARD_ASPECT; }
    layout.boardW = bw;
    layout.boardH = bh;
    layout.boardX = (w - bw) / 2;
    layout.boardY = topInset + (availH - bh) / 2;

    layout.cell = bw / COLS;
    layout.gap = layout.cell * GAP_FRAC;
    layout.ballR = layout.cell * BALL_R_FRAC;
    layout.gridTop = layout.cell * 0.5;         // small gap under top edge
    layout.cannonY = bh - layout.cell * 0.7;    // cannon line near bottom
    layout.deathRow = Math.floor((layout.cannonY - layout.gridTop) / layout.cell);
  }

  // Convert a grid cell to its pixel box.
  function cellBox(col, row) {
    const c = layout.cell, g = layout.gap;
    return {
      x: col * c + g,
      y: layout.gridTop + row * c + g,
      w: c - g * 2,
      h: c - g * 2,
      cx: col * c + c / 2,
      cy: layout.gridTop + row * c + c / 2
    };
  }

  // Pixel box for a (possibly multi-cell) block spanning bW x bH cells.
  function blockBox(b) {
    const c = layout.cell, g = layout.gap;
    const bW = b.w || 1, bH = b.h || 1;
    return {
      x: b.col * c + g,
      y: layout.gridTop + b.row * c + g,
      w: bW * c - g * 2,
      h: bH * c - g * 2,
      cx: b.col * c + (bW * c) / 2,
      cy: layout.gridTop + b.row * c + (bH * c) / 2
    };
  }

  // ---------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------
  const STATE = { START: 0, AIMING: 1, SHOOTING: 2, RESOLVING: 3, OVER: 4 };

  let game = null;
  function newGame() {
    return {
      phase: STATE.AIMING,
      round: 1,
      score: 0,
      // Persistent balls: each slot carries its own damage level (dmg = 2**level)
      // and survives across rounds. Owned count = ballSlots.length.
      ballSlots: [{ level: 0 }],
      pierceRounds: 0,
      freezeRounds: 0,
      scoreMultRounds: 0,
      shields: 0,

      cannonXFrac: 0.5,          // stored as fraction so it survives resize
      nextCannonXFrac: null,

      blocks: [],
      balls: [],
      particles: [],
      lasers: [],
      pattern: null,             // stateful layout generator {name, ttl, data}
      chunkTick: 0,              // turns since the last chunk dropped
      dens: 0,                   // current board density bias (from firepower)
      lastBossRound: -999,       // round the last boss spawned (for cooldown)

      // firing bookkeeping
      fireQueue: [],             // slot indices still to launch this shot
      fireTimer: 0,
      fireDir: { x: 0, y: -1 },
      firstReturnX: null,
      launched: 0,               // balls launched this shot
      returned: 0,               // balls returned home this shot

      shake: 0,
      nextId: 1,

      // aim
      aiming: false,
      aimDir: { x: 0, y: -1 },
      pointerType: 'mouse'
    };
  }

  function cannonPos() {
    return { x: game.cannonXFrac * layout.boardW, y: layout.cannonY };
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------
  const best = { score: 0, round: 0 };
  function loadBest() {
    try {
      const s = JSON.parse(localStorage.getItem('nbb_best') || '{}');
      best.score = s.score || 0;
      best.round = s.round || 0;
    } catch (_) {}
  }
  function saveBest() {
    if (game.score > best.score) best.score = game.score;
    if (game.round > best.round) best.round = game.round;
    try { localStorage.setItem('nbb_best', JSON.stringify(best)); } catch (_) {}
  }

  // ---------------------------------------------------------------------
  // Block / powerup spawning
  // ---------------------------------------------------------------------
  // Find a live block covering (col,row) — accounts for multi-cell (boss) blocks.
  function blockAt(col, row) {
    for (const b of game.blocks) {
      if (b.hp <= 0) continue;
      const bW = b.w || 1, bH = b.h || 1;
      if (col >= b.col && col < b.col + bW && row >= b.row && row < b.row + bH) return b;
    }
    return null;
  }

  // Total firepower: sum of each ball's single-hit damage (2**level), lightly
  // boosted by ball count (more balls = more coverage). Difficulty scales off this.
  function firepower() {
    let dmg = 0;
    for (const s of game.ballSlots) dmg += 2 ** s.level;
    return dmg * (1 + COVERAGE * Math.max(0, game.ballSlots.length - 1));
  }

  // Block hit points scale off the player's firepower (gently super-linear), so the
  // board is always a challenging fraction of what you can output — not the clock.
  function blockHp(big) {
    const F = firepower();
    const t = HP_A * Math.pow(F, HP_P) + HP_B;
    const v = big ? t * HP_BIG : t * (0.75 + Math.random() * 0.5);
    return Math.max(1, Math.round(v));
  }

  function spawnRow(targetRow = 0) {
    // Density bias grows with firepower — boards thicken as you get stronger.
    game.dens = clamp((firepower() - DENS_START) / DENS_SCALE, 0, DENS_MAX);

    // Pick or continue a multi-row layout pattern so structures actually form.
    if (!game.pattern || game.pattern.ttl <= 0) game.pattern = pickPattern();
    const row = PATTERNS[game.pattern.name](game.round, game.pattern.data);
    game.pattern.ttl--;

    // Thicken: fill some empty cells with probability `dens`, but always leave
    // at least 3 open cells (>=1 gap to shoot through + room for the tokens).
    const emptyCols = shuffle([...Array(COLS).keys()].filter((c) => !row[c]));
    const maxThicken = Math.max(0, emptyCols.length - 3);
    let thickened = 0;
    for (const c of emptyCols) {
      if (thickened >= maxThicken) break;
      if (Math.random() < game.dens) { row[c] = 'square'; thickened++; }
    }

    // Safety: never a fully solid row (must stay playable), and never fully empty.
    let filled = row.filter(Boolean).length;
    if (filled >= COLS) row[Math.floor(Math.random() * COLS)] = null;
    if (filled === 0) row[Math.floor(Math.random() * COLS)] = 'square';

    const used = new Set();
    const rowBlocks = [];
    for (let col = 0; col < COLS; col++) {
      const cell = row[col];
      if (!cell) continue;
      used.add(col);
      const isBig = Math.random() < 0.16;
      const hp = blockHp(isBig);
      // 'square' cells occasionally become triangles for variety; explicit
      // triangle cells (from funnels/tunnels) keep their orientation.
      const shape = cell === 'square'
        ? (Math.random() < 0.14 ? triangleShape() : 'square')
        : cell;
      const b = { id: game.nextId++, type: T.BLOCK, shape, col, row: targetRow, hp, maxHp: hp, flash: 0 };
      game.blocks.push(b);
      rowBlocks.push(b);
    }

    // Rare "spice": promote one plain square in this row to a splitter block.
    if (rowBlocks.length && Math.random() < SPLIT_CHANCE) {
      const cand = rowBlocks.filter((b) => b.shape === 'square');
      if (cand.length) cand[Math.floor(Math.random() * cand.length)].type = T.SPLIT;
    }

    // Tokens fill leftover cells: mostly +1 ball / 2x damage, rare specials.
    const free = [];
    for (let c = 0; c < COLS; c++) if (!used.has(c)) free.push(c);
    if (free.length) {
      const col = free.splice(Math.floor(Math.random() * free.length), 1)[0];
      game.blocks.push(makeToken(col, Math.random() < 0.72 ? T.BALL : T.DAMAGE, targetRow));
    }
    if (free.length && Math.random() < 0.18) {
      const col = free.splice(Math.floor(Math.random() * free.length), 1)[0];
      game.blocks.push(makeToken(col, weightedSpecial(), targetRow));
    }
  }

  // Spawn a full chunk of CHUNK rows at the top (rows 0..CHUNK-1), pattern
  // continuing across them so multi-row structures appear together.
  function spawnChunkRows() {
    for (let r = CHUNK - 1; r >= 0; r--) spawnRow(r);
    maybeSpawnBoss();
  }

  // Rare 2x2 armored boss with a single weak-point cell. At most one at a time,
  // gated by a cooldown; carves out a 2x2 region at the top to sit in.
  function maybeSpawnBoss() {
    if (game.round - game.lastBossRound < BOSS_COOLDOWN) return;
    if (game.blocks.some((b) => b.type === T.BOSS)) return;
    if (Math.random() >= BOSS_CHANCE) return;
    const c = Math.floor(Math.random() * (COLS - 1));   // occupies cols c..c+1
    // Clear anything currently in the 2x2 (cols c..c+1, rows 0..1).
    game.blocks = game.blocks.filter((b) => {
      const bW = b.w || 1, bH = b.h || 1;
      const hits = !(b.col + bW <= c || b.col >= c + 2 || b.row + bH <= 0 || b.row >= 2);
      return !hits;
    });
    const hp = Math.round(blockHp(false) * BOSS_HP_MULT);
    game.blocks.push({
      id: game.nextId++, type: T.BOSS, shape: 'boss',
      col: c, row: 0, w: 2, h: 2, hp, maxHp: hp,
      weakDx: Math.floor(Math.random() * 2), weakDy: Math.floor(Math.random() * 2),
      flash: 0
    });
    game.lastBossRound = game.round;
  }

  // Choose a fresh pattern (avoid repeating the current one), held for a few rows.
  // As density rises, bias toward denser patterns and away from sparse ones.
  function pickPattern() {
    const dense = ['chamber', 'wave', 'pinball', 'twinTunnel'];
    const sparse = ['sparse', 'splitMiddle', 'sides'];
    const names = Object.keys(PATTERNS);
    const weightOf = (n) => {
      if (dense.includes(n)) return 1 + game.dens * 4;
      if (sparse.includes(n)) return Math.max(0.15, 1 - game.dens * 2);
      return 1;
    };
    let name, guard = 0;
    do {
      const total = names.reduce((s, n) => s + weightOf(n), 0);
      let r = Math.random() * total;
      name = names[0];
      for (const n of names) { if ((r -= weightOf(n)) < 0) { name = n; break; } }
    } while (game.pattern && name === game.pattern.name && names.length > 1 && ++guard < 8);
    return { name, ttl: 3 + Math.floor(Math.random() * 5), data: {} };
  }

  // Each generator returns an array of length COLS whose entries are:
  //   null      -> empty cell (a gap / opening)
  //   'square'  -> square block
  //   'tl'|'tr'|'bl'|'br' -> triangle block of that orientation
  // `data` persists across the rows the pattern is held, so shapes span rows.
  const PATTERNS = {
    // A vertical corridor (1-2 wide) that drifts left/right, walls angled inward.
    tunnel(round, d) {
      if (d.gap == null) { d.w = Math.random() < 0.35 ? 2 : 1; d.gap = 1 + Math.floor(Math.random() * (COLS - 2 - d.w)); }
      else if (Math.random() < 0.6) d.gap = clamp(d.gap + (Math.random() < 0.5 ? -1 : 1), 0, COLS - d.w);
      const row = [];
      for (let c = 0; c < COLS; c++) {
        if (c >= d.gap && c < d.gap + d.w) row.push(null);
        else if (c === d.gap - 1) row.push('br');
        else if (c === d.gap + d.w) row.push('bl');
        else row.push('square');
      }
      return row;
    },
    // Two drifting corridors.
    twinTunnel(round, d) {
      const half = Math.floor(COLS / 2);
      if (d.g1 == null) { d.g1 = Math.floor(Math.random() * half); d.g2 = half + Math.floor(Math.random() * (COLS - half)); }
      else {
        if (Math.random() < 0.5) d.g1 = clamp(d.g1 + (Math.random() < 0.5 ? -1 : 1), 0, half - 1);
        if (Math.random() < 0.5) d.g2 = clamp(d.g2 + (Math.random() < 0.5 ? -1 : 1), half, COLS - 1);
      }
      const row = [];
      for (let c = 0; c < COLS; c++) row.push((c === d.g1 || c === d.g2) ? null : 'square');
      return row;
    },
    // Offset checkerboard — heavy ricochet.
    pinball(round, d) {
      d.phase = (d.phase || 0) ^ 1;
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(((c + d.phase) % 2 === 0) ? 'square' : null);
      return row;
    },
    // Breather: a couple of scattered blocks.
    sparse(round, d) {
      const row = new Array(COLS).fill(null);
      const cols = shuffle([...Array(COLS).keys()]).slice(0, 2 + Math.floor(Math.random() * 2));
      for (const c of cols) row[c] = 'square';
      return row;
    },
    // Near-solid wall with a single door that periodically seals -> pockets.
    chamber(round, d) {
      if (d.door == null) { d.door = 1 + Math.floor(Math.random() * (COLS - 2)); d.tick = 0; }
      d.tick++;
      const seal = d.tick % 3 === 0;
      const row = [];
      for (let c = 0; c < COLS; c++) row.push((c === d.door && !seal) ? null : 'square');
      return row;
    },
    // Triangles sloping toward a center gap.
    funnel(round, d) {
      if (d.center == null) d.center = 2 + Math.floor(Math.random() * (COLS - 4));
      const row = new Array(COLS).fill(null);
      for (let c = 0; c < COLS; c++) {
        if (c === d.center) continue;
        if (Math.random() < 0.65) row[c] = c < d.center ? 'br' : 'bl';
      }
      return row;
    },
    // A diagonal band that walks across, leaving a diagonal lane.
    staircase(round, d) {
      if (d.start == null) { d.start = 0; d.dir = 1; d.w = 2 + Math.floor(Math.random() * 2); }
      d.start += d.dir;
      if (d.start <= 0 || d.start + d.w >= COLS) d.dir *= -1;
      const row = [];
      for (let c = 0; c < COLS; c++) row.push((c >= d.start && c < d.start + d.w) ? 'square' : null);
      return row;
    },
    // Rails on both edges, open middle — balls run down the center.
    sides(round, d) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push((c === 0 || c === COLS - 1 || Math.random() < 0.12) ? 'square' : null);
      return row;
    },
    // Solid center column, open sides.
    splitMiddle(round, d) {
      if (d.w == null) d.w = 2 + Math.floor(Math.random() * 2);
      const start = Math.floor((COLS - d.w) / 2);
      const row = [];
      for (let c = 0; c < COLS; c++) row.push((c >= start && c < start + d.w) ? 'square' : null);
      return row;
    },
    // Density rises and falls like a wave.
    wave(round, d) {
      d.t = (d.t == null ? Math.random() * Math.PI * 2 : d.t + 0.8);
      const density = 0.5 + 0.38 * Math.sin(d.t);
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(Math.random() < density ? 'square' : null);
      return row;
    }
  };

  // Weighted pick for the rare bonus token: staples dominate, strong ones are scarce.
  function weightedSpecial() {
    const pool = [
      [T.DAMAGE, 5], [T.BALL, 4], [T.MULTI, 3], [T.MULT, 2],
      [T.FREEZE, 2], [T.PIERCE, 1], [T.LASER, 1]
    ];
    const total = pool.reduce((s, e) => s + e[1], 0);
    let r = Math.random() * total;
    for (const [type, w] of pool) { if ((r -= w) < 0) return type; }
    return T.BALL;
  }

  function makeToken(col, type, row = 0) {
    return { id: game.nextId++, type, shape: 'token', col, row, hp: 1, flash: 0 };
  }

  function triangleShape() {
    // one of 4 right-triangle orientations (which corner is filled/solid)
    return ['tl', 'tr', 'bl', 'br'][Math.floor(Math.random() * 4)];
  }

  function isToken(b) { return b.shape === 'token'; }
  function isTriangle(b) { return b.shape === 'tl' || b.shape === 'tr' || b.shape === 'bl' || b.shape === 'br'; }

  // ---------------------------------------------------------------------
  // Round flow
  // ---------------------------------------------------------------------
  function startRound() {
    game.phase = STATE.AIMING;
    game.firstReturnX = null;
    recallBtn.classList.add('hidden');
  }

  function fire(dir) {
    if (game.phase !== STATE.AIMING) return;
    game.phase = STATE.SHOOTING;
    game.fireDir = { x: dir.x, y: dir.y };
    game.fireQueue = game.ballSlots.map((_, i) => i); // launch every owned ball
    game.fireTimer = 0;
    game.firstReturnX = null;
    game.launched = 0;
    game.returned = 0;
    recallBtn.classList.remove('hidden');
  }

  // Spawn a ball bound to a persistent slot (carries that slot's damage level),
  // or a temporary ball (slot === null) with no slot / level 0.
  function spawnBall(dir, slotIndex) {
    const p = cannonPos();
    const speed = layout.cell * SPEED_FRAC;
    const isTemp = slotIndex == null;
    const level = isTemp ? 0 : game.ballSlots[slotIndex].level;
    const r = radiusForLevel(level);
    game.balls.push({
      id: game.nextId++,
      x: p.x, y: p.y - r - 1,
      vx: dir.x * speed, vy: dir.y * speed,
      r,
      trail: [],
      temp: isTemp,
      slotIndex: isTemp ? null : slotIndex,
      level,
      dmg: 2 ** level,
      skip: 0            // block id currently being pierced-through
    });
    if (!isTemp) game.launched++;
  }

  function recall() {
    // Immediately end shooting; balls vanish and round resolves.
    if (game.phase !== STATE.SHOOTING && game.phase !== STATE.AIMING) return;
    game.fireQueue = [];
    game.balls.length = 0;
    resolveRound();
  }

  function resolveRound() {
    game.phase = STATE.RESOLVING;
    recallBtn.classList.add('hidden');

    // Cannon always re-centers to the middle at the start of each round.
    game.cannonXFrac = 0.5;
    game.nextCannonXFrac = null;

    // Tick down timed powerups.
    if (game.pierceRounds > 0) game.pierceRounds--;
    if (game.scoreMultRounds > 0) game.scoreMultRounds--;

    // The board drops a CHUNK of rows at once, but only every CHUNK turns — so
    // the average descent is still 1 row/turn (difficulty unchanged) while whole
    // pattern chunks are revealed together. Freeze skips the whole turn.
    if (game.freezeRounds > 0) {
      game.freezeRounds--;
      addFloatText('FROZEN', '#8be0ff');
    } else {
      game.round++;
      game.chunkTick++;
      if (game.chunkTick >= CHUNK) {
        game.chunkTick = 0;
        for (const b of game.blocks) b.row += CHUNK;
        spawnChunkRows();
      }
    }

    // Lose check (shield can save you).
    if (checkDeath()) {
      if (game.shields > 0) {
        game.shields--;
        // Clear whatever crossed the line and push everything up one.
        game.blocks = game.blocks.filter((b) => b.row < layout.deathRow);
        addFloatText('SHIELD USED', COLORS.aimBounce);
      } else {
        return gameOver();
      }
    }

    startRound();
    syncHud();
  }

  function checkDeath() {
    for (const b of game.blocks) {
      if (isToken(b) || b.hp <= 0) continue;
      const bottom = b.row + (b.h || 1) - 1;   // multi-cell blocks die by their bottom
      if (bottom >= layout.deathRow) return true;
    }
    return false;
  }

  function gameOver() {
    game.phase = STATE.OVER;
    saveBest();
    document.getElementById('finalRound').textContent = game.round;
    document.getElementById('finalScore').textContent = game.score;
    document.getElementById('finalBest').textContent = best.score;
    gameOverScreen.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Powerup effects
  // ---------------------------------------------------------------------
  function applyPowerup(type, cx, cy, ball) {
    switch (type) {
      case T.BALL:
        game.ballSlots.push({ level: 0 });
        addFloatText('+1 BALL', COLORS.cannon, cx, cy);
        break;
      case T.DAMAGE: {
        // Upgrade ONE ball: the collecting ball's own slot climbs a tier
        // (2x -> 4x -> 8x ...). A temp/scatter ball has no slot, so it boosts
        // the weakest owned ball instead of being wasted.
        let slot;
        if (ball && ball.slotIndex != null && game.ballSlots[ball.slotIndex]) {
          slot = game.ballSlots[ball.slotIndex];
        } else {
          slot = game.ballSlots.reduce((a, b) => (b.level < a.level ? b : a), game.ballSlots[0]);
        }
        slot.level = Math.min(MAX_LEVEL, slot.level + 1);
        // Reflect the upgrade on the in-flight ball right away.
        if (ball) {
          ball.level = slot.level;
          ball.dmg = 2 ** slot.level;
          ball.r = radiusForLevel(slot.level);
        }
        addFloatText((2 ** slot.level) + '× DMG', tierColor(slot.level), cx, cy);
        break;
      }
      case T.MULTI: {
        const n = 4 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
          spawnScatterBall(cx, cy, a);
        }
        addFloatText('MULTI-BALL', '#7dff9b', cx, cy);
        break;
      }
      case T.LASER:
        fireLaserRow(Math.max(0, Math.round((cy - layout.gridTop) / layout.cell)));
        addFloatText('LASER', COLORS.aimBounce, cx, cy);
        break;
      case T.PIERCE:
        game.pierceRounds = Math.max(game.pierceRounds, 1);
        addFloatText('PIERCE', '#c58bff', cx, cy);
        break;
      case T.FREEZE:
        game.freezeRounds = Math.max(game.freezeRounds, 1);
        addFloatText('FREEZE', '#8be0ff', cx, cy);
        break;
      case T.MULT:
        game.scoreMultRounds = Math.max(game.scoreMultRounds, 4);
        addFloatText('SCORE x2', '#ffd23e', cx, cy);
        break;
      case T.SHIELD:
        game.shields++;
        addFloatText('SHIELD', '#7dff9b', cx, cy);
        break;
    }
    syncHud();
  }

  function spawnScatterBall(x, y, ang) {
    const speed = layout.cell * SPEED_FRAC;
    game.balls.push({
      id: game.nextId++, x, y,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      r: radiusForLevel(0), trail: [], temp: true, slotIndex: null, level: 0, dmg: 1, skip: 0
    });
  }

  function fireLaserRow(row) {
    game.lasers.push({ row, t: 0.35 });
    for (const b of game.blocks) {
      if (!isToken(b) && b.row === row) damageBlock(b, 3 + game.round, true);
    }
    game.shake = Math.max(game.shake, 8);
  }

  // ---------------------------------------------------------------------
  // Damage / destruction
  // ---------------------------------------------------------------------
  function damageBlock(b, amount, silent) {
    if (b.hp <= 0) return;
    b.hp -= amount;
    b.flash = 1;
    if (!silent) spawnHitParticles(b);
    if (b.hp <= 0) destroyBlock(b);
  }

  function destroyBlock(b) {
    b.hp = 0;
    game.score += 1 * scoreMult();
    spawnBreakParticles(b);
    if (b.type === T.BOMB) explode(b);
    if (b.type === T.SPLIT) splitBlock(b);
  }

  // Splitter: on death, spawn up to two half-HP normal children in adjacent empty
  // cells. Children are plain blocks, so there is no infinite cascade.
  function splitBlock(b) {
    const childHp = Math.max(1, Math.ceil((b.maxHp || 2) / 2));
    const spots = [[b.col - 1, b.row], [b.col + 1, b.row], [b.col, b.row - 1], [b.col, b.row + 1]];
    let made = 0;
    for (const [col, row] of spots) {
      if (made >= 2) break;
      if (col < 0 || col >= COLS || row < 0 || blockAt(col, row)) continue;
      game.blocks.push({ id: game.nextId++, type: T.BLOCK, shape: 'square', col, row, hp: childHp, maxHp: childHp, flash: 1 });
      made++;
    }
  }

  function explode(b) {
    game.shake = Math.max(game.shake, 12);
    const box = cellBox(b.col, b.row);
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (60 + Math.random() * 220);
      game.particles.push({
        x: box.cx, y: box.cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.6, max: 0.6, color: '#ff8a3e', r: 2 + Math.random() * 3
      });
    }
    const blast = Math.ceil(game.round * 1.5) + 3;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const nb = blockAt(b.col + dc, b.row + dr);
        if (nb && !isToken(nb)) damageBlock(nb, blast, true);
      }
    }
  }

  function scoreMult() { return game.scoreMultRounds > 0 ? 2 : 1; }

  // ---------------------------------------------------------------------
  // Physics update
  // ---------------------------------------------------------------------
  function update(dt) {
    if (game.phase === STATE.SHOOTING) {
      // Emit the stream of balls, one slot at a time.
      if (game.fireQueue.length > 0) {
        game.fireTimer -= dt;
        while (game.fireQueue.length > 0 && game.fireTimer <= 0) {
          spawnBall(game.fireDir, game.fireQueue.shift());
          game.fireTimer += FIRE_INTERVAL;
        }
      }
      stepBalls(dt);
      // Round ends when nothing left to fire and no balls in play.
      if (game.fireQueue.length === 0 && game.balls.length === 0) {
        resolveRound();
      }
    }

    // Particles
    for (const p of game.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 260 * dt;      // a little gravity on debris only
    }
    game.particles = game.particles.filter((p) => p.life > 0);

    // Float texts
    for (const f of floats) { f.life -= dt; f.y -= 26 * dt; }
    for (let i = floats.length - 1; i >= 0; i--) if (floats[i].life <= 0) floats.splice(i, 1);

    // Lasers
    for (const l of game.lasers) l.t -= dt;
    game.lasers = game.lasers.filter((l) => l.t > 0);

    // Block flash fade
    for (const b of game.blocks) if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 4);
    game.blocks = game.blocks.filter((b) => b.hp > 0);

    if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 40);
  }

  function stepBalls(dt) {
    const maxStep = layout.ballR * 0.9;
    for (const ball of game.balls) {
      let remaining = Math.hypot(ball.vx, ball.vy) * dt;
      const nx = ball.vx / (Math.hypot(ball.vx, ball.vy) || 1);
      const ny = ball.vy / (Math.hypot(ball.vx, ball.vy) || 1);
      const speed = Math.hypot(ball.vx, ball.vy);

      // record trail
      ball.trail.push({ x: ball.x, y: ball.y });
      if (ball.trail.length > 8) ball.trail.shift();

      let dead = false;
      while (remaining > 0 && !dead) {
        const step = Math.min(remaining, maxStep);
        ball.x += (ball.vx / speed) * step;
        ball.y += (ball.vy / speed) * step;
        remaining -= step;

        // Walls
        if (ball.x < ball.r) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
        else if (ball.x > layout.boardW - ball.r) { ball.x = layout.boardW - ball.r; ball.vx = -Math.abs(ball.vx); }
        if (ball.y < ball.r + 4) { ball.y = ball.r + 4; ball.vy = Math.abs(ball.vy); }

        // Floor -> ball returns
        if (ball.y > layout.cannonY) {
          if (game.firstReturnX == null) {
            game.firstReturnX = ball.x;
            if (!ball.temp) game.nextCannonXFrac = ball.x / layout.boardW;
          }
          if (!ball.temp) game.returned++;
          dead = true;
          break;
        }

        // Blocks
        collideBlocks(ball);
      }
      ball._dead = dead;
    }
    game.balls = game.balls.filter((b) => !b._dead);
  }

  function collideBlocks(ball) {
    // Find candidate cells near the ball.
    const c = layout.cell;
    const col0 = Math.floor((ball.x - ball.r) / c);
    const col1 = Math.floor((ball.x + ball.r) / c);
    const row0 = Math.floor((ball.y - ball.r - layout.gridTop) / c);
    const row1 = Math.floor((ball.y + ball.r - layout.gridTop) / c);

    // A multi-cell (boss) block can be found via several cells — resolve it once.
    const seen = ball._seen || (ball._seen = new Set());
    seen.clear();

    for (let col = col0; col <= col1; col++) {
      for (let row = row0; row <= row1; row++) {
        const b = blockAt(col, row);
        if (!b || seen.has(b.id)) continue;
        seen.add(b.id);

        if (isToken(b)) {
          // pickup: circle vs circle
          const box = cellBox(b.col, b.row);
          const d = Math.hypot(ball.x - box.cx, ball.y - box.cy);
          if (d < ball.r + c * 0.3) {
            const type = b.type;
            b.hp = 0;
            applyPowerup(type, box.cx, box.cy, ball);
          }
          continue;
        }

        if (b.type === T.BOSS) {
          // Solid 2x2 that bounces everywhere but only takes damage on its weak cell.
          const box = blockBox(b);
          const px = ball.x, py = ball.y;                 // pre-bounce position
          if (resolveAABB(ball, box)) {
            // contact point on the box surface (from the pre-bounce center)
            const cxp = clamp(px, box.x, box.x + box.w);
            const cyp = clamp(py, box.y, box.y + box.h);
            const half = box.w / 2, halfH = box.h / 2;
            const wx = box.x + b.weakDx * half, wy = box.y + b.weakDy * halfH;
            if (cxp >= wx && cxp <= wx + half && cyp >= wy && cyp <= wy + halfH) {
              hitBlock(ball, b);
            }
          }
          continue;
        }

        if (isTriangle(b)) {
          const box = cellBox(b.col, b.row);
          if (resolveTriangle(ball, b, box)) hitBlock(ball, b);
          continue;
        }

        // square AABB
        const box = cellBox(b.col, b.row);
        if (resolveAABB(ball, box)) hitBlock(ball, b);
      }
    }
  }

  function hitBlock(ball, b) {
    if (game.pierceRounds > 0) {
      // pass through: damage once per contact, no bounce
      if (ball.skip !== b.id) {
        ball.skip = b.id;
        damageBlock(b, ball.dmg);
      }
    } else {
      damageBlock(b, ball.dmg);
    }
  }

  // Resolve circle vs axis-aligned box. Returns true on contact, reflecting
  // the ball's velocity and pushing it out (unless piercing).
  function resolveAABB(ball, box) {
    const nx = clamp(ball.x, box.x, box.x + box.w);
    const ny = clamp(ball.y, box.y, box.y + box.h);
    let dx = ball.x - nx;
    let dy = ball.y - ny;
    let d2 = dx * dx + dy * dy;
    if (d2 > ball.r * ball.r) return false;

    if (game.pierceRounds > 0) return true; // no physical response while piercing

    if (dx === 0 && dy === 0) {
      // center inside box: pick minimum-penetration axis
      const left = ball.x - box.x, right = box.x + box.w - ball.x;
      const top = ball.y - box.y, bottom = box.y + box.h - ball.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left) { ball.x = box.x - ball.r; ball.vx = -Math.abs(ball.vx); }
      else if (m === right) { ball.x = box.x + box.w + ball.r; ball.vx = Math.abs(ball.vx); }
      else if (m === top) { ball.y = box.y - ball.r; ball.vy = -Math.abs(ball.vy); }
      else { ball.y = box.y + box.h + ball.r; ball.vy = Math.abs(ball.vy); }
    } else {
      const d = Math.sqrt(d2) || 0.0001;
      const overlap = ball.r - d;
      const ux = dx / d, uy = dy / d;
      ball.x += ux * overlap;
      ball.y += uy * overlap;
      // reflect along dominant axis of the contact normal
      if (Math.abs(ux) > Math.abs(uy)) ball.vx = Math.sign(ux) * Math.abs(ball.vx);
      else ball.vy = Math.sign(uy) * Math.abs(ball.vy);
    }
    return true;
  }

  // Triangle collision: the block is a right triangle filling the cell with
  // one corner removed. We reflect off the hypotenuse when the ball is on the
  // solid side, otherwise treat the two legs as AABB faces.
  function resolveTriangle(ball, b, box) {
    // First a quick AABB reject.
    const nx = clamp(ball.x, box.x, box.x + box.w);
    const ny = clamp(ball.y, box.y, box.y + box.h);
    if ((ball.x - nx) ** 2 + (ball.y - ny) ** 2 > ball.r * ball.r) return false;

    // Hypotenuse endpoints & inward normal depend on which corner is solid.
    // Local coords within box (0..w, 0..h).
    const lx = ball.x - box.x, ly = ball.y - box.y;
    const w = box.w, h = box.h;
    let n; // outward normal of the hypotenuse (points to the empty side)
    let onSolidSide;
    switch (b.shape) {
      case 'tl': // solid at top-left, hyp from (w,0)->(0,h); normal ~ (1,1)
        n = { x: 1, y: 1 }; onSolidSide = (lx / w + ly / h) <= 1; break;
      case 'tr': // solid top-right, hyp (0,0)->(w,h); normal ~ (-1,1)
        n = { x: -1, y: 1 }; onSolidSide = (ly / h - lx / w) >= 0; break;
      case 'bl': // solid bottom-left, hyp (0,0)->(w,h); normal ~ (1,-1)
        n = { x: 1, y: -1 }; onSolidSide = (lx / w - ly / h) >= 0; break;
      default:   // 'br' solid bottom-right, hyp (0,h)->(w,0); normal ~ (-1,-1)
        n = { x: -1, y: -1 }; onSolidSide = (lx / w + ly / h) >= 1; break;
    }
    if (!onSolidSide) {
      // ball is in the empty quadrant near the hyp — reflect off hypotenuse
      const len = Math.hypot(n.x, n.y);
      const ux = n.x / len, uy = n.y / len;
      if (game.pierceRounds > 0) return true;
      const vdot = ball.vx * ux + ball.vy * uy;
      if (vdot < 0) {
        ball.vx -= 2 * vdot * ux;
        ball.vy -= 2 * vdot * uy;
        ball.x += ux * ball.r * 0.6;
        ball.y += uy * ball.r * 0.6;
      }
      return true;
    }
    // On the solid bulk — behave like a normal square face.
    return resolveAABB(ball, box);
  }

  // ---------------------------------------------------------------------
  // Particles / float text
  // ---------------------------------------------------------------------
  const floats = [];
  function addFloatText(text, color, x, y) {
    floats.push({
      text, color,
      x: x != null ? x : layout.boardW / 2,
      y: y != null ? y : layout.boardH * 0.42,
      life: 1.1, max: 1.1
    });
  }

  function spawnHitParticles(b) {
    const box = blockBox(b);
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 90;
      game.particles.push({
        x: box.cx, y: box.cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.3, max: 0.3, color: blockColor(b), r: 1.5 + Math.random() * 2
      });
    }
  }
  function spawnBreakParticles(b) {
    const box = blockBox(b);
    const n = b.type === T.BOSS ? 26 : 12;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 160;
      game.particles.push({
        x: box.cx, y: box.cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.5, max: 0.5, color: blockColor(b), r: 2 + Math.random() * 2.5
      });
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function blockColor(b) {
    if (b.type === T.BOMB) return '#ff8a3e';
    if (b.type === T.SPLIT) return '#7dff9b';   // splitter = neon green
    if (b.type === T.BOSS) return '#ff4d6d';    // boss body = danger red
    // Hue tracks HP relative to current firepower, so "hot" = tanky for you now.
    const denom = Math.max(8, firepower() * 1.2);
    const ratio = Math.min(b.hp / denom, 1);
    const hue = 185 - ratio * 185; // cyan(185) -> red(0)
    return `hsl(${hue}, 90%, 60%)`;
  }

  const TOKEN_STYLE = {
    [T.BALL]:   { c: '#33e6ff', label: '+1' },
    [T.DAMAGE]: { c: '#ffd23e', label: '2×' },
    [T.MULTI]:  { c: '#7dff9b', label: '⁙' },
    [T.LASER]:  { c: '#ff3ea5', label: '≣' },
    [T.PIERCE]: { c: '#c58bff', label: '➤' },
    [T.FREEZE]: { c: '#8be0ff', label: '❄' },
    [T.MULT]:   { c: '#ffd23e', label: '×2' },
    [T.SHIELD]: { c: '#7dff9b', label: '⛨' }
  };

  function render() {
    // Outer background surrounds the phone-shaped board (letterbox).
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, layout.W, layout.H);

    const W = layout.boardW, H = layout.boardH;
    ctx.save();
    // screen shake + move into board-local space
    const sx = game.shake > 0 ? (Math.random() - 0.5) * game.shake : 0;
    const sy = game.shake > 0 ? (Math.random() - 0.5) * game.shake : 0;
    ctx.translate(layout.boardX + sx, layout.boardY + sy);

    // Board panel background, then clip everything to the rounded screen.
    roundRect(0, 0, W, H, 20);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();
    ctx.save();
    ctx.clip();

    drawGridGlow();

    // death line
    const dy = layout.gridTop + layout.deathRow * layout.cell;
    ctx.strokeStyle = 'rgba(255,62,165,0.4)';
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, dy); ctx.lineTo(W, dy); ctx.stroke();
    ctx.setLineDash([]);

    // lasers
    for (const l of game.lasers) {
      const ly = layout.gridTop + l.row * layout.cell + layout.cell / 2;
      const alpha = l.t / 0.35;
      ctx.fillStyle = `rgba(255,62,165,${0.5 * alpha})`;
      ctx.shadowColor = '#ff3ea5'; ctx.shadowBlur = 24;
      ctx.fillRect(0, ly - layout.cell * 0.3, W, layout.cell * 0.6);
      ctx.shadowBlur = 0;
    }

    // blocks
    for (const b of game.blocks) drawBlock(b);

    // balls
    for (const ball of game.balls) drawBall(ball);

    // particles
    for (const p of game.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // cannon + aim
    drawCannon();
    if (game.phase === STATE.AIMING && game.aiming) drawAim();

    // float texts
    for (const f of floats) {
      const a = Math.min(1, f.life / 0.4);
      ctx.globalAlpha = a;
      ctx.fillStyle = f.color;
      ctx.font = '700 18px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = f.color; ctx.shadowBlur = 12;
      ctx.fillText(f.text, f.x, f.y);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;

    ctx.restore(); // end clip

    // Neon phone-screen frame.
    roundRect(0, 0, W, H, 20);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(120,200,255,0.28)';
    ctx.shadowColor = 'rgba(120,200,255,0.5)';
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  function drawGridGlow() {
    // faint vertical guide lines
    ctx.strokeStyle = 'rgba(120,200,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < COLS; i++) {
      const x = i * layout.cell;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, layout.cannonY); ctx.stroke();
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBlock(b) {
    if (isToken(b)) return drawToken(b, cellBox(b.col, b.row));
    if (b.type === T.BOSS) return drawBoss(b);

    const box = cellBox(b.col, b.row);
    const color = blockColor(b);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 + (b.flash > 0 ? 14 * b.flash : 0);

    if (isTriangle(b)) {
      drawTrianglePath(b, box);
    } else {
      roundRect(box.x, box.y, box.w, box.h, box.w * 0.16);
    }
    ctx.fillStyle = withAlpha(color, 0.22);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();

    // number
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(layout.cell * 0.34)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.type === T.BOMB ? '✸' : String(b.hp), box.cx, box.cy + 1);
    ctx.textBaseline = 'alphabetic';

    // splitter badge: two little arrows pointing apart (it splits when destroyed)
    if (b.type === T.SPLIT) {
      const s = layout.cell * 0.12, my = box.y + s * 1.4;
      ctx.fillStyle = '#eafff2';
      ctx.beginPath(); // left arrow
      ctx.moveTo(box.cx - s * 2.2, my); ctx.lineTo(box.cx - s * 0.8, my - s); ctx.lineTo(box.cx - s * 0.8, my + s); ctx.closePath(); ctx.fill();
      ctx.beginPath(); // right arrow
      ctx.moveTo(box.cx + s * 2.2, my); ctx.lineTo(box.cx + s * 0.8, my - s); ctx.lineTo(box.cx + s * 0.8, my + s); ctx.closePath(); ctx.fill();
    }
  }

  // Rare 2x2 armored boss: plated body, one glowing weak-point cell shows the HP.
  function drawBoss(b) {
    const box = blockBox(b);
    const color = '#ff4d6d';
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 16 + (b.flash > 0 ? 16 * b.flash : 0);
    roundRect(box.x, box.y, box.w, box.h, box.w * 0.07);
    ctx.fillStyle = withAlpha(color, 0.16); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke();
    ctx.restore();

    // plating cross-lines
    ctx.strokeStyle = withAlpha(color, 0.35); ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(box.x + box.w / 2, box.y); ctx.lineTo(box.x + box.w / 2, box.y + box.h);
    ctx.moveTo(box.x, box.y + box.h / 2); ctx.lineTo(box.x + box.w, box.y + box.h / 2);
    ctx.stroke();

    // glowing weak cell
    const half = box.w / 2, halfH = box.h / 2;
    const wx = box.x + b.weakDx * half, wy = box.y + b.weakDy * halfH;
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 200);
    ctx.save();
    ctx.shadowColor = '#ffe36b'; ctx.shadowBlur = 18 * pulse;
    roundRect(wx + 4, wy + 4, half - 8, halfH - 8, 6);
    ctx.fillStyle = withAlpha('#ffe36b', 0.4); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffe36b'; ctx.stroke();
    ctx.restore();

    // hp on the weak cell
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(layout.cell * 0.34)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(b.hp), wx + half / 2, wy + halfH / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }

  function drawTrianglePath(b, box) {
    const { x, y, w, h } = box;
    ctx.beginPath();
    switch (b.shape) {
      case 'tl': ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); break;
      case 'tr': ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); break;
      case 'bl': ctx.moveTo(x, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h); break;
      default:   ctx.moveTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); break;
    }
    ctx.closePath();
  }

  function drawToken(b, box) {
    const st = TOKEN_STYLE[b.type] || { c: '#fff', label: '?' };
    const r = layout.cell * 0.3;
    ctx.save();
    ctx.shadowColor = st.c; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(box.cx, box.cy, r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(st.c, 0.18); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = st.c; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = st.c;
    ctx.font = `700 ${Math.round(layout.cell * 0.3)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(st.label, box.cx, box.cy + 1);
    ctx.textBaseline = 'alphabetic';
  }

  function drawBall(ball) {
    const col = game.pierceRounds > 0 ? '#c58bff' : tierColor(ball.level);
    const glow = withAlpha(col, 0.9);
    // trail
    for (let i = 0; i < ball.trail.length; i++) {
      const t = ball.trail[i];
      const a = (i / ball.trail.length) * 0.35;
      ctx.globalAlpha = a;
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(t.x, t.y, ball.r * 0.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.shadowColor = glow; ctx.shadowBlur = ball.level > 0 ? 16 : 12;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2); ctx.fill();
    // a small multiplier label on upgraded balls
    if (ball.level > 0) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = ball.level >= 3 ? '#1a0a12' : '#3a2a00';
      ctx.font = `700 ${Math.round(ball.r * 1.1)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(2 ** ball.level), ball.x, ball.y + 0.5);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  function drawCannon() {
    const p = cannonPos();
    ctx.save();
    ctx.shadowColor = COLORS.cannon; ctx.shadowBlur = 16;
    ctx.fillStyle = COLORS.cannon;
    ctx.beginPath(); ctx.arc(p.x, p.y, layout.ballR * 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    const owned = game.ballSlots.length;

    if (game.phase === STATE.AIMING) {
      // A pile of your actual balls, colored by their power tier, so you can
      // see how many you have (and which are upgraded) at a glance.
      drawBallPile(p.x, p.y - layout.ballR * 1.5 - 6, game.ballSlots.map((s) => s.level));
      ctx.fillStyle = 'rgba(234,242,255,0.9)';
      ctx.font = '700 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('×' + owned, p.x, p.y + layout.ballR * 1.5 + 16);
    } else if (game.phase === STATE.SHOOTING) {
      // Balls that have come home pile back up, with a live counter.
      const levels = game.ballSlots.map((s) => s.level).slice(0, game.returned);
      drawBallPile(p.x, p.y - layout.ballR * 1.5 - 6, levels);
      ctx.fillStyle = 'rgba(234,242,255,0.9)';
      ctx.font = '700 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(game.returned + ' / ' + owned, p.x, p.y + layout.ballR * 1.5 + 16);
    }
  }

  // Draw a compact centered row (wrapping upward) of small tier-colored dots.
  function drawBallPile(cx, baseY, levels) {
    if (!levels.length) return;
    const r = layout.ballR * 0.5;
    const gap = r * 2.4;
    const perRow = Math.min(levels.length, Math.max(3, Math.floor((layout.boardW * 0.5) / gap)));
    ctx.save();
    for (let i = 0; i < levels.length; i++) {
      const rowN = Math.floor(i / perRow);
      const inRow = i % perRow;
      const count = Math.min(perRow, levels.length - rowN * perRow);
      const x = cx + (inRow - (count - 1) / 2) * gap;
      const y = baseY - rowN * gap;
      const col = tierColor(levels[i]);
      ctx.shadowColor = withAlpha(col, 0.9); ctx.shadowBlur = 6;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawAim() {
    const p = cannonPos();
    const d = game.aimDir;
    const hit = raycast(p.x, p.y - layout.ballR - 1, d.x, d.y);
    if (!hit) return;

    // solid line to first hit
    ctx.save();
    ctx.strokeStyle = COLORS.aim;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = COLORS.aim; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - layout.ballR - 1);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();

    // small dot at bounce point
    ctx.fillStyle = COLORS.aimBounce;
    ctx.beginPath(); ctx.arc(hit.x, hit.y, 4, 0, Math.PI * 2); ctx.fill();

    // short dashed stub of the post-bounce direction
    const rdot = d.x * hit.nx + d.y * hit.ny;
    const rx = d.x - 2 * rdot * hit.nx;
    const ry = d.y - 2 * rdot * hit.ny;
    const stub = layout.cell * 1.6;
    ctx.strokeStyle = COLORS.aimBounce;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(hit.x, hit.y);
    ctx.lineTo(hit.x + rx * stub, hit.y + ry * stub);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Raycast from (x,y) along (dx,dy). Returns first hit {x,y,nx,ny}.
  function raycast(x, y, dx, dy) {
    const stepLen = layout.cell * 0.12;
    const maxDist = Math.hypot(layout.boardW, layout.boardH) * 1.2;
    let px = x, py = y;
    for (let dist = 0; dist < maxDist; dist += stepLen) {
      const nxp = px + dx * stepLen;
      const nyp = py + dy * stepLen;
      // walls
      if (nxp < layout.ballR) return { x: layout.ballR, y: nyp, nx: 1, ny: 0 };
      if (nxp > layout.boardW - layout.ballR) return { x: layout.boardW - layout.ballR, y: nyp, nx: -1, ny: 0 };
      if (nyp < layout.ballR + 4) return { x: nxp, y: layout.ballR + 4, nx: 0, ny: 1 };
      // block?
      const col = Math.floor(nxp / layout.cell);
      const row = Math.floor((nyp - layout.gridTop) / layout.cell);
      const b = blockAt(col, row);
      if (b && !isToken(b)) {
        const box = cellBox(col, row);
        // normal from the previous (outside) point
        let nx = 0, ny = 0;
        if (px < box.x) nx = -1; else if (px > box.x + box.w) nx = 1;
        if (py < box.y) ny = -1; else if (py > box.y + box.h) ny = 1;
        if (nx === 0 && ny === 0) ny = -1;
        // prefer single dominant axis
        if (nx !== 0 && ny !== 0) {
          if (Math.abs(px - box.cx) > Math.abs(py - box.cy)) ny = 0; else nx = 0;
        }
        return { x: px, y: py, nx, ny };
      }
      px = nxp; py = nyp;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------
  function setAimFromPoint(px, py) {
    const p = cannonPos();
    if (game.pointerType === 'touch') {
      // The aim rotates around straight-up, proportional to HORIZONTAL drag only.
      // Swipe right -> aim tilts right (not inverted). TOUCH_SENS is radians/pixel,
      // so a small value means low sensitivity. Vertical drag is ignored for stability.
      const maxDev = 1.4; // ~80deg max tilt from vertical
      const a = clamp((px - game.aimStart.x) * TOUCH_SENS, -maxDev, maxDev);
      game.aimDir = { x: Math.sin(a), y: -Math.cos(a) };
      return;
    }
    // mouse: aim toward cursor
    let dx = px - p.x;
    let dy = py - p.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    if (dy > -AIM_MIN_UP) {              // must shoot upward
      dy = -AIM_MIN_UP;
      const nlen = Math.hypot(dx, dy) || 1;
      dx /= nlen; dy /= nlen;
    }
    game.aimDir = { x: dx, y: dy };
  }

  function pointerDown(e) {
    if (!game || game.phase === STATE.OVER || game.phase === STATE.START) return;
    game.pointerType = e.pointerType || 'mouse';
    const pt = evtPoint(e);
    game.aimStart = pt;
    if (game.phase === STATE.AIMING) {
      game.aiming = true;
      setAimFromPoint(pt.x, pt.y);
    }
  }
  function pointerMove(e) {
    if (!game) return;
    const pt = evtPoint(e);
    if (game.pointerType === 'mouse' && game.phase === STATE.AIMING) {
      game.aiming = true;
      setAimFromPoint(pt.x, pt.y);
    } else if (game.aiming && game.phase === STATE.AIMING) {
      setAimFromPoint(pt.x, pt.y);
    }
  }
  function pointerUp(e) {
    if (!game || game.phase !== STATE.AIMING) return;
    const pt = evtPoint(e);
    if (game.pointerType === 'touch') {
      // Require a real drag to fire; a tiny tap is ignored.
      const dragged = Math.hypot(pt.x - game.aimStart.x, pt.y - game.aimStart.y) > layout.cell * 0.25;
      if (game.aiming && dragged) { game.aiming = false; fire(game.aimDir); }
      else game.aiming = false;
    } else {
      // mouse click fires along current aim
      setAimFromPoint(pt.x, pt.y);
      fire(game.aimDir);
    }
  }

  function evtPoint(e) {
    const rect = canvas.getBoundingClientRect();
    // Return coordinates in board-local space (board origin = 0,0).
    return { x: e.clientX - rect.left - layout.boardX, y: e.clientY - rect.top - layout.boardY };
  }

  // ---------------------------------------------------------------------
  // HUD wiring
  // ---------------------------------------------------------------------
  const roundVal = document.getElementById('roundVal');
  const scoreVal = document.getElementById('scoreVal');
  const bestVal = document.getElementById('bestVal');
  const recallBtn = document.getElementById('recallBtn');
  const startScreen = document.getElementById('startScreen');
  const gameOverScreen = document.getElementById('gameOverScreen');

  function syncHud() {
    roundVal.textContent = game.round;
    scoreVal.textContent = game.score;
    bestVal.textContent = Math.max(best.score, game.score);
  }

  recallBtn.addEventListener('click', () => recall());

  document.getElementById('startBtn').addEventListener('click', begin);
  document.getElementById('restartBtn').addEventListener('click', () => {
    gameOverScreen.classList.add('hidden');
    begin();
  });

  function begin() {
    startScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    game = newGame();
    spawnChunkRows();
    syncHud();
    startRound();
  }

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function withAlpha(color, a) {
    // handles hsl() and hex
    if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${a})`);
    if (color.startsWith('#')) {
      const n = parseInt(color.slice(1), 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    }
    return color;
  }

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------
  let last = 0;
  function loop(ts) {
    const dt = Math.min(0.033, (ts - last) / 1000 || 0);
    last = ts;
    if (game && game.phase !== STATE.START && game.phase !== STATE.OVER) update(dt);
    if (game) { render(); syncHud(); }
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function boot() {
    loadBest();
    resize();
    bestVal.textContent = best.score;

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 150));

    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); pointerDown(e); });
    canvas.addEventListener('pointermove', (e) => { e.preventDefault(); pointerMove(e); });
    canvas.addEventListener('pointerup', (e) => { e.preventDefault(); pointerUp(e); });
    canvas.addEventListener('pointercancel', () => { if (game) game.aiming = false; });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // Set control hint by device.
    const hint = document.getElementById('controlHint');
    if (matchMedia('(pointer: fine)').matches) hint.textContent = 'Move to aim · click to fire';

    requestAnimationFrame(loop);

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch(() => {});
      });
    }
  }

  boot();
})();
