// Run with `node --test server/server.test.js`.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
require('../js/logic.js');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-0123456789';
let proc, dir, secret;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), '4xproti-'));
  proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db'), RATE_LIMIT: '3', ADMIN_TOKEN: TOKEN },
    stdio: 'inherit'
  });
  for (let i = 0; i < 50 && !secret; i++) {
    try {
      await fetch(BASE + '/healthz');
      const db = new DatabaseSync(path.join(dir, 'test.db'));
      secret = Buffer.from(db.prepare(`SELECT value FROM meta WHERE key = 'secret'`).get().value, 'hex');
      db.close();
    } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!secret) throw new Error('server did not start');
});

test.after(() => {
  proc.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
});

function api(pathname, body, ip) {
  return fetch(BASE + '/api' + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-Ip': ip || '1.1.1.1' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const post = (body, ip) => api('/scores', body, ip);

// Signs like the server does, with the secret it stored in the database.
function seal(kind, payload) {
  return payload + '.' + crypto.createHmac('sha256', secret).update(kind + ':' + payload).digest('base64url');
}

// A receipt as /games/finish would issue it, without playing.
function receipt(over) {
  const r = Object.assign({
    game: crypto.randomBytes(9).toString('base64url'), score: 20000, level: 5, seconds: 94, finishedAt: Date.now()
  }, over);
  return seal('receipt', Buffer.from(JSON.stringify(r)).toString('base64url'));
}

// A /scores body; `score` goes into its receipt.
const entry = ({ score, ...over } = {}) => Object.assign({
  receipt: receipt(score === undefined ? {} : { score }),
  nickname: 'Mojca', message: 'Se vidimo v nedeljo!', clientId: 'c-' + Math.random()
}, over);

// Plays the first `count` moves findMove suggests, at the earliest time the rules allow.
function play(seed, count) {
  const rand = Logic.rng(seed);
  const grid = Logic.generateBoard(Logic.SIZE, rand);
  const moves = [];
  let ms = 0, score = 0;
  for (let i = 0; i < count; i++) {
    const [a, b] = Logic.findMove(grid);
    const turn = Logic.playTurn(grid, a, b, rand);
    moves.push([a[0], a[1], b[0], b[1], ms]);
    score += turn.points;
    ms += Math.ceil(Logic.minTurnMs(turn, Logic.levelFor(score)));
  }
  return { moves, score };
}

test('empty leaderboard', async () => {
  const r = await fetch(BASE + '/api/scores?limit=10');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), []);
});

test('submit and rank, ties go to the earlier entry', async () => {
  const a = await post(entry({ score: 5000 }), '10.0.0.1');
  assert.strictEqual(a.status, 201);
  assert.deepStrictEqual([a.body.rank, a.body.total], [1, 1]);

  const b = await post(entry({ score: 9000, nickname: 'Ana' }), '10.0.0.2');
  assert.deepStrictEqual([b.body.rank, b.body.total], [1, 2]);

  const c = await post(entry({ score: 5000, nickname: 'Bor' }), '10.0.0.3');
  assert.deepStrictEqual([c.body.rank, c.body.total], [3, 3]);

  const rows = await (await fetch(BASE + '/api/scores?limit=10')).json();
  assert.deepStrictEqual(rows.map((r) => r.id), [b.body.id, a.body.id, c.body.id]);
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['createdAt', 'id', 'message', 'nickname', 'score']);
});

test('offset pages through the ranking', async () => {
  const all = await (await fetch(BASE + '/api/scores?limit=10')).json();
  const page = await (await fetch(BASE + '/api/scores?limit=2&offset=1')).json();
  assert.deepStrictEqual(page.map((r) => r.id), all.slice(1, 3).map((r) => r.id));
});

test('rejects bad text with the filter message', async () => {
  const r = await post(entry({ nickname: 'kur4c' }), '10.0.1.1');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'Vzdevek vsebuje neprimerne besede.');
  const l = await post(entry({ message: 'glej www.example.com' }), '10.0.1.2');
  assert.strictEqual(l.body.error, 'Povezave v sporočilu niso dovoljene.');
});

