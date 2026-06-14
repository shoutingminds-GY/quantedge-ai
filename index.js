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
  isExpiryDay: false, // true on Tuesday (NIFTY weekly expiry)

  // Price Action levels (PDH/PDL)
  pdh:         0,   // Previous Day High — key resistance
  pdl:         0,   // Previous Day Low  — key support
  pdMid:       0,   // (PDH+PDL)/2 — first target for rejections
  pdRange:     0,   // PDH - PDL — must be > 100 for meaningful levels
  pdDate:      null,// Date of the prev day data (prevents stale levels)
  paSignalFired: false, // one PA trade per day
  paWatching:  null,   // 'PDH' | 'PDL' | null — which level is being tested

  // Mode 1 morning breakout tracking
  morningBias:    null,   // 'CE' | 'PE' | null — set at 9:30 if Mode 1 fires
  morningChecked: false,  // true once 9:30 AM check has been evaluated
  morningSignalFired: false, // true if Mode 1 actually entered a trade

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
// NIFTY weekly F&O expires every TUESDAY (getDay() === 2)
// Previously wrong: was checking Monday (getDay() === 1)
// Evidence: Jun 9 confirmed as expiry day by AngelOne/NSE
function isNiftyExpiryDay() {
  const ist = new Date(Date.now() + 330 * 60000);
  return ist.getDay() === 2; // 2 = Tuesday (NIFTY weekly expiry)
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

// ─── Price Action: PDH/PDL Rejection ──────────────────────
// The core new strategy. Enters at KNOWN LEVELS using candle rejection.
// Leading signal — anticipates reversal at key level, not confirms trend.
//
// PDH rejection (PE trade):
//   - NIFTY tests yesterday's high (PDH)
//   - 5-min candle: high >= PDH, close < PDH, upper wick > body
//   - Means: sellers rejected the level firmly
//   - Enter PE. SL = PDH + 25pts. Target = VWAP then PDL.
//
// PDL rejection (CE trade):
//   - NIFTY tests yesterday's low (PDL)
//   - 5-min candle: low <= PDL, close > PDL, lower wick > body
//   - Means: buyers defended the level firmly
//   - Enter CE. SL = PDL - 25pts. Target = VWAP then PDH.
//
// VWAP grading:
//   Grade A: signal direction CONFIRMS VWAP position (stronger)
//     PDH PE + NIFTY below VWAP = Grade A
//     PDL CE + NIFTY above VWAP = Grade A
//   Grade B: signal contradicts VWAP (skip with current capital)
//
// One trade per day. First clean rejection wins. No second guessing.
function detectPriceAction() {
  const { pdh, pdl, pdMid, pdRange, nifty, vwap,
          candles5m, indiaVix, paSignalFired, tradeCount,
          dailyPnl, lastLoss } = state;

  // ── Gate 1: Safety ──────────────────────────────────────
  if (paSignalFired) return null;          // one PA trade per day
  if (tradeCount >= 3) return null;
  if (dailyPnl <= -3000) return null;
  if (indiaVix > 19) return null;          // too volatile
  if (lastLoss && (Date.now() - lastLoss) / 60000 < 15) return null;

  // ── Gate 2: Time ────────────────────────────────────────
  const ist = istMins();
  if (ist < 565) return null;  // before 9:25 AM
  if (ist > 840) return null;  // after 2:00 PM

  // ── Gate 3: PDH/PDL must be loaded and meaningful ───────
  if (!pdh || !pdl || pdh === 0 || pdl === 0) return null;
  if (pdRange < 100) {
    // Yesterday's range too small — level not meaningful
    log('PA: pdRange ' + pdRange + ' < 100 — levels not meaningful', 'info');
    return null;
  }

  // ── Gate 4: Need at least 3 candles ─────────────────────
  if (!candles5m || candles5m.length < 3) return null;

  // ── Gate 5: Check if today opens INSIDE yesterday's range ─
  // If NIFTY opened above PDH → PDH is now support, not resistance
  // If NIFTY opened below PDL → PDL is now resistance, not support
  // On large gap days levels behave differently — skip PA strategy
  const todayO = state.todayOpen;
  if (todayO > 0) {
    if (todayO > pdh * 1.002) {
      // Opened above PDH — gap up. PDH now acts as support.
      log('PA: gap-up open above PDH — levels inverted, skipping', 'info');
      return null;
    }
    if (todayO < pdl * 0.998) {
      // Opened below PDL — gap down. PDL now acts as resistance.
      log('PA: gap-down open below PDL — levels inverted, skipping', 'info');
      return null;
    }
  }

  // ── Check most recent CLOSED candle for rejection ────────
  // candles5m[-1] = most recent closed 5-min candle
  // [timestamp, open, high, low, close, volume]
  const last = candles5m[candles5m.length - 1];
  const cOpen  = last[1], cHigh = last[2], cLow = last[3], cClose = last[4];
  const cBody  = Math.abs(cClose - cOpen);

  // ── PDH REJECTION → PE ──────────────────────────────────
  const pdhRejection = (
    cHigh >= pdh &&          // wick reached PDH level
    cClose < pdh &&          // close back inside (rejection confirmed)
    cClose < cOpen &&        // bearish candle (closed below open)
    (cHigh - cOpen) > cBody && // upper wick longer than body (long rejection wick)
    cBody >= 3               // real candle, not a doji
  );

  // ── PDL REJECTION → CE ──────────────────────────────────
  const pdlRejection = (
    cLow <= pdl &&           // wick reached PDL level
    cClose > pdl &&          // close back inside (rejection confirmed)
    cClose > cOpen &&        // bullish candle (closed above open)
    (cOpen - cLow) > cBody && // lower wick longer than body (long rejection wick)
    cBody >= 3               // real candle, not a doji
  );

  if (!pdhRejection && !pdlRejection) return null;

  // ── VWAP GRADING ─────────────────────────────────────────
  // Grade A: signal direction confirms where NIFTY sits vs VWAP
  // Grade B: signal contradicts VWAP — skip (risky with low capital)
  if (pdhRejection) {
    // PE signal. Grade A if NIFTY already below VWAP or near it.
    const gradeA = nifty <= vwap * 1.002;  // at or below VWAP
    if (!gradeA) {
      log('PA PDH reject: PE signal but NIFTY ' + Math.round(nifty - vwap) +
          'pts above VWAP — Grade B, skipping (low capital)', 'warn');
      return null;
    }
    const wickSize  = Math.round(cHigh - pdh);
    const candleRng = Math.round(cHigh - cLow);
    const distToVwap = Math.round(Math.abs(nifty - vwap));
    log('PA SIGNAL: PDH REJECTION → PE' +
        ' | PDH ₹' + pdh +
        ' | candle H₹' + cHigh + ' C₹' + cClose +
        ' | wick ' + wickSize + 'pts above PDH' +
        ' | body ' + Math.round(cBody) + 'pts' +
        ' | NIFTY ' + Math.round(nifty - vwap) + 'pts from VWAP' +
        ' | Grade A ✅', 'signal');
    state.paWatching = 'PDH';
    return {
      signal:   'PE',
      type:     'PRICE_ACTION',
      score:    80,
      paLevel:  pdh,
      paType:   'PDH_REJECTION',
      slNifty:  Math.round(pdh + 25),  // SL: 25pts above PDH
      target1:  vwap > 0 ? Math.round(vwap) : Math.round(pdMid), // VWAP or mid
      target2:  Math.round(pdl),  // second target: PDL
      reasons:  [
        'PDH rejection ₹' + pdh,
        'Wick ' + wickSize + 'pts above PDH',
        'NIFTY below VWAP (' + distToVwap + 'pts) Grade A',
      ],
      regime: 'TRENDING',
    };
  }

  if (pdlRejection) {
    // CE signal. Grade A if NIFTY already above VWAP or near it.
    const gradeA = nifty >= vwap * 0.998;  // at or above VWAP
    if (!gradeA) {
      log('PA PDL reject: CE signal but NIFTY ' + Math.round(vwap - nifty) +
          'pts below VWAP — Grade B, skipping (low capital)', 'warn');
      return null;
    }
    const wickSize   = Math.round(pdl - cLow);
    const distToVwap = Math.round(Math.abs(nifty - vwap));
    log('PA SIGNAL: PDL REJECTION → CE' +
        ' | PDL ₹' + pdl +
        ' | candle L₹' + cLow + ' C₹' + cClose +
        ' | wick ' + wickSize + 'pts below PDL' +
        ' | body ' + Math.round(cBody) + 'pts' +
        ' | NIFTY ' + Math.round(nifty - vwap) + 'pts from VWAP' +
        ' | Grade A ✅', 'signal');
    state.paWatching = 'PDL';
    return {
      signal:   'CE',
      type:     'PRICE_ACTION',
      score:    80,
      paLevel:  pdl,
      paType:   'PDL_REJECTION',
      slNifty:  Math.round(pdl - 25),  // SL: 25pts below PDL
      target1:  vwap > 0 ? Math.round(vwap) : Math.round(pdMid), // VWAP or mid
      target2:  Math.round(pdh),  // second target: PDH
      reasons:  [
        'PDL rejection ₹' + pdl,
        'Wick ' + wickSize + 'pts below PDL',
        'NIFTY above VWAP (' + distToVwap + 'pts) Grade A',
      ],
      regime: 'TRENDING',
    };
  }

  return null;
}

// ─── Mode 1: Morning Breakout (9:30 AM early entry) ────────
// The biggest change: enters at the START of a move, not the end.
// Evidence from 12 actual trades:
//   Jun10: entered 149pts into CE move at 11:00 — LOST
//   Jun10 Mode1: would have entered at 9:30 when move was 36pts old — WIN
//   Jun4:  entered 109pts into PE move at 1:15 PM — LOST
//   Jun4 Mode1: PE at 9:30 (NIFTY falling at open) — WIN
//   Jun3: NIFTY rose 239pts. Mode1 at 9:30 would catch the start.
//
// Conditions (all must be true):
//   1. Exactly 3 candles built (9:30 AM window only)
//   2. All 3 candles same colour (confirmed direction)
//   3. NIFTY 30+ pts from VWAP (real move, not noise)
//   4. Gap < 0.8% (large gap opens often reverse violently)
//   5. VIX < 19 (standard expensive-options block)
//   6. No trade yet today (Mode 1 is first trade only)
//   7. Not expiry day (use Mode 2 on expiry day)
//
// What it returns: a signal object like Signal A, or null
// What it sets: state.morningBias = 'CE'|'PE' (prevents Mode 2 counter-trade)
function detectMorningBreakout() {
  const { candles5m, nifty, vwap, todayOpen, prevClose, tradeCount,
          dailyPnl, indiaVix, isExpiryDay, morningChecked } = state;

  // Only evaluate once per day (at exactly 3-candle mark)
  if (morningChecked) return null;

  // Need exactly 3 candles — the 9:30 AM window
  // More than 3 means the move is already developing, Mode 2 handles it
  if (!candles5m || candles5m.length !== 3) return null;

  // Mark as checked — won't evaluate again today
  state.morningChecked = true;

  // Safety gates
  if (tradeCount >= 3) return null;
  if (dailyPnl <= -3000) return null;
  if (indiaVix > 19) { log('Mode1 blocked: VIX ' + indiaVix + ' > 19', 'info'); return null; }
  if (isExpiryDay) { log('Mode1 blocked: expiry day — use Mode 2', 'info'); return null; }

  // Gap check: no extreme gap opens
  if (prevClose && todayOpen) {
    const gapPct = Math.abs((todayOpen - prevClose) / prevClose * 100);
    if (gapPct >= 0.8) {
      log('Mode1 blocked: gap ' + gapPct.toFixed(2) + '% >= 0.8% — gap opens often reverse', 'info');
      state.morningBias = null; // no bias on gap days
      return null;
    }
  }

  // All 3 candles same colour
  const green3 = candles5m.filter(c => c[4] > c[1]).length;
  const red3   = candles5m.filter(c => c[4] < c[1]).length;
  const allGreen = green3 === 3;
  const allRed   = red3   === 3;
  if (!allGreen && !allRed) {
    log('Mode1: mixed candles (green=' + green3 + ' red=' + red3 + ') — no morning bias', 'info');
    state.morningBias = null;
    return null;
  }

  // NIFTY distance from VWAP: minimum 30 points
  if (!vwap || vwap === 0) return null;
  const dist = nifty - vwap;
  const absDist = Math.abs(dist);
  if (absDist < 30) {
    const direction = allGreen ? 'CE' : 'PE';
    log('Mode1: ' + direction + ' candles but dist ' + Math.round(absDist) + 'pts < 30 — too close to VWAP', 'info');
    state.morningBias = direction; // record bias but don't trade
    return null;
  }

  // Direction confirmed
  const signal = allGreen ? 'CE' : 'PE';
  const directionOk = signal === 'CE' ? dist > 0 : dist < 0;
  if (!directionOk) {
    // Candles say CE but NIFTY is below VWAP — contradiction
    log('Mode1: candle colour contradicts VWAP position — skip', 'info');
    state.morningBias = null;
    return null;
  }

  // Calculate ATR from 3 candles (minimum check — need real movement)
  const candle_ranges = candles5m.map(c => c[2] - c[3]); // high - low
  const avg_range = candle_ranges.reduce((a,b) => a+b, 0) / candle_ranges.length;
  if (avg_range < 8) {
    log('Mode1: avg candle range ' + Math.round(avg_range) + 'pts too small — not enough movement', 'info');
    state.morningBias = signal;
    return null;
  }

  // All conditions met — Morning Breakout signal
  state.morningBias = signal;
  log('Mode1 MORNING BREAKOUT: ' + signal + ' | 3/' + (allGreen?'3 green':'3 red') + ' candles' +
      ' | dist ' + Math.round(absDist) + 'pts from VWAP' +
      ' | avg range ' + Math.round(avg_range) + 'pts', 'signal');

  return {
    signal,
    type:    'MORNING',
    score:   70,  // high confidence — all 3 checks passed
    reasons: [
      (allGreen?'3/3':'3/3') + (allGreen?' green':' red') + ' candles',
      'Dist ' + Math.round(absDist) + 'pts from VWAP',
      'Range ' + Math.round(avg_range) + 'pts/candle',
    ],
    regime: 'TRENDING',
    details: { dist: absDist, avgRange: avg_range, green: green3, red: red3 },
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

  // Daily bias check: if Mode 1 established morning direction, Mode 2
  // only trades in the SAME direction. No counter-trend trades same day.
  // Evidence: Jun4 NIFTY fell at open (PE day) but we entered PE at 1:15 PM.
  // If Mode 1 had set morningBias=PE, Mode 2 would confirm PE not flip to CE.
  const bias = state.morningBias;
  if (ceScore >= 58 && sep >= 15) {
    if (bias === 'PE') {
      reasons.push('BIAS BLOCK: morning bias PE — no CE trade today');
      return { signal: null, reason: 'Morning bias PE — CE blocked', reasons, regime, score: ceScore, details };
    }
    return { signal: 'CE', score: Math.min(ceScore, 97), reasons, regime, details };
  }
  if (peScore >= 58 && sep >= 15) {
    if (bias === 'CE') {
      reasons.push('BIAS BLOCK: morning bias CE — no PE trade today');
      return { signal: null, reason: 'Morning bias CE — PE blocked', reasons, regime, score: peScore, details };
    }
    return { signal: 'PE', score: Math.min(peScore, 97), reasons, regime, details };
  }

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
      // todayOpen must use nd.ohlc.open (NSE auction settlement price)
      // Evidence from Jun 8: auction settled ₹23,157. First candle = ₹23,102.
      // Gap check should ask: 'is NIFTY holding the gap vs official open?'
      // Using first candle (₹23,102) caused 'gap reversed' all day when
      // NIFTY was above ₹23,102 but BELOW real open ₹23,157 → wrong -10 penalty.
      // 
      // SAFETY: only set when candles confirm today's date is loaded
      // This prevents yesterday's stale ohlc.open from setting todayOpen
      // on day boundary before new candles arrive.
      const istNow = (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 330) % 1440;
      if (istNow >= 555 && !state.todayOpen && nd.ohlc?.open) {
        // Only accept ohlc.open when we have today's candles confirming market is open
        // OR when it's past 9:25 AM and market is definitely open
        const marketConfirmed = state.candles5m && state.candles5m.length > 0;
        const timeConfirmed   = istNow >= 565; // past 9:25 AM
        if (marketConfirmed || timeConfirmed) {
          state.todayOpen = nd.ohlc.open;
          const source = marketConfirmed ? 'candles confirm' : 'time confirms';
          log('Today open set: ₹' + state.todayOpen + ' (OHLC API, ' + source + ')', 'info');
        }
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
    if (pc.length >= 2) {
      state.prevClose = pc[1][4];
      // Store PDH and PDL from yesterday's candle
      // pc[1] = [timestamp, open, high, low, close, volume]
      // These are the key price action levels for today's session
      const newPdh = pc[1][2];  // yesterday's high
      const newPdl = pc[1][3];  // yesterday's low
      const newPdDate = new Date(pc[1][0]).toISOString().slice(0,10);
      // Only update if date changed (prevents overwriting during session)
      if (newPdDate !== state.pdDate && newPdh > 0 && newPdl > 0) {
        state.pdh    = Math.round(newPdh * 100) / 100;
        state.pdl    = Math.round(newPdl * 100) / 100;
        state.pdMid  = Math.round((newPdh + newPdl) / 2 * 100) / 100;
        state.pdRange = Math.round(newPdh - newPdl);
        state.pdDate  = newPdDate;
        log('PA levels: PDH ₹' + state.pdh + ' PDL ₹' + state.pdl +
            ' Mid ₹' + state.pdMid + ' Range ' + state.pdRange + 'pts', 'info');
      }
    }

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
    // On expiry day (Tuesday): skip today's expiry — those options expire in hours
    // and have near-zero time value (₹50-80 range) making SL too tight.
    // Use next week's expiry instead: options are ₹150-200, normal risk profile.
    // Evidence: Jun 9 expiry day — all options ₹59-77, blocked 22 signals.
    if (state.isExpiryDay) {
      const nextExpiry = dates.find(d => d > today);
      if (nextExpiry) {
        log('Expiry day: using next week expiry ' + nextExpiry + ' (skipping today\'s)', 'info');
        return nextExpiry;
      }
    }
    return dates.find(d => d >= today) || null;
  } catch(e) { return null; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enterTrade(signal) {
  if (state.inTrade || state.position) return;
  state.inTrade = true;

  try {
    const isCrossover   = signal.type === 'CROSSOVER';
    const isPriceAction = signal.type === 'PRICE_ACTION';

    // ── STEP 0: DISTANCE CHECK — block entries on exhausted moves ──
    // Skip distance check for Price Action trades:
    // PA enters AT a level after rejection — the move hasn't started yet.
    // Distance check would wrongly block valid PA entries.
    if (!isPriceAction) {
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
    } // end distance check (skipped for PRICE_ACTION)

    // ── STEP 1: IV CHECK ────────────────────────────────────────
    // Morning (Mode 1): 20% target — NIFTY only needs 40-60pts more
    // Crossover (Signal B): 20% target, 15% SL
    // Signal A (Mode 2): VIX-adjusted 25-40% target
    const isMorning = signal.type === 'MORNING';
    let tradeConfig;
    if (isPriceAction) {
      // PA trade: use moderate SL (18%) and target (25%)
      // The real SL/target for PA is NIFTY-based (stored in signal.slNifty)
      // We use option % as a backstop in case NIFTY monitor has issues
      // Primary exit logic is in monitorPosition using signal.slNifty level
      tradeConfig = { allow: true, targetMult: 1.25, slMult: 0.82,
                      label: 'PRICE_ACTION (25% target, 18% SL backstop)' };
      if (state.indiaVix > 19) {
        log('IV BLOCK [PA]: VIX ' + state.indiaVix + ' > 19', 'warn');
        state.inTrade = false; return;
      }
      log('IV CHECK [PA]: VIX ' + state.indiaVix + ' — ' + tradeConfig.label, 'info');
    } else if (isMorning) {
      // Morning breakout: 20% target (needs only ~40pts NIFTY move)
      // 20% SL matches target for 1:1 R:R minimum
      // Evidence: Jun10 mode1 entry at 9:30 → 8% gain available vs 35% needed
      tradeConfig = { allow: true, targetMult: 1.20, slMult: 0.80,
                      label: 'MORNING mode (20% target, 20% SL)' };
      if (state.indiaVix > 19) {
        log('IV BLOCK [morning]: VIX ' + state.indiaVix + ' > 19', 'warn');
        state.inTrade = false; return;
      }
      log('IV CHECK [morning]: VIX ' + state.indiaVix + ' — ' + tradeConfig.label, 'info');
    } else if (isCrossover) {
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

    // Max hold:
    //   Morning (Mode 1):  60 min — must exit by 10:30 AM
    //   Crossover:         45 min
    //   Expiry day:        45 min
    //   Signal A (Mode 2): no limit
    const maxHoldMs = isMorning    ? 60 * 60 * 1000 :
                      isCrossover  ? 45 * 60 * 1000 :
                      state.isExpiryDay ? 45 * 60 * 1000 : null;
    const tradeTag  = isMorning ? 'MORNING' : isCrossover ? 'CROSSOVER' : isPriceAction ? 'PRICE_ACTION' : 'MOMENTUM';

    state.position = {
      instrument: 'NIFTY', strike: Number(match.strike_price),
      direction: signal.signal, entryPrice: avgPrice, currentPrice: avgPrice,
      instrumentKey: realKey, expiry, qty: LOT, sl, target: tgt,
      trailLocked: false, orderId, entryTime: Date.now(),
      maxHoldMs, isExpiryDay: state.isExpiryDay,
      vixAtEntry: state.indiaVix, targetMult: tradeConfig.targetMult,
      tradeTag,
      // Price Action: NIFTY-level SL and target (level-to-level)
      paSlNifty:    isPriceAction ? signal.slNifty  : null,
      paTarget1:    isPriceAction ? signal.target1  : null,
      paTarget2:    isPriceAction ? signal.target2  : null,
      paLevel:      isPriceAction ? signal.paLevel  : null,
      paType:       isPriceAction ? signal.paType   : null,
    };
    state.tradeCount++;
    if (isMorning) state.morningSignalFired = true;
    if (isPriceAction) state.paSignalFired = true;
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
    state.morningBias   = null;
    state.morningChecked = false;
    state.morningSignalFired = false;
    state.paSignalFired = false;
    state.paWatching    = null;
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

  // ── PRICE ACTION: PDH/PDL Rejection — HIGHEST PRIORITY ────
  // Runs first every scan. Checks last closed 5-min candle for
  // rejection at PDH (→ PE) or PDL (→ CE). One trade per day.
  if (!state.position && !state.inTrade) {
    const paResult = detectPriceAction();
    if (paResult) {
      log('PA-SIGNAL: ' + paResult.paType + ' → ' + paResult.signal +
          ' | level ₹' + paResult.paLevel +
          ' | SL NIFTY ₹' + paResult.slNifty +
          ' | T1 ₹' + paResult.target1 +
          ' | ' + paResult.reasons.join(' | '), 'signal');
      await enterTrade(paResult);
      return;  // PA fired — Mode 1 and Mode 2 don't run today
    }
    // Log PA watching status every scan when near a level
    // Only when paSignalFired=false — silent after PA trade fires today
    if (state.pdh && state.pdl && state.nifty > 0 && !state.paSignalFired) {
      const distPDH = Math.round(Math.abs(state.nifty - state.pdh));
      const distPDL = Math.round(Math.abs(state.nifty - state.pdl));
      if (distPDH <= 30 || distPDL <= 30) {
        const near = distPDH <= distPDL ? 'PDH' : 'PDL';
        const dist = Math.min(distPDH, distPDL);
        log('PA watching: ' + near + ' ₹' + (near==='PDH'?state.pdh:state.pdl) +
            ' — NIFTY ' + dist + 'pts away', 'info');
      }
    }
  }

  // ── Mode 1: Morning Breakout (9:30 AM — fires when candles === 3) ─
  // Priority: runs before Mode 2. Enters at the START of the morning move.
  // Only fires once per day (morningChecked flag prevents repeat evaluation)
  if (!state.position && !state.inTrade) {
    const morningResult = detectMorningBreakout();
    if (morningResult) {
      log('MODE1-MORNING: ' + morningResult.signal + ' 70% | ' + morningResult.reasons.join(', '), 'signal');
      await enterTrade(morningResult);
      return;  // Mode 1 fired — don't check Mode 2 this scan
    }
  }

  // ── Mode 2: Signal A momentum system (score >= 58) ──────────
  // Only fires if Mode 1 did not fire (or Mode 1 had no signal)
  // Respects morningBias — won't trade counter to morning direction
  if (result.signal && !state.position && !state.inTrade) {
    log('MODE2-MOMENTUM: ' + result.signal + ' ' + result.score + '% | ' + result.reasons.slice(0, 3).join(', '), 'signal');
    await enterTrade(result);
    return;
  }

  // ── Signal B: VWAP Crossover — DISABLED
  // Re-enable by removing 'false &&'
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

      // ── Price Action: NIFTY-level SL and Target ────────────
      // For PA trades, we also check if NIFTY has crossed the
      // level-based SL or reached the VWAP target (level-to-level)
      if (pos.paSlNifty !== null && state.nifty > 0) {
        const nifty = state.nifty;
        // PE trade: SL if NIFTY rises above paSlNifty (above PDH+25)
        // CE trade: SL if NIFTY falls below paSlNifty (below PDL-25)
        const niftySLHit = pos.direction === 'PE'
          ? nifty >= pos.paSlNifty
          : nifty <= pos.paSlNifty;
        if (niftySLHit) {
          log('PA SL HIT (NIFTY level): NIFTY ₹' + nifty +
              (pos.direction==='PE' ? ' ≥ ' : ' ≤ ') +
              ' SL level ₹' + pos.paSlNifty, 'warn');
          await exitPosition(pos, ltp, 'PA_SL_NIFTY');
          return;
        }
        // PA Target 1 (VWAP-based) REMOVED — Jun12 evidence:
        // Grade A PDH-PE requires NIFTY already below VWAP at entry.
        // So paTarget1=VWAP was already met the instant monitor ran (9s after entry).
        // Fix: use standard % target (25%) and trail (+15%) for PA exit.
        // NIFTY-level SL (PDH+25 / PDL-25) still active above.
      }

      // ── Standard trail and SL (backstop) ────────────────────
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
      // Price Action levels
      pdh:          state.pdh,
      pdl:          state.pdl,
      pdMid:        state.pdMid,
      pdRange:      state.pdRange,
      paSignalFired:state.paSignalFired,
      paWatching:   state.paWatching,
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
