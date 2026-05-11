// ═══════════════════════════════════════════════════════════════
// QUANTEDGE SERVER — Option B
// Brain lives here. Browser is display only.
//
// What this server does:
//   - Stores Upstox token after /connect
//   - Runs signal engine every 60 seconds
//   - Places real orders directly on Upstox
//   - Manages SL, trail, target every 15 seconds
//   - Writes all logs to trading.log (survives refresh/restart)
//   - Serves current state to browser via GET /state
//   - Continues running even when browser is closed
// ═══════════════════════════════════════════════════════════════

'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const PORT  = process.env.PORT || 3000;
const UPSTOX_HOST = 'api.upstox.com';
const LOG_FILE = path.join(__dirname, 'trading.log');
const LOT = 65;

// ═══════════════════════════════════════════════════════════════
// LOGGING — writes to file AND memory
// ═══════════════════════════════════════════════════════════════

const memLogs = []; // last 200 entries for browser display

function log(msg, level = 'info') {
  const ist  = new Date(Date.now() + 330 * 60000);
  const time = ist.toISOString().slice(0, 19).replace('T', ' ') + ' IST';
  const line = time + ' [' + level.toUpperCase() + '] ' + msg;

  // Write to file (append)
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}

  // Write to console
  console.log(line);

  // Keep in memory for browser
  memLogs.unshift({ time: ist.toISOString().slice(11, 19), msg, level });
  if (memLogs.length > 200) memLogs.pop();
}

// ═══════════════════════════════════════════════════════════════
// SERVER STATE — everything lives here
// ═══════════════════════════════════════════════════════════════

const state = {
  token:       null,
  capital:     0,
  connected:   false,
  running:     false,

  // Market data
  nifty:       0,
  prevNifty:   0,
  todayOpen:   0,
  prevClose:   0,
  candles5m:   [],
  vwap:        0,

  // Trading state
  position:    null,
  lastTrade:   null,
  dailyPnl:    0,
  tradeCount:  0,
  lastLoss:    null,
  inTrade:     false,

  // Signal engine last result
  lastSignal:  null,
  scanIn:      60,

  // Timers
  scanTimer:   null,
  posTimer:    null,
  countTimer:  null,
};

// ═══════════════════════════════════════════════════════════════
// UPSTOX API
// ═══════════════════════════════════════════════════════════════

function upstoxReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function headers(extra = {}) {
  return {
    'Authorization': 'Bearer ' + state.token,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
    'Api-Version':   '2.0',
    ...extra,
  };
}

async function upstox(method, path2, body) {
  const opts = { hostname: UPSTOX_HOST, path: path2, method, headers: headers() };
  if (body) {
    const b = JSON.stringify(body);
    opts.headers['Content-Length'] = Buffer.byteLength(b);
    return upstoxReq(opts, b);
  }
  return upstoxReq(opts);
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL ENGINE
// ═══════════════════════════════════════════════════════════════

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return Math.round(ema * 100) / 100;
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i][2], l = candles[i][3], pc = candles[i-1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length * 100) / 100;
}

function calcVWAP(candles) {
  if (!candles || candles.length === 0) return null;
  let pv = 0, vol = 0;
  for (const c of candles) {
    const tp = (c[2] + c[3] + c[4]) / 3;
    const v  = c[5] || 1;
    pv += tp * v; vol += v;
  }
  return Math.round(pv / vol * 100) / 100;
}

function emaSlope(closes, period) {
  if (closes.length < period + 3) return 'FLAT';
  const e3 = calcEMA(closes, period);
  const e2 = calcEMA(closes.slice(0, -1), period);
  const e1 = calcEMA(closes.slice(0, -2), period);
  if (!e1 || !e2 || !e3) return 'FLAT';
  if (e3 > e2 && e2 > e1) return 'UP';
  if (e3 < e2 && e2 < e1) return 'DOWN';
  return 'FLAT';
}

function istMins() {
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
}

