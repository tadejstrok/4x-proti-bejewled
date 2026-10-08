// Serves the game and the leaderboard API (see LEADERBOARD-API.md) from one process.
// No dependencies: node:http + node:sqlite. Run with `node server/server.js`.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

require('../js/filter.js'); // defines globalThis.TextFilter, same checks as in the browser
require('../js/logic.js'); // defines globalThis.Logic, used to replay games and check their scores

const PORT = Number(process.env.PORT) || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'scores.db');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..'));
const STATIC_ALLOW = ['index.html', 'style.css', 'js', 'public']; // never serve server/, .git, the db …

const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 5; // entries per client/IP per hour
const GAME_RATE_LIMIT = 200; // games started per IP per hour
// A game must be finished within its time limit plus this much (tab switches pause the
// game clock, so leave room). It bounds how long anyone can study a board offline.
const GAME_SLACK_MS = 120e3;
const CLOCK_SLACK_MS = 2000; // client game clock vs server clock
const RECEIPT_TTL_MS = 24 * 3600e3; // a finished game can go on the leaderboard for this long
// Moderation page at /admin#<token>. Unset or short token disables it.
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').length >= 16 ? process.env.ADMIN_TOKEN : '';

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS scores (
    id         TEXT PRIMARY KEY,
    nickname   TEXT NOT NULL,
    message    TEXT NOT NULL,
    score      INTEGER NOT NULL,
    level      INTEGER NOT NULL,
    duration   INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    hidden     INTEGER NOT NULL DEFAULT 0,
    game_id    TEXT
  );
  CREATE INDEX IF NOT EXISTS scores_rank ON scores (hidden, score DESC, created_at);
  CREATE INDEX IF NOT EXISTS scores_recent ON scores (created_at);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Entries from before verified games have no game_id. Each game goes on the board only once.
