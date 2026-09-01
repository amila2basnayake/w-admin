/* AI Water Advisor — speech engine shared by every chat surface (the client AI Advisor tab, the
 * broker Client Rail, the AI Trainer). One file, three hosts: each page creates an instance bound to
 * its own composer and sidecar routes, so dictation, read-aloud and hands-free voice mode behave
 * identically everywhere and a fix lands everywhere.
 *
 *   var V = WFVoice.create({
 *     base, ttsPath, readerPath, token(), ensureToken(), refreshToken(),   // sidecar + auth (the host's own token flow)
 *     textarea, micButton, voiceButton,                 // composer elements (voiceButton optional)
 *     toast(msg), autoResize(),                         // host UI helpers
 *     send(), isBusy(), lastAssistant()                 // host chat state (voice mode drives these)
 *   });
 *   V.setReader(me.reader);                             // 'retell' (phone voice via a web call) | 'openai'
 *
 * Dictation (live speech-to-text): tap the mic; the microphone is captured as 24 kHz PCM and
 * streamed over a websocket (<base>/transcribe/stream) to the sidecar, which relays it to the
 * realtime transcription service (voice activity detection runs server-side). Words arrive per
 * utterance, about half a second after each pause, and are written straight into the composer —
 * nothing waits for a "stop". Tap again, press Enter/Send, or Escape to finish; finishing first
 * flushes the utterance in flight so the last words are never lost. While listening the mic
 * button is a live level meter.
 *
 * Read-aloud (text-to-speech): a per-message Listen button POSTs the reply's markdown to
 * <base><ttsPath> and plays the audio; a dictated message gets its reply spoken back
 * automatically (spoken in -> spoken out); and the optional voice-mode toggle speaks every reply
 * as it streams, then listens again with auto-send — a hands-free conversation.
 *
 * Plain DOM JS, no build step (matches the other seam pages). Both capabilities stay hidden until
 * the host calls enableMic() / enableVoice() after its /me reports transcribe / tts.
 */
