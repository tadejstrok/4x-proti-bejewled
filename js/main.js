// Rendering, input, game flow and UI screens.
(function () {
  'use strict';

  var N = Logic.SIZE;
  var FACES = [
    { img: 'public/janez.png', ring: '#FF7F00' },
    { img: 'public/logar.png', ring: '#FFFFFF' },
    { img: 'public/stevo.png', ring: '#00E5FF' },
    { img: 'public/vrtovec.png', ring: '#FF2D95' }
  ];
  var LOGO = 'public/4xproti.png';
  var TIMED_SECONDS = 90;
  var CROSS_TIME_BONUS = 4;
  var HINT_DELAY = 5000;
  // Leaderboard messages are off for now: no input on the submit form, not shown on the board.
  var SHOW_MESSAGES = false;
  var BOUNCE = 'cubic-bezier(.34, 1.25, .64, 1)';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var $ = function (id) { return document.getElementById(id); };
  var board = $('board'), boardWrap = $('board-wrap'), overlay = $('overlay');
  var canvas = $('fx'), fxCtx = canvas.getContext('2d');

  // ---------- State ----------
  var grid = null;
  var els = new Map(); // tile.id -> element
  var state = 'menu';  // menu | playing | over
  var mode = 'timed';  // timed | zen
  var score = 0, level = 1, timeLeft = TIMED_SECONDS, lastTick = 0;
  var busy = false, timeUp = false, selected = null, drag = null;
  var lastAction = 0, hintIds = [];
  var cellPx = 48, dpr = 1;
  var gameId = 0; // bumps on every new game so stale async cascades stop
  var gameStartedAt = 0, gameDuration = 0, submitted = false;

  // ---------- Storage ----------
  function loadBest(m) {
    try { return parseInt(localStorage.getItem('4xproti-best-' + m), 10) || 0; } catch (e) { return 0; }
  }
  function saveBest(m, v) {
    try { localStorage.setItem('4xproti-best-' + m, String(v)); } catch (e) {}
  }

  // ---------- Helpers ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function speed() { return (REDUCED ? 0.7 : 1) * Math.max(0.6, 1 - 0.05 * (level - 1)); }
  function D(ms) { return Math.round(ms * speed()); }
  function key(r, c) { return r * N + c; }
  function fmt(n) { return n.toLocaleString('sl-SI'); }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
    $('screen-' + name).classList.add('active');
    if (name === 'game') resize();
    if (name !== 'board') stopTips();
  }

  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  function flash() {
    if (REDUCED) return;
    var f = $('flash');
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
  }

  function shake() {
    if (REDUCED) return;
    boardWrap.classList.remove('shake');
    void boardWrap.offsetWidth;
    boardWrap.classList.add('shake');
  }

  // ---------- Tiles ----------
  function tileEl(tile) {
    var el = document.createElement('div');
    el.className = 'tile';
    var face = document.createElement('div');
    face.className = 'face';
    el.appendChild(face);
    updateTileLook(el, tile);
    board.appendChild(el);
    els.set(tile.id, el);
    return el;
  }

  function updateTileLook(el, tile) {
    var face = el.firstChild;
    el.classList.toggle('flame', tile.special === 'flame');
    face.classList.toggle('cross', tile.special === 'cross');
    if (tile.special === 'cross') {
      face.style.backgroundImage = 'url(' + LOGO + ')';
      face.style.removeProperty('--ring');
    } else {
      face.style.backgroundImage = 'url(' + FACES[tile.type].img + ')';
      face.style.setProperty('--ring', FACES[tile.type].ring);
    }
  }

  function place(el, r, c, dur, ease) {
    el.style.transition = dur ? 'transform ' + dur + 'ms ' + (ease || 'ease-out') : 'none';
    el.style.transform = 'translate(' + (c * 100) + '%, ' + (r * 100) + '%)';
  }

  function renderAll() {
    board.innerHTML = '';
    els.clear();
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) place(tileEl(grid[r][c]), r, c, 0);
  }

  function faceAt(p) {
    var t = grid[p[0]][p[1]];
    var el = t && els.get(t.id);
    return el ? el.firstChild : null;
  }

  function setSelected(p) {
    if (selected) { var f = faceAt(selected); if (f) f.classList.remove('selected'); }
    selected = p;
    if (p) { var g = faceAt(p); if (g) g.classList.add('selected'); }
  }

  function clearHint() {
    hintIds.forEach(function (id) {
      var el = els.get(id);
      if (el) el.firstChild.classList.remove('hint');
    });
    hintIds = [];
  }

  function showHint() {
    var mv = Logic.findMove(grid);
    if (!mv) return;
    mv.forEach(function (p) {
      var t = grid[p[0]][p[1]];
      hintIds.push(t.id);
      els.get(t.id).firstChild.classList.add('hint');
    });
  }

  // ---------- FX canvas ----------
  var parts = [], rings = [], beams = [];

  function resize() {
    var rect = board.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cellPx = rect.width / N;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    document.documentElement.style.setProperty('--cell', cellPx + 'px');
  }

  function center(r, c) { return { x: (c + 0.5) * cellPx, y: (r + 0.5) * cellPx }; }

  function burst(r, c, color, count) {
    var p = center(r, c);
    count = REDUCED ? Math.ceil(count / 2) : count;
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2, s = (0.4 + Math.random()) * cellPx * 0.12;
      parts.push({
        x: p.x, y: p.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - cellPx * 0.03,
        life: 1, decay: 0.02 + Math.random() * 0.02, size: cellPx * (0.04 + Math.random() * 0.07), color: color
      });
    }
  }

  function ember(r, c) {
    var p = center(r, c);
    parts.push({
      x: p.x + (Math.random() - 0.5) * cellPx * 0.6, y: p.y + cellPx * 0.2,
      vx: (Math.random() - 0.5) * 0.6, vy: -cellPx * (0.02 + Math.random() * 0.03),
      life: 1, decay: 0.03, size: cellPx * 0.05, color: Math.random() < 0.5 ? '#FFB000' : '#FF5A00', noGravity: true
    });
  }

  function ring(r, c, radiusCells, color) {
    var p = center(r, c);
    rings.push({ x: p.x, y: p.y, r: 0, max: radiusCells * cellPx, life: 1, color: color });
  }

  function beam(index, horizontal) {
    beams.push({ index: index, h: horizontal, life: 1 });
  }

  function playEffects(effects) {
    effects.forEach(function (e) {
      if (e.kind === 'cross' || e.kind === 'bigcross') {
        var spread = e.kind === 'bigcross' ? 1 : 0;
        for (var d = -spread; d <= spread; d++) { beam(e.r + d, true); beam(e.c + d, false); }
        ring(e.r, e.c, 2, '#FF7F00');
      } else {
        ring(e.r, e.c, e.kind === 'bigflame' ? 3 : 1.8, '#FFB000');
        burst(e.r, e.c, '#FF5A00', 24);
      }
    });
  }

  function drawFx() {
    var w = canvas.width, h = canvas.height;
    fxCtx.setTransform(1, 0, 0, 1, 0, 0);
    fxCtx.clearRect(0, 0, w, h);
    if (!parts.length && !rings.length && !beams.length) return;
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fxCtx.globalCompositeOperation = 'lighter';
    var size = cellPx * N;

    beams = beams.filter(function (b) {
      b.life -= 0.045;
      if (b.life <= 0) return false;
      var thick = cellPx * (0.25 + 0.75 * b.life);
      var pos = (b.index + 0.5) * cellPx - thick / 2;
      fxCtx.globalAlpha = b.life;
      fxCtx.fillStyle = '#FF7F00';
      if (b.h) fxCtx.fillRect(0, pos, size, thick); else fxCtx.fillRect(pos, 0, thick, size);
      fxCtx.fillStyle = '#FFFFFF';
      var core = thick * 0.3;
      var cpos = (b.index + 0.5) * cellPx - core / 2;
      if (b.h) fxCtx.fillRect(0, cpos, size, core); else fxCtx.fillRect(cpos, 0, core, size);
      return true;
    });

    rings = rings.filter(function (rg) {
      rg.life -= 0.04;
      if (rg.life <= 0) return false;
      rg.r = rg.max * (1 - rg.life * rg.life);
      fxCtx.globalAlpha = rg.life;
      fxCtx.strokeStyle = rg.color;
      fxCtx.lineWidth = cellPx * 0.18 * rg.life + 1;
      fxCtx.beginPath();
      fxCtx.arc(rg.x, rg.y, rg.r, 0, Math.PI * 2);
      fxCtx.stroke();
      return true;
    });

    parts = parts.filter(function (p) {
      p.life -= p.decay;
      if (p.life <= 0) return false;
      p.x += p.vx; p.y += p.vy;
      if (!p.noGravity) p.vy += cellPx * 0.006;
      p.vx *= 0.98;
      fxCtx.globalAlpha = p.life;
      fxCtx.fillStyle = p.color;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, p.size * (0.5 + p.life * 0.5), 0, Math.PI * 2);
      fxCtx.fill();
      return true;
    });

    fxCtx.globalAlpha = 1;
    fxCtx.globalCompositeOperation = 'source-over';
  }

  // ---------- Overlay text ----------
  function popup(r, c, text, cls) {
    var d = document.createElement('div');
    d.className = 'popup' + (cls ? ' ' + cls : '');
    d.textContent = text;
    d.style.left = ((c + 0.5) / N * 100) + '%';
    d.style.top = ((r + 0.5) / N * 100) + '%';
    overlay.appendChild(d);
    setTimeout(function () { d.remove(); }, 950);
  }

  var SLOGANS = [
    'PROTI POLITIČNI POLICIJI',
    'PROTI IZBRISU VOLIVCEV',
    'PROTI UNIČENJU RTV',
    'PROTI PRISILNEMU DELU',
    'PROTI IZDAJALCEM',
    'PROTI LAŽNIVCEM',
    'PROTI PREVARANTOM',
    'PROTI SVETOHLINCEM'
  ];

  function shuffled(list) {
    var pool = list.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    return pool;
  }

  // Returns `count` different slogans in random order.
  function randomSlogans(count) {
    return shuffled(SLOGANS).slice(0, count);
  }

  function callout(text, big, slogans) {
    overlay.querySelectorAll('.callout').forEach(function (n) { n.remove(); });
    var withSlogans = slogans && slogans.length;
    var d = document.createElement('div');
    d.className = 'callout' + (big ? ' big' : '') + (withSlogans ? ' with-slogan' : '');
    var main = document.createElement('div');
    main.textContent = text;
    d.appendChild(main);
    (slogans || []).forEach(function (text) {
      var sub = document.createElement('div');
      sub.className = 'slogan';
      sub.textContent = text;
      d.appendChild(sub);
    });
    overlay.appendChild(d);
    setTimeout(function () { d.remove(); }, withSlogans ? 1850 : 1150);
  }

  function comboCallout(combo) {
    if (combo < 3) return;
    var n = combo - 2; // 1X, 2X, 3X, 4X, 5X ...
    var big = n >= 4;
    callout(n + 'X', big, randomSlogans(Math.min(n, 4)));
    if (big) flash();
  }

  // ---------- Score & level ----------
  function threshold(l) { return 750 * l * (l + 1); } // score needed to finish level l

  function addScore(points) {
    score += points;
    var s = $('score');
    s.textContent = fmt(score);
    s.classList.remove('bump'); void s.offsetWidth; s.classList.add('bump');
    while (score >= threshold(level)) {
      level++;
      $('level').textContent = level;
      document.documentElement.style.setProperty('--intensity', Math.min(1, (level - 1) / 8));
      setTimeout(function (l) { return function () { callout('NIVO ' + l, true); Sfx.levelUp(); }; }(level), 500);
    }
    updateProgress();
  }

  function updateProgress() {
    var lo = threshold(level - 1), hi = threshold(level);
    $('progress-fill').style.width = Math.min(100, (score - lo) / (hi - lo) * 100) + '%';
  }

  function updateTimer() {
    var stat = $('timer-stat');
    if (mode !== 'timed') { $('time').textContent = '∞'; stat.classList.remove('low'); return; }
    $('time').textContent = Math.ceil(timeLeft);
    stat.classList.toggle('low', timeLeft <= 10 && timeLeft > 0);
  }

  // ---------- Game flow ----------
  function startGame(m) {
    Sfx.unlock();
    mode = m;
    gameId++;
    score = 0; level = 1; timeLeft = TIMED_SECONDS; lastTick = Math.ceil(timeLeft);
    busy = false; timeUp = false; selected = null; drag = null; hintIds = [];
    parts = []; rings = []; beams = [];
    document.documentElement.style.setProperty('--intensity', 0);
    $('score').textContent = '0';
    $('level').textContent = '1';
    overlay.innerHTML = '';
    updateProgress();
    updateTimer();
    showScreen('game');
    grid = Logic.generateBoard(N);
    renderAll();
    lastAction = performance.now();
    gameStartedAt = lastAction;
    submitted = false;
    state = 'playing';
  }

  function endGame() {
    if (state !== 'playing') return;
    state = 'over';
    gameDuration = Math.round((performance.now() - gameStartedAt) / 1000);
    setSelected(null);
    clearHint();
    var best = loadBest(mode);
    var record = score > best;
    if (record) { best = score; saveBest(mode, score); }
    $('final-score').textContent = fmt(score);
    $('final-best').textContent = fmt(best);
    $('new-record').hidden = !record;
    updateBestLine();
    updateSubmitButton();
    Sfx.gameOver();
    setTimeout(function () { showScreen('over'); }, 400);
  }

  function quit() {
    if (state !== 'playing') return;
    if (mode === 'zen') { endGame(); return; }
    state = 'menu';
    showScreen('menu');
  }

  function afterTurn() {
    lastAction = performance.now();
    if (timeUp) endGame();
  }

  async function attemptSwap(a, b) {
    if (busy || state !== 'playing' || timeUp) return;
    busy = true;
    clearHint();
    var id = gameId;
    var r1 = a[0], c1 = a[1], r2 = b[0], c2 = b[1];
    var t1 = grid[r1][c1], t2 = grid[r2][c2];
    var e1 = els.get(t1.id), e2 = els.get(t2.id);
    Sfx.swap();
    place(e1, r2, c2, D(170));
    place(e2, r1, c1, D(170));
    grid[r1][c1] = t2; grid[r2][c2] = t1;
    await sleep(D(180));
    if (id !== gameId) return;

    if (Logic.isSpecialSwap(t1, t2)) {
      var eff = Logic.specialSwapEffect(grid, b, a);
      await resolve(eff, [a, b], id);
    } else if (Logic.findMatches(grid).length) {
      await resolve(null, [a, b], id);
    } else {
      Sfx.invalid();
      grid[r1][c1] = t1; grid[r2][c2] = t2;
      place(e1, r1, c1, D(170));
      place(e2, r2, c2, D(170));
      e1.firstChild.classList.add('nope');
      e2.firstChild.classList.add('nope');
      await sleep(D(320));
      e1.firstChild.classList.remove('nope');
      e2.firstChild.classList.remove('nope');
    }
    if (id !== gameId) return;
    busy = false;
    afterTurn();
  }

  // Clears matches (or an initial special blast), drops tiles and repeats until stable.
  async function resolve(initial, swapCells, id) {
    var combo = 0;
    function live() { return state === 'playing' && id === gameId; }
    while (live()) {
      var cells, detonated, effects = [], crosses = 0, creations = [];
      if (initial) {
        cells = initial.cells;
        detonated = initial.detonated;
        effects = initial.effects.slice();
        crosses = initial.crosses;
        initial = null;
      } else {
        var groups = Logic.findMatches(grid);
        if (!groups.length) break;
        cells = new Set();
        detonated = new Set();
        groups.forEach(function (g) {
          g.cells.forEach(function (p) { cells.add(key(p[0], p[1])); });
          var sp = Logic.specialFor(g);
          if (!sp) return;
          var pos = null;
          if (swapCells) {
            swapCells.forEach(function (s) {
              if (!pos && g.cells.some(function (p) { return p[0] === s[0] && p[1] === s[1]; })) pos = s;
            });
          }
          if (!pos) {
            var sorted = g.cells.slice().sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
            pos = sorted[Math.floor(sorted.length / 2)];
          }
          creations.push({ r: pos[0], c: pos[1], special: sp, type: g.type });
        });
      }
      combo++;

      var ex = Logic.expandBlast(grid, cells, detonated);
      effects = effects.concat(ex.effects);
      crosses += ex.crosses;

      // Clear
      var sumR = 0, sumC = 0, count = 0;
      cells.forEach(function (k) {
        var r = Math.floor(k / N), c = k % N, t = grid[r][c];
        if (!t) return;
        grid[r][c] = null;
        sumR += r; sumC += c; count++;
        var el = els.get(t.id);
        els.delete(t.id);
        el.style.zIndex = 3;
        el.firstChild.classList.remove('selected', 'hint');
        el.firstChild.classList.add('pop');
        setTimeout(function () { el.remove(); }, 280);
        burst(r, c, t.special === 'cross' ? '#FF7F00' : FACES[t.type].ring, 10);
      });

      if (effects.length) {
        playEffects(effects);
        Sfx.boom();
        shake();
      }
      Sfx.pop(combo);

      var points = (count * 10 + effects.length * 100) * combo;
      addScore(points);
      if (count) popup(sumR / count, sumC / count, '+' + fmt(points));
      if (mode === 'timed' && crosses) {
        timeLeft += CROSS_TIME_BONUS * crosses;
        updateTimer();
        Sfx.bonus();
        popup(0.6, N / 2 - 0.5, '+' + (CROSS_TIME_BONUS * crosses) + ' s', 'time');
      }
      if (effects.some(function (e) { return e.kind !== 'flame'; })) {
        callout('4X PROTI!', true, randomSlogans(4));
        flash();
      } else {
        comboCallout(combo);
      }
      // Bonus moments (special tile blast or a 1X+ combo) get a random voice clip.
      if (effects.length || combo >= 3) Sfx.voice();

      await sleep(D(240));
      if (!live()) return;

      // New special tiles appear where 4+ matches happened
      creations.forEach(function (cr) {
        var nt = Logic.makeTile(cr.special === 'cross' ? -1 : cr.type, cr.special);
        grid[cr.r][cr.c] = nt;
        var el = tileEl(nt);
        place(el, cr.r, cr.c, 0);
        el.firstChild.classList.add('born');
        setTimeout(function () { el.firstChild.classList.remove('born'); }, 450);
      });
      if (creations.length) {
        Sfx.create();
        await sleep(D(200));
        if (!live()) return;
      }

      // Gravity
      var g = Logic.applyGravity(grid);
      var maxDur = 0;
      g.moves.forEach(function (m) {
        var dur = D(120 + 55 * (m.to - m.from));
        maxDur = Math.max(maxDur, dur);
        place(els.get(m.tile.id), m.to, m.c, dur, BOUNCE);
      });
      var spawned = g.spawns.map(function (s) {
        var el = tileEl(s.tile);
        place(el, s.from, s.c, 0);
        return { el: el, s: s };
      });
      void board.offsetHeight;
      spawned.forEach(function (o) {
        var dur = D(120 + 55 * (o.s.to - o.s.from));
        maxDur = Math.max(maxDur, dur);
        place(o.el, o.s.to, o.s.c, dur, BOUNCE);
      });
      await sleep(maxDur + 30);
      swapCells = null;
    }

    if (live() && !Logic.findMove(grid)) await reshuffle();
  }

  async function reshuffle() {
    callout('NI VEČ POTEZ!', false);
    await sleep(D(800));
    Sfx.shuffle();
    Logic.shuffle(grid);
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var el = els.get(grid[r][c].id);
        updateTileLook(el, grid[r][c]);
        place(el, r, c, D(450), 'cubic-bezier(.5, 0, .2, 1)');
      }
    }
    await sleep(D(470));
  }

  // ---------- Input ----------
  function cellFromEvent(e) {
    var rect = board.getBoundingClientRect();
    var c = Math.floor((e.clientX - rect.left) / rect.width * N);
    var r = Math.floor((e.clientY - rect.top) / rect.height * N);
    return Logic.inBounds(r, c, N) ? [r, c] : null;
  }

  function adjacent(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1; }

  function canPlay() { return state === 'playing' && !busy && !timeUp; }

  board.addEventListener('pointerdown', function (e) {
    Sfx.unlock();
    if (!canPlay()) return;
    var cell = cellFromEvent(e);
    if (!cell) return;
    e.preventDefault();
    drag = { start: cell, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    try { board.setPointerCapture(e.pointerId); } catch (err) {}
    clearHint();
    lastAction = performance.now();
  });

  board.addEventListener('pointermove', function (e) {
    if (!drag || drag.moved || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y, th = cellPx * 0.35;
    if (Math.abs(dx) < th && Math.abs(dy) < th) return;
    drag.moved = true;
    var r = drag.start[0], c = drag.start[1];
    var target = Math.abs(dx) > Math.abs(dy) ? [r, c + Math.sign(dx)] : [r + Math.sign(dy), c];
    if (Logic.inBounds(target[0], target[1], N) && canPlay()) {
      setSelected(null);
      attemptSwap(drag.start, target);
    }
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    if (e.type === 'pointerup' && !d.moved && canPlay()) handleTap(d.start);
  }
  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', endDrag);

  function handleTap(cell) {
    if (selected && selected[0] === cell[0] && selected[1] === cell[1]) { setSelected(null); return; }
    if (selected && adjacent(selected, cell)) {
      var s = selected;
      setSelected(null);
      attemptSwap(s, cell);
      return;
    }
    Sfx.select();
    setSelected(cell);
  }

  // ---------- Main loop ----------
  var prev = performance.now();
  function loop(now) {
    var dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;

    if (state === 'playing') {
      if (mode === 'timed' && !timeUp) {
        timeLeft -= dt;
        var sec = Math.ceil(timeLeft);
        if (sec !== lastTick) {
          lastTick = sec;
          if (sec <= 10 && sec > 0) Sfx.tick();
        }
        if (timeLeft <= 0) {
          timeLeft = 0;
          timeUp = true;
          setSelected(null);
          callout('ZMANJKALO\nJE ČASA!', true);
          if (!busy) setTimeout(endGame, 900);
        }
        updateTimer();
      }
      if (!busy && !timeUp && !hintIds.length && now - lastAction > HINT_DELAY) showHint();
      if (!REDUCED) {
        for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
          var t = grid[r][c];
          if (t && t.special === 'flame' && Math.random() < 0.08) ember(r, c);
        }
      }
    }
    drawFx();
    requestAnimationFrame(loop);
  }

  // ---------- Leaderboard ----------
  var boardBack = 'menu';

  // Loading-screen style tips under the leaderboard: mostly nudges to vote, plus a few game tips.
  var TIPS = [
    'Referendum je v nedeljo, 11. oktobra. Tega "levela" ne moreš ponoviti.',
    'Volišča so odprta od 7. do 19. ure. Dovolj časa za brunch s prijateljicami, sprehod in 4xPROTI.',
    'Ne pozabi osebnega dokumenta. Brez njega na volišču ne gre. Spomni tudi druge.',
    'Zakon pade, če PROTI glasuje večina in hkrati vsaj petina vseh volivcev. Vsak glas šteje v ta prag. Poskrbi, da tvoji znanci in družina glasujejo.',
    'Rekord na lestvici je lep. Glas na referendumu je lepši (še posebej tisti od prijatelja).',
    'Najmočnejša kombinacija: ti + prijatelji + volišče. Povabi jih s seboj.',
    'Obkrožiti PROTI štirikrat vzame manj časa kot ena igra v načinu Odštevanje.',
    'Pokliči mamo, brata, sosedo. Vsak dodaten glas dvigne kombo.',
    'Kdor v nedeljo ostane doma, ga ne šteje nobena lestvica.',
    'Deli igro s prijatelji in jih spomni, da naj v nedeljo glasujejo 4xPROTI.',
    'Glasovanje je igra, kjer šteje vsaka poteza.',
    '4 v vrsto ustvari ploščico 4xPROTI. Zamenjaj jo s sosedo in počisti celo vrstico in stolpec.',
    '5 v vrsto ali oblika L/T ustvari gorečo ploščico, ki eksplodira v kvadratu 3 × 3.',
    'Zamenjaj dve posebni ploščici med sabo in združi njuni moči.',
    'V načinu Odštevanje ti vsaka 4X PROTI bomba prinese +4 sekunde.',
    'Ujemanja nizko na plošči sprožijo več padcev in višji večkratnik.',
  ];
  var TIP_INTERVAL = 7000;
  var tipDeck = [], tipTimer = null;

  function nextTip() {
    if (!tipDeck.length) tipDeck = shuffled(TIPS);
    var el = $('tip-text');
    el.classList.remove('in');
    void el.offsetWidth;
    el.textContent = tipDeck.pop();
    el.classList.add('in');
  }

  function startTips() {
    stopTips();
    nextTip();
    tipTimer = setInterval(nextTip, TIP_INTERVAL);
  }

  function stopTips() {
    clearInterval(tipTimer);
    tipTimer = null;
  }

  // Only timed games go on the leaderboard (zen scores are unbounded).
  function updateSubmitButton() {
    var canSubmit = mode === 'timed' && score > 0 && !submitted;
    $('btn-submit').hidden = !canSubmit;
    $('btn-again').classList.toggle('primary', !canSubmit);
  }

  function openSubmitForm() {
    var nick = '';
    try { nick = localStorage.getItem('4xproti-nickname') || ''; } catch (e) {}
    $('submit-score').textContent = fmt(score);
    $('nick').value = nick;
    $('msg').value = '';
    $('msg-count').textContent = '0';
    setFormError(null);
    $('btn-send').disabled = false;
    $('btn-send').textContent = 'Pošlji';
    showScreen('submit');
    (nick && SHOW_MESSAGES ? $('msg') : $('nick')).focus();
  }

  function setFormError(field, text) {
    $('nick').classList.toggle('invalid', field === 'nickname');
    $('msg').classList.toggle('invalid', field === 'message');
    $('form-error').textContent = text || '';
  }

  async function sendScore(e) {
    e.preventDefault();
    if (submitted) return;
    var check = TextFilter.validate($('nick').value, $('msg').value);
    if (!check.ok) {
      setFormError(check.field, check.error);
      $(check.field === 'nickname' ? 'nick' : 'msg').focus();
      return;
    }
    setFormError(null);
    var btn = $('btn-send');
    btn.disabled = true;
    btn.textContent = 'Pošiljam…';
    try {
      var res = await Leaderboard.submit({
        nickname: check.nickname,
        message: check.message,
        score: score,
        level: level,
        durationSeconds: gameDuration
      });
      submitted = true;
      try { localStorage.setItem('4xproti-nickname', check.nickname); } catch (err) {}
      updateSubmitButton();
      showLeaderboard({ back: 'over', highlightId: res && res.id, rank: res && res.rank });
    } catch (err) {
      setFormError(null, err.serverMessage || 'Vpis ni uspel. Preveri povezavo in poskusi znova.');
      btn.disabled = false;
      btn.textContent = 'Pošlji';
    }
  }

  async function showLeaderboard(opts) {
    boardBack = opts.back;
    var list = $('board-list'), status = $('board-status'), rankEl = $('board-rank');
    list.innerHTML = '';
    rankEl.hidden = !opts.rank;
    if (opts.rank) rankEl.textContent = 'Si na ' + opts.rank + '. mestu!';
    $('board-local').hidden = !Leaderboard.isLocal();
    status.textContent = 'Nalaganje…';
    showScreen('board');
    startTips();
    try {
      var rows = await Leaderboard.top(10);
      status.textContent = rows.length ? '' : 'Lestvica je še prazna. Bodi prvi!';
      rows.forEach(function (row, i) {
        var li = document.createElement('li');
        if (opts.highlightId && row.id === opts.highlightId) li.className = 'me';
        var pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = (i + 1) + '.';
        var who = document.createElement('div');
        who.className = 'who';
        var nick = document.createElement('span');
        nick.className = 'nick';
        nick.textContent = row.nickname;
        who.appendChild(nick);
        if (SHOW_MESSAGES && row.message) {
          var msg = document.createElement('span');
          msg.className = 'msg';
          msg.textContent = row.message;
          who.appendChild(msg);
        }
        var pts = document.createElement('span');
        pts.className = 'pts';
        pts.textContent = fmt(row.score);
        li.appendChild(pos);
        li.appendChild(who);
        li.appendChild(pts);
        list.appendChild(li);
      });
    } catch (err) {
      status.textContent = 'Lestvice ni bilo mogoče naložiti.';
    }
  }

  // ---------- UI wiring ----------
  if (!SHOW_MESSAGES) {
    document.querySelectorAll('.msg-field').forEach(function (el) { el.hidden = true; });
    $('form-note').textContent = 'Vzdevek bo javno viden na lestvici.';
  }

  function updateBestLine() {
    $('best-timed').textContent = fmt(loadBest('timed'));
    $('best-zen').textContent = fmt(loadBest('zen'));
  }

  function updateMuteButtons() {
    document.querySelectorAll('.mute-btn').forEach(function (b) {
      b.textContent = Sfx.isMuted() ? '🔇' : '🔊';
      b.setAttribute('aria-label', Sfx.isMuted() ? 'Vklopi zvok' : 'Izklopi zvok');
    });
  }

  document.querySelectorAll('.mute-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      Sfx.unlock();
      Sfx.setMuted(!Sfx.isMuted());
      updateMuteButtons();
    });
  });

  function updateVoiceButtons() {
    var on = Sfx.voicesOn();
    document.querySelectorAll('.voice-btn').forEach(function (b) {
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', on ? 'Izklopi glasove' : 'Vklopi glasove');
      b.title = on ? 'Glasovi: vklopljeni' : 'Glasovi: izklopljeni';
    });
  }

  document.querySelectorAll('.voice-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      Sfx.unlock();
      Sfx.setVoices(!Sfx.voicesOn());
      updateVoiceButtons();
    });
  });

  $('btn-play').addEventListener('click', function () { startGame('timed'); });
  $('btn-zen').addEventListener('click', function () { startGame('zen'); });
  $('btn-again').addEventListener('click', function () { startGame(mode); });
  $('btn-menu').addEventListener('click', function () { state = 'menu'; showScreen('menu'); });
  $('btn-leaderboard').addEventListener('click', function () { showLeaderboard({ back: 'menu' }); });
  $('btn-submit').addEventListener('click', openSubmitForm);
  $('btn-cancel').addEventListener('click', function () { showScreen('over'); });
  $('btn-board-back').addEventListener('click', function () { showScreen(boardBack); });
  // Tapping the tip skips ahead, like on a loading screen.
  $('board-tip').addEventListener('click', function () { if (tipTimer) startTips(); });
  $('submit-form').addEventListener('submit', sendScore);
  $('msg').addEventListener('input', function () { $('msg-count').textContent = this.value.length; });
  $('btn-quit').addEventListener('click', quit);
  $('btn-share').addEventListener('click', async function () {
    var text = 'Moj rezultat v igri 4X PROTI: ' + fmt(score) + ' točk! V nedeljo glasuj 4X PROTI.';
    var url = location.href.split('#')[0];
    if (navigator.share) {
      try { await navigator.share({ title: '4X PROTI', text: text, url: url }); } catch (e) {}
      return;
    }
    try {
      await navigator.clipboard.writeText(text + ' ' + url);
      toast('Povezava kopirana!');
    } catch (e) {
      toast(url);
    }
  });

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(board);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (selected) setSelected(null); else quit(); }
  });

  // ---------- Boot ----------
  function preload(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = img.onerror = resolve;
      img.src = src;
    });
  }

  if (location.hash === '#debug') {
    window.__game = {
      get grid() { return grid; },
      get busy() { return busy; },
      get score() { return score; },
      set timeLeft(v) { timeLeft = v; },
      swap: attemptSwap,
      render: renderAll
    };
  }

  updateBestLine();
  updateMuteButtons();
  updateVoiceButtons();
  Promise.all(FACES.map(function (f) { return preload(f.img); }).concat(preload(LOGO))).then(function () {
    $('btn-play').disabled = false;
    $('btn-zen').disabled = false;
    $('btn-play').textContent = 'Igraj';
  });
  requestAnimationFrame(loop);
})();
