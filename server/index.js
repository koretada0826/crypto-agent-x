/* ============================================================
   CRYPTO AGENT X — Data Collector & Server (zero-dependency)
   取引所が保持しないOI/Funding/L-S履歴を毎分記録し、
   将来のOIエッジ・バックテストの土台を作る。
   ------------------------------------------------------------
   起動: node server/index.js
   ・毎60秒 BTC/ETH/SOL の OI/Funding/L-S/価格を収集し JSONL 追記
   ・http://localhost:8790/  で web/ を配信（実弾発注はしない）
   ・API: /api/history?sym=BTC&limit=500 , /api/status
   Node18+ (global fetch) 必須。外部パッケージ不要。
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 想定外エラーでもプロセスを落とさない（1回のfetch失敗等で全停止しない）
process.on('uncaughtException', e => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e && (e.message || e)));
// macOS通知（起動・再起動を知らせる＝落ちて自動復旧したら気づける）
function notify(msg, title = 'CRYPTO AGENT X') {
  try { exec(`osascript -e 'display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}'`); } catch (e) { }
}
const S = require(path.join(__dirname, '..', 'web', 'js', 'strategy.js')); // 共有戦略コア

const PORT = process.env.PORT || 8790;
const WEB_DIR = path.join(__dirname, '..', 'web');
const DATA_DIR = path.join(__dirname, 'data');
const INTERVAL_MS = 60 * 1000;
const SCAN_MS = 30 * 60 * 1000;                 // 30分毎にエッジ再探索
const SCAN_TFS = ['4h', '6h', '12h', '1d'];   // GMO想定＝4h以上の現実的な保有時間
const EDGE_GATE = { minN: 12, minExp: 0.12, minPF: 1.25 };      // エッジ最低基準(検証)。★2026-07-07厳格化: 旧n8/exp0.03/PF1.05は緩すぎ(trend族がn8-13の極小サンプルで採用され不振=ATOM等)。funding系(n≥25)に寄せ、脆弱な小サンプルtrendを剪定
// GMO連携“準備OK”基準：単発の好成績では昇格させない。時間をかけて安定確認する。
// GMO連携“準備OK”基準：過去検証だけでは不十分。前向き(フォワード)のペーパー実績で裏を取る。
const GMO_GATE = { minExp: 0.15, minPF: 1.4, minN: 10, minStable: 0.75, minScans: 12, minClosed: 25, minPaperWR: 45 }; // 過去検証(安定黒字) かつ ペーパー決済25件以上で純益プラス＆勝率45%以上
const EDGE_FILE = path.join(DATA_DIR, 'edge-report.jsonl');
const SCORECARD_FILE = path.join(DATA_DIR, 'scorecard.jsonl');

// OI/Funding/L-S を詳細記録する主要3銘柄（クロス取引所）
const COINS = [
  { sym: 'BTC', bn: 'BTCUSDT', bybit: 'BTCUSDT', okx: 'BTC-USDT-SWAP' },
  { sym: 'ETH', bn: 'ETHUSDT', bybit: 'ETHUSDT', okx: 'ETH-USDT-SWAP' },
  { sym: 'SOL', bn: 'SOLUSDT', bybit: 'SOLUSDT', okx: 'SOL-USDT-SWAP' },
];
// 取引ユニバース = GMOコインで取引可能 かつ Binance先物にデータがある銘柄（エッジ探索＋ペーパー執行対象）
const UNIVERSE = [
  { sym: 'BTC', bn: 'BTCUSDT' }, { sym: 'ETH', bn: 'ETHUSDT' }, { sym: 'SOL', bn: 'SOLUSDT' },
  { sym: 'ADA', bn: 'ADAUSDT' }, { sym: 'XRP', bn: 'XRPUSDT' }, { sym: 'DOGE', bn: 'DOGEUSDT' },
  { sym: 'LINK', bn: 'LINKUSDT' }, { sym: 'DOT', bn: 'DOTUSDT' }, { sym: 'ATOM', bn: 'ATOMUSDT' },
  { sym: 'BCH', bn: 'BCHUSDT' }, { sym: 'LTC', bn: 'LTCUSDT' }, { sym: 'XLM', bn: 'XLMUSDT' },
  { sym: 'XTZ', bn: 'XTZUSDT' }, { sym: 'SUI', bn: 'SUIUSDT' },
];
const BF = 'https://fapi.binance.com';
const BYBIT = 'https://api.bybit.com';
const OKX = 'https://www.okx.com';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const stat = { started: Date.now(), cycles: 0, lastTs: null, errors: 0, counts: {}, lastSnap: {}, scanCount: 0, lastScan: null, readiness: { ready: false, candidates: [] } };
COINS.forEach(c => { stat.counts[c.sym] = countLines(fileFor(c.sym)); });

function fileFor(sym) { return path.join(DATA_DIR, sym + '.jsonl'); }
function countLines(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } }
const n = v => (v == null || isNaN(+v)) ? null : +v;

async function getJSON(url, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function settle(p) { try { return await p; } catch (e) { return null; } }

/* ---------- collect one snapshot per coin ---------- */
async function collectCoin(c) {
  const [prem, oiBn, oiBy, oiOx, funBy, funOx, lsAcc, lsPos, lsTk] = await Promise.all([
    settle(getJSON(`${BF}/fapi/v1/premiumIndex?symbol=${c.bn}`)),
    settle(getJSON(`${BF}/fapi/v1/openInterest?symbol=${c.bn}`)),
    settle(getJSON(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${c.bybit}&intervalTime=1h&limit=1`)),
    settle(getJSON(`${OKX}/api/v5/public/open-interest?instType=SWAP&instId=${c.okx}`)),
    settle(getJSON(`${BYBIT}/v5/market/tickers?category=linear&symbol=${c.bybit}`)),
    settle(getJSON(`${OKX}/api/v5/public/funding-rate?instId=${c.okx}`)),
    settle(getJSON(`${BF}/futures/data/globalLongShortAccountRatio?symbol=${c.bn}&period=5m&limit=1`)),
    settle(getJSON(`${BF}/futures/data/topLongShortPositionRatio?symbol=${c.bn}&period=5m&limit=1`)),
    settle(getJSON(`${BF}/futures/data/takerlongshortRatio?symbol=${c.bn}&period=5m&limit=1`)),
  ]);
  const price = prem ? n(prem.markPrice) : null;
  const fBn = prem ? n(prem.lastFundingRate) * 100 : null;
  const fBy = funBy && funBy.result && funBy.result.list[0] ? n(funBy.result.list[0].fundingRate) * 100 : null;
  const fOx = funOx && funOx.data && funOx.data[0] ? n(funOx.data[0].fundingRate) * 100 : null;
  const fVals = [fBn, fBy, fOx].filter(v => v != null);
  const oiBinance = oiBn && price ? n(oiBn.openInterest) * price : null;
  const oiBybit = oiBy && oiBy.result && oiBy.result.list[0] && price ? n(oiBy.result.list[0].openInterest) * price : null;
  const oiOkx = oiOx && oiOx.data && oiOx.data[0] ? n(oiOx.data[0].oiUsd) : null;
  const oiTotal = [oiBinance, oiBybit, oiOkx].filter(v => v != null).reduce((a, b) => a + b, 0);

  return {
    t: Date.now(), sym: c.sym, price,
    funding: { binance: fBn, bybit: fBy, okx: fOx, avg: fVals.length ? fVals.reduce((a, b) => a + b, 0) / fVals.length : null },
    oiUsd: { binance: oiBinance, bybit: oiBybit, okx: oiOkx, total: oiTotal || null },
    ls: {
      acct: lsAcc && lsAcc[0] ? n(lsAcc[0].longShortRatio) : null,
      pos: lsPos && lsPos[0] ? n(lsPos[0].longShortRatio) : null,
      taker: lsTk && lsTk[0] ? n(lsTk[0].buySellRatio) : null,
    },
  };
}
// 軽量収集(Binance単体): 深掘り3銘柄以外の11銘柄用。funding/OI/L-Sを1取引所で記録しAPI負荷を抑制
async function collectLite(c) {
  const [prem, oi, lsAcc, lsPos, lsTk] = await Promise.all([
    settle(getJSON(`${BF}/fapi/v1/premiumIndex?symbol=${c.bn}`)),
    settle(getJSON(`${BF}/fapi/v1/openInterest?symbol=${c.bn}`)),
    settle(getJSON(`${BF}/futures/data/globalLongShortAccountRatio?symbol=${c.bn}&period=5m&limit=1`)),
    settle(getJSON(`${BF}/futures/data/topLongShortPositionRatio?symbol=${c.bn}&period=5m&limit=1`)),
    settle(getJSON(`${BF}/futures/data/takerlongshortRatio?symbol=${c.bn}&period=5m&limit=1`)),
  ]);
  const price = prem ? n(prem.markPrice) : null;
  const fBn = prem ? n(prem.lastFundingRate) * 100 : null;
  const oiUsd = oi && price ? n(oi.openInterest) * price : null;
  return {
    t: Date.now(), sym: c.sym, price,
    funding: { binance: fBn, avg: fBn },
    oiUsd: { binance: oiUsd, total: oiUsd },
    ls: {
      acct: lsAcc && lsAcc[0] ? n(lsAcc[0].longShortRatio) : null,
      pos: lsPos && lsPos[0] ? n(lsPos[0].longShortRatio) : null,
      taker: lsTk && lsTk[0] ? n(lsTk[0].buySellRatio) : null,
    },
  };
}

let _cycleRunning = false;
async function cycle() {
  if (_cycleRunning) { console.warn(`[${new Date().toISOString()}] cycle重複をスキップ（前サイクル未完/スリープ復帰）`); return; }  // 多重実行ガード: 二重建玉・jsonl破損を防止
  _cycleRunning = true;
  try {
    for (const c of COINS) {                                 // 深掘り3銘柄(BTC/ETH/SOL): 3取引所のfunding/OI/L-S
      const snap = await collectCoin(c);
      fs.appendFileSync(fileFor(c.sym), JSON.stringify(snap) + '\n');
      stat.counts[c.sym] = (stat.counts[c.sym] || 0) + 1;
      stat.lastSnap[c.sym] = snap;
    }
    // ★残り11銘柄も履歴記録(Binance単体の軽量収集・並列)。全14銘柄のfunding/OI/L-S長期履歴を蓄積→OIエッジ検証+裁量監視の土台
    const liteSyms = UNIVERSE.filter(u => !COINS.find(c => c.sym === u.sym));
    const liteSnaps = await Promise.all(liteSyms.map(c => settle(collectLite(c))));
    for (let i = 0; i < liteSyms.length; i++) {
      const snap = liteSnaps[i]; if (!snap) continue;
      fs.appendFileSync(fileFor(liteSyms[i].sym), JSON.stringify(snap) + '\n');
      stat.counts[liteSyms[i].sym] = (stat.counts[liteSyms[i].sym] || 0) + 1;
      stat.lastSnap[liteSyms[i].sym] = snap;
    }
    stat.cycles++; stat.lastTs = Date.now();
    await managePaper();                         // 自律ペーパー執行・監視（GMO取引可の全ユニバース）
    const b = stat.lastSnap.BTC;
    console.log(`[${new Date().toISOString()}] cycle #${stat.cycles} ` +
      (b ? `BTC $${b.price} fund ${b.funding.avg?.toFixed(3)}% OI $${(b.oiUsd.total / 1e9).toFixed(2)}B L/S ${b.ls.acct}` : '') +
      ` | paper $${paper.equity.toFixed(0)} open${paper.positions.length} closed${paper.history.length}`);
  } catch (e) { stat.errors++; console.error('cycle error', e.message); }
  finally { _cycleRunning = false; }
}

/* ============================================================
   AUTONOMOUS EDGE SCANNER — 私が起きていなくてもエッジを探し続ける
   30分毎に 銘柄×時間足 を最適化＋アウトオブサンプル検証し記録。
   複数スキャンで“安定して黒字”なものを GMO連携候補として昇格。
   ============================================================ */
async function klines(bn, tf, limit) {
  const j = await getJSON(`${BF}/fapi/v1/klines?symbol=${bn}&interval=${tf}&limit=${limit}`);
  return j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}
async function scanEdges() {
  const scan = { t: Date.now(), results: [] };
  for (const c of UNIVERSE) {
    let daily = null; try { daily = await klines(c.bn, '1d', 400); } catch (e) { }
    for (const tf of SCAN_TFS) {
      try {
        const rows = await klines(c.bn, tf, tf === '1d' ? 1000 : 1500);
        const htf = (daily && tf !== '1d') ? S.buildHTF(rows, daily) : null;   // 上位足=日足（1d足自身には付けない）
        const o = S.optimize(rows, { split: 0.7, htf });
        if (!o) continue;
        const wfOK = !o.wf || o.wf.windows < 2 || o.wf.positive >= Math.ceil(o.wf.windows * 0.6); // 時系列頑健性
        const pass = o.test.n >= EDGE_GATE.minN && o.test.expectancy >= EDGE_GATE.minExp && o.test.profitFactor >= EDGE_GATE.minPF && wfOK;
        scan.results.push({
          sym: c.sym, tf, pass,
          test: { winRate: +o.test.winRate.toFixed(1), exp: +o.test.expectancy.toFixed(3), pf: +o.test.profitFactor.toFixed(2), n: o.test.n },
          full: { exp: +o.full.expectancy.toFixed(3), pf: +(o.full.profitFactor === Infinity ? 99 : o.full.profitFactor).toFixed(2), n: o.full.n, maxDD: +o.full.maxDD.toFixed(1) },
          wf: o.wf, params: o.params,
        });
      } catch (e) { /* skip tf */ }
    }
  }
  fs.appendFileSync(EDGE_FILE, JSON.stringify(scan) + '\n');
  stat.lastScan = scan; stat.scanCount = (stat.scanCount || 0) + 1;
  updateActiveModels(scan);        // ペーパー自動売買が使う“検証エッジ銘柄”を更新
  autoPromoteTrend(scan);          // ★B: 全WF一様プラスが連続する頑健trendを自動でホワイトリスト入り
  computeReadiness();
  detectStructural().catch(() => { }); // 構造シグナルの検出・記録（実験室）
  const passing = scan.results.filter(r => r.pass).map(r => `${r.sym}(${r.tf}) ${r.test.exp >= 0 ? '+' : ''}${r.test.exp}R`);
  console.log(`[${new Date().toISOString()}] EDGE SCAN #${stat.scanCount}: ${passing.length ? passing.join(', ') : 'エッジなし'} | GMO準備: ${stat.readiness.ready ? 'OK ' + stat.readiness.candidates.map(x => x.key).join(',') : '未達'}`);
}

/* エッジの“安定性”を過去スキャンから集計し、GMO準備OKか判定 */
function computeReadiness() {
  let scans = [];
  try { scans = fs.readFileSync(EDGE_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { }
  const recent = scans.slice(-20);            // 直近20スキャン
  const seen = {};                            // key -> {passCount, last}
  recent.forEach(sc => sc.results.forEach(r => {
    const key = `${r.sym}/${r.tf}`;
    seen[key] = seen[key] || { key, sym: r.sym, tf: r.tf, passCount: 0, total: 0, last: null };
    seen[key].total++; if (r.pass) seen[key].passCount++; seen[key].last = r;
  }));
  const enoughScans = recent.length >= GMO_GATE.minScans;   // 十分な回数を経ていない間は昇格しない
  const candidates = Object.values(seen).filter(s => {
    const stable = s.total ? s.passCount / s.total : 0;
    const t = s.last && s.last.test;
    return t && s.total >= GMO_GATE.minScans && stable >= GMO_GATE.minStable && t.exp >= GMO_GATE.minExp && t.pf >= GMO_GATE.minPF && t.n >= GMO_GATE.minN;
  }).map(s => ({ key: s.key, sym: s.sym, tf: s.tf, stability: +(s.passCount / s.total).toFixed(2), scans: s.total, test: s.last.test }));
  // 前向き(フォワード)ペーパー実績での裏取り
  const closed = paper.history.length, net = paper.equity - paper.start;
  const paperWR = closed ? paper.history.filter(h => h.pnl > 0).length / closed * 100 : 0;
  const paperProven = closed >= GMO_GATE.minClosed && net > 0 && paperWR >= GMO_GATE.minPaperWR;
  const scanProgress = Math.min(1, recent.length / GMO_GATE.minScans);
  const paperProgress = Math.min(1, closed / GMO_GATE.minClosed);
  stat.readiness = {
    ready: enoughScans && candidates.length > 0 && paperProven,   // 過去検証＋フォワード実績の両方が必要
    candidates, evaluatedScans: recent.length, needScans: GMO_GATE.minScans,
    paperClosed: closed, needClosed: GMO_GATE.minClosed, paperNet: +net.toFixed(2), paperWR: +paperWR.toFixed(0), paperProven,
    progress: +Math.min(scanProgress, paperProgress).toFixed(2), gate: GMO_GATE,
  };
}

/* ============================================================
   AUTONOMOUS PAPER TRADER — 24時間サーバ側で仮想売買（実弾なし）
   ・検証エッジのある銘柄で、確定足のシグナルが出たら自動で仮想建玉
   ・毎サイクル(60s)マーク価格でSL/TP判定→自動決済
   ・口座/履歴を paper.json に永続化。ブラウザを閉じても動く。
   ============================================================ */
const PAPER_FILE = path.join(DATA_DIR, 'paper.json');
const PAPER_RISK = 0.01, PAPER_CONF_MIN = 60;
const LEGACY_EDGES = false;   // ★旧エッジ(activeModelsのtrend/mr全銘柄, dip)を停止(2026-07-09 ユーザー要望)。現行検証済エッジ(funding系ショート/calendar/mr_rsi2)のみでフォワード測定
// ★2026-08-07 増強: LEGACY全開放はせず、バックテスト1400回連続100%合格の頑健trendだけを厳選投入(sym->tf)。funding(逆張り)と無相関=分散でDD低減狙い
const TREND_WHITELIST = { XTZ: '12h', ETH: '1d', ADA: '12h' };
// ★2026-08-07 稼ぐ仕組み3点: A=エッジ自動キル / B=厳格オート昇格 / C=週次スコアカード
const KILL_MIN_N = 8;        // 自動キル判定に必要な最低決済数
const KILL_WINDOW = 12;      // 直近この本数の決済で評価
const KILL_R = -3;           // 直近KILL_WINDOW本の合計Rがこれ以下=自動停止(損失の垂れ流し防止)
// ★2026-08-07 自律ループ修正: 旧「全WF一様連続」は厳しすぎ(優良ETH1dですら一様pass4%)＋連続ストリークは地合いで釣れる(ATOM4h全12%なのに直近連続合格)。
// →「長期pass率」判定に変更。実装済XTZ/ETH/ADAを選んだ実際の基準(=長期に安定合格)に一致させ、レジーム依存フラッシュを弾く。
const TREND_PROMOTE_WINDOW = 96;   // 直近この回数のスキャン(≈2日)でのpass率で判定
const TREND_PROMOTE_MINSAMPLES = 60;  // 昇格判定に必要な最低サンプル数
const TREND_PROMOTE_RATE = 0.9;    // 長期pass率がこれ以上=durable(XTZ/ETH/ADAは約100%, ATOM4hは約12%で弾かれる)
const SCORECARD_MS = 7 * 24 * 3600 * 1000;  // 週次スコアカード間隔
const COST_RATE = 0.0008;   // 片道 手数料+スリッページ（GMO taker 0.05% + slip 0.03%）
// ポートフォリオ・リスク管理（相関・分散・破綻防止）
const MAX_OPEN = 6;         // 同時保有の上限（総リスク=総ヒート抑制）
const MAX_PER_DIR = 4;      // 同方向の上限（全部ショート等の一方向偏りを防ぐ）
const MAX_DD_HALT = 12;     // 評価額ドローダウン(%)がこれを超えたら新規エントリー停止
const FUND_MAXHOLD_MS = 24 * 8 * 3600 * 1000; // funding系エッジの時間決済=24バー(8h)=8日。WF検証: exp維持(0.161)+PF改善(1.32)+テールリスク削減
let lastPrices = {};        // 直近の全銘柄価格（含み損益・監視用）
// 投げ売り逆張り買い（capitulation long）: 深い売られ過ぎ×極度の恐怖でのみ発動（ユーザー承認の自律買い）
let lastFng = null, lastFngT = 0;
async function getFng() {
  if (lastFng != null && Date.now() - lastFngT < 600000) return lastFng;
  try { const j = await getJSON('https://api.alternative.me/fng/?limit=1'); lastFng = +j.data[0].value; lastFngT = Date.now(); } catch (e) { }
  return lastFng;
}
let activeModels = {};   // sym -> {tf, params, test}
let paper = loadPaper();
function loadPaper() {
  let p;
  try { p = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8')); } catch (e) { return { equity: 10000, start: 10000, positions: [], history: [], lastSignalT: {} }; }
  // 移行: 時間決済導入前のfunding系旧ポジにcloseAtを後付け(検証済8日=24bar)。延々塩漬けを防ぐ安全網。エッジ短縮はしない。
  for (const pos of (p.positions || [])) {
    if (!pos.closeAt && ['funding', 'fstreak', 'fundcum'].includes(pos.type) && pos.openedT) pos.closeAt = pos.openedT + FUND_MAXHOLD_MS;
  }
  return p;
}
function savePaper() { try { fs.writeFileSync(PAPER_FILE, JSON.stringify(paper)); } catch (e) { } }

/* ============================================================
   ★稼ぐ仕組み A: エッジ自動キル — 負けが続くエッジを自動停止
   稼働中エッジの実現Rを常時監視し、直近KILL_WINDOW本でKILL_R以下なら停止。
   fstreak/fundcumの-7.84R垂れ流しを構造的に再発防止。手動選別の自動化。
   ============================================================ */
function edgeLive(type) { return !((paper.disabledEdges || []).includes(type)); }
function evaluateEdgeHealth() {
  paper.disabledEdges = paper.disabledEdges || [];
  const byType = {};
  for (const h of paper.history) { (byType[h.type] || (byType[h.type] = [])).push(h); }  // historyは新しい順(unshift)
  for (const [type, arr] of Object.entries(byType)) {
    if (paper.disabledEdges.includes(type)) continue;
    const recent = arr.slice(0, KILL_WINDOW);
    if (recent.length < KILL_MIN_N) continue;
    const sumR = recent.reduce((s, x) => s + (x.R || 0), 0);
    if (sumR <= KILL_R) {
      paper.disabledEdges.push(type); savePaper();
      console.log(`[AUTO-KILL] エッジ '${type}' 自動停止: 直近${recent.length}本で${sumR.toFixed(2)}R (基準${KILL_R}R以下)`);
      notify(`エッジ自動停止: ${type} (直近${recent.length}本 ${sumR.toFixed(1)}R)`, 'CRYPTO AGENT X リスク');
    }
  }
}
/* ★稼ぐ仕組み B: trendの厳格オート昇格対象tfを返す(ホワイトリスト + 自動昇格分) */
function trendTargetTf(sym) {
  if (TREND_WHITELIST[sym]) return TREND_WHITELIST[sym];
  const p = (promoted.trend || []).find(x => x.sym === sym);
  return p ? p.tf : null;
}
let trendPassHist = {};   // key -> 直近スキャンのpass結果(0/1)配列。長期pass率でdurableなtrendのみ昇格
function autoPromoteTrend(scan) {
  for (const r of scan.results) {
    if (!r || !r.params || r.params.type !== 'trend') continue;
    const key = r.sym + ':' + r.tf;
    const arr = trendPassHist[key] || (trendPassHist[key] = []);
    arr.push(r.pass ? 1 : 0);
    while (arr.length > TREND_PROMOTE_WINDOW) arr.shift();
    if (arr.length < TREND_PROMOTE_MINSAMPLES) continue;                 // サンプル不足=まだ判定しない
    const rate = arr.reduce((s, x) => s + x, 0) / arr.length;
    // 昇格条件: 長期pass率が高い(=地合い依存でなく普遍的) + 現在pass + 低DD + 十分な期待値
    if (rate >= TREND_PROMOTE_RATE && r.pass && r.full.exp >= 0.25 && r.full.maxDD <= 8) {
      if (TREND_WHITELIST[r.sym] || (promoted.trend || []).find(x => x.sym === r.sym)) continue; // 1銘柄1trend
      promoted.trend = promoted.trend || [];
      promoted.trend.push({ sym: r.sym, tf: r.tf, promotedAt: Date.now(), exp: r.full.exp, maxDD: r.full.maxDD, passRate: +rate.toFixed(2) }); savePromoted();
      console.log(`[AUTO-PROMOTE] trend ${key} 昇格→実弾trend対象 (直近${arr.length}スキャンpass率${(100 * rate).toFixed(0)}% exp+${r.full.exp} DD${r.full.maxDD}%)`);
      notify(`trendエッジ自動昇格: ${key} (pass率${(100 * rate).toFixed(0)}% exp+${r.full.exp})`, 'CRYPTO AGENT X');
    }
  }
}
/* ★ポートフォリオ公開用スナップショット: paper全体＋エクイティ曲線＋エッジ別内訳。publish_snapshot.shがcurlしてGitHubへpush→Vercelの静的画面が読む */
function buildSnapshot() {
  const s = paperStats();
  // エクイティ曲線: history(新しい順)を時系列昇順に並べ、startからの累積で復元
  const hist = [...(paper.history || [])].sort((a, b) => a.closedT - b.closedT);
  let eq = paper.start || 10000;
  const equityCurve = [{ t: hist.length ? hist[0].openedT || hist[0].closedT : Date.now(), equity: eq }];
  for (const h of hist) { eq += h.pnl; equityCurve.push({ t: h.closedT, equity: +eq.toFixed(2) }); }
  // エッジ別内訳
  const byEdge = {};
  for (const h of (paper.history || [])) { const b = byEdge[h.type] || (byEdge[h.type] = { n: 0, win: 0, pnl: 0, R: 0 }); b.n++; b.pnl += h.pnl; b.R += h.R; if (h.pnl > 0) b.win++; }
  for (const k of Object.keys(byEdge)) { byEdge[k].pnl = +byEdge[k].pnl.toFixed(2); byEdge[k].R = +byEdge[k].R.toFixed(2); byEdge[k].winRate = Math.round(100 * byEdge[k].win / byEdge[k].n); }
  return Object.assign({}, s, { updatedAt: Date.now(), equityCurve, byEdge, cyclesRun: stat.cycles, uptimeStartedAt: stat.started });
}
/* ★ポートフォリオ公開: buildSnapshot()を.snapshot-wt(snapshotブランチのworktree)へ書き出しGitHubへforce-push。
   Vercelの静的画面が raw.githubusercontent.com/.../snapshot/web/snapshot.json を読む。
   launchd bashはDesktopがTCC保護で不可→既にDesktopアクセス権を持つ本サーバ(node)が実行。 */
const SNAP_WT = path.join(__dirname, '..', '.snapshot-wt');
function publishSnapshot() {
  try {
    const dir = path.join(SNAP_WT, 'web');
    if (!fs.existsSync(dir)) return;   // worktree未セットアップならスキップ
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(buildSnapshot()));
    const cmd = 'git add web/snapshot.json && (git diff --cached --quiet || ((git commit --amend --no-edit -q 2>/dev/null || git commit -m snapshot -q) && git push -f -q origin snapshot))';
    exec(cmd, { cwd: SNAP_WT, timeout: 60000 }, (e) => { if (e) console.warn('[SNAPSHOT] publish:', e.message); });
  } catch (e) { console.warn('[SNAPSHOT] err', e.message); }
}
/* ★稼ぐ仕組み C: 週次スコアカード — 実測をエッジ別に自動集計＋通知 */
function weeklyScorecard() {
  const now = Date.now();
  if (!paper.lastScorecardT) { paper.lastScorecardT = now; savePaper(); return; }
  if (now - paper.lastScorecardT < SCORECARD_MS) return;
  const since = paper.lastScorecardT;
  const period = paper.history.filter(h => h.closedT >= since);
  const byType = {};
  for (const h of period) { const b = byType[h.type] || (byType[h.type] = { n: 0, win: 0, pnl: 0, R: 0 }); b.n++; b.pnl += h.pnl; b.R += h.R; if (h.pnl > 0) b.win++; }
  const totalPnl = period.reduce((s, h) => s + h.pnl, 0), totalR = period.reduce((s, h) => s + h.R, 0);
  const card = { t: now, since, days: +((now - since) / 86400000).toFixed(1), equity: +paper.equity.toFixed(2), closed: period.length, totalPnl: +totalPnl.toFixed(2), totalR: +totalR.toFixed(2), byType, disabled: paper.disabledEdges || [] };
  try { fs.appendFileSync(SCORECARD_FILE, JSON.stringify(card) + '\n'); } catch (e) { }
  const parts = Object.entries(byType).map(([t, b]) => `${t}:${b.R.toFixed(1)}R(${b.n}件${Math.round(100 * b.win / b.n)}%)`).join(' ');
  console.log(`[SCORECARD] ${card.days}日 equity$${card.equity} 決済${card.closed} 計${card.totalR}R | ${parts || 'トレードなし'}`);
  notify(`週次成績 ${card.totalR >= 0 ? '+' : ''}${card.totalR}R ($${card.totalPnl}) 決済${card.closed}件 → equity$${card.equity}`, 'CRYPTO AGENT X 週次');
  paper.lastScorecardT = now; savePaper();
}

function updateActiveModels(scan) {
  const best = {};
  scan.results.filter(r => r.pass).forEach(r => { if (!best[r.sym] || r.test.exp > best[r.sym].test.exp) best[r.sym] = { tf: r.tf, params: r.params, test: r.test }; });
  activeModels = best;
}
function initActiveModels() {
  try { const lines = fs.readFileSync(EDGE_FILE, 'utf8').split('\n').filter(Boolean); if (lines.length) updateActiveModels(JSON.parse(lines[lines.length - 1])); } catch (e) { }
}
function closePaper(pos, exit, reason) {
  const dm = pos.dir === 'long' ? 1 : -1;
  const gross = (exit - pos.entry) * pos.size * dm;
  const fee = (pos.entry + exit) * pos.size * COST_RATE;   // 往復手数料+スリッページ
  const pnl = gross - fee;
  const risk$ = pos.size * Math.abs(pos.entry - pos.sl);
  const R = risk$ ? pnl / risk$ : 0;                        // 手数料控除後のR
  paper.equity += pnl;
  paper.history.unshift({ sym: pos.sym, dir: pos.dir, type: pos.type, tf: pos.tf, entry: pos.entry, exit, pnl: +pnl.toFixed(2), fee: +fee.toFixed(2), R: +R.toFixed(2), reason, openedT: pos.openedT, closedT: Date.now() });
  if (paper.history.length > 200) paper.history.pop();
  paper.positions = paper.positions.filter(p => p.id !== pos.id);
  console.log(`[PAPER] CLOSE ${pos.sym} ${reason} net ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (fee ${fee.toFixed(2)}, ${R.toFixed(2)}R) → equity $${paper.equity.toFixed(0)}`);
}
async function managePaper() {
  // 全ユニバースの現在値を1回で取得
  let prices = {};
  try { (await getJSON(`${BF}/fapi/v1/ticker/price`)).forEach(x => { prices[x.symbol] = +x.price; }); } catch (e) { return; }
  const bnOf = sym => (UNIVERSE.find(u => u.sym === sym) || {}).bn;
  lastPrices = prices;
  // ポートフォリオ状態: 評価額・ピーク・ドローダウンでサーキットブレーカー判定
  const unrl0 = paper.positions.reduce((s, p) => { const px = prices[bnOf(p.sym)] || p.entry; return s + (px - p.entry) * p.size * (p.dir === 'long' ? 1 : -1); }, 0);
  const evalV = paper.equity + unrl0;
  paper.peakEval = Math.max(paper.peakEval || paper.start, evalV);
  const ddPct = (paper.peakEval - evalV) / paper.peakEval * 100;
  const halted = ddPct >= MAX_DD_HALT;
  if (halted && !paper._wasHalted) console.log(`[RISK] サーキットブレーカー作動: DD ${ddPct.toFixed(1)}% ≥ ${MAX_DD_HALT}% → 新規停止`);
  paper._wasHalted = halted;
  // 1) 保有ポジ監視（戦略種別ごとに決済ロジックを分岐）
  for (const pos of [...paper.positions]) {
    const px = prices[bnOf(pos.sym)]; if (!px) continue;
    const long = pos.dir === 'long';
    if (pos.closeAt && Date.now() >= pos.closeAt) { closePaper(pos, px, '時間決済'); continue; } // 全種別共通の時間決済バックストップ(funding系24bar/calendar)
    if (pos.type === 'mr') {                              // 逆張り: 平均(EMA10)回帰で利確 / ATRで損切り
      let ema10 = null;
      try { const rows = await klines(bnOf(pos.sym), pos.tf, 260); ema10 = S.ema(rows.map(r => r.c), 10).slice(-1)[0]; } catch (e) { }
      if (long) { if (px <= pos.sl) closePaper(pos, pos.sl, 'SL'); else if (ema10 && px >= ema10) closePaper(pos, px, '平均回帰'); }
      else { if (px >= pos.sl) closePaper(pos, pos.sl, 'SL'); else if (ema10 && px <= ema10) closePaper(pos, px, '平均回帰'); }
    } else if (pos.exit === 'trail') {                   // 順張り: ATRトレーリング
      if (long) { pos.extreme = Math.max(pos.extreme, px); pos.sl = Math.max(pos.sl, pos.extreme - pos.trailAtr * pos.atr); if (px <= pos.sl) closePaper(pos, pos.sl, 'トレール'); }
      else { pos.extreme = Math.min(pos.extreme, px); pos.sl = Math.min(pos.sl, pos.extreme + pos.trailAtr * pos.atr); if (px >= pos.sl) closePaper(pos, pos.sl, 'トレール'); }
    } else if (pos.exit === 'time') {                    // カレンダー: 時間決済＋保護SL
      if (long) { if (px <= pos.sl) closePaper(pos, pos.sl, 'SL'); }
      else { if (px >= pos.sl) closePaper(pos, pos.sl, 'SL'); }
      if (paper.positions.find(p => p.id === pos.id) && pos.closeAt && Date.now() >= pos.closeAt) closePaper(pos, px, '時間決済');
    } else {                                             // 順張り: 固定RR
      if (long) { if (px <= pos.sl) closePaper(pos, pos.sl, 'SL'); else if (px >= pos.tp) closePaper(pos, pos.tp, 'TP'); }
      else { if (px >= pos.sl) closePaper(pos, pos.sl, 'SL'); else if (px <= pos.tp) closePaper(pos, pos.tp, 'TP'); }
    }
  }
  evaluateEdgeHealth();   // ★A: 負けが続くエッジを自動キル(新規エントリー前に評価)
  // 2) 新規エントリー探索（★旧trend/mrエッジ = LEGACY_EDGESで停止中）
  if (LEGACY_EDGES) for (const c of UNIVERSE) {
    if (halted) break;                                    // サーキットブレーカー中は新規なし
    if (paper.positions.length >= MAX_OPEN) break;        // 同時保有上限
    const m = activeModels[c.sym]; if (!m) continue;
    if (paper.positions.find(p => p.sym === c.sym)) continue;
    let rows; try { rows = await klines(c.bn, m.tf, 260); } catch (e) { continue; }
    const ind = S.indicators(rows, m.params);
    const i = rows.length - 2;                            // 確定足
    const sig = S.signalFor(m.params.type)(rows, i, ind, m.params);
    if (!sig || sig.conf < PAPER_CONF_MIN) continue;
    if (paper.positions.filter(p => p.dir === sig.dir).length >= MAX_PER_DIR) continue; // 同方向の偏りを抑制
    // モメンタム・ガード: 短期(4h EMA21>50=上昇)に逆らうショート新規を禁止（踏み上げ回避）。
    // 逆に4h下降に逆らうロング新規も禁止。今回の"上昇相場でショート乱発→全敗"の再発防止。
    try {
      const c4 = m.tf === '4h' ? rows : await klines(c.bn, '4h', 120);
      const c4cl = c4.map(r => r.c); const e21 = S.ema(c4cl, 21).at(-1), e50 = S.ema(c4cl, 50).at(-1);
      if (e21 != null && e50 != null) {
        const shortTermUp = e21 > e50;
        if (sig.dir === 'short' && shortTermUp) continue;   // 上昇中のショート禁止
        if (sig.dir === 'long' && !shortTermUp) continue;   // 下降中のロング禁止
      }
    } catch (e) { }
    if (m.params.useHTF && m.tf !== '1d') {               // 上位足コンフルエンス（採用モデルのみ）
      try { const daily = await klines(c.bn, '1d', 400); const reg = S.buildHTF(rows, daily)[i];
        if (reg != null && ((sig.dir === 'long' && !reg) || (sig.dir === 'short' && reg))) continue; } catch (e) { }
    }
    if (paper.lastSignalT[c.sym] === rows[i].t) continue;
    const price = prices[c.bn] || sig.price;
    const risk = m.params.slAtr * sig.atr;
    const sl = sig.dir === 'long' ? price - risk : price + risk;
    const tp = m.params.type === 'mr' ? null : (sig.dir === 'long' ? price + m.params.rr * risk : price - m.params.rr * risk);
    const size = (paper.equity * PAPER_RISK) / Math.abs(price - sl);
    paper.positions.push({ id: 's' + Date.now() + c.sym, sym: c.sym, dir: sig.dir, type: m.params.type, tf: m.tf, entry: price, sl, tp, size, conf: sig.conf, exit: m.params.exit || null, atr: sig.atr, trailAtr: m.params.trailAtr || m.params.slAtr, extreme: price, openedT: Date.now() });
    paper.lastSignalT[c.sym] = rows[i].t;
    console.log(`[PAPER] OPEN ${c.sym} ${sig.dir} ${m.params.type} ${m.tf} @$${price.toFixed(4)} SL$${sl.toFixed(4)} ${tp ? 'TP$' + tp.toFixed(4) : '(平均回帰)'} conf${sig.conf}`);
  }
  // 2.5) Funding系エッジ（検証済み・ウォークフォワードBTC4/4黒字）。逆張りなのでモメンタムガード免除
  // ★2026-08-07 実績選別: fundcum(-3.04R/勝率20%)・fstreak(-4.80R/勝率17%)を停止。勝ち頭funding(+7.17R/勝率78%)と未判定のcalendar/mr_rsi2は継続。
  if (!halted) {   // ★A: edgeLive()で自動キル済みエッジは新規スキップ
    if (edgeLive('funding')) { try { await tryFundingEdge(prices); } catch (e) { } }
    if (edgeLive('calendar')) { try { await tryThursdayShort(prices); } catch (e) { } }
    if (edgeLive('mr_rsi2')) { try { await tryMrRsi2(prices); } catch (e) { } }
  }
  // 2.6) Trend系エッジ（順張り・fundingと無相関=分散効果）。頑健3種(XTZ12h/ETH1d/ADA12h)＋★B自動昇格分。
  if (!halted && LEGACY_EDGES === false && edgeLive('trend')) for (const c of UNIVERSE) {
    const wlTf = trendTargetTf(c.sym); if (!wlTf) continue;
    if (paper.positions.length >= MAX_OPEN) break;
    if (paper.positions.find(p => p.sym === c.sym)) continue;
    const m = activeModels[c.sym]; if (!m) continue;
    if (m.params.type !== 'trend' || m.tf !== wlTf) continue;   // 検証済trend×指定tfに厳密一致した時のみ
    let rows; try { rows = await klines(c.bn, m.tf, 260); } catch (e) { continue; }
    const ind = S.indicators(rows, m.params);
    const i = rows.length - 2;
    const sig = S.signalFor(m.params.type)(rows, i, ind, m.params);
    if (!sig || sig.conf < PAPER_CONF_MIN) continue;
    if (paper.positions.filter(p => p.dir === sig.dir).length >= MAX_PER_DIR) continue;
    try {                                                        // モメンタムガード(4h EMA21/50)
      const c4 = m.tf === '4h' ? rows : await klines(c.bn, '4h', 120);
      const c4cl = c4.map(r => r.c); const e21 = S.ema(c4cl, 21).at(-1), e50 = S.ema(c4cl, 50).at(-1);
      if (e21 != null && e50 != null) { const up = e21 > e50; if (sig.dir === 'short' && up) continue; if (sig.dir === 'long' && !up) continue; }
    } catch (e) { }
    if (m.params.useHTF && m.tf !== '1d') {                      // 上位足コンフルエンス
      try { const daily = await klines(c.bn, '1d', 400); const reg = S.buildHTF(rows, daily)[i];
        if (reg != null && ((sig.dir === 'long' && !reg) || (sig.dir === 'short' && reg))) continue; } catch (e) { }
    }
    if (paper.lastSignalT['TREND_' + c.sym] === rows[i].t) continue;
    const price = prices[c.bn] || sig.price;
    const risk = m.params.slAtr * sig.atr;
    const sl = sig.dir === 'long' ? price - risk : price + risk;
    const tp = sig.dir === 'long' ? price + m.params.rr * risk : price - m.params.rr * risk;
    const size = (paper.equity * PAPER_RISK) / Math.abs(price - sl);
    paper.positions.push({ id: 'tr' + Date.now() + c.sym, sym: c.sym, dir: sig.dir, type: 'trend', tf: m.tf, entry: price, sl, tp, size, conf: sig.conf, exit: m.params.exit || 'rr', atr: sig.atr, trailAtr: m.params.trailAtr || m.params.slAtr, extreme: price, openedT: Date.now() });
    paper.lastSignalT['TREND_' + c.sym] = rows[i].t;
    console.log(`[PAPER] OPEN TREND ${c.sym} ${sig.dir} ${m.tf} @$${price.toFixed(4)} SL$${sl.toFixed(4)} TP$${tp.toFixed(4)} conf${sig.conf}`);
  }
  // 3) 投げ売り逆張り買い（dip・★LEGACY_EDGESで停止中・未検証の旧エッジ）
  const fng = LEGACY_EDGES ? await getFng() : null;
  if (LEGACY_EDGES && !halted && fng != null && fng <= 25) {
    for (const c of UNIVERSE) {
      if (paper.positions.length >= MAX_OPEN) break;
      if (paper.positions.filter(p => p.dir === 'long').length >= MAX_PER_DIR) break;
      if (paper.positions.find(p => p.sym === c.sym)) continue;
      let rows; try { rows = await klines(c.bn, '4h', 300); } catch (e) { continue; }
      const cl = rows.map(r => r.c), r14 = S.rsi(cl, 14), atrArr = S.atr(rows, 14), i = rows.length - 2;
      if (r14[i] == null || r14[i] >= 30) continue;                 // 深い売られ過ぎのみ
      if (paper.lastSignalT['DIP_' + c.sym] === rows[i].t) continue;
      const a = atrArr[i], price = prices[c.bn] || cl[i];
      const sl = price - 1.5 * a, tp = price + 1.5 * 1.5 * a;        // 逆張り RR1.5
      const size = (paper.equity * PAPER_RISK) / Math.abs(price - sl);
      paper.positions.push({ id: 'd' + Date.now() + c.sym, sym: c.sym, dir: 'long', type: 'dip', tf: '4h', entry: price, sl, tp, size, conf: 0, exit: 'rr', atr: a, trailAtr: 1.5, extreme: price, openedT: Date.now() });
      paper.lastSignalT['DIP_' + c.sym] = rows[i].t;
      console.log(`[PAPER] OPEN DIP-LONG ${c.sym} @$${price.toFixed(4)} (RSI14 ${r14[i].toFixed(0)}, F&G ${fng}) SL$${sl.toFixed(4)} TP$${tp.toFixed(4)}`);
    }
  }
  savePaper();
}
/* ============================================================
   FUNDING-EXTREME EDGE — 検証済みエッジ（ウォークフォワード4/4黒字）
   Fundingが極端(上位20%=ロング過熱→ショート / 下位20%→ロング)で逆張り。
   166日・複数地合いで頑健。8h ATR stop / RR1.5。モメンタムガードは免除(意図的な逆張り)。
   ============================================================ */
// Funding極値フェード対象（WF検証済）。rr=銘柄別に最適化した利確倍率（RR2.5でBTC/ETH/XRPは期待値ほぼ倍、DOTのみ1.5維持）
const FUNDING_SYMS = [
  // ★RR最適化: BTC/ETHはRR3.0(大型は平均回帰が深い)、他RR2.5(DOT1.5)。
  // ★2026-08-07 純化: live完全一致(short限定/70-30/trend一致/24bar/手数料0.16%)・333日・前半後半分割で再検証。
  //   「全期間exp>0.05 かつ 直近後半exp>0(=今も生きてる)」の7銘柄に絞込。除外=XTZ(直近-0.34へ減衰)/LINK(全滅-0.48)/LTC・SUI・ADA(全期間で稼げず)。
  { sym: 'BTC', bn: 'BTCUSDT', rr: 3.0 }, { sym: 'ETH', bn: 'ETHUSDT', rr: 3.0 }, { sym: 'XRP', bn: 'XRPUSDT', rr: 2.5 }, { sym: 'DOT', bn: 'DOTUSDT', rr: 1.5 },
  { sym: 'SOL', bn: 'SOLUSDT', rr: 2.5 }, { sym: 'DOGE', bn: 'DOGEUSDT', rr: 2.5 }, { sym: 'ATOM', bn: 'ATOMUSDT', rr: 2.5 },
];
// Funding連続ストリーク対象（WF黒字銘柄のみ・DOTは不合格で除外）: BTC/ETH/XRP
const FUNDING_STREAK_SYMS = [{ sym: 'BTC', bn: 'BTCUSDT' }, { sym: 'ETH', bn: 'ETHUSDT' }, { sym: 'XRP', bn: 'XRPUSDT' }, { sym: 'LTC', bn: 'LTCUSDT' }, { sym: 'SUI', bn: 'SUIUSDT' }];
const fundCache = {};   // bn -> {t, hist}
async function fundingSignal(bn) {
  let c = fundCache[bn];
  if (!c || Date.now() - c.t > 1800000) {   // 30分キャッシュ（fundingは8h毎）
    try { const h = await getJSON(`${BF}/fapi/v1/fundingRate?symbol=${bn}&limit=500`); fundCache[bn] = c = { t: Date.now(), hist: h.map(x => ({ ft: x.fundingTime, f: +x.fundingRate * 100 })) }; }
    catch (e) { return null; }
  }
  const arr = c.hist.map(x => x.f); if (arr.length < 100) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  // ★閾値を80/20→70/30に緩和(2026-07-08): GMO実コスト込WF検証で上位70%でもexp0.51(pos4/4)維持、取引数+61%・総R+57%(300→472R)。回数UPで複利効きやすく。※ショート枠が埋まる時間は増えDDやや膨らみ得る(同方向上限4は不変)
  const hi = sorted[Math.floor(sorted.length * 0.7)], lo = sorted[Math.floor(sorted.length * 0.3)];
  const latest = c.hist[c.hist.length - 1];
  let dir = 0; if (latest.f >= hi) dir = -1; else if (latest.f <= lo) dir = 1; else return null;
  return { dir, fund: latest.f, hi, lo, fundingTime: latest.ft };
}
// Funding連続ストリーク: 同符号が4回以上連続した末に逆張り（ショートが払い続けた底/ロングが払い続けた天井）。BTC WF4/4黒字
async function fundingStreakSignal(bn) {
  let c = fundCache[bn];
  if (!c || Date.now() - c.t > 1800000) { try { const h = await getJSON(`${BF}/fapi/v1/fundingRate?symbol=${bn}&limit=500`); fundCache[bn] = c = { t: Date.now(), hist: h.map(x => ({ ft: x.fundingTime, f: +x.fundingRate * 100 })) }; } catch (e) { return null; } }
  const h = c.hist; if (h.length < 10) return null;
  let streak = 1; const lastSign = Math.sign(h[h.length - 1].f);
  if (lastSign === 0) return null;
  for (let i = h.length - 2; i >= 0; i--) { if (Math.sign(h[i].f) === lastSign) streak++; else break; }
  if (streak < 4) return null;
  return { dir: lastSign < 0 ? 1 : -1, streak, fundingTime: h[h.length - 1].ft };  // マイナス連続→ロング
}
async function tryFundingStreak(prices) {
  for (const c of FUNDING_STREAK_SYMS.concat(promoted.fstreak)) {   // 実装済み + 自動昇格された銘柄
    if (paper.positions.length >= MAX_OPEN) break;
    if (paper.positions.find(p => p.sym === c.sym)) continue;   // 1銘柄1ポジ（極値エッジと重複しない）
    const sig = await fundingStreakSignal(c.bn); if (!sig) continue;
    if (sig.dir === 1) continue;   // ★ショート側のみ: funding fadeのロング側は検証で一貫負け(非対称性/レジーム/コンフルall -EV)。検証済ロングはmr_rsi2に委ねる
    if (paper.positions.filter(p => p.dir === (sig.dir === 1 ? 'long' : 'short')).length >= MAX_PER_DIR) continue;
    if (paper.lastSignalT['FSTREAK_' + c.sym] === sig.fundingTime) continue;
    let rows; try { rows = await klines(c.bn, '8h', 60); } catch (e) { continue; }
    const a = S.atr(rows, 14).slice(-1)[0]; if (!a) continue;
    const price = prices[c.bn] || rows[rows.length - 1].c;
    // ★RR最適化(6銘柄プール検証): RR1.5→2.5でプールexp0.21→0.33、全銘柄で改善(BTC0.41→0.55,ETH0.26→0.46,XRP0.16→0.33単調増加)=fundext同様「funding平均回帰は深く戻る」
    const FSTREAK_RR = 2.5, risk = 1.5 * a, sl = sig.dir === 1 ? price - risk : price + risk, tp = sig.dir === 1 ? price + FSTREAK_RR * risk : price - FSTREAK_RR * risk;
    const size = (paper.equity * PAPER_RISK) / Math.abs(price - sl);
    paper.positions.push({ id: 'fs' + Date.now() + c.sym, sym: c.sym, dir: sig.dir === 1 ? 'long' : 'short', type: 'fstreak', tf: '8h', entry: price, sl, tp, size, conf: 0, exit: 'rr', atr: a, trailAtr: 1.5, extreme: price, openedT: Date.now(), closeAt: Date.now() + FUND_MAXHOLD_MS });
    paper.lastSignalT['FSTREAK_' + c.sym] = sig.fundingTime;
    console.log(`[PAPER] OPEN FUNDING-STREAK ${c.sym} ${sig.dir === 1 ? 'long' : 'short'} @$${price.toFixed(2)} (${sig.streak}連続) SL$${sl.toFixed(2)} TP$${tp.toFixed(2)}`);
  }
}
// 曜日カレンダーエッジ（WF検証済）: wday曜日00:00 UTC付近にdir方向、約24h後に時間決済＋ATR保護stop
// 木曜ショート: RR型決済(SL1.5ATR/TP=RR1.5)で独立WF再検証合格=BTC(exp0.31 WF4/4均一)/ETH(0.32)/XRP(0.21)/ADA(0.18)/DOGE(0.22)。
// ※旧・時間決済型は exp0.12 と弱かった(検証はRR型)=検証と実装の不一致を是正。LINKはpos2/4で棄却。火曜ロング=ETH(WF3/4)。
const CALENDAR_EDGES = [
  { sym: 'BTC', bn: 'BTCUSDT', wday: 4, dir: 'short', rr: 1.5 }, { sym: 'ETH', bn: 'ETHUSDT', wday: 4, dir: 'short', rr: 1.5 },
  { sym: 'XRP', bn: 'XRPUSDT', wday: 4, dir: 'short', rr: 1.5 }, { sym: 'ADA', bn: 'ADAUSDT', wday: 4, dir: 'short', rr: 1.5 },
  { sym: 'DOGE', bn: 'DOGEUSDT', wday: 4, dir: 'short', rr: 1.5 },
  { sym: 'ETH', bn: 'ETHUSDT', wday: 2, dir: 'long', rr: 1.5 },
];
async function tryThursdayShort(prices) {
  const now = new Date();
  if (now.getUTCHours() >= 3) return;   // 各曜日0-3時UTCの窓でのみ発動
  for (const c of CALENDAR_EDGES) {
    if (now.getUTCDay() !== c.wday) continue;
    if (paper.positions.length >= MAX_OPEN) break;
    if (paper.positions.find(p => p.sym === c.sym)) continue;
    if (paper.positions.filter(p => p.dir === c.dir).length >= MAX_PER_DIR) continue;
    const dayKey = 'CAL_' + c.sym + '_' + c.wday + c.dir + '_' + now.getUTCFullYear() + '-' + now.getUTCMonth() + '-' + now.getUTCDate();
    if (paper.lastSignalT[dayKey]) continue;   // 同じ日で1回のみ
    let rows; try { rows = await klines(c.bn, '8h', 60); } catch (e) { continue; }
    const a = S.atr(rows, 14).slice(-1)[0]; if (!a) continue;
    const price = prices[c.bn] || rows[rows.length - 1].c;
    const rr = c.rr || 1.5, risk = 1.5 * a;                            // 検証済みRR型: SL1.5ATR/TP=RR*risk
    const sl = c.dir === 'short' ? price + risk : price - risk;
    const tp = c.dir === 'short' ? price - rr * risk : price + rr * risk;
    const size = (paper.equity * PAPER_RISK) / Math.abs(price - sl);
    paper.positions.push({ id: 'th' + Date.now() + c.sym, sym: c.sym, dir: c.dir, type: 'calendar', tf: '8h', entry: price, sl, tp, size, conf: 0, exit: 'rr', atr: a, trailAtr: 1.5, extreme: price, openedT: Date.now(), closeAt: Date.now() + FUND_MAXHOLD_MS });
    paper.lastSignalT[dayKey] = Date.now();
    console.log(`[PAPER] OPEN CALENDAR ${c.sym} ${c.dir} (${['日', '月', '火', '水', '木', '金', '土'][c.wday]}曜) @$${price.toFixed(2)} (24h時間決済 / 保護SL$${sl.toFixed(2)})`);
  }
}
// 逆張りMR(日足RSI2): RSI2<5 & 価格>EMA200 → ロング / RSI2>95 & <EMA200 → ショート。RR1.5/SL1.5ATR。
// 実装条件で独立WF再検証合格: LINK(exp0.31 WF4/4完全均一)/BTC(0.44)/SUI(0.28)/BCH(0.28)。※研究ラボ提案のSOLはpos2/4で棄却。
// 日足=8h系と別サイクル+RSI2<5はロング=ショート偏重への方向分散に寄与。
const MR_RSI2_SYMS = [
  { sym: 'LINK', bn: 'LINKUSDT' }, { sym: 'BTC', bn: 'BTCUSDT' }, { sym: 'SUI', bn: 'SUIUSDT' }, { sym: 'BCH', bn: 'BCHUSDT' },
];
async function tryMrRsi2(prices) {
  const dayTag = new Date().toISOString().slice(0, 10);
  for (const c of MR_RSI2_SYMS) {
    if (paper.positions.length >= MAX_OPEN) break;
    if (paper.positions.find(p => p.sym === c.sym)) continue;
    let rows; try { rows = await klines(c.bn, '1d', 260); } catch (e) { continue; }
    const cl = rows.map(r => r.c), r2 = S.rsi(cl, 2), e200 = S.ema(cl, 200);
    const i = cl.length - 1; if (r2[i] == null || e200[i] == null) continue;
    let dir = 0; if (r2[i] < 5 && cl[i] > e200[i]) dir = 1; else if (r2[i] > 95 && cl[i] < e200[i]) dir = -1;
    if (!dir) continue;
    if (paper.positions.filter(p => p.dir === (dir === 1 ? 'long' : 'short')).length >= MAX_PER_DIR) continue;
    const dayKey = 'MRR_' + c.sym + '_' + dayTag;
    if (paper.lastSignalT[dayKey]) continue;   // 同じ日足バーで1回のみ
    const a = S.atr(rows, 14).slice(-1)[0]; if (!a) continue;
    const price = prices[c.bn] || cl[i], risk = 1.5 * a;
    const sl = dir === 1 ? price - risk : price + risk, tp = dir === 1 ? price + 1.5 * risk : price - 1.5 * risk;
    const size = (paper.equity * PAPER_RISK) / Math.abs(price - sl);
    paper.positions.push({ id: 'mr2' + Date.now() + c.sym, sym: c.sym, dir: dir === 1 ? 'long' : 'short', type: 'mr_rsi2', tf: '1d', entry: price, sl, tp, size, conf: 0, exit: 'rr', atr: a, trailAtr: 1.5, extreme: price, openedT: Date.now(), closeAt: Date.now() + 20 * 24 * 3600 * 1000 });
    paper.lastSignalT[dayKey] = Date.now();
    console.log(`[PAPER] OPEN MR_RSI2 ${c.sym} ${dir === 1 ? 'long' : 'short'} @$${price.toFixed(4)} (RSI2=${r2[i].toFixed(0)} / SL$${sl.toFixed(4)} TP$${tp.toFixed(4)})`);
  }
}
// 累積Funding圧（直近48h=6期間のfunding合計が極値→逆張り）。BTC WF4/4・勝62%で最高品質
// ★RR銘柄別最適化: BTC/ETH/XRPはRR2.0→3.0で単調増加(BTC0.84→1.04/ETH1.06→1.49/XRP0.42→0.67,pos3-4/4)=大型は深く戻る→rr3.0。LINKは高RRで悪化(0.22→0.06)/SUI/LTCは2.5維持。
const FUNDING_CUM_SYMS = [
  { sym: 'BTC', bn: 'BTCUSDT', rr: 3.0 }, { sym: 'ETH', bn: 'ETHUSDT', rr: 3.0 },
  // 48h累積Funding圧が他銘柄でも検証合格（XRP+1.20R/LINK+0.62R WF4/4/SUI+0.71R/LTC+0.26R）
  { sym: 'XRP', bn: 'XRPUSDT', rr: 3.0 }, { sym: 'LINK', bn: 'LINKUSDT', rr: 2.5 }, { sym: 'SUI', bn: 'SUIUSDT', rr: 2.5 }, { sym: 'LTC', bn: 'LTCUSDT', rr: 2.5 },
];
async function fundingCumSignal(bn) {
  let c = fundCache[bn];
  if (!c || Date.now() - c.t > 1800000) { try { const h = await getJSON(`${BF}/fapi/v1/fundingRate?symbol=${bn}&limit=500`); fundCache[bn] = c = { t: Date.now(), hist: h.map(x => ({ ft: x.fundingTime, f: +x.fundingRate * 100 })) }; } catch (e) { return null; } }
  const h = c.hist; if (h.length < 100) return null;
  const CUM_W = 9;   // ★ルックバック最適化(プール検証): 3/6/9/12期間で9期間(72h)がexp0.725でピーク(山型・過学習でない)。旧48h(6期間)0.674から改善
  const cum = [];
  for (let i = CUM_W; i < h.length; i++) { let s = 0; for (let k = i - CUM_W; k < i; k++) s += h[k].f; cum.push(s); }
  const sorted = [...cum].sort((a, b) => a - b), hi = sorted[Math.floor(sorted.length * 0.8)], lo = sorted[Math.floor(sorted.length * 0.2)];
  const latest = cum[cum.length - 1];
  let dir = 0; if (latest >= hi) dir = -1; else if (latest <= lo) dir = 1; else return null;
  return { dir, cum: latest, fundingTime: h[h.length - 1].ft };
}
// ★アンサンブル投票: fundext/fstreak/fundcum のうち dir方向に一致するシグナル数(全てfundCache利用・追加APIコール無し)
// プール検証: 1票exp0.22→2票0.63(pos4/4均一)→3票0.76(但し直近窓マイナス)。2票以上=頑健な高確度としてサイズUP、3票への過剰張りはしない(1.5倍据置)
async function fundingVotes(bn, dir) {
  let v = 0;
  const e = await fundingSignal(bn); if (e && e.dir === dir) v++;
  const s = await fundingStreakSignal(bn); if (s && s.dir === dir) v++;
  const c = await fundingCumSignal(bn); if (c && c.dir === dir) v++;
  return v;
}
// ★エッジ発火レーダー: 1銘柄の全funding指標(百分位/極値/ストリーク/累積/投票)を常時返す(極値でなくても状態を出す)。裁量ダッシュボード用。
async function fundingRadar(bn) {
  let c = fundCache[bn];
  if (!c || Date.now() - c.t > 1800000) { try { const h = await getJSON(`${BF}/fapi/v1/fundingRate?symbol=${bn}&limit=500`); fundCache[bn] = c = { t: Date.now(), hist: h.map(x => ({ ft: x.fundingTime, f: +x.fundingRate * 100 })) }; } catch (e) { return null; } }
  const h = c.hist; if (h.length < 100) return null;
  const arr = h.map(x => x.f), sorted = [...arr].sort((a, b) => a - b);
  const hi = sorted[Math.floor(sorted.length * 0.7)], lo = sorted[Math.floor(sorted.length * 0.3)];   // fundextと同じ70/30に統一(コックピット表示整合)
  const latest = h[h.length - 1].f;
  let below = 0; for (const v of arr) if (v < latest) below++;
  const pct = Math.round(below / arr.length * 100);
  let extreme = 0; if (latest >= hi) extreme = -1; else if (latest <= lo) extreme = 1;   // 高funding→ショート(-1)/低→ロング(+1)
  let streak = 1; const lastSign = Math.sign(latest);
  for (let i = h.length - 2; i >= 0; i--) { if (Math.sign(h[i].f) === lastSign) streak++; else break; }
  const streakDir = streak >= 4 ? (lastSign < 0 ? 1 : -1) : 0;
  let cum = 0; for (let i = Math.max(0, h.length - 9); i < h.length; i++) cum += h[i].f;
  return { fund: +latest.toFixed(4), pct, hi: +hi.toFixed(4), lo: +lo.toFixed(4), extreme, streak, streakDir, cum: +cum.toFixed(4) };
}
async function tryFundingCumulative(prices) {
  for (const c of FUNDING_CUM_SYMS) {
    if (paper.positions.length >= MAX_OPEN) break;
    if (paper.positions.find(p => p.sym === c.sym)) continue;
    const sig = await fundingCumSignal(c.bn); if (!sig) continue;
    if (sig.dir === 1) continue;   // ★ショート側のみ(fundcumロング側も-EV)
    if (paper.positions.filter(p => p.dir === (sig.dir === 1 ? 'long' : 'short')).length >= MAX_PER_DIR) continue;
    if (paper.lastSignalT['FCUM_' + c.sym] === sig.fundingTime) continue;
    let rows; try { rows = await klines(c.bn, '8h', 60); } catch (e) { continue; }
    const cl = rows.map(r => r.c), e50 = S.ema(cl, 50).slice(-1)[0];
    if (e50 != null) { const trend = cl[cl.length - 1] > e50 ? 1 : -1; if (sig.dir !== trend) continue; }  // トレンド一致
    const a = S.atr(rows, 14).slice(-1)[0]; if (!a) continue;
    const price = prices[c.bn] || cl[cl.length - 1];
    const rr = c.rr || 2.5, risk = 1.5 * a, sl = sig.dir === 1 ? price - risk : price + risk, tp = sig.dir === 1 ? price + rr * risk : price - rr * risk;
    // ★アンサンブル・コンフルエンス: fundext/fstreak/fundcumの投票2票以上=高確度(プール exp0.22→0.63) or 出来高高 でリスク1.5倍
    const votes = await fundingVotes(c.bn, sig.dir);
    const multiConf = votes >= 2;
    const vols = rows.map(r => r.v), volSma = vols.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, vols.length);
    const hiVol = rows[rows.length - 1].v >= volSma;
    const riskPct = (multiConf || hiVol) ? PAPER_RISK * 1.5 : PAPER_RISK;
    const size = (paper.equity * riskPct) / Math.abs(price - sl);
    paper.positions.push({ id: 'fc' + Date.now() + c.sym, sym: c.sym, dir: sig.dir === 1 ? 'long' : 'short', type: 'fundcum', tf: '8h', entry: price, sl, tp, size, conf: multiConf ? votes : (hiVol ? 1 : 0), exit: 'rr', atr: a, trailAtr: 1.5, extreme: price, openedT: Date.now(), closeAt: Date.now() + FUND_MAXHOLD_MS });
    paper.lastSignalT['FCUM_' + c.sym] = sig.fundingTime;
    console.log(`[PAPER] OPEN FUNDING-CUM ${c.sym} ${sig.dir === 1 ? 'long' : 'short'} @$${price.toFixed(2)} (72h累積 ${sig.cum.toFixed(4)}%) SL$${sl.toFixed(2)} TP$${tp.toFixed(2)}`);
  }
}
async function tryFundingEdge(prices) {
  for (const c of FUNDING_SYMS.concat(promoted.fundext)) {   // 実装済み + 自動昇格された銘柄
    if (paper.positions.length >= MAX_OPEN) break;
    if (paper.positions.find(p => p.sym === c.sym)) continue;
    const sig = await fundingSignal(c.bn); if (!sig) continue;
    if (sig.dir === 1) continue;   // ★ショート側のみ(fundextロング側も-EV。検証済ロングはmr_rsi2)
    if (paper.positions.filter(p => p.dir === (sig.dir === 1 ? 'long' : 'short')).length >= MAX_PER_DIR) continue;
    if (paper.lastSignalT['FUND_' + c.sym] === sig.fundingTime) continue;   // 同一funding期間で重複しない
    let rows; try { rows = await klines(c.bn, '8h', 60); } catch (e) { continue; }
    // ★トレンド一致フィルター（WF4/4検証済み・期待値+0.36R→+0.51R）: Fundingフェード方向が8h EMA50トレンドと一致する時のみ
    const cl = rows.map(r => r.c), e50 = S.ema(cl, 50).slice(-1)[0];
    if (e50 != null) { const trend = cl[cl.length - 1] > e50 ? 1 : -1; if (sig.dir !== trend) continue; }
    const a = S.atr(rows, 14).slice(-1)[0]; if (!a) continue;
    const price = prices[c.bn] || rows[rows.length - 1].c;
    const rr = c.rr || 2.5, risk = 1.5 * a, sl = sig.dir === 1 ? price - risk : price + risk, tp = sig.dir === 1 ? price + rr * risk : price - rr * risk;
    // ★アンサンブル・コンフルエンス: fundext/fstreak/fundcumの投票2票以上=高確度(プール exp0.22→0.63) or 出来高高 でリスク1.5倍
    const votes = await fundingVotes(c.bn, sig.dir);   // self(fundext)含め同方向の一致数
    const multiConf = votes >= 2;
    const vols = rows.map(r => r.v), volSma = vols.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, vols.length);
    const hiVol = rows[rows.length - 1].v >= volSma;
    const hiConv = multiConf || hiVol;
    const size = (paper.equity * (hiConv ? PAPER_RISK * 1.5 : PAPER_RISK)) / Math.abs(price - sl);
    paper.positions.push({ id: 'f' + Date.now() + c.sym, sym: c.sym, dir: sig.dir === 1 ? 'long' : 'short', type: 'funding', tf: '8h', entry: price, sl, tp, size, conf: multiConf ? votes : (hiVol ? 1 : 0), exit: 'rr', atr: a, trailAtr: 1.5, extreme: price, openedT: Date.now(), closeAt: Date.now() + FUND_MAXHOLD_MS });
    paper.lastSignalT['FUND_' + c.sym] = sig.fundingTime;
    console.log(`[PAPER] OPEN FUNDING-EDGE ${c.sym} ${sig.dir === 1 ? 'long' : 'short'} @$${price.toFixed(2)} (funding ${sig.fund.toFixed(4)}% 極値) SL$${sl.toFixed(2)} TP$${tp.toFixed(2)}`);
  }
}

function paperStats() {
  const h = paper.history, wins = h.filter(x => x.pnl > 0).length;
  const bnOf = sym => (UNIVERSE.find(u => u.sym === sym) || {}).bn;
  const positions = paper.positions.map(p => {
    const px = lastPrices[bnOf(p.sym)] || p.entry, dm = p.dir === 'long' ? 1 : -1;
    const uPnl = (px - p.entry) * p.size * dm - (p.entry + px) * p.size * COST_RATE;
    return Object.assign({}, p, { price: px, uPnl: +uPnl.toFixed(2) });
  });
  const unrealized = positions.reduce((s, p) => s + p.uPnl, 0);
  const longs = positions.filter(p => p.dir === 'long').length, shorts = positions.length - longs;
  const evalV = paper.equity + unrealized, peak = paper.peakEval || paper.start, ddPct = (peak - evalV) / peak * 100;
  return {
    equity: +paper.equity.toFixed(2), start: paper.start, net: +(paper.equity - paper.start).toFixed(2),
    openCount: positions.length, closed: h.length, wins, winRate: h.length ? +(wins / h.length * 100).toFixed(1) : 0,
    unrealized: +unrealized.toFixed(2), evalValue: +evalV.toFixed(2),
    portfolio: { open: positions.length, longs, shorts, maxOpen: MAX_OPEN, maxPerDir: MAX_PER_DIR, ddPct: +ddPct.toFixed(1), maxDD: MAX_DD_HALT, halted: ddPct >= MAX_DD_HALT },
    disabledEdges: paper.disabledEdges || [], promotedTrend: promoted.trend || [],   // ★A自動キル済 / ★B自動昇格trend
    positions, recent: h.slice(0, 12), models: activeModels,
  };
}

/* ============================================================
   STRUCTURAL EDGE LAB — ポジション"構造"をエッジ化する実験室
   ・大衆L/S偏り / Funding過熱 / OI×価格の乖離 等を検出して記録
   ・24h後の実際の値動きで自動採点（記録済み価格履歴を使う）
   ・データが貯まるほど「どの構造が効くか」が実測で見える
   まだトレード対象ではない（検証フェーズ）。
   ============================================================ */
const STRUCT_FILE = path.join(DATA_DIR, 'structural.jsonl');
const STRUCT_HORIZON_MS = 24 * 3600 * 1000;
const STRUCT_TYPES = {
  crowdedLong_down: '大衆ロング過多×下降トレンド (→ショート)',
  crowdedShort_up: '大衆ショート過多×上昇トレンド (→ロング)',
  fundingHot: 'Funding過熱 (ロング払い→ショート)',
  fundingCold: 'Fundingマイナス過度 (ショート払い→ロング)',
  oiUp_priceDown: 'OI増×価格下落 (新規売り主導→ショート)',
  oiUp_priceUp: 'OI増×価格急伸 (過熱→反落警戒/ショート)',
};
async function detectStructural() {
  let recent = []; try { recent = fs.readFileSync(STRUCT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { }
  const now = Date.now(); const news = [];
  for (const c of COINS) {
    let cl; try { cl = (await klines(c.bn, '1d', 300)).map(r => r.c); } catch (e) { continue; }
    const price = cl[cl.length - 1], ema200 = S.ema(cl, 200)[cl.length - 1];
    const price24 = cl.length > 1 ? (cl[cl.length - 1] - cl[cl.length - 2]) / cl[cl.length - 2] * 100 : 0;
    let oi24 = 0; try { const a = (await getJSON(`${BF}/futures/data/openInterestHist?symbol=${c.bn}&period=1h&limit=25`)).map(o => +o.sumOpenInterestValue); oi24 = a.length > 1 ? (a[a.length - 1] - a[0]) / a[0] * 100 : 0; } catch (e) { }
    const snap = stat.lastSnap[c.sym] || {}; const ls = (snap.ls || {}).acct, fund = (snap.funding || {}).avg;
    const sigs = [];
    if (ls != null && ema200 != null) { if (ls >= 1.6 && price < ema200) sigs.push(['crowdedLong_down', 'short']); if (ls <= 0.85 && price > ema200) sigs.push(['crowdedShort_up', 'long']); }
    if (fund != null) { if (fund >= 0.03) sigs.push(['fundingHot', 'short']); if (fund <= -0.02) sigs.push(['fundingCold', 'long']); }
    if (oi24 >= 5 && price24 < 0) sigs.push(['oiUp_priceDown', 'short']);
    if (oi24 >= 8 && price24 > 3) sigs.push(['oiUp_priceUp', 'short']);
    for (const [type, dir] of sigs) {
      if (recent.some(r => r.sym === c.sym && r.type === type && (now - r.t) < STRUCT_HORIZON_MS)) continue; // 24h内は重複記録しない
      const rec = { t: now, sym: c.sym, type, dir, entry: price, horizonMs: STRUCT_HORIZON_MS, meta: { ls, fund: fund != null ? +fund.toFixed(4) : null, oi24: +oi24.toFixed(1), price24: +price24.toFixed(1) } };
      fs.appendFileSync(STRUCT_FILE, JSON.stringify(rec) + '\n'); news.push(rec); recent.push(rec);
    }
  }
  if (news.length) console.log(`[STRUCT] 構造シグナル検出 ${news.length}件: ` + news.map(x => x.sym + '/' + x.type).join(', '));
}
function priceAt(sym, targetT) {
  let lines; try { lines = fs.readFileSync(fileFor(sym), 'utf8').split('\n').filter(Boolean); } catch (e) { return null; }
  let best = null, bestD = Infinity;
  for (const l of lines) { try { const s = JSON.parse(l); const d = Math.abs(s.t - targetT); if (d < bestD) { bestD = d; best = s; } } catch (e) { } }
  return best && bestD < 3600000 ? best.price : null;   // 目標時刻±1h以内の記録価格
}
function structuralStats() {
  let sigs = []; try { sigs = fs.readFileSync(STRUCT_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { }
  const now = Date.now(), agg = {};
  sigs.forEach(s => {
    const a = agg[s.type] = agg[s.type] || { type: s.type, label: STRUCT_TYPES[s.type] || s.type, matured: 0, wins: 0, sumRet: 0, pending: 0 };
    const matureT = s.t + s.horizonMs;
    if (now >= matureT) { const fp = priceAt(s.sym, matureT); if (fp != null) { const ret = (fp - s.entry) / s.entry * 100 * (s.dir === 'long' ? 1 : -1); a.matured++; if (ret > 0) a.wins++; a.sumRet += ret; } else a.pending++; }
    else a.pending++;
  });
  return {
    horizonH: STRUCT_HORIZON_MS / 3600000, total: sigs.length,
    types: Object.values(agg).map(a => ({ type: a.type, label: a.label, matured: a.matured, pending: a.pending, winRate: a.matured ? +(a.wins / a.matured * 100).toFixed(0) : null, avgRet: a.matured ? +(a.sumRet / a.matured).toFixed(2) : null })),
  };
}

/* ============================================================
   POSITIONING INTELLIGENCE — 群衆ポジショニングの可視化
   リテールL/S・成行フロー・OIレジームを提示し、
   さらに直近データでのフォワードリターン研究を返す（※地合い依存・未検証と明示）。
   ============================================================ */
async function positioning(sym) {
  const bnsym = sym;
  const [retail, taker, oiHist, kl] = await Promise.all([
    getJSON(`${BF}/futures/data/globalLongShortAccountRatio?symbol=${bnsym}&period=1h&limit=500`).catch(() => []),
    getJSON(`${BF}/futures/data/takerlongshortRatio?symbol=${bnsym}&period=1h&limit=500`).catch(() => []),
    getJSON(`${BF}/futures/data/openInterestHist?symbol=${bnsym}&period=1h&limit=500`).catch(() => []),
    getJSON(`${BF}/fapi/v1/klines?symbol=${bnsym}&interval=1h&limit=500`).catch(() => []),
  ]);
  if (!retail.length || !kl.length) return { sym, error: 'no data' };
  const price = {}; kl.forEach(k => price[k[0]] = +k[4]);
  const tk = {}, oiM = {}; taker.forEach(x => tk[x.timestamp] = +x.buySellRatio); oiHist.forEach(x => oiM[x.timestamp] = +x.sumOpenInterestValue);
  const rows = retail.map(x => ({ t: x.timestamp, retail: +x.longShortRatio, taker: tk[x.timestamp], oi: oiM[x.timestamp], px: price[x.timestamp] })).filter(r => r.px);
  if (rows.length < 30) return { sym, error: 'insufficient' };
  const cur = rows[rows.length - 1];
  // 現在のポジショニング状態
  const rs = rows.map(r => r.retail).sort((a, b) => a - b);
  const pct = v => Math.round(rs.filter(x => x <= v).length / rs.length * 100);
  const oiChg6 = cur.oi && rows[rows.length - 7] && rows[rows.length - 7].oi ? (cur.oi - rows[rows.length - 7].oi) / rows[rows.length - 7].oi * 100 : null;
  // フォワードリターン研究（8h先・手数料込0.08%）: レジーム別に多数派followの結果
  const study = [];
  const buckets = { '極端ショート(下位20%)': r => r.retail <= rs[Math.floor(rs.length * 0.2)], '中立': r => r.retail > rs[Math.floor(rs.length * 0.2)] && r.retail < rs[Math.floor(rs.length * 0.8)], '極端ロング(上位20%)': r => r.retail >= rs[Math.floor(rs.length * 0.8)] };
  for (const [label, cond] of Object.entries(buckets)) {
    let n = 0, w = 0, s = 0;
    for (let i = 0; i < rows.length - 8; i++) { if (!cond(rows[i]) || !rows[i].px) continue; const f = (rows[i + 8].px - rows[i].px) / rows[i].px * 100; n++; if (f > 0) w++; s += f; }
    study.push({ regime: label, n, upRate: n ? Math.round(w / n * 100) : null, avgFwd8h: n ? +(s / n).toFixed(2) : null });
  }
  return {
    sym, days: Math.round(rows.length / 24),
    current: { retail: +cur.retail.toFixed(3), retailPct: pct(cur.retail), taker: taker.length ? +(+taker[taker.length - 1].buySellRatio).toFixed(3) : null, oiChg6h: oiChg6 != null ? +oiChg6.toFixed(1) : null, price: cur.px },
    study,
    note: '21日データの後方研究。地合い依存で未検証。トレード根拠ではなく状況把握用。',
  };
}

/* ============================================================
   EDGE RESEARCH LAB — 自律的にエッジを掘り続ける（無指示で常時稼働）
   2時間毎に銘柄をローテしながら仮説を長期データ×損切り利確手数料×WF4分割で検証。
   合格した"未実装"の新エッジをフラグして research-log.jsonl に記録。
   実装（コード反映）は点検時に人手判断で行うが、発見は完全自律。
   ============================================================ */
const RESEARCH_FILE = path.join(DATA_DIR, 'research-log.jsonl');
const RESEARCH_INTERVAL = 2 * 3600 * 1000;
const RESEARCH_UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'DOTUSDT', 'ATOMUSDT', 'BCHUSDT', 'LTCUSDT', 'XTZUSDT'];
// 既に実装済みの(edge,symbol)は再フラグしない
const IMPLEMENTED = new Set([
  'fundext:BTCUSDT', 'fundext:ETHUSDT', 'fundext:XRPUSDT', 'fundext:DOTUSDT',
  'fstreak:BTCUSDT', 'fstreak:ETHUSDT', 'fstreak:XRPUSDT',
  'wd4S:BTCUSDT', 'wd4S:ETHUSDT',   // 木曜ショート（研究エンジンのキー名に一致）
]);
let researchIdx = 0;
const researchFindings = [];   // 直近で発見した合格エッジ候補
// ★自動昇格: 研究ラボがFunding族(fundext/fstreak)の新銘柄を検証合格したら、Claude不要でサーバが自動でトレード対象に追加
const PROMOTED_FILE = path.join(DATA_DIR, 'promoted-edges.json');
let promoted = { fundext: [], fstreak: [], trend: [] };
try { promoted = Object.assign(promoted, JSON.parse(fs.readFileSync(PROMOTED_FILE, 'utf8'))); } catch (e) { }
if (!promoted.trend) promoted.trend = [];   // 旧ファイル互換
function savePromoted() { try { fs.writeFileSync(PROMOTED_FILE, JSON.stringify(promoted)); } catch (e) { } }
function autoPromote(key, r) {
  // key例: 'fundext:ADAUSDT' / 'fstreak:LINKUSDT'。堅牢基準(WF4/4 or 期待値高)のみ自動昇格
  const [edge, bn] = key.split(':');
  if (edge !== 'fundext' && edge !== 'fstreak') return false;      // Funding族のみ自動昇格(実証済みの鉱脈)
  if (r.pos < 4 || r.exp < 0.2 || r.n < 25) return false;          // 自動化は厳しめ基準(全WF黒字・期待+0.2R・n25以上)
  const sym = bn.replace('USDT', '');
  if (promoted[edge].find(x => x.bn === bn) || FUNDING_SYMS.find(x => x.bn === bn) || FUNDING_STREAK_SYMS.find(x => x.bn === bn)) return false;
  promoted[edge].push({ sym, bn, rr: 1.5, promotedAt: Date.now(), exp: r.exp, wf: r.wf }); savePromoted();
  console.log(`[AUTO-PROMOTE] ${key} を自動昇格→ライブトレード対象に追加 (期待+${r.exp}R WF${r.wf.join('/')})`);
  notify(`エッジ自動昇格: ${key} (期待+${r.exp}R)`, 'CRYPTO AGENT X');
  return true;
}

const _atr = (kl, i, p = 14) => { if (i < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) { const pc = kl[k - 1].c; s += Math.max(kl[k].h - kl[k].l, Math.abs(kl[k].h - pc), Math.abs(kl[k].l - pc)); } return s / p; };
function wfBacktest(kl, tradesRaw) {
  // tradesRaw: [{t, R}]  →  WF4分割
  if (!tradesRaw.length) return { n: 0, wr: 0, exp: 0, pos: 0, valid: 0, wf: [] };
  const t0 = tradesRaw[0].t, t1 = tradesRaw[tradesRaw.length - 1].t, span = (t1 - t0) / 4 || 1, wf = [];
  for (let w = 0; w < 4; w++) { const a = t0 + w * span, b = t0 + (w + 1) * span, seg = tradesRaw.filter(x => x.t >= a && x.t < b); const n = seg.length; wf.push({ n, exp: n ? +(seg.reduce((s, x) => s + x.R, 0) / n).toFixed(2) : 0 }); }
  const n = tradesRaw.length, win = tradesRaw.filter(x => x.R > 0).length, exp = tradesRaw.reduce((s, x) => s + x.R, 0) / n;
  return { n, wr: Math.round(win / n * 100), exp: +exp.toFixed(2), pos: wf.filter(r => r.exp > 0 && r.n >= 3).length, valid: wf.filter(r => r.n >= 3).length, wf: wf.map(r => r.exp) };
}
// klinesシグナルを損切り/利確/手数料でトレード化
function simulate(kl, signalFn, rr = 1.5, slA = 1.5) {
  const trades = []; let i = 60;
  while (i < kl.length - 1) {
    const dir = signalFn(kl, i); if (!dir) { i++; continue; }
    const a = _atr(kl, i); if (!a) { i++; continue; }
    const e = kl[i].c, risk = slA * a, sl = dir === 1 ? e - risk : e + risk, tp = dir === 1 ? e + rr * risk : e - rr * risk;
    let o = null, ex = i;
    for (let m = i + 1; m < kl.length; m++) { const c = kl[m]; if (dir === 1) { if (c.l <= sl) { o = -1; ex = m; break; } if (c.h >= tp) { o = rr; ex = m; break; } } else { if (c.h >= sl) { o = -1; ex = m; break; } if (c.l <= tp) { o = rr; ex = m; break; } } }
    if (o == null) break; trades.push({ t: kl[i].t, R: o - 0.08 / (risk / e * 100) }); i = ex + 1;
  }
  return trades;
}
async function researchSymbol(bn) {
  const out = [];
  let k8, k1d, fund;
  try {
    k8 = (await getJSON(`${BF}/fapi/v1/klines?symbol=${bn}&interval=8h&limit=1000`)).map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
    k1d = (await getJSON(`${BF}/fapi/v1/klines?symbol=${bn}&interval=1d&limit=1000`)).map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
    fund = (await getJSON(`${BF}/fapi/v1/fundingRate?symbol=${bn}&limit=500`)).map(x => ({ t: x.fundingTime, f: +x.fundingRate * 100 }));
  } catch (e) { return out; }

  // --- 仮説1: Funding極値+トレンド一致 ---
  if (fund.length > 150) {
    const cl = k8.map(x => x.c), e50 = S.ema(cl, 50);
    const rows = []; for (const fr of fund) { const bar = k8.findIndex(x => x.t <= fr.t && x.t + 8 * 3600000 > fr.t); if (bar >= 0) rows.push({ f: fr.f, idx: bar }); }
    const sorted = rows.map(r => r.f).sort((a, b) => a - b), hi = sorted[Math.floor(sorted.length * 0.8)], lo = sorted[Math.floor(sorted.length * 0.2)];
    const trades = [];
    for (const r of rows) { let dir = 0; if (r.f >= hi) dir = -1; else if (r.f <= lo) dir = 1; else continue; const i = r.idx, a = _atr(k8, i); if (!a || e50[i] == null) continue; if (dir !== (cl[i] > e50[i] ? 1 : -1)) continue; const e = cl[i], risk = 1.5 * a, sl = dir === 1 ? e - risk : e + risk, tp = dir === 1 ? e + 1.5 * risk : e - 1.5 * risk; let o = null; for (let m = i + 1; m < k8.length; m++) { const c = k8[m]; if (dir === 1) { if (c.l <= sl) { o = -1; break; } if (c.h >= tp) { o = 1.5; break; } } else { if (c.h >= sl) { o = -1; break; } if (c.l <= tp) { o = 1.5; break; } } } if (o == null) continue; trades.push({ t: k8[i].t, R: o - 0.08 / (risk / e * 100) }); }
    out.push({ edge: 'fundext', bn, ...wfBacktest(k8, trades) });
  }
  // --- 仮説2: Funding連続ストリーク ---
  if (fund.length > 100) {
    const rows = []; for (const fr of fund) { const bar = k8.findIndex(x => x.t <= fr.t && x.t + 8 * 3600000 > fr.t); if (bar >= 0) rows.push({ f: fr.f, idx: bar, t: fr.t }); }
    const trades = []; let streak = 0, sign = 0;
    for (const r of rows) { const cs = Math.sign(r.f); if (cs === sign) streak++; else { sign = cs; streak = 1; } if (streak >= 4) { const dir = sign < 0 ? 1 : -1, i = r.idx, a = _atr(k8, i); if (!a) continue; const e = k8[i].c, risk = 1.5 * a, sl = dir === 1 ? e - risk : e + risk, tp = dir === 1 ? e + 1.5 * risk : e - 1.5 * risk; let o = null; for (let m = i + 1; m < k8.length; m++) { const c = k8[m]; if (dir === 1) { if (c.l <= sl) { o = -1; break; } if (c.h >= tp) { o = 1.5; break; } } else { if (c.h >= sl) { o = -1; break; } if (c.l <= tp) { o = 1.5; break; } } } if (o == null) continue; trades.push({ t: r.t, R: o - 0.08 / (risk / e * 100) }); streak = 0; } }
    out.push({ edge: 'fstreak', bn, ...wfBacktest(k8, trades) });
  }
  // --- 仮説3: 曜日ショート/ロング（各曜日を実トレード化, 8h×3本保有） ---
  for (const wd of [1, 2, 3, 4, 5]) {
    for (const dir of [1, -1]) {
      const trades = [];
      for (let i = 14; i < k8.length - 3; i++) { const dt = new Date(k8[i].t); if (dt.getUTCDay() !== wd || dt.getUTCHours() !== 0) continue; const e = k8[i].c, x = k8[i + 3].c; trades.push({ t: k8[i].t, R: (x - e) / e / (0.02) * dir - 0.08 }); }
      // R正規化: 2%を1Rと見なす簡易化
      const r = wfBacktest(k8, trades); r.edge = `wd${wd}${dir > 0 ? 'L' : 'S'}`; r.bn = bn; out.push(r);
    }
  }
  // --- 仮説4: 逆張りMR(RSI2) 日足 ---
  {
    const cl = k1d.map(x => x.c), r2 = S.rsi(cl, 2), e200 = S.ema(cl, 200);
    const sig = (kl, i) => { if (r2[i] == null || e200[i] == null) return 0; if (r2[i] < 5 && kl[i].c > e200[i]) return 1; if (r2[i] > 95 && kl[i].c < e200[i]) return -1; return 0; };
    out.push({ edge: 'mr_rsi2', bn, ...wfBacktest(k1d, simulate(k1d, sig, 1.5, 1.5)) });
  }
  return out;
}
async function runResearch() {
  const bn = RESEARCH_UNIVERSE[researchIdx % RESEARCH_UNIVERSE.length]; researchIdx++;
  let results; try { results = await researchSymbol(bn); } catch (e) { return; }
  const stamp = Date.now(); const passers = [];
  for (const r of results) {
    if (!r || !r.n) continue;
    const pass = r.pos >= 3 && r.valid >= 3 && r.exp >= 0.1 && r.n >= 15;
    const key = r.edge + ':' + r.bn;
    if (pass && !IMPLEMENTED.has(key)) { passers.push({ key, edge: r.edge, bn: r.bn, n: r.n, wr: r.wr, exp: r.exp, wf: r.wf }); autoPromote(key, r); }
    fs.appendFileSync(RESEARCH_FILE, JSON.stringify({ t: stamp, key, n: r.n, wr: r.wr, exp: r.exp, pos: r.pos, valid: r.valid, wf: r.wf, pass, implemented: IMPLEMENTED.has(key) }) + '\n');
  }
  if (passers.length) {
    for (const p of passers) { const ex = researchFindings.findIndex(f => f.key === p.key); if (ex >= 0) researchFindings.splice(ex, 1); researchFindings.unshift(Object.assign({ foundAt: stamp }, p)); }
    while (researchFindings.length > 30) researchFindings.pop();
    console.log(`[RESEARCH] ${bn} 検証完了。新エッジ候補 ${passers.length}件: ` + passers.map(p => `${p.key}(${p.exp}R WF${p.wf.join('/')})`).join(', '));
    notify(`新エッジ候補 ${passers.length}件: ${passers.map(p => p.key).join(', ')}`, 'CRYPTO AGENT X 研究');
  } else {
    console.log(`[RESEARCH] ${bn} 検証完了。新規合格なし（累計候補${researchFindings.length}件）`);
  }
}

/* ---------- history read ---------- */
function readHistory(sym, limit) {
  try {
    const lines = fs.readFileSync(fileFor(sym), 'utf8').split('\n').filter(Boolean);
    const slice = limit ? lines.slice(-limit) : lines;
    return slice.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/* ---------- static + api server ---------- */
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (u.pathname === '/api/health') {
    const ageSec = stat.lastTs ? Math.round((Date.now() - stat.lastTs) / 1000) : null;
    return json(res, { ok: ageSec != null && ageSec < 180, lastCycleAgeSec: ageSec, cycles: stat.cycles, uptimeSec: Math.round((Date.now() - stat.started) / 1000) });
  }
  if (u.pathname === '/api/status') {
    return json(res, {
      running: true, uptimeSec: Math.round((Date.now() - stat.started) / 1000),
      cycles: stat.cycles, lastTs: stat.lastTs, errors: stat.errors,
      counts: stat.counts, latest: stat.lastSnap, intervalSec: INTERVAL_MS / 1000,
    });
  }
  if (u.pathname === '/api/history') {
    const sym = (u.searchParams.get('sym') || 'BTC').toUpperCase();
    const limit = parseInt(u.searchParams.get('limit') || '1000', 10);
    return json(res, { sym, count: stat.counts[sym] || 0, data: readHistory(sym, limit) });
  }
  if (u.pathname === '/api/edges') {
    return json(res, { scanCount: stat.scanCount, lastScan: stat.lastScan, readiness: stat.readiness });
  }
  if (u.pathname === '/api/paper') {
    return json(res, paperStats());
  }
  if (u.pathname === '/api/snapshot') {   // ★ポートフォリオ公開用: paper全体＋エクイティ曲線＋エッジ別内訳の静的スナップショット
    return json(res, buildSnapshot());
  }
  if (u.pathname === '/api/structural') {
    return json(res, structuralStats());
  }
  if (u.pathname === '/api/research') {
    return json(res, { findings: researchFindings, promoted, universeIdx: researchIdx, note: '自律エッジ研究ラボが2h毎に検証。findings=候補。promoted=Claude不要でサーバが自動昇格しライブ稼働中のFunding族新銘柄。' });
  }
  if (u.pathname === '/api/positioning') {
    const sym = (u.searchParams.get('sym') || 'BTCUSDT').toUpperCase();
    return positioning(sym).then(r => json(res, r)).catch(e => json(res, { error: e.message }));
  }
  if (u.pathname === '/api/signals') {   // ★エッジ発火レーダー: 全14銘柄のfunding状態+売買方向+確信度。裁量ダッシュボード用。
    return (async () => {
      const out = [];
      for (const co of UNIVERSE) {
        const r = await fundingRadar(co.bn);
        const snap = stat.lastSnap[co.sym] || null;   // BTC/ETH/SOL等は詳細スナップ有り
        if (!r) { out.push({ sym: co.sym, ok: false }); continue; }
        const fadeDir = r.fund >= 0 ? -1 : 1;                          // funding+→ショート/−→ロング
        const votes = await fundingVotes(co.bn, r.extreme || fadeDir);
        let action = 'WATCH', conviction = 0;
        if (r.extreme === -1) { action = 'SELL'; conviction = votes; }   // funding系はショート専業(高funding→売り)。低funding(ロング側)は検証で負け=WATCHのまま表示(負けシグナルを出さない)
        const held = paper.positions.find(p => p.sym === co.sym) || null;
        out.push({
          sym: co.sym, price: snap ? snap.price : null, fund: r.fund, pct: r.pct, extreme: r.extreme,
          streak: r.streak, streakDir: r.streakDir, cum: r.cum, votes, action, conviction,
          ls: snap ? snap.ls : null, oiUsd: snap ? (snap.oiUsd || {}).total : null,
          held: held ? { dir: held.dir, type: held.type, uPnl: null } : null,
        });
      }
      out.sort((a, b) => (b.conviction || 0) - (a.conviction || 0) || (b.votes || 0) - (a.votes || 0));   // 発火強い順
      return json(res, { t: Date.now(), signals: out, note: 'エッジ発火レーダー。action=BUY/SELL(funding極値でfade方向)/WATCH。votes=fundext+fstreak+fundcumの一致数(2以上で高確度)。' });
    })().catch(e => json(res, { error: e.message }));
  }

  // static
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const fp = path.join(WEB_DIR, path.normalize(p));
  if (!fp.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0',
    });
    res.end(data);
  });
});
function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

server.listen(PORT, () => {
  console.log(`\n🚀 CRYPTO AGENT X server → http://localhost:${PORT}`);
  console.log(`   collecting OI/Funding/L-S every ${INTERVAL_MS / 1000}s → ${DATA_DIR}`);
  console.log(`   API: /api/health /api/status /api/paper /api/edges /api/structural\n`);
  notify(`サーバが起動しました (port ${PORT})`);   // 再起動時に通知＝自動復旧に気づける
  cycle();
  setInterval(cycle, INTERVAL_MS);
  computeReadiness();                       // 既存レポートから復元
  initActiveModels();                       // ペーパー用モデルを直近スキャンから復元
  setTimeout(scanEdges, 5000);             // 起動5秒後に初回エッジ探索
  setInterval(scanEdges, SCAN_MS);         // 以降30分毎に自動探索
  setTimeout(runResearch, 20000);          // 起動20秒後に初回エッジ研究
  setInterval(runResearch, RESEARCH_INTERVAL); // 以降2h毎に銘柄ローテで自律研究
  if (!paper.lastScorecardT) { paper.lastScorecardT = Date.now(); savePaper(); }  // ★C: 週次スコアカードの起点
  setInterval(weeklyScorecard, 6 * 3600 * 1000);  // 6h毎に「7日経過したか」を判定し週次成績を集計＋通知
  setTimeout(publishSnapshot, 15000);             // 起動15秒後に初回スナップショット発行
  setInterval(publishSnapshot, 5 * 60 * 1000);    // 以降5分毎にポートフォリオ用スナップショットをGitHubへpush
});