test('plays, finishes and submits a verified game', async () => {
  const start = await api('/games', {}, '10.0.7.1');
  assert.strictEqual(start.status, 201);
  assert.match(start.body.seed, /^[0-9a-f]{32}$/);

  const { moves, score } = play(start.body.seed, 3);
  assert.ok(moves[2][4] < 2000, 'fits in the clock slack, so the test needs no waiting');
  const fin = await api('/games/finish', { token: start.body.token, moves, score }, '10.0.7.1');
  assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));
  assert.strictEqual(fin.body.score, score);
  assert.strictEqual(fin.body.level, Logic.levelFor(score));

  const sub = await post({ receipt: fin.body.receipt, nickname: 'Igralka', message: '', clientId: 'c-play' }, '10.0.7.1');
  assert.strictEqual(sub.status, 201);
  const rows = (await (await fetch(BASE + '/api/scores?limit=100')).json());
  assert.strictEqual(rows.find((r) => r.id === sub.body.id).score, score);

  const again = await post({ receipt: fin.body.receipt, nickname: 'Spet', message: '', clientId: 'c-play2' }, '10.0.7.2');
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.error, 'Ta igra je že vpisana.');
});

test('finish rejects games that were not played by the rules', async () => {
  const { body: { token, seed } } = await api('/games', {}, '10.0.8.1');
  const { moves } = play(seed, 3);
  const cases = [
    [{ token: token + 'x', moves }, 'Igra ni veljavna.'],
    [{ token: seal('game', 'abc.' + Date.now()).replace(/.$/, 'A'), moves }, 'Igra ni veljavna.'],
    [{ token, moves: [[0, 0, 2, 0, 0]] }, 'Igra ni veljavna.'],
    [{ token, moves: moves.map((m) => [...m.slice(0, 4), 0]) }, 'Igra ni veljavna.'], // faster than the animations
    [{ token, moves: [[...moves[0].slice(0, 4), 60000]] }, 'Igra ni veljavna.'], // later than the real clock
    [{ token, moves: 'nope' }, 'Igra ni veljavna.']
  ];
  for (const [body, error] of cases) {
    const r = await api('/games/finish', body, '10.0.8.1');
    assert.deepStrictEqual([r.status, r.body.error], [400, error], JSON.stringify(body).slice(0, 120));
  }

  // Started long enough ago that even a 90 s game plus the slack is over.
  const id = 'old-game';
  const old = seal('game', id + '.' + (Date.now() - 300e3));
  const seedForOld = crypto.createHmac('sha256', secret).update('seed:' + id).digest('hex').slice(0, 32);
  const late = await api('/games/finish', { token: old, moves: play(seedForOld, 1).moves }, '10.0.8.1');
  assert.deepStrictEqual([late.status, late.body.error], [400, 'Igra je trajala predolgo za vpis na lestvico.']);
});

test('rejects forged, expired and empty receipts', async () => {
  const forged = receipt().replace(/\.[^.]+$/, '.' + crypto.randomBytes(32).toString('base64url'));
  const cases = [
    [{ receipt: 'nope' }, 'Rezultat ni veljaven.'],
    [{ receipt: forged }, 'Rezultat ni veljaven.'],
    [{ receipt: undefined }, 'Rezultat ni veljaven.'],
    [{ receipt: receipt({ score: 0 }) }, 'Rezultat ni veljaven.'],
    [{ receipt: receipt({ finishedAt: Date.now() - 25 * 3600e3 }) }, 'Vpis je potekel. Odigraj novo igro.']
  ];
  for (const [over, error] of cases) {
    const r = await post(Object.assign(entry(), over), '10.0.2.1');
    assert.deepStrictEqual([r.status, r.body.error], [400, error]);
  }
  // Raising the score breaks the signature.
  const [payload, sig] = receipt({ score: 100 }).split('.');
  const raised = JSON.parse(Buffer.from(payload, 'base64url'));
  raised.score = 999999;
  const r = await post(entry({ receipt: Buffer.from(JSON.stringify(raised)).toString('base64url') + '.' + sig }), '10.0.2.1');
  assert.strictEqual(r.status, 400);
});

