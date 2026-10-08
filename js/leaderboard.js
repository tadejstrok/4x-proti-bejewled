// Leaderboard data layer. Exposed as window.Leaderboard.
// API contract for the backend: see LEADERBOARD-API.md.
(function (global) {
  'use strict';

  // Backend base URL. The API is served by server/server.js next to the game, so a
  // relative path is enough. Empty means local test mode (entries stay in this browser),
  // which is used when index.html is opened straight from disk.
  var API_URL = /^https?:$/.test(location.protocol) ? 'api' : '';

  var LOCAL_KEY = '4xproti-local-leaderboard';

  function clientId() {
    try {
      var id = localStorage.getItem('4xproti-client-id');
      if (!id) {
        id = global.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
        localStorage.setItem('4xproti-client-id', id);
      }
      return id;
    } catch (e) {
      return 'anon';
    }
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch (e) { return []; }
  }
  function writeLocal(list) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function byScore(a, b) {
    return b.score - a.score || (a.createdAt < b.createdAt ? -1 : 1);
  }

  async function request(path, options) {
    var res = await fetch(API_URL.replace(/\/$/, '') + path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, options));
    var body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((body && body.error) || 'HTTP ' + res.status);
      err.status = res.status;
      err.serverMessage = body && body.error;
      throw err;
    }
    return body;
  }

  // Returns [{ id, nickname, message, score, createdAt }] sorted best first.
  async function top(limit) {
    limit = limit || 10;
    if (!API_URL) return readLocal().sort(byScore).slice(0, limit);
    return request('/scores?limit=' + limit);
  }

  // entry: { nickname, message, score, level, durationSeconds }
  // Returns { id, rank, total }.
  async function submit(entry) {
    if (!API_URL) {
      var list = readLocal();
      var row = {
        id: Date.now().toString(36),
        nickname: entry.nickname,
        message: entry.message,
        score: entry.score,
        createdAt: new Date().toISOString()
      };
      list.push(row);
      list.sort(byScore);
      writeLocal(list.slice(0, 100));
      return { id: row.id, rank: list.indexOf(row) + 1, total: list.length };
    }
    return request('/scores', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ mode: 'timed', clientId: clientId() }, entry))
    });
  }

  global.Leaderboard = {
    isLocal: function () { return !API_URL; },
    top: top,
    submit: submit
  };
})(window);