function analyseMarket() {
  const { nifty: spot, todayOpen, prevClose, candles5m, dailyPnl, tradeCount, lastLoss } = state;
  const reasons = [], details = {};

  if (!spot || !todayOpen || !candles5m || candles5m.length < 6)
    return { signal: null, reason: 'Waiting for candles (' + (candles5m?.length || 0) + '/6)', reasons: [], score: 0 };

  if (tradeCount >= 2)
    return { signal: null, reason: 'Max 2 trades done today', reasons: [], score: 0 };

  if (lastLoss) {
    const mins = (Date.now() - lastLoss) / 60000;
    if (mins < 30)
      return { signal: null, reason: 'Cooldown ' + Math.ceil(30 - mins) + 'min after loss', reasons: [], score: 0 };
  }

  const ist = istMins();
  if (ist < 565) return { signal: null, reason: 'Before 9:25 AM', reasons: [], score: 0 };
  if (ist > 840) return { signal: null, reason: 'After 2:00 PM — no new trades', reasons: [], score: 0 };
  if (dailyPnl <= -3000) return { signal: null, reason: 'Daily loss ₹3,000 hit', reasons: [], score: 0 };

  const closes = candles5m.map(c => c[4]);
  let ceScore = 0, peScore = 0;

  // ATR
  const atr = calcATR(candles5m, 6);
  details.atr = atr;
  if (!atr) return { signal: null, reason: 'ATR failed', reasons: [], score: 0 };
  if (atr < 15) return { signal: null, reason: 'Choppy — ATR ' + atr + ' < 15', reasons: [], score: 0, regime: 'CHOPPY', details };
  const atrS = Math.min(20, Math.round((atr / 35) * 20));
  ceScore += atrS; peScore += atrS;
  reasons.push('ATR ' + atr + 'pts (+' + atrS + ')');

  // Momentum
  const last3 = candles5m.slice(-3);
  const green = last3.filter(c => c[4] > c[1]).length;
  const red   = last3.filter(c => c[4] < c[1]).length;
  details.greenCandles = green; details.redCandles = red;
  if (green >= 2) { const s = green === 3 ? 20 : 12; ceScore += s; reasons.push(green + '/3 green candles (+' + s + ')'); }
  else if (red >= 2) { const s = red === 3 ? 20 : 12; peScore += s; reasons.push(red + '/3 red candles (+' + s + ')'); }
  else reasons.push('Mixed candles');

  // EMA
  if (closes.length >= 21) {
    const ema9 = calcEMA(closes, 9), ema21 = calcEMA(closes, 21);
    const slope = emaSlope(closes, 9);
    details.ema9 = ema9; details.ema21 = ema21;
    if (ema9 && ema21) {
      const dp = Math.abs(ema9 - ema21) / ema21 * 100;
      if (ema9 > ema21 && slope === 'UP')   { const s = Math.min(20, Math.round(dp*50)); ceScore += s; reasons.push('EMA bullish (+' + s + ')'); }
      else if (ema9 < ema21 && slope === 'DOWN') { const s = Math.min(20, Math.round(dp*50)); peScore += s; reasons.push('EMA bearish (+' + s + ')'); }
      else reasons.push('EMA flat');
    }
  }

  // VWAP
  const vwap = calcVWAP(candles5m);
  details.vwap = vwap;
  if (vwap) {
    const diff = Math.abs(spot - vwap) / vwap * 100;
    if (diff < 0.10) { ceScore -= 5; peScore -= 5; reasons.push('Near VWAP (-5)'); }
    else if (spot > vwap) { const s = Math.min(20, Math.round(diff*20)); ceScore += s; reasons.push('Above VWAP ₹' + vwap + ' (+' + s + ')'); }
    else { const s = Math.min(20, Math.round(diff*20)); peScore += s; reasons.push('Below VWAP ₹' + vwap + ' (+' + s + ')'); }
  }

  // Gap + open bias
  if (prevClose) {
    const gapPct = (todayOpen - prevClose) / prevClose * 100;
    const holding = gapPct > 0 ? spot > todayOpen * 0.998 : spot < todayOpen * 1.002;
    details.gapPct = Math.round(gapPct * 100) / 100;
    if (Math.abs(gapPct) > 0.3 && holding) {
      if (gapPct > 0) { ceScore += 15; reasons.push('Gap up ' + Math.abs(gapPct).toFixed(2) + '% (+15)'); }
      else            { peScore += 15; reasons.push('Gap down ' + Math.abs(gapPct).toFixed(2) + '% (+15)'); }
    } else if (Math.abs(gapPct) > 0.3 && !holding) {
      ceScore -= 10; peScore -= 10; reasons.push('Gap reversed (-10)');
    } else {
      if (spot > todayOpen) { ceScore += 8; reasons.push('Above open (+8)'); }
      else { peScore += 8; reasons.push('Below open (+8)'); }
    }
  }

  details.ceScore = ceScore; details.peScore = peScore;
  const top = Math.max(ceScore, peScore);
  const sep = Math.abs(ceScore - peScore);
  const regime = top >= 65 ? 'TRENDING' : top >= 50 ? 'DEVELOPING' : 'CHOPPY';

  if (ceScore >= 65 && sep >= 15) return { signal: 'CE', score: Math.min(ceScore, 97), reasons, regime, details };
  if (peScore >= 65 && sep >= 15) return { signal: 'PE', score: Math.min(peScore, 97), reasons, regime, details };

  reasons.push('No clear signal — CE:' + ceScore + ' PE:' + peScore);
  return { signal: null, reason: 'CE:' + ceScore + ' PE:' + peScore + ' (need 65 + 15pt lead)', reasons, regime, score: top, details };
}

