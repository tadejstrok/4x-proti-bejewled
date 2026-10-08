// Synthesized sound effects plus voice clips from public/ (Web Audio). Exposed as window.Sfx.
(function (global) {
  'use strict';

  var ctx = null, master = null, muted = false;
  var VOLUME = 0.5;
  var VOICE_GAIN = 1.6;

  // Voice clips played at random on bonuses (special tile blasts, combos).
  var VOICE_FILES = [
    'public/drhal.mp3',
    'public/gospodarstvo.mp3',
    'public/janez-laze.mp3',
    'public/logar-2.mp3',
    'public/logar-lazz.mp3',
    'public/moc.mp3',
    'public/mocc.mp3',
    'public/moocc.mp3',
    'public/podstat.mp3',
    'public/prevarantom.mp3',
    'public/soferja.mp3',
    'public/sudan.mp3',
    'public/vrtovc.mp3'
  ];
  var voices = [], voiceBag = [], lastVoice = null, voiceBusyUntil = 0, voicesRequested = false;
  var voicesOn = true, currentVoice = null;
  try {
    muted = localStorage.getItem('4xproti-muted') === '1';
    voicesOn = localStorage.getItem('4xproti-voices') !== '0';
  } catch (e) {}

  function unlock() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      var comp = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOLUME;
      master.connect(comp);
      comp.connect(ctx.destination);
      if (voicesOn) loadVoices();
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  // Decoded into Web Audio buffers so clips can start later from async game code
  // (mobile browsers block HTMLAudio.play() outside a tap handler).
  function loadVoices() {
    if (voicesRequested || !global.fetch) return;
    voicesRequested = true;
    VOICE_FILES.forEach(function (src) {
      fetch(src)
        .then(function (r) { if (!r.ok) throw new Error(src); return r.arrayBuffer(); })
        .then(function (data) { return ctx.decodeAudioData(data); })
        .then(function (buf) { voices.push(buf); })
        .catch(function () {});
    });
  }

  // Random clip without repeats until every clip has played once.
  function nextVoice() {
    if (!voiceBag.length) {
      voiceBag = voices.slice();
      for (var i = voiceBag.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = voiceBag[i]; voiceBag[i] = voiceBag[j]; voiceBag[j] = t;
      }
      if (voiceBag.length > 1 && voiceBag[voiceBag.length - 1] === lastVoice) {
        voiceBag.unshift(voiceBag.pop());
      }
    }
    return voiceBag.pop();
  }

  // Plays a random clip unless one is still playing.
  function voice() {
    if (!ctx || muted || !voicesOn || !voices.length || ctx.currentTime < voiceBusyUntil) return;
    var buf = nextVoice();
    lastVoice = buf;
    var src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    g.gain.value = VOICE_GAIN;
    src.connect(g); g.connect(master);
    src.start();
    currentVoice = src;
    voiceBusyUntil = ctx.currentTime + buf.duration + 0.4;
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!ctx || muted) return;
    var t0 = ctx.currentTime + (delay || 0);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  function noise(dur, vol, cutoff, delay) {
    if (!ctx || muted) return;
    var t0 = ctx.currentTime + (delay || 0);
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff || 1000, t0);
    f.frequency.exponentialRampToValueAtTime(80, t0 + dur);
    g.gain.setValueAtTime(vol || 0.3, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
  }

  function notes(freqs, step, dur, type, vol) {
    freqs.forEach(function (f, i) { tone(f, dur, type, vol, null, i * step); });
  }

  global.Sfx = {
    unlock: unlock,
    voice: voice,
    voicesOn: function () { return voicesOn; },
    // Turns the voice clips on/off; synth effects are unaffected.
    setVoices: function (on) {
      voicesOn = on;
      try { localStorage.setItem('4xproti-voices', on ? '1' : '0'); } catch (e) {}
      if (on && ctx) loadVoices();
      if (!on && currentVoice) {
        try { currentVoice.stop(); } catch (e) {}
        currentVoice = null;
        voiceBusyUntil = 0;
      }
    },
    isMuted: function () { return muted; },
    setMuted: function (m) {
      muted = m;
      try { localStorage.setItem('4xproti-muted', m ? '1' : '0'); } catch (e) {}
      if (master) master.gain.setTargetAtTime(m ? 0 : VOLUME, ctx.currentTime, 0.02);
    },
    select: function () { tone(700, 0.05, 'square', 0.04); },
    swap: function () { tone(520, 0.08, 'square', 0.05, 880); },
    invalid: function () { tone(190, 0.18, 'sawtooth', 0.08, 110); },
    pop: function (combo) {
      var f = 330 * Math.pow(2, Math.min(combo - 1, 12) * 2 / 12);
      tone(f, 0.18, 'triangle', 0.25, f * 1.5);
      tone(f * 2, 0.12, 'sine', 0.08);
    },
    create: function () { notes([660, 831, 988, 1319], 0.045, 0.12, 'square', 0.05); },
    boom: function () {
      tone(150, 0.6, 'sine', 0.55, 35);
      noise(0.5, 0.35, 1200);
    },
    bonus: function () { tone(880, 0.12, 'sine', 0.15, 1760); },
    levelUp: function () { notes([523, 659, 784, 1047], 0.08, 0.22, 'triangle', 0.2); },
    tick: function () { tone(1300, 0.04, 'square', 0.04); },
    shuffle: function () { noise(0.4, 0.12, 3000); },
    gameOver: function () { notes([523, 415, 330, 262], 0.16, 0.35, 'triangle', 0.2); }
  };
})(window);
