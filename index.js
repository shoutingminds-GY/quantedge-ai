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
  lastScanDate: null,  // tracks date for daily reset
  scanIn:      60,

  // Market context
  indiaVix:    0,   // India VIX fetched each morning
  oiData:      {},  // OI wall data from option chain
  pcr:         0,   // Put-Call Ratio
  isExpiryDay: false, // true on Monday (NIFTY expiry)

  // VWAP crossover tracking (Signal B)
  vwapSide:    null,  // current: 'above' | 'below' | null
  prevVwapSide: null, // previous scan's side
  vwapCrossCount: 0,  // consecutive scans on same side after cross
  vwapHistory: [],    // last 6 VWAP values for trend direction check

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

// ─── VIX-based trade config ─────────────────────────────────
// Returns target multiplier, sl multiplier, and whether to trade
// Based on 590-day VIX percentile analysis:
//   Median VIX = 13.8 | 75th pct = 15.7 | 90th pct = 17.4
function getTradeConfig(vix) {
  // SL is 25% (slMult 0.75) across all VIX zones.
  // Evidence: 25% ≈ 70pt NIFTY buffer at delta ~0.6.
  // This survives 30-50pt intraday noise on correct-direction trades.
  // Saves Jun4 (43pt bounce) and Jun5-T3 (36pt bounce) which were right direction.
  // Wrong-direction trades (Jun5 T1/T2) are blocked by distance check anyway.
  if (vix <= 0) {
    return { allow: true, targetMult: 1.35, slMult: 0.75, label: 'VIX unknown (safe defaults, SL 25%)' };
  }
  if (vix > 19) {
    return { allow: false, targetMult: 1.40, slMult: 0.75, label: 'VIX ' + vix + ' > 19 (very expensive — skip)' };
  }
  if (vix > 16) {
    return { allow: true, targetMult: 1.25, slMult: 0.75, label: 'VIX ' + vix + ' (expensive — target 25%, SL 25%)' };
  }
  if (vix > 13) {
    return { allow: true, targetMult: 1.35, slMult: 0.75, label: 'VIX ' + vix + ' (normal — target 35%, SL 25%)' };
  }
  return { allow: true, targetMult: 1.40, slMult: 0.75, label: 'VIX ' + vix + ' (cheap — target 40%, SL 25%)' };
}

// ─── OI wall analysis ────────────────────────────────────────
// Returns nearest OI wall and PCR from option chain data
// contracts: array from Upstox option chain API
// direction: 'CE' or 'PE'
// nifty: current NIFTY spot
function analyseOI(contracts, direction, nifty) {
  if (!contracts || contracts.length === 0) return { wall: null, pcr: 0, clearPath: true };

  // Separate CE and PE
  const ceContracts = contracts.filter(c => c.instrument_type === 'CE');
  const peContracts = contracts.filter(c => c.instrument_type === 'PE');

  // PCR = total PE OI / total CE OI
  const totalCeOI = ceContracts.reduce((s, c) => s + (c.oi || 0), 0);
  const totalPeOI = peContracts.reduce((s, c) => s + (c.oi || 0), 0);
  const pcr = totalCeOI > 0 ? Math.round(totalPeOI / totalCeOI * 100) / 100 : 0;

  // Find OI wall in trade direction
  // For CE: look at CE strikes 50-200 points ABOVE nifty
  // For PE: look at PE strikes 50-200 points BELOW nifty
  const relevant = direction === 'CE'
    ? ceContracts.filter(c => Number(c.strike_price) > nifty && Number(c.strike_price) <= nifty + 200)
    : peContracts.filter(c => Number(c.strike_price) < nifty && Number(c.strike_price) >= nifty - 200);

  if (relevant.length === 0) return { wall: null, pcr, clearPath: true };

  // Find average OI in the search range
  const oiValues = relevant.map(c => c.oi || 0).filter(v => v > 0);
  if (oiValues.length === 0) return { wall: null, pcr, clearPath: true };
  const avgOI = oiValues.reduce((s, v) => s + v, 0) / oiValues.length;

  // Wall = any strike with OI more than 3x average
  const walls = relevant
    .filter(c => (c.oi || 0) > avgOI * 3)
    .sort((a, b) => direction === 'CE'
      ? Number(a.strike_price) - Number(b.strike_price)  // nearest wall first for CE
      : Number(b.strike_price) - Number(a.strike_price)  // nearest wall first for PE
    );

  const nearestWall = walls[0] || null;
  const distToWall  = nearestWall
    ? Math.abs(Number(nearestWall.strike_price) - nifty)
    : 999;

  return {
    wall:      nearestWall ? { strike: Number(nearestWall.strike_price), oi: nearestWall.oi, dist: distToWall } : null,
    pcr,
    clearPath: distToWall > 100, // true if wall is more than 100 pts away
  };
}

