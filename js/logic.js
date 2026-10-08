// Pure game logic: no DOM, no clocks. Exposed as window.Logic.
// The server loads this file too and replays timed games with it to verify scores (see
// replay() below), so every rule that affects the score must live here, and all
// randomness that affects the board must come from the seeded `rand`.
(function (global) {
  'use strict';

  var SIZE = 7;
  var TYPES = 4;
  var TIMED_SECONDS = 90;
  var CROSS_TIME_BONUS = 4; // seconds per 4X PROTI tile in timed mode
  var nextId = 1;

  // Deterministic PRNG (sfc32) from a 32-hex-digit seed. Returns floats in [0, 1),
  // the same sequence in every JS engine.
  function rng(seed) {
    var a = parseInt(seed.slice(0, 8), 16) | 0, b = parseInt(seed.slice(8, 16), 16) | 0;
    var c = parseInt(seed.slice(16, 24), 16) | 0, d = parseInt(seed.slice(24, 32), 16) | 0;
    function next() {
      d = d + 1 | 0;
      var t = (a + b | 0) + d | 0;
      a = b ^ b >>> 9;
      b = c + (c << 3) | 0;
      c = (c << 21 | c >>> 11) + t | 0;
      return (t >>> 0) / 4294967296;
    }
    for (var i = 0; i < 15; i++) next();
    return next;
  }

  function threshold(l) { return 750 * l * (l + 1); } // score needed to finish level l

  function levelFor(score) {
    var l = 1;
    while (score >= threshold(l)) l++;
    return l;
  }

  // special: null | 'flame' | 'cross'. Cross (4X PROTI) tiles are colorless (type -1).
  function makeTile(type, special) {
    return { id: nextId++, type: type, special: special || null };
  }

  function inBounds(r, c, n) {
    return r >= 0 && c >= 0 && r < n && c < n;
  }

  function colorAt(grid, r, c) {
    var t = grid[r] && grid[r][c];
    return t && t.special !== 'cross' ? t.type : -1;
  }

  function randType(rand) {
    return Math.floor((rand || Math.random)() * TYPES);
  }

  function generateBoard(n, rand) {
    rand = rand || Math.random;
    for (var attempt = 0; attempt < 200; attempt++) {
      var grid = [];
      for (var r = 0; r < n; r++) {
        grid.push([]);
        for (var c = 0; c < n; c++) {
          var banned = {};
          if (c >= 2 && grid[r][c - 1].type === grid[r][c - 2].type) banned[grid[r][c - 1].type] = true;
          if (r >= 2 && grid[r - 1][c].type === grid[r - 2][c].type) banned[grid[r - 1][c].type] = true;
          var options = [];
          for (var t = 0; t < TYPES; t++) if (!banned[t]) options.push(t);
          grid[r].push(makeTile(options[Math.floor(rand() * options.length)]));
        }
      }
      if (findMove(grid)) return grid;
    }
    throw new Error('Could not generate a playable board');
  }

  // Returns groups of connected same-color runs (length >= 3).
  // Each group: { cells: [[r,c]...], type, hMax, vMax }
  function findMatches(grid) {
    var n = grid.length;
    var parent = {};
    function find(k) {
      while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; }
      return k;
    }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }

    var runs = [];
    for (var dir = 0; dir < 2; dir++) {
      for (var i = 0; i < n; i++) {
        var j = 0;
        while (j < n) {
          var r0 = dir === 0 ? i : j, c0 = dir === 0 ? j : i;
          var t = colorAt(grid, r0, c0);
          var e = j + 1;
          while (e < n && t >= 0 && colorAt(grid, dir === 0 ? i : e, dir === 0 ? e : i) === t) e++;
          if (t >= 0 && e - j >= 3) {
            var cells = [];
            for (var k = j; k < e; k++) cells.push(dir === 0 ? [i, k] : [k, i]);
            runs.push({ cells: cells, h: dir === 0, type: t });
          }
          j = e;
        }
      }
    }

    runs.forEach(function (run) {
      var first = run.cells[0][0] * n + run.cells[0][1];
      run.cells.forEach(function (p) {
        var key = p[0] * n + p[1];
        if (parent[key] === undefined) parent[key] = key;
        if (parent[first] === undefined) parent[first] = first;
        union(first, key);
      });
    });

    var groups = {};
    runs.forEach(function (run) {
      var root = find(run.cells[0][0] * n + run.cells[0][1]);
      var g = groups[root] || (groups[root] = { keys: {}, cells: [], type: run.type, hMax: 0, vMax: 0 });
      run.cells.forEach(function (p) {
        var key = p[0] * n + p[1];
        if (!g.keys[key]) { g.keys[key] = true; g.cells.push(p); }
      });
      if (run.h) g.hMax = Math.max(g.hMax, run.cells.length);
      else g.vMax = Math.max(g.vMax, run.cells.length);
    });

    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      return { cells: g.cells, type: g.type, hMax: g.hMax, vMax: g.vMax };
    });
  }

  // Match 5 or an L/T shape -> flame tile. Match 4 in a line -> 4X PROTI cross tile.
  function specialFor(group) {
    if (group.hMax >= 5 || group.vMax >= 5 || (group.hMax >= 3 && group.vMax >= 3)) return 'flame';
    if (group.hMax === 4 || group.vMax === 4) return 'cross';
    return null;
  }

  function createsMatchAt(grid, r, c) {
    var t = colorAt(grid, r, c);
    if (t < 0) return false;
    var n = grid.length, h = 1, v = 1, k;
    for (k = c - 1; k >= 0 && colorAt(grid, r, k) === t; k--) h++;
    for (k = c + 1; k < n && colorAt(grid, r, k) === t; k++) h++;
    for (k = r - 1; k >= 0 && colorAt(grid, k, c) === t; k--) v++;
    for (k = r + 1; k < n && colorAt(grid, k, c) === t; k++) v++;
    return h >= 3 || v >= 3;
  }

  function isSpecialSwap(a, b) {
    return a.special === 'cross' || b.special === 'cross' || !!(a.special && b.special);
  }

  // Returns the first valid swap [[r,c],[r2,c2]] or null.
  function findMove(grid) {
    var n = grid.length;
    var dirs = [[0, 1], [1, 0]];
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        for (var d = 0; d < 2; d++) {
          var r2 = r + dirs[d][0], c2 = c + dirs[d][1];
          if (!inBounds(r2, c2, n)) continue;
          var a = grid[r][c], b = grid[r2][c2];
          if (isSpecialSwap(a, b)) return [[r, c], [r2, c2]];
          grid[r][c] = b; grid[r2][c2] = a;
          var ok = createsMatchAt(grid, r, c) || createsMatchAt(grid, r2, c2);
          grid[r][c] = a; grid[r2][c2] = b;
          if (ok) return [[r, c], [r2, c2]];
        }
      }
    }
    return null;
  }

  // Effect of swapping a special tile. p1/p2 are positions AFTER the swap.
  function specialSwapEffect(grid, p1, p2) {
    var n = grid.length;
    var cells = new Set();
    function add(r, c) { if (inBounds(r, c, n)) cells.add(r * n + c); }
    function addRow(r) { for (var i = 0; i < n; i++) add(r, i); }
    function addCol(c) { for (var i = 0; i < n; i++) add(i, c); }

    var t1 = grid[p1[0]][p1[1]], t2 = grid[p2[0]][p2[1]];
    var effects = [], crosses = 0, flames = 0;
    var detonated = new Set();
    if (t1.special) detonated.add(p1[0] * n + p1[1]);
    if (t2.special) detonated.add(p2[0] * n + p2[1]);
    add(p1[0], p1[1]); add(p2[0], p2[1]);

    var s1 = t1.special, s2 = t2.special;
    if (s1 === 'cross' && s2 === 'cross') {
      [p1, p2].forEach(function (p) { addRow(p[0]); addCol(p[1]); effects.push({ kind: 'cross', r: p[0], c: p[1] }); });
      crosses = 2;
    } else if (s1 === 'cross' || s2 === 'cross') {
      var cp = s1 === 'cross' ? p1 : p2;
      var other = s1 === 'cross' ? s2 : s1;
      crosses = 1;
      if (other === 'flame') {
        for (var d = -1; d <= 1; d++) { if (cp[0] + d >= 0 && cp[0] + d < n) addRow(cp[0] + d); if (cp[1] + d >= 0 && cp[1] + d < n) addCol(cp[1] + d); }
        effects.push({ kind: 'bigcross', r: cp[0], c: cp[1] });
        flames = 1;
      } else {
        addRow(cp[0]); addCol(cp[1]);
        effects.push({ kind: 'cross', r: cp[0], c: cp[1] });
      }
    } else {
      // flame + flame: 5x5 blast
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) add(p1[0] + dr, p1[1] + dc);
      effects.push({ kind: 'bigflame', r: p1[0], c: p1[1] });
      flames = 2;
    }
    return { cells: cells, detonated: detonated, effects: effects, crosses: crosses, flames: flames };
  }

  // Chain-detonate specials inside the clear set. Mutates cells and detonated.
  function expandBlast(grid, cells, detonated) {
    var n = grid.length;
    var effects = [], crosses = 0, flames = 0;
    var queue = Array.from(cells);
    function add(r, c) {
      if (!inBounds(r, c, n)) return;
      var k = r * n + c;
      if (!cells.has(k)) { cells.add(k); queue.push(k); }
    }
    while (queue.length) {
      var k = queue.pop();
      var r = Math.floor(k / n), c = k % n;
      var t = grid[r][c];
      if (!t || !t.special || detonated.has(k)) continue;
      detonated.add(k);
      if (t.special === 'cross') {
        crosses++;
        effects.push({ kind: 'cross', r: r, c: c });
        for (var i = 0; i < n; i++) { add(r, i); add(i, c); }
      } else {
        flames++;
        effects.push({ kind: 'flame', r: r, c: c });
        for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) add(r + dr, c + dc);
      }
    }
    return { effects: effects, crosses: crosses, flames: flames };
  }

  // Drops tiles into empty (null) cells and fills from the top.
  // Returns { moves: [{tile, from, to, c}], spawns: [{tile, from, to, c}] } (from < 0 for spawns).
  function applyGravity(grid, rand) {
    var n = grid.length, moves = [], spawns = [];
    for (var c = 0; c < n; c++) {
      var write = n - 1;
      for (var r = n - 1; r >= 0; r--) {
        var t = grid[r][c];
        if (!t) continue;
        if (r !== write) {
          grid[write][c] = t;
          grid[r][c] = null;
          moves.push({ tile: t, from: r, to: write, c: c });
        }
        write--;
      }
      var empty = write + 1;
      for (var r2 = write; r2 >= 0; r2--) {
        var nt = makeTile(randType(rand));
        grid[r2][c] = nt;
        spawns.push({ tile: nt, from: r2 - empty, to: r2, c: c });
      }
    }
    return { moves: moves, spawns: spawns };
  }

  // Rearranges existing tiles until there are no matches and at least one move.
  // Falls back to recoloring plain tiles if no arrangement is found.
  function shuffle(grid, rand) {
    rand = rand || Math.random;
    var n = grid.length, tiles = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) tiles.push(grid[r][c]);
    for (var attempt = 0; attempt < 300; attempt++) {
      for (var i = tiles.length - 1; i > 0; i--) {
        var j = Math.floor(rand() * (i + 1));
        var tmp = tiles[i]; tiles[i] = tiles[j]; tiles[j] = tmp;
      }
      if (attempt > 150) {
        tiles.forEach(function (t) { if (!t.special) t.type = randType(rand); });
      }
      for (var k = 0; k < tiles.length; k++) grid[Math.floor(k / n)][k % n] = tiles[k];
      if (!findMatches(grid).length && findMove(grid)) return true;
    }
    return false;
  }

  // Plays the swap of a and b. Returns null (grid untouched) if it isn't a legal move.
  // Otherwise settles the board in place and returns what happened, one step per cascade,
  // for the UI to animate:
  // { steps: [{ combo, cleared: [{r, c, tile}], effects, points, crosses, created: [{r, c, tile}], gravity }],
  //   points, crosses, shuffled }
  function playTurn(grid, a, b, rand) {
    var n = grid.length;
    if (!inBounds(a[0], a[1], n) || !inBounds(b[0], b[1], n) ||
        Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) !== 1) return null;
    var t1 = grid[a[0]][a[1]], t2 = grid[b[0]][b[1]];
    grid[a[0]][a[1]] = t2; grid[b[0]][b[1]] = t1;
    var initial = null;
    if (isSpecialSwap(t1, t2)) {
      initial = specialSwapEffect(grid, b, a);
    } else if (!findMatches(grid).length) {
      grid[a[0]][a[1]] = t1; grid[b[0]][b[1]] = t2;
      return null;
    }

    var swapCells = [a, b], steps = [], total = 0, totalCrosses = 0;
    for (var combo = 1; ; combo++) {
      var cells, detonated, effects = [], crosses = 0, creations = [];
      if (initial) {
        cells = initial.cells;
        detonated = initial.detonated;
        effects = initial.effects.slice();
        crosses = initial.crosses;
        initial = null;
      } else {
        var groups = findMatches(grid);
        if (!groups.length) break;
        cells = new Set();
        detonated = new Set();
        groups.forEach(function (g) {
          g.cells.forEach(function (p) { cells.add(p[0] * n + p[1]); });
          var sp = specialFor(g);
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

      var ex = expandBlast(grid, cells, detonated);
      effects = effects.concat(ex.effects);
      crosses += ex.crosses;

      var cleared = [];
      cells.forEach(function (k) {
        var r = Math.floor(k / n), c = k % n, t = grid[r][c];
        if (!t) return;
        grid[r][c] = null;
        cleared.push({ r: r, c: c, tile: t });
      });
      var points = (cleared.length * 10 + effects.length * 100) * combo;

      // New special tiles appear where 4+ matches happened
      var created = creations.map(function (cr) {
        var nt = makeTile(cr.special === 'cross' ? -1 : cr.type, cr.special);
        grid[cr.r][cr.c] = nt;
        return { r: cr.r, c: cr.c, tile: nt };
      });

      steps.push({
        combo: combo, cleared: cleared, effects: effects, points: points, crosses: crosses,
        created: created, gravity: applyGravity(grid, rand)
      });
      total += points;
      totalCrosses += crosses;
      swapCells = null;
    }

    var shuffled = !findMove(grid);
    if (shuffled) shuffle(grid, rand);
    return { steps: steps, points: total, crosses: totalCrosses, shuffled: shuffled };
  }

  // ---------- Timing ----------
  // Pauses (ms at normal speed) between the animation phases of a turn. Input is blocked
  // while a turn animates, so these bound how many moves fit in a timed game.
  var TIMING = { swap: 180, clear: 240, create: 200, settle: 30, noMoves: 800, shuffle: 470 };

  function fallMs(rows) { return 120 + 55 * rows; }

  // Animations speed up with the level; reduced motion makes everything shorter as well.
  function speed(level, reduced) {
    return (reduced ? 0.7 : 1) * Math.max(0.6, 1 - 0.05 * (level - 1));
  }

  // The shortest a turn can take to animate: reduced motion, at the level reached by its end.
  function minTurnMs(turn, level) {
    var s = speed(level, true);
    var ms = TIMING.swap * s;
    turn.steps.forEach(function (st) {
      var rows = 0;
      st.gravity.moves.concat(st.gravity.spawns).forEach(function (m) { rows = Math.max(rows, m.to - m.from); });
      ms += (TIMING.clear + (st.created.length ? TIMING.create : 0) + fallMs(rows)) * s + TIMING.settle;
    });
    if (turn.shuffled) ms += (TIMING.noMoves + TIMING.shuffle) * s;
    return ms;
  }

  // Slack for clocks that lag behind the animations (the game clock skips long frames).
  var PACE = 0.9;

  function timeLimit(crosses) { return TIMED_SECONDS + CROSS_TIME_BONUS * crosses; }

  // Replays a timed game. moves: [[r1, c1, r2, c2, ms], ...], only swaps that were played,
  // where ms is the game clock (time used so far) when the swap was made.
  // Returns { ok: true, score, level, crosses, seconds, lastMoveMs } or { ok: false, reason }.
  function replay(seed, moves) {
    function fail(i, reason) { return { ok: false, reason: 'move ' + i + ': ' + reason }; }
    if (typeof seed !== 'string' || !/^[0-9a-f]{32}$/.test(seed)) return { ok: false, reason: 'bad seed' };
    if (!Array.isArray(moves)) return { ok: false, reason: 'bad moves' };
    var rand = rng(seed), grid = generateBoard(SIZE, rand);
    var score = 0, crosses = 0, earliest = 0, last = 0;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (!Array.isArray(m) || m.length !== 5 || !m.every(function (v) { return Number.isInteger(v) && v >= 0; })) {
        return fail(i, 'malformed');
      }
      var ms = m[4];
      if (ms < last) return fail(i, 'out of order');
      if (ms < earliest) return fail(i, 'faster than the animations');
      if (ms >= timeLimit(crosses) * 1000) return fail(i, 'after the time ran out');
      var turn = playTurn(grid, [m[0], m[1]], [m[2], m[3]], rand);
      if (!turn) return fail(i, 'illegal swap');
      score += turn.points;
      crosses += turn.crosses;
      earliest += PACE * minTurnMs(turn, levelFor(score));
      last = ms;
    }
    return { ok: true, score: score, level: levelFor(score), crosses: crosses, seconds: timeLimit(crosses), lastMoveMs: last };
  }

  global.Logic = {
    SIZE: SIZE,
    TYPES: TYPES,
    TIMED_SECONDS: TIMED_SECONDS,
    CROSS_TIME_BONUS: CROSS_TIME_BONUS,
    TIMING: TIMING,
    rng: rng,
    threshold: threshold,
    levelFor: levelFor,
    fallMs: fallMs,
    speed: speed,
    timeLimit: timeLimit,
    playTurn: playTurn,
    minTurnMs: minTurnMs,
    replay: replay,
    makeTile: makeTile,
    inBounds: inBounds,
    colorAt: colorAt,
    generateBoard: generateBoard,
    findMatches: findMatches,
    specialFor: specialFor,
    findMove: findMove,
    isSpecialSwap: isSpecialSwap,
    specialSwapEffect: specialSwapEffect,
    expandBlast: expandBlast,
    applyGravity: applyGravity,
    shuffle: shuffle
  };
})(typeof window !== 'undefined' ? window : globalThis);