test('rate limits games started per IP', async () => {
  let status;
  for (let i = 0; i < 201 && status !== 429; i++) status = (await api('/games', {}, '10.0.9.1')).status;
  assert.strictEqual(status, 429);
  assert.strictEqual((await api('/games', {}, '10.0.9.2')).status, 201);
});

test('rejects malformed JSON', async () => {
  for (const p of ['/scores', '/games/finish']) {
    const r = await fetch(BASE + '/api' + p, { method: 'POST', body: '{nope' });
    assert.strictEqual(r.status, 400, p);
  }
});

test('rate limits per IP and per clientId', async () => {
  for (let i = 0; i < 3; i++) assert.strictEqual((await post(entry(), '10.0.3.1')).status, 201);
  assert.strictEqual((await post(entry(), '10.0.3.1')).status, 429);

  for (let i = 0; i < 3; i++) assert.strictEqual((await post(entry({ clientId: 'same' }), '10.0.4.' + i)).status, 201);
  assert.strictEqual((await post(entry({ clientId: 'same' }), '10.0.4.9')).status, 429);
});

test('serves the game but nothing outside the allowlist', async () => {
  assert.strictEqual((await fetch(BASE + '/')).status, 200);
  assert.strictEqual((await fetch(BASE + '/js/main.js')).status, 200);
  assert.strictEqual((await fetch(BASE + '/public/4xproti.png')).headers.get('content-type'), 'image/png');
  for (const p of ['/server/server.js', '/.git/config', '/%2e%2e/etc/passwd', '/README.md']) {
    assert.strictEqual((await fetch(BASE + p)).status, 404, p);
  }
});

function admin(pathname, opts, token) {
  return fetch(BASE + '/api/admin' + pathname, Object.assign({}, opts, {
    headers: { Authorization: 'Bearer ' + (token === undefined ? TOKEN : token), 'Content-Type': 'application/json' }
  })).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('admin needs the token', async () => {
  assert.strictEqual((await admin('/scores', {}, '')).status, 401);
  assert.strictEqual((await admin('/scores', {}, 'test-token-0123456780')).status, 401);
  assert.strictEqual((await fetch(BASE + '/admin')).status, 200);
});

test('admin edits, hides and restores an entry', async () => {
  const { body: created } = await post(entry({ nickname: 'Original', score: 99999 }), '10.0.5.1');

  const list = await admin('/scores?q=Original');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 1);
  assert.ok(!('ip' in list.body[0]));

  const edit = await admin('/scores/' + created.id, { method: 'PATCH', body: JSON.stringify({ nickname: '  Popravljeno ', message: '' }) });
  assert.deepStrictEqual(edit.body, { id: created.id, nickname: 'Popravljeno', message: '', hidden: 0 });
  let top = await (await fetch(BASE + '/api/scores?limit=1')).json();
  assert.strictEqual(top[0].nickname, 'Popravljeno');

  await admin('/scores/' + created.id, { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
  top = await (await fetch(BASE + '/api/scores?limit=100')).json();
  assert.ok(!top.some((r) => r.id === created.id));
  assert.strictEqual((await admin('/scores?q=Popravljeno')).body[0].hidden, 1);

  await admin('/scores/' + created.id, { method: 'PATCH', body: JSON.stringify({ hidden: false }) });
  top = await (await fetch(BASE + '/api/scores?limit=1')).json();
  assert.strictEqual(top[0].id, created.id);
});

test('admin edits go through the filter; unknown ids 404', async () => {
  const { body: created } = await post(entry({ nickname: 'Nekdo' }), '10.0.6.1');
  const bad = await admin('/scores/' + created.id, { method: 'PATCH', body: JSON.stringify({ nickname: 'fuck' }) });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await admin('/scores/nope', { method: 'PATCH', body: '{}' })).status, 404);
});

test('admin sort=top orders by score', async () => {
  const rows = (await admin('/scores?sort=top')).body;
  const scores = rows.map((r) => r.score);
  assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a));
});
