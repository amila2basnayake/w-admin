/*
 * Call Campaigns — the CRM page for outbound AI Advisor call campaigns.
 *
 * Host page (ai-campaigns.jsp) sets window.WFCAMP = { token, baseUrl, userId, userName, tokenTtl, refreshUrl }.
 * Everything talks to the sidecar's /voice/campaigns routes with the CRM-minted bearer token; the
 * sidecar re-verifies staff usertype + the BROKER/SU role from the database on every call, fail-closed.
 *
 * Layout: campaigns down the left; the selected campaign on the right — its brief (flow, message,
 * broker, callback, schedule) and its call list, with each client's live state once launched. A
 * sheet builds the list (filters over the CRM's accounts, or pasted client ids / CRNs).
 *
 * A campaign never dials from this page: Launch hands the list to the sidecar, which paces it into the
 * outbound queue inside calling hours; the page polls and shows what happened on each call.
 *
 * Plain DOM JS, no build step (matches the other seam pages).
 */
(function () {
  'use strict';
  var CFG = window.WFCAMP || {};
  var BASE = (CFG.baseUrl || 'http://localhost:3100').replace(/\/$/, '');
  var API = BASE + '/voice/campaigns';
  var token = CFG.token || '';
  var root = document.getElementById('wfk-root');
  if (!root) return;

  // ================================================================ utils
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function q(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qa(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function fmtWhen(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function fmtDate(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function ago(s) {
    if (!s) return ''; var d = new Date(s); if (isNaN(d)) return String(s);
    var sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 45) return 'just now'; if (sec < 3600) return Math.round(sec / 60) + ' min ago';
    if (sec < 86400) { var h = Math.round(sec / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    if (sec < 172800) return 'yesterday'; if (sec < 86400 * 14) return Math.round(sec / 86400) + ' days ago';
    return fmtDate(s);
  }
  function fmtDur(sec) { if (sec == null) return ''; var m = Math.floor(sec / 60), s = sec % 60; return m ? m + 'm ' + (s < 10 ? '0' : '') + s + 's' : s + 's'; }
  function fmtMl(v) { if (v == null) return ''; return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ML'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function localInput(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }

  var toasts = el('<div id="wfk-toasts"></div>'); document.body.appendChild(toasts);
  function toast(msg, opts) {
    opts = opts || {};
    var t = el('<div class="wfk-toast' + (opts.err ? ' err' : '') + '"><span>' + esc(msg) + '</span></div>');
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
    return fetch(CFG.refreshUrl, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('token refresh failed'); return r.json(); }).then(function (j) { token = j.token; });
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
          var e = new Error(j.error || ('request failed (' + r.status + ')')); e.status = r.status; throw e;
        });
      }
      return r.json();
    });
  }

  // ================================================================ vocabulary
  var FLOW_LABEL = { trade_opportunity: 'Trade opportunity', market_alert: 'Market alert', broker_followup: 'Broker follow-up' };
  var STATE_LABEL = { pending: 'Waiting', queued: 'Queued', dialing: 'Calling', called: 'Called', voicemail: 'Voicemail', failed: 'Failed', suppressed: 'Suppressed', skipped: 'Skipped', cancelled: 'Cancelled' };
  var STATE_ICON = { pending: 'fa-circle-o', queued: 'fa-clock-o', dialing: 'fa-phone', called: 'fa-check', voicemail: 'fa-microphone', failed: 'fa-times', suppressed: 'fa-ban', skipped: 'fa-minus', cancelled: 'fa-times' };
  var OUTCOME_LABEL = { transferred: 'Transferred to a broker', callback_requested: 'Callback requested', opted_out: 'Asked not to be called', order_placed: 'Order placed', completed: 'Called', no_answer: 'No answer', busy: 'Busy' };
  var BAR_ORDER = ['called', 'voicemail', 'failed', 'dialing', 'queued', 'skipped', 'suppressed', 'cancelled'];
  var STATUS_LABEL = { draft: 'Draft', running: 'Running', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled' };

  function stateChip(m) {
    var label = STATE_LABEL[m.state] || m.state;
    if (m.state === 'called' && m.outcome && OUTCOME_LABEL[m.outcome] && m.outcome !== 'completed') label = OUTCOME_LABEL[m.outcome];
    return '<span class="wfk-state ' + esc(m.state) + '"><i class="fa ' + (STATE_ICON[m.state] || 'fa-circle') + '"></i>' + esc(label) + '</span>';
  }
  function stateDetail(m) {
    if (m.state === 'skipped') return m.skip_reason || m.req_detail || '';
    if (m.state === 'suppressed' || m.state === 'failed') return m.req_detail || '';
    if (m.state === 'queued') {
      if (m.req_detail && /dialer disabled|no from-number|no outbound agent/i.test(m.req_detail)) return 'dialer off';
      if (m.req_detail && /retry|hours|cap|flag/i.test(m.req_detail)) return m.req_detail + (m.scheduled_for ? ' · ' + fmtWhen(m.scheduled_for) : '');
      return m.scheduled_for && new Date(m.scheduled_for) > new Date() ? 'from ' + fmtWhen(m.scheduled_for) : '';
    }
    if (m.state === 'called' || m.state === 'voicemail') return (m.ended_at ? fmtWhen(m.ended_at) : '') + (m.duration_seconds != null ? ' · ' + fmtDur(m.duration_seconds) : '');
    if (m.state === 'cancelled') return m.req_detail || '';
    return '';
  }
  function bar(counts, cls) {
    var total = counts.total || 0;
    var h = '<div class="wfk-bar' + (cls ? ' ' + cls : '') + '">';
    if (total) BAR_ORDER.forEach(function (k) { var n = counts[k] || 0; if (n) h += '<span class="' + k + '" style="width:' + (100 * n / total) + '%"></span>'; });
    return h + '</div>';
  }
  function statusChip(s) { return '<span class="wfk-st ' + esc(s) + '">' + esc(STATUS_LABEL[s] || s) + '</span>'; }

  // ================================================================ state
  var options = null;       // dropdown data
  var health = null;        // /voice/health
  var camps = [];           // list
  var current = null;       // detail of the selected campaign
  var selectedId = (function () { try { return Number(sessionStorage.getItem('wfk.selected')) || null; } catch (e) { return null; } })();
  var expanded = {};        // member id -> true (row expanded)
  var pollTimer = null;

  // ================================================================ shell
  root.innerHTML =
    '<div id="wfk">' +
      '<div id="wfk-top">' +
        '<div id="wfk-brand"><span class="wfk-mark"></span>Call Campaigns</div>' +
        '<div id="wfk-status"></div>' +
        '<div id="wfk-who"><b>' + esc(CFG.userName || '') + '</b></div>' +
      '</div>' +
      '<div id="wfk-side">' +
        '<div id="wfk-side-head"><button id="wfk-new"><i class="fa fa-plus"></i>New campaign</button></div>' +
        '<div id="wfk-camps"></div>' +
      '</div>' +
      '<div id="wfk-main"></div>' +
    '</div>' +
    '<div id="wfk-sheet"><div class="card">' +
      '<div class="card-head"><h2>Add clients</h2><button class="wfk-btn close"><i class="fa fa-times"></i>Close</button></div>' +
      '<div id="wfk-filters"></div>' +
      '<div id="wfk-results"></div>' +
      '<div id="wfk-paste"><textarea placeholder="Client IDs or CRNs, one per line"></textarea><button class="wfk-btn" id="wfk-paste-add">Add</button></div>' +
      '<div class="card-foot"><button class="wfk-btn primary" id="wfk-add-sel" disabled>Add selected</button><button class="wfk-btn" id="wfk-add-all" disabled>Add all</button><span class="n"></span><button class="wfk-btn" id="wfk-done">Done</button></div>' +
    '</div></div>';

  var main = q('#wfk-main'), side = q('#wfk-camps');

  // ================================================================ top status
  function renderStatus() {
    var h = '';
    if (health) {
      if (!health.enabled) h += '<span class="wfk-pill danger"><i class="fa fa-power-off"></i>Voice calls off</span>';
      else if (health.outbound_dialer) h += '<span class="wfk-pill live"><i class="fa fa-phone"></i>Dialer armed</span>';
      else h += '<span class="wfk-pill warn"><i class="fa fa-phone"></i>Dialer off</span>';
    }
    if (options) h += '<span class="wfk-pill mono">' + esc(options.calling_hours) + ' ' + esc(options.timezone.replace('Australia/', '')) + '</span>';
    q('#wfk-status').innerHTML = h;
  }

  // ================================================================ campaign list
  function renderList() {
    if (!camps.length) { side.innerHTML = ''; return; }
    side.innerHTML = camps.map(function (c) {
      var done = (c.counts.called || 0) + (c.counts.voicemail || 0) + (c.counts.failed || 0) + (c.counts.skipped || 0) + (c.counts.suppressed || 0) + (c.counts.cancelled || 0);
      return '<button class="wfk-camp' + (c.id === selectedId ? ' on' : '') + '" data-id="' + c.id + '">' +
        '<div class="t"><b>' + esc(c.name) + '</b>' + statusChip(c.status) + '</div>' +
        '<div class="m"><span class="flow">' + esc(FLOW_LABEL[c.flow] || c.flow) + '</span><span class="n">' + (c.status === 'draft' ? plural(c.counts.total, 'client') : done + ' / ' + c.counts.total) + '</span></div>' +
        (c.status === 'draft' ? '' : bar(c.counts)) +
      '</button>';
    }).join('');
    qa('.wfk-camp', side).forEach(function (b) { b.addEventListener('click', function () { select(Number(b.getAttribute('data-id'))); }); });
  }
  function loadList() {
    return api('').then(function (list) { camps = list; renderList(); return list; });
  }

  // ================================================================ campaign detail
  function select(id) {
    selectedId = id;
    try { sessionStorage.setItem('wfk.selected', String(id || '')); } catch (e) {}
    expanded = {};
    renderList();
    return loadDetail();
  }
  function loadDetail() {
    if (!selectedId) { current = null; renderDetail(); return Promise.resolve(); }
    return api('/' + selectedId).then(function (d) { current = d; renderDetail(); schedulePoll(); }).catch(function (e) {
      if (e.status === 404) { selectedId = null; current = null; renderDetail(); loadList(); }
      else toast(e.message, { err: true });
    });
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!current || (current.status !== 'running' && current.status !== 'paused')) return;
    pollTimer = setTimeout(function () { if (document.hidden) { schedulePoll(); return; } loadDetail().then(loadList); }, 8000);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && current) loadDetail().then(loadList); });

  var editable = function () { return current && (current.status === 'draft' || current.status === 'running' || current.status === 'paused'); };
  var listEditable = editable;

  function renderDetail() {
    if (!current) {
      main.innerHTML = camps.length ? '' : '<div class="wfk-empty"></div>';
      return;
    }
    var c = current, ed = editable();
    var counts = c.counts;
    var eligible = c.members.filter(function (m) { return m.state === 'pending'; }).length;
    var h = '';
    // header
    h += '<div id="wfk-head">' +
      '<input id="wfk-name" value="' + esc(c.name) + '"' + (ed ? '' : ' readonly') + ' />' +
      statusChip(c.status) +
      '<div id="wfk-actions">' +
        (c.status === 'draft' ? '<button class="wfk-btn primary" id="wfk-launch"' + (eligible ? '' : ' disabled') + '><i class="fa fa-phone"></i>Launch</button><button class="wfk-btn danger" id="wfk-delete"><i class="fa fa-trash-o"></i>Delete</button>' : '') +
        (c.status === 'running' ? '<button class="wfk-btn" id="wfk-pause"><i class="fa fa-pause"></i>Pause</button><button class="wfk-btn danger" id="wfk-cancel"><i class="fa fa-stop"></i>Cancel</button>' : '') +
        (c.status === 'paused' ? '<button class="wfk-btn primary" id="wfk-resume"><i class="fa fa-play"></i>Resume</button><button class="wfk-btn danger" id="wfk-cancel"><i class="fa fa-stop"></i>Cancel</button>' : '') +
        (c.status === 'completed' || c.status === 'cancelled' ? '<button class="wfk-btn" id="wfk-dup"><i class="fa fa-clone"></i>Duplicate</button>' : '') +
      '</div>' +
    '</div>';
    h += '<div id="wfk-meta">' +
      '<span>' + esc(c.created_by_name || 'staff') + '</span><span class="sep">·</span><span>created ' + esc(ago(c.created_at)) + '</span>' +
      (c.launched_at ? '<span class="sep">·</span><span>launched ' + esc(fmtWhen(c.launched_at)) + '</span>' : '') +
      (c.finished_at ? '<span class="sep">·</span><span>finished ' + esc(fmtWhen(c.finished_at)) + '</span>' : '') +
      (c.status === 'running' && c.scheduled_for && new Date(c.scheduled_for) > new Date() ? '<span class="sep">·</span><span class="wfk-pill accent"><i class="fa fa-clock-o"></i>starts ' + esc(fmtWhen(c.scheduled_for)) + '</span>' : '') +
    '</div>';
    // progress
    if (c.status !== 'draft' && counts.total) {
      h += '<div id="wfk-progress">' + bar(counts) + '<div class="legend">' +
        BAR_ORDER.concat(['pending']).filter(function (k) { return counts[k]; }).map(function (k) { return '<span><i class="' + k + '" style="background:' + barColor(k) + '"></i>' + esc(STATE_LABEL[k]) + ' <span class="n">' + counts[k] + '</span></span>'; }).join('') +
        '<span style="margin-left:auto"><span class="n">' + counts.total + '</span> clients</span>' +
      '</div></div>';
    }
    // brief
    var p = c.payload || {};
    var flowOpts = (options ? options.flows : Object.keys(FLOW_LABEL).map(function (k) { return { id: k, label: FLOW_LABEL[k], opening: '' }; }));
    var cbOpts = options ? options.callback_numbers : [];
    var opening = (flowOpts.filter(function (f) { return f.id === c.flow; })[0] || {}).opening || c.opening || '';
    var flowLocked = c.status !== 'draft';
    h += '<div class="wfk-panel"><div class="wfk-panel-head"><h3>Brief</h3></div><div class="wfk-panel-body"><div class="wfk-form">' +
      '<div class="wfk-field"><label>Call type</label><select id="wfk-flow"' + (ed && !flowLocked ? '' : ' disabled') + '>' + flowOpts.map(function (f) { return '<option value="' + esc(f.id) + '"' + (f.id === c.flow ? ' selected' : '') + '>' + esc(f.label) + '</option>'; }).join('') + '</select></div>' +
      '<div class="wfk-field"><label>Broker</label><input id="wfk-broker" value="' + esc(p.broker_name || '') + '"' + (ed ? '' : ' readonly') + ' /></div>' +
      '<div class="wfk-field"><label>Region</label><input id="wfk-region" value="' + esc(p.region || '') + '"' + (ed ? '' : ' readonly') + ' /></div>' +
      '<div class="wfk-field"><label>Callback number</label><select id="wfk-callback"' + (ed ? '' : ' disabled') + '><option value="">None</option>' + cbOpts.map(function (n) { return '<option value="' + esc(n) + '"' + (n === p.callback_number ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select></div>' +
      '<div class="wfk-field wide"><label>Message</label><textarea id="wfk-message"' + (ed ? '' : ' readonly') + '>' + esc(p.message || '') + '</textarea></div>' +
      '<div class="wfk-field start"><label>Start</label><div class="row">' +
        '<span class="wfk-seg"><button type="button" data-when="now"' + (c.scheduled_for ? '' : ' class="on"') + (ed ? '' : ' disabled') + '>' + (c.status === 'draft' ? 'On launch' : 'Now') + '</button><button type="button" data-when="at"' + (c.scheduled_for ? ' class="on"' : '') + (ed ? '' : ' disabled') + '>At</button></span>' +
        '<input type="datetime-local" id="wfk-when" value="' + esc(localInput(c.scheduled_for)) + '"' + (c.scheduled_for ? '' : ' style="visibility:hidden"') + (ed ? '' : ' readonly') + ' />' +
      '</div></div>' +
      '<div class="wfk-field"><label>Calls at once</label><input type="number" id="wfk-conc" min="1" max="20" value="' + esc(c.max_concurrent) + '"' + (ed ? '' : ' readonly') + ' /></div>' +
      '<div class="wfk-opening"><b>Opening</b> — ' + esc(opening) + '</div>' +
    '</div></div></div>';
    // call list
    h += '<div class="wfk-panel"><div class="wfk-panel-head"><h3>Call list</h3><span class="n">' + counts.total + '</span><div class="right">' +
      (listEditable() ? '<button class="wfk-btn sm ghost" id="wfk-recheck"><i class="fa fa-refresh"></i>Recheck</button><button class="wfk-btn sm primary" id="wfk-add"><i class="fa fa-plus"></i>Add clients</button>' : '') +
    '</div></div>';
    if (!c.members.length) h += '<div class="wfk-empty"></div>';
    else {
      h += '<table class="wfk-tbl"><thead><tr><th>Client</th><th>Zone</th><th>Phone</th><th>' + (c.status === 'draft' ? 'Check' : 'Call') + '</th>' + (listEditable() ? '<th></th>' : '') + '</tr></thead><tbody>';
      c.members.forEach(function (m) {
        var canExpand = !!(m.summary || m.recording_url || m.call_id);
        var removable = listEditable() && (m.state === 'pending' || m.state === 'skipped');
        h += '<tr data-mid="' + m.id + '"' + (canExpand ? ' class="clickable"' : '') + '>' +
          '<td class="who"><b>' + esc(m.client_name || ('#' + m.client_uid)) + '</b>' + (m.company ? '<small>' + esc(m.company) + '</small>' : '') + '</td>' +
          '<td class="zone" title="' + esc(m.zone || '') + '">' + esc(zoneOf(m)) + '</td>' +
          '<td class="num">' + esc(m.to_number ? '…' + String(m.to_number).slice(-3) : '') + '</td>' +
          '<td>' + stateChip(m) + (stateDetail(m) ? '<span class="detail">' + esc(stateDetail(m)) + '</span>' : '') + '</td>' +
          (listEditable() ? '<td class="x">' + (removable ? '<button title="Remove" data-rm="' + m.client_uid + '">&times;</button>' : '') + '</td>' : '') +
        '</tr>';
        if (expanded[m.id] && canExpand) {
          h += '<tr class="more"><td colspan="5">' +
            (m.summary ? '<div class="summary">' + esc(m.summary) + '</div>' : '') +
            '<div class="links">' + (m.recording_url ? '<a href="' + esc(m.recording_url) + '" target="_blank" rel="noopener"><i class="fa fa-play-circle"></i> Recording</a>' : '') +
            (m.started_at ? '<span>' + esc(fmtWhen(m.started_at)) + (m.duration_seconds != null ? ' · ' + fmtDur(m.duration_seconds) : '') + '</span>' : '') +
            (m.attempts > 1 ? '<span>' + plural(m.attempts, 'attempt') + '</span>' : '') + '</div>' +
          '</td></tr>';
        }
      });
      h += '</tbody></table>';
    }
    h += '</div>';
    main.innerHTML = h;
    wireDetail();
  }
  function barColor(k) { return { called: '#2E7D5B', voicemail: '#6FB397', failed: '#B23B3B', dialing: '#0E7C9E', queued: '#8FC7DA', skipped: '#C4CCC9', suppressed: '#C4CCC9', cancelled: '#C4CCC9', pending: '#EAEEEC' }[k] || '#ccc'; }
  function zoneOf(m) { return (m.zone || '') + (m.licences > 1 ? ' +' + (m.licences - 1) : ''); }

  var saveBrief = debounce(function () {
    if (!current || !editable()) return;
    var atMode = q('.wfk-seg button[data-when="at"]').classList.contains('on');
    var whenVal = q('#wfk-when').value;
    var patch = {
      name: q('#wfk-name').value,
      payload: { message: q('#wfk-message').value, broker_name: q('#wfk-broker').value, region: q('#wfk-region').value, callback_number: q('#wfk-callback').value },
      scheduled_for: atMode && whenVal ? new Date(whenVal).toISOString() : null,
      max_concurrent: Number(q('#wfk-conc').value) || undefined,
    };
    if (current.status === 'draft') patch.flow = q('#wfk-flow').value;
    api('/' + current.id, { method: 'PATCH', json: patch }).then(function (c) {
      Object.assign(current, c);
      var s = camps.filter(function (x) { return x.id === c.id; })[0]; if (s) { s.name = c.name; s.flow = c.flow; renderList(); }
      var opening = (options ? options.flows : []).filter(function (f) { return f.id === c.flow; })[0];
      if (opening) q('.wfk-opening').innerHTML = '<b>Opening</b> — ' + esc(opening.opening);
    }).catch(function (e) { toast(e.message, { err: true }); });
  }, 500);

  function wireDetail() {
    var c = current;
    ['#wfk-name', '#wfk-broker', '#wfk-region', '#wfk-message', '#wfk-conc'].forEach(function (s) { var n = q(s); if (n && !n.readOnly) n.addEventListener('input', saveBrief); });
    ['#wfk-flow', '#wfk-callback', '#wfk-when'].forEach(function (s) { var n = q(s); if (n && !n.disabled && !n.readOnly) n.addEventListener('change', saveBrief); });
    qa('.wfk-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        qa('.wfk-seg button').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
        var at = b.getAttribute('data-when') === 'at';
        var w = q('#wfk-when'); w.style.visibility = at ? 'visible' : 'hidden';
        if (at && !w.value) { var d = new Date(Date.now() + 3600 * 1000); d.setMinutes(0); w.value = localInput(d.toISOString()); w.focus(); }
        saveBrief();
      });
    });
    var launch = q('#wfk-launch');
    if (launch) arm(launch, '<i class="fa fa-phone"></i>Call ' + plural(c.members.filter(function (m) { return m.state === 'pending'; }).length, 'client') + '?', function () {
      api('/' + c.id + '/launch', { method: 'POST' }).then(function () { toast('Launched'); return loadDetail().then(loadList); }).catch(function (e) { toast(e.message, { err: true }); });
    });
    var del = q('#wfk-delete');
    if (del) arm(del, '<i class="fa fa-trash-o"></i>Delete this draft?', function () {
      api('/' + c.id, { method: 'DELETE' }).then(function () { selectedId = null; current = null; return loadList().then(function () { renderDetail(); }); }).catch(function (e) { toast(e.message, { err: true }); });
    });
    var pause = q('#wfk-pause');
    if (pause) pause.addEventListener('click', function () { api('/' + c.id + '/pause', { method: 'POST' }).then(function () { return loadDetail().then(loadList); }).catch(function (e) { toast(e.message, { err: true }); }); });
    var resume = q('#wfk-resume');
    if (resume) resume.addEventListener('click', function () { api('/' + c.id + '/resume', { method: 'POST' }).then(function () { return loadDetail().then(loadList); }).catch(function (e) { toast(e.message, { err: true }); }); });
    var cancel = q('#wfk-cancel');
    if (cancel) arm(cancel, '<i class="fa fa-stop"></i>Stop calling?', function () {
      api('/' + c.id + '/cancel', { method: 'POST' }).then(function () { return loadDetail().then(loadList); }).catch(function (e) { toast(e.message, { err: true }); });
    });
    var dup = q('#wfk-dup');
    if (dup) dup.addEventListener('click', function () { api('/' + c.id + '/duplicate', { method: 'POST' }).then(function (n) { return loadList().then(function () { select(n.id); }); }).catch(function (e) { toast(e.message, { err: true }); }); });
    var add = q('#wfk-add');
    if (add) add.addEventListener('click', openSheet);
    var recheck = q('#wfk-recheck');
    if (recheck) recheck.addEventListener('click', function () { api('/' + c.id + '/recheck', { method: 'POST' }).then(function (r) { toast(plural(r.eligible, 'client') + ' can be called' + (r.skipped ? ', ' + r.skipped + ' skipped' : '')); return loadDetail(); }).catch(function (e) { toast(e.message, { err: true }); }); });
    qa('button[data-rm]', main).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        api('/' + c.id + '/members/' + b.getAttribute('data-rm'), { method: 'DELETE' }).then(function () { return loadDetail().then(loadList); }).catch(function (e2) { toast(e2.message, { err: true }); });
      });
    });
    qa('tr.clickable', main).forEach(function (tr) {
      tr.addEventListener('click', function () { var id = Number(tr.getAttribute('data-mid')); expanded[id] = !expanded[id]; renderDetail(); });
    });
  }

  // ================================================================ new campaign
  q('#wfk-new').addEventListener('click', function () {
    var n = camps.filter(function (c) { return /^New campaign/.test(c.name); }).length;
    api('', { method: 'POST', json: { name: 'New campaign' + (n ? ' ' + (n + 1) : ''), flow: 'broker_followup', payload: { broker_name: CFG.userName || '' } } })
      .then(function (c) { return loadList().then(function () { return select(c.id); }).then(function () { var nm = q('#wfk-name'); if (nm) { nm.focus(); nm.select(); } }); })
      .catch(function (e) { toast(e.message, { err: true }); });
  });

  // ================================================================ the Add clients sheet
  var sheet = q('#wfk-sheet'), results = q('#wfk-results'), filters = q('#wfk-filters');
  var hits = [], selected = {};
  var onList = function () { var s = {}; (current ? current.members : []).forEach(function (m) { s[m.client_uid] = true; }); return s; };

  function renderFilters() {
    var o = options || { states: [], brokers: [] };
    filters.innerHTML =
      '<div class="wfk-field"><label>Search</label><input id="wff-q" placeholder="Name, company, email, client id, CRN" /></div>' +
      '<div class="wfk-field"><label>State / authority</label><select id="wff-state"><option value="">Any</option>' + o.states.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="wfk-field"><label>Zone</label><select id="wff-region" disabled><option value="">Any</option></select></div>' +
      '<div class="wfk-field"><label>Broker</label><select id="wff-broker"><option value="">Any</option>' + o.brokers.map(function (b) { return '<option value="' + b.uid + '">' + esc(b.name) + ' (' + b.accounts + ')</option>'; }).join('') + '</select></div>' +
      '<div class="wfk-field"><label>Minimum ML held</label><input id="wff-ml" type="number" min="0" step="10" /></div>' +
      '<div class="wfk-field"><label>Not contacted since</label><input id="wff-since" type="date" /></div>' +
      '<div class="go"><button class="wfk-btn primary" id="wff-go" disabled><i class="fa fa-search"></i>Search</button><span class="n"></span></div>';
    var inputs = qa('input, select', filters);
    function anyFilter() { return inputs.some(function (i) { return i.id !== 'wff-region' || i.value ? !!i.value : false; }); }
    inputs.forEach(function (i) { i.addEventListener('input', function () { q('#wff-go').disabled = !anyFilter(); }); i.addEventListener('change', function () { q('#wff-go').disabled = !anyFilter(); }); });
    q('#wff-state').addEventListener('change', function () {
      var sel = q('#wff-region'); sel.innerHTML = '<option value="">Any</option>'; sel.disabled = true;
      var sid = q('#wff-state').value; if (!sid) return;
      api('/regions?state_id=' + encodeURIComponent(sid)).then(function (rs) { sel.innerHTML = '<option value="">Any</option>' + rs.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + ' (' + r.licences + ')</option>'; }).join(''); sel.disabled = false; }).catch(function (e) { toast(e.message, { err: true }); });
    });
    q('#wff-go').addEventListener('click', search);
    q('#wff-q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !q('#wff-go').disabled) search(); });
  }
  function search() {
    var params = { q: q('#wff-q').value.trim(), state_id: q('#wff-state').value, region_id: q('#wff-region').value, broker_uid: q('#wff-broker').value, min_ml: q('#wff-ml').value, not_contacted_since: q('#wff-since').value, limit: 500 };
    var qs = Object.keys(params).filter(function (k) { return params[k] !== '' && params[k] != null; }).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    q('#wff-go').disabled = true; q('#wff-go').innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i>Searching';
    api('/clients?' + qs).then(function (rows) {
      hits = rows; selected = {};
      renderResults();
      if (current) api('/' + current.id, { method: 'PATCH', json: { filter: params } }).catch(function () {});
    }).catch(function (e) { toast(e.message, { err: true }); }).then(function () { q('#wff-go').disabled = false; q('#wff-go').innerHTML = '<i class="fa fa-search"></i>Search'; });
  }
  function renderResults() {
    var on = onList();
    var n = q('#wfk-filters .go .n'); n.textContent = hits.length ? (hits.length >= 500 ? 'first 500' : plural(hits.length, 'account')) : '';
    if (!hits.length) { results.innerHTML = '<div class="wfk-empty"></div>'; updateFoot(); return; }
    var h = '<table class="wfk-tbl"><thead><tr><th class="ck"><input type="checkbox" id="wff-all" /></th><th>Client</th><th>Zone</th><th class="num">Held</th><th>Broker</th><th>Contacted</th><th>Phone</th></tr></thead><tbody>';
    hits.forEach(function (r) {
      var inList = !!on[r.uid];
      var flags = (r.suppressed ? '<span class="wfk-flag danger">suppressed</span>' : '') + (!r.advisor_on ? '<span class="wfk-flag">advisor off</span>' : '') + (!r.campaign_optin ? '<span class="wfk-flag">opted out</span>' : '') + (inList ? '<span class="wfk-flag muted">on the list</span>' : '');
      h += '<tr' + (inList ? ' class="in"' : '') + '>' +
        '<td class="ck"><input type="checkbox" data-uid="' + r.uid + '"' + (inList ? ' checked disabled' : (selected[r.uid] ? ' checked' : '')) + ' /></td>' +
        '<td class="who"><b>' + esc(r.name) + '</b>' + flags + (r.company ? '<small>' + esc(r.company) + '</small>' : '') + '</td>' +
        '<td class="zone" title="' + esc(r.zones.join(' · ')) + '">' + esc(r.zones[0] || '') + (r.licences > 1 ? ' <small>+' + (r.licences - 1) + '</small>' : '') + '</td>' +
        '<td class="num">' + esc(fmtMl(r.volume_ml)) + '</td>' +
        '<td>' + esc(r.broker || '') + '</td>' +
        '<td>' + esc(r.last_contacted ? fmtDate(r.last_contacted) : '') + '</td>' +
        '<td class="num">' + esc(r.phone_tail || '') + '</td>' +
      '</tr>';
    });
    results.innerHTML = h + '</tbody></table>';
    qa('input[data-uid]', results).forEach(function (cb) { cb.addEventListener('change', function () { if (cb.checked) selected[cb.getAttribute('data-uid')] = true; else delete selected[cb.getAttribute('data-uid')]; updateFoot(); }); });
    q('#wff-all').addEventListener('change', function () {
      var all = q('#wff-all').checked;
      qa('input[data-uid]', results).forEach(function (cb) { if (cb.disabled) return; cb.checked = all; if (all) selected[cb.getAttribute('data-uid')] = true; else delete selected[cb.getAttribute('data-uid')]; });
      updateFoot();
    });
    updateFoot();
  }
  function updateFoot() {
    var on = onList();
    var sel = Object.keys(selected).length;
    var addable = hits.filter(function (r) { return !on[r.uid]; }).length;
    q('#wfk-add-sel').disabled = !sel; q('#wfk-add-sel').textContent = sel ? 'Add ' + plural(sel, 'client') : 'Add selected';
    q('#wfk-add-all').disabled = !addable; q('#wfk-add-all').textContent = addable ? 'Add all ' + addable : 'Add all';
    q('#wfk-sheet .card-foot .n').textContent = current ? plural(current.counts.total, 'client') + ' on the list' : '';
  }
  function addUids(uids, crns) {
    if (!current) return;
    api('/' + current.id + '/members', { method: 'POST', json: { client_uids: uids, crns: crns || [] } }).then(function (r) {
      var msg = plural(r.added, 'client') + ' added' + (r.skipped ? ' (' + r.skipped + ' will be skipped)' : '') + (r.already ? ', ' + r.already + ' already on the list' : '') + (r.unknown.length ? ', not found: ' + r.unknown.slice(0, 6).join(', ') + (r.unknown.length > 6 ? '…' : '') : '');
      toast(msg, { err: !r.added && !!r.unknown.length });
      selected = {};
      return loadDetail().then(function () { renderResults(); return loadList(); });
    }).catch(function (e) { toast(e.message, { err: true }); });
  }
  q('#wfk-add-sel').addEventListener('click', function () { addUids(Object.keys(selected).map(Number)); });
  q('#wfk-add-all').addEventListener('click', function () { var on = onList(); addUids(hits.filter(function (r) { return !on[r.uid]; }).map(function (r) { return r.uid; })); });
  q('#wfk-paste-add').addEventListener('click', function () {
    var ta = q('#wfk-paste textarea');
    var toks = ta.value.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!toks.length) return;
    var uids = [], crns = [];
    toks.forEach(function (t) { var m = /^(?:crn[:\s#-]*)?(\d+)$/i.exec(t); if (!m) return; if (/^crn/i.test(t)) crns.push(Number(m[1])); else { uids.push(Number(m[1])); crns.push(Number(m[1])); } });
    ta.value = '';
    addUids(uids, crns);
  });
  function openSheet() {
    if (!options) return;
    sheet.classList.add('open');
    if (!filters.children.length) renderFilters();
    updateFoot();
    setTimeout(function () { var i = q('#wff-q'); if (i) i.focus(); }, 0);
  }
  function closeSheet() { sheet.classList.remove('open'); }
  q('#wfk-sheet .close').addEventListener('click', closeSheet);
  q('#wfk-done').addEventListener('click', closeSheet);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet.classList.contains('open')) closeSheet(); });

  // ================================================================ boot
  function gate(title, body) { root.innerHTML = '<div class="wfk-gate"><i class="fa fa-lock"></i><h2>' + esc(title) + '</h2><p>' + esc(body) + '</p></div>'; }
  fetch(BASE + '/voice/health').then(function (r) { return r.json(); }).then(function (h) { health = h; renderStatus(); }).catch(function () {});
  api('/options').then(function (o) {
    options = o; renderStatus();
    return loadList().then(function (list) {
      if (selectedId && !list.some(function (c) { return c.id === selectedId; })) selectedId = null;
      if (!selectedId && list.length) selectedId = (list.filter(function (c) { return c.status === 'running' || c.status === 'paused'; })[0] || list[0]).id;
      renderList();
      return loadDetail();
    });
  }).catch(function (e) {
    if (e.status === 403) gate('Broker role required', 'Call Campaigns is for staff who hold the Broker or Superuser role.');
    else if (e.status === 404) gate('Voice calls are off', 'The advisor service on this server has voice calls switched off.');
    else if (e.status === 503) gate('Not available right now', e.message);
    else gate('Could not reach the advisor service', e.message);
  });
  setInterval(function () { if (!document.hidden && options) loadList(); }, 30000);
})();
