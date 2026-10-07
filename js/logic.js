// Pure board logic: no DOM, no timing. Exposed as window.Logic.
(function (global) {
  'use strict';

  var SIZE = 7;
  var TYPES = 4;
  var nextId = 1;

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

  global.Logic = {
    SIZE: SIZE,
    TYPES: TYPES,
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
})(window);