// ─── Strike selection (ITM vs ATM based on VIX) ──────────────
// VIX > 16: buy 1-strike ITM (lower extrinsic, better delta)
// VIX <= 16: buy ATM (standard)
function getTargetStrike(nifty, direction, vix, step) {
  const atm = direction === 'CE'
    ? Math.ceil(nifty / step) * step
    : Math.floor(nifty / step) * step;
  if (vix > 16) {
    // Buy 1-strike ITM: for CE go 1 strike lower, for PE go 1 strike higher
    const itm = direction === 'CE' ? atm - step : atm + step;
    return { strike: itm, type: 'ITM' };
  }
  return { strike: atm, type: 'ATM' };
}

// ─── Expiry day detection ─────────────────────────────────────
// NIFTY expires every Monday
function isNiftyExpiryDay() {
  const ist = new Date(Date.now() + 330 * 60000);
  return ist.getDay() === 1; // 1 = Monday
}

// ─── VWAP Crossover detection (Signal B) ─────────────────────
// Returns crossover signal or null
// Evidence: 71% win rate on our 14 trading days with dist > 10pts filter
// Fires when NIFTY cleanly crosses VWAP:
//   - Was on opposite side last scan (the actual crossing moment)
//   - Now on new side for 2 consecutive scans (confirmation)
//   - Distance from VWAP > 10 points (avoids noise crosses)
//   - Same time gates and safety gates as Signal A
function detectVwapCross() {
  const { nifty, vwap, tradeCount, lastLoss, dailyPnl, prevVwapSide, vwapSide, vwapCrossCount } = state;

  // Safety gates — identical to Signal A
  if (!nifty || !vwap || vwap === 0) return null;
  if (tradeCount >= 3) return null;
  if (dailyPnl <= -3000) return null;
  if (lastLoss && (Date.now() - lastLoss) / 60000 < 15) return null;
  const ist = istMins();
  if (ist < 565) return null;  // Before 9:25 AM
  if (ist > 840) return null;  // After 2:00 PM

  // Need minimum candles for a valid VWAP
  if (!state.candles5m || state.candles5m.length < 4) return null;

  // Current side
  const curSide = nifty > vwap ? 'above' : 'below';
  const dist    = Math.abs(nifty - vwap);

  // We need:
  // 1. A genuine cross: prevVwapSide is DIFFERENT from curSide
  //    (NIFTY just crossed VWAP in this scan)
  // 2. Minimum distance: dist > 10pts (not a noise cross)
  // 3. vwapCrossCount >= 1 (cross confirmed for 2+ scans)
  //    This is tracked in scan() — incremented each scan after cross

  // Has a cross happened? prevVwapSide != vwapSide means we crossed
  // vwapCrossCount tells us how many scans we've been on new side
  if (!prevVwapSide || !vwapSide) return null;
  if (prevVwapSide === vwapSide) return null;  // No cross yet
  if (vwapCrossCount < 1) return null;         // Not confirmed yet (need 2nd scan)
  if (dist < 10) return null;                  // Too close — noise

  // Cross confirmed — which direction?
  const direction = curSide === 'above' ? 'CE' : 'PE';

  // ── VWAP DIRECTION FILTER ────────────────────────────────────
  // Evidence: 71% win rate with filter vs 56% without
  // CE cross: VWAP must be rising (not falling) over last 5 scans
  // PE cross: VWAP must be falling (not rising) over last 5 scans
  // Prevents buying CE against a falling VWAP (today's Trade 2 mistake)
  if (state.vwapHistory && state.vwapHistory.length >= 5) {
    const vwapOld     = state.vwapHistory[0];  // oldest in window
    const vwapNew     = state.vwap;             // current
    const vwapChange  = vwapNew - vwapOld;
    const vwapRising  = vwapChange >= -2;   // flat or rising
    const vwapFalling = vwapChange <= 2;    // flat or falling

    if (direction === 'CE' && !vwapRising) {
      // VWAP is falling — CE cross likely a bounce, not a trend
      log('CROSS BLOCK: CE cross but VWAP falling ' + vwapChange.toFixed(1) + 'pts — skipping', 'warn');
      return null;
    }
    if (direction === 'PE' && !vwapFalling) {
      // VWAP is rising — PE cross likely a dip, not a trend
      log('CROSS BLOCK: PE cross but VWAP rising ' + vwapChange.toFixed(1) + 'pts — skipping', 'warn');
      return null;
    }
    log('VWAP direction: ' + direction + ' aligned (change ' + vwapChange.toFixed(1) + 'pts over 5 scans)', 'info');
  }

  return {
    signal:    direction,
    type:      'CROSSOVER',
    score:     60,           // Fixed confidence for crossover signals
    vwapDist:  Math.round(dist),
    vwap:      vwap,
    nifty:     nifty,
    reason:    'VWAP cross ' + direction + ' dist ' + Math.round(dist) + 'pts',
    reasons:   ['VWAP crossover', direction + ' side dist ' + Math.round(dist) + 'pts', 'Confirmed 2 scans'],
  };
}

