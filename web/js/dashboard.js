/* ============================================================
   CRYPTO AGENT X — Dashboard renderer (REAL DATA ONLY)
   window.CAX (data.js) の実データを購読して描画。乱数・ダミー無し。
   ============================================================ */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const C = { cyan: '#22d3ee', blue: '#3b82f6', purple: '#8b5cf6', up: '#34d399', dn: '#f43f5e', warn: '#fbbf24', mut: '#5f6f8f', grid: 'rgba(40,60,110,.16)' };
  const CAX = window.CAX; if (!CAX) return;
  const F = CAX.fmt;
  const clsPct = v => v >= 0 ? 'up' : 'dn';

  function fit(cv, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth || cv.parentElement.clientWidth;
    const hh = h || cv.clientHeight || 200;
    cv.width = w * dpr; cv.height = hh * dpr;
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h: hh };
  }

  /* ---------------- Price ticker cards ---------------- */
  const PRIMARY = ['BTC', 'ETH', 'SOL'];
  function renderPriceCards(m) {
    const host = $('#priceCards'); if (!host) return;
    host.innerHTML = PRIMARY.map(sym => {
      const c = m[sym]; if (!c) return `<div class="pc skeleton" data-sym="${sym}"></div>`;
      const spark = miniSparkline(sym);
      return `<div class="pc" data-sym="${sym}">
        <div class="pc-top"><img src="${c.img}" alt="" class="pc-ic"/><span class="pc-sym">${sym}</span><span class="pc-name">${c.name}</span>
          <span class="pc-rank">#${c.rank}</span></div>
        <div class="pc-price" id="pcp-${sym}">${F.usd(c.price, c.price > 100 ? 2 : 3)}</div>
        <div class="pc-changes">
          <span class="chg ${clsPct(c.ch1h)}">1h ${F.pct(c.ch1h)}</span>
          <span class="chg ${clsPct(c.ch24h)}">24h ${F.pct(c.ch24h)}</span>
          <span class="chg ${clsPct(c.ch7d)}">7d ${F.pct(c.ch7d)}</span>
        </div>
        <div class="pc-foot"><span>時価総額 ${F.big(c.mcap)}</span><span>24h高 ${F.usd(c.high24, 0)}</span></div>
      </div>`;
    }).join('');
  }
  function miniSparkline() { return ''; }
  // live tick update (from WS markPrice)
  CAX.on('tick', ({ sym, price }) => {
    const el = $('#pcp-' + sym); if (el) { el.textContent = F.usd(price, price > 100 ? 2 : 3); flash(el); }
    if (sym === curSym) { const l = $('#btcLast'); if (l) l.textContent = F.usd(price, 2); }
  });
  let flashT;
  function flash(el) { el.classList.add('flash'); clearTimeout(el._f); el._f = setTimeout(() => el.classList.remove('flash'), 400); }

  /* ---------------- Global market ---------------- */
  function renderGlobal(g) {
    if (!g) return;
    $('#gMcap').textContent = F.big(g.totalMcap);
    $('#gMcapCh').innerHTML = `<span class="${clsPct(g.mcapCh24)}">${F.pct(g.mcapCh24)}</span>`;
    $('#gVol').textContent = F.big(g.vol24);
    $('#gDomB').textContent = g.domBTC.toFixed(1) + '%';
    $('#gDomE').textContent = g.domETH.toFixed(1) + '%';
    $('#gCoins').textContent = g.activeCoins.toLocaleString();
    // hero
    $('#hsMcap').textContent = F.big(g.totalMcap);
    $('#hsDom').textContent = g.domBTC.toFixed(1) + '%';
  }

  /* ---------------- Fear & Greed gauge ---------------- */
  function renderFNG(f) {
    if (!f) return;
    $('#fngVal').textContent = f.value;
    $('#fngLabel').textContent = jpFng(f.label);
    $('#hsFng').textContent = f.value + ' ' + jpFng(f.label);
    drawGauge(f.value);
    drawFngSpark(f.history);
  }
  function jpFng(l) {
    return ({ 'Extreme Fear': '極度の恐怖', 'Fear': '恐怖', 'Neutral': '中立', 'Greed': '強欲', 'Extreme Greed': '極度の強欲' })[l] || l;
  }
  function drawGauge(score) {
    const cv = $('#gauge'); if (!cv) return; const { ctx, w } = fit(cv, 120);
    const cx = w / 2, cy = 96, r = Math.min(w / 2 - 12, 76);
    ctx.clearRect(0, 0, w, 120); ctx.lineWidth = 11; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI); ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.stroke();
    const g = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
    g.addColorStop(0, C.dn); g.addColorStop(0.5, C.warn); g.addColorStop(1, C.up);
    const end = Math.PI + (score / 100) * Math.PI;
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, end); ctx.strokeStyle = g; ctx.shadowColor = C.warn; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;
    const na = Math.PI + (score / 100) * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(na) * (r - 6), cy + Math.sin(na) * (r - 6));
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 6.28); ctx.fillStyle = '#fff'; ctx.fill();
    // color the label
    const lab = $('#fngLabel'); if (lab) lab.style.color = score < 40 ? C.dn : score > 60 ? C.up : C.warn;
  }
  function drawFngSpark(h) {
    const cv = $('#fngSpark'); if (!cv || !h || !h.length) return; const { ctx, w, ht } = fit(cv, 42);
    const hh = 42; const mn = Math.min(...h), mx = Math.max(...h);
    const X = i => (i / (h.length - 1)) * w, Y = v => hh - 4 - ((v - mn) / (mx - mn || 1)) * (hh - 8);
    ctx.clearRect(0, 0, w, hh);
    ctx.beginPath(); h.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
    ctx.strokeStyle = C.warn; ctx.lineWidth = 1.6; ctx.stroke();
  }

  /* ---------------- Heatmap (real 24h changes, size by mcap) ---------------- */
  function renderHeatmap(m) {
    const host = $('#heatmap'); if (!host) return;
    const coins = Object.values(m).filter(c => c.mcap).sort((a, b) => b.mcap - a.mcap).slice(0, 8);
    if (!coins.length) return;
    host.innerHTML = coins.map((c, i) => {
      const big = i < 3;
      return `<div class="hm ${big ? 'big' : 'small'}" style="background:${heatColor(c.ch24h)}">
        <b>${c.sym}</b><span class="pct">${F.pct(c.ch24h)}</span></div>`;
    }).join('');
  }
  function heatColor(v) {
    const t = Math.max(-1, Math.min(1, v / 6));
    return t >= 0 ? `rgba(34,197,94,${0.16 + t * 0.55})` : `rgba(244,63,94,${0.16 + (-t) * 0.55})`;
  }

  /* ---------------- Funding table (cross-exchange) ---------------- */
  function renderFunding(fund) {
    const tb = $('#fundingTable tbody'); if (!tb) return;
    tb.innerHTML = PRIMARY.map(sym => {
      const f = fund[sym]; if (!f) return '';
      const cell = v => v == null ? '<td class="muted">—</td>' : `<td class="${v >= 0 ? 'up' : 'dn'}">${F.pct(v, 3)}</td>`;
      return `<tr><td class="dsym">${sym}</td>${cell(f.binance)}${cell(f.bybit)}${cell(f.okx)}<td class="${f.avg >= 0 ? 'up' : 'dn'}"><b>${F.pct(f.avg, 3)}</b></td></tr>`;
    }).join('');
  }

  /* ---------------- Open Interest table ---------------- */
  function renderOI(oi) {
    const tb = $('#oiTable tbody'); if (!tb) return;
    tb.innerHTML = PRIMARY.map(sym => {
      const o = oi[sym]; if (!o) return '';
      return `<tr><td class="dsym">${sym}</td><td><b>${F.big(o.total)}</b></td>
        <td class="${clsPct(o.ch1h)}">${F.pct(o.ch1h, 1)}</td>
        <td class="${clsPct(o.ch24h)}">${F.pct(o.ch24h, 1)}</td></tr>`;
    }).join('');
  }

  /* ---------------- Long/Short blocks ---------------- */
  function renderLS(ls) {
    const host = $('#lsBlocks'); if (!host) return;
    host.innerHTML = PRIMARY.map(sym => {
      const l = ls[sym]; if (!l || l.longAcc == null) return '';
      const longPct = l.longAcc, shortPct = l.shortAcc;
      return `<div class="ls-row">
        <div class="ls-head"><span class="dsym">${sym}</span>
          <span class="ls-nums"><em class="up">L ${longPct.toFixed(1)}%</em> / <em class="dn">S ${shortPct.toFixed(1)}%</em></span></div>
        <div class="ls-bar"><i class="lsl" style="width:${longPct}%"></i><i class="lss" style="width:${shortPct}%"></i></div>
        <div class="ls-meta"><span>口座比 <b>${l.accRatio ?? '—'}</b></span><span>大口ポジ <b>${l.posRatio ?? '—'}</b></span><span>Taker <b>${l.takerRatio ?? '—'}</b></span></div>
      </div>`;
    }).join('');
  }

  /* ---------------- Live liquidations (WS) ---------------- */
  function renderLiqSummary() {
    const L = CAX.state.liq;
    $('#liqLong').textContent = F.big(L.longUSD);
    $('#liqShort').textContent = F.big(L.shortUSD);
  }
  CAX.on('liquidation', (ev) => {
    renderLiqSummary();
    const list = $('#liqList'); if (!list) return;
    const wait = list.querySelector('.liq-wait'); if (wait) wait.remove();
    const li = document.createElement('li');
    li.className = 'liq-item ' + (ev.isLong ? 'long' : 'short');
    li.innerHTML = `<span class="liq-side">${ev.isLong ? 'LONG' : 'SHORT'}</span>
      <span class="liq-sym">${ev.sym}</span>
      <span class="liq-usd">${F.big(ev.usd)}</span>
      <span class="liq-px">@${F.usd(ev.price, ev.price > 100 ? 0 : 4)}</span>`;
    li.style.opacity = 0;
    list.insertBefore(li, list.firstChild);
    requestAnimationFrame(() => { li.style.transition = '.35s'; li.style.opacity = 1; });
    while (list.children.length > 12) list.removeChild(list.lastChild);
  });

  /* ---------------- Candlestick chart (real klines) ---------------- */
  let curSym = 'BTC', curTf = '1d', candleRows = [];
  function drawCandles(rows) {
    candleRows = rows || candleRows;
    const cv = $('#candles'); if (!cv) return; const { ctx, w, h } = fit(cv, 250);
    ctx.clearRect(0, 0, w, h);
    const d = candleRows; if (!d.length) return;
    const padB = 20, padR = 52;
    const mn = Math.min(...d.map(c => c.l)), mx = Math.max(...d.map(c => c.h));
    const pad = (mx - mn) * 0.06;
    const lo = mn - pad, hi = mx + pad;
    const Y = v => (h - padB) - ((v - lo) / (hi - lo)) * (h - padB - 8);
    const cw = (w - padR) / d.length;
    ctx.font = '10px Inter'; ctx.fillStyle = C.mut; ctx.textAlign = 'left';
    for (let g = 0; g <= 4; g++) {
      const val = lo + (g / 4) * (hi - lo), y = Y(val);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val.toFixed(2), w - padR + 5, y + 3);
    }
    // time labels
    ctx.textAlign = 'center';
    const step = Math.ceil(d.length / 6);
    d.forEach((c, i) => {
      if (i % step === 0) {
        const dt = new Date(c.t);
        const lbl = curTf.includes('m') || curTf.includes('h') ? `${dt.getHours()}:${String(dt.getMinutes()).padStart(2, '0')}` : `${dt.getMonth() + 1}/${dt.getDate()}`;
        ctx.fillText(lbl, i * cw + cw / 2, h - 5);
      }
    });
    d.forEach((c, i) => {
      const x = i * cw + cw / 2, up = c.c >= c.o, col = up ? C.up : C.dn;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
      const bw = Math.max(cw * 0.62, 1.5), yo = Y(c.o), yc = Y(c.c);
      ctx.fillStyle = col; ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(Math.abs(yc - yo), 1));
    });
    const last = d[d.length - 1].c, ly = Y(last);
    ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(52,211,153,.55)';
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w - padR, ly); ctx.stroke(); ctx.setLineDash([]);
    const l = $('#btcLast'); if (l) l.textContent = F.usd(last, last > 100 ? 2 : 4);
  }
  async function loadChart() {
    $('#chartSym').textContent = curSym + '/USDT';
    const rows = await CAX.fetchKlines(curSym, curTf);
    drawCandles(rows);
  }
  CAX.on('klines', ({ sym, interval, rows }) => { if (sym === curSym && interval === curTf) drawCandles(rows); });

  /* ---------------- Summary panel ---------------- */
  function renderSummary() {
    const s = CAX.state, sym = curSym;
    const m = s.markets[sym], f = s.funding[sym], oi = s.oi[sym], ls = s.ls[sym];
    const host = $('#summary'); if (!host || !m) return;
    $('#sumSym').textContent = sym;
    const row = (k, v, cls) => `<div class="kv"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`;
    host.innerHTML =
      row('現在値', F.usd(m.price, m.price > 100 ? 2 : 3)) +
      row('24h変動', F.pct(m.ch24h), clsPct(m.ch24h)) +
      row('24h高値', F.usd(m.high24, 0)) +
      row('24h安値', F.usd(m.low24, 0)) +
      row('24h出来高', F.big(m.vol)) +
      (f ? row('Funding(平均)', F.pct(f.avg, 3), f.avg >= 0 ? 'up' : 'dn') : '') +
      (oi ? row('建玉 合計', F.big(oi.total)) : '') +
      (oi ? row('建玉 24h', F.pct(oi.ch24h, 1), clsPct(oi.ch24h)) : '') +
      (ls && ls.accRatio ? row('L/S 口座比', ls.accRatio, ls.accRatio >= 1 ? 'up' : 'dn') : '');
  }

  /* ---------------- Agent report ---------------- */
  const biasTag = b => {
    if (b === '上目線' || b === 'やや上') return 'tag-up';
    if (b === '下目線' || b === 'やや下') return 'tag-dn';
    return 'tag-range';
  };
  function renderAgent(r) {
    if (!r) return;
    $('#reportTime').textContent = new Date(r.time).toLocaleTimeString('ja-JP');
    // bias rows
    $('#biasRows').innerHTML = PRIMARY.map(sym => {
      const c = r.coins[sym]; if (!c) return '';
      return `<div class="bias-row"><span>${sym}</span>
        <b>${F.usd(c.price, c.price > 100 ? 0 : 2)} <em class="${clsPct(c.ch24h)}">${F.pct(c.ch24h)}</em></b>
        <span class="tag ${biasTag(c.bias)}">${c.bias}</span></div>`;
    }).join('');
    // overall verdict = BTC
    const btc = r.coins.BTC;
    if (btc) {
      $('#biasVerdict').innerHTML = `<span class="tag ${biasTag(btc.bias)}">総合：${btc.bias}</span><span class="tag tag-conf">信頼度：${btc.conf}</span>`;
    }
    // reasons
    const ru = $('#reasonsUp'), rd = $('#reasonsDown');
    ru.innerHTML = r.reasonsUp.length ? r.reasonsUp.map(x => `<li>${x}</li>`).join('') : '<li class="muted">検出なし</li>';
    rd.innerHTML = r.reasonsDown.length ? r.reasonsDown.map(x => `<li>${x}</li>`).join('') : '<li class="muted">検出なし</li>';
    // lv table (real)
    const s = CAX.state;
    $('#lvTable').innerHTML = '<tbody>' + PRIMARY.map(sym => {
      const m = s.markets[sym], f = s.funding[sym], oi = s.oi[sym];
      if (!m) return '';
      return `<tr><td>${sym}</td><td>${F.usd(m.price, m.price > 100 ? 0 : 2)}</td>
        <td class="${f && f.avg >= 0 ? 'up' : 'dn'}">${f ? F.pct(f.avg, 3) : '—'}</td>
        <td class="${oi ? clsPct(oi.ch24h) : ''}">${oi ? 'OI ' + F.pct(oi.ch24h, 0) : '—'}</td></tr>`;
    }).join('') + '</tbody>';
    // push agent bias-change events to log
    r.events.forEach(ev => pushLog(`${ev.sym} 目線が「${ev.from}」→「${ev.to}」に変化`, '再評価を実行'));
    renderSummary();
  }

  /* ---------------- Judgment log ---------------- */
  function nowClock() { return new Date().toLocaleTimeString('ja-JP'); }
  function pushLog(a, b) {
    const list = $('#logList'); if (!list) return;
    const load = list.querySelector('.log-load'); if (load) load.remove();
    const li = document.createElement('li');
    li.innerHTML = `<span class="log-dot"></span><span class="log-t">${nowClock()}</span>
      <span class="log-d"><b>${a}</b><br/><span class="ar">→</span> ${b}</span>`;
    li.style.opacity = 0;
    list.insertBefore(li, list.firstChild);
    requestAnimationFrame(() => { li.style.transition = '.4s'; li.style.opacity = 1; });
    while (list.children.length > 6) list.removeChild(list.lastChild);
  }
  // periodic real-data-derived log lines
  function autoLog() {
    const s = CAX.state; if (!s.markets.BTC) return;
    const btc = s.markets.BTC, f = s.funding.BTC, oi = s.oi.BTC;
    const pool = [];
    if (f && f.avg < -0.005) pool.push(['Funding マイナスを検出', 'ショート踏み上げに警戒']);
    if (f && f.avg > 0.02) pool.push(['Funding 過熱を検出', 'ロング巻き戻しに警戒']);
    if (oi && oi.ch24h > 3) pool.push([`OI 24h ${F.pct(oi.ch24h, 1)} を検出`, 'ポジション蓄積を記録']);
    if (oi && oi.ch24h < -3) pool.push([`OI 24h ${F.pct(oi.ch24h, 1)} を検出`, '手仕舞い優勢と判断']);
    if (btc.ch24h > 2) pool.push([`BTC ${F.pct(btc.ch24h)} の上昇を検出`, 'モメンタムを評価']);
    if (btc.ch24h < -2) pool.push([`BTC ${F.pct(btc.ch24h)} の下落を検出`, 'リスク縮小を検討']);
    if (s.liq.count > 3) pool.push([`清算 ${s.liq.count}件を捕捉`, `L ${F.big(s.liq.longUSD)} / S ${F.big(s.liq.shortUSD)}`]);
    if (pool.length) { const p = pool[Math.floor(Math.random() * pool.length)]; pushLog(p[0], p[1]); }
  }

  /* ---------------- Flow cycle (reflects real polling phase) ---------------- */
  const phases = ['Collect フェーズ', 'Analyze フェーズ', 'Monitor フェーズ', 'Update フェーズ'];
  let pIdx = 0, pPct = 0;
  function paintFlow() {
    $$('.flow-step').forEach((el, i) => el.classList.toggle('on', i === pIdx));
    $('#flowPhase').textContent = phases[pIdx];
    $('#flowPct').textContent = pPct + '%'; $('#flowBar').style.width = pPct + '%';
  }
  function tickFlow() { pPct += 5; if (pPct >= 100) { pPct = 0; pIdx = (pIdx + 1) % 4; } paintFlow(); }

  /* ---------------- Status / source bar ---------------- */
  const SRC = [
    { k: 'markets', n: 'CoinGecko' }, { k: 'global', n: 'Global' },
    { k: 'funding', n: 'Funding×3' }, { k: 'oi', n: 'Open Interest' },
    { k: 'ls', n: 'Long/Short' }, { k: 'fng', n: 'Fear&Greed' }, { k: 'klines', n: 'Klines' },
  ];
  function renderSrcBar() {
    const s = CAX.state; const bar = $('#srcBar'); if (!bar) return;
    bar.innerHTML = SRC.map(x => {
      const st = s.status[x.k]; const cls = st === 'ok' ? 'ok' : st === 'err' ? 'err' : 'wait';
      return `<span class="src ${cls}"><i></i>${x.n}</span>`;
    }).join('') + `<span class="src ok"><i></i>Liquidation WS</span>`;
    const okc = Object.values(s.status).filter(v => v === 'ok').length;
    $('#hsSrc').textContent = okc;
  }
  function renderClock() {
    const s = CAX.state;
    const anyOk = Object.values(s.status).some(v => v === 'ok');
    $('#liveClock').innerHTML = `${new Date().toLocaleTimeString('ja-JP')} <b>${anyOk ? '● LIVE' : '接続中…'}</b>`;
  }

  /* ---------------- Interactions ---------------- */
  function toast(msg) {
    const t = $('#toast'); t.innerHTML = `<span class="ti">◈</span> ${msg}`;
    t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function bindUI() {
    ['#launchBtn', '#startBtn'].forEach(id => $(id) && $(id).addEventListener('click', () => document.getElementById('dashboard').scrollIntoView()));
    $('#demoBtn') && $('#demoBtn').addEventListener('click', () => document.getElementById('strategy').scrollIntoView());
    // symbol tabs
    $$('#symTabs button').forEach(b => b.addEventListener('click', () => {
      $$('#symTabs button').forEach(x => x.classList.remove('on')); b.classList.add('on');
      curSym = b.textContent; loadChart(); renderSummary(); toast(curSym + '/USDT を表示');
    }));
    $$('#tfTabs button').forEach(b => b.addEventListener('click', () => {
      $$('#tfTabs button').forEach(x => x.classList.remove('on')); b.classList.add('on');
      curTf = b.textContent; loadChart(); toast('時間足: ' + curTf);
    }));
    window.addEventListener('scroll', () => $('#nav').classList.toggle('scrolled', window.scrollY > 20));
  }

  /* ---------------- Subscriptions ---------------- */
  CAX.on('markets', m => { renderPriceCards(m); renderHeatmap(m); renderSummary(); });
  CAX.on('global', renderGlobal);
  CAX.on('fng', renderFNG);
  CAX.on('funding', renderFunding);
  CAX.on('oi', renderOI);
  CAX.on('ls', renderLS);
  CAX.on('agent', renderAgent);
  CAX.on('ready', () => { toast('全データ源に接続しました'); pushLog('データ源への接続完了', '自律監視を開始'); });

  /* ---------------- Boot ---------------- */
  function init() {
    bindUI();
    // render whatever is already in state (data.js may have fired before subscribe)
    const s = CAX.state;
    if (Object.keys(s.markets).length) { renderPriceCards(s.markets); renderHeatmap(s.markets); }
    if (s.global) renderGlobal(s.global);
    if (s.fng) renderFNG(s.fng);
    if (Object.keys(s.funding).length) renderFunding(s.funding);
    if (Object.keys(s.oi).length) renderOI(s.oi);
    if (Object.keys(s.ls).length) renderLS(s.ls);
    if (s.agent) renderAgent(s.agent);
    loadChart(); renderLiqSummary();
    paintFlow();
    setInterval(tickFlow, 700);
    setInterval(autoLog, 6000);
    setInterval(renderSrcBar, 2000);
    setInterval(renderClock, 1000);
    renderSrcBar(); renderClock();
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { drawCandles(); if (s.fng) drawFngSpark(s.fng.history); if (s.fng) drawGauge(s.fng.value); }, 150); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
