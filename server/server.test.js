// Run with `node --test server/server.test.js`.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-0123456789';
let proc, dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), '4xproti-'));
  proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db'), RATE_LIMIT: '3', ADMIN_TOKEN: TOKEN },
    stdio: 'inherit'
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/healthz'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

test.after(() => {
  proc.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
});

function post(body, ip) {
  return fetch(BASE + '/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-Ip': ip || '1.1.1.1' },
    body: JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const entry = (over) => Object.assign({
  nickname: 'Mojca', message: 'Se vidimo v nedeljo!', score: 20000, level: 5,
  durationSeconds: 104, mode: 'timed', clientId: 'c-' + Math.random()
}, over);

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

test('rejects bad text with the filter message', async () => {
  const r = await post(entry({ nickname: 'kur4c' }), '10.0.1.1');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'Vzdevek vsebuje neprimerne besede.');
  const l = await post(entry({ message: 'glej www.example.com' }), '10.0.1.2');
  assert.strictEqual(l.body.error, 'Povezave v sporočilu niso dovoljene.');
});

test('rejects implausible scores', async () => {
  for (const over of [{ score: -5 }, { score: 1.5 }, { score: 200000, durationSeconds: 100 }, { mode: 'zen' }, { durationSeconds: '90' }]) {
    const r = await post(entry(over), '10.0.2.1');
    assert.strictEqual(r.status, 400, JSON.stringify(over));
  }
});

test('rejects malformed JSON', async () => {
  const r = await fetch(BASE + '/api/scores', { method: 'POST', body: '{nope' });
  assert.strictEqual(r.status, 400);
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