if (!db.prepare(`SELECT 1 FROM pragma_table_info('scores') WHERE name = 'game_id'`).get()) {
  db.exec(`ALTER TABLE scores ADD COLUMN game_id TEXT`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS scores_game ON scores (game_id)`);

// Signs game tokens and receipts. Kept in the database so a restart doesn't void games in progress.
db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('secret', ?)`).run(crypto.randomBytes(32).toString('hex'));
const SECRET = Buffer.from(db.prepare(`SELECT value FROM meta WHERE key = 'secret'`).get().value, 'hex');

// Older databases stored the IP and clientId with each entry. Drop them and rewrite the
// file so they don't linger in free pages.
const legacy = db.prepare(`SELECT name FROM pragma_table_info('scores') WHERE name IN ('ip', 'client_id')`).all();
if (legacy.length) {
  for (const { name } of legacy) db.exec(`ALTER TABLE scores DROP COLUMN ${name}`);
  db.exec('VACUUM');
  console.log('removed stored IPs and client ids');
}

const q = {
  top: db.prepare(`SELECT id, nickname, message, score, created_at AS createdAt FROM scores
                   WHERE hidden = 0 ORDER BY score DESC, created_at, id LIMIT ? OFFSET ?`),
  insert: db.prepare(`INSERT INTO scores (id, nickname, message, score, level, duration, created_at, game_id)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  hasGame: db.prepare(`SELECT 1 FROM scores WHERE game_id = ?`),
  ahead: db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE hidden = 0
                     AND (score > ? OR (score = ? AND (created_at < ? OR (created_at = ? AND id < ?))))`),
  total: db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE hidden = 0`),
  adminList: db.prepare(`SELECT id, nickname, message, score, level, duration AS durationSeconds,
                         created_at AS createdAt, hidden FROM scores
                         WHERE ?1 = '' OR nickname LIKE '%' || ?1 || '%' OR message LIKE '%' || ?1 || '%'
                         ORDER BY CASE WHEN ?2 = 'top' THEN -score END, created_at DESC LIMIT 500`),
  adminGet: db.prepare(`SELECT id, nickname, message, hidden FROM scores WHERE id = ?`),
  adminUpdate: db.prepare(`UPDATE scores SET nickname = ?, message = ?, hidden = ? WHERE id = ?`)
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function clientIp(req) {
  // Traefik sets X-Real-Ip to the address it saw the request come from.
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
}

// Rate limiting lives only in memory: salted hashes of the IP and clientId, kept for an
// hour. Nothing identifying a player is written to the database or the logs.
const RATE_SALT = crypto.randomBytes(16);
const recent = new Map(); // hashed key -> submission timestamps within the last hour

function rateKey(kind, value) {
  return crypto.createHmac('sha256', RATE_SALT).update(kind + ':' + value).digest('base64url');
}

function rateLimited(keys, limit) {
  const hourAgo = Date.now() - 3600e3;
  const counts = keys.map((k) => (recent.get(k) || []).filter((t) => t > hourAgo));
  if (counts.some((ts) => ts.length >= limit)) return true;
  keys.forEach((k, i) => recent.set(k, counts[i].concat(Date.now())));
  return false;
}

setInterval(() => {
  const hourAgo = Date.now() - 3600e3;
  for (const [k, ts] of recent) {
    const keep = ts.filter((t) => t > hourAgo);
    if (keep.length) recent.set(k, keep); else recent.delete(k);
  }
}, 600e3).unref();

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, max) {
  let body;
  try { body = JSON.parse(await readBody(req, max)); } catch (e) {
    throw Object.assign(new Error('bad request'), { status: e.status || 400 });
  }
  if (!body || typeof body !== 'object') throw Object.assign(new Error('bad request'), { status: 400 });
  return body;
}

// ---------- Verified games ----------
// A timed game starts with a signed token that carries its id and start time; the board's
// seed is derived from the id. When the game ends, the client sends back its moves, the
// server replays them with js/logic.js and signs a receipt with the score it got. Only
// receipts go on the leaderboard, each game once. Nothing is stored until then.

function sign(kind, payload) {
  return crypto.createHmac('sha256', SECRET).update(kind + ':' + payload).digest('base64url');
}

function seal(kind, payload) {
  return payload + '.' + sign(kind, payload);
}

// Returns the payload of a sealed string, or null if it wasn't signed by us for this kind.
function unseal(kind, sealed) {
  if (typeof sealed !== 'string' || sealed.length > 1000) return null;
  const i = sealed.lastIndexOf('.');
  if (i < 0) return null;
  const payload = sealed.slice(0, i);
  const given = Buffer.from(sealed.slice(i + 1)), want = Buffer.from(sign(kind, payload));
  return given.length === want.length && crypto.timingSafeEqual(given, want) ? payload : null;
}

function seedFor(gameId) {
  return crypto.createHmac('sha256', SECRET).update('seed:' + gameId).digest('hex').slice(0, 32);
}

function startGame(req, res) {
  if (rateLimited([rateKey('games', clientIp(req))], GAME_RATE_LIMIT)) {
    return json(res, 429, { error: 'Preveč iger. Poskusi znova čez eno uro.' });
  }
  const id = crypto.randomBytes(9).toString('base64url');
  json(res, 201, { token: seal('game', id + '.' + Date.now()), seed: seedFor(id) });
}

// body: { token, moves: [[r1, c1, r2, c2, ms], ...], score? }. `score` is what the
// player saw; it is only compared with the replay to catch bugs, never trusted.
async function finishGame(req, res) {
  const body = await readJson(req, 64 * 1024);
  const game = unseal('game', body.token);
  if (!game) return json(res, 400, { error: 'Igra ni veljavna.' });
  const [id, startedAt] = game.split('.');
  const wallMs = Date.now() - Number(startedAt);

  const result = Logic.replay(seedFor(id), body.moves);
  let reason = !result.ok ? result.reason
    : result.lastMoveMs > wallMs + CLOCK_SLACK_MS ? 'moves are later than the clock'
    : wallMs > result.seconds * 1000 + GAME_SLACK_MS ? 'finished too late'
    : '';
  if (reason) {
    console.log(`game ${id} rejected: ${reason}`);
    return json(res, 400, {
      error: reason === 'finished too late' ? 'Igra je trajala predolgo za vpis na lestvico.' : 'Igra ni veljavna.'
    });
  }
  if (Number.isInteger(body.score) && body.score !== result.score) {
    console.log(`game ${id}: client score ${body.score}, replay ${result.score}`);
  }
  const receipt = seal('receipt', Buffer.from(JSON.stringify({
    game: id, score: result.score, level: result.level, seconds: result.seconds, finishedAt: Date.now()
  })).toString('base64url'));
  json(res, 200, { receipt, score: result.score, level: result.level });
}

// body: { receipt, nickname, message, clientId }
async function postScore(req, res) {
  const body = await readJson(req, 4096);
  const sealed = unseal('receipt', body.receipt);
  const played = sealed && JSON.parse(Buffer.from(sealed, 'base64url').toString('utf8'));
  if (!played || played.score < 1) return json(res, 400, { error: 'Rezultat ni veljaven.' });
  if (Date.now() - played.finishedAt > RECEIPT_TTL_MS) {
    return json(res, 400, { error: 'Vpis je potekel. Odigraj novo igro.' });
  }
  if (q.hasGame.get(played.game)) return json(res, 409, { error: 'Ta igra je že vpisana.' });

  const check = TextFilter.validate(body.nickname, body.message);
  if (!check.ok) return json(res, 400, { error: check.error });

  const keys = [rateKey('ip', clientIp(req))];
  if (body.clientId) keys.push(rateKey('client', String(body.clientId).slice(0, 64)));
  if (rateLimited(keys, RATE_LIMIT)) {
    return json(res, 429, { error: 'Preveč vpisov. Poskusi znova čez eno uro.' });
  }

  const id = crypto.randomBytes(8).toString('base64url');
  const createdAt = new Date().toISOString();
  q.insert.run(id, check.nickname, check.message, played.score, played.level, played.seconds, createdAt, played.game);
  const rank = q.ahead.get(played.score, played.score, createdAt, createdAt, id).n + 1;
  json(res, 201, { id, rank, total: q.total.get().n });
}

function getScores(url, res) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 10, 1), 100);
  const offset = Math.min(Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0), 1e6);
  json(res, 200, q.top.all(limit, offset));
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function adminList(url, res) {
  const search = String(url.searchParams.get('q') || '').slice(0, 50);
  json(res, 200, q.adminList.all(search, url.searchParams.get('sort') === 'top' ? 'top' : 'recent'));
}

// body: { nickname?, message?, hidden? }. Edited text goes through the same filter as players' input.
async function adminUpdate(id, req, res) {
  const body = await readJson(req, 4096);
  const row = q.adminGet.get(id);
  if (!row) return json(res, 404, { error: 'Vpis ne obstaja.' });
  const check = TextFilter.validate(
    body.nickname !== undefined ? body.nickname : row.nickname,
    body.message !== undefined ? body.message : row.message
  );
  if (!check.ok) return json(res, 400, { error: check.error });
  const hidden = body.hidden !== undefined ? (body.hidden ? 1 : 0) : row.hidden;
  q.adminUpdate.run(check.nickname, check.message, hidden, id);
  console.log(`admin: updated ${id}`, JSON.stringify({ from: row, to: { nickname: check.nickname, message: check.message, hidden } }));
  json(res, 200, q.adminGet.get(id));
}

function serveAdminPage(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer'
  });
  fs.createReadStream(path.join(__dirname, 'admin.html')).pipe(res);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.mp3': 'audio/mpeg'
};

function serveStatic(url, req, res) {
  let rel;
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'; } catch (e) { rel = ''; }
  const file = path.join(STATIC_DIR, rel);
  const top = path.relative(STATIC_DIR, file).split(path.sep)[0];
  let stat;
  if (file.startsWith(STATIC_DIR + path.sep) && STATIC_ALLOW.includes(top)) {
    try { stat = fs.statSync(file); } catch (e) {}
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const etag = '"' + stat.size.toString(36) + '-' + stat.mtimeMs.toString(36) + '"';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    ETag: etag
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/api/scores') {
      if (req.method === 'GET') return getScores(url, res);
      if (req.method === 'POST') return await postScore(req, res);
      return json(res, 405, { error: 'Method not allowed' });
    }
    if (url.pathname === '/api/games' || url.pathname === '/api/games/finish') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      return url.pathname === '/api/games' ? startGame(req, res) : await finishGame(req, res);
    }
    if (url.pathname === '/admin' && ADMIN_TOKEN) return serveAdminPage(res);
    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'Napačen ali manjkajoč žeton.' });
      if (url.pathname === '/api/admin/scores' && req.method === 'GET') return adminList(url, res);
      const m = url.pathname.match(/^\/api\/admin\/scores\/([\w-]+)$/);
      if (m && req.method === 'PATCH') return await adminUpdate(m[1], req, res);
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url, req, res);
    json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err.status) return json(res, err.status, { error: 'Neveljavna zahteva.' });
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Napaka na strežniku. Poskusi znova.' });
  }
});

server.listen(PORT, () => console.log(`4X PROTI on :${PORT}, db ${DB_PATH}`));

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
