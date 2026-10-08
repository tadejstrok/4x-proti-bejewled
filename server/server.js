// Serves the game and the leaderboard API (see LEADERBOARD-API.md) from one process.
// No dependencies: node:http + node:sqlite. Run with `node server/server.js`.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

require('../js/filter.js'); // defines globalThis.TextFilter, same checks as in the browser

const PORT = Number(process.env.PORT) || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'scores.db');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..'));
const STATIC_ALLOW = ['index.html', 'style.css', 'js', 'public']; // never serve server/, .git, the db …

const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 5; // entries per client/IP per hour
const POINTS_PER_SECOND = 1000; // plausibility cap: score <= durationSeconds * this
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
    hidden     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS scores_rank ON scores (hidden, score DESC, created_at);
  CREATE INDEX IF NOT EXISTS scores_recent ON scores (created_at);
`);

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
  insert: db.prepare(`INSERT INTO scores (id, nickname, message, score, level, duration, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`),
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

function rateLimited(keys) {
  const hourAgo = Date.now() - 3600e3;
  const counts = keys.map((k) => (recent.get(k) || []).filter((t) => t > hourAgo));
  if (counts.some((ts) => ts.length >= RATE_LIMIT)) return true;
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

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

async function postScore(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 4096)); } catch (e) {
    return json(res, e.status || 400, { error: 'Neveljavna zahteva.' });
  }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'Neveljavna zahteva.' });

  const check = TextFilter.validate(body.nickname, body.message);
  if (!check.ok) return json(res, 400, { error: check.error });

  const { score, level, durationSeconds } = body;
  if (body.mode !== 'timed' ||
      !isInt(durationSeconds, 1, 3600) ||
      !isInt(level, 1, 1000) ||
      !isInt(score, 1, durationSeconds * POINTS_PER_SECOND)) {
    return json(res, 400, { error: 'Rezultat ni veljaven.' });
  }

  const keys = [rateKey('ip', clientIp(req))];
  if (body.clientId) keys.push(rateKey('client', String(body.clientId).slice(0, 64)));
  if (rateLimited(keys)) {
    return json(res, 429, { error: 'Preveč vpisov. Poskusi znova čez eno uro.' });
  }

  const id = crypto.randomBytes(8).toString('base64url');
  const createdAt = new Date().toISOString();
  q.insert.run(id, check.nickname, check.message, score, level, durationSeconds, createdAt);
  const rank = q.ahead.get(score, score, createdAt, createdAt, id).n + 1;
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
  let body;
  try { body = JSON.parse(await readBody(req, 4096)); } catch (e) {
    return json(res, e.status || 400, { error: 'Neveljavna zahteva.' });
  }
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