(function () {
  'use strict';

  var DICT_IDLE_STOP_MS = 20000;            // manual dictation stops itself after this long with no speech
  var DICT_FLUSH_WAIT_MS = 2500;            // finishing: wait this long for the last utterance's words
  var DICT_AUTOSEND_QUIET_MS = 500;         // voice mode: send this long after an utterance completes
  var VOICE_NO_SPEECH_MS = 8000;            // hands-free: give up listening if the caller never speaks
  var DICT_FRAME = 2400;                    // samples per frame at 24 kHz (100 ms)
  var DICT_WORKLET = "class P extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0;}"
    + "process(i){var c=i[0]&&i[0][0];if(!c)return true;this.b.push(new Float32Array(c));this.n+=c.length;"
    + "if(this.n>=" + DICT_FRAME + "){var o=new Float32Array(this.n),p=0;for(var k=0;k<this.b.length;k++){o.set(this.b[k],p);p+=this.b[k].length;}"
    + "this.b=[];this.n=0;this.port.postMessage(o,[o.buffer]);}return true;}}registerProcessor('wfai-pcm',P);";
  var WAVE_SVG = '<svg class="wfai-wave" viewBox="0 0 21 16" width="19" height="15" aria-hidden="true" fill="currentColor">' +
    '<rect x="0" y="5" width="2.6" height="6" rx="1.3"/><rect x="4.6" y="2.5" width="2.6" height="11" rx="1.3"/>' +
    '<rect x="9.2" y="0" width="2.6" height="16" rx="1.3"/><rect x="13.8" y="2.5" width="2.6" height="11" rx="1.3"/>' +
    '<rect x="18.4" y="5" width="2.6" height="6" rx="1.3"/></svg>';

  function micSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket
      && (window.AudioContext || window.webkitAudioContext));
  }
  function wsUrl(base) {
    var b = base || '';
    if (!/^https?:/i.test(b)) b = location.protocol + '//' + location.host + (b.charAt(0) === '/' || !b ? '' : '/') + b;
    return b.replace(/^http/i, 'ws') + '/transcribe/stream';
  }
  // Float32 (any rate) -> Int16 24 kHz; linear resample when the context could not run at 24 kHz.
  function toPcm16(f32, rate) {
    var n = f32.length, out, i;
    if (rate !== 24000) {
      var ratio = rate / 24000, m = Math.floor(n / ratio), r = new Float32Array(m);
      for (i = 0; i < m; i++) { var p = i * ratio, j = Math.floor(p), t = p - j; r[i] = f32[j] + (f32[Math.min(j + 1, n - 1)] - f32[j]) * t; }
      f32 = r; n = m;
    }
    out = new Int16Array(n);
    for (i = 0; i < n; i++) { var v = Math.max(-1, Math.min(1, f32[i])); out[i] = v < 0 ? v * 32768 : v * 32767; }
    return out;
  }
  function rmsOf(f32) { var s = 0; for (var i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / (f32.length || 1)); }

  // Find a safe cut AFTER a sentence end (or paragraph break) at/past `min` chars. Never cuts
  // inside a ``` fence or a pipe-table row, so each chunk is well-formed for the server's stripper.
  function cutPoint(buf, min) {
    if (((buf.match(/```/g) || []).length) % 2 === 1) return -1;
    var best = -1, m;
    var re = /[.!?][)"']*\s/g;
    while ((m = re.exec(buf))) {
      var idx = m.index + m[0].length;
      if (idx >= min) { best = idx; break; }
    }
    var para = buf.indexOf('\n\n');
    if (para >= min - 2 && (best === -1 || para + 2 < best)) best = para + 2;
    if (best === -1) return -1;
    var lineStart = buf.lastIndexOf('\n', best - 1) + 1;
    if (/^\s*\|/.test(buf.slice(lineStart, best))) return -1; // mid-table — wait for the break after it
    return best;
  }
  function splitWhole(text) {
    var chunks = [], buf = String(text || '');
    for (;;) {
      var cut = cutPoint(buf, 300);
      if (cut <= 0) break;
      chunks.push(buf.slice(0, cut)); buf = buf.slice(cut);
    }
    if (buf.trim()) chunks.push(buf);
    return chunks;
  }

  function create(o) {
    var elText = o.textarea, elMic = o.micButton, elVoice = o.voiceButton || null;
    var toast = o.toast || function () {};
    var autoResize = o.autoResize || function () {};
    var isBusy = o.isBusy || function () { return false; };
    var lastAssistant = o.lastAssistant || function () { return null; };
    var ensureToken = o.ensureToken || function () { return Promise.resolve(); };
    var BASE = (o.base || '').replace(/\/$/, '');
    var TTS_PATH = o.ttsPath || '/tts';

    // ---- dictation -------------------------------------------------------------
    var dict = { s: null,                   // the active session (see dictStart) or null
                 contributed: false };      // dictated words are in the composer -> the reply is spoken back
    function dictActive() { return !!(dict.s && !dict.s.finishing); }
    function dictBusy() { return !!dict.s; } // active OR finishing (flushing its last words)

    // Mic button states: idle | connecting | listening | finishing (meter = 4 bars driven by the live level).
    function micSetState(st) {
      if (!elMic) return;
      elMic.className = 'wfai-mic' + (st !== 'idle' ? ' ' + st : '');
      elMic.setAttribute('aria-pressed', st === 'idle' ? 'false' : 'true');
      elMic.title = st === 'idle' ? 'Dictate' : 'Stop';
      if (st === 'idle') elMic.innerHTML = '<i class="fa fa-microphone"></i>';
      else if (!elMic.querySelector('.wfai-meter')) elMic.innerHTML = '<span class="wfai-meter"><i></i><i></i><i></i><i></i></span>';
    }
    function micMeterTick(s) {
      if (dict.s !== s || !s.bars) return;
      // ease toward the latest frame level, then decay — smooth at 60 fps from a 10 fps signal
      s.shown += (s.level - s.shown) * 0.35; s.level *= 0.9;
      var k = [0.55, 1, 0.8, 0.45], base = s.finishing ? 2 : 3;
      for (var i = 0; i < s.bars.length; i++) s.bars[i].style.height = Math.round(base + Math.min(1, s.shown * 9) * k[i] * 15) + 'px';
      s.raf = requestAnimationFrame(function () { micMeterTick(s); });
    }

    // Composer text = what was there when dictation started + the utterances, in order. Deltas grow
    // an utterance live; its `final` replaces the live text. Typing mid-dictation re-anchors to the edit.
    function dictRender(s) {
      var parts = [];
      for (var i = 0; i < s.items.length; i++) if (s.items[i].text) parts.push(s.items[i].text.trim());
      if (parts.length) dict.contributed = true;
      s.rendering = true;
      elText.value = s.base + parts.join(' ');
      // A programmatic value set fires no `input`; hosts that save a draft on input (the rail,
      // across CRM postbacks) need to hear this one. Our own listener ignores it (s.rendering).
      try { elText.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      s.rendering = false;
      autoResize(); elText.scrollTop = elText.scrollHeight;
    }
    function dictItem(s, id) {
      if (!s.byId[id]) { s.byId[id] = { id: id, text: '', done: false }; s.items.push(s.byId[id]); }
      return s.byId[id];
    }
    function dictAllDone(s) { for (var i = 0; i < s.items.length; i++) if (!s.items[i].done) return false; return true; }
    function dictResolveFlush(s) {
      // While finishing the mic is already off, so no new utterance can begin: every known item done
      // is enough (a manual commit gets a final but no speech_stopped, so speechOpen would never clear).
      if (!s.flushWaiters.length || !dictAllDone(s) || (s.speechOpen && !s.finishing)) return;
      var w = s.flushWaiters; s.flushWaiters = [];
      for (var i = 0; i < w.length; i++) w[i]();
    }
    function dictArmIdle(s) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      var ms = s.opts.noSpeechMs || DICT_IDLE_STOP_MS;
      s.idleTimer = setTimeout(function () {
        if (dict.s !== s || s.speechOpen) return;
        dictStop();
        if (s.opts.onNoSpeech) s.opts.onNoSpeech();
      }, ms);
    }
    function dictArmAutoSend(s) {
      if (!s.opts.autoSend) return;
      if (s.autoTimer) clearTimeout(s.autoTimer);
      s.autoTimer = setTimeout(function () {
        if (dict.s !== s || s.speechOpen || !dictAllDone(s)) return;
        if (!elText.value.trim()) { dictArmIdle(s); return; } // nothing usable (noise) — keep listening
        dictStop();
        o.send();
      }, DICT_AUTOSEND_QUIET_MS);
    }

    function dictHandle(s, m) {
      if (m.type === 'ready') { s.ready = true; micSetState(s.finishing ? 'finishing' : 'listening'); return; }
      if (m.type === 'speech_started') {
        s.speechOpen = true; dictItem(s, m.item);
        if (s.autoTimer) { clearTimeout(s.autoTimer); s.autoTimer = null; }
        if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
        return;
      }
      if (m.type === 'speech_stopped') { s.speechOpen = false; dictItem(s, m.item); return; }
      if (m.type === 'delta') { var it = dictItem(s, m.item); if (it.done) return; it.text += m.text; dictRender(s); return; }
      if (m.type === 'final') {
        var f = dictItem(s, m.item); f.done = true; if (m.text) f.text = m.text; dictRender(s);
        dictResolveFlush(s);
        if (!s.finishing) { dictArmIdle(s); dictArmAutoSend(s); }
        return;
      }
      if (m.type === 'error') {
        var msg = m.message === 'transcription not configured' ? 'Dictation is not enabled' : 'Dictation stopped — ' + (m.message || 'connection lost');
        dictTeardown(s); toast(msg);
        if (s.opts.onError) s.opts.onError();
      }
    }

    // Start a session. opts: { autoSend, noSpeechMs, onNoSpeech, onError } (voice mode passes all four).
    function dictStart(opts) {
      if (dictBusy()) return;
      var s = { opts: opts || {}, ws: null, ctx: null, src: null, node: null, sink: null, stream: null, ready: false, finishing: false,
                items: [], byId: {}, base: '', speechOpen: false, flushWaiters: [], idleTimer: null, autoTimer: null,
                level: 0, shown: 0, raf: 0, bars: null, rendering: false, queue: [], open: false, dead: false, finishPromise: null };
      dict.s = s;
      var cur = elText.value;
      s.base = cur && !/\s$/.test(cur) ? cur + ' ' : cur;
      micSetState('connecting');
      s.bars = elMic.querySelectorAll('.wfai-meter i');
      micMeterTick(s);

      function onFrame(f32, rate) {
        if (dict.s !== s || s.finishing) return;
        s.level = Math.max(s.level, rmsOf(f32));
        var pcm = toPcm16(f32, rate);
        if (s.open) s.ws.send(pcm.buffer); else if (s.queue.length < 30) s.queue.push(pcm.buffer);
      }

      var url = wsUrl(BASE);
      ensureToken().then(function () {
        if (dict.s !== s) return null;
        var ws;
        try { ws = new WebSocket(url); } catch (e) { dictTeardown(s); toast('Dictation unavailable'); return null; }
        s.ws = ws; ws.binaryType = 'arraybuffer';
        ws.onopen = function () {
          if (dict.s !== s) { try { ws.close(); } catch (e) {} return; }
          ws.send(JSON.stringify({ type: 'start', token: o.token(), silence_ms: s.opts.autoSend ? 900 : 700 }));
          s.open = true;
          for (var i = 0; i < s.queue.length; i++) ws.send(s.queue[i]);
          s.queue = [];
          dictArmIdle(s);
        };
        ws.onmessage = function (ev) { if (dict.s !== s) return; var m; try { m = JSON.parse(ev.data); } catch (e) { return; } dictHandle(s, m); };
        ws.onerror = function () { if (dict.s === s && !s.dead) { dictTeardown(s); toast('Dictation unavailable'); if (s.opts.onError) s.opts.onError(); } };
        ws.onclose = function () { if (dict.s === s && !s.dead) { dictTeardown(s); if (s.opts.onError) s.opts.onError(); } };
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      }).then(function (stream) {
        if (!stream) return;
        if (dict.s !== s) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        s.stream = stream;
        var AC = window.AudioContext || window.webkitAudioContext, ctx, src;
        try { ctx = new AC({ sampleRate: 24000 }); src = ctx.createMediaStreamSource(stream); }
        catch (e) { // some browsers refuse a context rate that differs from the device's — resample in JS instead
          if (ctx) { try { ctx.close(); } catch (e2) {} }
          ctx = new AC(); src = ctx.createMediaStreamSource(stream);
        }
        s.ctx = ctx; s.src = src;
        if (ctx.state === 'suspended') ctx.resume();
        var rate = ctx.sampleRate;
        var wire = function (node) {
          s.node = node;
          // a muted sink keeps the graph pulling (ScriptProcessor needs it; harmless for the worklet)
          var g = ctx.createGain(); g.gain.value = 0; s.sink = g;
          src.connect(node); node.connect(g); g.connect(ctx.destination);
        };
        var scriptNode = function () {
          var sp = ctx.createScriptProcessor(4096, 1, 1);
          sp.onaudioprocess = function (ev) { onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)), rate); };
          return sp;
        };
        if (ctx.audioWorklet && window.AudioWorkletNode) {
          var blobUrl = URL.createObjectURL(new Blob([DICT_WORKLET], { type: 'application/javascript' }));
          return ctx.audioWorklet.addModule(blobUrl).then(function () {
            URL.revokeObjectURL(blobUrl);
            if (dict.s !== s) return;
            var node = new AudioWorkletNode(ctx, 'wfai-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
            node.port.onmessage = function (ev) { onFrame(ev.data, rate); };
            wire(node);
          }, function () { if (dict.s === s) wire(scriptNode()); });
        }
        wire(scriptNode());
      }).catch(function (e) {
        if (dict.s !== s) return;
        dictTeardown(s);
        toast(e && e.name === 'NotAllowedError' ? 'Microphone access denied' : 'Could not start the microphone');
        if (s.opts.onError) s.opts.onError();
      });
    }

    // Release the microphone + audio graph (the socket may stay open while the last words arrive).
    function dictReleaseAudio(s) {
      if (s.stream) { s.stream.getTracks().forEach(function (t) { t.stop(); }); s.stream = null; }
      try { if (s.node && s.node.port) s.node.port.onmessage = null; } catch (e) {}
      try { if (s.node && 'onaudioprocess' in s.node) s.node.onaudioprocess = null; } catch (e) {}
      try { if (s.src) s.src.disconnect(); } catch (e) {}
      try { if (s.node) s.node.disconnect(); } catch (e) {}
      try { if (s.sink) s.sink.disconnect(); } catch (e) {}
      if (s.ctx) { try { s.ctx.close(); } catch (e) {} s.ctx = null; }
      s.src = null; s.node = null; s.sink = null;
    }
    function dictTeardown(s) {
      if (s.dead) return;
      s.dead = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      if (s.autoTimer) clearTimeout(s.autoTimer);
      if (s.raf) cancelAnimationFrame(s.raf);
      dictReleaseAudio(s);
      if (s.ws) { try { if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'stop' })); } catch (e) {} try { s.ws.close(); } catch (e) {} s.ws = null; }
      var w = s.flushWaiters; s.flushWaiters = [];
      for (var i = 0; i < w.length; i++) w[i]();
      if (dict.s === s) { dict.s = null; micSetState('idle'); }
    }

    // Finish the active session: mic off now, then wait (briefly) for the words still in flight
    // before closing. Resolves when the composer holds everything that was said. Safe when idle.
    function dictFinish() {
      var s = dict.s;
      if (!s) return Promise.resolve();
      if (s.finishing) return s.finishPromise;
      s.finishing = true;
      micSetState('finishing');
      if (s.autoTimer) { clearTimeout(s.autoTimer); s.autoTimer = null; }
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      dictReleaseAudio(s);
      var needWait = s.open && s.ready && (s.speechOpen || !dictAllDone(s));
      if (needWait && s.speechOpen) { try { s.ws.send(JSON.stringify({ type: 'commit' })); } catch (e) {} }
      s.finishPromise = new Promise(function (resolve) {
        if (!needWait) { resolve(); return; }
        var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(); } }, DICT_FLUSH_WAIT_MS);
        s.flushWaiters.push(function () { if (!done) { done = true; clearTimeout(t); resolve(); } });
      }).then(function () { dictTeardown(s); });
      return s.finishPromise;
    }
    // Stop immediately, keeping whatever has been written so far (turn start, voice mode off, playback).
    function dictStop() { if (dict.s) dictTeardown(dict.s); }

    var micReady = false;
    function enableMic() {
      if (micReady || !elMic) return;
      if (!micSupported()) return; // insecure context (non-HTTPS) or unsupported browser
      micReady = true; V.micReady = true;
      elMic.hidden = false;
      elMic.addEventListener('click', function () {
        if (dict.s) { if (!dict.s.finishing) dictFinish(); return; }
        if (voice.mode && voice.playingId !== null) { speakStop(); startVoiceListen(); return; } // interrupt the reply: my turn
        speakStop(); // same interrupt outside voice mode — playback must never bleed into the capture
        dictStart();
      });
    }
    // Escape finishes dictation (and goes no further — hosts bind Escape to close/back as well).
    elText.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dictActive()) { e.preventDefault(); e.stopImmediatePropagation(); dictFinish(); }
    });
    elText.addEventListener('input', function () {
      if (!elText.value.trim()) dict.contributed = false; // emptied by hand: the next message is typed, not dictated
      var s = dict.s; if (!s || s.rendering) return;
      // the user edited mid-dictation: keep their text, and append anything still to come after it
      s.base = /\s$/.test(elText.value) || !elText.value ? elText.value : elText.value + ' ';
      s.items = []; s.byId = {};
    });

    // ---- read-aloud + voice mode ---------------------------------------------
    // Three surfaces, all gated on the host reporting tts:true:
    //   1. a per-assistant-message Listen button that speaks the reply;
    //   2. spoken in -> spoken out: a message dictated via the mic gets that one reply spoken as it
    //      streams (voice.speakNextReply), with no mic re-arm afterwards;
    //   3. a composer "voice mode" toggle: each reply is spoken as it streams, and when playback ends
    //      the live dictation engine starts with autoSend (server-side VAD ends the utterance and the
    //      turn is sent) so a client in a tractor or ute can converse fully hands-free. The loop stops
    //      on toggle-off, on a turn error, on a no-speech timeout, or when the tab loses visibility.
    // Two READERS can do the speaking (the host sets which from its /me `reader` flag):
    //   'openai' — POST <ttsPath> per sentence group -> parallel fetches -> back-to-back <audio>;
    //   'retell' — one Retell WEB CALL per utterance: the sidecar creates the call to the reader agent
    //              (the phone channel's voice), this page joins it with Retell's SDK (mic muted) and
    //              streams the text to the sidecar, which feeds it down Retell's custom-LLM socket.
    //              If Retell fails before it has spoken, the utterance is handed to the OpenAI reader
    //              and this page stays on OpenAI until reloaded — the words are never lost.
    var ttsReady = false;
    var voice = { mode: false, streamedTurn: false,
                  speakNextReply: false, // dictated send in flight: speak this one reply, then stop
                  audio: null, url: null, playingId: null, playingBtn: null, reqSeq: 0 };

    var READER_SDK_URL = 'https://cdn.jsdelivr.net/npm/retell-client-js-sdk@2.0.8/+esm';
    var NOMIC_KEY = 'wfai.reader.nomic';   // sessionStorage: this browser cannot join Retell calls (no mic / denied)
    var reader = { mode: 'openai', path: o.readerPath || '/reader', dead: false, noMic: false, sdk: null, warned: false };
    try { reader.noMic = sessionStorage.getItem(NOMIC_KEY) === '1'; } catch (e) {}
    function setReader(mode) {
      reader.mode = mode === 'retell' ? 'retell' : 'openai';
      // Retell's SDK publishes a microphone track to join a call (we mute it at once). A desktop with
      // no input device cannot join: probe up front and stay quietly on OpenAI rather than fail later.
      if (reader.mode === 'retell' && !reader.noMic && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices().then(function (list) {
          if (!list.some(function (d) { return d.kind === 'audioinput'; })) noMic('no audio input device');
        }, function () {});
      }
    }
    function noMic(why) {
      reader.noMic = true;
      try { sessionStorage.setItem(NOMIC_KEY, '1'); } catch (e) {}
      try { console.info('[wfai] Retell reader not used on this browser: ' + why); } catch (e) {}
    }
    function useRetell() { return reader.mode === 'retell' && !reader.dead && !reader.noMic; }
    function readerSdk() {
      if (!reader.sdk) {
        // A dynamic import from a classic script, built with Function so an old parser never trips on the syntax.
        reader.sdk = (new Function('u', 'return import(u);'))(READER_SDK_URL).then(function (m) { return m.RetellWebClient; });
        reader.sdk.then(null, function () { reader.sdk = null; });
      }
      return reader.sdk;
    }
    function readerApi(method, path, body, retried) {
      return ensureToken().then(function () {
        return fetch(BASE + reader.path + path, { method: method, headers: { Authorization: 'Bearer ' + o.token(), 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined, keepalive: method === 'DELETE' });
      }).then(function (r) {
        // A lapsed token gets one refresh + retry when the host can mint a new one (as ttsFetch does).
        if (r.status === 401 && !retried && o.refreshToken) return o.refreshToken().then(function () { return readerApi(method, path, body, true); });
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; });
        return r.status === 204 ? null : r.json();
      });
    }
    function readerDisable(why) {
      reader.dead = true;
      if (!reader.warned) { reader.warned = true; toast('Phone voice unavailable — using the standard voice'); }
      try { console.warn('[wfai] Retell reader disabled for this page: ' + why); } catch (e) {}
    }

    function setSpeakBtn(btn, s) {
      if (elVoice) elVoice.classList.toggle('speaking', s === 'playing'); // the wave animates while the advisor talks
      if (!btn) return;
      var iconOnly = btn.classList.contains('icon');
      if (s === 'loading') { btn.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i>' + (iconOnly ? '' : ' Listen'); btn.classList.add('speaking'); btn.title = 'Loading'; }
      else if (s === 'playing') { btn.innerHTML = '<i class="fa fa-stop"></i>' + (iconOnly ? '' : ' Stop'); btn.classList.add('speaking'); btn.title = 'Stop'; }
      else { btn.innerHTML = '<i class="fa fa-volume-up"></i>' + (iconOnly ? '' : ' Listen'); btn.classList.remove('speaking'); btn.title = 'Listen'; }
    }

    // ---- the current utterance (one at a time) ----------------------------------
    // An utterance is a reply (or a Listen) being spoken: text is pushed in sentence groups as it
    // becomes available, closed when complete, and it reports back when playback has drained.
    var utt = null;
    var vstream = { on: false, buf: '' };

    function speakStop() {
      voice.reqSeq++; // invalidate any in-flight fetch, queued chunk, or pending playback
      var u = utt; utt = null;
      if (u) { try { u.stop(); } catch (e) {} }
      if (voice.audio) { try { voice.audio.pause(); } catch (e) {} }
      if (voice.url) { try { URL.revokeObjectURL(voice.url); } catch (e) {} }
      setSpeakBtn(voice.playingBtn, 'idle');
      voice.audio = null; voice.url = null; voice.playingId = null; voice.playingBtn = null;
      vstream.on = false; vstream.buf = '';
    }
    function uttFinish(u, failedAll, failMsg) {
      if (utt !== u || u.seq !== voice.reqSeq) return;
      utt = null;
      setSpeakBtn(voice.playingBtn, 'idle');
      voice.playingId = null; voice.playingBtn = null;
      var f = u.onDrain; u.onDrain = null;
      if (failedAll) {
        toast(failMsg === 'session expired' ? 'Session expired — reload the page' : 'Could not play the reply');
        if (f && voice.mode) setVoiceMode(false); // a dead reader must not re-arm the hands-free mic in a loop
        return;
      }
      if (f) f();
    }
    function uttStart(id, btn, onDrain) {
      dictStop(); // playback and a live mic capture must never overlap — end any capture first, so the
                  // advisor's own audio can't be transcribed and auto-sent as a user turn
      speakStop();
      var seq = ++voice.reqSeq;
      voice.playingId = id; voice.playingBtn = btn || null;
      setSpeakBtn(btn, 'loading');
      utt = useRetell() ? retellUtt(seq, onDrain || null) : openaiUtt(seq, onDrain || null);
    }
    function uttPush(text) { if (utt && text && text.trim()) utt.push(text); }
    function uttClose() { if (utt) utt.close(); }

    // ---- OpenAI reader: parallel fetches -> back-to-back playback -----------------
    // Playback starts after the FIRST sentence group synthesises while the rest fetch in parallel.
    function ttsFetch(text, retried) {
      return ensureToken().then(function () {
        return fetch(BASE + TTS_PATH, { method: 'POST', headers: { Authorization: 'Bearer ' + o.token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) });
      }).then(function (r) {
        // A lapsed token gets one refresh + retry when the host can mint a new one.
        if (r.status === 401 && !retried && o.refreshToken) return o.refreshToken().then(function () { return ttsFetch(text, true); });
        if (!r.ok) return r.json().catch(function () { return { error: 'HTTP ' + r.status }; })
          .then(function (j) { throw new Error(r.status === 401 ? 'session expired' : (j.error || ('HTTP ' + r.status))); });
        return r.blob();
      });
    }
    function openaiUtt(seq, onDrain) {
      var u = { kind: 'openai', seq: seq, onDrain: onDrain, items: [], idx: 0, playing: false, closed: false, played: 0, failed: 0, failMsg: null };
      function alive() { return utt === u && u.seq === voice.reqSeq; }
      function kick() {
        if (!alive() || u.playing) return;
        if (u.idx >= u.items.length) {
          if (!u.closed) return; // stream still feeding — wait for the next chunk
          uttFinish(u, !u.played && u.failed > 0, u.failMsg);
          return;
        }
        u.playing = true;
        u.items[u.idx++].then(function (blob) {
          if (!alive()) return; // superseded or stopped while fetching
          var url = URL.createObjectURL(blob);
          var audio = new Audio(url);
          voice.audio = audio; voice.url = url;
          function step() {
            if (!alive()) return;
            try { URL.revokeObjectURL(url); } catch (e) {}
            voice.audio = null; voice.url = null;
            u.playing = false; kick();
          }
          audio.addEventListener('ended', step);
          audio.addEventListener('error', function () { u.failed++; step(); }); // a bad chunk is skipped, the queue keeps moving
          setSpeakBtn(voice.playingBtn, 'playing'); // null btn (live pipeline): only the voice-mode wave animates
          audio.play().then(function () { u.played++; }, function () {
            if (!alive()) return;
            speakStop(); if (voice.mode) setVoiceMode(false); else toast('Playback was blocked — tap Listen again');
          });
        }).catch(function (e) {
          if (!alive()) return;
          var m = e && e.message;
          if (m === 'text-to-speech not configured') {
            speakStop(); if (voice.mode) setVoiceMode(false); else toast('Voice is not enabled');
            return;
          }
          u.failed++; u.failMsg = m;
          u.playing = false; kick(); // skip the failed chunk, keep speaking the rest (a fully failed reply toasts on drain)
        });
      }
      u.push = function (text) { if (u.closed) return; u.items.push(ttsFetch(text)); kick(); };
      u.close = function () { if (!u.closed) { u.closed = true; kick(); } };
      u.stop = function () {}; // the <audio> is paused by speakStop
      return u;
    }

    // ---- Retell reader: one web call per utterance --------------------------------
    // The call is opened the moment the utterance starts (before any text exists) so the connection
    // cost overlaps the model's first sentence; text follows in order through the sidecar.
    function retellUtt(seq, onDrain) {
      var u = { kind: 'retell', seq: seq, onDrain: onDrain, texts: [], closed: false, capped: false, session: null, client: null, spoke: false, gone: false, chain: null };
      function alive() { return utt === u && u.seq === voice.reqSeq && !u.gone; }
      function hangup() {
        try { if (u.client) u.client.stopCall(); } catch (e) {}
        if (u.session) readerApi('DELETE', '/sessions/' + u.session.session_id).then(null, function () {});
      }
      // Failed: if it already spoke, the reply is treated as finished (the rest is on screen); if it
      // never spoke, the whole utterance goes to the OpenAI reader with the same button and drain hook.
      // The page is latched off Retell only for a failure that would repeat: the SDK not loading, or
      // the call not starting for a non-request reason. A microphone refusal / absence is remembered
      // quietly (the SDK cannot join a call without one); a 4xx never latches.
      function fail(e, where) {
        if (!alive()) return;
        u.gone = true;
        var msg = (e && e.message) || String(e), name = (e && e.name) || '';
        try { console.warn('[wfai] Retell reader ' + where + ' failed: ' + msg); } catch (x) {}
        hangup();
        if (u.spoke) { toast('Playback stopped early — the rest is on screen'); uttFinish(u, false); return; }
        var micErr = /NotAllowedError|NotFoundError|NotReadableError|OverconstrainedError|SecurityError/.test(name) || /permission|microphone|device/i.test(msg);
        if (where === 'start' && micErr) noMic(msg);
        else if ((where === 'sdk' || where === 'start') && !(e && e.status >= 400 && e.status < 500)) readerDisable(where + ': ' + msg);
        var texts = u.texts.slice(), closed = u.closed;
        var next = openaiUtt(u.seq, u.onDrain);
        utt = next;
        for (var i = 0; i < texts.length; i++) next.push(texts[i]);
        if (closed) next.close();
      }
      var start = readerApi('POST', '/sessions').then(function (j) {
        if (!alive()) { readerApi('DELETE', '/sessions/' + j.session_id).then(null, function () {}); return; }
        u.session = j;
        return readerSdk().then(function (Ctor) {
          if (!alive()) { hangup(); return; }
          var c = new Ctor(); u.client = c;
          c.on('call_started', function () { try { c.mute(); } catch (e) {} });
          c.on('agent_start_talking', function () { if (!alive()) return; u.spoke = true; setSpeakBtn(voice.playingBtn, 'playing'); });
          c.on('call_ended', function () {
            if (!alive()) return;
            // Ended before a word was spoken (Retell's silence timeout, a dropped call): the whole
            // utterance — including text still to come — moves to the OpenAI reader.
            if (!u.spoke) fail(new Error('the call ended before it spoke'), 'ended');
            else { u.gone = true; if (!u.closed) toast('Playback stopped early — the rest is on screen'); uttFinish(u, false); }
          });
          c.on('error', function (e) { fail(e, 'call'); });
          return c.startCall({ accessToken: j.access_token }).then(function () {
            try { c.mute(); } catch (e) {}                                   // the reader never listens
            try { if (c.startAudioPlayback) c.startAudioPlayback(); } catch (e) {} // resume audio if the page's context was suspended
          });
        }, function (e) { throw new Error('sdk: ' + ((e && e.message) || e)); });
      });
      start.then(null, function (e) { fail(e, 'start'); });
      // Text and close are serialised behind the start, so chunks reach the sidecar in order.
      u.chain = start.then(null, function () {});
      // `closed` = the host has pushed everything (a Listen closes synchronously, before the chained
      // says have even run); `capped` = the sidecar closed the session itself — only that stops sends.
      u.push = function (text) {
        if (u.closed || u.gone) return;
        u.texts.push(text);
        u.chain = u.chain.then(function () {
          if (!alive() || !u.session || u.capped) return;
          return readerApi('POST', '/sessions/' + u.session.session_id + '/say', { text: text }).then(function (j) {
            // The sidecar capped or closed the session (it said "the rest is on screen"): send no more.
            if (j && (j.capped || j.closed)) u.capped = true;
          });
        }).then(null, function (e) { fail(e, 'say'); });
      };
      u.close = function () {
        if (u.closed) return;
        u.closed = true;
        u.chain = u.chain.then(function () { if (!alive() || !u.session || u.capped) return; return readerApi('POST', '/sessions/' + u.session.session_id + '/close'); })
          .then(null, function (e) { fail(e, 'close'); });
      };
      u.stop = function () { u.gone = true; hangup(); };
      return u;
    }

    // Find a safe cut AFTER a sentence end (or paragraph break) at/past `min` chars — see cutPoint.
    // Live turn: called at turn start; returns whether the pipeline is on. Speaks when voice mode is
    // on, or once for a dictated send (speakNextReply). Consumed here so it never outlives its turn;
    // the pipeline's drain callback (startVoiceListen) still no-ops unless voice mode is on.
    // `opts.id` attributes the live pipeline to the reply's message id when the host already knows
    // it, so a Listen button rendered mid-playback shows Stop instead of Listen.
    function turnBegin(opts) {
      var speakThis = voice.mode || voice.speakNextReply;
      voice.speakNextReply = false;
      if (!speakThis || !ttsReady) return false;
      voice.streamedTurn = true; // afterTurn must not replay what we already spoke
      uttStart(opts && opts.id != null ? opts.id : null, null, startVoiceListen);
      vstream.on = true; vstream.buf = ''; // after uttStart: its speakStop() resets vstream
      return true;
    }
    function turnDelta(t) {
      if (!vstream.on) return;
      vstream.buf += t;
      for (;;) {
        var cut = cutPoint(vstream.buf, 80);
        if (cut <= 0) break;
        uttPush(vstream.buf.slice(0, cut));
        vstream.buf = vstream.buf.slice(cut);
      }
    }
    function turnEnd() {
      if (!vstream.on) return;
      vstream.on = false;
      if (vstream.buf.trim()) uttPush(vstream.buf);
      vstream.buf = '';
      uttClose();
    }
    // An errored turn breaks the hands-free loop (and stops whatever was being spoken).
    function turnError() { if (voice.mode) setVoiceMode(false); else if (vstream.on) speakStop(); }

    // Play one message's audio. `onended` fires only on natural completion (not on stop/replace).
    function speak(id, text, btn, onended) {
      uttStart(id, btn, onended || null);
      var chunks = splitWhole(text);
      for (var i = 0; i < chunks.length; i++) uttPush(chunks[i]);
      uttClose();
    }
    // Listen button: toggle playback for this message. In voice mode, a click during the hands-free
    // listen phase ends that capture first (uttStart -> dictStop), then re-arms listening once this
    // message finishes playing — so the loop resumes cleanly instead of leaving voice mode stalled.
    function toggleSpeak(id, text, btn) {
      if (voice.playingId === id) { speakStop(); return; }
      speak(id, text, btn, voice.mode ? startVoiceListen : null);
    }
    // A ready-made Listen button for a message: `opts.icon` = icon only (narrow surfaces).
    function listenButton(id, text, opts) {
      var b = document.createElement('button');
      b.className = 'wfai-speak' + (opts && opts.icon ? ' icon' : '');
      b.type = 'button';
      setSpeakBtn(b, voice.playingId === id ? 'playing' : 'idle');
      if (voice.playingId === id) { voice.playingBtn = b; }
      b.addEventListener('click', function () { toggleSpeak(id, text, b); });
      return b;
    }

    // After a turn completes in voice mode, auto-play the newest reply, then listen.
    function afterTurn() {
      if (!voice.mode || !ttsReady) return;
      if (voice.streamedTurn) { // already spoken live during the stream
        voice.streamedTurn = false;
        // If that pipeline drained before this point, its onDrain found the turn still streaming and
        // could not re-arm listening — do it now.
        if (!utt && voice.playingId === null && !dictBusy()) startVoiceListen();
        return;
      }
      var last = lastAssistant();
      if (!last) { startVoiceListen(); return; }
      speak(last.id, last.text, last.btn || null, startVoiceListen);
    }

    // Hands-free listen phase: live dictation with autoSend — the server VAD ends the utterance, the
    // words land in the composer, and the turn is sent after a short quiet gap.
    function startVoiceListen() {
      if (!voice.mode) return;
      if (document.hidden) { setVoiceMode(false); return; }
      if (!micReady) return; // playback-only here (no STT) — stay idle
      if (isBusy() || dictBusy()) return;
      dictStart({
        autoSend: true,
        noSpeechMs: VOICE_NO_SPEECH_MS,
        onNoSpeech: function () { if (voice.mode) { setVoiceMode(false); toast('Voice mode paused — no speech detected'); } },
        onError: function () { if (voice.mode) setVoiceMode(false); }
      });
    }

    function setVoiceMode(on) {
      voice.mode = on;
      voice.streamedTurn = false;
      if (elVoice) {
        elVoice.classList.toggle('on', on);
        elVoice.setAttribute('aria-pressed', on ? 'true' : 'false');
        elVoice.title = on ? 'Voice mode on' : 'Voice mode';
      }
      if (o.onVoiceMode) o.onVoiceMode(on);
      if (!on) { speakStop(); dictStop(); return; }
      // kick the loop: read the last reply if there is one, otherwise start listening
      if (lastAssistant()) afterTurn(); else startVoiceListen();
    }

    function enableVoice() {
      if (ttsReady) return;
      ttsReady = true; V.ttsReady = true;
      if (!elVoice) return;
      if (!elVoice.firstElementChild) elVoice.innerHTML = WAVE_SVG;
      elVoice.hidden = false;
      elVoice.addEventListener('click', function () { setVoiceMode(!voice.mode); });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (voice.mode) setVoiceMode(false); else { speakStop(); dictFinish(); } }
    });


    // ---- send hooks ------------------------------------------------------------
    // Spoken in -> spoken out: a dictated message gets its reply read aloud even with voice mode
    // off (voice mode already speaks every reply, and re-arming the mic stays voice-mode-only).
    // The host calls noteSend() as the message leaves the composer and undoSend() if it failed.
    function noteSend() {
      var was = dict.contributed;
      dict.contributed = false;
      voice.speakNextReply = was && !voice.mode && ttsReady;
      return { dictated: was };
    }
    function undoSend(marker) { dict.contributed = !!(marker && marker.dictated); voice.speakNextReply = false; }

    var V = {
      micReady: false, ttsReady: false,
      enableMic: enableMic, enableVoice: enableVoice,
      dictActive: dictActive, dictBusy: dictBusy, dictStart: dictStart, dictFinish: dictFinish, dictStop: dictStop,
      noteSend: noteSend, undoSend: undoSend,
      turnBegin: turnBegin, turnDelta: turnDelta, turnEnd: turnEnd, turnError: turnError, afterTurn: afterTurn,
      speak: speak, toggleSpeak: toggleSpeak, speakStop: speakStop, listenButton: listenButton,
      setReader: setReader, reader: function () { return useRetell() ? 'retell' : 'openai'; },
      playingId: function () { return voice.playingId; },
      voiceMode: function () { return voice.mode; }, setVoiceMode: setVoiceMode
    };
    return V;
  }

  window.WFVoice = { create: create, micSupported: micSupported, cutPoint: cutPoint, splitWhole: splitWhole };
})();
