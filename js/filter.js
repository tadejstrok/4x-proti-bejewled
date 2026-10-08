// Nickname/message validation with a simple profanity filter. Exposed as window.TextFilter.
// The server must repeat these checks; this only gives players instant feedback.
(function (global) {
  'use strict';

  // Blocked when found anywhere in the text (also with spaces/dots between letters).
  var ANYWHERE = [
    'kurac', 'kurc', 'pizd', 'picka', 'jeba', 'jebe', 'jebi', 'jebo', 'jebat', 'fuk',
    'kurb', 'prasic', 'peder', 'buzer', 'drkat', 'drkal', 'sranj', 'usran', 'posran',
    'debil', 'kreten', 'retard', 'idiot', 'cigan', 'cefur', 'gnida', 'pedof', 'nacist',
    'fuck', 'shit', 'bitch', 'cunt', 'whore', 'slut', 'hitler'
  ];
  // Blocked only as whole words (short words that also appear inside normal words).
  var WORDS = [
    'rit', 'riti', 'drek', 'jeb', 'fak', 'prdec', 'bedak', 'tepec', 'kozel',
    'nazi', 'heil', 'ass', 'dick', 'cock', 'fag', 'niga', 'niger'
  ];

  var LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

  function normalize(text) {
    return String(text)
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[013457@$!]/g, function (ch) { return LEET[ch]; })
      .replace(/(.)\1+/g, '$1');
  }

  var anywhere = ANYWHERE.map(normalize);
  var words = {};
  WORDS.forEach(function (w) { words[normalize(w)] = true; });

  function isOffensive(text) {
    var n = normalize(text);
    var compact = n.replace(/[^a-z]/g, '');
    if (anywhere.some(function (w) { return compact.indexOf(w) !== -1; })) return true;
    return n.split(/[^a-z]+/).some(function (w) { return words[w]; });
  }

  function clean(text) {
    return String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  var NICK_MAX = 20, MSG_MAX = 100;
  var NICK_RE = /^[\p{L}\p{N} ._\-]+$/u;
  var LINK_RE = /https?:|www\.|\.(com|si|net|org|eu|io)\b/i;

  // Returns { ok: true, nickname, message } or { ok: false, field, error }.
  function validate(nickname, message) {
    nickname = clean(nickname);
    message = clean(message);
    if (!nickname) return { ok: false, field: 'nickname', error: 'Vpiši vzdevek.' };
    if (nickname.length > NICK_MAX) return { ok: false, field: 'nickname', error: 'Vzdevek je lahko dolg največ ' + NICK_MAX + ' znakov.' };
    if (!NICK_RE.test(nickname)) return { ok: false, field: 'nickname', error: 'Vzdevek lahko vsebuje le črke, številke, presledek, piko, podčrtaj in vezaj.' };
    if (isOffensive(nickname)) return { ok: false, field: 'nickname', error: 'Vzdevek vsebuje neprimerne besede.' };
    if (message.length > MSG_MAX) return { ok: false, field: 'message', error: 'Sporočilo je lahko dolgo največ ' + MSG_MAX + ' znakov.' };
    if (LINK_RE.test(message)) return { ok: false, field: 'message', error: 'Povezave v sporočilu niso dovoljene.' };
    if (isOffensive(message)) return { ok: false, field: 'message', error: 'Sporočilo vsebuje neprimerne besede.' };
    return { ok: true, nickname: nickname, message: message };
  }

  global.TextFilter = {
    NICK_MAX: NICK_MAX,
    MSG_MAX: MSG_MAX,
    isOffensive: isOffensive,
    validate: validate
  };
})(typeof window !== 'undefined' ? window : globalThis);
