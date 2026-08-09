/* ============================================================
   CRYPTO AGENT X — Strategy core v3
   ・順張り(trend) と 逆張り(mean-reversion) の2エッジ族
   ・手数料+スリッページを織り込んだ実測バックテスト
   ・パラメータ最適化(train/test アウトオブサンプル) が両戦略を横断で探索
   売買実行はしない。判定と検証のみ。
   ============================================================ */
(function () {
  'use strict';

  // GMOコイン taker(0.05%) + 想定スリッページ(0.03%) ≒ 片道0.08%
  const COST_DEFAULT = 0.0008;

  /* ---------- indicators ---------- */
  function ema(vals, period) {
    const k = 2 / (period + 1); const out = new Array(vals.length).fill(null); let prev;
    for (let i = 0; i < vals.length; i++) { if (i === 0) { prev = vals[0]; out[0] = prev; continue; } prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }
  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null); let g = 0, l = 0;
    if (closes.length <= period) return out;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
    g /= period; l /= period; out[period] = 100 - 100 / (1 + (l === 0 ? 100 : g / l));
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (period - 1) + (d > 0 ? d : 0)) / period; l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l));
    }
    return out;
  }
  function atr(candles, period = 14) {
    const out = new Array(candles.length).fill(null); const tr = [];
    for (let i = 0; i < candles.length; i++) {
      if (i === 0) { tr.push(candles[0].h - candles[0].l); continue; }
      const p = candles[i - 1].c, c = candles[i];
      tr.push(Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p)));
    }
    let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period; out[period] = a;
    for (let i = period + 1; i < candles.length; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
    return out;
  }
  function adx(candles, period = 14) {
    const len = candles.length, out = new Array(len).fill(null);
    if (len < period * 2 + 2) return out;
    const tr = [], pDM = [], mDM = [];
    for (let i = 1; i < len; i++) {
      const up = candles[i].h - candles[i - 1].h, dn = candles[i - 1].l - candles[i].l;
      pDM.push(up > dn && up > 0 ? up : 0); mDM.push(dn > up && dn > 0 ? dn : 0);
      const p = candles[i - 1].c;
      tr.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - p), Math.abs(candles[i].l - p)));
    }
    let atrW = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let pW = pDM.slice(0, period).reduce((a, b) => a + b, 0);
    let mW = mDM.slice(0, period).reduce((a, b) => a + b, 0);
    const dx = [];
    for (let i = period; i < tr.length; i++) {
      atrW = atrW - atrW / period + tr[i]; pW = pW - pW / period + pDM[i]; mW = mW - mW / period + mDM[i];
      const pDI = 100 * pW / atrW, mDI = 100 * mW / atrW;
      dx.push(100 * Math.abs(pDI - mDI) / (pDI + mDI || 1));
    }
    let adxV = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let idx = 1 + period + period; out[idx] = adxV;
    for (let i = period; i < dx.length; i++) { adxV = (adxV * (period - 1) + dx[i]) / period; out[++idx] = adxV; }
    return out;
  }

  function indicators(candles, p) {
    const P = Object.assign({ emaFast: 9, emaMid: 21, emaSlow: 50, emaReg: 200 }, p || {});
    const closes = candles.map(c => c.c);
    return {
      emaF: ema(closes, P.emaFast), emaM: ema(closes, P.emaMid), emaS: ema(closes, P.emaSlow), emaR: ema(closes, P.emaReg),
      rsi14: rsi(closes, 14), rsi2: rsi(closes, 2), ema10: ema(closes, 10), atr14: atr(candles, 14), adx14: adx(candles, 14),
    };
  }

  const DEF = { rsiLoS: 30, rsiLoL: 47, rsiHiL: 72, rsiHiS: 53, nearAtr: 1.4, useRegime: true, adxMin: 0, mrLo: 8, mrHi: 92 };

  /* ---------- ① 順張り signal ---------- */
  function evalSignal(candles, i, ind, p) {
    const P = Object.assign({}, DEF, p);
    if (i < 205) return null;
    const c = candles[i].c;
    const eF = ind.emaF[i], eM = ind.emaM[i], eS = ind.emaS[i], eR = ind.emaR[i], r = ind.rsi14[i], a = ind.atr14[i], ax = ind.adx14[i];
    if ([eF, eM, eS, eR, r, a].some(v => v == null)) return null;
    if (P.adxMin > 0 && (ax == null || ax < P.adxMin)) return null;
    const up = eF > eM && eM > eS && (!P.useRegime || c > eR);
    const dn = eF < eM && eM < eS && (!P.useRegime || c < eR);
    if (Math.abs(c - eM) >= P.nearAtr * a) return null;
    const slope = (c - candles[i - 3].c) / a; let dir = null, conf = 50; const reasons = [];
    if (up && r > P.rsiLoL && r < P.rsiHiL) { dir = 'long'; conf = 55 + Math.min(20, (eF - eS) / a * 8) + (r > 52 && r < 63 ? 8 : 0) + Math.max(-8, Math.min(10, slope * 4)); reasons.push('EMA9>21>50', P.useRegime ? '価格>EMA200' : '上昇整列', `RSI ${r.toFixed(0)}`, ax != null ? `ADX ${ax.toFixed(0)}` : ''); }
    else if (dn && r < P.rsiHiS && r > P.rsiLoS) { dir = 'short'; conf = 55 + Math.min(20, (eS - eF) / a * 8) + (r > 37 && r < 48 ? 8 : 0) + Math.max(-8, Math.min(10, -slope * 4)); reasons.push('EMA9<21<50', P.useRegime ? '価格<EMA200' : '下降整列', `RSI ${r.toFixed(0)}`, ax != null ? `ADX ${ax.toFixed(0)}` : ''); }
    else return null;
    conf = Math.max(0, Math.min(95, Math.round(conf)));
    return { type: 'trend', dir, conf, atr: a, price: c, rsi: r, adx: ax, reasons: reasons.filter(Boolean) };
  }

  /* ---------- ② 逆張り(平均回帰) signal ---------- */
  function evalMR(candles, i, ind, p) {
    const P = Object.assign({}, DEF, p);
    if (i < 205) return null;
    const c = candles[i].c, r = ind.rsi2[i], eR = ind.emaR[i], a = ind.atr14[i];
    if ([r, eR, a].some(v => v == null)) return null;
    let dir = null, conf = 55; const reasons = [];
    if (r < P.mrLo && c > eR) { dir = 'long'; conf = 60 + Math.min(20, (P.mrLo - r)); reasons.push(`RSI2 ${r.toFixed(0)}(売られ過ぎ)`, '上昇局面の押し目買い'); }
    else if (r > P.mrHi && c < eR) { dir = 'short'; conf = 60 + Math.min(20, (r - P.mrHi)); reasons.push(`RSI2 ${r.toFixed(0)}(買われ過ぎ)`, '下降局面の戻り売り'); }
    else return null;
    conf = Math.max(0, Math.min(95, Math.round(conf)));
    return { type: 'mr', dir, conf, atr: a, price: c, rsi: r, reasons };
  }

  function signalFor(type) { return type === 'mr' ? evalMR : evalSignal; }

  /* ---------- backtest（手数料込み） ---------- */
  function backtest(candles, opts = {}) {
    const p = Object.assign({ type: 'trend', rr: 1.6, slAtr: 1.2, riskPct: 0.01, exit: 'rr', trailAtr: 1.6, cost: COST_DEFAULT, minIdx: 205 }, opts);
    const ind = opts._ind || indicators(candles, p);
    const sig = signalFor(p.type);
    const trades = []; let equity = 100, peak = 100, maxDD = 0; const eqCurve = [equity];
    let i = Math.max(p.minIdx, 205);
    while (i < candles.length - 1) {
      const s = sig(candles, i, ind, p);
      if (!s) { i++; continue; }
      // 上位足コンフルエンス: 大局と逆方向はスキップ（p.htf = 各indexの上位足レジーム bool|null）
      if (p.htf && p.htf[i] != null && ((s.dir === 'long' && !p.htf[i]) || (s.dir === 'short' && p.htf[i]))) { i++; continue; }
      const entry = s.price, a = s.atr, dir = s.dir, risk = p.slAtr * a;
      const costR = 2 * p.cost * entry / risk;                 // 往復コストをR換算
      let sl = dir === 'long' ? entry - risk : entry + risk;
      let outcome = null, exitIdx = i, extreme = entry;
      for (let j = i + 1; j < candles.length; j++) {
        const cj = candles[j];
        if (p.type === 'mr') {                                   // 逆張り: 平均(EMA10)回帰で利確 / ATRで損切り
          if (dir === 'long') { if (cj.l <= sl) { outcome = -1; exitIdx = j; break; } if (cj.c >= ind.ema10[j]) { outcome = (cj.c - entry) / risk; exitIdx = j; break; } }
          else { if (cj.h >= sl) { outcome = -1; exitIdx = j; break; } if (cj.c <= ind.ema10[j]) { outcome = (entry - cj.c) / risk; exitIdx = j; break; } }
        } else if (p.exit === 'rr') {                            // 順張り: 固定RR
          const tp = dir === 'long' ? entry + p.rr * risk : entry - p.rr * risk;
          if (dir === 'long') { if (cj.l <= sl) { outcome = -1; exitIdx = j; break; } if (cj.h >= tp) { outcome = p.rr; exitIdx = j; break; } }
          else { if (cj.h >= sl) { outcome = -1; exitIdx = j; break; } if (cj.l <= tp) { outcome = p.rr; exitIdx = j; break; } }
        } else {                                                 // 順張り: ATRトレーリング
          if (dir === 'long') { extreme = Math.max(extreme, cj.h); sl = Math.max(sl, extreme - p.trailAtr * a); if (cj.l <= sl) { outcome = (sl - entry) / risk; exitIdx = j; break; } }
          else { extreme = Math.min(extreme, cj.l); sl = Math.min(sl, extreme + p.trailAtr * a); if (cj.h >= sl) { outcome = (entry - sl) / risk; exitIdx = j; break; } }
        }
      }
      if (outcome == null) break;
      outcome -= costR;                                          // 手数料+スリッページ控除
      equity *= (1 + p.riskPct * outcome);
      peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak * 100); eqCurve.push(equity);
      trades.push({ dir, R: outcome, t: candles[i].t });
      i = exitIdx + 1;
    }
    const wins = trades.filter(t => t.R > 0).length, n = trades.length;
    const gW = trades.filter(t => t.R > 0).reduce((s, t) => s + t.R, 0);
    const gL = trades.filter(t => t.R < 0).reduce((s, t) => s + Math.abs(t.R), 0);
    return {
      trades, n, wins, losses: n - wins, winRate: n ? wins / n * 100 : 0,
      avgR: n ? trades.reduce((s, t) => s + t.R, 0) / n : 0, expectancy: n ? trades.reduce((s, t) => s + t.R, 0) / n : 0,
      profitFactor: gL ? gW / gL : (gW ? Infinity : 0), maxDD, equity, eqCurve, params: p,
    };
  }

  /* ---------- optimizer: 順張り+逆張りを横断でグリッド探索 + train/test ---------- */
  function optimize(candles, opts = {}) {
    const split = opts.split || 0.7, minTrades = opts.minTrades || 12, cost = opts.cost || COST_DEFAULT;
    const cut = Math.floor(candles.length * split);
    const train = candles.slice(0, cut), test = candles.slice(cut - 210);
    const htf = opts.htf || null;                                  // 上位足レジーム(全candles分, bool|null)
    const htfTrain = htf ? htf.slice(0, cut) : null, htfTest = htf ? htf.slice(cut - 210) : null;
    const htfOpts = htf ? [false, true] : [false];                 // 上位足フィルタ有無を横断
    const combos = [];
    htfOpts.forEach(useHTF => {
      [1.4, 1.8, 2.4].forEach(rr => [1.0, 1.5, 2.0].forEach(slAtr => [0, 20, 25].forEach(adxMin => ['rr', 'trail'].forEach(exit =>
        combos.push({ type: 'trend', rr, slAtr, adxMin, exit, useRegime: true, trailAtr: slAtr, cost, useHTF })))));
      [2.0, 2.5, 3.0].forEach(slAtr => [[8, 92], [5, 95], [12, 88]].forEach(([mrLo, mrHi]) =>
        combos.push({ type: 'mr', slAtr, mrLo, mrHi, useRegime: true, cost, useHTF })));
    });
    const indTrain = indicators(train), indTest = indicators(test);
    let best = null;
    combos.forEach(c => {
      const bt = backtest(train, Object.assign({ riskPct: 0.01, _ind: indTrain, htf: c.useHTF ? htfTrain : null }, c));
      if (bt.n >= minTrades && (!best || bt.expectancy > best.bt.expectancy)) best = { params: c, bt };
    });
    if (!best) return null;
    const testBt = backtest(test, Object.assign({ riskPct: 0.01, _ind: indTest, htf: best.params.useHTF ? htfTest : null }, best.params));
    const fullBt = backtest(candles, Object.assign({ riskPct: 0.01, htf: best.params.useHTF ? htf : null }, best.params));
    // ウォークフォワード頑健性: 時系列3分割し各期間で採用パラメータを検証（どの局面でも黒字か）
    const W = 3, wlen = Math.floor(candles.length / W); let wfN = 0, wfPos = 0;
    for (let w = 0; w < W; w++) {
      const a = w * wlen, b = w === W - 1 ? candles.length : (w + 1) * wlen;
      const seg = candles.slice(a, b); if (seg.length < 260) continue;
      const bt = backtest(seg, Object.assign({ riskPct: 0.01, htf: best.params.useHTF && htf ? htf.slice(a, b) : null }, best.params));
      if (bt.n >= 5) { wfN++; if (bt.expectancy > 0) wfPos++; }
    }
    return { params: best.params, train: pick(best.bt), test: pick(testBt), full: fullBt, wf: { windows: wfN, positive: wfPos }, combos: combos.length };
  }
  function pick(bt) { return { n: bt.n, winRate: bt.winRate, expectancy: bt.expectancy, profitFactor: bt.profitFactor === Infinity ? 99 : bt.profitFactor, maxDD: bt.maxDD }; }

  // 上位足(日足)のEMA200レジームを、entry足の各candle時刻に割り当てた配列(bool|null)を作る
  function buildHTF(entryCandles, dailyCandles) {
    const cl = dailyCandles.map(x => x.c), e = ema(cl, 200);
    const reg = dailyCandles.map((d, i) => ({ t: d.t, up: e[i] != null ? d.c > e[i] : null }));
    const out = new Array(entryCandles.length).fill(null); let di = 0;
    for (let k = 0; k < entryCandles.length; k++) {
      const t = entryCandles[k].t;
      while (di + 1 < reg.length && reg[di + 1].t <= t) di++;
      out[k] = (reg[di] && reg[di].t <= t) ? reg[di].up : null;
    }
    return out;
  }

  const API = { ema, rsi, atr, adx, indicators, evalSignal, evalMR, signalFor, backtest, optimize, buildHTF, DEF, COST_DEFAULT };
  if (typeof window !== 'undefined') window.CAXStrat = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
