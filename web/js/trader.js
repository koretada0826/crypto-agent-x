/* ============================================================
   CRYPTO AGENT X — TRADE DESK v2 (edge-validated)
   ・銘柄×時間足ごとにパラメータ最適化＋訓練/検証(アウトオブサンプル)
   ・“検証データで黒字が確認できた市場だけ”ライブシグナルを出す
   ・発注チケット: 口座残高→数量/SL/TP を算出（そのまま取引所で執行できる形）
   ・ペーパートレード（承認制・実弾なし）
   私は実弾の約定はしない。発注はユーザーの承認・執行に委ねる。
   ============================================================ */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CAX = window.CAX, S = window.CAXStrat; if (!CAX || !S) return;
  const F = CAX.fmt, BF = 'https://fapi.binance.com';
  const SYMS = [{ s: 'BTC', bn: 'BTCUSDT' }, { s: 'ETH', bn: 'ETHUSDT' }, { s: 'SOL', bn: 'SOLUSDT' }];
  const TFS = ['2h', '4h', '6h', '12h', '1d'];
  const CONF_MIN = 60;
  const EDGE = { minN: 8, minExp: 0.03, minPF: 1.05 };   // アウトオブサンプル合格基準
  const RISK_PCT = 0.01;

  /* ---------- state ---------- */
  const model = {};        // sym -> {edge:bool, tf, params, train, test, full, candles, ind, note}
  let liveSignals = {};    // sym -> signal
  let activeCandidate = null;
  let acct = +(localStorage.getItem('caxAcct') || 1000);   // 口座残高(USD)想定
  let riskPct = +(localStorage.getItem('caxRisk') || 1);   // %

  /* ---------- paper account ---------- */
  const LS = 'caxPaperV1';
  const loadPaper = () => { try { const p = JSON.parse(localStorage.getItem(LS)); if (p && p.equity) return p; } catch (e) { } return { equity: 10000, start: 10000, positions: [], history: [] }; };
  const savePaper = () => { try { localStorage.setItem(LS, JSON.stringify(paper)); } catch (e) { } };
  let paper = loadPaper();

  async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); }

  /* ---------- SERVER paper account (autonomous 24/7 の口座を表示) ---------- */
  let sp = null;                 // server paper snapshot
  let serverOK = false;
  async function pollServerPaper() {
    try { sp = await getJSON('/api/paper'); serverOK = true; renderServerPaper(); }
    catch (e) { serverOK = false; }   // サーバ未起動時はローカル表示にフォールバック
  }
  function renderServerPaper() {
    if (!sp) return;
    const pf = sp.portfolio || {};
    // equity header（評価額と含み損益も）
    const eh = $('#deskEquity');
    if (eh) eh.innerHTML = `自律ペーパー資産 <b>${F.usd(sp.equity, 0)}</b> <span class="${sp.net >= 0 ? 'up' : 'dn'}">(${sp.net >= 0 ? '+' : ''}${F.usd(sp.net, 0)})</span>` +
      ` <span class="muted">| 含み <b class="${sp.unrealized >= 0 ? 'up' : 'dn'}">${sp.unrealized >= 0 ? '+' : ''}${F.usd(sp.unrealized, 0)}</b> 評価額 ${F.usd(sp.evalValue, 0)}</span>`;
    // open positions (server-computed uPnl — 全銘柄で正確)
    const pc = $('#posCard');
    if (pc) {
      const risk = `<div class="pf-bar ${pf.halted ? 'halt' : ''}">保有 ${pf.open}/${pf.maxOpen}・ロング${pf.longs}/ショート${pf.shorts}（同方向上限${pf.maxPerDir}）・DD ${pf.ddPct}%${pf.halted ? ' ⛔停止中' : ''}</div>`;
      pc.innerHTML = risk + (sp.positions.length ? sp.positions.map(p => {
        const pnl = p.uPnl, live = p.price;
        return `<div class="pos-row ${p.dir}"><div class="pos-top"><span class="pos-sym">${p.sym}</span><span class="pos-dir ${p.dir}">${p.dir === 'long' ? 'LONG' : 'SHORT'}</span><span class="pos-tf">${p.tf}</span><b class="pos-pnl ${pnl >= 0 ? 'up' : 'dn'}">${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}</b></div>
          <div class="pos-meta"><span>入 ${F.usd(p.entry, p.entry > 100 ? 0 : 4)}</span><span>現 ${F.usd(live, live > 100 ? 0 : 4)}</span><span class="dn">SL ${F.usd(p.sl, p.sl > 100 ? 0 : 4)}</span><span class="up">TP ${p.tp ? F.usd(p.tp, p.tp > 100 ? 0 : 4) : '平均回帰'}</span></div></div>`;
      }).join('') : `<div class="pos-empty">保有中の仮想ポジションなし<br><small class="muted">検証エッジ銘柄でシグナル待機中</small></div>`);
    }
    // history + stats
    const hc = $('#histCard');
    if (hc) {
      hc.innerHTML = `<div class="hist-stats">
          <div><small>自律ペーパー資産</small><b>${F.usd(sp.equity, 0)}</b></div><div><small>累計損益</small><b class="${sp.net >= 0 ? 'up' : 'dn'}">${sp.net >= 0 ? '+' : ''}${F.usd(sp.net, 0)}</b></div>
          <div><small>実績勝率</small><b class="${sp.winRate >= 50 ? 'up' : 'dn'}">${sp.winRate}%</b></div><div><small>決済数</small><b>${sp.closed}</b></div></div>
        <ul class="hist-list">${sp.recent.length ? sp.recent.map(x => `<li><span class="hist-sym">${x.sym}</span><span class="pos-dir ${x.dir}">${x.dir === 'long' ? 'L' : 'S'}</span><span class="hist-reason">${x.reason} ${x.tf}</span><b class="${x.pnl >= 0 ? 'up' : 'dn'}">${x.pnl >= 0 ? '+' : ''}${F.usd(x.pnl, 1)}</b><span class="hist-r ${x.R >= 0 ? 'up' : 'dn'}">${x.R >= 0 ? '+' : ''}${x.R.toFixed(1)}R</span></li>`).join('') : '<li class="muted">決済履歴なし（エントリー監視中）</li>'}</ul>
        <div class="mini-note">🤖 サーバが検証エッジ銘柄を24時間自動で仮想売買中（実弾なし）。ブラウザを閉じても継続。</div>`;
    }
  }
  async function kl(bn, tf, lim) { const j = await getJSON(`${BF}/fapi/v1/klines?symbol=${bn}&interval=${tf}&limit=${lim}`); return j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })); }

  /* ---------- build validated model per symbol ---------- */
  async function buildModel(sym, bn) {
    let bestPick = null, daily = null;
    try { daily = await kl(bn, '1d', 400); } catch (e) { }
    for (const tf of TFS) {
      let c; try { c = await kl(bn, tf, tf === '1d' ? 1000 : 1500); } catch (e) { continue; }
      const htf = (daily && tf !== '1d') ? S.buildHTF(c, daily) : null;
      const opt = S.optimize(c, { split: 0.7, htf });
      if (!opt) continue;
      const wfOK = !opt.wf || opt.wf.windows < 2 || opt.wf.positive >= Math.ceil(opt.wf.windows * 0.6);
      const passed = opt.test.n >= EDGE.minN && opt.test.expectancy >= EDGE.minExp && opt.test.profitFactor >= EDGE.minPF && wfOK;
      const cand = { tf, opt, candles: c, htf, passed, testExp: opt.test.expectancy };
      if (!bestPick || (passed && !bestPick.passed) || (passed === bestPick.passed && cand.testExp > bestPick.testExp)) bestPick = cand;
    }
    if (!bestPick) { model[sym] = { edge: false, note: 'データ不足' }; return; }
    const ind = S.indicators(bestPick.candles, bestPick.opt.params);
    model[sym] = {
      edge: bestPick.passed, tf: bestPick.tf, params: bestPick.opt.params,
      train: bestPick.opt.train, test: bestPick.opt.test, full: bestPick.opt.full,
      candles: bestPick.candles, ind, htf: bestPick.htf,
      note: bestPick.passed ? 'アウトオブサンプル検証済' : 'エッジ未確認（検証データで黒字化せず）',
    };
  }

  /* ---------- live signal (validated markets only) ---------- */
  function computeSignal(sym) {
    const m = model[sym]; if (!m || !m.candles) { delete liveSignals[sym]; return; }
    const i = m.candles.length - 2; // last closed
    const sig = S.signalFor(m.params.type)(m.candles, i, m.ind, m.params);
    if (!sig) { delete liveSignals[sym]; return; }
    if (m.params.useHTF && m.htf && m.htf[i] != null && ((sig.dir === 'long' && !m.htf[i]) || (sig.dir === 'short' && m.htf[i]))) { delete liveSignals[sym]; return; } // 上位足コンフルエンス

    const st = CAX.state, f = st.funding[sym], ls = st.ls[sym], fng = st.fng;
    let conf = sig.conf; const ov = [];
    if (f && f.avg != null) {
      if (sig.dir === 'long') { if (f.avg > 0.03) { conf -= 8; ov.push('Funding過熱(-)'); } else if (f.avg < 0) { conf += 6; ov.push('Fundingマイナス=踏み上げ余地(+)'); } }
      else { if (f.avg < -0.03) { conf -= 8; ov.push('Funding過度マイナス(-)'); } else if (f.avg > 0) { conf += 6; ov.push('Fundingプラス=投げ余地(+)'); } }
    }
    if (fng) {
      if (sig.dir === 'long') { if (fng.value <= 25) { conf += 6; ov.push('F&G恐怖=底値圏(+)'); } else if (fng.value >= 75) { conf -= 8; ov.push('F&G強欲=過熱(-)'); } }
      else { if (fng.value >= 75) { conf += 6; ov.push('F&G強欲=天井圏(+)'); } else if (fng.value <= 20) { conf -= 6; ov.push('F&G極度恐怖=売られ過ぎ(-)'); } }
    }
    if (ls && ls.accRatio) {
      if (sig.dir === 'long' && ls.accRatio > 2.2) { conf -= 5; ov.push('ロング偏重(-)'); }
      if (sig.dir === 'short' && ls.accRatio < 0.8) { conf -= 5; ov.push('ショート偏重(-)'); }
    }
    // ---- OI × 価格の需給読み（ライブ確認フィルタ / 統計検証不可・30日制限）----
    const oi = st.oi[sym], mk = st.markets[sym];
    let oiRead = null;
    if (oi && mk && oi.ch24h != null) {
      const pUp = mk.ch24h > 0, o = oi.ch24h;
      if (sig.dir === 'long') {
        if (o > 1 && pUp) { conf += 7; ov.push('OI増×価格上=新規買い流入(+)'); oiRead = 'confirm'; }
        else if (o > 3 && !pUp) { conf -= 9; ov.push('OI増×価格下=売り勢力(-)'); oiRead = 'contra'; }
        else if (o < -2) { conf -= 3; ov.push('OI減=買い戻し主体で燃料薄(注)'); oiRead = 'weak'; }
      } else {
        if (o > 1 && !pUp) { conf += 7; ov.push('OI増×価格下=新規売り流入(+)'); oiRead = 'confirm'; }
        else if (o > 3 && pUp) { conf -= 9; ov.push('OI増×価格上=踏み上げ危険(-)'); oiRead = 'contra'; }
        else if (o < -2) { conf -= 3; ov.push('OI減=ショート買い戻し一服(注)'); oiRead = 'weak'; }
      }
    }
    conf = Math.max(0, Math.min(96, Math.round(conf)));
    const price = (st.markets[sym] && st.markets[sym].price) || sig.price;
    const risk = m.params.slAtr * sig.atr;
    const sl = sig.dir === 'long' ? price - risk : price + risk;
    const tp = sig.dir === 'long' ? price + m.params.rr * risk : price - m.params.rr * risk;
    liveSignals[sym] = {
      sym, dir: sig.dir, conf, entry: price, sl, tp, rr: m.params.rr, atr: sig.atr,
      reasons: sig.reasons, overlay: ov, tf: m.tf,
      testWR: m.test.winRate, testExp: m.test.expectancy, testPF: m.test.profitFactor, edge: m.edge,
      exit: m.params.exit, oiRead,
      demand: {
        funding: f ? f.avg : null, oi24: oi ? oi.ch24h : null,
        ls: ls ? ls.accRatio : null, taker: ls ? ls.takerRatio : null,
      },
    };
  }

  function pickCandidate() {
    let best = null;
    Object.values(liveSignals).forEach(s => {
      if (!s.edge) return;                     // 検証エッジのある市場のみ
      if (s.conf < CONF_MIN) return;
      if (!best || s.conf > best.conf) best = s;
    });
    activeCandidate = best;
  }

  /* ---------- render: signal + order ticket ---------- */
  function renderSignal() {
    const host = $('#signalCard'); if (!host) return;
    const s = activeCandidate;
    if (!s) {
      const edged = Object.values(model).filter(m => m.edge).map((m, i) => Object.keys(model)[Object.values(model).indexOf(m)]);
      const list = Object.entries(model).map(([k, m]) => `${k}:${m.edge ? m.tf + '✓' : '×'}`).join('  ');
      host.innerHTML = `<div class="sig-none">
        <div class="sig-none-ic">◎</div><b>エントリー候補なし</b>
        <p>検証済みエッジのある市場で、今この瞬間に条件が揃っていません。</p>
        <div class="edge-map">${Object.entries(model).map(([k, m]) => `<span class="em ${m.edge ? 'ok' : 'no'}">${k} ${m.edge ? m.tf : '不可'}</span>`).join('')}</div>
        <small>✓=アウトオブサンプル黒字で監視中 / ×=エッジ未確認でトレードしない</small>
      </div>`;
      return;
    }
    const dirJP = s.dir === 'long' ? 'ロング（買い）' : 'ショート（売り）';
    const dcls = s.dir === 'long' ? 'long' : 'short';
    const held = paper.positions.find(p => p.sym === s.sym);
    // order ticket sizing
    const risk$ = acct * (riskPct / 100);
    const perUnit = Math.abs(s.entry - s.sl);
    const qty = perUnit > 0 ? risk$ / perUnit : 0;
    const notional = qty * s.entry;
    const px = v => F.usd(v, v > 100 ? 1 : 4);
    host.innerHTML = `
      <div class="sig-badge2 ${dcls}">${s.sym}/USDT · ${dirJP} <span class="sig-tf">${s.tf}足</span></div>
      <div class="sig-conf-row">
        <div class="sig-conf-big">${s.conf}<small>%</small></div>
        <div class="sig-conf-meta">
          <div>確信度（実データ総合）</div>
          <div class="sig-wr">検証データ実績 <b>勝率${s.testWR.toFixed(0)}% / 期待値${s.testExp >= 0 ? '+' : ''}${s.testExp.toFixed(2)}R / PF${(s.testPF >= 99 ? '∞' : s.testPF.toFixed(2))}</b></div>
          <div class="edge-badge">✓ アウトオブサンプル検証済</div>
        </div>
      </div>
      <div class="sig-levels">
        <div><small>エントリー</small><b>${px(s.entry)}</b></div>
        <div><small>損切り (SL)</small><b class="dn">${px(s.sl)}</b></div>
        <div><small>利確 (TP)</small><b class="up">${s.exit === 'trail' ? 'トレール' : px(s.tp)}</b></div>
        <div><small>RR</small><b>1 : ${s.rr}</b></div>
      </div>
      <div class="sig-reasons">${[...s.reasons, ...s.overlay].map(r => `<span>${r}</span>`).join('')}</div>
      ${demandBlock(s)}
      <div class="ticket">
        <div class="ticket-h">📋 発注チケット</div>
        <div class="ticket-inputs">
          <label>口座残高(USD)<input type="number" id="acctIn" value="${acct}" min="10" step="10"></label>
          <label>1回リスク%<input type="number" id="riskIn" value="${riskPct}" min="0.1" max="10" step="0.1"></label>
        </div>
        <div class="ticket-out">
          <div><small>推奨数量</small><b>${qty.toFixed(s.entry > 100 ? 4 : 2)} ${s.sym}</b></div>
          <div><small>想定金額</small><b>${F.usd(notional, 0)}</b></div>
          <div><small>最大損失</small><b class="dn">-${F.usd(risk$, 0)}</b></div>
          <div><small>目標利益</small><b class="up">+${F.usd(risk$ * s.rr, 0)}</b></div>
        </div>
        <button class="btn btn-ghost btn-copy" id="copyOrder">注文内容をコピー</button>
      </div>
      <div class="sig-actions">
        <div class="auto-note">🤖 サーバが検証エッジ銘柄を<b>24時間自動で仮想執行中</b>。この候補も条件を満たせば自動でエントリーされます。</div>
        <span class="sig-warn">実弾ではありません（ペーパー）。実発注はチケットを参考にご自身の取引所で。</span>
      </div>`;
    $('#acctIn').addEventListener('change', e => { acct = Math.max(10, +e.target.value || 1000); localStorage.setItem('caxAcct', acct); renderSignal(); });
    $('#riskIn').addEventListener('change', e => { riskPct = Math.min(10, Math.max(0.1, +e.target.value || 1)); localStorage.setItem('caxRisk', riskPct); renderSignal(); });
    $('#copyOrder').addEventListener('click', () => {
      const txt = `${s.sym}/USDT ${s.dir.toUpperCase()} @${px(s.entry)}\nSL ${px(s.sl)} / TP ${s.exit === 'trail' ? 'trailing' : px(s.tp)}\nQty ${qty.toFixed(s.entry > 100 ? 4 : 2)} ${s.sym} (notional ${F.usd(notional, 0)})\nRisk ${F.usd(risk$, 0)} (${riskPct}% of ${F.usd(acct, 0)})`;
      navigator.clipboard && navigator.clipboard.writeText(txt); toast('注文内容をコピーしました');
    });
  }

  function demandBlock(s) {
    const d = s.demand; if (!d) return '';
    const oiCls = s.oiRead === 'confirm' ? 'up' : (s.oiRead === 'contra' ? 'dn' : 'muted');
    const oiTxt = s.oiRead === 'confirm' ? '順行✓' : (s.oiRead === 'contra' ? '逆行✗' : (s.oiRead === 'weak' ? '燃料薄' : '中立'));
    const fCls = d.funding == null ? 'muted' : (d.funding >= 0 ? 'up' : 'dn');
    return `<div class="demand">
      <div class="demand-h">需給コンフルエンス <span class="muted">ライブ確認・統計検証不可(OI30日制限)</span></div>
      <div class="demand-row">
        <span>OI 24h</span><b class="${d.oi24 == null ? 'muted' : (d.oi24 >= 0 ? 'up' : 'dn')}">${d.oi24 == null ? '—' : F.pct(d.oi24, 1)}</b>
        <span class="dm-tag ${oiCls}">${oiTxt}</span>
      </div>
      <div class="demand-row">
        <span>Funding</span><b class="${fCls}">${d.funding == null ? '—' : F.pct(d.funding, 3)}</b>
        <span>L/S ${d.ls ?? '—'}</span><span>Taker ${d.taker ?? '—'}</span>
      </div>
    </div>`;
  }

  /* ---------- paper open/close ---------- */
  function openPaper(s) {
    const risk = paper.equity * RISK_PCT, perUnit = Math.abs(s.entry - s.sl), size = perUnit > 0 ? risk / perUnit : 0;
    paper.positions.push({ id: 'p' + Date.now(), sym: s.sym, dir: s.dir, entry: s.entry, sl: s.sl, tp: s.tp, size, conf: s.conf, exit: s.exit, atr: s.atr, extreme: s.entry, openedT: Date.now(), price: s.entry });
    savePaper(); toast(`${s.sym} ${s.dir === 'long' ? 'ロング' : 'ショート'} 仮想エントリー`); renderSignal(); renderPositions();
    pushDeskLog(`${s.sym} ${s.dir === 'long' ? 'LONG' : 'SHORT'} 承認・仮想建玉 (${s.tf})`, `SL ${F.usd(s.sl, 0)} / TP ${s.exit === 'trail' ? 'trail' : F.usd(s.tp, 0)}`);
  }
  function closePaper(pos, exitPrice, reason) {
    const dm = pos.dir === 'long' ? 1 : -1, pnl = (exitPrice - pos.entry) * pos.size * dm, R = (exitPrice - pos.entry) * dm / Math.abs(pos.entry - pos.sl);
    paper.equity += pnl; paper.history.unshift({ sym: pos.sym, dir: pos.dir, entry: pos.entry, exit: exitPrice, pnl, R, reason, closedT: Date.now() });
    if (paper.history.length > 60) paper.history.pop();
    paper.positions = paper.positions.filter(p => p.id !== pos.id); savePaper();
    renderPositions(); renderHistory(); renderSignal();
    pushDeskLog(`${pos.sym} ${reason} 決済`, `損益 ${pnl >= 0 ? '+' : ''}${F.usd(pnl, 2)} (${R >= 0 ? '+' : ''}${R.toFixed(2)}R)`);
  }
  CAX.on('tick', ({ sym, price }) => {
    let touched = false;
    paper.positions.filter(p => p.sym === sym).forEach(p => {
      p.price = price;
      if (p.exit === 'trail') {
        if (p.dir === 'long') { p.extreme = Math.max(p.extreme, price); p.sl = Math.max(p.sl, p.extreme - 1.6 * p.atr); if (price <= p.sl) { closePaper(p, p.sl, 'トレール'); touched = true; } }
        else { p.extreme = Math.min(p.extreme, price); p.sl = Math.min(p.sl, p.extreme + 1.6 * p.atr); if (price >= p.sl) { closePaper(p, p.sl, 'トレール'); touched = true; } }
      } else {
        if (p.dir === 'long') { if (price <= p.sl) { closePaper(p, p.sl, 'SL'); touched = true; } else if (price >= p.tp) { closePaper(p, p.tp, 'TP'); touched = true; } }
        else { if (price >= p.sl) { closePaper(p, p.sl, 'SL'); touched = true; } else if (price <= p.tp) { closePaper(p, p.tp, 'TP'); touched = true; } }
      }
    });
    if (!touched) updatePositionsLive();
  });

  /* ---------- backtest card (with train/test split) ---------- */
  function renderBacktest() {
    const host = $('#btCard'); if (!host) return;
    const sym = (activeCandidate && activeCandidate.sym) || (Object.keys(model).find(k => model[k].edge)) || 'BTC';
    const m = model[sym]; if (!m || !m.full) { host.innerHTML = '<div class="tload">最適化中…</div>'; return; }
    $('#btSym').textContent = sym + ' ' + (m.tf || '');
    const f = m.full, tr = m.train, te = m.test;
    const pf = v => v >= 99 ? '∞' : v.toFixed(2);
    host.innerHTML = `
      <div class="bt-split">
        <div class="bt-col"><div class="bt-lab">訓練(前半70%)</div>
          <div>勝率 <b>${tr.winRate.toFixed(0)}%</b></div><div>期待値 <b class="${tr.expectancy >= 0 ? 'up' : 'dn'}">${tr.expectancy >= 0 ? '+' : ''}${tr.expectancy.toFixed(2)}R</b></div><div>PF <b>${pf(tr.profitFactor)}</b> <span class="muted">n${tr.n}</span></div></div>
        <div class="bt-col hl"><div class="bt-lab">検証(後半30%·未使用)</div>
          <div>勝率 <b>${te.winRate.toFixed(0)}%</b></div><div>期待値 <b class="${te.expectancy >= 0 ? 'up' : 'dn'}">${te.expectancy >= 0 ? '+' : ''}${te.expectancy.toFixed(2)}R</b></div><div>PF <b>${pf(te.profitFactor)}</b> <span class="muted">n${te.n}</span></div></div>
      </div>
      <div class="bt-full">全期間: 勝率 <b>${f.winRate.toFixed(0)}%</b> · 期待値 <b class="${f.expectancy >= 0 ? 'up' : 'dn'}">${f.expectancy >= 0 ? '+' : ''}${f.expectancy.toFixed(2)}R</b> · PF <b>${pf(f.profitFactor === Infinity ? 99 : f.profitFactor)}</b> · 最大DD <b class="warn">${f.maxDD.toFixed(0)}%</b> · ${f.n}件</div>
      <canvas id="eqCurve" height="64"></canvas>
      <div class="mini-note">${sym} ${m.tf}足。<b>${m.edge ? '検証データでも黒字＝エッジ確認' : 'エッジ未確認=この市場はトレードしない'}</b>。RR1:${m.params.rr}/ADX≥${m.params.adxMin}/${m.params.exit === 'trail' ? 'トレール決済' : '固定利確'}。</div>`;
    drawEquity(f.eqCurve);
  }
  function drawEquity(curve) {
    const cv = $('#eqCurve'); if (!cv || !curve || curve.length < 2) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = 64;
    cv.width = w * dpr; cv.height = h * dpr; const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mn = Math.min(...curve), mx = Math.max(...curve), X = i => (i / (curve.length - 1)) * w, Y = v => h - 4 - ((v - mn) / (mx - mn || 1)) * (h - 8);
    ctx.clearRect(0, 0, w, h); const up = curve[curve.length - 1] >= curve[0];
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, up ? 'rgba(52,211,153,.3)' : 'rgba(244,63,94,.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.moveTo(0, h); curve.forEach((v, i) => ctx.lineTo(X(i), Y(v))); ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); curve.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.strokeStyle = up ? '#34d399' : '#f43f5e'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  /* ---------- positions / history / depth / alt (same as before) ---------- */
  function renderPositions() {
    if (serverOK) return renderServerPaper();     // サーバ自律口座を優先表示
    const host = $('#posCard'); if (!host) return;
    if (!paper.positions.length) { host.innerHTML = `<div class="pos-empty">保有中の仮想ポジションなし</div>`; renderEquityHeader(); return; }
    host.innerHTML = paper.positions.map(p => { const dm = p.dir === 'long' ? 1 : -1, pnl = (p.price - p.entry) * p.size * dm;
      return `<div class="pos-row ${p.dir}"><div class="pos-top"><span class="pos-sym">${p.sym}</span><span class="pos-dir ${p.dir}">${p.dir === 'long' ? 'LONG' : 'SHORT'}</span><b class="pos-pnl ${pnl >= 0 ? 'up' : 'dn'}">${pnl >= 0 ? '+' : ''}${F.usd(pnl, 2)}</b></div>
        <div class="pos-meta"><span>入 ${F.usd(p.entry, p.entry > 100 ? 0 : 3)}</span><span>現 ${F.usd(p.price, p.price > 100 ? 0 : 3)}</span><span class="dn">SL ${F.usd(p.sl, 0)}</span><span class="up">TP ${p.exit === 'trail' ? '—' : F.usd(p.tp, 0)}</span></div>
        <button class="pos-close" data-id="${p.id}">手動決済</button></div>`; }).join('');
    $$('.pos-close', host).forEach(b => b.addEventListener('click', () => { const p = paper.positions.find(x => x.id === b.dataset.id); if (p) closePaper(p, p.price, '手動'); }));
    renderEquityHeader();
  }
  function updatePositionsLive() {
    paper.positions.forEach(p => { const el = $$(`#posCard .pos-row`).find(r => r.querySelector('.pos-sym') && r.querySelector('.pos-sym').textContent === p.sym); if (!el) return;
      const dm = p.dir === 'long' ? 1 : -1, pnl = (p.price - p.entry) * p.size * dm, b = el.querySelector('.pos-pnl'); if (b) { b.textContent = (pnl >= 0 ? '+' : '') + F.usd(pnl, 2); b.className = 'pos-pnl ' + (pnl >= 0 ? 'up' : 'dn'); } });
    renderEquityHeader();
  }
  function renderHistory() {
    if (serverOK) return renderServerPaper();     // サーバ自律口座を優先表示
    const host = $('#histCard'); if (!host) return;
    const h = paper.history, wins = h.filter(x => x.pnl > 0).length, wr = h.length ? wins / h.length * 100 : 0, net = paper.equity - paper.start;
    host.innerHTML = `<div class="hist-stats">
        <div><small>ペーパー資産</small><b>${F.usd(paper.equity, 0)}</b></div><div><small>累計損益</small><b class="${net >= 0 ? 'up' : 'dn'}">${net >= 0 ? '+' : ''}${F.usd(net, 0)}</b></div>
        <div><small>実績勝率</small><b class="${wr >= 50 ? 'up' : 'dn'}">${wr.toFixed(0)}%</b></div><div><small>決済数</small><b>${h.length}</b></div></div>
      <ul class="hist-list">${h.slice(0, 6).map(x => `<li><span class="hist-sym">${x.sym}</span><span class="pos-dir ${x.dir}">${x.dir === 'long' ? 'L' : 'S'}</span><span class="hist-reason">${x.reason}</span><b class="${x.pnl >= 0 ? 'up' : 'dn'}">${x.pnl >= 0 ? '+' : ''}${F.usd(x.pnl, 1)}</b><span class="hist-r ${x.R >= 0 ? 'up' : 'dn'}">${x.R >= 0 ? '+' : ''}${x.R.toFixed(1)}R</span></li>`).join('') || '<li class="muted">決済履歴なし</li>'}</ul>
      <button class="btn btn-ghost btn-reset" id="resetPaper">ペーパー口座をリセット</button>`;
    $('#resetPaper').addEventListener('click', () => { if (confirm('ペーパー口座を初期化しますか？')) { paper = { equity: 10000, start: 10000, positions: [], history: [] }; savePaper(); renderPositions(); renderHistory(); renderSignal(); } });
    renderEquityHeader();
  }
  function renderEquityHeader() { if (serverOK) return; const el = $('#deskEquity'); if (el) { const net = paper.equity - paper.start; el.innerHTML = `ペーパー資産 <b>${F.usd(paper.equity, 0)}</b> <span class="${net >= 0 ? 'up' : 'dn'}">(${net >= 0 ? '+' : ''}${F.usd(net, 0)})</span>`; } }
  function pushDeskLog(a, b) { const list = $('#deskLog'); if (!list) return; const load = list.querySelector('.log-load'); if (load) load.remove();
    const li = document.createElement('li'); li.innerHTML = `<span class="log-dot"></span><span class="log-t">${new Date().toLocaleTimeString('ja-JP')}</span><span class="log-d"><b>${a}</b><br/><span class="ar">→</span> ${b}</span>`;
    list.insertBefore(li, list.firstChild); while (list.children.length > 8) list.removeChild(list.lastChild); }

  async function refreshDepth() {
    const sym = (activeCandidate && activeCandidate.sym) || 'BTC', bn = (SYMS.find(x => x.s === sym) || SYMS[0]).bn;
    let d; try { d = await getJSON(`${BF}/fapi/v1/depth?symbol=${bn}&limit=50`); } catch (e) { return; }
    const bids = d.bids.map(b => ({ p: +b[0], q: +b[1] })), asks = d.asks.map(a => ({ p: +a[0], q: +a[1] }));
    const bs = bids.reduce((s, x) => s + x.q, 0), as = asks.reduce((s, x) => s + x.q, 0), imb = (bs - as) / (bs + as) * 100;
    const host = $('#depthCard'); if (!host) return; $('#depthSym') && ($('#depthSym').textContent = sym);
    const mq = Math.max(...bids.slice(0, 8).map(x => x.q), ...asks.slice(0, 8).map(x => x.q));
    const row = (x, side) => `<div class="ob-row ${side}"><i style="width:${x.q / mq * 100}%"></i><span class="ob-p">${F.usd(x.p, x.p > 100 ? 1 : 4)}</span><span class="ob-q">${x.q.toFixed(2)}</span></div>`;
    host.innerHTML = `<div class="ob-imb"><div class="ob-imb-bar"><i class="bid" style="width:${bs / (bs + as) * 100}%"></i><i class="ask" style="width:${as / (bs + as) * 100}%"></i></div>
      <div class="ob-imb-lab"><span class="up">買 ${(bs / (bs + as) * 100).toFixed(0)}%</span><b class="${imb >= 0 ? 'up' : 'dn'}">偏り ${imb >= 0 ? '+' : ''}${imb.toFixed(0)}%</b><span class="dn">売 ${(as / (bs + as) * 100).toFixed(0)}%</span></div></div>
      <div class="ob-cols"><div class="ob-col">${asks.slice(0, 6).reverse().map(x => row(x, 'ask')).join('')}</div><div class="ob-col">${bids.slice(0, 6).map(x => row(x, 'bid')).join('')}</div></div>`;
  }
  function renderAltStrength() {
    const host = $('#altCard'); if (!host) return; const m = CAX.state.markets, btc = m.BTC; if (!btc) return;
    const coins = Object.values(m).filter(c => c.mcap && c.sym !== 'USDT' && c.sym !== 'USDC').map(c => ({ ...c, rel: c.ch24h - btc.ch24h })).sort((a, b) => b.rel - a.rel).slice(0, 8);
    const mr = Math.max(...coins.map(c => Math.abs(c.rel)), 1);
    host.innerHTML = coins.map(c => `<div class="alt-row"><span class="alt-sym">${c.sym}</span><div class="alt-bar"><i class="${c.rel >= 0 ? 'pos' : 'neg'}" style="width:${Math.abs(c.rel) / mr * 50}%;${c.rel >= 0 ? 'left:50%' : 'right:50%'}"></i></div><span class="alt-val ${c.rel >= 0 ? 'up' : 'dn'}">${c.rel >= 0 ? '+' : ''}${c.rel.toFixed(1)}%</span></div>`).join('');
  }
  function toast(msg) { const t = $('#toast'); if (!t) return; t.innerHTML = `<span class="ti">◈</span> ${msg}`; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2600); }

  /* ---------- 群衆ポジショニング可視化 ---------- */
  async function renderPositioning() {
    const grid = $('#posGrid'); if (!grid) return;
    const cards = await Promise.all(['BTCUSDT', 'ETHUSDT'].map(async s => {
      try { return await getJSON('/api/positioning?sym=' + s); } catch (e) { return { sym: s, error: 'fetch' }; }
    }));
    grid.innerHTML = cards.map(p => {
      if (p.error) return `<article class="card"><h3 class="card-h">${p.sym} <span class="muted">取得失敗</span></h3></article>`;
      const c = p.current, sym = p.sym.replace('USDT', '');
      // リテールの傾き: 1超=ロング多数、1未満=ショート多数。パーセンタイルで極端さ
      const lean = c.retail >= 1 ? 'ロング多数' : 'ショート多数';
      const extreme = c.retailPct >= 80 ? '⚠ 極端ロング(餌ゾーン)' : c.retailPct <= 20 ? '⚠ 極端ショート(踏み上げ余地)' : '中立圏';
      const oiCls = c.oiChg6h == null ? 'muted' : c.oiChg6h > 2 ? 'dn' : c.oiChg6h < -2 ? 'up' : 'muted';
      const oiTxt = c.oiChg6h == null ? '—' : (c.oiChg6h >= 0 ? '+' : '') + c.oiChg6h + '%' + (c.oiChg6h > 2 ? ' 群衆殺到' : c.oiChg6h < -2 ? ' 手仕舞い' : '');
      const rows = p.study.map(x => {
        const cls = x.avgFwd8h > 0.1 ? 'up' : x.avgFwd8h < -0.1 ? 'dn' : 'muted';
        return `<tr><td>${x.regime}</td><td>${x.n}</td><td>${x.upRate}%</td><td class="${cls}">${x.avgFwd8h >= 0 ? '+' : ''}${x.avgFwd8h}%</td></tr>`;
      }).join('');
      return `<article class="card">
        <h3 class="card-h">${sym} 群衆ポジション <span class="muted">${p.days}日</span></h3>
        <div class="pos-gauge">
          <div class="pos-lean"><b>${lean}</b> <span class="pos-ext">${extreme}</span></div>
          <div class="pos-bar"><i style="width:${c.retailPct}%"></i><span class="pos-mark" style="left:${c.retailPct}%"></span></div>
          <div class="pos-scale"><span>ショート偏</span><span>中立</span><span>ロング偏</span></div>
        </div>
        <div class="pos-kv"><span>散りL/S比</span><b>${c.retail} <em class="muted">(${c.retailPct}%タイル)</em></b></div>
        <div class="pos-kv"><span>成行フロー</span><b class="${c.taker == null ? 'muted' : c.taker >= 1 ? 'up' : 'dn'}">${c.taker == null ? '—' : c.taker + (c.taker >= 1 ? ' 買い優勢' : ' 売り優勢')}</b></div>
        <div class="pos-kv"><span>OI 6h変化</span><b class="${oiCls}">${oiTxt}</b></div>
        <table class="pos-study"><thead><tr><th>群衆レジーム</th><th>件数</th><th>8h後↑率</th><th>平均</th></tr></thead><tbody>${rows}</tbody></table>
      </article>`;
    }).join('');
    const cav = $('#posCaveat');
    if (cav) cav.innerHTML = `⚠ この研究は<b>直近21日のみ</b>（取引所のL/S履歴は30日制限）。今の反発相場に偏っており<b>再現性は未検証</b>。素の比率でのエントリーは大口の餌になりやすい＝トレード根拠には使わず、<b>状況把握</b>として見る。真の検証には収集サーバが貯めている自前の長期履歴が必要。`;
  }

  /* ---------- refresh cycle ---------- */
  function recompute() { SYMS.forEach(x => computeSignal(x.s)); pickCandidate(); renderSignal(); renderBacktest(); }
  async function rebuild() {
    pushDeskLog('最適化を実行中…', '銘柄×時間足でパラメータ探索＋アウトオブサンプル検証');
    for (const x of SYMS) { await buildModel(x.s, x.bn); }
    const edged = Object.entries(model).filter(([, m]) => m.edge).map(([k, m]) => `${k}(${m.tf})`);
    pushDeskLog('最適化完了', edged.length ? `検証エッジ確認: ${edged.join(', ')}` : '現在エッジ確認できる市場なし（待機）');
    recompute();
  }

  function init() {
    try { localStorage.removeItem(LS); } catch (e) { }  // 旧ローカル口座は破棄（サーバ自律口座に一本化）
    paper = { equity: 10000, start: 10000, positions: [], history: [] };
    pollServerPaper();                                    // サーバ自律ペーパー口座を取得・表示
    setInterval(pollServerPaper, 5000);
    let ptT; CAX.on('tick', () => { if (serverOK) { clearTimeout(ptT); ptT = setTimeout(renderServerPaper, 300); } }); // 保有ポジのライブ損益
    renderPositions(); renderHistory(); renderEquityHeader();
    CAX.on('markets', renderAltStrength); if (Object.keys(CAX.state.markets).length) renderAltStrength();
    // 需給データが届いたらライブ確認フィルタを反映
    let rcT; const softRecompute = () => { clearTimeout(rcT); rcT = setTimeout(recompute, 400); };
    CAX.on('funding', softRecompute); CAX.on('oi', softRecompute); CAX.on('ls', softRecompute);
    $('#signalCard') && ($('#signalCard').innerHTML = '<div class="tload">エッジ検証中…（最適化＋アウトオブサンプル）</div>');
    $('#btCard') && ($('#btCard').innerHTML = '<div class="tload">最適化中…</div>');
    rebuild(); refreshDepth();
    renderPositioning(); setInterval(renderPositioning, 120000);  // 群衆ポジショニング可視化
    setInterval(recompute, 60000);        // ライブ再評価
    setInterval(rebuild, 3600000);        // 1時間毎にモデル再最適化
    setInterval(refreshDepth, 6000);
    setInterval(() => { const sym = (activeCandidate && activeCandidate.sym) || 'BTC'; if (model[sym] && model[sym].full) drawEquity(model[sym].full.eqCurve); }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
