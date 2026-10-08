// Run with `node --test js/logic.test.js`.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
require('./logic.js');

const SEED = '0123456789abcdef0123456789abcdef';

// Plays a timed game as fast as the rules allow, always taking the first move found.
// Returns { moves, score, crosses } in the format replay() expects.
function playFast(seed, { gapMs = 0 } = {}) {
  const rand = Logic.rng(seed);
  const grid = Logic.generateBoard(Logic.SIZE, rand);
  const moves = [];
  let ms = 0, score = 0, crosses = 0;
  while (ms < Logic.timeLimit(crosses) * 1000) {
    const [a, b] = Logic.findMove(grid);
    const turn = Logic.playTurn(grid, a, b, rand);
    assert.ok(turn, 'findMove gave a legal move');
    moves.push([a[0], a[1], b[0], b[1], ms]);
    score += turn.points;
    crosses += turn.crosses;
    ms += Math.ceil(Logic.minTurnMs(turn, Logic.levelFor(score))) + gapMs;
  }
  return { moves, score, crosses };
}

test('rng is deterministic and in [0, 1)', () => {
  const a = Logic.rng(SEED), b = Logic.rng(SEED), c = Logic.rng('f'.repeat(32));
  const xs = Array.from({ length: 1000 }, a);
  assert.deepStrictEqual(Array.from({ length: 1000 }, b), xs);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepStrictEqual(Array.from({ length: 1000 }, c), xs);
  assert.ok(new Set(xs).size > 990);
});

test('the same seed generates the same board', () => {
  const types = (g) => g.map((row) => row.map((t) => t.type));
  assert.deepStrictEqual(types(Logic.generateBoard(7, Logic.rng(SEED))), types(Logic.generateBoard(7, Logic.rng(SEED))));
});

test('playTurn rejects non-matching and non-adjacent swaps without touching the board', () => {
  const grid = Logic.generateBoard(7, Logic.rng(SEED));
  const before = grid.map((row) => row.map((t) => t.id));
  assert.strictEqual(Logic.playTurn(grid, [0, 0], [2, 0], Math.random), null);
  assert.strictEqual(Logic.playTurn(grid, [0, 0], [0, 7], Math.random), null);
  // A plain swap that makes no match: first adjacent pair that findMove would skip.
  let rejected = false;
  for (let r = 0; r < 7 && !rejected; r++) {
    for (let c = 0; c < 6 && !rejected; c++) {
      const copy = grid.map((row) => row.slice());
      copy[r][c] = grid[r][c + 1]; copy[r][c + 1] = grid[r][c];
      if (!Logic.findMatches(copy).length) {
        assert.strictEqual(Logic.playTurn(grid, [r, c], [r, c + 1], Math.random), null);
        rejected = true;
      }
    }
  }
  assert.ok(rejected);
  assert.deepStrictEqual(grid.map((row) => row.map((t) => t.id)), before);
});

test('playTurn leaves a full, settled board and adds up its steps', () => {
  const rand = Logic.rng(SEED);
  const grid = Logic.generateBoard(7, rand);
  for (let i = 0; i < 50; i++) {
    const turn = Logic.playTurn(grid, ...Logic.findMove(grid), rand);
    assert.ok(turn.steps.length >= 1);
    assert.strictEqual(turn.points, turn.steps.reduce((s, st) => s + st.points, 0));
    assert.strictEqual(turn.crosses, turn.steps.reduce((s, st) => s + st.crosses, 0));
    turn.steps.forEach((st, k) => assert.strictEqual(st.combo, k + 1));
    assert.ok(grid.every((row) => row.every(Boolean)));
    assert.strictEqual(Logic.findMatches(grid).length, 0);
    assert.ok(Logic.findMove(grid));
  }
});

test('replay reproduces the score of a played game', () => {
  for (const seed of [SEED, 'deadbeef'.repeat(4), '00000000000000000000000000000001']) {
    const game = playFast(seed);
    const r = Logic.replay(seed, game.moves);
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.score, game.score);
    assert.strictEqual(r.crosses, game.crosses);
    assert.strictEqual(r.level, Logic.levelFor(game.score));
    assert.strictEqual(r.seconds, 90 + 4 * game.crosses);
    assert.ok(game.moves.length > 50, 'a fast game has plenty of moves');
  }
});

test('replay rejects tampered games', () => {
  const { moves } = playFast(SEED, { gapMs: 200 });
  const cases = [
    ['nope', moves, 'bad seed'],
    [SEED, [[0, 0, 0, 0, 0]], 'move 0: illegal swap'],
    [SEED, [[0, 0, 2, 0, 0]], 'move 0: illegal swap'],
    [SEED, [[0, 0, 0, 1]], 'move 0: malformed'],
    [SEED, [[...moves[0].slice(0, 4), 1.5]], 'move 0: malformed'],
    [SEED, [[...moves[0].slice(0, 4), 5000], [...moves[1].slice(0, 4), 4000]], 'move 1: out of order'],
    [SEED, moves.map((m) => [...m.slice(0, 4), 0]), 'move 1: faster than the animations'],
    [SEED, [[...moves[0].slice(0, 4), 90000]], 'move 0: after the time ran out'],
    ['f'.repeat(32), moves, 'move 0: illegal swap'] // moves from another board
  ];
  for (const [seed, ms, reason] of cases) {
    assert.deepStrictEqual(Logic.replay(seed, ms), { ok: false, reason });
  }
});

test('the clock allows moves up to, not at, the time limit', () => {
  const { moves } = playFast(SEED);
  const first = moves[0].slice(0, 4);
  assert.ok(Logic.replay(SEED, [[...first, 89999]]).ok);
  assert.strictEqual(Logic.replay(SEED, [[...first, 90000]]).ok, false);
});

test('4X PROTI tiles extend the time limit', () => {
  // Find a seed where a fast game earns a cross, then check a move is allowed past 90 s.
  for (let i = 0; i < 50; i++) {
    const seed = i.toString(16).padStart(32, '0');
    const { moves, crosses } = playFast(seed, { gapMs: 200 });
    if (!crosses) continue;
    const last = moves[moves.length - 1];
    assert.ok(last[4] >= 90000, 'the last move came after 90 s');
    assert.ok(Logic.replay(seed, moves).ok);
    return;
  }
  assert.fail('no seed earned a cross');
});