function analyseMarket() {
  const { nifty: spot, todayOpen, prevClose, candles5m, dailyPnl, tradeCount, lastLoss } = state;
  const reasons = [], details = {};

  if (!spot || !todayOpen || !candles5m || candles5m.length < 6)
    return { signal: null, reason: 'Waiting for candles (' + (candles5m?.length || 0) + '/6)', reasons: [], score: 0 };

  if (tradeCount >= 3)
    return { signal: null, reason: 'Max 3 trades done today', reasons: [], score: 0 };

  if (lastLoss) {
    const mins = (Date.now() - lastLoss) / 60000;
    if (mins < 15)
      return { signal: null, reason: 'Cooldown ' + Math.ceil(15 - mins) + 'min after loss', reasons: [], score: 0 };
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
      // EMA scoring: use absolute point difference (not percentage)
      // Percentage was wrong for NIFTY at 23,000 — 0.1% = 23pts which is meaningful
      // New: abs(ema9-ema21)/2 → 10pts diff=+5, 20pts=+10, 40pts=+20(max)
      const dp = Math.abs(ema9 - ema21);
      if (ema9 > ema21 && slope === 'UP')   { const s = Math.min(20, Math.round(dp/2)); ceScore += s; reasons.push('EMA bullish (+' + s + ')'); }
      else if (ema9 < ema21 && slope === 'DOWN') { const s = Math.min(20, Math.round(dp/2)); peScore += s; reasons.push('EMA bearish (+' + s + ')'); }
      else reasons.push('EMA flat');
    }
  }

  // VWAP
  const vwap = calcVWAP(candles5m);
  details.vwap = vwap;
  if (vwap) {
    // VWAP scoring: use absolute point difference (not percentage)
    // Percentage was wrong for NIFTY — 0.18% = 41pts which is a strong signal
    // New: absDiff/3 → 10pts=+3, 30pts=+10, 60pts=+20(max)
    // Near VWAP: use 5pts absolute (not 0.10% = 23pts)
    const absDiff = Math.abs(spot - vwap);
    if (absDiff < 5) { ceScore -= 5; peScore -= 5; reasons.push('Near VWAP (-5)'); }
    else if (spot > vwap) { const s = Math.min(20, Math.round(absDiff/3)); ceScore += s; reasons.push('Above VWAP ₹' + vwap + ' (+' + s + ')'); }
    else { const s = Math.min(20, Math.round(absDiff/3)); peScore += s; reasons.push('Below VWAP ₹' + vwap + ' (+' + s + ')'); }
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
  const regime = top >= 58 ? 'TRENDING' : top >= 45 ? 'DEVELOPING' : 'CHOPPY';

  if (ceScore >= 58 && sep >= 15) return { signal: 'CE', score: Math.min(ceScore, 97), reasons, regime, details };
  if (peScore >= 58 && sep >= 15) return { signal: 'PE', score: Math.min(peScore, 97), reasons, regime, details };

  reasons.push('No clear signal — CE:' + ceScore + ' PE:' + peScore);
  return { signal: null, reason: 'CE:' + ceScore + ' PE:' + peScore + ' (need 58 + 15pt lead)', reasons, regime, score: top, details };
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
      // Only set todayOpen after market opens (9:15 AM IST = 555 mins)
      // Before 9:15, ohlc.open returns yesterday's value
      const istNow = (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 330) % 1440;
      if (istNow >= 555 && nd.ohlc?.open) {
        // Only update todayOpen if it's 0 (first fetch of the day)
        // Once set, keep it — the open price doesn't change
        if (!state.todayOpen) state.todayOpen = nd.ohlc.open;
      }
    }

    // 5-min candles
    const cr = await upstox('GET', '/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/5');
    const candles = cr?.body?.data?.candles || [];
    if (candles.length > 0) {
      // API returns newest candle first — take 30 newest, reverse to oldest-first
      const newestCandle = candles[0];
      const candleDate   = new Date(newestCandle[0]).toISOString().slice(0, 10);
      const todayDate    = new Date(Date.now() + 330*60000).toISOString().slice(0, 10);
      if (candleDate !== todayDate) {
        // Candles are from a previous day — clear them and reset todayOpen
        log('New trading day detected — clearing stale candles and resetting open', 'info');
        state.candles5m  = [];
        state.todayOpen  = 0;
      } else {
        state.candles5m = candles.slice(0, 30).reverse();
      }
    }

    // Previous day close
    const todayD   = new Date();
    const toDate   = todayD.toISOString().slice(0, 10);
    const fromD    = new Date(todayD.getTime()); // separate object — don't mutate todayD
    fromD.setDate(fromD.getDate() - 5);
    const fromDate = fromD.toISOString().slice(0, 10);
    const pr = await upstox('GET', '/v2/historical-candle/NSE_INDEX%7CNifty%2050/day/' + toDate + '/' + fromDate);
    const pc = pr?.body?.data?.candles || [];
    if (pc.length >= 2) state.prevClose = pc[1][4];

    // VWAP — build from candles, but supplement with live spot when candles freeze
    // Candles from Upstox v3 API can stop updating after mid-session
    // We detect a freeze by checking if the last candle timestamp is stale
    const vwapFromCandles = calcVWAP(state.candles5m);
    if (vwapFromCandles && state.candles5m.length > 0) {
      const lastCandleTime = state.candles5m[state.candles5m.length - 1][0]; // newest candle (last after reverse)
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

    // India VIX — fetch once per day (updates state.indiaVix)
    // VIX tells us if options are cheap or expensive
    // We use market_quote for INDIA VIX index
    try {
      const vr = await upstox('GET', '/v2/market-quote/quotes?instrument_key=NSE_INDEX%7CIndia%20VIX');
      const vd = vr?.body?.data || {};
      const vn = vd['NSE_INDEX|India VIX'] || vd['NSE_INDEX:India VIX'] || Object.values(vd)[0];
      if (vn && vn.last_price > 0) {
        state.indiaVix = Math.round(vn.last_price * 100) / 100;
      }
    } catch(e) { /* VIX fetch failed — use last known value */ }

    // Expiry day detection (Monday = NIFTY weekly expiry)
    state.isExpiryDay = isNiftyExpiryDay();

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
    const isCrossover = signal.type === 'CROSSOVER';

    // ── STEP 0: DISTANCE CHECK — block entries on exhausted moves ──
    // Evidence: Jun5 T1 (224pts before connect) and T2 (142pt bounce) both lost.
    // Jun3 wins: move was 77pts over 6 candles — ongoing, not exhausted.
    // Rule: if NIFTY already moved >120pts in signal direction over last 6 candles
    //       (30 minutes), the move is likely complete. Block entry.
    if (state.candles5m && state.candles5m.length >= 6) {
      const recent6     = state.candles5m.slice(-6);
      const oldest6Close = recent6[0][4];
      const niftyMove   = state.nifty - oldest6Close;
      const moveInDir   = signal.signal === 'CE' ? niftyMove : -niftyMove;
      if (moveInDir > 120) {
        log('DISTANCE BLOCK: NIFTY moved ' + Math.round(moveInDir) + 'pts in ' +
            signal.signal + ' dir over last 30min (max 120) — move exhausted', 'warn');
        state.inTrade = false; return;
      }
      log('Distance check: ' + Math.round(moveInDir) + 'pts in ' + signal.signal + ' dir (max 120) ✅', 'info');
    }

    // ── STEP 1: IV CHECK ────────────────────────────────────────
    // Crossover trades use fixed 20% target regardless of VIX
    // Signal A trades use VIX-adjusted target
    let tradeConfig;
    if (isCrossover) {
      // Crossover: always 20% target, 15% SL, fast exit
      // VIX block still applies — don't buy expensive options even on crossovers
      tradeConfig = { allow: true, targetMult: 1.20, slMult: 0.85,
                      label: 'CROSSOVER mode (20% target, 15% SL)' };
      if (state.indiaVix > 19) {
        log('IV BLOCK [crossover]: VIX ' + state.indiaVix + ' > 19 — too expensive', 'warn');
        state.inTrade = false; return;
      }
      log('IV CHECK [crossover]: VIX ' + state.indiaVix + ' — ' + tradeConfig.label, 'info');
    } else {
      tradeConfig = getTradeConfig(state.indiaVix);
      if (!tradeConfig.allow) {
        log('IV BLOCK: ' + tradeConfig.label, 'warn');
        state.inTrade = false; return;
      }
      log('IV CHECK: ' + tradeConfig.label, 'info');
    }

    // ── STEP 2: EXPIRY DAY RULES ────────────────────────────────
    if (state.isExpiryDay) {
      const ist = istMins();
      if (ist > 720) {
        log('EXPIRY BLOCK: Past 12:00 PM on expiry day — theta too high', 'warn');
        state.inTrade = false; return;
      }
      if (!isCrossover && signal.score < 70) {
        log('EXPIRY BLOCK: Score ' + signal.score + ' < 70 needed on expiry day', 'warn');
        state.inTrade = false; return;
      }
      log('EXPIRY DAY: Proceeding with ' + (isCrossover ? 'CROSSOVER' : 'score ' + signal.score) + '.', 'info');
    }

    const expiry = await getNextExpiry();
    if (!expiry) { log('No expiry found', 'error'); state.inTrade = false; return; }

    const ocr = await upstox('GET', '/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=' + expiry);
    const contracts = ocr?.body?.data || [];
    const step = 50;

    // ── STEP 3: OI WALL CHECK ────────────────────────────────────
    const oiResult = analyseOI(contracts, signal.signal, state.nifty);
    state.oiData = oiResult;
    state.pcr    = oiResult.pcr;

    if (oiResult.wall && oiResult.wall.dist <= 80) {
      log('OI BLOCK: Wall at ' + oiResult.wall.strike + ' only ' + oiResult.wall.dist + ' pts away (OI ' + oiResult.wall.oi + ')', 'warn');
      state.inTrade = false; return;
    }
    if (oiResult.wall) {
      log('OI WALL: ' + oiResult.wall.strike + ' dist ' + oiResult.wall.dist + ' pts. PCR ' + oiResult.pcr, 'info');
    } else {
      log('OI CLEAR: No wall within 200pts. PCR ' + oiResult.pcr, 'info');
    }

    // PCR confirmation: warn if OI positioning contradicts signal
    if (signal.signal === 'CE' && oiResult.pcr < 0.7) {
      log('OI CAUTION: PCR ' + oiResult.pcr + ' < 0.7 — market positioned bearish vs our CE signal', 'warn');
    } else if (signal.signal === 'PE' && oiResult.pcr > 1.5) {
      log('OI CAUTION: PCR ' + oiResult.pcr + ' > 1.5 — market positioned bullish vs our PE signal', 'warn');
    }

    // ── STEP 4: STRIKE SELECTION (ITM vs ATM based on VIX) ──────
    const strikeInfo = getTargetStrike(state.nifty, signal.signal, state.indiaVix, step);
    const targetStrike = strikeInfo.strike;

    let match = contracts.find(c => Number(c.strike_price) === targetStrike && c.instrument_type === signal.signal);
    if (!match) {
      // Fallback to nearest available strike
      const same = contracts.filter(c => c.instrument_type === signal.signal);
      match = same.sort((a, b) => Math.abs(Number(a.strike_price) - targetStrike) - Math.abs(Number(b.strike_price) - targetStrike))[0];
      if (match) log('Using nearest strike: ' + match.strike_price + ' (' + strikeInfo.type + ' selection)', 'warn');
    } else {
      log('Strike: ' + match.strike_price + ' (' + strikeInfo.type + ', VIX ' + state.indiaVix + ')', 'info');
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
    // Minimum price gate: ₹100
    // Evidence: All winning trades ₹155+. Losses at ₹55-62 had SL too tight (noise = instant stop).
    // Below ₹100: SL room in rupees too small for intraday NIFTY movement.
    if (chainPrice < 100) {
      log('MIN PRICE BLOCK: ₹' + chainPrice + ' < ₹100 minimum — option too cheap for safe SL', 'warn');
      state.inTrade = false; return;
    }

    // Log option IV if available
    if (match.implied_volatility) {
      log('Option IV: ' + match.implied_volatility + '% | Delta: ' + (match.delta || 'N/A'), 'info');
    }

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
    let sr = await upstox('GET', '/v2/order/details?order_id=' + orderId);
    let fd = sr?.body?.data || {};
    // Retry if average_price not yet populated — MARKET orders can take a few seconds
    // Evidence: Jun5 log showed ₹163 but Upstox showed ₹169 — 3.5s was not enough
    if (!fd.average_price || fd.average_price === 0) {
      log('Fill price not ready — retrying in 3s', 'info');
      await sleep(3000);
      sr = await upstox('GET', '/v2/order/details?order_id=' + orderId);
      fd = sr?.body?.data || {};
    }
    const avgPrice = fd.average_price || chainPrice;
    const realKey  = fd.instrument_token || match.instrument_key;

    log('FILL: ₹' + avgPrice + ' (est ₹' + chainPrice + ')' + (fd.average_price ? '' : ' ⚠️ used chainPrice estimate'), 'trade');

    if (avgPrice > chainPrice * 1.5) {
      log('GAP BLOCK: ₹' + avgPrice + ' vs ₹' + chainPrice + ' — closing', 'warn');
      await exitPosition({ instrumentKey: realKey, qty: LOT, entryPrice: avgPrice }, avgPrice, 'GAP_BLOCK');
      state.inTrade = false; return;
    }

    // ── STEP 5: VIX-ADJUSTED TARGET AND SL ──────────────────────
    const sl  = Math.round(avgPrice * tradeConfig.slMult);
    const tgt = Math.round(avgPrice * tradeConfig.targetMult);

    // Max hold: crossover = always 45min, expiry day = 45min, normal Signal A = null
    const maxHoldMs = (isCrossover || state.isExpiryDay) ? 45 * 60 * 1000 : null;
    const tradeTag  = isCrossover ? 'CROSSOVER' : 'MOMENTUM';

    state.position = {
      instrument: 'NIFTY', strike: Number(match.strike_price),
      direction: signal.signal, entryPrice: avgPrice, currentPrice: avgPrice,
      instrumentKey: realKey, expiry, qty: LOT, sl, target: tgt,
      trailLocked: false, orderId, entryTime: Date.now(),
      maxHoldMs, isExpiryDay: state.isExpiryDay,
      vixAtEntry: state.indiaVix, targetMult: tradeConfig.targetMult,
      tradeTag,
    };
    state.tradeCount++;
    // Reset VWAP cross tracking after entry (don't re-fire immediately)
    state.vwapCrossCount = 0;
    state.prevVwapSide   = state.vwapSide;
    log('OPEN [' + tradeTag + ']: NIFTY ' + match.strike_price + ' ' + signal.signal +
        ' entry ₹' + avgPrice +
        ' SL ₹' + sl +
        ' target ₹' + tgt +
        ' (' + Math.round((tradeConfig.targetMult - 1) * 100) + '% target)' +
        (maxHoldMs ? ' [MAX 45min]' : '') +
        ' VIX ' + state.indiaVix, 'trade');

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

  // Auto-stop at 3:30 PM IST (market close) if no open position
  const istNow = (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 330) % 1440;
  if (istNow >= 930 && !state.position) {
    log('Market closed (3:30 PM) — stopping scan engine', 'info');
    stopEngine();
    return;
  }

  // Daily reset — when date changes, reset daily counters
  const scanDateNow = new Date(Date.now() + 330*60000).toISOString().slice(0, 10);
  if (state.lastScanDate && state.lastScanDate !== scanDateNow) {
    log('New trading day: ' + scanDateNow + ' — resetting daily P&L and trade count', 'info');
    state.dailyPnl      = 0;
    state.tradeCount    = 0;
    state.lastLoss      = null;
    state.todayOpen     = 0;
    state.candles5m     = [];
    state.vwap          = 0;
    state.vwapSide      = null;
    state.prevVwapSide  = null;
    state.vwapCrossCount = 0;
    state.vwapHistory    = [];
  }
  state.lastScanDate = scanDateNow;

  await fetchMarketData();
  const result = analyseMarket();
  state.lastSignal = result;

  // ── Update VWAP history and side tracking for Signal B ──────
  if (state.nifty > 0 && state.vwap > 0) {
    // Keep last 6 VWAP values for direction filter
    state.vwapHistory.push(state.vwap);
    if (state.vwapHistory.length > 6) state.vwapHistory.shift();
    const newSide = state.nifty > state.vwap ? 'above' : 'below';
    if (state.vwapSide === null) {
      // First scan — initialise both sides
      state.vwapSide     = newSide;
      state.prevVwapSide = newSide;
      state.vwapCrossCount = 0;
    } else if (newSide !== state.vwapSide) {
      // Side changed — this IS the crossing scan
      // prevVwapSide stays as the old side (where we came from)
      state.prevVwapSide   = state.vwapSide;  // remember where we came from
      state.vwapSide       = newSide;          // record new side
      state.vwapCrossCount = 0;                // reset confirmation counter
    } else {
      // Same side as last scan — increment confirmation
      state.vwapCrossCount++;
    }
  }

  const vixLabel  = state.indiaVix > 0 ? ' VIX ' + state.indiaVix : '';
  const expiryLbl = state.isExpiryDay ? ' [EXPIRY DAY]' : '';
  log('SCAN: NIFTY ₹' + state.nifty + ' VWAP ₹' + state.vwap + vixLabel + expiryLbl + ' | ' +
    (result.signal ? 'SIGNAL ' + result.signal + ' ' + result.score + '%' : result.reason || 'no signal'), 'info');

  // ── Signal A: Original momentum system (score >= 65) ────────
  if (result.signal && !state.position && !state.inTrade) {
    log('SIGNAL-A: ' + result.signal + ' ' + result.score + '% | ' + result.reasons.slice(0, 3).join(', '), 'signal');
    await enterTrade(result);
    return;
  }

  // ── Signal B: VWAP Crossover — DISABLED (false && prevents execution)
  // Disabled after Jun 1-2 losses: fired in choppy markets with noise stops.
  // Re-enable by removing 'false &&' when ready.
  if (false && !state.position && !state.inTrade) {
    const crossResult = detectVwapCross();
    if (crossResult) {
      log('SIGNAL-B [CROSSOVER]: ' + crossResult.signal + ' | ' + crossResult.reason, 'signal');
      await enterTrade(crossResult);
    }
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

    // Match by instrument_token (exact) — more reliable than trading_symbol string
    // pos.instrumentKey = 'NSE_FO|NIFTY2451923650CE' from order fill
    // positions API returns p.instrument_token in same format
    const matched = positions.find(p =>
      p.instrument_token === pos.instrumentKey ||
      (p.trading_symbol || '').toUpperCase() === (pos.instrumentKey || '').split('|')[1]?.toUpperCase()
    );
    const ltp = matched?.last_price || 0;
    if (ltp > 0) log('Monitor: ' + pos.strike + ' ' + pos.direction + ' LTP ₹' + ltp + ' SL ₹' + pos.sl + ' Target ₹' + pos.target, 'info');

    if (ltp > 0) {
      pos.currentPrice = ltp;
      pos.unrealPnl = Math.round((ltp - pos.entryPrice) * pos.qty);

      // Max hold time check (expiry day = 45 minutes)
      if (pos.maxHoldMs && (Date.now() - pos.entryTime) >= pos.maxHoldMs) {
        log('MAX HOLD: ' + Math.round(pos.maxHoldMs/60000) + 'min reached on expiry day — closing', 'warn');
        await exitPosition(pos, ltp, 'MAX_HOLD');
        return;
      }

      // Trail: move SL to break-even at +15% (was 20%)
      // Evidence: all 3 winners passed +15% before target. Locks earlier = safer.
      // May14: +15%=₹203, target₹247. Jun3T1: +15%=₹280, target₹305.
      if (!pos.trailLocked && ltp >= pos.entryPrice * 1.15) {
        pos.sl = pos.entryPrice;
        pos.trailLocked = true;
        log('TRAIL: SL moved to break-even ₹' + pos.sl + ' (+15% reached)', 'trade');
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
  if (!state.running) return; // already stopped
  if (state.scanTimer)  { clearInterval(state.scanTimer);  state.scanTimer = null; }
  if (state.countTimer) { clearInterval(state.countTimer); state.countTimer = null; }
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

  // Serve any HTML file from project folder
  if (req.method === 'GET' && (req.url === '/' || /^\/[\w-]+\.html$/.test(req.url))) {
    const filename = req.url === '/' ? 'index.html' : req.url.slice(1);
    try {
      const html = fs.readFileSync(path.join(__dirname, filename));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) { send(404, { error: filename + ' not found' }); }
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
      connected:    state.connected,
      running:      state.running,
      nifty:        state.nifty,
      prevNifty:    state.prevNifty,
      vwap:         state.vwap,
      capital:      state.capital,
      dailyPnl:     state.dailyPnl,
      tradeCount:   state.tradeCount,
      position:     state.position,
      lastTrade:    state.lastTrade,
      lastSignal:   state.lastSignal,
      scanIn:       state.scanIn,
      indiaVix:     state.indiaVix,
      pcr:          state.pcr,
      isExpiryDay:  state.isExpiryDay,
      vwapSide:     state.vwapSide,
      vwapCrossCount: state.vwapCrossCount,
      logs:         memLogs.slice(0, 50),
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

    state.token     = token.trim().replace(/[\r\n\t]/g, ''); // strip any whitespace/newlines
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

    // Pre-load today's candles immediately on connect
    // This eliminates the 30-minute blind window at market open
    // Without this, the system waits for 6 candles to build (9:15-9:45 AM)
    try {
      const cr = await upstox('GET', '/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/5');
      const candles = cr?.body?.data?.candles || [];
      if (candles.length > 0) {
        const newestCandle = candles[0];
        const candleDate   = new Date(newestCandle[0]).toISOString().slice(0, 10);
        const todayDate    = new Date(Date.now() + 330*60000).toISOString().slice(0, 10);
        if (candleDate === todayDate) {
          state.candles5m = candles.slice(0, 30).reverse();
          const vwapNow = calcVWAP(state.candles5m);
          if (vwapNow) state.vwap = vwapNow;
          log('Pre-loaded ' + state.candles5m.length + ' candles from today — ready immediately', 'info');
        } else {
          log('Candles are from previous day — will build fresh after 9:15 AM', 'info');
        }
      }
    } catch(e) { log('Candle pre-load failed: ' + e.message + ' — will build normally', 'warn'); }

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

  // Disconnect — clear token and stop everything
  if (req.method === 'POST' && req.url === '/disconnect') {
    stopEngine();
    if (state.posTimer) { clearInterval(state.posTimer); state.posTimer = null; }
    state.token     = null;
    state.connected = false;
    state.position  = null;
    log('Token cleared — disconnected', 'warn');
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
