/* AI Water Advisor — chat SPA. Talks to the sidecar with the CRM-minted bearer token. */
(function () {
  'use strict';
  var WFAI = window.WFAI || {};
  var BASE = (WFAI.baseUrl || '').replace(/\/$/, '');
  var tokenExp = Math.floor(Date.now() / 1000) + (WFAI.tokenTtl || 1800);

  var state = { conversations: [], projects: [], expanded: {}, newChatProjectId: null, currentId: null, messages: [], settings: { theme: 'light', custom_instructions: null }, streaming: false, abort: null, pendingAtts: [] };

  // ---- utils ---------------------------------------------------------------
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = el('div', 'wfai-toast', escapeHtml(msg)); document.body.appendChild(t); requestAnimationFrame(function () { t.classList.add('show'); }); setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 250); }, 1800); }
  function copyText(t) { if (navigator.clipboard) { navigator.clipboard.writeText(t).then(function () { toast('Copied'); }); } else { var ta = el('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Copied'); } catch (e) {} ta.remove(); } }

  // ---- markdown (safe subset) ---------------------------------------------
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
        out += '<pre><button class="copy-code wfai-head-btn" title="Copy code" data-code="' + encodeURIComponent(joined) + '"><i class="fa fa-clipboard"></i></button><code>' + escapeHtml(joined) + '</code></pre>'; continue;
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

  // ---- markdown tables -------------------------------------------------------
  function isTableSep(s) { return s.indexOf('|') >= 0 && /-{3,}/.test(s) && /^\s*\|?[\s:|-]+\|?\s*$/.test(s); }
  function isTableStart(lines, i) { return lines[i].indexOf('|') >= 0 && !isTableSep(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]); }
  function splitRow(s) { return s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); }

  // ---- charts (fenced ```chart blocks with a JSON spec → inline SVG) --------
  // Palette: dataviz reference categorical slots 1–4, validated for both themes
  // against this UI's surfaces (see ai-advisor.css --wfai-s*). Fixed slot order.
  var SERIES_COLORS = ['var(--wfai-s1)', 'var(--wfai-s2)', 'var(--wfai-s3)', 'var(--wfai-s4)'];
  var SVGNS = 'http://www.w3.org/2000/svg';

  function chartHtml(jsonText, closed) {
    if (!closed) return '<div class="wfai-chart pending"><i class="fa fa-line-chart"></i> Building chart…</div>';
    var spec = null;
    try { spec = normalizeChartSpec(JSON.parse(jsonText)); } catch (e) { spec = null; }
    if (!spec) return '<div class="wfai-chart pending"><i class="fa fa-exclamation-circle"></i> Chart could not be rendered.</div>';
    return '<div class="wfai-chart" data-spec="' + encodeURIComponent(JSON.stringify(spec)) + '"></div>';
  }

  // Clamp an untrusted spec to what buildChart can draw: ≤4 series, ≤60 points,
  // numbers-or-null data padded to x's length. Returns null if nothing plottable.
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
    var W = 640, H = 300, padT = 12, padB = 28, padL = 52;
    var n = spec.x.length, isBar = spec.type === 'bar';
    var padR = (!isBar && spec.series.length <= 2) ? 48 : 14;   // room for line end-labels
    var plotW = W - padL - padR, plotH = H - padT - padB;

    // domain from data (+ band); bars always include the zero baseline
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

    // scaffold: header (title · unit · table toggle), plot, legend
    mount.innerHTML = '';
    var hd = el('div', 'hd');
    var tSpan = el('span', 't'); tSpan.textContent = spec.title || 'Chart'; hd.appendChild(tSpan);
    if (spec.unit) { var uSpan = el('span', 'u'); uSpan.textContent = spec.unit; hd.appendChild(uSpan); }
    var tblBtn = el('button', 'tbl'); tblBtn.title = 'View as table'; tblBtn.innerHTML = '<i class="fa fa-table"></i>'; hd.appendChild(tblBtn);
    mount.appendChild(hd);
    var plot = el('div', 'plot'); plot.tabIndex = 0; mount.appendChild(plot);
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' }, null); plot.appendChild(svg);
    if (spec.title) svg.setAttribute('aria-label', spec.title);

    // gridlines + y tick labels (clean multiples of the nice step)
    for (var gv = d0; gv <= d1 + step / 2; gv += step) {
      svgEl('line', { x1: padL, x2: W - padR, y1: Y(gv), y2: Y(gv), 'class': 'grid' }, svg);
      svgEl('text', { x: padL - 8, y: Y(gv) + 4, 'class': 'ylbl' }, svg).textContent = fmtVal(gv);
    }
    var baseV = (d0 <= 0 && d1 >= 0) ? 0 : d0;
    svgEl('line', { x1: padL, x2: W - padR, y1: Y(baseV), y2: Y(baseV), 'class': 'axis' }, svg);

    // x labels — at most ~8, always the last (skip a tick that would collide with it)
    var xstep = Math.max(1, Math.ceil(n / 8));
    for (var xi = 0; xi < n; xi++) {
      if (!(xi === n - 1 || (xi % xstep === 0 && n - 1 - xi >= xstep / 2))) continue;
      svgEl('text', { x: X(xi), y: H - 8, 'class': 'xlbl' }, svg).textContent = spec.x[xi];
    }

    // band (min–max envelope) behind the lines, a 10% wash
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
      var groupW = m * barW + 2 * (m - 1);   // 2px surface gap between grouped bars
      var y0 = Y(baseV);
      spec.series.forEach(function (s, si) {
        for (var i5 = 0; i5 < n; i5++) {
          var v5 = s.data[i5]; if (v5 == null) continue;
          var bx = X(i5) - groupW / 2 + si * (barW + 2), by = Y(v5);
          var top = Math.min(by, y0), hgt = Math.abs(y0 - by);
          var r = Math.min(4, barW / 2, hgt), dp;
          if (v5 >= 0) {   // 4px rounded data-end, square at the baseline
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
        for (var i4 = 0; i4 < n; i4++) {   // dots at every point when sparse, else end-dot only
          if (s.data[i4] == null || (n > 20 && i4 !== lastIdx)) continue;
          svgEl('circle', { cx: X(i4), cy: Y(s.data[i4]), r: 4, 'class': 'dot', style: 'fill:' + color }, svg);
        }
        if (spec.series.length <= 2 && lastIdx >= 0) {   // selective end-label, in ink not series color
          var ly = Y(s.data[lastIdx]);
          if (!endYs.some(function (p) { return Math.abs(p - ly) < 13; })) {
            endYs.push(ly);
            svgEl('text', { x: X(lastIdx) + 8, y: ly + 4, 'class': 'vlbl' }, svg).textContent = fmtVal(s.data[lastIdx]);
          }
        }
      });
    }

    // hover/focus layer: crosshair (line) or column-snap (bar), one tooltip with every series
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
    var kbIdx = -1;   // keyboard gets the same readout as hover
    plot.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        kbIdx = kbIdx < 0 ? (ev.key === 'ArrowRight' ? 0 : n - 1) : Math.max(0, Math.min(n - 1, kbIdx + (ev.key === 'ArrowRight' ? 1 : -1)));
        showTip(kbIdx); ev.preventDefault();
      } else if (ev.key === 'Escape') { kbIdx = -1; hideTip(); }
    });
    plot.addEventListener('blur', function () { kbIdx = -1; hideTip(); });

    // legend — always for ≥2 series or a band; a single bare series is named by the title
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

    // built-in table view (accessibility relief for the low-contrast slots)
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

  // ---- tool activity labels -------------------------------------------------
  var TOOL_LABELS = {
    get_my_profile: 'Looking up your account…', get_my_holdings: 'Checking your holdings…',
    estimate_my_seasonal_allocation: 'Estimating your seasonal allocation…',
    get_my_trade_history: 'Reviewing your trade history…', get_my_settlement_progress: 'Checking settlement progress…',
    get_my_disputes: 'Checking dispute history…', get_my_engagement: 'Reviewing your account activity…',
    get_my_context: 'Reviewing your crop & interests…', get_my_water_account: 'Checking your water account…',
    get_my_account_setup: 'Reviewing your account setup…',
    find_region: 'Finding the market region…', get_region_tradability: 'Checking where you can trade…',
    get_matchable_orders: 'Scanning the live order book…', get_market_liquidity: 'Assessing market liquidity…',
    get_price_band: 'Pulling recent settled prices…', get_market_reference: 'Building a price reference…',
    get_region_allocation: 'Checking announced allocations…', get_allocation_trajectory: 'Charting the allocation season…',
    get_climate_drivers: 'Checking climate drivers…', estimate_net_proceeds: 'Estimating net proceeds…',
    get_market_events: 'Checking market events…',
    prepare_sell_order: 'Preparing your sell order…', prepare_buy_order: 'Preparing your buy order…',
    prepare_order_withdrawal: 'Preparing the withdrawal…',
    get_my_open_orders: 'Checking your open orders…', get_my_ai_orders: 'Checking your AI order history…'
  };
  function toolLabel(name) {
    if (name === 'WebSearch' || name === 'WebFetch') return '<i class="fa fa-search"></i> Searching the web…';
    var m = /^mcp__wf__(.+)$/.exec(name || '');
    if (m) return '<i class="fa fa-database"></i> ' + escapeHtml(TOOL_LABELS[m[1]] || 'Checking your data…');
    return '<i class="fa fa-cog"></i> Working…';
  }

  // ---- api -----------------------------------------------------------------
  function authHeaders() { return { Authorization: 'Bearer ' + WFAI.token, 'Content-Type': 'application/json' }; }
  function ensureToken() {
    var now = Math.floor(Date.now() / 1000);
    if (tokenExp - now > 120 || !WFAI.refreshUrl) return Promise.resolve();
    return fetch(WFAI.refreshUrl, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.token) { WFAI.token = j.token; tokenExp = j.exp; } }).catch(function () {});
  }
  function api(method, path, body) {
    return ensureToken().then(function () {
      return fetch(BASE + path, { method: method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
    }).then(function (r) {
      if (r.status === 401) { toast('Session expired — please reload'); throw new Error('401'); }
      if (r.status === 403) {
        return r.json().catch(function () { return {}; }).then(function (e) {
          if (e && e.error === 'advisor_disabled') advisorDisabled();
          throw new Error(e && e.message ? e.message : 'HTTP 403');
        });
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }
  // Flag was switched off mid-session: reload the page — the CRM host JSP re-checks the
  // flag server-side and renders the reach-out-for-access card instead of the chat.
  function advisorDisabled() {
    toast('AI Advisor access is not enabled on your account');
    setTimeout(function () { location.reload(); }, 1500);
  }
  // SSE via fetch stream. handlers: {onUser,onDelta,onTool,onDone,onError}
  function streamTurn(path, body, handlers) {
    return ensureToken().then(function () {
      var ac = new AbortController(); state.abort = ac;
      return fetch(BASE + path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}), signal: ac.signal })
        .then(function (res) {
          var ct = res.headers.get('content-type') || '';
          if (!res.ok && ct.indexOf('application/json') >= 0) { return res.json().then(function (e) { if (e && e.error === 'advisor_disabled') advisorDisabled(); handlers.onError && handlers.onError(e.message || e.error || ('HTTP ' + res.status)); }); }
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
                if (evt.type === 'user') handlers.onUser && handlers.onUser(evt);
                else if (evt.type === 'delta') handlers.onDelta && handlers.onDelta(evt.text);
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

  // ---- attachments -----------------------------------------------------------
  var ATT_MAX_PER_MSG = 5, attSeq = 0, attBlobCache = {};
  var ATT_EXT = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', pdf: 'pdf',
    csv: 'text', tsv: 'text', txt: 'text', log: 'text', md: 'text', json: 'text', xml: 'text' };
  var ATT_MAX_BYTES = { image: 5 * 1048576, pdf: 10 * 1048576, text: 256 * 1024 };

  function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function fmtSize(b) { b = Number(b) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function attIcon(kind) { return kind === 'image' ? 'fa-file-image-o' : kind === 'pdf' ? 'fa-file-pdf-o' : 'fa-file-text-o'; }

  /** Owner-authed fetch of an attachment's bytes -> cached object URL (promise-cached: no
   *  duplicate fetch when a thumbnail and a click race for the same id). */
  function attUrl(id) {
    if (!attBlobCache[id]) {
      attBlobCache[id] = ensureToken().then(function () {
        return fetch(BASE + '/attachments/' + id, { headers: { Authorization: 'Bearer ' + WFAI.token } });
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (b) { return URL.createObjectURL(b); })
        .catch(function (e) { delete attBlobCache[id]; throw e; });
    }
    return attBlobCache[id];
  }
  function openAtt(a) {
    (a._localUrl ? Promise.resolve(a._localUrl) : attUrl(a.id)).then(function (url) {
      var link = el('a'); link.href = url; link.target = '_blank';
      if (a.kind !== 'image') link.download = a.filename || 'attachment';
      document.body.appendChild(link); link.click(); link.remove();
    }).catch(function () { toast('Could not open attachment'); });
  }

  /** A chip (or image thumbnail) for one attachment, used in the composer and in messages. */
  function attChip(a, opts) {
    opts = opts || {};
    var chip = el('div', 'wfai-att' + (a.kind === 'image' ? ' img' : '') + (opts.uploading ? ' uploading' : ''));
    if (a.kind === 'image') {
      var img = document.createElement('img'); img.alt = a.filename || 'image';
      if (a._localUrl) img.src = a._localUrl;
      else if (a.id) attUrl(a.id).then(function (u) { img.src = u; }).catch(function () { chip.classList.add('broken'); });
      chip.appendChild(img);
    } else {
      chip.innerHTML = '<i class="fa ' + attIcon(a.kind) + '"></i><span class="nm"></span><span class="sz">' + fmtSize(a.size_bytes) + '</span>';
      chip.querySelector('.nm').textContent = a.filename || 'file';
    }
    chip.title = (a.filename || '') + (opts.uploading ? ' (uploading…)' : '');
    if (opts.uploading) chip.appendChild(el('span', 'spin', '<i class="fa fa-circle-o-notch fa-spin"></i>'));
    if (opts.onRemove) {
      var rm = el('button', 'rm', '<i class="fa fa-times"></i>'); rm.title = 'Remove';
      rm.addEventListener('click', function (e) { e.stopPropagation(); opts.onRemove(); });
      chip.appendChild(rm);
    } else if (a.id) {
      chip.classList.add('openable');
      chip.addEventListener('click', function () { openAtt(a); });
    }
    return chip;
  }

  function renderAttachRow() {
    if (!elAttachRow) return;
    elAttachRow.innerHTML = '';
    elAttachRow.hidden = !state.pendingAtts.length;
    state.pendingAtts.forEach(function (item) {
      elAttachRow.appendChild(attChip(
        { id: item.id, filename: item.name, kind: item.kind, size_bytes: item.size, _localUrl: item.objectUrl },
        { uploading: item.status === 'uploading', onRemove: function () { removePendingAtt(item.key); } }));
    });
  }
  function removePendingAtt(key) {
    state.pendingAtts = state.pendingAtts.filter(function (a) {
      if (a.key !== key) return true;
      if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
      return false;
    });
    renderAttachRow();
  }

  function addFiles(files) {
    if (state.streaming) return;
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    list.forEach(function (f) {
      var kind = ATT_EXT[extOf(f.name)];
      if (!kind) { toast('Unsupported file type: ' + (f.name || '?')); return; }
      if (f.size > ATT_MAX_BYTES[kind]) { toast(f.name + ' is too large (max ' + fmtSize(ATT_MAX_BYTES[kind]) + ')'); return; }
      if (state.pendingAtts.length >= ATT_MAX_PER_MSG) { toast('At most ' + ATT_MAX_PER_MSG + ' attachments per message'); return; }
      var item = { key: 'a' + (attSeq++), id: null, name: f.name, size: f.size, kind: kind, status: 'uploading',
        objectUrl: kind === 'image' ? URL.createObjectURL(f) : null };
      state.pendingAtts.push(item);
      renderAttachRow();
      ensureToken().then(function () {
        return fetch(BASE + '/attachments?filename=' + encodeURIComponent(f.name), {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + WFAI.token, 'Content-Type': 'application/octet-stream' },
          body: f
        });
      }).then(function (r) {
        return r.json().catch(function () { return { error: 'HTTP ' + r.status }; })
          .then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
      }).then(function (meta) {
        // the item may have been removed while uploading — only mark it if still pending
        if (state.pendingAtts.indexOf(item) < 0) return;
        item.id = meta.id; item.kind = meta.kind; item.status = 'ready';
        if (item.objectUrl) attBlobCache[meta.id] = Promise.resolve(item.objectUrl);
        renderAttachRow();
      }).catch(function (e) {
        removePendingAtt(item.key);
        toast(e.message || 'Upload failed');
      });
    });
  }

  // ---- DOM refs ------------------------------------------------------------
  var root = document.getElementById('wfai-root');
  root.innerHTML =
    '<div class="wfai-side">' +
      '<div class="wfai-side-top">' +
        '<button class="wfai-newchat"><i class="fa fa-plus"></i> New chat</button>' +
        '<div class="wfai-search"><i class="fa fa-search"></i><input type="text" placeholder="Search chats" /></div>' +
      '</div>' +
      '<div class="wfai-convs"></div>' +
      '<div class="wfai-side-foot"><span class="who"><i class="fa fa-user-circle"></i> <span class="uname"></span></span>' +
        '<span><button class="theme" title="Toggle light/dark"><i class="fa fa-moon-o"></i></button>' +
        '<button class="ci" title="Custom instructions"><i class="fa fa-sliders"></i></button></span></div>' +
    '</div>' +
    '<div class="wfai-main">' +
      '<div class="wfai-head"><button class="menu-toggle" title="Menu"><i class="fa fa-bars"></i></button>' +
        '<span class="proj-chip" hidden><i class="fa fa-folder-o"></i> <span class="pn"></span></span>' +
        '<span class="title">New chat</span>' +
        '<button class="export" title="Export as Markdown"><i class="fa fa-download"></i></button></div>' +
      '<div class="wfai-msgs"><div class="wfai-msgs-inner"></div></div>' +
      '<div class="wfai-orders"></div>' +
      '<div class="wfai-composer"><div class="wfai-composer-inner">' +
        '<div class="wfai-attach-row" hidden></div>' +
        '<div class="wfai-input-row">' +
          '<button class="wfai-attach" title="Attach images or files (png, jpg, pdf, csv, txt…)"><i class="fa fa-plus"></i></button>' +
          '<textarea rows="1" placeholder="Ask about Australian water markets, trades, allocations, carryover, IVTs…"></textarea>' +
          '<button class="wfai-mic" title="Dictate" aria-pressed="false" hidden><i class="fa fa-microphone"></i></button>' +
          '<button class="wfai-voice" title="Voice mode" aria-pressed="false" hidden>' +
            '<svg class="wfai-wave" viewBox="0 0 21 16" width="19" height="15" aria-hidden="true" fill="currentColor">' +
              '<rect x="0" y="5" width="2.6" height="6" rx="1.3"/><rect x="4.6" y="2.5" width="2.6" height="11" rx="1.3"/>' +
              '<rect x="9.2" y="0" width="2.6" height="16" rx="1.3"/><rect x="13.8" y="2.5" width="2.6" height="11" rx="1.3"/>' +
              '<rect x="18.4" y="5" width="2.6" height="6" rx="1.3"/></svg></button>' +
          '<button class="wfai-send" title="Send"><i class="fa fa-arrow-up"></i></button></div></div>' +
        '<input type="file" class="wfai-file" multiple hidden accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.csv,.tsv,.txt,.log,.md,.json,.xml" />' +
      '</div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var elConvs = $('.wfai-convs'), elMsgs = $('.wfai-msgs-inner'), elMsgsWrap = $('.wfai-msgs'),
      elTitle = $('.wfai-head .title'), elText = $('.wfai-composer textarea'), elSend = $('.wfai-send'),
      elSide = $('.wfai-side'), elMain = $('.wfai-main'),
      elAttachRow = $('.wfai-attach-row'), elAttachBtn = $('.wfai-attach'), elFile = $('.wfai-file'),
      elMic = $('.wfai-mic'), elVoice = $('.wfai-voice');
  elOrders = $('.wfai-orders');
  $('.uname').textContent = WFAI.userName || 'You';
  // ---- speech: dictation, read-aloud, voice mode (shared engine: ai-voice.js) --
  // The engine owns the mic button, the voice-mode toggle and playback. This page tells it when a
  // turn starts / streams / ends and which reply is newest, and asks it for Listen buttons. Both
  // capabilities stay hidden until /me reports transcribe / tts (enableMic / enableVoice in init).
  // If the shared engine did not load (a partial deploy), the page must still chat: a no-op engine.
  function noSpeech() {
    var no = function () {}, f = function () { return false; };
    return { micReady: false, ttsReady: false, enableMic: no, enableVoice: no, dictActive: f, dictBusy: f, dictStart: no,
      dictFinish: function () { return Promise.resolve(); }, dictStop: no, noteSend: function () { return { dictated: false }; }, undoSend: no,
      turnBegin: f, turnDelta: no, turnEnd: no, turnError: no, afterTurn: no, speak: no, toggleSpeak: no, speakStop: no,
      listenButton: function () { return document.createElement('span'); }, playingId: function () { return null; }, voiceMode: f, setVoiceMode: no, setReader: no };
  }
  var V = window.WFVoice ? window.WFVoice.create({
    base: BASE, ttsPath: '/tts', readerPath: '/reader',
    token: function () { return WFAI.token; }, ensureToken: ensureToken,
    textarea: elText, micButton: elMic, voiceButton: elVoice,
    toast: toast, autoResize: autoResize,
    send: function () { send(); },
    isBusy: function () { return state.streaming; },
    lastAssistant: function () {
      for (var i = state.messages.length - 1; i >= 0; i--) {
        var m = state.messages[i];
        if (m.role === 'assistant') return { id: m.id, text: m.content, btn: elMsgs.querySelector('.wfai-msg[data-id="' + m.id + '"] .wfai-speak') };
      }
      return null;
    }
  }) : noSpeech();


  // ---- rendering -----------------------------------------------------------
  function setTheme(t) { document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light'); var ic = $('.theme i'); if (ic) ic.className = t === 'dark' ? 'fa fa-sun-o' : 'fa fa-moon-o'; }

  function convRow(c) {
    var row = el('div', 'wfai-conv' + (c.id === state.currentId ? ' active' : ''));
    row.innerHTML = '<i class="fa fa-comment-o" style="color:var(--text-dim)"></i><span class="t"></span>' +
      '<span class="acts"><button class="mv" title="Move to project"><i class="fa fa-folder-o"></i></button>' +
      '<button class="rn" title="Rename"><i class="fa fa-pencil"></i></button>' +
      '<button class="del" title="Delete"><i class="fa fa-trash"></i></button></span>';
    row.querySelector('.t').textContent = c.title || 'New chat';
    row.addEventListener('click', function (e) { if (e.target.closest('.acts')) return; openConversation(c.id); });
    row.querySelector('.mv').addEventListener('click', function (e) { e.stopPropagation(); moveToProject(c); });
    row.querySelector('.rn').addEventListener('click', function (e) { e.stopPropagation(); renameConversation(c); });
    row.querySelector('.del').addEventListener('click', function (e) { e.stopPropagation(); deleteConversation(c); });
    return row;
  }

  // Flat list — used for search results only; the default sidebar is the grouped renderSidebar.
  function renderConvList(list) {
    elConvs.innerHTML = '';
    if (!list.length) { elConvs.appendChild(el('div', 'wfai-side-hint', 'No matching conversations.')); return; }
    list.forEach(function (c) { elConvs.appendChild(convRow(c)); });
  }

  function projectRow(p, chats) {
    var open = !!state.expanded[p.id];
    var row = el('div', 'wfai-conv wfai-proj' + (open ? ' open' : ''));
    row.innerHTML = '<i class="fa ' + (open ? 'fa-folder-open-o' : 'fa-folder-o') + '" style="color:var(--text-dim)"></i><span class="t"></span>' +
      '<span class="n">' + chats.length + '</span>' +
      '<span class="acts"><button class="nc" title="New chat in project"><i class="fa fa-plus"></i></button>' +
      '<button class="pi" title="Project instructions"><i class="fa fa-sliders"></i></button>' +
      '<button class="rn" title="Rename project"><i class="fa fa-pencil"></i></button>' +
      '<button class="del" title="Delete project"><i class="fa fa-trash"></i></button></span>' +
      '<i class="fa fa-chevron-right chev"></i>';
    row.querySelector('.t').textContent = p.name;
    row.addEventListener('click', function (e) {
      if (e.target.closest('.acts')) return;
      state.expanded[p.id] = !state.expanded[p.id]; renderSidebar();
    });
    row.querySelector('.nc').addEventListener('click', function (e) { e.stopPropagation(); state.expanded[p.id] = true; newChat(p.id); });
    row.querySelector('.pi').addEventListener('click', function (e) { e.stopPropagation(); openProjectInstructions(p); });
    row.querySelector('.rn').addEventListener('click', function (e) { e.stopPropagation(); renameProject(p); });
    row.querySelector('.del').addEventListener('click', function (e) { e.stopPropagation(); deleteProjectUi(p); });
    return row;
  }

  function renderSidebar() {
    elConvs.innerHTML = '';
    var sec = el('div', 'wfai-sec', '<span>Projects</span><button class="add" title="New project"><i class="fa fa-plus"></i></button>');
    sec.querySelector('.add').addEventListener('click', createProjectUi);
    elConvs.appendChild(sec);
    if (!state.projects.length) elConvs.appendChild(el('div', 'wfai-side-hint', 'Group chats by client, valley or deal.'));
    state.projects.forEach(function (p) {
      var chats = state.conversations.filter(function (c) { return c.project_id === p.id; });
      elConvs.appendChild(projectRow(p, chats));
      if (state.expanded[p.id]) {
        var box = el('div', 'wfai-proj-chats');
        if (!chats.length) box.appendChild(el('div', 'wfai-side-hint', 'No chats yet.'));
        chats.forEach(function (c) { box.appendChild(convRow(c)); });
        elConvs.appendChild(box);
      }
    });
    // Ungrouped = no project, or a project we failed to load — never hide a chat from the sidebar.
    var ungrouped = state.conversations.filter(function (c) { return !c.project_id || !projectById(c.project_id); });
    elConvs.appendChild(el('div', 'wfai-sec', '<span>Chats</span>'));
    if (!ungrouped.length) { elConvs.appendChild(el('div', 'wfai-side-hint', 'No conversations yet.')); return; }
    ungrouped.forEach(function (c) { elConvs.appendChild(convRow(c)); });
  }

  function projectById(id) { return state.projects.filter(function (p) { return p.id === id; })[0] || null; }

  function setHeaderProject(projectId) {
    var chip = $('.wfai-head .proj-chip');
    var p = projectId ? projectById(projectId) : null;
    chip.hidden = !p;
    if (p) chip.querySelector('.pn').textContent = p.name;
  }

  function msgEl(m) {
    if (m.role === 'system') {
      var note = el('div', 'wfai-sysnote');
      note.innerHTML = '<i class="fa fa-info-circle"></i> <span></span>';
      note.querySelector('span').textContent = String(m.content).replace(/^\[order event\]\s*/i, '');
      return note;
    }
    var wrap = el('div', 'wfai-msg ' + (m.role === 'assistant' ? 'assistant' : 'user'));
    wrap.dataset.id = m.id;
    var av = m.role === 'assistant' ? '<i class="fa fa-tint"></i>' : '<i class="fa fa-user"></i>';
    wrap.innerHTML = '<div class="avatar">' + av + '</div><div class="body"><div class="who">' + (m.role === 'assistant' ? 'AI Water Advisor' : (WFAI.userName || 'You')) + '</div><div class="content"></div><div class="actions"></div></div>';
    var content = wrap.querySelector('.content');
    if (m.role === 'assistant') { content.innerHTML = renderMarkdown(m.content); hydrateCharts(content); } else content.textContent = m.content;
    var atts = m.meta && m.meta.attachments;
    if (m.role === 'user' && atts && atts.length) {
      var attWrap = el('div', 'wfai-msg-atts');
      atts.forEach(function (a) { attWrap.appendChild(attChip(a, {})); });
      content.parentNode.insertBefore(attWrap, content);
    }
    var actions = wrap.querySelector('.actions');
    var copyBtn = el('button', '', '<i class="fa fa-clipboard"></i> Copy'); copyBtn.addEventListener('click', function () { copyText(m.content); }); actions.appendChild(copyBtn);
    if (m.role === 'assistant' && V.ttsReady) actions.appendChild(V.listenButton(m.id, m.content));
    if (m.role === 'user') { var editBtn = el('button', '', '<i class="fa fa-pencil"></i> Edit'); editBtn.addEventListener('click', function () { startEdit(wrap, m); }); actions.appendChild(editBtn); }
    return wrap;
  }

  function renderMessages() {
    elMsgs.innerHTML = '';
    if (!state.messages.length) { elMsgs.appendChild(emptyState()); return; }
    state.messages.forEach(function (m, idx) {
      var e = msgEl(m);
      if (m.role === 'assistant' && idx === state.messages.length - 1) {
        var actions = e.querySelector('.actions');
        var regen = el('button', '', '<i class="fa fa-refresh"></i> Regenerate'); regen.addEventListener('click', regenerate); actions.appendChild(regen);
      }
      elMsgs.appendChild(e);
    });
    scrollDown();
  }

  function emptyState() {
    var e = el('div', 'wfai-empty');
    e.innerHTML = '<div class="logo"><i class="fa fa-tint"></i></div><h1>AI Water Advisor</h1>' +
      '<p>Ask about Australian water rights, market conditions, and whether a trade makes sense.</p>' +
      '<div class="wfai-suggest"></div>';
    var sug = e.querySelector('.wfai-suggest');
    SUGGESTIONS.forEach(function (q) { var b = el('button', '', escapeHtml(q)); b.addEventListener('click', function () { elText.value = q; send(); }); sug.appendChild(b); });
    return e;
  }

  // Empty-chat suggestions: the built-ins render instantly and stand in if the fetch fails; the
  // served list (client audience — edited in the AI Trainer's Questions tab) replaces them.
  var SUGGESTIONS = [
    'What\'s the difference between a water allocation and an entitlement?',
    'How do carryover rules work in the southern Murray–Darling Basin?',
    'A client wants to sell 500ML of high-security entitlement — what should I check?',
    'What typically drives allocation prices during a wet season?'
  ];
  function loadSuggestions() {
    return api('GET', '/default-questions').then(function (r) {
      if (!r || !Array.isArray(r.questions)) return;
      SUGGESTIONS = r.questions;
      if (!state.messages.length && !state.streaming) renderMessages();
    }).catch(function () {});
  }

  function scrollDown() { elMsgsWrap.scrollTop = elMsgsWrap.scrollHeight; }

  // ---- streaming assistant element ----------------------------------------
  function beginStreaming() {
    if (!state.messages.length) elMsgs.innerHTML = '';
    var wrap = el('div', 'wfai-msg assistant');
    wrap.innerHTML = '<div class="avatar"><i class="fa fa-tint"></i></div><div class="body"><div class="who">AI Water Advisor</div><div class="tools"></div><div class="content"><span class="wfai-cursor"></span></div></div>';
    elMsgs.appendChild(wrap); scrollDown();
    return wrap;
  }

  // ---- brokerage: order confirmation cards ----------------------------------
  // NB: declaration only (no `= null`) — this runs AFTER the DOM-refs assignment below and a
  // re-initialiser would null the captured element (var is function-scoped/hoisted).
  var elOrders;

  function fmtNum(n) { var x = Number(n); return isNaN(x) ? String(n) : x.toLocaleString(); }

  function orderCard(o) {
    var isW = o.side === 'WITHDRAW';
    var isFwd = !isW && !!o.delivery_date;
    var card = el('div', 'wfai-order-card');
    var title = isW
      ? 'Withdraw your order #' + o.target_order_id
      : (isFwd ? 'FORWARD ' : '') + (o.side === 'BUY' ? 'Buy' : 'Sell') + ' ' + fmtNum(o.volume_ml) + ' ML ' +
        (o.is_permanent ? 'entitlement' : 'allocation');
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
        '<span class="tag">requires your confirmation</span></div>' +
      '<div class="rows">' + rows + '</div>' +
      (isFwd && o.preview && o.preview.forward_note
        ? '<div class="warn fwd"><i class="fa fa-calendar"></i> ' + escapeHtml(o.preview.forward_note) + '</div>' : '') +
      (o.split && o.preview && o.preview.split_note
        ? '<div class="warn split"><i class="fa fa-scissors"></i> ' + escapeHtml(o.preview.split_note) + '</div>' : '') +
      (isW ? '' :
        '<label class="tc"><input type="checkbox" class="tcbox"/> I accept the Waterfind terms &amp; conditions for this order</label>') +
      '<div class="warn"><i class="fa fa-exclamation-triangle"></i> ' +
        (isW ? 'This withdraws your resting order from the Waterfind exchange.'
             : 'This places a REAL order on the Waterfind exchange and may trade immediately.') + '</div>' +
      '<div class="btns"><button class="decline">Decline</button><button class="confirm" ' + (isW ? '' : 'disabled') + '>' +
        (isW ? 'Confirm withdrawal' : 'Confirm & place order') + '</button></div>' +
      '<div class="result"></div>';
    card.querySelector('.head').appendChild(el('span', 'exp', ''));
    card.querySelector('.r b').textContent = o.region_name || ('region ' + o.region_id);
    var tc = card.querySelector('.tcbox');
    var btnC = card.querySelector('.confirm'), btnD = card.querySelector('.decline'), resEl = card.querySelector('.result');
    if (tc) tc.addEventListener('change', function () { btnC.disabled = !tc.checked; });
    function busy(on) { btnC.disabled = on || (tc && !tc.checked); btnD.disabled = on; card.classList.toggle('busy', on); }
    btnD.addEventListener('click', function () {
      busy(true);
      api('POST', '/orders/' + o.id + '/cancel').then(function () {
        toast('Order declined'); afterOrderDecision();
      }).catch(function () { busy(false); toast('Could not decline'); });
    });
    btnC.addEventListener('click', function () {
      busy(true);
      resEl.innerHTML = '<i class="fa fa-circle-o-notch fa-spin"></i> Placing through the Waterfind trade engine…';
      api('POST', '/orders/' + o.id + '/confirm', { tc_accepted: !!(tc && tc.checked) || isW }).then(function (po) {
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
    if (state.currentId) openConversation(state.currentId).then(loadOrderCards);
    else loadOrderCards();
  }

  function loadOrderCards() {
    if (!elOrders) return Promise.resolve();
    elOrders.innerHTML = '';
    if (!state.currentId) return Promise.resolve();
    return api('GET', '/orders?conversation_id=' + state.currentId + '&status=pending').then(function (list) {
      (list || []).forEach(function (o) { elOrders.appendChild(orderCard(o)); });
    }).catch(function (e) { if (window.console && console.error) console.error('wfai order cards failed:', e); });
  }

  // ---- actions -------------------------------------------------------------
  function setStreaming(on) {
    state.streaming = on;
    if (on) V.dictStop(); // a turn starting ends dictation (its words are already in the composer)
    elSend.classList.toggle('stop', on);
    elSend.innerHTML = on ? '<i class="fa fa-stop"></i>' : '<i class="fa fa-arrow-up"></i>';
    elSend.title = on ? 'Stop' : 'Send';
  }
  // Send pressed while dictating: the button waits (spinner) for the last words, then the turn goes.
  var sendWaiting = false;
  function setSendBusy(on) {
    elSend.classList.toggle('busy', on);
    if (!state.streaming) elSend.innerHTML = on ? '<i class="fa fa-circle-o-notch fa-spin"></i>' : '<i class="fa fa-arrow-up"></i>';
  }

  function loadConversations() { return api('GET', '/conversations').then(function (list) { state.conversations = list || []; renderSidebar(); }); }
  function loadProjects() { return api('GET', '/projects').then(function (list) { state.projects = list || []; renderSidebar(); }); }

  // Project the open (or about-to-be-created) chat belongs to — drives the header chip.
  function currentProjectId() {
    if (state.currentId) {
      var c = state.conversations.filter(function (x) { return x.id === state.currentId; })[0];
      return c ? c.project_id : null;
    }
    return state.newChatProjectId;
  }

  function clearPendingAtts() {
    state.pendingAtts.forEach(function (a) { if (a.objectUrl && !a.id) URL.revokeObjectURL(a.objectUrl); });
    state.pendingAtts = []; renderAttachRow();
  }

  function openConversation(id) {
    // Switching chats stops any reply that is playing; a reload of the SAME chat (after a turn, an
    // order event) must not — in voice mode the reply is still being spoken at that moment.
    if (state.currentId !== id) { V.speakStop(); V.dictStop(); clearPendingAtts(); } // attachments stay with the chat they were picked for; a live capture must not land in another chat
    state.currentId = id;
    return api('GET', '/conversations/' + id + '/messages').then(function (msgs) {
      state.messages = msgs || [];
      var c = state.conversations.filter(function (x) { return x.id === id; })[0];
      elTitle.textContent = c ? c.title : 'Chat';
      if (c && c.project_id) state.expanded[c.project_id] = true;
      setHeaderProject(c ? c.project_id : null);
      renderSidebar(); renderMessages();
      loadOrderCards();
    });
  }

  function newChat(projectId) {
    V.speakStop(); V.dictStop(); if (state.currentId !== null) clearPendingAtts();
    state.currentId = null; state.messages = [];
    state.newChatProjectId = projectId || null;
    setHeaderProject(state.newChatProjectId);
    elTitle.textContent = 'New chat'; renderSidebar(); renderMessages(); loadOrderCards(); elText.focus();
  }

  function ensureConversation() {
    if (state.currentId) return Promise.resolve(state.currentId);
    var body = state.newChatProjectId ? { project_id: state.newChatProjectId } : {};
    return api('POST', '/conversations', body).then(function (c) {
      state.currentId = c.id; state.conversations.unshift(c);
      if (c.project_id) state.expanded[c.project_id] = true;
      return c.id;
    }, function (e) {
      // Only a vanished project (deleted in another tab) drops the grouping — transient
      // failures (network, 500) keep it so the retry stays in the project.
      if (state.newChatProjectId && e && e.message === 'HTTP 404') { state.newChatProjectId = null; setHeaderProject(null); loadProjects(); }
      throw e;
    });
  }

  function runTurn(pathBuilder, body, optimisticUser, onRejected) {
    setStreaming(true);
    if (optimisticUser != null) { state.messages.push(optimisticUser); renderMessages(); }
    var wrap = beginStreaming(); var contentEl = wrap.querySelector('.content'); var toolsEl = wrap.querySelector('.tools'); var acc = '';
    var sawUser = false; // server sends {type:'user'} only after the message is persisted
    // Until the first delta or tool event there is nothing on screen — say we're working.
    var labelOn = true;
    toolsEl.innerHTML = '<span class="wfai-tool">Processing…</span>';
    var spoken = V.turnBegin(); // voice mode / dictated send: speak sentences as they stream, not after the turn
    return streamTurn(pathBuilder(state.currentId), body, {
      onUser: function () { sawUser = true; },
      onTool: function (name) { toolsEl.innerHTML = '<span class="wfai-tool">' + toolLabel(name) + '</span>'; labelOn = true; },
      onDelta: function (t) {
        if (labelOn) { toolsEl.innerHTML = ''; labelOn = false; } // model is talking again — drop the stale label
        acc += t; contentEl.innerHTML = renderMarkdown(acc) + '<span class="wfai-cursor"></span>'; hydrateCharts(contentEl); scrollDown();
        if (spoken) V.turnDelta(t);
      },
      onDone: function (evt) { toolsEl.innerHTML = ''; if (evt.title) elTitle.textContent = evt.title; if (spoken) V.turnEnd(); },
      onError: function (msg) {
        toolsEl.innerHTML = ''; contentEl.innerHTML = '<div style="color:#b13636"><i class="fa fa-exclamation-circle"></i> ' + escapeHtml(msg) + '</div>';
        V.turnError(); // an errored turn breaks the hands-free loop
        if (!sawUser && !acc && onRejected) onRejected(); // rejected before persisting -> let the user retry
      }
    }).then(function () {
      setStreaming(false); state.abort = null;
      return openConversation(state.currentId).then(loadConversations).then(V.afterTurn);
    });
  }

  function send() {
    if (state.streaming) return;
    if (V.dictBusy()) {
      // Still dictating: finish first so the utterance in flight lands in the composer, then send.
      if (sendWaiting) return;
      sendWaiting = true; setSendBusy(true);
      V.dictFinish().then(function () { sendWaiting = false; setSendBusy(false); send(); });
      return;
    }
    var text = elText.value.trim();
    if (state.pendingAtts.some(function (a) { return a.status === 'uploading'; })) { toast('Still uploading — one moment'); return; }
    var ready = state.pendingAtts.filter(function (a) { return a.status === 'ready'; });
    if (!text && !ready.length) return;
    var attIds = ready.map(function (a) { return a.id; });
    var attMeta = ready.map(function (a) { return { id: a.id, filename: a.name, kind: a.kind, size_bytes: a.size, _localUrl: a.objectUrl }; });
    var saved = state.pendingAtts;
    // Spoken in -> spoken out: a dictated message gets its reply read aloud (the engine remembers
    // whether the composer text came from the mic).
    var spokenIn = V.noteSend();
    elText.value = ''; autoResize();
    state.pendingAtts = []; renderAttachRow();
    var restore = function () { state.pendingAtts = saved; renderAttachRow(); elText.value = text; autoResize(); V.undoSend(spokenIn); };
    // Guard BEFORE the async conversation-create: a second trigger (Enter + click, or the
    // voice loop) in that window would otherwise start a second, parallel turn.
    setStreaming(true);
    ensureConversation().then(function () {
      return runTurn(function (id) { return '/conversations/' + id + '/chat'; },
        { message: text, attachment_ids: attIds },
        { id: 'tmp-u', role: 'user', content: text, meta: attMeta.length ? { attachments: attMeta } : null },
        restore);
    }).catch(function () { restore(); toast('Could not send — try again'); setStreaming(false); });
  }

  function regenerate() { if (state.streaming || !state.currentId) return; runTurn(function (id) { return '/conversations/' + id + '/regenerate'; }, {}, null); }

  function startEdit(wrap, m) {
    if (state.streaming) return;
    var body = wrap.querySelector('.body');
    var editor = el('div', 'wfai-edit');
    editor.innerHTML = '<div class="wfai-attach-row" hidden></div><textarea></textarea><div class="row"><button class="cancel">Cancel</button><button class="primary save">Save & submit</button></div>';
    var ta = editor.querySelector('textarea'); ta.value = m.content;
    // original attachments carry over unless removed here
    var editAtts = ((m.meta && m.meta.attachments) || []).slice();
    var attRow = editor.querySelector('.wfai-attach-row');
    function renderEditAtts() {
      attRow.innerHTML = ''; attRow.hidden = !editAtts.length;
      editAtts.forEach(function (a) {
        attRow.appendChild(attChip(a, { onRemove: function () {
          editAtts = editAtts.filter(function (x) { return x.id !== a.id; }); renderEditAtts();
        } }));
      });
    }
    renderEditAtts();
    var prev = body.innerHTML; body.innerHTML = ''; body.appendChild(editor); ta.focus(); ta.style.height = (ta.scrollHeight) + 'px';
    editor.querySelector('.cancel').addEventListener('click', function () { renderMessages(); });
    editor.querySelector('.save').addEventListener('click', function () {
      var v = ta.value.trim(); if (!v && !editAtts.length) return;
      // truncate view to before this message, then run edit turn
      var keepAtts = editAtts;
      var idx = state.messages.findIndex(function (x) { return String(x.id) === String(m.id); });
      if (idx >= 0) state.messages = state.messages.slice(0, idx);
      state.messages.push({ id: 'tmp-u', role: 'user', content: v, meta: keepAtts.length ? { attachments: keepAtts } : null }); renderMessages();
      setStreaming(true);
      var wrap2 = beginStreaming(); var c2 = wrap2.querySelector('.content'); var t2 = wrap2.querySelector('.tools'); var acc = '';
      streamTurn('/conversations/' + state.currentId + '/messages/' + m.id + '/edit',
        { content: v, attachment_ids: keepAtts.map(function (a) { return a.id; }) }, {
        onTool: function (name) { t2.innerHTML = '<span class="wfai-tool">' + toolLabel(name) + '</span>'; },
        onDelta: function (t) { acc += t; c2.innerHTML = renderMarkdown(acc) + '<span class="wfai-cursor"></span>'; hydrateCharts(c2); scrollDown(); },
        onDone: function (evt) { t2.innerHTML = ''; if (evt.title) elTitle.textContent = evt.title; },
        onError: function (msg) { c2.innerHTML = '<div style="color:#b13636">' + escapeHtml(msg) + '</div>'; }
      }).then(function () { setStreaming(false); state.abort = null; openConversation(state.currentId).then(loadConversations); });
    });
  }

  function renameConversation(c) {
    var t = window.prompt('Rename conversation', c.title || 'New chat'); if (t == null) return; t = t.trim(); if (!t) return;
    api('PATCH', '/conversations/' + c.id, { title: t }).then(function () { if (c.id === state.currentId) elTitle.textContent = t; loadConversations(); });
  }
  function deleteConversation(c) {
    if (!window.confirm('Delete "' + (c.title || 'New chat') + '"? This cannot be undone.')) return;
    api('DELETE', '/conversations/' + c.id).then(function () { if (c.id === state.currentId) newChat(null); return loadConversations(); });
  }

  // ---- projects ------------------------------------------------------------
  function createProjectUi() {
    var name = window.prompt('Project name'); if (name == null) return; name = name.trim(); if (!name) return;
    api('POST', '/projects', { name: name }).then(function (p) {
      state.projects.unshift(p); state.expanded[p.id] = true; renderSidebar();
    }).catch(function () { toast('Could not create project'); });
  }

  function renameProject(p) {
    var t = window.prompt('Rename project', p.name); if (t == null) return; t = t.trim(); if (!t) return;
    api('PATCH', '/projects/' + p.id, { name: t })
      .then(null, function () { toast('Could not rename project'); })
      .then(loadProjects).then(function () { setHeaderProject(currentProjectId()); });
  }

  function deleteProjectUi(p) {
    if (!window.confirm('Delete project "' + p.name + '"? Its chats will be kept and moved out of the project.')) return;
    api('DELETE', '/projects/' + p.id).then(function () {
      if (state.newChatProjectId === p.id) state.newChatProjectId = null;
      delete state.expanded[p.id];
    }, function () { toast('Could not delete project'); })
      .then(loadConversations).then(loadProjects)
      .then(function () { setHeaderProject(currentProjectId()); });
  }

  function openProjectInstructions(pRef) {
    var p = projectById(pRef.id) || pRef; // never edit from a stale closure
    var bg = el('div', 'wfai-modal-bg');
    bg.innerHTML = '<div class="wfai-modal"><h3>Project instructions</h3>' +
      '<p style="color:var(--text-dim);font-size:13px;margin-top:0">Applied to every chat in "<span class="pnm"></span>", on top of your custom instructions.</p>' +
      '<textarea maxlength="4000" placeholder="e.g. This project covers the Smith family trust — three licences in the Murrumbidgee. Report per-licence and flag carryover limits."></textarea>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="primary save">Save</button></div></div>';
    bg.querySelector('.pnm').textContent = p.name;
    bg.querySelector('textarea').value = p.instructions || '';
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('.cancel').addEventListener('click', function () { bg.remove(); });
    bg.querySelector('.save').addEventListener('click', function () {
      var v = bg.querySelector('textarea').value;
      api('PATCH', '/projects/' + p.id, { instructions: v }).then(function (np) {
        state.projects = state.projects.map(function (x) { return x.id === np.id ? np : x; });
        renderSidebar(); // row handlers must close over the fresh project object
        toast('Saved'); bg.remove();
      }).catch(function () { toast('Could not save'); });
    });
    document.body.appendChild(bg);
  }

  function moveToProject(c) {
    var bg = el('div', 'wfai-modal-bg');
    bg.innerHTML = '<div class="wfai-modal"><h3>Move to project</h3><div class="wfai-proj-pick"></div>' +
      '<div class="row"><button class="cancel">Cancel</button></div></div>';
    var pick = bg.querySelector('.wfai-proj-pick');
    function doMove(pid2) {
      api('PATCH', '/conversations/' + c.id, { project_id: pid2 }).then(function () {
        if (pid2) state.expanded[pid2] = true;
        bg.remove();
        return loadConversations();
      }).then(function () { setHeaderProject(currentProjectId()); toast('Moved'); })
        .catch(function () { toast('Could not move'); });
    }
    var none = el('button', c.project_id ? '' : 'cur', '<i class="fa fa-comment-o"></i> No project');
    none.addEventListener('click', function () { doMove(null); });
    pick.appendChild(none);
    state.projects.forEach(function (p) {
      var b = el('button', p.id === c.project_id ? 'cur' : '', '<i class="fa fa-folder-o"></i> <span class="nm"></span>');
      b.querySelector('.nm').textContent = p.name;
      b.addEventListener('click', function () { doMove(p.id); });
      pick.appendChild(b);
    });
    var np = el('button', '', '<i class="fa fa-plus"></i> New project…');
    np.addEventListener('click', function () {
      var name = window.prompt('Project name'); if (name == null) return; name = name.trim(); if (!name) return;
      api('POST', '/projects', { name: name }).then(function (p) { state.projects.unshift(p); doMove(p.id); })
        .catch(function () { toast('Could not create project'); });
    });
    pick.appendChild(np);
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('.cancel').addEventListener('click', function () { bg.remove(); });
    document.body.appendChild(bg);
  }

  function exportCurrent() {
    if (!state.currentId) { toast('Open a conversation first'); return; }
    ensureToken().then(function () {
      return fetch(BASE + '/conversations/' + state.currentId + '/export?format=md', { headers: authHeaders() });
    }).then(function (r) { return r.blob(); }).then(function (blob) {
      var a = el('a'); var url = URL.createObjectURL(blob); a.href = url; a.download = (elTitle.textContent || 'conversation').replace(/[^a-z0-9-_]+/gi, '_') + '.md';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }).catch(function () { toast('Export failed'); });
  }

  function openCustomInstructions() {
    var bg = el('div', 'wfai-modal-bg');
    bg.innerHTML = '<div class="wfai-modal"><h3>Custom instructions</h3>' +
      '<p style="color:var(--text-dim);font-size:13px;margin-top:0">Tell the advisor how you\'d like it to respond. Applied to every conversation.</p>' +
      '<textarea placeholder="e.g. I\'m a broker in the southern connected system. Keep answers concise and always flag inter-valley transfer limits."></textarea>' +
      '<div class="row"><button class="cancel">Cancel</button><button class="primary save">Save</button></div></div>';
    bg.querySelector('textarea').value = state.settings.custom_instructions || '';
    bg.addEventListener('click', function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector('.cancel').addEventListener('click', function () { bg.remove(); });
    bg.querySelector('.save').addEventListener('click', function () {
      var v = bg.querySelector('textarea').value;
      api('PUT', '/settings', { theme: state.settings.theme, custom_instructions: v }).then(function (s) { state.settings = s; toast('Saved'); bg.remove(); });
    });
    document.body.appendChild(bg);
  }

  function toggleTheme() {
    var next = state.settings.theme === 'dark' ? 'light' : 'dark';
    state.settings.theme = next; setTheme(next);
    api('PUT', '/settings', { theme: next, custom_instructions: state.settings.custom_instructions }).catch(function () {});
  }

  // ---- events --------------------------------------------------------------
  function autoResize() { elText.style.height = 'auto'; elText.style.height = Math.min(elText.scrollHeight, 200) + 'px'; }
  elText.addEventListener('input', autoResize);
  elText.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  elSend.addEventListener('click', function () { if (state.streaming) { if (state.abort) state.abort.abort(); } else { send(); } });
  elAttachBtn.addEventListener('click', function () { elFile.click(); });
  elFile.addEventListener('change', function () { addFiles(elFile.files); elFile.value = ''; });
  elText.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addFiles(files); }
  });
  // drag & drop anywhere over the chat pane
  var elDrop = el('div', 'wfai-drop', '<div class="inner"><i class="fa fa-cloud-upload"></i><p>Drop to attach</p></div>');
  elMain.appendChild(elDrop);
  var dragDepth = 0;
  function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return t && Array.prototype.indexOf.call(t, 'Files') >= 0; }
  elMain.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; elDrop.classList.add('on'); });
  elMain.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  elMain.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; elDrop.classList.remove('on'); } });
  elMain.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; elDrop.classList.remove('on');
    addFiles(e.dataTransfer.files);
  });
  $('.wfai-newchat').addEventListener('click', function () { newChat(null); });
  $('.export').addEventListener('click', exportCurrent);
  $('.theme').addEventListener('click', toggleTheme);
  $('.ci').addEventListener('click', openCustomInstructions);
  $('.menu-toggle').addEventListener('click', function () { elSide.classList.toggle('open'); });
  var searchInput = $('.wfai-search input'); var searchTimer;
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer); var q = searchInput.value.trim();
    searchTimer = setTimeout(function () {
      if (!q) { renderSidebar(); return; }
      api('GET', '/search?q=' + encodeURIComponent(q)).then(function (list) { renderConvList(list || []); });
    }, 200);
  });
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('.copy-code'); if (b) { copyText(decodeURIComponent(b.dataset.code || '')); } });

  // ---- init ----------------------------------------------------------------
  loadSuggestions();
  api('GET', '/settings').then(function (s) { state.settings = s || state.settings; setTheme(state.settings.theme); }).catch(function () {});
  api('GET', '/me').then(function (me) {
    if (me && me.reader) V.setReader(me.reader); // which reader speaks: the phone voice via Retell, or OpenAI
    if (me && me.transcribe) V.enableMic();
    if (me && me.tts) { V.enableVoice(); if (state.messages.length) renderMessages(); } // add Listen buttons to already-rendered replies
  }).catch(function () {});
  Promise.all([loadProjects(), loadConversations()]).then(function () { renderMessages(); }).catch(function (e) { elMsgs.innerHTML = '<div class="wfai-empty"><p>Could not reach the advisor service.</p></div>'; });
  elText.focus();
})();
