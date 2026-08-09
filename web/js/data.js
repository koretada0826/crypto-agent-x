/* ============================================================
   CRYPTO AGENT X — DataHub (REAL DATA ONLY, no auth, no keys)
   ダミーデータ一切なし。全て取引所/オンチェーン公開APIから取得。
   ------------------------------------------------------------
   sources:
     CoinGecko  : price / 24h・7d change / market cap / dominance / global
     Binance F  : funding / open interest / OI history / long-short / taker / klines / 24h
     Bybit      : funding / open interest (cross-exchange)
     OKX        : funding / open interest (cross-exchange)
     alt.me     : Fear & Greed Index (+ history)
     Binance WS : 清算ライブフィード / mark price live tick
   ============================================================ */
(function () {
  'use strict';

  const COINS = [
    { id: 'bitcoin', sym: 'BTC', bn: 'BTCUSDT', bybit: 'BTCUSDT', okx: 'BTC-USDT-SWAP', cg: 'bitcoin' },
    { id: 'ethereum', sym: 'ETH', bn: 'ETHUSDT', bybit: 'ETHUSDT', okx: 'ETH-USDT-SWAP', cg: 'ethereum' },
    { id: 'solana', sym: 'SOL', bn: 'SOLUSDT', bybit: 'SOLUSDT', okx: 'SOL-USDT-SWAP', cg: 'solana' },
  ];

  const CG = 'https://api.coingecko.com/api/v3';
  const BF = 'https://fapi.binance.com';
  const BYBIT = 'https://api.bybit.com';
  const OKX = 'https://www.okx.com';

  /* ---------- tiny event bus ---------- */
  const bus = {};
  function on(ev, cb) { (bus[ev] = bus[ev] || []).push(cb); }
  function emit(ev, data) { (bus[ev] || []).forEach(cb => { try { cb(data); } catch (e) { console.warn(e); } }); }

  /* ---------- shared state (latest real snapshot) ---------- */
  const state = {
    markets: {},        // sym -> {price, ch1h, ch24h, ch7d, mcap, vol, high24, low24}
    global: null,       // {totalMcap, mcapCh24, domBTC, domETH, vol24}
    funding: {},        // sym -> {binance, bybit, okx, avg, nextTime}
    oi: {},             // sym -> {binance, bybit, okx, total, ch1h, ch24h}
    ls: {},             // sym -> {accRatio, posRatio, takerRatio, longAcc, shortAcc}
    fng: null,          // {value, label, history[]}
    liq: { events: [], longUSD: 0, shortUSD: 0, count: 0 },  // live liquidations since load
    klines: {},         // sym|interval -> [{o,h,l,c,v,t}]
    agent: null,        // derived bias/report
    updated: {},        // source -> ts
    status: {},         // source -> 'ok'|'err'
  };

  /* ---------- helpers ---------- */
  const num = v => (v == null || isNaN(+v)) ? 0 : +v;
  async function getJSON(url, ms = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  function ok(src) { state.status[src] = 'ok'; state.updated[src] = Date.now(); }
  function err(src, e) { state.status[src] = 'err'; console.warn('[' + src + ']', e.message); }

  const fmtUSD = (v, d = 2) => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtBig = v => {
    v = num(v);
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
    return '$' + v.toFixed(2);
  };
  const fmtPct = (v, d = 2) => (v >= 0 ? '+' : '') + num(v).toFixed(d) + '%';

  /* ============================================================
     FETCHERS
     ============================================================ */

  // CoinGecko: prices, changes, mcap, volume for top coins (incl BTC/ETH/SOL)
  async function fetchMarkets() {
    try {
      const j = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=16&page=1&price_change_percentage=1h,24h,7d&sparkline=false`);
      const m = {};
      j.forEach(c => {
        m[c.symbol.toUpperCase()] = {
          id: c.id, sym: c.symbol.toUpperCase(), name: c.name, img: c.image,
          price: num(c.current_price),
          ch1h: num(c.price_change_percentage_1h_in_currency),
          ch24h: num(c.price_change_percentage_24h_in_currency),
          ch7d: num(c.price_change_percentage_7d_in_currency),
          mcap: num(c.market_cap), vol: num(c.total_volume),
          high24: num(c.high_24h), low24: num(c.low_24h), rank: c.market_cap_rank,
        };
      });
      state.markets = m; ok('markets'); emit('markets', m);
    } catch (e) { err('markets', e); }
  }

  // CoinGecko global: total market cap, dominance
  async function fetchGlobal() {
    try {
      const j = await getJSON(`${CG}/global`);
      const d = j.data;
      state.global = {
        totalMcap: num(d.total_market_cap.usd),
        mcapCh24: num(d.market_cap_change_percentage_24h_usd),
        domBTC: num(d.market_cap_percentage.btc),
        domETH: num(d.market_cap_percentage.eth),
        vol24: num(d.total_volume.usd),
        activeCoins: d.active_cryptocurrencies,
      };
      ok('global'); emit('global', state.global);
    } catch (e) { err('global', e); }
  }

  // Binance funding + Bybit + OKX (cross-exchange)
  async function fetchFunding() {
    for (const c of COINS) {
      const res = { binance: null, bybit: null, okx: null, nextTime: 0 };
      const [bn, by, ok_] = await Promise.allSettled([
        getJSON(`${BF}/fapi/v1/premiumIndex?symbol=${c.bn}`),
        getJSON(`${BYBIT}/v5/market/tickers?category=linear&symbol=${c.bybit}`),
        getJSON(`${OKX}/api/v5/public/funding-rate?instId=${c.okx}`),
      ]);
      if (bn.status === 'fulfilled') { res.binance = num(bn.value.lastFundingRate) * 100; res.nextTime = num(bn.value.nextFundingTime); res.mark = num(bn.value.markPrice); }
      if (by.status === 'fulfilled') { const t = by.value.result.list[0]; res.bybit = num(t.fundingRate) * 100; }
      if (ok_.status === 'fulfilled') { res.okx = num(ok_.value.data[0].fundingRate) * 100; }
      const vals = [res.binance, res.bybit, res.okx].filter(v => v != null);
      res.avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      state.funding[c.sym] = res;
    }
    ok('funding'); emit('funding', state.funding);
  }

  // Open interest across exchanges + Binance OI history (1h/24h change)
  async function fetchOI() {
    for (const c of COINS) {
      const res = { binance: 0, bybit: 0, okx: 0, total: 0, ch1h: 0, ch24h: 0 };
      const price = (state.markets[c.sym] && state.markets[c.sym].price) || (state.funding[c.sym] && state.funding[c.sym].mark) || 0;
      const [bn, by, ox, hist] = await Promise.allSettled([
        getJSON(`${BF}/fapi/v1/openInterest?symbol=${c.bn}`),
        getJSON(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${c.bybit}&intervalTime=1h&limit=1`),
        getJSON(`${OKX}/api/v5/public/open-interest?instType=SWAP&instId=${c.okx}`),
        getJSON(`${BF}/futures/data/openInterestHist?symbol=${c.bn}&period=1h&limit=25`),
      ]);
      if (bn.status === 'fulfilled') res.binance = num(bn.value.openInterest) * price;
      if (by.status === 'fulfilled') res.bybit = num(by.value.result.list[0].openInterest) * price;
      if (ox.status === 'fulfilled') res.okx = num(ox.value.data[0].oiUsd);
      res.total = res.binance + res.bybit + res.okx;
      if (hist.status === 'fulfilled' && hist.value.length > 1) {
        const arr = hist.value.map(h => num(h.sumOpenInterestValue));
        const now = arr[arr.length - 1];
        const h1 = arr[arr.length - 2];
        const h24 = arr[0];
        res.ch1h = h1 ? (now - h1) / h1 * 100 : 0;
        res.ch24h = h24 ? (now - h24) / h24 * 100 : 0;
      }
      state.oi[c.sym] = res;
    }
    ok('oi'); emit('oi', state.oi);
  }

  // Long/short ratios (Binance)
  async function fetchLongShort() {
    for (const c of COINS) {
      const res = {};
      const [acc, pos, taker] = await Promise.allSettled([
        getJSON(`${BF}/futures/data/globalLongShortAccountRatio?symbol=${c.bn}&period=1h&limit=1`),
        getJSON(`${BF}/futures/data/topLongShortPositionRatio?symbol=${c.bn}&period=1h&limit=1`),
        getJSON(`${BF}/futures/data/takerlongshortRatio?symbol=${c.bn}&period=1h&limit=1`),
      ]);
      if (acc.status === 'fulfilled') { const a = acc.value[0]; res.accRatio = num(a.longShortRatio); res.longAcc = num(a.longAccount) * 100; res.shortAcc = num(a.shortAccount) * 100; }
      if (pos.status === 'fulfilled') res.posRatio = num(pos.value[0].longShortRatio);
      if (taker.status === 'fulfilled') res.takerRatio = num(taker.value[0].buySellRatio);
      state.ls[c.sym] = res;
    }
    ok('ls'); emit('ls', state.ls);
  }

  // Candlesticks (real klines)
  async function fetchKlines(sym, interval) {
    const c = COINS.find(x => x.sym === sym) || COINS[0];
    try {
      const j = await getJSON(`${BF}/fapi/v1/klines?symbol=${c.bn}&interval=${interval}&limit=90`);
      const rows = j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      state.klines[sym + '|' + interval] = rows;
      ok('klines'); emit('klines', { sym, interval, rows });
      return rows;
    } catch (e) { err('klines', e); return []; }
  }

  // Fear & Greed (+ 30d history)
  async function fetchFNG() {
    try {
      const j = await getJSON('https://api.alternative.me/fng/?limit=30');
      const cur = j.data[0];
      state.fng = {
        value: num(cur.value), label: cur.value_classification,
        history: j.data.map(x => num(x.value)).reverse(),
      };
      ok('fng'); emit('fng', state.fng);
    } catch (e) { err('fng', e); }
  }

  /* ---------- WebSocket: LIVE liquidations (Binance forceOrder) ---------- */
  function startLiquidationStream() {
    let ws;
    const connect = () => {
      try { ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr'); }
      catch (e) { return; }
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data).o;
          const usd = num(d.p) * num(d.q);
          const ev = {
            sym: d.s.replace('USDT', ''), side: d.S, // SELL = long liquidated, BUY = short liquidated
            price: num(d.p), usd, t: d.T,
            isLong: d.S === 'SELL',
          };
          const L = state.liq;
          L.events.unshift(ev); if (L.events.length > 40) L.events.pop();
          L.count++;
          if (ev.isLong) L.longUSD += usd; else L.shortUSD += usd;
          emit('liquidation', ev);
        } catch (e) { }
      };
      ws.onclose = () => setTimeout(connect, 3000);
      ws.onerror = () => { try { ws.close(); } catch (e) { } };
    };
    connect();
  }

  /* ---------- WebSocket: live mark price tick for BTC/ETH/SOL ---------- */
  function startPriceStream() {
    const streams = COINS.map(c => c.bn.toLowerCase() + '@markPrice@1s').join('/');
    let ws;
    const connect = () => {
      try { ws = new WebSocket('wss://fstream.binance.com/stream?streams=' + streams); }
      catch (e) { return; }
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data).data;
          const sym = d.s.replace('USDT', '');
          if (state.markets[sym]) state.markets[sym].price = num(d.p);
          emit('tick', { sym, price: num(d.p), funding: num(d.r) * 100 });
        } catch (e) { }
      };
      ws.onclose = () => setTimeout(connect, 3000);
      ws.onerror = () => { try { ws.close(); } catch (e) { } };
    };
    connect();
  }

  /* ============================================================
     AUTONOMOUS AGENT — 実データからルールベースで目線を導出
     ============================================================ */
  const prevBias = {};
  function evaluateAgent() {
    if (!state.markets.BTC) return;
    const report = { time: Date.now(), coins: {}, reasonsUp: [], reasonsDown: [], events: [] };

    COINS.forEach(c => {
      const m = state.markets[c.sym]; if (!m) return;
      const f = state.funding[c.sym] || {}; const oi = state.oi[c.sym] || {}; const ls = state.ls[c.sym] || {};
      let score = 0; // +up / -down

      // price momentum
      if (m.ch24h > 2) score += 2; else if (m.ch24h > 0) score += 1;
      else if (m.ch24h < -2) score -= 2; else if (m.ch24h < 0) score -= 1;
      if (m.ch7d > 5) score += 1; else if (m.ch7d < -5) score -= 1;

      // funding: extreme positive = crowded long (bearish risk), negative = crowded short (squeeze up)
      if (f.avg != null) {
        if (f.avg < -0.005) score += 1.5;            // shorts crowded -> squeeze up potential
        else if (f.avg > 0.03) score -= 1.5;         // longs overheated
      }
      // OI + price divergence
      if (oi.ch24h > 3 && m.ch24h < 0) score -= 1.5; // OI up + price down = shorts building / weak
      if (oi.ch24h > 3 && m.ch24h > 0) score += 1;   // OI up + price up = trend fuel
      // long/short account extremes (contrarian)
      if (ls.accRatio > 2.2) score -= 1;             // too many longs
      else if (ls.accRatio && ls.accRatio < 0.9) score += 1;

      let bias = 'レンジ', conf = '中';
      if (score >= 3) { bias = '上目線'; conf = score >= 4.5 ? '高' : '中'; }
      else if (score <= -3) { bias = '下目線'; conf = score <= -4.5 ? '高' : '中'; }
      else if (Math.abs(score) < 1.2) { bias = 'レンジ'; conf = '中'; }
      else { bias = score > 0 ? 'やや上' : 'やや下'; conf = '低'; }

      report.coins[c.sym] = { bias, conf, score: +score.toFixed(1), price: m.price, ch24h: m.ch24h };

      // fire judgment-log events on change
      if (prevBias[c.sym] && prevBias[c.sym] !== bias) {
        report.events.push({ sym: c.sym, from: prevBias[c.sym], to: bias, t: Date.now() });
      }
      prevBias[c.sym] = bias;
    });

    // aggregate reasons (BTC-led, real values)
    const btc = state.markets.BTC, f = state.funding.BTC || {}, oi = state.oi.BTC || {}, ls = state.ls.BTC || {};
    if (btc.ch24h > 0) report.reasonsUp.push(`BTC 24h ${fmtPct(btc.ch24h)} と上昇`);
    if (f.avg < 0) report.reasonsUp.push(`Funding平均 ${fmtPct(f.avg, 3)}（ショート過多→踏み上げ余地）`);
    if (oi.ch24h < 0) report.reasonsUp.push(`OI 24h ${fmtPct(oi.ch24h)}（ポジション整理進む）`);
    if (ls.accRatio && ls.accRatio < 1) report.reasonsUp.push(`ロング/ショート比 ${ls.accRatio}（弱気多数＝逆張り妙味）`);
    if (state.fng && state.fng.value <= 35) report.reasonsUp.push(`Fear&Greed ${state.fng.value}（恐怖＝出尽くし圏）`);

    if (btc.ch24h < 0) report.reasonsDown.push(`BTC 24h ${fmtPct(btc.ch24h)} と下落`);
    if (f.avg > 0.02) report.reasonsDown.push(`Funding平均 ${fmtPct(f.avg, 3)}（ロング過熱）`);
    if (oi.ch24h > 3 && btc.ch24h < 0) report.reasonsDown.push(`OI増+価格下落（下方向にポジション蓄積）`);
    if (ls.accRatio > 2) report.reasonsDown.push(`ロング/ショート比 ${ls.accRatio}（ロング偏重）`);
    if (state.fng && state.fng.value >= 70) report.reasonsDown.push(`Fear&Greed ${state.fng.value}（強欲＝過熱）`);
    if (state.liq.longUSD > state.liq.shortUSD * 1.5 && state.liq.count > 5) report.reasonsDown.push(`ロング清算が優勢（下押し圧）`);

    state.agent = report; emit('agent', report);
  }

  /* ============================================================
     SCHEDULER — 自律ポーリングループ
     ============================================================ */
  async function cycleFast() {   // derivatives — every 20s
    await Promise.allSettled([fetchFunding(), fetchOI(), fetchLongShort()]);
    evaluateAgent();
  }
  async function cycleMed() {    // market/global — every 60s (CoinGecko rate limit safe)
    await Promise.allSettled([fetchMarkets(), fetchGlobal()]);
    evaluateAgent();
  }
  async function cycleSlow() {   // sentiment — every 10min
    await fetchFNG(); evaluateAgent();
  }

  async function boot() {
    emit('boot', true);
    // initial: markets first (needed for OI usd calc), then derivatives
    await Promise.allSettled([fetchMarkets(), fetchGlobal(), fetchFNG()]);
    await Promise.allSettled([fetchFunding(), fetchOI(), fetchLongShort()]);
    await Promise.allSettled([fetchKlines('BTC', '1d')]);
    evaluateAgent();
    startLiquidationStream();
    startPriceStream();
    emit('ready', state);
    setInterval(cycleFast, 20000);
    setInterval(cycleMed, 60000);
    setInterval(cycleSlow, 600000);
    setInterval(evaluateAgent, 8000);
  }

  /* ---------- public API ---------- */
  window.CAX = {
    state, on, emit, COINS,
    fetchKlines,
    fmt: { usd: fmtUSD, big: fmtBig, pct: fmtPct, num },
    boot,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
