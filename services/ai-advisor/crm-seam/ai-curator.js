/*
 * AI Trainer — the knowledge-base workbench behind the CRM's "AI Trainer Home".
 *
 * Host page (ai-curator.jsp) sets window.WFCUR = { token, baseUrl, userId, userName, tokenTtl, refreshUrl }.
 * Everything talks to the sidecar's /trainer routes with the CRM-minted bearer token; the sidecar
 * re-verifies staff usertype + the AI Trainer role from the database on every call, fail-closed.
 *
 * Layout: the assistant rail (left) and the workspace (right: Library / Notes / Uploads / Reports /
 * History). Anything the assistant can do, the workspace can do by hand; both go through the same
 * ledger, so a change made in chat shows up in History with an Undo, and vice versa. A "change" is
 * always shown as a numbered chip (№ 142) — the one piece of vocabulary the whole page shares.
 *
 * Plain DOM JS, no build step (matches the other seam pages).
 */
(function () {
  'use strict';
  var CFG = window.WFCUR || {};
  var API = (CFG.baseUrl || 'http://localhost:3100').replace(/\/$/, '') + '/trainer';
  var token = CFG.token || '';
  var tokenAt = Date.now();   // when `token` was minted — the speech engine refreshes it before it lapses
  var EMBEDDED = (function () { try { return window.top !== window.self; } catch (e) { return true; } })();
  var STORE_KEY = 'wftr.chat.' + (CFG.userId || 'anon');
  var root = document.getElementById('wfc-root');
  if (!root) return;

  // ================================================================ utils
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function q(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qa(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function fmtBytes(n) { if (n == null) return ''; if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'; if (n >= 1024) return Math.round(n / 1024) + ' KB'; return n + ' B'; }
  function fmtWhen(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleString(); }
  function ago(s) {
    if (!s) return ''; var d = new Date(s); if (isNaN(d)) return String(s);
    var sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 45) return 'just now'; if (sec < 3600) return Math.round(sec / 60) + ' min ago';
    if (sec < 86400) { var h = Math.round(sec / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    if (sec < 172800) return 'yesterday'; if (sec < 86400 * 14) return Math.round(sec / 86400) + ' days ago';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function num(id) { return '<span class="wft-num">№ ' + esc(id) + '</span>'; }
  function opChip(op) { return '<span class="op ' + esc(op) + '">' + esc(op === 'create' ? 'added' : op === 'delete' ? 'removed' : op === 'snapshot' ? 'baseline' : 'edited') + '</span>'; }
  function viaLabel(v) { return v === 'chat' ? 'via the assistant' : v === 'manual' ? 'by hand' : v === 'ingest' ? 'from an upload' : v === 'undo' ? 'undo' : v === 'restore' ? 'restore' : v === 'external' ? 'outside the Trainer' : v; }
  /** Only plain http(s) URLs become links; anything else renders as text. */
  function safeLink(u, label) { return /^https?:\/\/\S+$/.test(u) ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(label || u) + '</a>' : esc(label || u); }
  function slug(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }

  var toasts = el('<div id="wft-toasts"></div>'); document.body.appendChild(toasts);
  function toast(msg, opts) {
    opts = opts || {};
    var t = el('<div class="wft-toast' + (opts.err ? ' err' : '') + '"><span>' + esc(msg) + '</span></div>');
    if (opts.action) { var b = el('<button>' + esc(opts.action) + '</button>'); b.addEventListener('click', function () { t.remove(); opts.onAction(); }); t.appendChild(b); }
    toasts.appendChild(t);
    setTimeout(function () { t.remove(); }, opts.err ? 8000 : (opts.action ? 9000 : 3500));
  }
  /** Two-step confirm without a blocking dialog: first click arms (relabel + 8s), second runs. */
  function arm(btn, armedLabel, onConfirm) {
    var original = btn.innerHTML, timer = null, armed = false;
    function disarm() { armed = false; btn.classList.remove('armed'); btn.innerHTML = original; clearTimeout(timer); document.removeEventListener('click', outside, true); }
    function outside(e) { if (!btn.contains(e.target)) disarm(); }
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (!armed) { armed = true; btn.classList.add('armed'); btn.innerHTML = armedLabel; timer = setTimeout(disarm, 8000); setTimeout(function () { document.addEventListener('click', outside, true); }, 0); return; }
      disarm(); onConfirm();
    });
    return btn;
  }

  // ================================================================ API
  function refreshToken() {
    if (!CFG.refreshUrl) return Promise.reject(new Error('no refresh url'));
    return fetch(CFG.refreshUrl, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('token refresh failed'); return r.json(); }).then(function (j) { token = j.token; tokenAt = Date.now(); });
  }
  /** Proactive variant for the speech engine (a websocket cannot retry on 401): refresh when the
   *  token is within two minutes of its TTL. */
  function ensureTokenFresh() {
    if (!CFG.refreshUrl || Date.now() - tokenAt < ((CFG.tokenTtl || 1800) - 120) * 1000) return Promise.resolve();
    return refreshToken().catch(function () {});
  }
  function api(path, opts, retried) {
    opts = opts || {};
    var headers = opts.headers ? Object.assign({}, opts.headers) : {};
    headers['Authorization'] = 'Bearer ' + token;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts = Object.assign({}, opts, { body: JSON.stringify(opts.json) }); }
    return fetch(API + path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status === 401 && !retried && CFG.refreshUrl) return refreshToken().then(function () { return api(path, opts, true); });
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(j.error || ('request failed (' + r.status + ')')); e.status = r.status; e.reason = j.reason; e.role = j.role; throw e;
        });
      }
      return r.json();
    });
  }

  // ================================================================ markdown (rendering only)
  function inlineMd(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[^"'>])(https?:\/\/[^\s<>&\)]+[^\s<>&\).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return s;
  }
  function md(src) {
    var out = [], lines = String(src || '').split(/\r?\n/), i = 0, buf = [];
    function flushP() { if (!buf.length) return; out.push('<p>' + inlineMd(buf.join(' ')) + '</p>'); buf = []; }
    while (i < lines.length) {
      var ln = lines[i];
      if (/^```/.test(ln)) { flushP(); var code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; } i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue; }
      var hm = /^(#{1,6})\s+(.*)$/.exec(ln);
      if (hm) { flushP(); var lvl = Math.min(hm[1].length, 3); out.push('<h' + lvl + '>' + inlineMd(hm[2]) + '</h' + lvl + '>'); i++; continue; }
      if (/^\s*[-*]\s+/.test(ln)) { flushP(); var items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inlineMd(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; } out.push('<ul>' + items.join('') + '</ul>'); continue; }
      if (/^\s*\d+[.)]\s+/.test(ln)) { flushP(); var oi = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { oi.push('<li>' + inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; } out.push('<ol>' + oi.join('') + '</ol>'); continue; }
      if (/^\s*>\s?/.test(ln)) { flushP(); var qs = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qs.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push('<blockquote>' + md(qs.join('\n')) + '</blockquote>'); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { flushP(); out.push('<hr>'); i++; continue; }
      if (/^\|.*\|\s*$/.test(ln)) {
        flushP(); var rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        var cells = rows.map(function (r) { return r.replace(/^\||\|\s*$/g, '').split('|').map(function (c) { return c.trim(); }); }).filter(function (r) { return !r.every(function (c) { return /^:?-{2,}:?$/.test(c); }); });
        if (cells.length) {
          var h = '<table><thead><tr>' + cells[0].map(function (c) { return '<th>' + inlineMd(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
          for (var ri = 1; ri < cells.length; ri++) h += '<tr>' + cells[ri].map(function (c) { return '<td>' + inlineMd(c) + '</td>'; }).join('') + '</tr>';
          out.push(h + '</tbody></table>');
        }
        continue;
      }
      if (!ln.trim()) { flushP(); i++; continue; }
      buf.push(ln.trim()); i++;
    }
    flushP();
    return out.join('');
  }

  // ================================================================ frontmatter (the document file)
  function parseFm(raw) {
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw || '');
    var meta = {}, order = [], urls = [], body = raw || '';
    if (m) {
      body = m[2] || '';
      var listKey = null;
      m[1].split(/\r?\n/).forEach(function (line) {
        var item = /^\s*-\s+(.*)$/.exec(line);
        if (item && listKey === 'source_urls') { urls.push(item[1].trim().replace(/^['"]|['"]$/g, '')); return; }
        var kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
        if (!kv) return;
        if (kv[1] === 'source_urls') { listKey = 'source_urls'; return; }
        listKey = null; meta[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, ''); order.push(kv[1]);
      });
    }
    return { meta: meta, order: order, urls: urls, body: body.replace(/^\n+/, '') };
  }
  var FM_ORDER = ['id', 'title', 'jurisdiction', 'instrument', 'source_file', 'upload_id', 'tags', 'document_date', 'as_at', 'best_by', 'summary'];
  function buildFm(meta, urls, body, extraOrder) {
    var lines = ['---'];
    var done = {};
    function put(k) { if (done[k]) return; done[k] = true; var v = meta[k]; if (v == null || String(v).trim() === '') return; lines.push(k + ': ' + String(v).replace(/[\r\n]+/g, ' ').trim()); }
    FM_ORDER.forEach(function (k) { if (k === 'as_at') { if (urls && urls.length) { lines.push('source_urls:'); urls.forEach(function (u) { lines.push('  - ' + u); }); } } put(k); });
    (extraOrder || []).forEach(put); Object.keys(meta).forEach(put);
    lines.push('---', '');
    return lines.join('\n') + (body || '').replace(/^\n+/, '') + '\n';
  }

  // ================================================================ line diff
  function diffLines(a, b) {
    var A = (a || '').split('\n'), B = (b || '').split('\n');
    var pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    var suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    var am = A.slice(pre, A.length - suf), bm = B.slice(pre, B.length - suf);
    var ops = [];
    for (var k = 0; k < pre; k++) ops.push(['ctx', A[k]]);
    if (am.length * bm.length <= 2500000 && am.length && bm.length) {
      var n = am.length, m2 = bm.length, dp = new Array((n + 1) * (m2 + 1)).fill(0);
      for (var i = n - 1; i >= 0; i--) for (var j = m2 - 1; j >= 0; j--) dp[i * (m2 + 1) + j] = am[i] === bm[j] ? dp[(i + 1) * (m2 + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m2 + 1) + j], dp[i * (m2 + 1) + j + 1]);
      var x = 0, y = 0;
      while (x < n && y < m2) {
        if (am[x] === bm[y]) { ops.push(['ctx', am[x]]); x++; y++; }
        else if (dp[(x + 1) * (m2 + 1) + y] >= dp[x * (m2 + 1) + y + 1]) { ops.push(['del', am[x]]); x++; }
        else { ops.push(['add', bm[y]]); y++; }
      }
      while (x < n) { ops.push(['del', am[x++]]); } while (y < m2) { ops.push(['add', bm[y++]]); }
    } else {
      am.forEach(function (l) { ops.push(['del', l]); }); bm.forEach(function (l) { ops.push(['add', l]); });
    }
    for (var s = A.length - suf; s < A.length; s++) ops.push(['ctx', A[s]]);
    return ops;
  }
  function renderDiff(a, b) {
    var ops = diffLines(a, b), html = [], CTX = 3;
    var keep = ops.map(function (o, i) { if (o[0] !== 'ctx') return true; for (var d = -CTX; d <= CTX; d++) { var o2 = ops[i + d]; if (o2 && o2[0] !== 'ctx') return true; } return false; });
    var gap = false, adds = 0, dels = 0;
    ops.forEach(function (o, i) {
      if (o[0] === 'add') adds++; if (o[0] === 'del') dels++;
      if (!keep[i]) { gap = true; return; }
      if (gap) { html.push('<div class="gap">···</div>'); gap = false; }
      html.push('<div class="' + o[0] + '">' + (o[0] === 'add' ? '+ ' : o[0] === 'del' ? '− ' : '  ') + esc(o[1]) + '</div>');
    });
    if (!adds && !dels) html.push('<div class="gap">no line changes</div>');
    return '<div class="wft-diff">' + html.join('') + '</div><div class="sub" style="font-size:11.5px;color:var(--ink-3)">' + adds + ' added, ' + dels + ' removed</div>';
  }

  // ================================================================ shell
  root.innerHTML =
    '<div id="wft">' +
    '  <div id="wft-top">' +
    '    <div id="wft-brand"><span class="wft-mark"></span><span>AI Trainer</span></div>' +
    '    <nav id="wft-nav">' +
    '      <button data-v="library"><i class="fa fa-book"></i> Library <span class="n zero" id="wft-n-library"></span></button>' +
    '      <button data-v="notes"><i class="fa fa-sticky-note-o"></i> Notes <span class="n zero" id="wft-n-notes"></span></button>' +
    '      <button data-v="questions"><i class="fa fa-question-circle-o"></i> Questions</button>' +
    '      <button data-v="uploads"><i class="fa fa-cloud-upload"></i> Uploads <span class="n zero" id="wft-n-uploads"></span></button>' +
    '      <button data-v="reports"><i class="fa fa-flag-o"></i> Reports <span class="n zero" id="wft-n-reports"></span></button>' +
    '      <button data-v="costs"><i class="fa fa-usd"></i> Costs</button>' +
    '      <button data-v="history"><i class="fa fa-history"></i> History</button>' +
    '    </nav>' +
    '    <div id="wft-who"><b id="wft-who-name"></b>' + (EMBEDDED ? '<a href="' + esc(location.pathname) + '" target="_blank" title="Open in its own window"><i class="fa fa-external-link"></i></a>' : '') + '</div>' +
    '  </div>' +
    '  <aside id="wft-rail">' +
    '    <div id="wft-rail-head"><b>Assistant</b><span id="wft-rail-sub"></span><a href="#" id="wft-newchat">New conversation</a></div>' +
    '    <div id="wft-msgs"></div>' +
    '    <div id="wft-composer">' +
    '      <div id="wft-attach-row"></div>' +
    '      <div id="wft-input-wrap">' +
    '        <textarea id="wft-input" rows="1" placeholder="Message the assistant"></textarea>' +
    '        <button class="wfai-mic" id="wft-mic" title="Dictate" aria-pressed="false" hidden><i class="fa fa-microphone"></i></button>' +
    '        <button class="wfai-voice" id="wft-voice" title="Voice mode" aria-pressed="false" hidden></button>' +
    '        <button id="wft-attach-btn" title="Attach an uploaded file to this message"><i class="fa fa-paperclip"></i></button>' +
    '        <button id="wft-send" class="send" title="Send (Enter)"><i class="fa fa-arrow-up"></i></button>' +
    '      </div>' +
    '    </div>' +
    '  </aside>' +
    '  <main id="wft-work">' +
    '    <section class="wft-view" id="wft-v-library"></section>' +
    '    <section class="wft-view" id="wft-v-notes"></section>' +
    '    <section class="wft-view" id="wft-v-questions"></section>' +
    '    <section class="wft-view" id="wft-v-uploads"></section>' +
    '    <section class="wft-view" id="wft-v-reports"></section>' +
    '    <section class="wft-view" id="wft-v-costs"></section>' +
    '    <section class="wft-view" id="wft-v-history"></section>' +
    '  </main>' +
    '</div>';


  var ME = null;
  var S = { view: 'library', docs: [], notes: [], uploads: [], reports: [], events: [], checkpoints: [], docId: null, docFilter: 'all', docQuery: '', reportFilter: 'open' };
  var views = { library: renderLibrary, notes: renderNotes, questions: renderQuestions, uploads: renderUploads, reports: renderReports, costs: renderCosts, history: renderHistory };

  function show(v) {
    S.view = v;
    qa('#wft-nav button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); });
    qa('.wft-view').forEach(function (s) { s.classList.toggle('on', s.id === 'wft-v-' + v); });
    try { sessionStorage.setItem('wftr.view', v); } catch (e) { /* ignore */ }
    views[v]();
  }
  qa('#wft-nav button').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-v')); }); });

  function setBadge(id, n, warn) { var b = q('#' + id); if (!b) return; b.textContent = n; b.classList.toggle('zero', !n); b.classList.toggle('warn', !!warn && n > 0); }
  function refreshCounts() {
    return api('/overview').then(function (o) {
      S.overview = o;
      setBadge('wft-n-library', o.counts.documents);
      setBadge('wft-n-notes', o.counts.notes);
      setBadge('wft-n-uploads', o.counts.uploads_waiting, true);
      setBadge('wft-n-reports', o.counts.open_reports, true);
      if (S.view === 'library') renderStrip();
    }).catch(function () {});
  }
  /** Something changed (by chat, by hand, undo…): reload counts and whatever view is showing. */
  function changed() { refreshCounts(); views[S.view](); }

  // ================================================================ chat
  var msgsEl = q('#wft-msgs'), inputEl = q('#wft-input'), sendBtn = q('#wft-send'), attachRow = q('#wft-attach-row');
  var chat = { messages: [], sessionId: null, busy: false, pending: [] };  // pending = upload ids to attach to next message

  // ---- speech: dictation, read-aloud, voice mode (shared engine: ai-voice.js) --
  // The engine owns the mic button, the voice-mode toggle and playback; this page tells it when a
  // turn starts / streams / ends and which reply is newest, and asks it for Listen buttons. Routes
  // are the Trainer's own (/trainer/tts, admitted by the staff + role check); hidden until
  // /trainer/me reports transcribe / tts. Hands-free voice mode auto-sends what is heard, and the
  // assistant applies changes immediately — the ledger's Undo is the safety net (user's call).
  // If the shared engine did not load (a partial deploy), the page must still chat: a no-op engine.
  function noSpeech() {
    var no = function () {}, f = function () { return false; };
    return { micReady: false, ttsReady: false, enableMic: no, enableVoice: no, dictActive: f, dictBusy: f, dictStart: no,
      dictFinish: function () { return Promise.resolve(); }, dictStop: no, noteSend: function () { return { dictated: false }; }, undoSend: no,
      turnBegin: f, turnDelta: no, turnEnd: no, turnError: no, afterTurn: no, speak: no, toggleSpeak: no, speakStop: no,
      listenButton: function () { return document.createElement('span'); }, playingId: function () { return null; }, voiceMode: f, setVoiceMode: no, setReader: no };
  }
  var V = window.WFVoice ? window.WFVoice.create({
    base: API.replace(/\/trainer$/, ''), ttsPath: '/trainer/tts', readerPath: '/trainer/reader',
    token: function () { return token; }, ensureToken: ensureTokenFresh, refreshToken: refreshToken,
    textarea: inputEl, micButton: q('#wft-mic'), voiceButton: q('#wft-voice'),
    toast: function (m) { toast(m); }, autoResize: autosize,
    send: function () { send(); },
    isBusy: function () { return chat.busy; },
    lastAssistant: function () {
      for (var i = chat.messages.length - 1; i >= 0; i--) {
        var m = chat.messages[i];
        if (m.role === 'ai' && m.text) return { id: m.k, text: m.text, btn: q('.wft-msg[data-k="' + m.k + '"] .wfai-speak') };
      }
      return null;
    }
  }) : noSpeech();
  // Stable per-message keys for Listen buttons (an array index would re-point a playing button at
  // whatever message later lands at that index). Persisted with the chat, minted on first render.
  var keySeq = 0;
  function newKey() { return 'm' + Date.now().toString(36) + '-' + (++keySeq); }
  try { var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); if (saved && saved.messages) { chat.messages = saved.messages; chat.sessionId = saved.sessionId || null; } } catch (e) { /* ignore */ }
  function persistChat() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ messages: chat.messages.slice(-60), sessionId: chat.sessionId })); } catch (e) { /* ignore */ } }

  function renderChat() {
    msgsEl.innerHTML = '';
    if (!chat.messages.length) {
      var st = el('<div class="wft-starters"></div>');
      [
        'Check the open reports and tell me what went wrong.',
        'Which documents are more than a year old?',
        'Add a note: for NSW balances and carryover, point people to iWAS.',
        'Add the latest upload to the library.',
      ].forEach(function (p) { var b = el('<button>' + esc(p) + '</button>'); b.addEventListener('click', function () { inputEl.value = p; inputEl.focus(); autosize(); }); st.appendChild(b); });
      msgsEl.appendChild(st);
      return;
    }
    chat.messages.forEach(function (m) { if (!m.k) m.k = newKey(); msgsEl.appendChild(msgNode(m)); });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function msgNode(m) {
    var n = el('<div class="wft-msg ' + esc(m.role) + '"></div>');
    if (m.k) n.setAttribute('data-k', m.k);
    if (m.role === 'user') {
      if (m.files && m.files.length) n.appendChild(el('<div class="wft-file-chips">' + m.files.map(function (f) { return '<span class="wft-file-chip"><i class="fa fa-file-o"></i> ' + esc(f) + '</span>'; }).join('') + '</div>'));
      n.appendChild(el('<div class="body">' + esc(m.text).replace(/\n/g, '<br>') + '</div>'));
    } else if (m.role === 'ai') {
      n.appendChild(el('<div class="who">Assistant</div>'));
      if (m.tools && m.tools.length) n.appendChild(el('<div class="wft-tools">' + m.tools.map(function (t) { return '<span>' + esc(toolLabel(t)) + '</span>'; }).join('') + '</div>'));
      var body = el('<div class="body">' + md(m.text) + '</div>'); n.appendChild(body);
      (m.changes || []).forEach(function (c) { n.appendChild(changeCard(c)); });
      (m.restores || []).forEach(function (r) { n.appendChild(restoreCard(r)); });
      if (V.ttsReady && m.text) { var acts = el('<div class="wft-msg-actions"></div>'); acts.appendChild(V.listenButton(m.k, m.text)); n.appendChild(acts); }
    } else if (m.role === 'sys') {
      n.appendChild(el('<div class="body">' + esc(m.text) + '</div>'));
    } else if (m.role === 'err') {
      n.appendChild(el('<div class="body">' + esc(m.text) + '</div>'));
    }
    return n;
  }
  function toolLabel(name) {
    var t = String(name || '').replace(/^mcp__trainer__/, '');
    var map = {
      list_documents: 'Listing documents', get_document: 'Reading a document', search_documents: 'Searching documents',
      list_notes: 'Reading notes', get_note: 'Reading a note', list_uploads: 'Checking uploads', get_upload_text: 'Reading an upload',
      list_reports: 'Checking reports', set_report_status: 'Updating a report', find_conversations: 'Finding conversations',
      get_conversation: 'Reading a conversation', get_history: 'Reading the change log', get_change: 'Reading a change',
      list_checkpoints: 'Checking checkpoints', preview_restore: 'Previewing a restore', create_document: 'Adding a document',
      update_document: 'Updating a document', edit_document: 'Editing a document', delete_document: 'Removing a document',
      add_upload_to_library: 'Adding an upload to the library', create_note: 'Writing a note', update_note: 'Updating a note',
      delete_note: 'Removing a note', undo_change: 'Undoing a change', restore_to: 'Restoring', restore_document_version: 'Restoring a version',
      create_checkpoint: 'Creating a checkpoint', WebSearch: 'Searching the web', WebFetch: 'Reading a web page',
    };
    return map[t] || t.replace(/_/g, ' ');
  }
  /**
   * The assistant proposed a whole-knowledge-base restore; the person clicks it through here.
   * r.point is the wire point (event_id | checkpoint_id | at) posted back verbatim; r.head is the
   * ledger position the plan was made at — the server refuses (409) if the log moved since, and the
   * card then reads "stale" rather than restoring blind.
   */
  function restoreCard(r) {
    var n = el('<div class="wft-change restore' + (r.done ? ' undone' : '') + '"><span class="wft-num">RESTORE</span>' +
      '<div class="t">Restore everything to ' + esc(r.label) + '<small>' + plural(r.changes.length, 'file') + ': ' + esc(r.changes.slice(0, 6).map(function (c) { return (c.action === 'delete' ? 'remove ' : c.action === 'create' ? 'bring back ' : 'roll back ') + c.doc_id; }).join(', ')) + (r.changes.length > 6 ? ', …' : '') + '</small></div>' +
      '<button' + (r.done ? ' disabled' : '') + '>' + (r.done ? (r.stale ? 'Out of date' : 'Restored') : 'Restore now') + '</button></div>');
    var btn = q('button', n);
    if (!r.done) arm(btn, 'Yes, restore', function () {
      btn.disabled = true; btn.textContent = 'Restoring…';
      var body = Object.assign({}, r.point || {}, { expect_head: r.head, expect_changes: r.changes.length });
      api('/restore', { method: 'POST', json: body }).then(function (res) {
        r.done = true; persistChat(); n.classList.add('undone'); btn.textContent = 'Restored';
        toast('Restored to ' + res.label + ' (' + plural(res.events.length, 'change') + ').'); changed();
      }).catch(function (e) {
        if (e.status === 409) { r.done = true; r.stale = true; persistChat(); n.classList.add('undone'); btn.textContent = 'Out of date'; }
        else { btn.disabled = false; btn.textContent = 'Restore now'; }
        toast(e.message, { err: true });
      });
    });
    return n;
  }
  function changeCard(c) {
    var n = el('<div class="wft-change ' + esc(c.op) + (c.undone ? ' undone' : '') + '">' + num(c.event_id) +
      '<div class="t">' + esc(c.summary || (c.op + ' ' + c.doc_id)) + '<small>' + esc(c.kind === 'note' ? 'note' : 'document') + ' · ' + esc(c.doc_id) + '</small></div>' +
      '<button' + (c.undone ? ' disabled' : '') + '>' + (c.undone ? 'Undone' : 'Undo') + '</button></div>');
    var btn = q('button', n);
    if (!c.undone) {
      arm(btn, 'Undo now', function () {
        btn.disabled = true; btn.textContent = 'Undoing…';
        api('/history/' + c.event_id + '/undo', { method: 'POST', json: {} }).then(function (r) {
          c.undone = true; persistChat(); n.classList.add('undone'); btn.textContent = 'Undone';
          toast(r.alreadyThere ? 'That change was already undone.' : 'Undone (change № ' + r.event.id + ').'); changed();
        }).catch(function (e) { btn.disabled = false; btn.textContent = 'Undo'; toast(e.message, { err: true }); });
      });
    }
    return n;
  }
  function autosize() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'; }
  inputEl.addEventListener('input', autosize);
  inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', function () { if (chat.busy) { if (chat.abort) chat.abort.abort(); } else send(); });
  q('#wft-newchat').addEventListener('click', function (e) { e.preventDefault(); if (chat.busy) return; V.speakStop(); V.dictStop(); chat.messages = []; chat.sessionId = null; persistChat(); renderChat(); });
  q('#wft-attach-btn').addEventListener('click', function () { show('uploads'); toast('Pick a file in Uploads and choose "Discuss in chat".'); });

  function renderAttachRow() {
    attachRow.innerHTML = '';
    chat.pending.forEach(function (u) {
      var c = el('<span class="chip"><i class="fa fa-file-o"></i> ' + esc(u.filename) + ' <button title="Remove">×</button></span>');
      q('button', c).addEventListener('click', function () { chat.pending = chat.pending.filter(function (x) { return x.id !== u.id; }); renderAttachRow(); });
      attachRow.appendChild(c);
    });
  }
  function attachToChat(u) { if (!chat.pending.some(function (x) { return x.id === u.id; })) chat.pending.push({ id: u.id, filename: u.filename }); renderAttachRow(); inputEl.focus(); }
  function askAssistant(text) { inputEl.value = text; autosize(); inputEl.focus(); }

  // Send pressed while dictating: the button waits (spinner) for the last words, then the turn goes.
  var sendWaiting = false;
  function send() {
    if (chat.busy) return;
    if (V.dictBusy()) {
      // Still dictating: finish first so the utterance in flight lands in the composer, then send.
      if (sendWaiting) return;
      sendWaiting = true; sendBtn.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i>';
      V.dictFinish().then(function () { sendWaiting = false; if (!chat.busy) sendBtn.innerHTML = '<i class="fa fa-arrow-up"></i>'; send(); });
      return;
    }
    var text = inputEl.value.trim();
    if (!text) return;
    // Spoken in -> spoken out: a dictated message gets its reply read aloud (the engine remembers
    // whether the composer text came from the mic).
    V.noteSend();
    var files = chat.pending.slice();
    chat.messages.push({ role: 'user', text: text, files: files.map(function (f) { return f.filename; }), k: newKey() });
    var aiMsg = { role: 'ai', text: '', tools: [], changes: [], k: newKey() };
    chat.messages.push(aiMsg);
    inputEl.value = ''; autosize(); chat.pending = []; renderAttachRow();
    renderChat();
    var node = msgsEl.lastChild, body = q('.body', node), toolsEl = null;
    body.innerHTML = '<span class="wft-cursor"></span>';
    chat.busy = true; sendBtn.className = 'stop'; sendBtn.innerHTML = '<i class="fa fa-stop"></i>'; sendBtn.title = 'Stop';
    chat.abort = new AbortController();
    var touched = false;
    var turnStarted = Date.now();
    var spoken = V.turnBegin({ id: aiMsg.k }); // voice mode / dictated send: speak sentences as they stream; the reply's Listen button shows Stop once rendered

    function finish(errText, aborted) {
      chat.busy = false; sendBtn.className = 'send'; sendBtn.innerHTML = '<i class="fa fa-arrow-up"></i>'; sendBtn.title = 'Send';
      if (spoken) { if (errText || aborted) V.turnError(); else V.turnEnd(); }
      else if (errText || aborted) V.turnError();
      if (errText) { chat.messages.push({ role: 'err', text: errText }); }
      persistChat(); renderChat();
      if (!errText && !aborted) V.afterTurn(); // voice mode: read the reply (if not already spoken live), then listen again
      if (touched) changed();
      // Stopped mid-turn: a write the assistant had already started still lands (and is ledgered)
      // after the stream is gone, so its card never arrived. Pick those up from the ledger.
      if (aborted) setTimeout(collectMissedChanges, 1500);   // the in-flight write finishes after the stream closes
    }
    function collectMissedChanges() {
      api('/history?limit=20').then(function (r) {
        var seen = {}; (aiMsg.changes || []).forEach(function (c) { seen[c.event_id] = true; });
        var missed = r.events.filter(function (ev) {
          return !seen[ev.id] && String(ev.actor_user_id) === String(CFG.userId) && ev.via === 'chat' && new Date(ev.at).getTime() >= turnStarted - 5000;
        }).reverse();
        if (!missed.length) { changed(); return; }
        missed.forEach(function (ev) { aiMsg.changes.push({ event_id: ev.id, op: ev.op, kind: ev.kind, doc_id: ev.doc_id, summary: ev.summary, batch_id: ev.batch_id }); });
        persistChat(); renderChat(); changed();
      }).catch(function () { changed(); });
    }
    function onEvent(ev) {
      if (ev.type === 'session') { chat.sessionId = ev.sessionId; }
      else if (ev.type === 'delta') { aiMsg.text += ev.text; body.innerHTML = md(aiMsg.text) + '<span class="wft-cursor"></span>'; msgsEl.scrollTop = msgsEl.scrollHeight; if (spoken) V.turnDelta(ev.text); }
      else if (ev.type === 'tool') {
        aiMsg.tools.push(ev.name);
        if (!toolsEl) { toolsEl = el('<div class="wft-tools"></div>'); node.insertBefore(toolsEl, body); }
        qa('span', toolsEl).forEach(function (s) { s.classList.remove('on'); });
        toolsEl.appendChild(el('<span class="on">' + esc(toolLabel(ev.name)) + '</span>'));
      }
      else if (ev.type === 'change') { aiMsg.changes.push(ev.change); node.appendChild(changeCard(ev.change)); touched = true; msgsEl.scrollTop = msgsEl.scrollHeight; }
      else if (ev.type === 'restore') { aiMsg.restores = aiMsg.restores || []; aiMsg.restores.push(ev.request); node.appendChild(restoreCard(ev.request)); msgsEl.scrollTop = msgsEl.scrollHeight; }
      else if (ev.type === 'done') { aiMsg.text = ev.text || aiMsg.text; if (ev.sessionId) chat.sessionId = ev.sessionId; }
      else if (ev.type === 'error') { throw new Error(ev.message || 'assistant error'); }
    }
    fetch(API + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, signal: chat.abort.signal,
      body: JSON.stringify({ message: text, sessionId: chat.sessionId, uploadIds: files.map(function (f) { return f.id; }) }) })
      .then(function (r) {
        if (r.status === 401) return refreshToken().then(function () { throw new Error('Your session was refreshed — please send that again.'); });
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('request failed (' + r.status + ')')); });
        var reader = r.body.getReader(), dec = new TextDecoder(), bufS = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            bufS += dec.decode(res.value, { stream: true });
            var parts = bufS.split('\n\n'); bufS = parts.pop();
            parts.forEach(function (p) { var line = p.split('\n').find(function (l) { return l.indexOf('data: ') === 0; }); if (line) onEvent(JSON.parse(line.slice(6))); });
            return pump();
          });
        }
        return pump();
      })
      .then(function () { finish(null, false); })
      .catch(function (e) { if (chat.abort.signal.aborted) finish(null, true); else finish(e.message || 'The assistant is unavailable.', false); });
  }

  // ================================================================ LIBRARY
  var libEl = q('#wft-v-library');
  libEl.innerHTML =
    '<div class="wft-strip" id="wft-strip"></div>' +
    '<div class="wft-bar"><h2>Library</h2><span class="sub" id="wft-lib-sub"></span><span class="grow"></span>' +
    '  <div class="wft-seg" id="wft-lib-filter"><button data-f="all" class="on">All</button><button data-f="regulatory">Regulatory</button><button data-f="library">Added by Waterfind</button><button data-f="stale">Stale</button></div>' +
    '  <input class="wft-input search" id="wft-lib-q" placeholder="Search titles, ids, tags, summaries…">' +
    '  <button class="wft-btn primary" id="wft-lib-new"><i class="fa fa-plus"></i> New document</button></div>' +
    '<div class="wft-cols"><div class="wft-list" id="wft-lib-list"></div><div class="wft-detail" id="wft-lib-detail"></div></div>';
  qa('#wft-lib-filter button').forEach(function (b) { b.addEventListener('click', function () { qa('#wft-lib-filter button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); S.docFilter = b.getAttribute('data-f'); renderLibList(); }); });
  q('#wft-lib-q').addEventListener('input', function (e) { S.docQuery = e.target.value; renderLibList(); });
  q('#wft-lib-new').addEventListener('click', function () { S.docId = null; renderLibList(); docEditor(null); });

  function renderStrip() {
    var o = S.overview, s = q('#wft-strip'); if (!o) return;
    var c = o.counts;
    s.innerHTML = '';
    [
      { n: c.documents, l: c.regulatory + ' regulatory, ' + c.library + ' added', v: 'library', f: 'all' },
      { n: c.stale, l: 'stale (over a year)', v: 'library', f: 'stale', warn: c.stale > 0 },
      { n: c.notes, l: c.pinned + ' pinned', v: 'notes' },
      { n: c.uploads_waiting, l: 'uploads to add', v: 'uploads', warn: c.uploads_waiting > 0 },
      { n: c.open_reports, l: 'open reports', v: 'reports', warn: c.open_reports > 0 },
      c.external_changes > 0 ? { n: c.external_changes, l: 'changed outside the Trainer', v: 'history' } : null,
      o.git_commit_enabled && c.uncommitted > 0 ? { n: c.uncommitted, l: 'not yet in git', v: 'history', warn: true } : null,
    ].filter(Boolean).forEach(function (t) {
      var n = el('<div class="wft-tile' + (t.warn ? ' warn' : '') + '"><div class="n">' + t.n + '</div><div class="l">' + esc(t.l) + '</div></div>');
      n.addEventListener('click', function () { if (t.f) { S.docFilter = t.f; qa('#wft-lib-filter button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-f') === t.f); }); } show(t.v); });
      s.appendChild(n);
    });
    if (!o.notes_enabled) s.appendChild(el('<div class="wft-note err" style="margin:0">Notes are switched OFF on the server (kill switch) — pinned notes are not reaching the advisor.</div>'));
  }
  // Past its best-by = stale. best_by "never" is never stale; no best_by falls back to the old
  // 12-months-past-as_at rule (the server's implied TTL is 6 months, but the list chip stays lenient).
  /** A best-by picker: native date input pre-filled with the default (today + TTL) and a "never goes stale" toggle. */
  function bestByPicker(current) {
    var ttl = (ME && ME.refresh_ttl_days) || 180;
    var def = new Date(); def.setDate(def.getDate() + ttl);
    var never = current === 'never', date = /^d{4}-d{2}-d{2}$/.test(current || '') ? current : def.toISOString().slice(0, 10);
    var w = el('<div class="wft-row wft-bestby" style="align-items:flex-end;max-width:360px"><div class="wft-field" style="flex:0 0 170px"><label>Best by</label><input class="wft-input" type="date" data-f="bestby" value="' + date + '"' + (never ? ' disabled' : '') + '></div>' +
      '<label class="wft-never"><input type="checkbox" data-f="never"' + (never ? ' checked' : '') + '> Never goes stale</label></div>');
    q('[data-f=never]', w).addEventListener('change', function () { q('[data-f=bestby]', w).disabled = this.checked; });
    w.value = function () { return q('[data-f=never]', w).checked ? 'never' : q('[data-f=bestby]', w).value.trim(); };
    return w;
  }
  function bestBySpan(x, bold) {
    var v = x.best_by_effective || x.best_by; if (!v) return '';
    var label = v === 'never' ? (bold ? 'never' : 'never goes stale') : (bold ? esc(v) : 'best by ' + esc(v));
    return '<span' + (x.best_by !== 'never' && v !== 'never' && v <= today() ? ' class="wft-due"' : '') + '>' + (bold ? '<b>Best by</b> ' : '') + label + '</span>';
  }
  function isStale(d) {
    if (d.best_by === 'never') return false;
    if (d.best_by) return d.best_by <= today();
    if (!d.as_at) return false;
    var cut = new Date(); cut.setMonth(cut.getMonth() - 12); return new Date(d.as_at) < cut;
  }
  function renderLibrary() {
    renderStrip();
    api('/documents').then(function (r) { S.docs = r.documents; renderLibList(); var det = q('#wft-lib-detail'); if (S.docId && !q('.wft-editor', det)) openDoc(S.docId); })
      .catch(function (e) { q('#wft-lib-list').innerHTML = '<div class="wft-empty">' + esc(e.message) + '</div>'; });
  }
  function renderLibList() {
    var list = q('#wft-lib-list'), qq = S.docQuery.trim().toLowerCase();
    var docs = S.docs.filter(function (d) {
      if (S.docFilter === 'regulatory' && d.collection !== 'regulatory') return false;
      if (S.docFilter === 'library' && d.collection !== 'library') return false;
      if (S.docFilter === 'stale' && !isStale(d)) return false;
      if (qq && (d.title + ' ' + d.id + ' ' + d.summary + ' ' + d.tags + ' ' + d.jurisdiction + ' ' + d.instrument).toLowerCase().indexOf(qq) === -1) return false;
      return true;
    });
    q('#wft-lib-sub').textContent = plural(docs.length, 'document') + (S.docs.length !== docs.length ? ' of ' + S.docs.length : '');
    list.innerHTML = '';
    if (!docs.length) { list.appendChild(el('<div class="wft-empty">' + (S.docs.length ? 'No documents match' : 'No documents') + '</div>')); return; }
    var groups = {};
    docs.forEach(function (d) { var g = d.collection === 'regulatory' ? (d.jurisdiction || 'Regulatory') : 'Library'; (groups[g] = groups[g] || []).push(d); });
    Object.keys(groups).sort(function (a, b) { return a === 'Library' ? 1 : b === 'Library' ? -1 : a.localeCompare(b); }).forEach(function (g) {
      list.appendChild(el('<div class="wft-group">' + esc(g === 'Library' ? 'Library — added by Waterfind' : g + ' — regulatory') + '</div>'));
      groups[g].forEach(function (d) {
        var row = el('<button class="wft-rowi' + (d.id === S.docId ? ' on' : '') + '"><div class="t">' + esc(d.title) + (isStale(d) ? ' <span class="wft-chip warn">stale</span>' : '') + '</div><div class="s">' + esc(d.summary) + '</div>' +
          '<div class="m"><span class="mono">' + esc(d.id) + '</span><span>as at ' + esc(d.as_at || '?') + '</span>' + bestBySpan(d) + (d.source_file ? '<span><i class="fa fa-file-o"></i> ' + esc(d.source_file) + '</span>' : '') + '</div></button>');
        row.addEventListener('click', function () { openDoc(d.id); });
        list.appendChild(row);
      });
    });
  }
  function openDoc(id) {
    S.docId = id; qa('#wft-lib-list .wft-rowi').forEach(function (r) { r.classList.toggle('on', r.querySelector('.mono') && r.querySelector('.mono').textContent === id); });
    var det = q('#wft-lib-detail'); det.innerHTML = '<div class="wft-empty">Loading…</div>';
    api('/documents/' + encodeURIComponent(id)).then(function (d) { S.doc = d; renderDoc(d); }).catch(function (e) { det.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>'; });
  }
  function renderDoc(d) {
    var det = q('#wft-lib-detail');
    var isReg = d.collection === 'regulatory';
    var meta = [
      '<span class="wft-chip ' + (isReg ? 'reg' : 'lib') + '">' + (isReg ? 'regulatory' : 'library') + '</span>',
      d.jurisdiction ? '<span class="wft-chip jur">' + esc(d.jurisdiction) + '</span>' : '',
      isStale(d) ? '<span class="wft-chip warn">stale</span>' : '',
      '<span><code>' + esc(d.id) + '</code></span>',
      d.instrument ? '<span>' + esc(d.instrument) + '</span>' : '',
      '<span>as at ' + esc(d.as_at || '?') + '</span>',
      bestBySpan(d),
      d.source_file ? '<span><i class="fa fa-file-o"></i> ' + esc(d.source_file) + '</span>' : '',
      d.tags ? '<span>' + esc(d.tags) + '</span>' : '',
    ].filter(Boolean).join('');
    var body = d.body || '';
    // Fold the verbatim block of a library doc so the summary and key points read first.
    var vIdx = body.search(/^## Full text/m), main = vIdx > 0 ? body.slice(0, vIdx) : body, verb = vIdx > 0 ? body.slice(vIdx) : '';
    det.innerHTML =
      '<div class="wft-doc-head">' +
      '<div class="wft-actions" style="margin:0 0 10px"><button class="wft-btn" id="wft-doc-edit"><i class="fa fa-pencil"></i> Edit</button>' +
      '<button class="wft-btn" id="wft-doc-ask"><i class="fa fa-comment-o"></i> Ask the assistant</button>' +
      ((d.versions || []).length ? '<button class="wft-btn" id="wft-doc-hist"><i class="fa fa-history"></i> ' + plural(d.versions.length, 'change') + '</button>' : '') +
      '<span class="spacer"></span><button class="wft-btn danger" id="wft-doc-del"><i class="fa fa-trash-o"></i> Delete</button></div>' +
      '<h2>' + esc(d.title) + '</h2><div class="meta">' + meta + '</div>' +
      (d.summary ? '<p class="wft-doc-sum">' + esc(d.summary) + '</p>' : '') +
      (d.source_urls && d.source_urls.length ? '<div class="wft-doc-src">' + d.source_urls.map(function (u) { var host = u.replace(/^https?:\/\//, '').split('/')[0]; return '<span class="wft-src" title="' + esc(u) + '">' + safeLink(u, host) + '</span>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<div class="wft-md" id="wft-doc-md">' + md(main) + (verb ? '<div class="verbatim"><button class="wft-btn sm ghost" id="wft-doc-verb">Show the full original text (' + fmtBytes(verb.length) + ')</button><div id="wft-doc-verb-body" style="display:none"></div></div>' : '') + '</div>' +
      '<div id="wft-doc-versions"></div>';
    q('#wft-doc-edit').addEventListener('click', function () { docEditor(d); });
    q('#wft-doc-ask').addEventListener('click', function () { askAssistant('About the document "' + d.title + '" (id ' + d.id + '): '); });
    arm(q('#wft-doc-del'), 'Delete this document', function () {
      api('/documents/' + encodeURIComponent(d.id), { method: 'DELETE', json: { expected_hash: d.hash, why: 'Deleted from the Library tab' } }).then(function (r) {
        toast('Deleted "' + d.title + '" (change № ' + r.event.id + ').', { action: 'Undo', onAction: function () { undoEvent(r.event.id); } });
        S.docId = null; q('#wft-lib-detail').innerHTML = ''; changed();
      }).catch(function (e) { toast(e.message, { err: true }); });
    });
    if (verb) q('#wft-doc-verb').addEventListener('click', function () { var b = q('#wft-doc-verb-body'); if (b.style.display === 'none') { b.innerHTML = md(verb); b.style.display = ''; this.textContent = 'Hide the full original text'; } else { b.style.display = 'none'; this.textContent = 'Show the full original text (' + fmtBytes(verb.length) + ')'; } });
    if (q('#wft-doc-hist')) q('#wft-doc-hist').addEventListener('click', function () { var v = q('#wft-doc-versions'); if (v.children.length) { v.innerHTML = ''; return; } v.innerHTML = '<div class="wft-section-h">Changes to this document</div>'; d.versions.forEach(function (ev) { v.appendChild(eventRow(ev, { compact: true })); }); });
  }
  function undoEvent(id) {
    return api('/history/' + id + '/undo', { method: 'POST', json: {} }).then(function (r) { toast(r.alreadyThere ? 'Already undone.' : 'Undone (change № ' + r.event.id + ').'); changed(); }).catch(function (e) { toast(e.message, { err: true }); });
  }

  /** The document editor: named fields for the details everyone edits, markdown for the body. */
  function docEditor(d) {
    var det = q('#wft-lib-detail');
    var fm = d ? parseFm(d.content) : { meta: {}, order: [], urls: [], body: '' };
    var isNew = !d;
    var collection = d ? d.collection : 'library';
    var JUR = ['', 'CTH', 'NSW', 'VIC', 'SA', 'QLD', 'WA', 'TAS', 'CROSS'];
    det.innerHTML =
      '<div class="wft-editor"><h2 style="font-size:16px;margin-bottom:12px">' + (isNew ? 'New document' : 'Edit: ' + esc(d.title)) + '</h2>' +
      (isNew ? '<div class="wft-field"><label>Collection</label><div class="wft-seg" id="wft-ed-coll"><button data-c="library" class="on">Added by Waterfind</button><button data-c="regulatory">Regulatory</button></div></div>' : '') +
      '<div class="wft-row"><div class="wft-field"><label>Title</label><input class="wft-input" id="wft-ed-title" value="' + esc(fm.meta.title || '') + '"></div>' +
      '<div class="wft-field" style="flex:0 0 200px"><label>Id</label><input class="wft-input mono" id="wft-ed-id" value="' + esc(fm.meta.id || '') + '"' + (isNew ? '' : ' disabled') + '></div></div>' +
      '<div class="wft-field"><label>Summary</label><input class="wft-input" id="wft-ed-summary" value="' + esc(fm.meta.summary || '') + '"></div>' +
      '<div class="wft-row"><div class="wft-field" style="flex:0 0 130px"><label>Jurisdiction</label><select class="wft-select" id="wft-ed-jur">' + JUR.map(function (j) { return '<option value="' + j + '"' + ((fm.meta.jurisdiction || '') === j ? ' selected' : '') + '>' + (j || '—') + '</option>'; }).join('') + '</select></div>' +
      '<div class="wft-field" style="flex:0 0 130px"><label>Verified as at</label><input class="wft-input" id="wft-ed-asat" value="' + esc(fm.meta.as_at || today()) + '" placeholder="YYYY-MM-DD"></div>' +
      '<div class="wft-field" style="flex:0 0 150px"><label>Best by</label><input class="wft-input" id="wft-ed-bestby" value="' + esc(fm.meta.best_by || '') + '" placeholder="YYYY-MM-DD or never"></div>' +
      '<div class="wft-field"><label>Tags</label><input class="wft-input" id="wft-ed-tags" value="' + esc(fm.meta.tags || '') + '"></div></div>' +
      '<div class="wft-field"><label>Instrument</label><input class="wft-input" id="wft-ed-instr" value="' + esc(fm.meta.instrument || '') + '"></div>' +
      '<div class="wft-field"><label>Source URLs</label><textarea class="wft-textarea mono" id="wft-ed-urls" rows="3" wrap="off">' + esc(fm.urls.join('\n')) + '</textarea></div>' +
      '<div class="wft-field"><label>Body</label><textarea class="wft-textarea mono" id="wft-ed-body">' + esc(fm.body) + '</textarea></div>' +
      '<div class="wft-field"><label>What changed and why</label><input class="wft-input" id="wft-ed-why"></div>' +
      '<div id="wft-ed-err"></div>' +
      '<div class="wft-actions"><button class="wft-btn primary" id="wft-ed-save"><i class="fa fa-check"></i> ' + (isNew ? 'Add document' : 'Save changes') + '</button><button class="wft-btn" id="wft-ed-cancel">Cancel</button></div></div>';
    if (isNew) qa('#wft-ed-coll button').forEach(function (b) { b.addEventListener('click', function () { qa('#wft-ed-coll button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); collection = b.getAttribute('data-c'); }); });
    if (isNew) q('#wft-ed-title').addEventListener('input', function () { var idf = q('#wft-ed-id'); if (!idf.dataset.touched) idf.value = slug(this.value); });
    if (isNew) q('#wft-ed-id').addEventListener('input', function () { this.dataset.touched = '1'; });
    q('#wft-ed-cancel').addEventListener('click', function () { if (d) renderDoc(d); else q('#wft-lib-detail').innerHTML = ''; });
    q('#wft-ed-save').addEventListener('click', function () {
      var meta = Object.assign({}, fm.meta);
      meta.id = isNew ? slug(q('#wft-ed-id').value) : fm.meta.id;
      meta.title = q('#wft-ed-title').value.trim(); meta.summary = q('#wft-ed-summary').value.trim();
      meta.jurisdiction = q('#wft-ed-jur').value; meta.instrument = q('#wft-ed-instr').value.trim();
      meta.as_at = q('#wft-ed-asat').value.trim(); meta.best_by = q('#wft-ed-bestby').value.trim(); meta.tags = q('#wft-ed-tags').value.trim();
      var urls = q('#wft-ed-urls').value.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      var content = buildFm(meta, urls, q('#wft-ed-body').value, fm.order);
      var why = q('#wft-ed-why').value.trim();
      var errEl = q('#wft-ed-err'); errEl.innerHTML = '';
      var p = isNew
        ? api('/documents', { method: 'POST', json: { id: meta.id, collection: collection, jurisdiction: meta.jurisdiction, content: content, why: why } })
        : api('/documents/' + encodeURIComponent(meta.id), { method: 'PUT', json: { content: content, expected_hash: d.hash, why: why } });
      this.disabled = true;
      p.then(function (r) { toast((isNew ? 'Added' : 'Saved') + ' "' + meta.title + '" (change № ' + r.event.id + ').', { action: 'Undo', onAction: function () { undoEvent(r.event.id); } }); S.docId = meta.id; changed(); openDoc(meta.id); })
        .catch(function (e) { errEl.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>'; q('#wft-ed-save').disabled = false; });
    });
  }

  // ================================================================ NOTES
  var notesEl = q('#wft-v-notes');
  notesEl.innerHTML =
    '<div class="wft-bar"><h2>Notes</h2><span class="sub" id="wft-notes-sub"></span><span class="grow"></span><input class="wft-input search" id="wft-notes-q" placeholder="Search notes…"><button class="wft-btn primary" id="wft-notes-new"><i class="fa fa-plus"></i> New note</button></div>' +
    '<div class="wft-scroll"><div id="wft-notes-form"></div><div id="wft-notes-list" style="max-width:860px"></div></div>';
  q('#wft-notes-new').addEventListener('click', function () { noteForm(null); });
  q('#wft-notes-q').addEventListener('input', function () { renderNotesList(); });
  function renderNotes() {
    api('/notes').then(function (r) { S.notes = r.notes; S.pinned = r.pinned; S.notesEnabled = r.enabled; renderNotesList(); }).catch(function (e) { q('#wft-notes-list').innerHTML = '<div class="wft-empty">' + esc(e.message) + '</div>'; });
  }
  function renderNotesList() {
    var list = q('#wft-notes-list'), qq = q('#wft-notes-q').value.trim().toLowerCase();
    q('#wft-notes-sub').innerHTML = plural(S.notes.length, 'note') + ' · ' + S.pinned + ' pinned' + (S.notesEnabled === false ? ' <span class="wft-chip danger">notes switched off on the server</span>' : '');
    list.innerHTML = '';
    var notes = S.notes.filter(function (n) { return !qq || (n.title + ' ' + n.text + ' ' + n.scope + ' ' + n.triggers.join(' ')).toLowerCase().indexOf(qq) !== -1; });
    if (!notes.length) { list.appendChild(el('<div class="wft-empty">' + (S.notes.length ? 'No notes match' : 'No notes') + '</div>')); return; }
    notes.sort(function (a, b) { return (a.mode === 'pin' ? 0 : 1) - (b.mode === 'pin' ? 0 : 1) || a.title.localeCompare(b.title); });
    notes.forEach(function (n) {
      var c = el('<div class="wft-note-card"><div class="h"><b>' + esc(n.title) + '</b><span class="wft-chip ' + (n.mode === 'pin' ? 'pin' : 'ret') + '">' + (n.mode === 'pin' ? 'always' : 'when relevant') + '</span><span class="grow"></span><span class="mono" style="color:var(--ink-3);font-size:11px">' + esc(n.id) + '</span></div>' +
        '<div class="txt">' + esc(n.text) + '</div>' +
        '<div class="m">' + (n.scope ? '<span><b>Scope</b> ' + esc(n.scope) + '</span>' : '') + (n.triggers.length ? '<span><b>Triggers</b> ' + esc(n.triggers.join(', ')) + '</span>' : '') + '<span><b>As at</b> ' + esc(n.as_at) + '</span>' + bestBySpan(n, true) + (n.source_urls.length ? '<span><b>Sources</b> ' + n.source_urls.map(function (u) { return safeLink(u, u.replace(/^https?:\/\//, '').split('/')[0]); }).join(', ') + '</span>' : '') + '</div>' +
        '<div class="a"><button class="wft-btn sm" data-a="edit"><i class="fa fa-pencil"></i> Edit</button><button class="wft-btn sm" data-a="pin">' + (n.mode === 'pin' ? '<i class="fa fa-thumb-tack"></i> Unpin' : '<i class="fa fa-thumb-tack"></i> Pin') + '</button><button class="wft-btn sm ghost" data-a="ask"><i class="fa fa-comment-o"></i> Ask the assistant</button><span style="flex:1"></span><button class="wft-btn sm danger" data-a="del"><i class="fa fa-trash-o"></i> Delete</button></div></div>');
      q('[data-a=edit]', c).addEventListener('click', function () { noteForm(n); });
      q('[data-a=ask]', c).addEventListener('click', function () { askAssistant('About the note "' + n.title + '" (id ' + n.id + '): '); });
      q('[data-a=pin]', c).addEventListener('click', function () {
        api('/notes/' + encodeURIComponent(n.id), { method: 'PUT', json: { mode: n.mode === 'pin' ? 'retrieve' : 'pin', why: (n.mode === 'pin' ? 'Unpinned' : 'Pinned') + ' the note "' + n.title + '"' } })
          .then(function (r) { toast((n.mode === 'pin' ? 'Unpinned' : 'Pinned') + ' (change № ' + r.event.id + ').'); changed(); }).catch(function (e) { toast(e.message, { err: true }); });
      });
      arm(q('[data-a=del]', c), 'Delete this note', function () {
        api('/notes/' + encodeURIComponent(n.id), { method: 'DELETE', json: { why: 'Deleted from the Notes tab' } })
          .then(function (r) { toast('Deleted "' + n.title + '" (change № ' + r.event.id + ').', { action: 'Undo', onAction: function () { undoEvent(r.event.id); } }); changed(); }).catch(function (e) { toast(e.message, { err: true }); });
      });
      list.appendChild(c);
    });
  }
  function noteForm(n) {
    var f = q('#wft-notes-form');
    var mode = n ? n.mode : 'retrieve';
    f.innerHTML = '<div class="wft-note-form"><h3 style="font-size:14px;margin-bottom:10px">' + (n ? 'Edit note' : 'New note') + '</h3>' +
      '<div class="wft-row"><div class="wft-field"><label>Title</label><input class="wft-input" id="wft-nf-title" value="' + esc(n ? n.title : '') + '"></div>' +
      '<div class="wft-field" style="flex:0 0 200px"><label>Delivery</label><div class="wft-seg" id="wft-nf-mode"><button data-m="retrieve"' + (mode === 'retrieve' ? ' class="on"' : '') + '>When relevant</button><button data-m="pin"' + (mode === 'pin' ? ' class="on"' : '') + '>Always</button></div></div></div>' +
      '<div class="wft-field"><label>Note</label><textarea class="wft-textarea" id="wft-nf-text" rows="4" maxlength="700">' + esc(n ? n.text : '') + '</textarea></div>' +
      '<div class="wft-row"><div class="wft-field"><label>Scope</label><input class="wft-input" id="wft-nf-scope" value="' + esc(n ? n.scope : '') + '"></div>' +
      '<div class="wft-field"><label>Triggers</label><input class="wft-input" id="wft-nf-trig" value="' + esc(n ? n.triggers.join(', ') : '') + '"></div>' +
      '<div class="wft-field" style="flex:0 0 150px"><label>Best by</label><input class="wft-input" id="wft-nf-bestby" value="' + esc(n ? n.best_by || '' : '') + '" placeholder="YYYY-MM-DD or never"></div></div>' +
      '<div class="wft-field"><label>Source URLs</label><textarea class="wft-textarea mono" id="wft-nf-urls" rows="2">' + esc(n ? n.source_urls.join('\n') : '') + '</textarea></div>' +
      '<div class="wft-field"><label>Why</label><input class="wft-input" id="wft-nf-why"></div>' +
      '<div id="wft-nf-err"></div><div class="wft-actions"><button class="wft-btn primary" id="wft-nf-save"><i class="fa fa-check"></i> ' + (n ? 'Save note' : 'Add note') + '</button><button class="wft-btn" id="wft-nf-cancel">Cancel</button></div></div>';
    qa('#wft-nf-mode button').forEach(function (b) { b.addEventListener('click', function () { qa('#wft-nf-mode button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); mode = b.getAttribute('data-m'); }); });
    q('#wft-nf-cancel').addEventListener('click', function () { f.innerHTML = ''; });
    q('#wft-nf-save').addEventListener('click', function () {
      var body = { title: q('#wft-nf-title').value.trim(), text: q('#wft-nf-text').value.trim(), mode: mode, scope: q('#wft-nf-scope').value.trim(),
        triggers: q('#wft-nf-trig').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        source_urls: q('#wft-nf-urls').value.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean),
        best_by: q('#wft-nf-bestby').value.trim(), why: q('#wft-nf-why').value.trim() };
      var errEl = q('#wft-nf-err'); errEl.innerHTML = ''; this.disabled = true;
      var p = n ? api('/notes/' + encodeURIComponent(n.id), { method: 'PUT', json: body }) : api('/notes', { method: 'POST', json: body });
      p.then(function (r) { toast((n ? 'Saved' : 'Added') + ' note (change № ' + r.event.id + ').', { action: 'Undo', onAction: function () { undoEvent(r.event.id); } }); f.innerHTML = ''; changed(); })
        .catch(function (e) { errEl.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>'; q('#wft-nf-save').disabled = false; });
    });
    q('#wft-nf-title').focus();
  }

  // ================================================================ COSTS
  // What the system costs to run, from the spend ledger (one row per vendor event — src/spend.ts).
  // Vendor-reported figures are shown as-is; list-price estimates (OpenAI audio/TTS, Messages-API
  // tokens) carry a ≈. All figures USD, days bucketed in the CRM's zone.
  var costEl = q('#wft-v-costs');
  costEl.innerHTML =
    '<div class="wft-bar"><h2>Costs</h2><span class="sub">USD</span><span class="grow"></span>' +
    '  <div class="wft-seg" id="wft-cost-win"><button data-d="7">7 days</button><button data-d="30" class="on">30 days</button><button data-d="90">90 days</button></div></div>' +
    '<div class="wft-scroll"><div id="wft-cost-body" style="max-width:980px"></div></div>';
  var COST_LABELS = {
    chat: 'AI Advisor', assist: 'AI Advisor · broker (client page)', titler: 'AI Advisor · chat titles',
    call_note_stt: 'Call notes · transcription', call_note_draft: 'Call notes · drafting',
    dictation: 'Dictation', tts: 'Spoken replies',
    voice_call: 'Phone calls · Retell', voice_agent: 'Phone calls · model',
    trainer_chat: 'Trainer assistant', trainer_annotate: 'Upload annotation', kb_refresh: 'Knowledge refresh',
  };
  var costDays = 30;
  /** est: true, or the estimated portion of n — marks ≈ only when that portion is at least 1% of n. */
  function usd(n, est) {
    if (n == null) return '—';
    if (typeof est === 'number') est = est > 0 && Math.abs(n) > 0 && est / Math.abs(n) >= 0.01;
    var a = Math.abs(n), s = '$' + (a > 0 && a < 0.01 ? n.toFixed(4) : n.toFixed(2));
    return (est ? '≈' : '') + s;
  }
  function qty(n, unit) {
    if (n == null) return '';
    if (unit === 'seconds') return n >= 3600 ? (n / 3600).toFixed(1) + ' h' : n >= 90 ? Math.round(n / 60) + ' min' : Math.round(n) + ' s';
    if (unit === 'chars') return n >= 1000 ? (n / 1000).toFixed(1) + 'k chars' : Math.round(n) + ' chars';
    if (unit === 'tokens') return n >= 1000 ? (n / 1000).toFixed(1) + 'k tokens' : Math.round(n) + ' tokens';
    return String(n);
  }
  function tr(html) { var r = document.createElement('tr'); r.innerHTML = html; return r; }
  function dayLabel(day) { return new Date(day + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
  qa('#wft-cost-win button').forEach(function (b) {
    b.addEventListener('click', function () { qa('#wft-cost-win button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); costDays = +b.getAttribute('data-d'); renderCosts(); });
  });
  function renderCosts() {
    api('/spend?days=' + costDays).then(renderCostBody)
      .catch(function (e) { q('#wft-cost-body').innerHTML = '<div class="wft-empty">' + esc(e.message) + '</div>'; });
  }
  function renderCostBody(r) {
    var body = q('#wft-cost-body'); body.innerHTML = '';
    var t = r.totals;
    var strip = el('<div class="wft-strip" style="padding:0 0 14px"></div>');
    [{ n: t.today, e: t.today_estimated, l: 'today' }, { n: t.d7, e: t.d7_estimated, l: '7 days' }, { n: t.d30, e: t.d30_estimated, l: '30 days' }, { n: t.all, e: t.all_estimated, l: 'all time' }]
      .forEach(function (x) { strip.appendChild(el('<div class="wft-tile" style="cursor:default"><div class="n">' + esc(usd(x.n, x.e)) + '</div><div class="l">' + esc(x.l) + '</div></div>')); });
    body.appendChild(strip);

    // per day: one column per day of the window, hover for the source split
    var max = r.daily.reduce(function (m, d) { return Math.max(m, d.usd); }, 0);
    var chart = el('<div class="wft-cost-panel"><div class="h"><b>Per day</b><span class="sub">' + esc(usd(t.window, t.window_estimated) + ' over ' + plural(r.days, 'day')) + '</span></div><div class="wft-cost-chart"></div><div class="wft-cost-xlab"></div></div>');
    var ch = q('.wft-cost-chart', chart), lab = q('.wft-cost-xlab', chart);
    var step = r.days <= 14 ? 1 : r.days <= 45 ? 7 : 14;
    r.daily.forEach(function (d, i) {
      var h = max > 0 && d.usd > 0 ? Math.max(2, Math.round(d.usd / max * 100)) : 0;
      var lines = Object.keys(d.by_source).sort(function (a, b) { return d.by_source[b] - d.by_source[a]; })
        .map(function (k) { return (COST_LABELS[k] || k) + ' ' + usd(d.by_source[k]); });
      ch.appendChild(el('<div class="col" title="' + esc(dayLabel(d.day) + ' ' + usd(d.usd) + (lines.length ? '\n' + lines.join('\n') : '')) + '"><i style="height:' + h + '%"></i></div>'));
      var last = r.daily.length - 1, show = i === last || (last - i) % step === 0;
      lab.appendChild(el('<span>' + (show ? esc(dayLabel(d.day)) : '') + '</span>'));
    });
    body.appendChild(chart);

    var src = el('<div class="wft-cost-panel"><div class="h"><b>By source</b></div><table class="wft-table"><thead><tr><th>Source</th><th>Vendor</th><th>Model</th><th class="r">Events</th><th class="r">Volume</th><th class="r">' + esc(plural(r.days, 'day')) + '</th><th class="r">All time</th></tr></thead><tbody></tbody></table></div>');
    var tb = q('tbody', src);
    if (!r.sources.length) tb.appendChild(tr('<td colspan="7" class="wft-empty">No spend recorded</td>'));
    r.sources.forEach(function (s) {
      tb.appendChild(tr('<td>' + esc(COST_LABELS[s.source] || s.source) + '</td><td>' + esc(s.vendor) + '</td><td class="m">' + esc(s.models.join(', ')) + '</td>' +
        '<td class="r">' + s.events + '</td><td class="r">' + esc(qty(s.quantity, s.unit)) + '</td><td class="r">' + esc(usd(s.window_usd, s.window_estimated_usd)) + '</td><td class="r">' + esc(usd(s.all_usd)) + '</td>'));
    });
    body.appendChild(src);

    var rec = el('<div class="wft-cost-panel"><div class="h"><b>Recent</b></div><table class="wft-table"><thead><tr><th>When</th><th>Source</th><th>Model</th><th class="r">Volume</th><th class="r">Cost</th><th>Who</th></tr></thead><tbody></tbody></table></div>');
    var rb = q('tbody', rec);
    if (!r.recent.length) rb.appendChild(tr('<td colspan="6" class="wft-empty">No spend recorded</td>'));
    r.recent.forEach(function (e) {
      rb.appendChild(tr('<td title="' + esc(fmtWhen(e.at)) + '">' + esc(ago(e.at)) + '</td><td>' + esc(COST_LABELS[e.source] || e.source) + '</td><td class="m">' + esc(e.model || '') + '</td>' +
        '<td class="r">' + esc(qty(e.quantity, e.unit)) + '</td><td class="r">' + esc(usd(e.cost_usd, e.estimated)) + '</td><td>' + esc(e.by_name || '') + '</td>'));
    });
    body.appendChild(rec);
  }

  // ================================================================ QUESTIONS
  // The default questions offered on an empty new chat — one list per audience ('broker' = the
  // Client Rail on the CRM client page, 'client' = the client's own AI Advisor tab). Saving serves
  // the lists immediately; the chat pages use their built-ins only while nothing is stored.
  var qsEl = q('#wft-v-questions');
  qsEl.innerHTML =
    '<div class="wft-bar"><h2>Questions</h2><span class="sub" id="wft-qs-sub"></span><span class="grow"></span><button class="wft-btn primary" id="wft-qs-save"><i class="fa fa-check"></i> Save</button></div>' +
    '<div class="wft-scroll"><div id="wft-qs-err" style="max-width:860px"></div><div id="wft-qs-lists" style="max-width:860px"></div></div>';
  var QS_AUDIENCES = [
    { key: 'broker', title: 'Brokers', where: 'new chat on a client page' },
    { key: 'client', title: 'Clients', where: 'new chat in the AI Advisor' },
  ];
  var qsDraft = null;   // { broker: {questions, version, by_name, updated_at}, client: {…} } — inputs edit this in place
  var qsDirty = false;  // unsaved edits: re-renders keep the draft instead of refetching over it
  function renderQuestions() {
    if (qsDirty && qsDraft) { renderQuestionLists(); return; }
    api('/default-questions').then(function (r) { qsDraft = r; qsDirty = false; renderQuestionLists(); })
      .catch(function (e) { q('#wft-qs-lists').innerHTML = '<div class="wft-empty">' + esc(e.message) + '</div>'; });
  }
  function renderQuestionLists(focusKey) {
    var wrap = q('#wft-qs-lists'); wrap.innerHTML = '';
    q('#wft-qs-sub').textContent = plural(qsDraft.broker.questions.length + qsDraft.client.questions.length, 'question');
    QS_AUDIENCES.forEach(function (a) {
      var set = qsDraft[a.key];
      var p = el('<div class="wft-qs-panel"><div class="h"><b>' + esc(a.title) + '</b><span class="sub">' + esc(a.where) + '</span><span class="grow"></span><span class="sub">' +
        (set.version ? esc((set.by_name ? set.by_name + ' · ' : '') + ago(set.updated_at)) : 'built-in defaults') + '</span></div>' +
        '<div class="rows"></div><button class="wft-btn sm" data-a="add"><i class="fa fa-plus"></i> Add question</button></div>');
      var rows = q('.rows', p);
      if (!set.questions.length) rows.appendChild(el('<div class="wft-empty" style="padding:8px 0;text-align:left">No questions</div>'));
      set.questions.forEach(function (text, i) {
        var row = el('<div class="wft-qs-row"><input class="wft-input" maxlength="500">' +
          '<button class="wft-btn sm ghost" data-a="up" title="Move up"><i class="fa fa-arrow-up"></i></button>' +
          '<button class="wft-btn sm ghost" data-a="down" title="Move down"><i class="fa fa-arrow-down"></i></button>' +
          '<button class="wft-btn sm ghost" data-a="rm" title="Remove"><i class="fa fa-times"></i></button></div>');
        var inp = q('input', row); inp.value = text;
        inp.addEventListener('input', function () { set.questions[i] = inp.value; qsDirty = true; });
        q('[data-a=up]', row).disabled = i === 0;
        q('[data-a=down]', row).disabled = i === set.questions.length - 1;
        q('[data-a=up]', row).addEventListener('click', function () { set.questions.splice(i - 1, 0, set.questions.splice(i, 1)[0]); qsDirty = true; renderQuestionLists(); });
        q('[data-a=down]', row).addEventListener('click', function () { set.questions.splice(i + 1, 0, set.questions.splice(i, 1)[0]); qsDirty = true; renderQuestionLists(); });
        q('[data-a=rm]', row).addEventListener('click', function () { set.questions.splice(i, 1); qsDirty = true; renderQuestionLists(); });
        rows.appendChild(row);
      });
      q('[data-a=add]', p).addEventListener('click', function () { set.questions.push(''); qsDirty = true; renderQuestionLists(a.key); });
      wrap.appendChild(p);
      if (focusKey === a.key) { var inps = qa('.wft-qs-row input', p); if (inps.length) inps[inps.length - 1].focus(); }
    });
  }
  q('#wft-qs-save').addEventListener('click', function () {
    if (!qsDraft) return;
    var btn = this, errEl = q('#wft-qs-err'); errEl.innerHTML = '';
    var body = {};
    QS_AUDIENCES.forEach(function (a) {
      body[a.key] = { questions: qsDraft[a.key].questions.map(function (s) { return s.trim(); }).filter(Boolean), version: qsDraft[a.key].version };
    });
    btn.disabled = true;
    api('/default-questions', { method: 'PUT', json: body }).then(function (r) {
      btn.disabled = false;
      qsDraft = { broker: r.broker, client: r.client }; qsDirty = false;
      renderQuestionLists();
      toast('Saved — new chats now offer these questions.');
    }).catch(function (e) {
      btn.disabled = false;
      errEl.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>';
      if (e.status === 409) { qsDirty = false; renderQuestions(); }
    });
  });

  // ================================================================ UPLOADS
  var upEl = q('#wft-v-uploads');
  upEl.innerHTML =
    '<div class="wft-bar"><h2>Uploads</h2><span class="sub" id="wft-up-sub"></span><span class="grow"></span><label class="wft-btn primary" for="wft-up-file"><i class="fa fa-cloud-upload"></i> Upload files</label><input type="file" id="wft-up-file" multiple style="display:none"></div>' +
    '<div class="wft-scroll"><div class="wft-drop" id="wft-drop"><b>Drop files here</b></div><div id="wft-up-progress" style="max-width:900px"></div><div id="wft-up-list" style="max-width:900px"></div></div>';
  var drop = q('#wft-drop');
  ['dragenter', 'dragover'].forEach(function (evn) { drop.addEventListener(evn, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (evn) { drop.addEventListener(evn, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { uploadFiles(e.dataTransfer.files); });
  q('#wft-up-file').addEventListener('change', function (e) { uploadFiles(e.target.files); e.target.value = ''; });
  function uploadFiles(files) {
    Array.prototype.forEach.call(files, function (file) {
      var note = el('<div class="wft-note info">Uploading ' + esc(file.name) + ' (' + fmtBytes(file.size) + ')…</div>'); q('#wft-up-progress').appendChild(note);
      fetch(API + '/uploads', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'upload failed'); return j; }); })
        .then(function (j) { note.remove(); toast(j.duplicate ? 'That exact file was already uploaded.' : 'Uploaded ' + file.name + '.'); renderUploads(); refreshCounts(); })
        .catch(function (e) { note.className = 'wft-note err'; note.textContent = file.name + ': ' + e.message; });
    });
  }
  function renderUploads() {
    api('/uploads').then(function (r) { S.uploads = r.uploads; renderUploadList(); }).catch(function (e) { q('#wft-up-list').innerHTML = '<div class="wft-empty">' + esc(e.message) + '</div>'; });
  }
  function renderUploadList() {
    var list = q('#wft-up-list'); list.innerHTML = '';
    var waiting = S.uploads.filter(function (u) { return !u.doc_id; }).length; q('#wft-up-sub').textContent = S.uploads.length ? plural(S.uploads.length, 'file') + (waiting ? ' · ' + waiting + ' to add' : '') : '';
    if (!S.uploads.length) { list.appendChild(el('<div class="wft-empty">No uploads</div>')); return; }
    S.uploads.forEach(function (u) { list.appendChild(uploadCard(u)); });
  }
  function uploadCard(u) {
    var status = u.doc_id ? '<span class="wft-chip live"><i class="fa fa-check"></i> in the library</span>'
      : u.text_status === 'ok' ? '<span class="wft-chip">text extracted' + (u.text_chars ? ', ' + fmtBytes(u.text_chars) : '') + '</span>'
      : u.text_status === 'empty' ? '<span class="wft-chip warn">no text layer — the pages will be read directly</span>'
      : u.text_status === 'unsupported' ? '<span class="wft-chip warn">' + esc(u.text_note || 'unsupported') + '</span>'
      : '<span class="wft-chip danger">' + esc(u.text_note || 'could not read') + '</span>';
    var canIngest = !u.doc_id && (u.text_status === 'ok' || (u.text_status === 'empty' && /\.pdf$/i.test(u.filename)));
    var c = el('<div class="wft-up"><div><div class="t">' + esc(u.filename) + ' ' + status + '</div><div class="s">' + fmtBytes(u.bytes) + ' · ' + esc(u.by_name || '') + ' · ' + esc(ago(u.uploaded_at)) + (u.text_note && u.text_status === 'ok' ? ' · ' + esc(u.text_note) : '') + '</div></div>' +
      '<div class="a">' + (u.doc_id ? '<button class="wft-btn sm" data-a="open"><i class="fa fa-book"></i> Open in Library</button>' : '') +
      (canIngest ? '<button class="wft-btn sm primary" data-a="ingest"><i class="fa fa-plus"></i> Add to library</button>' : '') +
      ((u.file_present !== false || u.text_status === 'ok') ? '<button class="wft-btn sm" data-a="chat"><i class="fa fa-comment-o"></i> Discuss in chat</button>' : '') +
      (u.text_status === 'ok' ? '<button class="wft-btn sm ghost" data-a="text">Text</button>' : '') +
      // The bytes live on the host that took the upload (not in git); a document written from them
      // carries the full text, so a redeployed host offers the text and the document, not the file.
      (u.file_present !== false ? '<button class="wft-btn sm ghost" data-a="file">Open file</button>' : '') +
      '<button class="wft-btn sm ghost" data-a="rm" title="Remove from this list">Remove</button></div></div>');
    if (u.doc_id) q('[data-a=open]', c).addEventListener('click', function () { S.docId = u.doc_id; show('library'); openDoc(u.doc_id); });
    var chatBtn = q('[data-a=chat]', c);
    if (chatBtn) chatBtn.addEventListener('click', function () { attachToChat(u); toast('Attached to your next message.'); });
    var fileBtn = q('[data-a=file]', c);
    if (fileBtn) fileBtn.addEventListener('click', function () {
      fetch(API + '/uploads/' + u.id + '/file', { headers: { 'Authorization': 'Bearer ' + token } }).then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('could not open the file (' + r.status + ')')); });
        var ct = r.headers.get('content-type') || 'application/octet-stream';
        return r.blob().then(function (b) {
          var blob = new Blob([b], { type: /^(application\/pdf|image\/)/.test(ct) ? ct : 'application/octet-stream' });
          var url = URL.createObjectURL(blob);
          if (/^(application\/pdf|image\/)/.test(ct)) { window.open(url, '_blank'); return; }
          var a = document.createElement('a'); a.href = url; a.download = u.filename; document.body.appendChild(a); a.click(); a.remove();
        });
      }).catch(function (e) { toast(e.message || 'Could not open the file.', { err: true }); });
    });
    q('[data-a=rm]', c).addEventListener('click', function () { api('/uploads/' + u.id + '/dismiss', { method: 'POST', json: { dismissed: true } }).then(function () { renderUploads(); refreshCounts(); }); });
    var tb = q('[data-a=text]', c);
    if (tb) tb.addEventListener('click', function () { var ex = q('.wft-uptext', c); if (ex) { ex.remove(); return; } api('/uploads/' + u.id).then(function (full) { c.appendChild(el('<div class="wft-uptext">' + esc(full.text || '') + '</div>')); }); });
    var ib = q('[data-a=ingest]', c);
    if (ib) ib.addEventListener('click', function () {
      if (q('textarea', c)) { runIngest(); return; }
      c.appendChild(el('<textarea class="wft-textarea" rows="2" placeholder="Hints for the annotation (optional)"></textarea>'));
      var picker = bestByPicker(''); picker.style.marginTop = '6px'; c.appendChild(picker);
      q('textarea', c).focus(); ib.innerHTML = '<i class="fa fa-check"></i> Add now';
      function runIngest() {
        var hints = q('textarea', c).value.trim(), bestBy = picker.value();
        c.classList.add('busy'); ib.disabled = true; c.appendChild(el('<div class="prog"><i class="fa fa-spinner fa-spin"></i> Reading and annotating…</div>'));
        api('/uploads/' + u.id + '/ingest', { method: 'POST', json: { hints: hints, best_by: bestBy } }).then(function (r) {
          toast('Added "' + r.annotation.title + '" to the library (change № ' + r.event.id + ').', { action: 'Open', onAction: function () { S.docId = r.document_id; show('library'); openDoc(r.document_id); } });
          changed();
        }).catch(function (e) { c.classList.remove('busy'); ib.disabled = false; q('.prog', c).remove(); toast(e.message, { err: true }); });
      }
    });
    return c;
  }

  // ================================================================ REPORTS
  var repEl = q('#wft-v-reports');
  repEl.innerHTML =
    '<div class="wft-bar"><h2>Reports</h2><span class="sub" id="wft-rep-sub"></span><span class="grow"></span><div class="wft-seg" id="wft-rep-filter"><button data-f="open" class="on">Open</button><button data-f="all">All</button></div></div>' +
    '<div class="wft-scroll">' +
    '<div id="wft-rep-list" style="max-width:900px"></div>' +
    '<div class="wft-section-h" style="max-width:900px">Find a conversation</div><div class="wft-conv-search" style="max-width:900px"><input class="wft-input" id="wft-cs-client" placeholder="Client"><input class="wft-input" id="wft-cs-text" placeholder="Words in the messages" style="min-width:220px"><span style="display:inline-flex;gap:8px;white-space:nowrap"><input class="wft-input" id="wft-cs-from" type="date" title="from"><input class="wft-input" id="wft-cs-to" type="date" title="to"><button class="wft-btn" id="wft-cs-go"><i class="fa fa-search"></i> Find</button></span></div><div id="wft-cs-res" style="max-width:900px"></div></div>';
  qa('#wft-rep-filter button').forEach(function (b) { b.addEventListener('click', function () { qa('#wft-rep-filter button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); S.reportFilter = b.getAttribute('data-f'); renderReports(); }); });
  q('#wft-cs-go').addEventListener('click', findConversations);
  ['wft-cs-client', 'wft-cs-text'].forEach(function (id) { q('#' + id).addEventListener('keydown', function (e) { if (e.key === 'Enter') findConversations(); }); });
  function findConversations() {
    var p = new URLSearchParams();
    var cl = q('#wft-cs-client').value.trim(), tx = q('#wft-cs-text').value.trim(), fr = q('#wft-cs-from').value, to = q('#wft-cs-to').value;
    if (cl) p.set('client', cl); if (tx) p.set('text', tx); if (fr) p.set('from', fr); if (to) p.set('to', to + 'T23:59:59');
    var res = q('#wft-cs-res'); res.innerHTML = '<div class="wft-empty">Searching…</div>';
    api('/conversations?' + p.toString()).then(function (r) {
      res.innerHTML = '';
      if (!r.conversations.length) { res.innerHTML = '<div class="wft-empty">No conversations match.</div>'; return; }
      r.conversations.forEach(function (c) {
        var n = el('<div class="wft-conv"><div class="t">' + esc(c.client_name || ('user #' + c.client_uid)) + (c.kind === 'broker-assist' ? ' <span class="wft-chip">broker chat' + (c.staff_name ? ' · ' + esc(c.staff_name) : '') + '</span>' : '') + ' — ' + esc(c.title) + '</div><div class="s">' + plural(c.messages, 'message') + ' · last ' + esc(ago(c.last_at)) + (c.matched_excerpt ? ' · “' + esc(c.matched_excerpt) + '”' : c.first_question ? ' · “' + esc(c.first_question) + '”' : '') + '</div><div class="x"></div></div>');
        n.addEventListener('click', function (e) { if (e.target.closest('.x')) return; var x = q('.x', n); if (x.children.length) { x.innerHTML = ''; return; } showTranscript(c.id, null, x); });
        res.appendChild(n);
      });
    }).catch(function (e) { res.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>'; });
  }
  function showTranscript(convId, aroundMsg, into, purpose) {
    into.innerHTML = '<div class="wft-empty">Loading…</div>';
    api('/conversations/' + convId + (aroundMsg ? '?around=' + aroundMsg + '&purpose=' + encodeURIComponent(purpose || 'report-view') : '?purpose=' + encodeURIComponent(purpose || 'manual-view'))).then(function (t) {
      into.innerHTML = '<div class="wft-xchg">' + (t.truncated ? '<div class="sub" style="color:var(--ink-3);font-size:12px">Earlier messages not shown.</div>' : '') +
        t.messages.map(function (m) { return '<div class="wft-turn' + (m.reported || (aroundMsg && m.id === aroundMsg) ? ' flag' : '') + '"><div class="r">' + (m.role === 'user' ? 'Client' : m.role === 'assistant' ? 'Advisor' : 'System') + ' · ' + esc(fmtWhen(m.at)) + (m.reported ? ' · reported: ' + esc(m.reported) : '') + '</div><div class="b">' + esc(m.content) + '</div></div>'; }).join('') +
        '<div class="wft-actions"><button class="wft-btn sm ghost" data-a="ask"><i class="fa fa-comment-o"></i> Ask the assistant to look at this conversation</button></div></div>';
      q('[data-a=ask]', into).addEventListener('click', function () { askAssistant('Look at conversation #' + convId + (aroundMsg ? ' around message #' + aroundMsg : '') + '. What did the advisor get wrong, and what should we change so it does not happen again?'); });
    }).catch(function (e) { into.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>'; });
  }
  function renderReports() {
    api('/reports' + (S.reportFilter === 'open' ? '?status=open' : '')).then(function (r) {
      S.reports = r.reports; var list = q('#wft-rep-list'); list.innerHTML = '';
      q('#wft-rep-sub').textContent = r.reports.length ? plural(r.reports.length, S.reportFilter === 'open' ? 'open report' : 'report') : '';
      if (!r.reports.length) { list.innerHTML = '<div class="wft-empty">' + (S.reportFilter === 'open' ? 'No open reports' : 'No reports') + '</div>'; return; }
      r.reports.forEach(function (rep) {
        var c = el('<div class="wft-rep' + (rep.status !== 'open' ? ' done' : '') + '"><div class="h"><b>Report #' + rep.feedback_id + '</b><span class="wft-chip ' + (rep.status === 'open' ? 'warn' : rep.status === 'resolved' ? 'live' : '') + '">' + esc(rep.status) + '</span><span class="grow"></span><span class="m">' + esc(rep.reporter_name || ('user #' + rep.reporter_uid)) + ' · ' + esc(ago(rep.at)) + '</span></div>' +
          '<div class="q">' + (rep.body ? esc(rep.body) : '<i>flagged without a comment</i>') + '</div>' + (rep.status_note ? '<div class="m">' + esc(rep.status) + ': ' + esc(rep.status_note) + '</div>' : '') +
          '<div class="a">' + (rep.conversation_id ? '<button class="wft-btn sm" data-a="show"><i class="fa fa-comments-o"></i> Show the exchange</button>' : '<span class="wft-chip">no conversation linked</span>') +
          '<button class="wft-btn sm" data-a="ask"><i class="fa fa-comment-o"></i> Ask the assistant to investigate</button><span style="flex:1"></span>' +
          (rep.status === 'open' ? '<button class="wft-btn sm" data-a="res"><i class="fa fa-check"></i> Resolve</button><button class="wft-btn sm ghost" data-a="dis">Dismiss</button>' : '<button class="wft-btn sm ghost" data-a="reopen">Reopen</button>') + '</div><div class="x"></div></div>');
        if (rep.conversation_id) q('[data-a=show]', c).addEventListener('click', function () { var x = q('.x', c); if (x.children.length) { x.innerHTML = ''; return; } showTranscript(rep.conversation_id, rep.message_id, x, 'report-view'); });
        q('[data-a=ask]', c).addEventListener('click', function () { askAssistant('Investigate report #' + rep.feedback_id + (rep.body ? ' ("' + rep.body.slice(0, 200) + '")' : '') + ': what did the advisor say, why was it wrong, and what should change? Make the fix if it is clear-cut, and tell me what you did.'); });
        function setStatus(st) { api('/reports/' + rep.feedback_id + '/status', { method: 'POST', json: { status: st } }).then(function () { renderReports(); refreshCounts(); }).catch(function (e) { toast(e.message, { err: true }); }); }
        var b; if ((b = q('[data-a=res]', c))) b.addEventListener('click', function () { setStatus('resolved'); });
        if ((b = q('[data-a=dis]', c))) b.addEventListener('click', function () { setStatus('dismissed'); });
        if ((b = q('[data-a=reopen]', c))) b.addEventListener('click', function () { setStatus('open'); });
        list.appendChild(c);
      });
    }).catch(function (e) { q('#wft-rep-list').innerHTML = '<div class="wft-empty">' + esc(e.message) + '</div>'; });
  }

  // ================================================================ HISTORY — the ledger
  var histEl = q('#wft-v-history');
  histEl.innerHTML =
    '<div class="wft-bar"><h2>History</h2></div>' +
    '<div class="wft-scroll"><div class="wft-restore-panel" style="max-width:900px"><h3>Restore points</h3><div id="wft-cps"></div>' +
    '<div class="wft-actions"><input class="wft-input" id="wft-cp-label" placeholder="Checkpoint name" style="min-width:260px"><button class="wft-btn" id="wft-cp-new"><i class="fa fa-bookmark-o"></i> Save checkpoint</button><span class="spacer"></span><span style="display:inline-flex;gap:8px;align-items:center;white-space:nowrap"><input class="wft-input" id="wft-restore-at" type="datetime-local"><button class="wft-btn" id="wft-restore-at-go"><i class="fa fa-undo"></i> Restore to this time</button></span></div><div id="wft-restore-plan"></div></div>' +
    '<div class="wft-ledger" id="wft-ledger"></div><div class="wft-actions" style="max-width:900px"><button class="wft-btn" id="wft-hist-more">Show earlier changes</button></div></div>';
  q('#wft-cp-new').addEventListener('click', function () {
    var label = q('#wft-cp-label').value.trim(); if (!label) { q('#wft-cp-label').focus(); return; }
    api('/checkpoints', { method: 'POST', json: { label: label } }).then(function () { q('#wft-cp-label').value = ''; toast('Checkpoint saved.'); renderHistory(); }).catch(function (e) { toast(e.message, { err: true }); });
  });
  q('#wft-restore-at-go').addEventListener('click', function () { var v = q('#wft-restore-at').value; if (!v) return; previewRestore({ at: new Date(v).toISOString() }); });
  q('#wft-hist-more').addEventListener('click', function () { var last = S.events[S.events.length - 1]; if (!last) return; api('/history?before=' + last.id).then(function (r) { S.events = S.events.concat(r.events); S.histMore = r.events.length >= 60; renderLedger(); }); });

  function renderHistory() {
    Promise.all([api('/history'), api('/checkpoints')]).then(function (rs) { S.events = rs[0].events; S.histMore = rs[0].events.length >= 60; S.checkpoints = rs[1].checkpoints; renderCheckpoints(); renderLedger(); })
      .catch(function (e) { q('#wft-ledger').innerHTML = '<div class="wft-empty">' + esc(e.message) + '</div>'; });
  }
  function renderCheckpoints() {
    var c = q('#wft-cps'); c.innerHTML = '';
    if (!S.checkpoints.length) return;
    S.checkpoints.forEach(function (cp) {
      var n = el('<div class="wft-cp"><i class="fa fa-bookmark-o" style="color:var(--pin)"></i><div><div class="t">' + esc(cp.label) + '</div><div class="s">' + esc(fmtWhen(cp.created_at)) + ' · ' + esc(cp.by_name || '') + ' · state after change № ' + cp.last_event_id + '</div></div><span class="grow"></span><button class="wft-btn sm" data-a="restore"><i class="fa fa-undo"></i> Restore to this</button><button class="wft-btn sm ghost" data-a="del">Delete</button></div>');
      q('[data-a=restore]', n).addEventListener('click', function () { previewRestore({ checkpoint_id: cp.id }); });
      arm(q('[data-a=del]', n), 'Delete checkpoint', function () { api('/checkpoints/' + cp.id, { method: 'DELETE' }).then(renderHistory); });
      c.appendChild(n);
    });
  }
  function previewRestore(point) {
    var pl = q('#wft-restore-plan'); pl.innerHTML = '<div class="wft-plan">Working out what would change…</div>';
    api('/restore/preview', { method: 'POST', json: point }).then(function (p) {
      if (!p.changes.length) { pl.innerHTML = '<div class="wft-plan">Already at ' + esc(p.label) + ' — nothing to restore.</div>'; return; }
      pl.innerHTML = '<div class="wft-plan"><b>Restoring to ' + esc(p.label) + '</b> would change ' + plural(p.changes.length, 'file') + ':<ul>' + p.changes.map(function (c) { return '<li>' + esc(c.action === 'delete' ? 'remove' : c.action === 'create' ? 'bring back' : 'roll back') + ' ' + esc(c.kind === 'note' ? 'note' : 'document') + ' <code>' + esc(c.doc_id) + '</code></li>'; }).join('') + '</ul>' +
        '<div class="wft-actions"><button class="wft-btn danger" id="wft-restore-go"><i class="fa fa-undo"></i> Restore now</button><button class="wft-btn" id="wft-restore-cancel">Cancel</button></div></div>';
      q('#wft-restore-cancel').addEventListener('click', function () { pl.innerHTML = ''; });
      arm(q('#wft-restore-go'), 'Yes, restore ' + plural(p.changes.length, 'file'), function () {
        // Bound to THIS preview: if the log moved since, the server answers 409 and we re-plan.
        var body = Object.assign({}, point, { expect_head: p.head, expect_changes: p.changes.length });
        api('/restore', { method: 'POST', json: body }).then(function (r) { pl.innerHTML = ''; toast('Restored to ' + r.label + ' (' + plural(r.events.length, 'change') + ').'); changed(); })
          .catch(function (e) { toast(e.message, { err: true }); if (e.status === 409) previewRestore(point); });
      });
    }).catch(function (e) { pl.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>'; });
  }
  function eventRow(ev, opts) {
    opts = opts || {};
    var snapshot = ev.op === 'snapshot';   // a baseline row: nothing changed, nothing to undo
    var n = el('<div class="wft-ev' + (ev.via === 'undo' ? ' undo-of' : '') + (ev.via === 'external' ? ' external' : '') + '"><div class="num">' + num(ev.id) + '</div><div class="what"><div class="t">' + opChip(ev.op) + '<b>' + esc(ev.doc_id) + '</b><span class="wft-chip ' + (ev.kind === 'note' ? 'pin' : 'reg') + '" style="' + (ev.kind === 'note' ? '' : 'background:var(--panel-2);color:var(--ink-2)') + '">' + (ev.kind === 'note' ? 'note' : 'document') + '</span><span class="via">' + esc(viaLabel(ev.via)) + (ev.restore_target ? ' → ' + esc(ev.restore_target) : '') + '</span></div><div class="s">' + esc(ev.summary) + '</div></div>' +
      '<div class="who">' + esc(ev.by_name || ('user #' + ev.actor_user_id)) + '<br><span title="' + esc(fmtWhen(ev.at)) + '">' + esc(ago(ev.at)) + '</span></div>' +
      '<div class="acts">' + (snapshot ? '' : '<button class="wft-btn sm ghost" data-a="diff">What changed</button>') + (opts.compact && ev.op !== 'delete' && !snapshot ? '<button class="wft-btn sm ghost" data-a="ver">Restore this version</button>' : '') + (snapshot ? '' : '<button class="wft-btn sm" data-a="undo"><i class="fa fa-undo"></i> Undo</button>') + '</div><div class="diffwrap"></div></div>');
    var diffBtn = q('[data-a=diff]', n);
    if (diffBtn) diffBtn.addEventListener('click', function () {
      var w = q('.diffwrap', n); if (w.children.length) { w.innerHTML = ''; return; }
      w.innerHTML = '<div class="wft-diff"><div class="gap">loading…</div></div>';
      api('/history/' + ev.id).then(function (full) { w.innerHTML = renderDiff(full.before_content, full.after_content); }).catch(function (e) { w.innerHTML = '<div class="wft-note err">' + esc(e.message) + '</div>'; });
    });
    var undoBtn = q('[data-a=undo]', n);
    if (undoBtn) arm(undoBtn, 'Undo № ' + ev.id, function () { undoEvent(ev.id); });
    var vb = q('[data-a=ver]', n); if (vb) arm(vb, 'Restore this version', function () { api('/history/' + ev.id + '/restore-version', { method: 'POST', json: {} }).then(function (r) { toast('Restored (change № ' + r.event.id + ').'); changed(); }).catch(function (e) { toast(e.message, { err: true }); }); });
    return n;
  }
  function renderLedger() {
    var L = q('#wft-ledger'); L.innerHTML = '';
    q('#wft-hist-more').style.display = S.histMore ? '' : 'none';
    if (!S.events.length) { L.innerHTML = '<div class="wft-empty">No changes yet</div>'; return; }
    var i = 0;
    while (i < S.events.length) {
      var ev = S.events[i];
      // A seam ABOVE each row: restoring to "after this change" = the state before everything newer.
      var seam = el('<div class="wft-seam"><button>Restore everything to just after № ' + ev.id + '</button></div>');
      (function (id) { q('button', seam).addEventListener('click', function () { previewRestore({ event_id: id }); }); })(ev.id);
      if (ev.batch_id) {
        var batch = [], b = ev.batch_id;
        while (i < S.events.length && S.events[i].batch_id === b) { batch.push(S.events[i]); i++; }
        var external = batch[0].via === 'external', allSnapshots = batch.every(function (e2) { return e2.op === 'snapshot'; });
        var title = batch[0].restore_target ? 'Restore to ' + batch[0].restore_target : external ? (allSnapshots ? 'Baseline: files on disk when the change log began' : 'Found changed on disk at startup') : 'Batch';
        var box = el('<div class="wft-batch"><div class="wft-batch-h"><i class="fa ' + (external ? 'fa-hdd-o' : 'fa-undo') + '"></i> ' + esc(title) + ' — ' + plural(batch.length, 'file') + '<span class="grow"></span><span>' + esc(batch[0].by_name || '') + ' · ' + esc(ago(batch[0].at)) + '</span>' + (allSnapshots ? '' : '<button class="wft-btn sm" data-a="undo-batch">Undo the whole batch</button>') + '</div></div>');
        var ub = q('[data-a=undo-batch]', box);
        if (ub) arm(ub, 'Undo ' + plural(batch.length, 'change'), function () { api('/history/batch/' + b + '/undo', { method: 'POST', json: {} }).then(function (r) { toast('Batch undone (' + plural(r.events.length, 'change') + ').'); changed(); }).catch(function (e) { toast(e.message, { err: true }); }); });
        batch.forEach(function (e2) { box.appendChild(eventRow(e2)); });
        L.appendChild(seam); L.appendChild(box);
      } else {
        L.appendChild(seam); L.appendChild(eventRow(ev)); i++;
      }
    }
    var lastSeam = el('<div class="wft-seam"><button>Restore everything to before № ' + S.events[S.events.length - 1].id + '</button></div>');
    (function (id) { q('button', lastSeam).addEventListener('click', function () { previewRestore({ event_id: id - 1 }); }); })(S.events[S.events.length - 1].id);
    L.appendChild(lastSeam); L.appendChild(el('<div style="height:14px"></div>'));
  }

  // ================================================================ boot
  function gate(title, body) {
    root.innerHTML = '<div class="wft-gate"><i class="fa fa-lock"></i><h2>' + esc(title) + '</h2><p>' + body + '</p></div>';
  }
  api('/me').then(function (me) {
    ME = me;
    q('#wft-who-name').textContent = me.name || '';
    if (me.reader) V.setReader(me.reader); // which reader speaks: the phone voice via Retell, or OpenAI
    if (me.transcribe) V.enableMic();
    if (me.tts) { V.enableVoice(); if (!chat.busy) renderChat(); } // add Listen buttons to already-rendered replies
    renderChat();
    var v = 'library'; try { v = sessionStorage.getItem('wftr.view') || 'library'; } catch (e) { /* ignore */ }
    show(views[v] ? v : 'library');
    refreshCounts();
    setInterval(refreshCounts, 60000);
  }).catch(function (e) {
    if (e.status === 404) gate('AI Trainer is switched off', 'The advisor service is running without the trainer surface enabled.');
    else if (e.status === 403 && e.reason === 'no-role') gate('AI Trainer role required', 'Your account is a staff account, but it does not hold the <b>' + esc(e.role === 'AI_TRAINER' ? 'AI Trainer' : e.role) + '</b> role. Ask an administrator to grant it on your CRM user record (Roles).');
    else if (e.status === 403) gate('Staff only', 'The AI Trainer is an internal Waterfind tool.');
    else if (e.status === 401) gate('Please log in again', 'Your session has expired.');
    else gate('The trainer service is unavailable', esc(e.message) + ' — the advisor service may not be running.');
  });
})();
