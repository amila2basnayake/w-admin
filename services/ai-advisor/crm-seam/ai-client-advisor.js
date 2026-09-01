/* AI Water Advisor — broker-assist rail panel ("Client Rail", Design A).
 * Hosted by ai-client-advisor.jsp inside the 400px rail iframe on the CRM client page
 * (user-reg-details.body.jsp). Talks to the sidecar /assist routes with a staff token whose
 * signed `act` claim binds every request to the viewed client. Advice-only: no orders,
 * no attachments, no projects. Markdown/table/chart rendering and SSE plumbing are the same
 * code as ai-advisor.js, trimmed. Rail chrome (close / width / pop-out) messages the parent
 * page via postMessage; in a popped-out window those controls are hidden.
 */
(function () {
  'use strict';
  var CFG = window.WFAIC || {};
  var BASE = (CFG.baseUrl || '').replace(/\/$/, '');
  var tokenExp = Math.floor(Date.now() / 1000) + (CFG.tokenTtl || 1800);
  var CLIENT = CFG.clientName || 'this client';
  var CLIENT_ID = String(CFG.clientId || '');
  var POPOUT = !!CFG.popout;
  var LS_CONV = 'wfaic.conv.' + CLIENT_ID;   // sessionStorage: survive the CRM's full-page postbacks
  var LS_DRAFT = 'wfaic.draft.' + CLIENT_ID;

  var state = { conversations: [], currentId: null, messages: [], streaming: false, abort: null, histOpen: false,
                clientChats: null, viewing: null };   // viewing = {id,title}: reading the CLIENT's own chat, read-only

  // ---- utils ---------------------------------------------------------------
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = el('div', 'wfai-toast', escapeHtml(msg)); document.body.appendChild(t); requestAnimationFrame(function () { t.classList.add('show'); }); setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 250); }, 1800); }
  function copyText(t) { if (navigator.clipboard) { navigator.clipboard.writeText(t).then(function () { toast('Copied'); }); } }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function relTime(iso) {
    var d = new Date(iso), now = new Date();
    var days = Math.floor((now - d) / 86400000);
    if (isNaN(days)) return '';
    if (days <= 0 && d.getDate() === now.getDate()) return d.toTimeString().slice(0, 5);
    if (days < 1) return 'yesterday';
    if (days < 7) return days + 'd ago';
    return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  }
  // Rail chrome + comment-box handoff go to the CRM page: the parent when framed, the opener when popped out.
  function post(msg) { try { var t = (window.parent && window.parent !== window) ? window.parent : window.opener; if (t) t.postMessage(msg, '*'); } catch (e) {} }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }

  // ---- markdown (safe subset) — same renderer as ai-advisor.js -------------
  function inlineFmt(t) {
    t = t.replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (m, txt, url) { return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>'; });
    return t;
  }
  function renderMarkdown(src) {
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n'), out = '', i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var lang = line.replace(/^```/, '').trim().toLowerCase();
        var code = []; i++; var closed = false;
        while (i < lines.length) { if (/^```/.test(lines[i])) { closed = true; i++; break; } code.push(lines[i]); i++; }
        var joined = code.join('\n');
        if (lang === 'chart') { out += chartHtml(joined, closed); continue; }
        out += '<pre><code>' + escapeHtml(joined) + '</code></pre>'; continue;
      }
      var hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) { var lvl = Math.min(hm[1].length, 3); out += '<h' + lvl + '>' + inlineFmt(escapeHtml(hm[2])) + '</h' + lvl + '>'; i++; continue; }
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out += '<hr/>'; i++; continue; }
      if (isTableStart(lines, i)) {
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) { return /^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''; });
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i]) && !isTableSep(lines[i])) { body.push(splitRow(lines[i])); i++; }
        var cell = function (tag, txt, ci) { return '<' + tag + (aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '') + '>' + inlineFmt(escapeHtml(txt == null ? '' : txt)) + '</' + tag + '>'; };
        out += '<div class="wfai-tablewrap"><table><thead><tr>' + head.map(function (h, ci) { return cell('th', h, ci); }).join('') + '</tr></thead><tbody>' +
          body.map(function (r) { return '<tr>' + head.map(function (_, ci) { return cell('td', r[ci], ci); }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
        continue;
      }
      if (/^>\s?/.test(line)) { var q = []; while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; } out += '<blockquote>' + inlineFmt(escapeHtml(q.join(' '))) + '</blockquote>'; continue; }
      if (/^\s*[-*+]\s+/.test(line)) { var u = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { u.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; } out += '<ul>' + u.map(function (it) { return '<li>' + inlineFmt(escapeHtml(it)) + '</li>'; }).join('') + '</ul>'; continue; }
      if (/^\s*\d+\.\s+/.test(line)) { var o = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { o.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; } out += '<ol>' + o.map(function (it) { return '<li>' + inlineFmt(escapeHtml(it)) + '</li>'; }).join('') + '</ol>'; continue; }
      if (/^\s*$/.test(line)) { i++; continue; }
      var para = [line]; i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !isTableStart(lines, i)) { para.push(lines[i]); i++; }
      out += '<p>' + inlineFmt(escapeHtml(para.join('\n'))).replace(/\n/g, '<br/>') + '</p>';
    }
    return out;
  }
  function isTableSep(s) { return s.indexOf('|') >= 0 && /-{3,}/.test(s) && /^\s*\|?[\s:|-]+\|?\s*$/.test(s); }
  function isTableStart(lines, i) { return lines[i].indexOf('|') >= 0 && !isTableSep(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]); }
  function splitRow(s) { return s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); }

  // ---- charts — same builder as ai-advisor.js -------------------------------
  var SERIES_COLORS = ['var(--wfai-s1)', 'var(--wfai-s2)', 'var(--wfai-s3)', 'var(--wfai-s4)'];
  var SVGNS = 'http://www.w3.org/2000/svg';
  function chartHtml(jsonText, closed) {
    if (!closed) return '<div class="wfai-chart pending"><i class="fa fa-line-chart"></i> Building chart…</div>';
    var spec = null;
    try { spec = normalizeChartSpec(JSON.parse(jsonText)); } catch (e) { spec = null; }
    if (!spec) return '<div class="wfai-chart pending"><i class="fa fa-exclamation-circle"></i> Chart could not be rendered.</div>';
    return '<div class="wfai-chart" data-spec="' + encodeURIComponent(JSON.stringify(spec)) + '"></div>';
  }
  function normalizeChartSpec(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.x) || !Array.isArray(s.series)) return null;
    var x = s.x.slice(0, 60).map(String);
    if (x.length < 2) return null;
    var num = function (v) { var n2 = Number(v); return (v == null || isNaN(n2)) ? null : n2; };
    var fit = function (arr) { var d = arr.slice(0, x.length).map(num); while (d.length < x.length) d.push(null); return d; };
    var series = [];
    for (var k = 0; k < s.series.length && series.length < 4; k++) {
      var sr = s.series[k]; if (!sr || !Array.isArray(sr.data)) continue;
      var d = fit(sr.data);
      if (d.some(function (v) { return v != null; })) series.push({ name: String(sr.name || 'Series ' + (series.length + 1)), data: d });
    }
    if (!series.length) return null;
    var out = { type: s.type === 'bar' ? 'bar' : 'line', title: s.title ? String(s.title) : '', unit: s.unit ? String(s.unit) : '', x: x, series: series };
    if (out.type === 'line' && s.band && Array.isArray(s.band.low) && Array.isArray(s.band.high)) {
      out.band = { name: String(s.band.name || 'Range'), low: fit(s.band.low), high: fit(s.band.high) };
    }
    return out;
  }
  function hydrateCharts(scope) {
    var nodes = (scope || document).querySelectorAll('.wfai-chart[data-spec]:not(.done)');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]; node.classList.add('done');
      try { buildChart(JSON.parse(decodeURIComponent(node.getAttribute('data-spec'))), node); }
      catch (e) { node.textContent = 'Chart could not be rendered.'; }
    }
  }
  function svgEl(tag, attrs, parent) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function niceStep(raw) { var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)); var f = raw / mag; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag; }
  function fmtVal(n) { if (n == null || isNaN(n)) return '—'; var r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100; return r.toLocaleString(); }
  function buildChart(spec, mount) {
    // Rail is ~370px of content width; the 640x300 viewBox scales down cleanly.
    var W = 640, H = 300, padT = 12, padB = 28, padL = 52;
    var n = spec.x.length, isBar = spec.type === 'bar';
    var padR = (!isBar && spec.series.length <= 2) ? 48 : 14;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var lo = Infinity, hi = -Infinity;
    var see = function (v) { if (v == null) return; if (v < lo) lo = v; if (v > hi) hi = v; };
    spec.series.forEach(function (s) { s.data.forEach(see); });
    if (spec.band) { spec.band.low.forEach(see); spec.band.high.forEach(see); }
    if (lo === Infinity) return;
    if (isBar) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (lo === hi) hi = lo + (Math.abs(lo) || 1);
    var step = niceStep((hi - lo) / 4);
    var d0 = Math.floor(lo / step) * step, d1 = Math.ceil(hi / step) * step;
    if (d1 <= d0) d1 = d0 + step;
    function Y(v) { return padT + plotH * (1 - (v - d0) / (d1 - d0)); }
    function X(i) { return isBar ? padL + plotW * ((i + 0.5) / n) : padL + plotW * (i / (n - 1)); }
    mount.innerHTML = '';
    var hd = el('div', 'hd');
    var tSpan = el('span', 't'); tSpan.textContent = spec.title || 'Chart'; hd.appendChild(tSpan);
    if (spec.unit) { var uSpan = el('span', 'u'); uSpan.textContent = spec.unit; hd.appendChild(uSpan); }
    var tblBtn = el('button', 'tbl'); tblBtn.title = 'View as table'; tblBtn.innerHTML = '<i class="fa fa-table"></i>'; hd.appendChild(tblBtn);
    mount.appendChild(hd);
    var plot = el('div', 'plot'); plot.tabIndex = 0; mount.appendChild(plot);
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' }, null); plot.appendChild(svg);
    if (spec.title) svg.setAttribute('aria-label', spec.title);
    for (var gv = d0; gv <= d1 + step / 2; gv += step) {
      svgEl('line', { x1: padL, x2: W - padR, y1: Y(gv), y2: Y(gv), 'class': 'grid' }, svg);
      svgEl('text', { x: padL - 8, y: Y(gv) + 4, 'class': 'ylbl' }, svg).textContent = fmtVal(gv);
    }
    var baseV = (d0 <= 0 && d1 >= 0) ? 0 : d0;
    svgEl('line', { x1: padL, x2: W - padR, y1: Y(baseV), y2: Y(baseV), 'class': 'axis' }, svg);
    var xstep = Math.max(1, Math.ceil(n / 8));
    for (var xi = 0; xi < n; xi++) {
      if (!(xi === n - 1 || (xi % xstep === 0 && n - 1 - xi >= xstep / 2))) continue;
      svgEl('text', { x: X(xi), y: H - 8, 'class': 'xlbl' }, svg).textContent = spec.x[xi];
    }
    if (spec.band) {
      var fwd = '', back = '';
      for (var bi = 0; bi < n; bi++) {
        if (spec.band.high[bi] == null || spec.band.low[bi] == null) continue;
        fwd += (fwd ? 'L' : 'M') + X(bi).toFixed(1) + ' ' + Y(spec.band.high[bi]).toFixed(1);
        back = 'L' + X(bi).toFixed(1) + ' ' + Y(spec.band.low[bi]).toFixed(1) + back;
      }
      if (fwd) svgEl('path', { d: fwd + back + 'Z', 'class': 'band' }, svg);
    }
    if (isBar) {
      var m = spec.series.length, bandW = plotW / n;
      var barW = Math.min(24, Math.max(3, (bandW - 6 - 2 * (m - 1)) / m));
      var groupW = m * barW + 2 * (m - 1);
      var y0 = Y(baseV);
      spec.series.forEach(function (s, si) {
        for (var i5 = 0; i5 < n; i5++) {
          var v5 = s.data[i5]; if (v5 == null) continue;
          var bx = X(i5) - groupW / 2 + si * (barW + 2), by = Y(v5);
          var top = Math.min(by, y0), hgt = Math.abs(y0 - by);
          var r = Math.min(4, barW / 2, hgt), dp;
          if (v5 >= 0) {
            dp = 'M' + bx + ' ' + (top + hgt) + 'V' + (top + r) + 'Q' + bx + ' ' + top + ' ' + (bx + r) + ' ' + top +
                 'H' + (bx + barW - r) + 'Q' + (bx + barW) + ' ' + top + ' ' + (bx + barW) + ' ' + (top + r) + 'V' + (top + hgt) + 'Z';
          } else {
            dp = 'M' + bx + ' ' + top + 'H' + (bx + barW) + 'V' + (top + hgt) + 'H' + bx + 'Z';
          }
          svgEl('path', { d: dp, 'class': 'bar bar-i' + i5, style: 'fill:' + SERIES_COLORS[si] }, svg);
          if (m === 1 && n <= 8 && v5 >= 0) svgEl('text', { x: bx + barW / 2, y: top - 5, 'class': 'vlbl mid' }, svg).textContent = fmtVal(v5);
        }
      });
    } else {
      var endYs = [];
      spec.series.forEach(function (s, si) {
        var color = SERIES_COLORS[si], d = '', pen = false, lastIdx = -1;
        for (var i2 = 0; i2 < n; i2++) {
          if (s.data[i2] == null) { pen = false; continue; }
          d += (pen ? 'L' : 'M') + X(i2).toFixed(1) + ' ' + Y(s.data[i2]).toFixed(1); pen = true; lastIdx = i2;
        }
        if (d) svgEl('path', { d: d, 'class': 'ln', style: 'stroke:' + color }, svg);
        for (var i4 = 0; i4 < n; i4++) {
          if (s.data[i4] == null || (n > 20 && i4 !== lastIdx)) continue;
          svgEl('circle', { cx: X(i4), cy: Y(s.data[i4]), r: 4, 'class': 'dot', style: 'fill:' + color }, svg);
        }
        if (spec.series.length <= 2 && lastIdx >= 0) {
          var ly = Y(s.data[lastIdx]);
          if (!endYs.some(function (p) { return Math.abs(p - ly) < 13; })) {
            endYs.push(ly);
            svgEl('text', { x: X(lastIdx) + 8, y: ly + 4, 'class': 'vlbl' }, svg).textContent = fmtVal(s.data[lastIdx]);
          }
        }
      });
    }
    var tip = el('div', 'wfai-tip'); tip.hidden = true; plot.appendChild(tip);
    var cross = isBar ? null : svgEl('line', { y1: padT, y2: padT + plotH, 'class': 'cross', visibility: 'hidden' }, svg);
    var hover = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' }, svg);
    function showTip(i6) {
      tip.innerHTML = '';
      var hx = el('div', 'x'); hx.textContent = spec.x[i6]; tip.appendChild(hx);
      var row = function (colorStyle, isBand, valTxt, name) {
        var r2 = el('div', 'row');
        var key = el('span', 'key' + (isBand ? ' band' : '')); if (colorStyle) key.style.background = colorStyle; r2.appendChild(key);
        var b = el('b'); b.textContent = valTxt + (spec.unit ? ' ' + spec.unit : ''); r2.appendChild(b);
        var nm = el('span', 'nm'); nm.textContent = name; r2.appendChild(nm);
        tip.appendChild(r2);
      };
      spec.series.forEach(function (s, si) { row(SERIES_COLORS[si], false, fmtVal(s.data[i6]), s.name); });
      if (spec.band && (spec.band.low[i6] != null || spec.band.high[i6] != null)) row(null, true, fmtVal(spec.band.low[i6]) + '–' + fmtVal(spec.band.high[i6]), spec.band.name);
      tip.hidden = false;
      var pr = plot.getBoundingClientRect();
      tip.style.left = Math.max(4, Math.min((X(i6) / W) * pr.width + 12, pr.width - tip.offsetWidth - 4)) + 'px';
      tip.style.top = '8px';
      if (cross) { cross.setAttribute('x1', X(i6)); cross.setAttribute('x2', X(i6)); cross.setAttribute('visibility', 'visible'); }
      if (isBar) svg.querySelectorAll('.bar').forEach(function (b2) { b2.classList.toggle('on', b2.classList.contains('bar-i' + i6)); });
    }
    function hideTip() {
      tip.hidden = true;
      if (cross) cross.setAttribute('visibility', 'hidden');
      if (isBar) svg.querySelectorAll('.bar.on').forEach(function (b2) { b2.classList.remove('on'); });
    }
    function idxFromEvent(ev) {
      var rect = svg.getBoundingClientRect();
      var vx = (ev.clientX - rect.left) * (W / rect.width);
      var f = isBar ? (vx - padL) / plotW * n - 0.5 : (vx - padL) / plotW * (n - 1);
      return Math.max(0, Math.min(n - 1, Math.round(f)));
    }
    hover.addEventListener('pointermove', function (ev) { showTip(idxFromEvent(ev)); });
    hover.addEventListener('pointerleave', hideTip);
    var kbIdx = -1;
    plot.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        kbIdx = kbIdx < 0 ? (ev.key === 'ArrowRight' ? 0 : n - 1) : Math.max(0, Math.min(n - 1, kbIdx + (ev.key === 'ArrowRight' ? 1 : -1)));
        showTip(kbIdx); ev.preventDefault();
      } else if (ev.key === 'Escape') { kbIdx = -1; hideTip(); }
    });
    plot.addEventListener('blur', function () { kbIdx = -1; hideTip(); });
    if (spec.series.length >= 2 || spec.band) {
      var lg = el('div', 'legend');
      spec.series.forEach(function (s, si) {
        var it = el('span', 'item');
        var k2 = el('span', 'key' + (isBar ? ' rect' : '')); k2.style.background = SERIES_COLORS[si]; it.appendChild(k2);
        var nm2 = el('span'); nm2.textContent = s.name; it.appendChild(nm2);
        lg.appendChild(it);
      });
      if (spec.band) {
        var it3 = el('span', 'item'); it3.appendChild(el('span', 'key band'));
        var nm3 = el('span'); nm3.textContent = spec.band.name; it3.appendChild(nm3);
        lg.appendChild(it3);
      }
      mount.appendChild(lg);
    }
    var tblWrap = null;
    tblBtn.addEventListener('click', function () {
      if (tblWrap) { tblWrap.hidden = !tblWrap.hidden; return; }
      tblWrap = el('div', 'wfai-tablewrap dt');
      var table = document.createElement('table'), thead = document.createElement('thead'), hr2 = document.createElement('tr');
      var addTh = function (txt) { var th = document.createElement('th'); th.textContent = txt; hr2.appendChild(th); };
      addTh('');
      spec.series.forEach(function (s) { addTh(s.name + (spec.unit ? ' (' + spec.unit + ')' : '')); });
      if (spec.band) { addTh(spec.band.name + ' min'); addTh(spec.band.name + ' max'); }
      thead.appendChild(hr2); table.appendChild(thead);
      var tb = document.createElement('tbody');
      for (var ri = 0; ri < n; ri++) {
        var tr = document.createElement('tr');
        var td0 = document.createElement('td'); td0.textContent = spec.x[ri]; tr.appendChild(td0);
        var addTd = function (v) { var td = document.createElement('td'); td.style.textAlign = 'right'; td.textContent = fmtVal(v); tr.appendChild(td); };
        spec.series.forEach(function (s) { addTd(s.data[ri]); });
        if (spec.band) { addTd(spec.band.low[ri]); addTd(spec.band.high[ri]); }
        tb.appendChild(tr);
      }
      table.appendChild(tb); tblWrap.appendChild(table); mount.appendChild(tblWrap);
    });
  }

  // ---- tool activity labels (third person — the broker is not the client) ---
  var TOOL_LABELS = {
    get_my_profile: "Looking up the client's account…", get_my_holdings: "Checking the client's holdings…",
    estimate_my_seasonal_allocation: "Estimating their seasonal allocation…",
    get_my_trade_history: 'Reviewing their trade history…', get_my_settlement_progress: 'Checking settlement progress…',
    get_my_disputes: 'Checking dispute history…', get_my_engagement: 'Reviewing account activity…',
    get_my_context: 'Reviewing their crop & interests…', get_my_water_account: 'Checking their water account…',
    get_my_account_setup: 'Reviewing their account setup…',
    find_region: 'Finding the market region…', get_region_tradability: 'Checking where they can trade…',
    get_matchable_orders: 'Scanning the live order book…', get_market_liquidity: 'Assessing market liquidity…',
    get_price_band: 'Pulling recent settled prices…', get_market_reference: 'Building a price reference…',
    get_region_allocation: 'Checking announced allocations…', get_allocation_trajectory: 'Charting the allocation season…',
    get_climate_drivers: 'Checking climate drivers…', estimate_net_proceeds: 'Estimating net proceeds…',
    get_market_events: 'Checking market events…', get_climate_outlook: 'Checking the BOM outlook…',
    get_my_open_orders: 'Checking their open orders…', get_my_ai_orders: 'Checking their AI order history…',
    get_my_fee_schedule: 'Checking their fee schedule…', get_my_opportunities: 'Scanning for opportunities…',
    prepare_sell_order: 'Preparing a sell order for your confirmation…', prepare_buy_order: 'Preparing a buy order for your confirmation…',
    prepare_order_withdrawal: 'Preparing a withdrawal for your confirmation…'
  };
  function toolLabel(name) {
    if (name === 'WebSearch' || name === 'WebFetch') return '<i class="fa fa-search"></i> Searching the web…';
    var m = /^mcp__wf__(.+)$/.exec(name || '');
    if (m) return '<i class="fa fa-database"></i> ' + escapeHtml(TOOL_LABELS[m[1]] || "Checking the client's data…");
    if (/^mcp__knowledge__/.test(name || '')) return '<i class="fa fa-book"></i> Checking the regulatory knowledge base…';
    return '<i class="fa fa-cog"></i> Working…';
  }

  // ---- api ------------------------------------------------------------------
  function authHeaders() { return { Authorization: 'Bearer ' + CFG.token, 'Content-Type': 'application/json' }; }
  function ensureToken() {
    var now = Math.floor(Date.now() / 1000);
    if (tokenExp - now > 120 || !CFG.refreshUrl) return Promise.resolve();
    return fetch(CFG.refreshUrl, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.token) { CFG.token = j.token; tokenExp = j.exp; } }).catch(function () {});
  }
  function api(method, path, body) {
    return ensureToken().then(function () {
      return fetch(BASE + path, { method: method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
    }).then(function (r) {
      if (r.status === 401) { toast('Session expired — reload the CRM page'); throw new Error('401'); }
      if (!r.ok) { return r.json().catch(function () { return {}; }).then(function (e) { throw new Error(e && (e.message || e.error) || ('HTTP ' + r.status)); }); }
      return r.status === 204 ? null : r.json();
    });
  }
  function streamTurn(path, body, handlers) {
    return ensureToken().then(function () {
      var ac = new AbortController(); state.abort = ac;
      return fetch(BASE + path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}), signal: ac.signal })
        .then(function (res) {
          var ct = res.headers.get('content-type') || '';
          if (!res.ok && ct.indexOf('application/json') >= 0) { return res.json().then(function (e) { handlers.onError && handlers.onError(e.message || e.error || ('HTTP ' + res.status)); }); }
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return;
              buf += dec.decode(r.value, { stream: true });
              var idx;
              while ((idx = buf.indexOf('\n\n')) >= 0) {
                var chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
                var dl = chunk.split('\n').filter(function (l) { return l.indexOf('data: ') === 0; })[0];
                if (!dl) continue;
                var evt; try { evt = JSON.parse(dl.slice(6)); } catch (e) { continue; }
                if (evt.type === 'delta') handlers.onDelta && handlers.onDelta(evt.text);
                else if (evt.type === 'user') handlers.onUser && handlers.onUser(evt.messageId);
                else if (evt.type === 'tool') handlers.onTool && handlers.onTool(evt.name);
                else if (evt.type === 'done') handlers.onDone && handlers.onDone(evt);
                else if (evt.type === 'error') handlers.onError && handlers.onError(evt.message);
              }
              return pump();
            });
          }
          return pump();
        }).catch(function (e) { if (e.name !== 'AbortError') handlers.onError && handlers.onError(e.message || 'stream failed'); });
    });
  }

  // ---- DOM scaffold ---------------------------------------------------------
  var root = document.getElementById('wfaic-root');
  root.innerHTML =
    '<div class="wfaic-head">' +
      '<div class="row1">' +
        '<span class="client">' + escapeHtml(CLIENT) + '</span>' +
        '<span class="btns">' +
          (POPOUT ? '' :
            '<button class="w" title="Cycle panel width"><i class="fa fa-arrows-h"></i></button>' +
            '<button class="pop" title="Open in its own window"><i class="fa fa-external-link"></i></button>' +
            '<button class="x" title="Close (Esc)"><i class="fa fa-times"></i></button>') +
        '</span>' +
      '</div>' +
      '<div class="row2">' + (CFG.clientMeta ? escapeHtml(CFG.clientMeta) : 'Client #' + escapeHtml(CLIENT_ID)) + '</div>' +
    '</div>' +
    '<div class="wfaic-bar">' +
      '<button class="newchat"><i class="fa fa-plus"></i> New chat</button>' +
      '<span class="histwrap"><button class="hist">History <span class="n"></span> <i class="fa fa-caret-down"></i></button></span>' +
    '</div>' +
    '<div class="wfaic-msgs"><div class="wfaic-msgs-inner"></div><div class="wfaic-orders"></div></div>' +
    '<div class="wfaic-composer">' +
      '<textarea rows="1" placeholder="Ask about ' + escapeHtml(CLIENT) + '…"></textarea>' +
      '<button class="wfai-mic" title="Dictate" aria-pressed="false" hidden><i class="fa fa-microphone"></i></button>' +
      '<button class="wfai-voice" title="Voice mode" aria-pressed="false" hidden></button>' +
      '<button class="send" title="Send"><i class="fa fa-arrow-up"></i></button>' +
    '</div>';

  function $(sel) { return root.querySelector(sel); }
  var elMsgsWrap = $('.wfaic-msgs'), elMsgs = $('.wfaic-msgs-inner'), elOrders = $('.wfaic-orders'),
      elText = $('.wfaic-composer textarea'), elSend = $('.wfaic-composer .send'),
      elHistBtn = $('.hist'), elHistN = $('.hist .n'), elHistWrap = $('.histwrap'),
      elMic = $('.wfai-mic'), elVoice = $('.wfai-voice');

  // ---- speech: dictation, read-aloud, voice mode (shared engine: ai-voice.js) --
  // The engine owns the mic button, the voice-mode toggle and playback; this panel tells it when a
  // turn starts / streams / ends and asks it for Listen buttons. Routes are the rail's own
  // (/assist/tts, admitted by the staff+act check); hidden until /assist/me reports transcribe / tts.
  var msgKeySeq = 0;
  function msgKey(m) { return m.id != null ? String(m.id) : (m._k || (m._k = 'k' + (++msgKeySeq))); }
  // If the shared engine did not load (a partial deploy), the panel must still chat: a no-op engine.
  function noSpeech() {
    var no = function () {}, f = function () { return false; };
    return { micReady: false, ttsReady: false, enableMic: no, enableVoice: no, dictActive: f, dictBusy: f, dictStart: no,
      dictFinish: function () { return Promise.resolve(); }, dictStop: no, noteSend: function () { return { dictated: false }; }, undoSend: no,
      turnBegin: f, turnDelta: no, turnEnd: no, turnError: no, afterTurn: no, speak: no, toggleSpeak: no, speakStop: no,
      listenButton: function () { return document.createElement('span'); }, playingId: function () { return null; }, voiceMode: f, setVoiceMode: no, setReader: no };
  }
  var V = window.WFVoice ? window.WFVoice.create({
    base: BASE, ttsPath: '/assist/tts', readerPath: '/assist/reader',
    token: function () { return CFG.token; }, ensureToken: ensureToken,
    textarea: elText, micButton: elMic, voiceButton: elVoice,
    toast: toast, autoResize: autoResize,
    send: function () { send(); },
    isBusy: function () { return state.streaming || !!state.viewing; }, // no hands-free turns into a read-only transcript
    lastAssistant: function () {
      for (var i = state.messages.length - 1; i >= 0; i--) {
        var m = state.messages[i];
        if (m.role === 'assistant') return { id: msgKey(m), text: m.content, btn: elMsgs.querySelector('.wfaic-msg[data-id="' + msgKey(m) + '"] .wfai-speak') };
      }
      return null;
    }
  }) : noSpeech();

  // ---- rendering ------------------------------------------------------------
  function scrollDown() { elMsgsWrap.scrollTop = elMsgsWrap.scrollHeight; }
  function msgEl(m) {
    var wrap = el('div', 'wfaic-msg ' + m.role);
    wrap.dataset.id = msgKey(m);
    var who = el('div', 'who');
    who.textContent = m.role === 'assistant' ? 'Advisor'
      : (m.meta && m.meta.staff ? m.meta.staff : (state.viewing ? CLIENT : 'You'));
    var when = m.created_at ? relTime(m.created_at) : '';
    if (when) { var w2 = el('span', 'when'); w2.textContent = when; who.appendChild(w2); }
    wrap.appendChild(who);
    var content = el('div', 'content');
    if (m.role === 'assistant') content.innerHTML = renderMarkdown(m.content);
    else content.textContent = m.content;
    wrap.appendChild(content);
    if (m.role === 'assistant' && m.content) {
      var acts = el('div', 'actions');
      var cp = el('button', null, '<i class="fa fa-clipboard"></i>'); cp.title = 'Copy';
      cp.onclick = function () { copyText(m.content); };
      acts.appendChild(cp);
      if (V.ttsReady) acts.appendChild(V.listenButton(msgKey(m), m.content, { icon: true }));
      wrap.appendChild(acts);
    }
    return wrap;
  }
  function sysNoteEl(m) {
    return el('div', 'wfai-sysnote', '<i class="fa fa-info-circle"></i> ' + escapeHtml(m.content));
  }
  function renderMessages() {
    elMsgs.innerHTML = '';
    root.classList.toggle('wfaic-viewing', !!state.viewing);
    if (state.viewing) {
      var bn = el('div', 'wfaic-viewbanner',
        '<i class="fa fa-eye"></i> ' + escapeHtml(CLIENT) + '’s chat with the advisor' +
        '<button class="back">Back to team chat</button>');
      bn.querySelector('.back').onclick = exitClientChat;
      elMsgs.appendChild(bn);
    }
    if (!state.messages.length) { if (!state.viewing) renderEmpty(); return; }
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      elMsgs.appendChild(m.role === 'system' ? sysNoteEl(m) : msgEl(m));
    }
    hydrateCharts(elMsgs);
    scrollDown();
  }
  function renderEmpty() {
    var e = el('div', 'wfaic-empty');
    e.appendChild(el('div', 'logo', '<i class="fa fa-tint"></i>'));
    var h = el('h1'); h.textContent = 'Chat about ' + CLIENT; e.appendChild(h);
    var sug = el('div', 'suggest');
    SUGGESTIONS.forEach(function (s) {
      var b = el('button'); b.textContent = s;
      b.onclick = function () { elText.value = s; autoResize(); send(); };
      sug.appendChild(b);
    });
    e.appendChild(sug);
    elMsgs.appendChild(e);
  }

  // Empty-chat suggestions: the built-ins render instantly and stand in if the fetch fails; the
  // served list (broker audience — edited in the AI Trainer's Questions tab) replaces them.
  var SUGGESTIONS = [
    'Verify accurate account setup',
    'Summarise this client’s position and anything that needs attention',
    'What are their allocation holdings worth at current prices?',
    'Any carryover or deadline risk for them this season?'
  ];
  function loadSuggestions() {
    return api('GET', '/assist/default-questions').then(function (r) {
      if (!r || !Array.isArray(r.questions)) return;
      SUGGESTIONS = r.questions;
      if (!state.messages.length && !state.viewing && !state.streaming) renderMessages();
    }).catch(function () {});
  }

  // streaming assistant bubble
  var streamEl = null, streamBuf = '', toolChip = null;
  function beginStreaming() {
    streamBuf = '';
    streamEl = el('div', 'wfaic-msg assistant');
    var who = el('div', 'who'); who.textContent = 'Advisor'; streamEl.appendChild(who);
    streamEl.appendChild(el('div', 'content', '<span class="wfai-cursor"></span>'));
    elMsgs.appendChild(streamEl);
    scrollDown();
  }
  function updateStreaming() {
    if (!streamEl) return;
    var c = streamEl.querySelector('.content');
    c.innerHTML = renderMarkdown(streamBuf) + '<span class="wfai-cursor"></span>';
    scrollDown();
  }
  function showTool(name) {
    if (!streamEl) return;
    if (toolChip) toolChip.remove();
    toolChip = el('div', 'wfai-tool', toolLabel(name));
    streamEl.appendChild(toolChip);
    scrollDown();
  }
  function endStreaming() {
    if (toolChip) { toolChip.remove(); toolChip = null; }
    streamEl = null; streamBuf = '';
  }

  function setStreaming(on) {
    state.streaming = on;
    if (on) V.dictStop(); // a turn starting ends dictation (its words are already in the composer)
    elSend.innerHTML = on ? '<i class="fa fa-stop"></i>' : '<i class="fa fa-arrow-up"></i>';
    elSend.classList.toggle('stop', on);
    elSend.title = on ? 'Stop' : 'Send';
  }

  // ---- brokerage: order confirmation cards ---------------------------------
  // The advisor can only STAGE an order for the client; it is placed on the client's account
  // when the broker clicks Confirm here (their own staff token, recorded on the order, the CRM
  // note and the broker task). Same card as the client's chat, addressed to the broker.
  function fmtNum(n) { var x = Number(n); return isNaN(x) ? String(n) : x.toLocaleString(); }

  function orderCard(o) {
    var isW = o.side === 'WITHDRAW';
    var isFwd = !isW && !!o.delivery_date;
    var card = el('div', 'wfai-order-card');
    var title = isW
      ? 'Withdraw ' + CLIENT + '’s order #' + o.target_order_id
      : (isFwd ? 'FORWARD ' : '') + (o.side === 'BUY' ? 'Buy' : 'Sell') + ' ' + fmtNum(o.volume_ml) + ' ML ' +
        (o.is_permanent ? 'entitlement' : 'allocation') + ' for ' + CLIENT;
    var band = o.preview && o.preview.recent_12m_price_band;
    var rows = '' +
      '<div class="r"><span>Region</span><b></b></div>' +
      (isW ? '' :
        '<div class="r"><span>Volume</span><b>' + fmtNum(o.volume_ml) + ' ML</b></div>' +
        '<div class="r"><span>Price</span><b>$' + fmtNum(o.price_per_ml) + ' / ML</b></div>' +
        '<div class="r"><span>Order value</span><b>$' + fmtNum(o.preview && o.preview.gross_value) + '</b></div>' +
        (isFwd ? '<div class="r fwd"><span>Delivery date</span><b>' + escapeHtml(o.delivery_date) + '</b></div>' : '') +
        (o.split ? '<div class="r split"><span>Partial fills</span><b>allowed — min ' + fmtNum(o.min_split_quantity) + ' ML' +
          (o.max_split_parcel_size ? ', max ' + fmtNum(o.max_split_parcel_size) + ' ML per fill' : '') + '</b></div>' : '') +
        (band && band.trades > 0 ? '<div class="r"><span>Settled last 12 m</span><b>$' + fmtNum(band.min_pml) + '–$' + fmtNum(band.max_pml) + ' (median $' + fmtNum(band.median_pml) + ')</b></div>' : '') +
        '<div class="r"><span>Order expires</span><b>' + escapeHtml(o.expiry || 'End of season') + '</b></div>');
    card.innerHTML =
      '<div class="head"><i class="fa ' + (isW ? 'fa-undo' : 'fa-exchange') + '"></i> ' + escapeHtml(title) +
        '<span class="tag">needs your confirmation</span></div>' +
      '<div class="rows">' + rows + '</div>' +
      (isFwd && o.preview && o.preview.forward_note
        ? '<div class="warn fwd"><i class="fa fa-calendar"></i> ' + escapeHtml(o.preview.forward_note) + '</div>' : '') +
      (o.split && o.preview && o.preview.split_note
        ? '<div class="warn split"><i class="fa fa-scissors"></i> ' + escapeHtml(o.preview.split_note) + '</div>' : '') +
      (isW ? '' :
        '<label class="tc"><input type="checkbox" class="tcbox"/> ' + escapeHtml(CLIENT) + ' has instructed this order and accepts the Waterfind terms &amp; conditions</label>') +
      '<div class="warn"><i class="fa fa-exclamation-triangle"></i> ' +
        (isW ? 'This withdraws ' + escapeHtml(CLIENT) + '’s resting order from the Waterfind exchange.'
             : 'This places a REAL order on ' + escapeHtml(CLIENT) + '’s account and may trade immediately.') +
        ' Recorded on their file as placed by you via the AI Advisor.</div>' +
      '<div class="btns"><button class="decline">Decline</button><button class="confirm" ' + (isW ? '' : 'disabled') + '>' +
        (isW ? 'Confirm withdrawal' : 'Confirm & place') + '</button></div>' +
      '<div class="result"></div>';
    card.querySelector('.r b').textContent = o.region_name || ('region ' + o.region_id);
    var tc = card.querySelector('.tcbox');
    var btnC = card.querySelector('.confirm'), btnD = card.querySelector('.decline'), resEl = card.querySelector('.result');
    if (tc) tc.addEventListener('change', function () { btnC.disabled = !tc.checked; });
    function busy(on) { btnC.disabled = on || (tc && !tc.checked); btnD.disabled = on; card.classList.toggle('busy', on); }
    btnD.addEventListener('click', function () {
      busy(true);
      api('POST', '/assist/orders/' + o.id + '/cancel').then(function () {
        toast('Order declined'); afterOrderDecision();
      }).catch(function () { busy(false); toast('Could not decline'); });
    });
    btnC.addEventListener('click', function () {
      busy(true);
      resEl.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i> Placing through the Waterfind trade engine…';
      api('POST', '/assist/orders/' + o.id + '/confirm', { tc_accepted: !!(tc && tc.checked) || isW }).then(function (po) {
        if (po.status === 'placed') {
          resEl.innerHTML = '<span class="ok"><i class="fa fa-check-circle"></i> ' +
            (isW ? 'Order withdrawn.' : 'Placed as order #' + po.crm_order_id +
              (po.cleared_trades > 0 ? ' — ' + po.cleared_trades + ' trade(s) cleared immediately.' : ' — resting on the market.')) + '</span>';
          toast(isW ? 'Order withdrawn' : 'Order placed');
        } else {
          resEl.innerHTML = '<span class="err"><i class="fa fa-times-circle"></i> ' +
            escapeHtml(po.error || ('Not placed (' + po.status + ')')) + '</span>';
        }
        setTimeout(afterOrderDecision, 1600);
      }).catch(function (e) {
        busy(false);
        resEl.innerHTML = '<span class="err"><i class="fa fa-times-circle"></i> ' + escapeHtml(e.message || 'failed') + '</span>';
      });
    });
    return card;
  }

  function afterOrderDecision() {
    // the outcome is recorded as a system note in the conversation — reload to show it
    if (state.currentId) openConversation(state.currentId);
    else loadOrderCards();
  }

  function loadOrderCards() {
    elOrders.innerHTML = '';
    if (!state.currentId || state.viewing) return Promise.resolve();
    var convId = state.currentId;
    return api('GET', '/assist/orders?conversation_id=' + convId + '&status=pending').then(function (list) {
      if (state.currentId !== convId || state.viewing) return; // the chat changed while loading
      (list || []).forEach(function (o) { elOrders.appendChild(orderCard(o)); });
      if ((list || []).length) scrollDown();
    }).catch(function (e) { if (window.console && console.error) console.error('wfaic order cards failed:', e); });
  }

  // ---- history dropdown -----------------------------------------------------
  var histMenu = null;
  function closeHist() { if (histMenu) { histMenu.remove(); histMenu = null; } state.histOpen = false; }
  function toggleHist() {
    if (state.histOpen) { closeHist(); return; }
    state.histOpen = true;
    histMenu = el('div', 'wfaic-histmenu');
    var hd = el('div', 'hd'); hd.textContent = 'Chats about ' + CLIENT; histMenu.appendChild(hd);
    if (!state.conversations.length) {
      histMenu.appendChild(el('div', 'none', 'No past chats about this client yet.'));
    }
    state.conversations.forEach(function (c) {
      var row = el('div', 'item' + (c.id === state.currentId ? ' cur' : ''));
      var t = el('span', 't'); t.textContent = c.title || 'New chat'; row.appendChild(t);
      var meta = el('span', 'meta');
      meta.textContent = (c.staff_name ? c.staff_name + ' · ' : '') + relTime(c.updated_at);
      row.appendChild(meta);
      if (c.mine) {
        var del = el('button', 'del', '<i class="fa fa-trash-o"></i>'); del.title = 'Delete (yours only)';
        del.onclick = function (ev) {
          ev.stopPropagation();
          if (!confirm('Delete this chat about ' + CLIENT + '?')) return;
          api('DELETE', '/assist/conversations/' + c.id).then(function () {
            if (state.currentId === c.id) { state.currentId = null; state.messages = []; ss(LS_CONV, null); renderMessages(); }
            loadConversations().then(function () { closeHist(); toggleHist(); });
          }).catch(function (e) { toast(e.message); });
        };
        row.appendChild(del);
      }
      row.onclick = function () { closeHist(); openConversation(c.id); };
      histMenu.appendChild(row);
    });

    // The CLIENT's own advisor chats — browsable read-only (reads are access-logged server-side).
    var chd = el('div', 'hd sub'); chd.textContent = CLIENT + '’s own advisor chats'; histMenu.appendChild(chd);
    var cbox = el('div', 'clientchats', '<div class="none">Loading…</div>');
    histMenu.appendChild(cbox);
    api('GET', '/assist/client-chats').then(function (list) {
      state.clientChats = list || [];
      if (!histMenu || !histMenu.contains(cbox)) return;   // dropdown closed meanwhile
      cbox.innerHTML = '';
      if (!state.clientChats.length) {
        cbox.appendChild(el('div', 'none', CLIENT + ' has not used the advisor yet.'));
        return;
      }
      state.clientChats.forEach(function (c) {
        var row = el('div', 'item client' + (state.viewing && state.viewing.id === c.id ? ' cur' : ''));
        var t = el('span', 't'); t.textContent = c.title || 'Chat'; row.appendChild(t);
        var meta = el('span', 'meta');
        meta.textContent = c.message_count + ' msg · ' + relTime(c.updated_at);
        row.appendChild(meta);
        row.onclick = function () { closeHist(); openClientChat(c); };
        cbox.appendChild(row);
      });
    }).catch(function (e) {
      if (histMenu && histMenu.contains(cbox)) cbox.innerHTML = '<div class="none">' + escapeHtml(e.message) + '</div>';
    });

    elHistWrap.appendChild(histMenu);
  }
  document.addEventListener('click', function (ev) {
    if (state.histOpen && histMenu && !elHistWrap.contains(ev.target)) closeHist();
  });

  // ---- actions --------------------------------------------------------------
  function loadConversations() {
    return api('GET', '/assist/conversations').then(function (list) {
      state.conversations = list || [];
      elHistN.textContent = state.conversations.length ? '(' + state.conversations.length + ')' : '';
    });
  }
  function openConversation(id) {
    // Switching chats stops any reply that is playing; a reload of the SAME chat must not — in
    // voice mode the reply is still being spoken at that moment.
    if (state.currentId !== id || state.viewing) { V.speakStop(); V.dictStop(); } // a live capture must not land in another chat either
    state.viewing = null;
    state.currentId = id; ss(LS_CONV, String(id));
    return api('GET', '/assist/conversations/' + id + '/messages').then(function (msgs) {
      state.messages = msgs || [];
      renderMessages();
      return loadOrderCards();
    }).catch(function () { state.currentId = null; ss(LS_CONV, null); state.messages = []; renderMessages(); loadOrderCards(); });
  }
  function newChat() {
    if (state.streaming) return;
    V.speakStop(); V.dictStop();
    state.viewing = null;
    state.currentId = null; state.messages = []; ss(LS_CONV, null);
    renderMessages(); loadOrderCards(); elText.focus();
  }
  /** Read-only view of one of the CLIENT's own advisor chats. The composer is hidden while
   *  viewing — staff can read the thread but there is no way to post into it. */
  function openClientChat(c) {
    if (state.streaming) return;
    V.speakStop(); V.dictStop(); // a hands-free capture must never auto-send while a client's transcript is on screen
    api('GET', '/assist/client-chats/' + c.id + '/messages').then(function (msgs) {
      state.viewing = { id: c.id, title: c.title };
      state.messages = msgs || [];
      renderMessages(); loadOrderCards();   // no cards over a client's read-only transcript
      elMsgsWrap.scrollTop = 0;   // a transcript reads top-down
    }).catch(function (e) { toast(e.message); });
  }
  function exitClientChat() {
    V.speakStop(); V.dictStop();
    state.viewing = null;
    if (state.currentId) { openConversation(state.currentId); return; }
    state.messages = [];
    renderMessages();
  }
  function ensureConversation() {
    if (state.currentId) return Promise.resolve(state.currentId);
    return api('POST', '/assist/conversations', {}).then(function (c) {
      state.currentId = c.id; ss(LS_CONV, String(c.id));
      return c.id;
    });
  }
  // Send pressed while dictating: the button waits (spinner) for the last words, then the turn goes.
  var sendWaiting = false;
  function send() {
    if (state.streaming) { if (state.abort) state.abort.abort(); setStreaming(false); endStreaming(); return; }
    if (state.viewing) return; // the composer is hidden over a client's read-only transcript; nothing may post from here
    if (V.dictBusy()) {
      // Still dictating: finish first so the utterance in flight lands in the composer, then send.
      if (sendWaiting) return;
      sendWaiting = true; elSend.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i>';
      V.dictFinish().then(function () { sendWaiting = false; if (!state.streaming) elSend.innerHTML = '<i class="fa fa-arrow-up"></i>'; send(); });
      return;
    }
    var text = elText.value.trim();
    if (!text) return;
    // Spoken in -> spoken out: a dictated message gets its reply read aloud (the engine remembers
    // whether the composer text came from the mic).
    var spokenIn = V.noteSend();
    elText.value = ''; autoResize(); ss(LS_DRAFT, null);
    // optimistic user bubble
    if (!state.messages.length) elMsgs.innerHTML = '';
    var um = { role: 'user', content: text, meta: { staff: CFG.staffName || null }, created_at: new Date().toISOString() };
    state.messages.push(um);
    elMsgs.appendChild(msgEl(um));
    setStreaming(true);
    beginStreaming();
    // The reply's key is minted up front so the live speech pipeline is attributed to it: its Listen
    // button renders as Stop while the reply is still being spoken.
    var replyKey = 'k' + (++msgKeySeq);
    var spoken = V.turnBegin({ id: replyKey }); // voice mode / dictated send: speak sentences as they stream, not after the turn
    ensureConversation().then(function (id) {
      return streamTurn('/assist/conversations/' + id + '/chat', { message: text }, {
        onDelta: function (t) { streamBuf += t; updateStreaming(); if (spoken) V.turnDelta(t); },
        // One-shot hook: whoever queued this turn (e.g. "Ask advisor" on a call note) learns the
        // conversation + stored user-message id of the turn it just sent.
        onTool: function (name) { showTool(name); },
        onDone: function (evt) {
          endStreaming(); setStreaming(false);
          state.messages.push({ role: 'assistant', content: evt.text || streamBuf, created_at: new Date().toISOString(), _k: replyKey });
          if (spoken) V.turnEnd();
          renderMessages();
          loadOrderCards();   // a prepare_* call this turn left a card waiting
          loadConversations();
          V.afterTurn(); // voice mode: read the reply (if not already spoken live), then listen again
        },
        onError: function (msg) {
          endStreaming(); setStreaming(false);
          V.turnError(); // an errored turn breaks the hands-free loop
          var e2 = el('div', 'wfaic-error', '<i class="fa fa-exclamation-triangle"></i> ' + escapeHtml(msg || 'Something went wrong.'));
          elMsgs.appendChild(e2); scrollDown();
        }
      });
    }).catch(function (e) {
      endStreaming(); setStreaming(false);
      V.turnError();
      state.messages.pop(); renderMessages();            // the optimistic bubble never went anywhere
      elText.value = text; autoResize(); V.undoSend(spokenIn); // keep what was typed/said for a retry
      toast(e.message || 'Could not start the chat');
    });
  }


  // ---- events ---------------------------------------------------------------
  function autoResize() { elText.style.height = 'auto'; elText.style.height = Math.min(elText.scrollHeight, 140) + 'px'; }
  elText.addEventListener('input', function () {
    autoResize();
    ss(LS_DRAFT, elText.value || null);   // survive the CRM's full-page postbacks
  });
  elText.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
    if (ev.key === 'Escape' && !POPOUT && !V.dictBusy()) post({ type: 'wfai-close' }); // Escape while dictating just stops the mic
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && state.histOpen) { closeHist(); return; }
    if (ev.key === 'Escape' && state.viewing) { exitClientChat(); return; }
    if (ev.key === 'Escape' && !POPOUT && document.activeElement !== elText) post({ type: 'wfai-close' });
  });
  elSend.onclick = send;
  $('.newchat').onclick = newChat;
  elHistBtn.onclick = toggleHist;
  if (!POPOUT) {
    $('.wfaic-head .x').onclick = function () { post({ type: 'wfai-close' }); };
    $('.wfaic-head .w').onclick = function () { post({ type: 'wfai-width' }); };
    $('.wfaic-head .pop').onclick = function () { post({ type: 'wfai-popout' }); };
  }

  // ---- boot -----------------------------------------------------------------
  loadSuggestions();
  api('GET', '/assist/me').then(function (me) {
    if (me && me.reader) V.setReader(me.reader); // which reader speaks: the phone voice via Retell, or OpenAI
    if (me && me.transcribe) V.enableMic();
    if (me && me.tts) { V.enableVoice(); if (state.messages.length && !state.streaming) renderMessages(); } // add Listen buttons to already-rendered replies
  }).catch(function () {});
  var draft = ss(LS_DRAFT);
  if (draft) { elText.value = draft; autoResize(); }
  loadConversations().then(function () {
    var saved = Number(ss(LS_CONV));
    if (saved && state.conversations.some(function (c) { return c.id === saved; })) {
      return openConversation(saved);
    }
    renderMessages();
  }).catch(function (e) {
    elMsgs.innerHTML = '';
    var msg = /staff only|403/.test(e.message || '') ? 'This panel is for Waterfind staff accounts.' : (e.message || 'The advisor service is unavailable.');
    elMsgs.appendChild(el('div', 'wfaic-error', '<i class="fa fa-exclamation-triangle"></i> ' + escapeHtml(msg)));
  });
  elText.focus();
})();