// ═══════════════════════════════════════════════════════════════
// MARKET DATA
// ═══════════════════════════════════════════════════════════════

async function fetchMarketData() {
  try {
    // Spot + OHLC
    const q = await upstox('GET', '/v2/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050');
    const qd = q?.body?.data || {};
    const nd = qd['NSE_INDEX|Nifty 50'] || qd['NSE_INDEX:Nifty 50'] || Object.values(qd)[0];
    if (nd) {
      state.prevNifty  = state.nifty;
      state.nifty      = nd.last_price || state.nifty;
      state.todayOpen  = nd.ohlc?.open || state.todayOpen;
    }

    // 5-min candles
    const cr = await upstox('GET', '/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/5');
    const candles = cr?.body?.data?.candles || [];
    if (candles.length > 0) state.candles5m = candles.slice(-30);

    // Previous day close
    const today    = new Date();
    const toDate   = today.toISOString().slice(0, 10);
    const fromDate = new Date(today.setDate(today.getDate() - 5)).toISOString().slice(0, 10);
    const pr = await upstox('GET', '/v2/historical-candle/NSE_INDEX%7CNifty%2050/day/' + toDate + '/' + fromDate);
    const pc = pr?.body?.data?.candles || [];
    if (pc.length >= 2) state.prevClose = pc[1][4];

    // VWAP — build from candles, but supplement with live spot when candles freeze
    // Candles from Upstox v3 API can stop updating after mid-session
    // We detect a freeze by checking if the last candle timestamp is stale
    const vwapFromCandles = calcVWAP(state.candles5m);
    if (vwapFromCandles && state.candles5m.length > 0) {
      const lastCandleTime = state.candles5m[0][0]; // newest candle timestamp
      const lastCandleMs   = typeof lastCandleTime === 'string'
        ? new Date(lastCandleTime).getTime()
        : lastCandleTime;
      const minsStale = (Date.now() - lastCandleMs) / 60000;
      if (minsStale > 10) {
        // Candles stale — blend frozen VWAP with current spot price
        // Running average: existing VWAP weighted by candle count, spot has weight 1
        const n = state.candles5m.length;
        state.vwap = Math.round(((vwapFromCandles * n) + state.nifty) / (n + 1) * 100) / 100;
        log('VWAP adjusted (candles ' + Math.round(minsStale) + 'min stale): ₹' + state.vwap, 'info');
      } else {
        state.vwap = vwapFromCandles;
      }
    } else {
      state.vwap = state.nifty; // fallback to spot
    }

  } catch(e) {
    log('Market data error: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// ORDER FLOW
// ═══════════════════════════════════════════════════════════════

async function getNextExpiry() {
  try {
    const r = await upstox('GET', '/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%2050');
    const contracts = r?.body?.data || [];
    const today = new Date().toISOString().slice(0, 10);
    const dates = [...new Set(contracts.map(c => c.expiry))].sort();
    return dates.find(d => d >= today) || null;
  } catch(e) { return null; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enterTrade(signal) {
  if (state.inTrade || state.position) return;
  state.inTrade = true;

  try {
    const expiry = await getNextExpiry();
    if (!expiry) { log('No expiry found', 'error'); state.inTrade = false; return; }

    const ocr = await upstox('GET', '/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=' + expiry);
    const contracts = ocr?.body?.data || [];
    const step   = 50;
    const target = signal.signal === 'CE'
      ? Math.ceil(state.nifty / step) * step
      : Math.floor(state.nifty / step) * step;

    let match = contracts.find(c => Number(c.strike_price) === target && c.instrument_type === signal.signal);
    if (!match) {
      const same = contracts.filter(c => c.instrument_type === signal.signal);
      match = same.sort((a, b) => Math.abs(Number(a.strike_price) - target) - Math.abs(Number(b.strike_price) - target))[0];
      if (match) log('Using nearest strike: ' + match.strike_price, 'warn');
    }
    if (!match) { log('No contract found', 'error'); state.inTrade = false; return; }

    // Get real price
    let chainPrice = match.last_price || 0;
    if (!chainPrice) {
      const ltr = await upstox('GET', '/v2/market-quote/ltp?instrument_key=' + encodeURIComponent(match.instrument_key));
      const ltd = ltr?.body?.data || {};
      chainPrice = ltd[match.instrument_key]?.last_price || Object.values(ltd)[0]?.last_price || 0;
    }
    if (!chainPrice) { log('No market price for ' + match.strike_price + ' ' + signal.signal, 'warn'); state.inTrade = false; return; }
    if (chainPrice < 10) { log('Option too cheap ₹' + chainPrice, 'warn'); state.inTrade = false; return; }

    log('Placing BUY: NIFTY ' + match.strike_price + ' ' + signal.signal + ' x' + LOT + ' ~₹' + chainPrice, 'trade');

    const or = await upstox('POST', '/v2/order/place', {
      quantity: LOT, product: 'I', validity: 'DAY', price: 0, tag: 'qe',
      instrument_token: match.instrument_key, order_type: 'MARKET',
      transaction_type: 'BUY', disclosed_quantity: 0, trigger_price: 0, is_amo: false,
    });

    if (or?.body?.status !== 'success') {
      log('BUY failed: ' + JSON.stringify(or?.body?.errors || or?.body?.message), 'error');
      state.inTrade = false; return;
    }

    const orderId = or?.body?.data?.order_id;
    log('Order placed: ' + orderId, 'info');

    await sleep(3500);
    const sr = await upstox('GET', '/v2/order/details?order_id=' + orderId);
    const fd = sr?.body?.data || {};
    const avgPrice = fd.average_price || chainPrice;
    const realKey  = fd.instrument_token || match.instrument_key;

    log('FILL: ₹' + avgPrice + ' (est ₹' + chainPrice + ')', 'trade');

    if (avgPrice > chainPrice * 1.5) {
      log('GAP BLOCK: ₹' + avgPrice + ' vs ₹' + chainPrice + ' — closing', 'warn');
      await exitPosition({ instrumentKey: realKey, qty: LOT, entryPrice: avgPrice }, avgPrice, 'GAP_BLOCK');
      state.inTrade = false; return;
    }

    const sl  = Math.round(avgPrice * 0.82);
    const tgt = Math.round(avgPrice * 1.40);

    state.position = {
      instrument: 'NIFTY', strike: Number(match.strike_price),
      direction: signal.signal, entryPrice: avgPrice, currentPrice: avgPrice,
      instrumentKey: realKey, expiry, qty: LOT, sl, target: tgt,
      trailLocked: false, orderId, entryTime: Date.now(),
    };
    state.tradeCount++;
    log('OPEN: NIFTY ' + match.strike_price + ' ' + signal.signal + ' entry ₹' + avgPrice + ' SL ₹' + sl + ' target ₹' + tgt, 'trade');

  } catch(e) {
    log('enterTrade error: ' + e.message, 'error');
  }
  state.inTrade = false;
}

async function exitPosition(pos, currentPrice, reason) {
  try {
    log('Closing [' + reason + '] ~₹' + currentPrice, 'info');

    const or = await upstox('POST', '/v2/order/place', {
      quantity: pos.qty || LOT, product: 'I', validity: 'DAY', price: 0, tag: 'qe',
      instrument_token: pos.instrumentKey, order_type: 'MARKET',
      transaction_type: 'SELL', disclosed_quantity: 0, trigger_price: 0, is_amo: false,
    });

    const sellId = or?.body?.data?.order_id;
    await sleep(3500);
    let exitPrice = currentPrice;
    if (sellId) {
      const sr = await upstox('GET', '/v2/order/details?order_id=' + sellId);
      if (sr?.body?.data?.average_price > 0) exitPrice = sr.body.data.average_price;
    }

    if (state.position) {
      const entry  = state.position.entryPrice;
      const rawPnl = Math.round((exitPrice - entry) * LOT);
      const fees   = Math.round(48 + exitPrice * LOT * 0.0005 + (entry + exitPrice) * LOT * 0.00053);
      const netPnl = rawPnl - fees;
      state.dailyPnl += netPnl;
      if (netPnl < 0) state.lastLoss = Date.now();
      state.lastTrade = { instrument: 'NIFTY', strike: state.position.strike, direction: state.position.direction, entryPrice: entry, exitPrice, pnl: netPnl, reason };
      const mark = netPnl >= 0 ? '✅' : '❌';
      log(mark + ' CLOSED [' + reason + ']: ₹' + entry + ' → ₹' + exitPrice + ' P&L ₹' + netPnl, netPnl >= 0 ? 'trade' : 'error');
      log('Daily P&L: ₹' + state.dailyPnl, 'info');
    }
    state.position = null;
  } catch(e) {
    log('exitPosition error: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// SCAN ENGINE — every 60 seconds
// ═══════════════════════════════════════════════════════════════

async function scan() {
  if (!state.token || !state.running) return;

  await fetchMarketData();
  const result = analyseMarket();
  state.lastSignal = result;

  log('SCAN: NIFTY ₹' + state.nifty + ' VWAP ₹' + state.vwap + ' | ' +
    (result.signal ? 'SIGNAL ' + result.signal + ' ' + result.score + '%' : result.reason || 'no signal'), 'info');

  if (result.signal && !state.position && !state.inTrade) {
    log('SIGNAL: ' + result.signal + ' ' + result.score + '% | ' + result.reasons.slice(0, 3).join(', '), 'signal');
    await enterTrade(result);
  }
}

// ═══════════════════════════════════════════════════════════════
// POSITION MONITOR — every 15 seconds
// ═══════════════════════════════════════════════════════════════

async function monitorPosition() {
  if (!state.token || !state.position) return;

  // EOD
  if (istMins() >= 910) {
    log('EOD: Auto-closing at 3:10 PM', 'warn');
    await exitPosition(state.position, state.position.currentPrice, 'EOD');
    return;
  }

  try {
    const pr = await upstox('GET', '/v2/portfolio/short-term-positions');
    const positions = pr?.body?.data || [];
    const pos = state.position;
    if (!pos) return;

    const sym = pos.instrument + String(pos.strike) + pos.direction;
    const matched = positions.find(p => (p.trading_symbol || '').toUpperCase().includes(sym.toUpperCase()));
    const ltp = matched?.last_price || 0;

    if (ltp > 0) {
      pos.currentPrice = ltp;
      pos.unrealPnl = Math.round((ltp - pos.entryPrice) * pos.qty);

      if (!pos.trailLocked && ltp >= pos.entryPrice * 1.20) {
        pos.sl = pos.entryPrice;
        pos.trailLocked = true;
        log('TRAIL: SL moved to break-even ₹' + pos.sl, 'trade');
      }
      if (ltp <= pos.sl) {
        log('SL HIT: ₹' + ltp + ' ≤ ₹' + pos.sl, 'warn');
        await exitPosition(pos, ltp, 'SL_HIT');
      } else if (ltp >= pos.target) {
        log('TARGET: ₹' + ltp + ' ≥ ₹' + pos.target, 'trade');
        await exitPosition(pos, ltp, 'TARGET_HIT');
      }
    }
  } catch(e) {
    log('Monitor error: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// START / STOP ENGINE
// ═══════════════════════════════════════════════════════════════

function startEngine() {
  if (state.scanTimer) clearInterval(state.scanTimer);
  if (state.posTimer)  clearInterval(state.posTimer);
  if (state.countTimer) clearInterval(state.countTimer);

  state.running = true;
  state.scanIn  = 60;

  scan(); // immediate first run
  state.scanTimer  = setInterval(scan, 60000);
  state.posTimer   = setInterval(monitorPosition, 15000);
  state.countTimer = setInterval(() => { state.scanIn = Math.max(0, state.scanIn - 1); if (state.scanIn === 0) state.scanIn = 60; }, 1000);

  log('Engine started — scanning every 60s', 'trade');
}

function stopEngine() {
  if (state.scanTimer)  { clearInterval(state.scanTimer);  state.scanTimer = null; }
  if (state.countTimer) { clearInterval(state.countTimer); state.countTimer = null; }
  // posTimer keeps running — must still manage open position
  state.running = false;
  log('Scan engine stopped (position monitor still active)', 'warn');
}

// ═══════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Serve dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) { send(404, { error: 'index.html not found' }); }
    return;
  }

  // Health
  if (req.method === 'GET' && req.url === '/health') {
    send(200, { status: 'ok', uptime: Math.round(process.uptime()) + 's', running: state.running, connected: state.connected });
    return;
  }

  // Current state for browser
  if (req.method === 'GET' && req.url === '/state') {
    send(200, {
      connected:  state.connected,
      running:    state.running,
      nifty:      state.nifty,
      prevNifty:  state.prevNifty,
      vwap:       state.vwap,
      capital:    state.capital,
      dailyPnl:   state.dailyPnl,
      tradeCount: state.tradeCount,
      position:   state.position,
      lastTrade:  state.lastTrade,
      lastSignal: state.lastSignal,
      scanIn:     state.scanIn,
      logs:       memLogs.slice(0, 50),
    });
    return;
  }

  // Download full log file
  if (req.method === 'GET' && req.url === '/logs') {
    try {
      const data = fs.readFileSync(LOG_FILE);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="trading.log"' });
      res.end(data);
    } catch(e) { send(404, { error: 'No log file yet' }); }
    return;
  }

  // Read body for POST requests
  let body = '';
  await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
  let data = {};
  try { data = JSON.parse(body); } catch(e) {}

  // Connect — receive token, start engine
  if (req.method === 'POST' && req.url === '/connect') {
    const { token, capital } = data;
    if (!token) { send(400, { error: 'Missing token' }); return; }

    state.token     = token;
    state.capital   = capital || 0;
    state.connected = true;
    state.dailyPnl  = 0;
    state.tradeCount = 0;
    state.lastLoss  = null;
    state.position  = null;

    log('Connected with token', 'trade');

    // Fetch real balance
    try {
      const br = await upstox('GET', '/v2/user/get-funds-and-margin?segment=SEC');
      const bal = br?.body?.data?.equity?.available_margin || 0;
      if (bal > 0) { state.capital = bal; log('Balance: ₹' + bal, 'trade'); }
    } catch(e) { log('Balance fetch failed', 'warn'); }

    startEngine();
    send(200, { ok: true, capital: state.capital });
    return;
  }

  // Stop scan engine
  if (req.method === 'POST' && req.url === '/stop') {
    stopEngine();
    send(200, { ok: true });
    return;
  }

  // Manual close
  if (req.method === 'POST' && req.url === '/close') {
    if (!state.position) { send(400, { error: 'No open position' }); return; }
    const pos = state.position;
    let closePrice = pos.currentPrice || pos.entryPrice;
    try {
      const ltr = await upstox('GET', '/v2/market-quote/ltp?instrument_key=' + encodeURIComponent(pos.instrumentKey));
      const ltd = ltr?.body?.data || {};
      const lv = ltd[pos.instrumentKey]?.last_price || Object.values(ltd)[0]?.last_price || 0;
      if (lv > 0) closePrice = lv;
    } catch(e) {}
    await exitPosition(pos, closePrice, 'MANUAL');
    send(200, { ok: true });
    return;
  }

  send(404, { error: 'Not found' });

}).listen(PORT, () => {
  log('QuantEdge server on port ' + PORT, 'info');
});
