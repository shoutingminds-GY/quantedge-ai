import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONSTANTS & CONFIG ────────────────────────────────────────────────────────
const BROKERS = ["Zerodha Kite", "Upstox", "Angel One SmartAPI"];
const STRATEGIES = ["Opening Range Breakout","VWAP Bounce","Momentum Scalp","OI Buildup","Trend Continuation"];
const INSTRUMENTS = ["NIFTY","BANKNIFTY"];

// ─── UTILITY ───────────────────────────────────────────────────────────────────
const fmt = (n, d=2) => Number(n).toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPnl = (n) => {
  const v = fmt(Math.abs(n));
  return n >= 0 ? `+₹${v}` : `-₹${v}`;
};
const randBetween = (a,b) => Math.random()*(b-a)+a;
const randomInt = (a,b) => Math.floor(randBetween(a,b));
const pick = arr => arr[randomInt(0,arr.length)];

// ─── SIMULATED MARKET ENGINE ───────────────────────────────────────────────────
function createMarketEngine() {
  let nifty = 22480 + randBetween(-200,200);
  let banknifty = 48200 + randBetween(-400,400);
  let vwapNifty = nifty - randBetween(-30,30);
  let vwapBNF = banknifty - randBetween(-60,60);
  let trend = pick(["BULLISH","BEARISH","SIDEWAYS"]);
  let volatility = randBetween(0.8,1.8);

  return {
    tick() {
      const delta = randBetween(-25,25) * volatility;
      const deltaBNF = randBetween(-50,60) * volatility;
      nifty = Math.max(20000, nifty + delta);
      banknifty = Math.max(42000, banknifty + deltaBNF);
      vwapNifty += (nifty - vwapNifty) * 0.05;
      vwapBNF += (banknifty - vwapBNF) * 0.05;
      volatility = Math.max(0.5, Math.min(3.0, volatility + randBetween(-0.05,0.05)));
      if (Math.random() < 0.02) trend = pick(["BULLISH","BEARISH","SIDEWAYS"]);
      return this.snapshot();
    },
    snapshot() {
      return { nifty, banknifty, vwapNifty, vwapBNF, trend, volatility };
    }
  };
}

function generateOptionsChain(spot, instrument) {
  const atm = Math.round(spot/100)*100;
  const strikes = [-300,-200,-100,0,100,200,300].map(d => atm+d);
  return strikes.map(strike => {
    const moneyness = spot - strike;
    const ceOI = Math.round(randBetween(50000,500000));
    const peOI = Math.round(randBetween(50000,500000));
    const ceVol = Math.round(randBetween(1000,30000));
    const peVol = Math.round(randBetween(1000,30000));
    const cePrem = Math.max(1, moneyness > 0 ? moneyness * 0.95 + randBetween(5,50) : randBetween(2,30));
    const pePrem = Math.max(1, moneyness < 0 ? -moneyness * 0.95 + randBetween(5,50) : randBetween(2,30));
    return { strike, ceOI, peOI, ceVol, peVol, cePrem: Math.round(cePrem), pePrem: Math.round(pePrem) };
  });
}

// ─── AI ANALYSIS ENGINE ────────────────────────────────────────────────────────
function analyzeMarket(market, chain, config) {
  const opportunities = [];

  INSTRUMENTS.forEach(inst => {
    const spot = inst === "NIFTY" ? market.nifty : market.banknifty;
    const vwap = inst === "NIFTY" ? market.vwapNifty : market.vwapBNF;
    const atmChain = chain.find(c => Math.abs(c.strike - spot) < 200);
    if (!atmChain) return;

    const reasons = [];
    let score = 40;
    let direction = null;
    let strategy = null;

    // VWAP analysis
    const vwapDiff = spot - vwap;
    if (Math.abs(vwapDiff) > 20) {
      if (vwapDiff > 0 && market.trend === "BULLISH") {
        reasons.push("Price trading above VWAP with bullish trend confirmation");
        score += 12; direction = "CE";
      } else if (vwapDiff < 0 && market.trend === "BEARISH") {
        reasons.push("Price trading below VWAP with bearish trend confirmation");
        score += 12; direction = "PE";
      }
    }

    // OI analysis
    if (atmChain.ceOI > 300000) {
      reasons.push(`Call OI spike at ${atmChain.strike} strike (${fmt(atmChain.ceOI,0)} lots) — significant CE buildup`);
      score += 8;
    }
    if (atmChain.peOI > 300000) {
      reasons.push(`Put OI spike at ${atmChain.strike} strike (${fmt(atmChain.peOI,0)} lots) — significant PE buildup`);
      score += 8;
    }

    // Volume analysis
    if (atmChain.ceVol > 15000) {
      reasons.push(`Unusual CE volume: ${fmt(atmChain.ceVol,0)} — institutional activity detected`);
      score += 10; if (!direction) direction = "CE";
    }
    if (atmChain.peVol > 15000) {
      reasons.push(`Unusual PE volume: ${fmt(atmChain.peVol,0)} — institutional activity detected`);
      score += 10; if (!direction) direction = "PE";
    }

    // Trend momentum
    if (market.trend === "BULLISH") {
      reasons.push("Broader market momentum: BULLISH — upside bias for calls");
      score += 7; if (!direction) direction = "CE";
      strategy = Math.random() > 0.5 ? "Opening Range Breakout" : "Trend Continuation";
    } else if (market.trend === "BEARISH") {
      reasons.push("Broader market momentum: BEARISH — downside bias for puts");
      score += 7; if (!direction) direction = "PE";
      strategy = Math.random() > 0.5 ? "Momentum Scalp" : "Trend Continuation";
    } else {
      reasons.push("Market in consolidation — VWAP bounce strategy applicable");
      strategy = "VWAP Bounce";
      score += 3;
    }

    // Volatility check
    if (market.volatility > 2.0) {
      reasons.push(`⚠ Elevated volatility (${market.volatility.toFixed(2)}x) — position sizing reduced`);
      score -= 15;
    } else {
      reasons.push(`Volatility within normal range (${market.volatility.toFixed(2)}x) — normal position sizing`);
      score += 5;
    }

    if (!strategy) strategy = pick(STRATEGIES);
    if (!direction) direction = Math.random() > 0.5 ? "CE" : "PE";

    const strike = direction === "CE" ? Math.round(spot/100)*100 + 100 : Math.round(spot/100)*100 - 100;
    const premium = direction === "CE"
      ? (chain.find(c => c.strike === strike)?.cePrem || randomInt(20,80))
      : (chain.find(c => c.strike === strike)?.pePrem || randomInt(20,80));

    const lotSize = inst === "NIFTY" ? 50 : 15;
    const riskPerTrade = config.capital * (config.riskPct/100);
    const maxLots = Math.max(1, Math.floor(riskPerTrade / (premium * lotSize * 0.5)));
    const qty = Math.min(maxLots, 5) * lotSize;

    const sl = Math.round(premium * 0.65);
    const target = Math.round(premium * 1.45);

    if (score >= 55 && reasons.length >= 3) {
      opportunities.push({
        id: Date.now() + Math.random(),
        instrument: inst,
        strike,
        direction,
        type: `${inst} ${strike} ${direction}`,
        premium,
        sl,
        target,
        qty,
        strategy,
        score: Math.min(95, Math.round(score)),
        reasons,
        timestamp: new Date(),
        status: "PENDING"
      });
    }
  });

  return opportunities;
}

// ─── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function TradingPlatform() {
  // Config state
  const [config, setConfig] = useState({
    capital: 100000, riskPct: 1, maxDailyLoss: 3000,
    minTradesPerDay: 1, maxTradesPerDay: 10,
    broker: BROKERS[0], apiKey: "", secretKey: "",
    autoTrade: false, trailingStop: true
  });
  const [todayTradeCount, setTodayTradeCount] = useState(0);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginForm, setLoginForm] = useState({ username:"", password:"" });
  const [loginError, setLoginError] = useState("");

  // Market state
  const marketRef = useRef(createMarketEngine());
  const [market, setMarket] = useState(marketRef.current.snapshot());
  const [chain, setChain] = useState(generateOptionsChain(22480,"NIFTY"));
  const [bnfChain, setBnfChain] = useState(generateOptionsChain(48200,"BANKNIFTY"));

  // Trading state
  const [opportunities, setOpportunities] = useState([]);
  const [trades, setTrades] = useState([]);
  const [openPositions, setOpenPositions] = useState([]);
  const [dailyPnl, setDailyPnl] = useState(0);
  const [weeklyPnl, setWeeklyPnl] = useState(randBetween(-5000,15000));
  const [systemStatus, setSystemStatus] = useState("ACTIVE");
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [logs, setLogs] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [configOpen, setConfigOpen] = useState(false);

  // Analytics
  const [analytics, setAnalytics] = useState({
    totalTrades:0, wins:0, losses:0, totalPnl:0,
    avgWin:0, avgLoss:0, strategyStats:{}
  });

  const addLog = useCallback((msg, level="INFO") => {
    setLogs(prev => [{
      id: Date.now()+Math.random(), time: new Date().toLocaleTimeString("en-IN"),
      msg, level
    }, ...prev].slice(0,100));
  }, []);

  const addAlert = useCallback((msg, type="warning") => {
    const id = Date.now();
    setAlerts(prev => [{id, msg, type}, ...prev].slice(0,5));
    setTimeout(() => setAlerts(prev => prev.filter(a => a.id !== id)), 5000);
  }, []);

  // ── Market tick ──
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(() => {
      const snap = marketRef.current.tick();
      setMarket(snap);
      setChain(generateOptionsChain(snap.nifty, "NIFTY"));
      setBnfChain(generateOptionsChain(snap.banknifty, "BANKNIFTY"));

      // Update open positions PnL
      setOpenPositions(prev => prev.map(p => {
        const currentPrem = Math.max(1, p.premium + randBetween(-8,8));
        const pnl = (currentPrem - p.premium) * p.qty * (p.direction === "CE" ? 1 : -1) +
          Math.abs(currentPrem - p.premium) * p.qty;
        return {...p, currentPrem, unrealizedPnl: Math.round((currentPrem - p.entryPrice) * p.qty)};
      }));

      // Check volatility
      if (snap.volatility > 2.5) {
        setSystemStatus("PAUSED");
        addAlert("System PAUSED: Abnormal volatility detected ("+snap.volatility.toFixed(2)+"x)", "danger");
        addLog("Trading halted — volatility threshold breached: "+snap.volatility.toFixed(2)+"x", "WARN");
      } else if (systemStatus === "PAUSED" && snap.volatility < 2.0) {
        setSystemStatus("ACTIVE");
        addLog("Trading resumed — volatility normalized", "INFO");
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [authenticated, systemStatus]);

  // ── AI Analysis loop ──
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(() => {
      if (systemStatus !== "ACTIVE") return;
      if (Math.abs(dailyPnl) >= config.maxDailyLoss) {
        setSystemStatus("HALTED");
        addAlert("Daily loss limit reached — trading halted", "danger");
        addLog(`Daily loss limit of ₹${config.maxDailyLoss} reached. System halted.`, "ERROR");
        return;
      }
      if (todayTradeCount >= config.maxTradesPerDay) {
        addLog(`Max trades/day reached (${config.maxTradesPerDay}). No new signals generated.`, "WARN");
        return;
      }
      const allChain = [...chain, ...bnfChain];
      const opps = analyzeMarket(market, allChain, config);
      if (opps.length > 0) {
        setOpportunities(prev => [...opps, ...prev].slice(0,10));
        opps.forEach(o => addLog(`AI Signal: ${o.type} | Score ${o.score}% | Strategy: ${o.strategy}`, "SIGNAL"));
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [authenticated, market, chain, bnfChain, systemStatus, dailyPnl, config]);

  // ── Auto-trade ──
  useEffect(() => {
    if (!authenticated || !config.autoTrade || systemStatus !== "ACTIVE") return;
    const interval = setInterval(() => {
      setOpportunities(prev => {
        const pending = prev.filter(o => o.status === "PENDING" && o.score >= 65);
        if (pending.length === 0) return prev;
        const opp = pending[0];
        executeTrade(opp);
        return prev.map(o => o.id === opp.id ? {...o, status:"EXECUTED"} : o);
      });
    }, 6000);
    return () => clearInterval(interval);
  }, [authenticated, config.autoTrade, systemStatus]);

  // ── Close positions simulation ──
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(() => {
      setOpenPositions(prev => {
        if (prev.length === 0) return prev;
        const updated = [...prev];
        const idx = randomInt(0, updated.length);
        const pos = updated[idx];
        if (!pos) return prev;
        const exitPrem = Math.max(1, pos.entryPrice + randBetween(-30,40));
        const pnl = Math.round((exitPrem - pos.entryPrice) * pos.qty);
        const closedTrade = {
          ...pos, exitPrice: exitPrem, exitTime: new Date(),
          pnl, status: pnl > 0 ? "WIN" : "LOSS"
        };
        setTrades(t => [closedTrade, ...t]);
        setDailyPnl(d => d + pnl);
        setWeeklyPnl(w => w + pnl);
        updateAnalytics(closedTrade);
        addLog(`CLOSED: ${pos.type} | Entry ₹${pos.entryPrice} → Exit ₹${exitPrem} | PnL: ${fmtPnl(pnl)}`, pnl > 0 ? "WIN" : "LOSS");
        if (pnl > 500) addAlert(`🎯 Profitable exit: ${pos.type} +₹${fmt(pnl)}`, "success");
        updated.splice(idx, 1);
        return updated;
      });
    }, 12000);
    return () => clearInterval(interval);
  }, [authenticated]);

  const executeTrade = useCallback((opp) => {
    const trade = {
      ...opp, id: `TRD-${Date.now()}`,
      entryTime: new Date(), entryPrice: opp.premium,
      currentPrem: opp.premium, unrealizedPnl: 0,
      status: "OPEN"
    };
    setOpenPositions(prev => [...prev, trade]);
    setTodayTradeCount(c => c + 1);
    addLog(`EXECUTED: ${opp.type} | Entry ₹${opp.premium} | SL ₹${opp.sl} | Target ₹${opp.target} | Qty ${opp.qty}`, "TRADE");
    addAlert(`✅ Trade placed: ${opp.type} @ ₹${opp.premium}`, "success");
  }, [addLog, addAlert]);

  const updateAnalytics = useCallback((trade) => {
    setAnalytics(prev => {
      const wins = prev.wins + (trade.pnl > 0 ? 1 : 0);
      const losses = prev.losses + (trade.pnl <= 0 ? 1 : 0);
      const total = wins + losses;
      const totalPnl = prev.totalPnl + trade.pnl;
      const stratStats = {...prev.strategyStats};
      if (!stratStats[trade.strategy]) stratStats[trade.strategy] = {trades:0,pnl:0,wins:0};
      stratStats[trade.strategy].trades++;
      stratStats[trade.strategy].pnl += trade.pnl;
      if (trade.pnl > 0) stratStats[trade.strategy].wins++;
      return { totalTrades:total, wins, losses, totalPnl,
        avgWin: wins > 0 ? (prev.avgWin*(wins-1) + (trade.pnl>0?trade.pnl:0))/wins : 0,
        avgLoss: losses > 0 ? (prev.avgLoss*(losses-1) + (trade.pnl<=0?trade.pnl:0))/losses : 0,
        strategyStats: stratStats };
    });
  }, []);

  // ─── LOGIN ───────────────────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div style={{fontFamily:"'IBM Plex Mono', monospace",background:"#020c18",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",color:"#e2e8f0"}}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@300;400;500;600;700&display=swap');
        .glow{text-shadow:0 0 20px #00d4ff,0 0 40px #00d4ff44;}
        .border-glow{box-shadow:0 0 0 1px #00d4ff33,0 4px 30px #00d4ff11;}
        .inp{background:#0a1628;border:1px solid #1e3a5f;color:#e2e8f0;padding:10px 14px;border-radius:6px;width:100%;outline:none;font-family:'IBM Plex Mono',monospace;font-size:13px;}
        .inp:focus{border-color:#00d4ff;box-shadow:0 0 0 2px #00d4ff22;}
        .btn-primary{background:linear-gradient(135deg,#00d4ff,#0077ff);color:#020c18;border:none;padding:12px 28px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-weight:700;cursor:pointer;width:100%;font-size:14px;letter-spacing:1px;transition:all 0.2s;}
        .btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 20px #00d4ff44;}
        `}</style>
        <div style={{width:400,padding:40,background:"#040f1f",borderRadius:12,border:"1px solid #1e3a5f",boxShadow:"0 20px 60px #00000080"}}>
          <div style={{textAlign:"center",marginBottom:32}}>
            <div style={{fontSize:11,letterSpacing:4,color:"#00d4ff",marginBottom:8}}>QUANTEDGE AI</div>
            <div className="glow" style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:26,fontWeight:700,marginBottom:6}}>Options Trading</div>
            <div style={{fontSize:11,color:"#4a6fa5",letterSpacing:2}}>NIFTY · BANKNIFTY · AUTOMATED</div>
          </div>
          <div style={{marginBottom:16}}>
            <label style={{fontSize:11,color:"#4a6fa5",letterSpacing:1,display:"block",marginBottom:6}}>USERNAME</label>
            <input className="inp" placeholder="Enter username" value={loginForm.username}
              onChange={e => setLoginForm(p=>({...p,username:e.target.value}))} />
          </div>
          <div style={{marginBottom:24}}>
            <label style={{fontSize:11,color:"#4a6fa5",letterSpacing:1,display:"block",marginBottom:6}}>PASSWORD</label>
            <input className="inp" type="password" placeholder="Enter password" value={loginForm.password}
              onChange={e => setLoginForm(p=>({...p,password:e.target.value}))}
              onKeyDown={e => e.key==="Enter" && (loginForm.username && loginForm.password ? setAuthenticated(true) : setLoginError("Invalid credentials"))} />
          </div>
          {loginError && <div style={{color:"#ff4444",fontSize:12,marginBottom:12,textAlign:"center"}}>{loginError}</div>}
          <button className="btn-primary" onClick={() => {
            if (loginForm.username && loginForm.password) { setAuthenticated(true); addLog("User authenticated — platform initialized","INFO"); }
            else setLoginError("Please enter credentials");
          }}>ENTER PLATFORM →</button>
          <div style={{textAlign:"center",marginTop:16,fontSize:11,color:"#2a4a6a"}}>Demo: any username + password</div>
        </div>
      </div>
    );
  }

  // ─── MAIN DASHBOARD ───────────────────────────────────────────────────────────
  const winRate = analytics.totalTrades > 0 ? Math.round(analytics.wins/analytics.totalTrades*100) : 0;
  const riskExposure = openPositions.reduce((s,p) => s + p.entryPrice*p.qty, 0);
  const capital = config.capital + dailyPnl;
  const drawdownPct = Math.abs(Math.min(0,dailyPnl))/config.capital*100;
  const isHalted = systemStatus === "HALTED" || systemStatus === "PAUSED";

  return (
    <div style={{fontFamily:"'IBM Plex Mono',monospace",background:"#020c18",minHeight:"100vh",color:"#c8d8f0",fontSize:13}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;scrollbar-width:thin;scrollbar-color:#1e3a5f #020c18;}
        .card{background:#040f1f;border:1px solid #0e2240;border-radius:10px;padding:20px;}
        .card-sm{background:#040f1f;border:1px solid #0e2240;border-radius:8px;padding:14px;}
        .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:1px;}
        .badge-bull{background:#00ff9911;color:#00ff99;border:1px solid #00ff9922;}
        .badge-bear{background:#ff444411;color:#ff4444;border:1px solid #ff444422;}
        .badge-side{background:#ffbb0011;color:#ffbb00;border:1px solid #ffbb0022;}
        .badge-win{background:#00ff9911;color:#00ff99;}
        .badge-loss{background:#ff444411;color:#ff4444;}
        .badge-open{background:#00d4ff11;color:#00d4ff;border:1px solid #00d4ff22;}
        .tab{padding:8px 18px;border-radius:6px;cursor:pointer;font-size:11px;letter-spacing:1.5px;font-weight:600;border:none;transition:all 0.15s;}
        .tab-active{background:#00d4ff;color:#020c18;}
        .tab-inactive{background:transparent;color:#4a6fa5;}
        .tab-inactive:hover{color:#00d4ff;background:#00d4ff11;}
        .opp-card{background:#040f1f;border:1px solid #0e2240;border-radius:8px;padding:14px;margin-bottom:10px;cursor:pointer;transition:all 0.15s;}
        .opp-card:hover{border-color:#00d4ff44;background:#051525;}
        .opp-card.selected{border-color:#00d4ff;background:#051a2e;}
        .inp{background:#0a1628;border:1px solid #1e3a5f;color:#e2e8f0;padding:8px 12px;border-radius:6px;outline:none;font-family:'IBM Plex Mono',monospace;font-size:12px;}
        .inp:focus{border-color:#00d4ff;}
        .btn{padding:8px 16px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;letter-spacing:1px;cursor:pointer;border:none;transition:all 0.15s;}
        .btn-primary{background:linear-gradient(135deg,#00d4ff,#0077ff);color:#020c18;}
        .btn-danger{background:#ff444422;color:#ff4444;border:1px solid #ff444433;}
        .btn-success{background:#00ff9922;color:#00ff99;border:1px solid #00ff9933;}
        .btn-outline{background:transparent;color:#4a6fa5;border:1px solid #1e3a5f;}
        .btn:hover{transform:translateY(-1px);filter:brightness(1.1);}
        .scroll{overflow-y:auto;max-height:340px;}
        .glow-text{text-shadow:0 0 12px currentColor;}
        .pulse{animation:pulse 2s infinite;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        .shimmer{position:relative;overflow:hidden;}
        .progress-bar{height:4px;border-radius:2px;background:#0e2240;}
        .progress-fill{height:100%;border-radius:2px;transition:width 0.3s;}
        .log-entry{padding:6px 10px;border-bottom:1px solid #0a1a2e;font-size:11px;display:flex;gap:10px;}
        .log-TRADE{color:#00d4ff;}
        .log-SIGNAL{color:#a78bfa;}
        .log-WIN{color:#00ff99;}
        .log-LOSS{color:#ff4444;}
        .log-WARN{color:#ffbb00;}
        .log-ERROR{color:#ff4444;font-weight:600;}
        .log-INFO{color:#4a6fa5;}
        .chain-row{display:grid;grid-template-columns:1fr 80px 80px 90px 80px 80px 1fr;gap:4px;padding:5px 8px;font-size:11px;border-bottom:1px solid #050e1c;}
        .chain-row:hover{background:#051525;}
        .chain-atm{background:#051a2e !important;border-left:2px solid #00d4ff;}
        .metric-card{background:#040f1f;border:1px solid #0e2240;border-radius:8px;padding:16px;}
        .spark{display:flex;align-items:flex-end;gap:2px;height:30px;}
        .spark-bar{width:8px;border-radius:2px 2px 0 0;background:#00d4ff33;transition:height 0.3s;}
      `}</style>

      {/* ── ALERT TOASTS ── */}
      <div style={{position:"fixed",top:16,right:16,zIndex:999,display:"flex",flexDirection:"column",gap:8}}>
        {alerts.map(a => (
          <div key={a.id} style={{
            padding:"10px 16px",borderRadius:8,fontSize:12,maxWidth:320,
            background: a.type==="success"?"#00ff9922":a.type==="danger"?"#ff444422":"#ffbb0022",
            border: `1px solid ${a.type==="success"?"#00ff9944":a.type==="danger"?"#ff444444":"#ffbb0044"}`,
            color: a.type==="success"?"#00ff99":a.type==="danger"?"#ff4444":"#ffbb00",
            boxShadow:"0 4px 20px #00000066"
          }}>{a.msg}</div>
        ))}
      </div>

      {/* ── TOP NAV ── */}
      <div style={{background:"#020c18",borderBottom:"1px solid #0e2240",padding:"0 24px",display:"flex",alignItems:"center",gap:20,height:52,position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"baseline",gap:8}}>
          <span style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:16,color:"#00d4ff",letterSpacing:1}}>QUANTEDGE</span>
          <span style={{fontSize:10,color:"#2a4a6a",letterSpacing:2}}>AI</span>
        </div>
        <div style={{display:"flex",gap:4,marginLeft:8}}>
          {[["dashboard","DASHBOARD"],["opportunities","SIGNALS"],["positions","POSITIONS"],["history","HISTORY"],["analytics","ANALYTICS"],["chain","OPTIONS CHAIN"],["logs","ACTIVITY LOG"]].map(([k,l]) => (
            <button key={k} className={`tab ${activeTab===k?"tab-active":"tab-inactive"}`} onClick={()=>setActiveTab(k)}>{l}</button>
          ))}
        </div>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:12}}>
          {/* System status */}
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 12px",borderRadius:20,
            background: systemStatus==="ACTIVE"?"#00ff9911":systemStatus==="PAUSED"?"#ffbb0011":"#ff444411",
            border: `1px solid ${systemStatus==="ACTIVE"?"#00ff9933":systemStatus==="PAUSED"?"#ffbb0033":"#ff444433"}`}}>
            <div className={systemStatus==="ACTIVE"?"pulse":""} style={{width:6,height:6,borderRadius:"50%",
              background: systemStatus==="ACTIVE"?"#00ff99":systemStatus==="PAUSED"?"#ffbb00":"#ff4444"}}/>
            <span style={{fontSize:10,fontWeight:600,letterSpacing:1,
              color:systemStatus==="ACTIVE"?"#00ff99":systemStatus==="PAUSED"?"#ffbb00":"#ff4444"}}>{systemStatus}</span>
          </div>
          <button className="btn btn-outline" style={{fontSize:10,padding:"4px 10px"}} onClick={()=>setConfigOpen(p=>!p)}>⚙ CONFIG</button>
          <button className="btn btn-outline" style={{fontSize:10,padding:"4px 10px"}} onClick={()=>setAuthenticated(false)}>EXIT</button>
        </div>
      </div>

      {/* ── CONFIG PANEL ── */}
      {configOpen && (
        <div style={{position:"fixed",top:52,right:0,width:340,height:"calc(100vh - 52px)",background:"#040f1f",borderLeft:"1px solid #0e2240",zIndex:200,padding:20,overflowY:"auto"}}>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:600,marginBottom:20,fontSize:14,color:"#00d4ff"}}>SYSTEM CONFIGURATION</div>
          {[
            {label:"CAPITAL (₹)",key:"capital",type:"number"},
            {label:"RISK PER TRADE (%)",key:"riskPct",type:"number"},
            {label:"MAX DAILY LOSS (₹)",key:"maxDailyLoss",type:"number"},
            {label:"MIN TRADES PER DAY",key:"minTradesPerDay",type:"number"},
            {label:"MAX TRADES PER DAY",key:"maxTradesPerDay",type:"number"},
          ].map(f => (
            <div key={f.key} style={{marginBottom:14}}>
              <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:4}}>{f.label}</div>
              <input className="inp" style={{width:"100%"}} type={f.type} value={config[f.key]}
                onChange={e=>setConfig(p=>({...p,[f.key]:Number(e.target.value)}))} />
            </div>
          ))}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:4}}>BROKER</div>
            <select className="inp" style={{width:"100%"}} value={config.broker} onChange={e=>setConfig(p=>({...p,broker:e.target.value}))}>
              {BROKERS.map(b=><option key={b}>{b}</option>)}
            </select>
          </div>
          {[{label:"API KEY",key:"apiKey"},{label:"SECRET KEY",key:"secretKey"}].map(f=>(
            <div key={f.key} style={{marginBottom:14}}>
              <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:4}}>{f.label}</div>
              <input className="inp" style={{width:"100%"}} type="password" placeholder="••••••••••••" value={config[f.key]}
                onChange={e=>setConfig(p=>({...p,[f.key]:e.target.value}))} />
            </div>
          ))}
          <div style={{marginBottom:20,display:"flex",gap:12,alignItems:"center"}}>
            <label style={{fontSize:11,color:"#4a6fa5",letterSpacing:1}}>AUTO-TRADE</label>
            <div onClick={()=>setConfig(p=>({...p,autoTrade:!p.autoTrade}))} style={{
              width:44,height:22,borderRadius:11,background:config.autoTrade?"#00d4ff":"#0e2240",cursor:"pointer",
              position:"relative",transition:"background 0.2s",border:"1px solid #1e3a5f"}}>
              <div style={{position:"absolute",top:2,left:config.autoTrade?22:2,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
            </div>
            <span style={{fontSize:10,color:config.autoTrade?"#00ff99":"#4a6fa5"}}>{config.autoTrade?"ON":"OFF"}</span>
          </div>
          <div style={{marginBottom:20,display:"flex",gap:12,alignItems:"center"}}>
            <label style={{fontSize:11,color:"#4a6fa5",letterSpacing:1}}>TRAILING STOP</label>
            <div onClick={()=>setConfig(p=>({...p,trailingStop:!p.trailingStop}))} style={{
              width:44,height:22,borderRadius:11,background:config.trailingStop?"#00d4ff":"#0e2240",cursor:"pointer",
              position:"relative",transition:"background 0.2s",border:"1px solid #1e3a5f"}}>
              <div style={{position:"absolute",top:2,left:config.trailingStop?22:2,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
            </div>
          </div>
          {isHalted && (
            <button className="btn btn-success" style={{width:"100%",marginBottom:10}} onClick={()=>{setSystemStatus("ACTIVE");addLog("System manually resumed by user","INFO");}}>
              ▶ RESUME TRADING
            </button>
          )}
          <button className="btn btn-danger" style={{width:"100%"}} onClick={()=>{
            setSystemStatus("HALTED");addLog("System manually halted by user","WARN");
          }}>⏹ HALT TRADING</button>
        </div>
      )}

      <div style={{padding:"16px 24px",paddingRight: configOpen?"364px":"24px"}}>

        {/* ══════════════════════════════════════════════════════════════ DASHBOARD */}
        {activeTab === "dashboard" && (
          <div>
            {/* Market ticker */}
            <div style={{display:"flex",gap:12,marginBottom:16}}>
              {[
                {label:"NIFTY 50",value:market.nifty,vwap:market.vwapNifty},
                {label:"BANKNIFTY",value:market.banknifty,vwap:market.vwapBNF},
              ].map(m=>(
                <div key={m.label} className="card-sm" style={{flex:1,display:"flex",alignItems:"center",gap:16}}>
                  <div>
                    <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:2}}>{m.label}</div>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:22,fontWeight:700,color:"#e2e8f0"}}>{fmt(m.value)}</div>
                  </div>
                  <div style={{borderLeft:"1px solid #0e2240",paddingLeft:16}}>
                    <div style={{fontSize:10,color:"#4a6fa5",marginBottom:2}}>VWAP</div>
                    <div style={{fontSize:14,color: m.value > m.vwap?"#00ff99":"#ff4444",fontWeight:600}}>{fmt(m.vwap)}</div>
                  </div>
                  <div style={{borderLeft:"1px solid #0e2240",paddingLeft:16}}>
                    <div style={{fontSize:10,color:"#4a6fa5",marginBottom:2}}>TREND</div>
                    <span className={`badge badge-${market.trend==="BULLISH"?"bull":market.trend==="BEARISH"?"bear":"side"}`}>{market.trend}</span>
                  </div>
                  <div style={{borderLeft:"1px solid #0e2240",paddingLeft:16}}>
                    <div style={{fontSize:10,color:"#4a6fa5",marginBottom:2}}>VOLATILITY</div>
                    <div style={{fontSize:13,color: market.volatility>2?"#ff4444":market.volatility>1.5?"#ffbb00":"#00ff99",fontWeight:600}}>
                      {market.volatility.toFixed(2)}x
                    </div>
                  </div>
                </div>
              ))}
              <div className="card-sm" style={{display:"flex",alignItems:"center",gap:16}}>
                <div>
                  <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:2}}>OPEN SIGNALS</div>
                  <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:22,fontWeight:700,color:"#a78bfa"}}>{opportunities.filter(o=>o.status==="PENDING").length}</div>
                </div>
                <div style={{borderLeft:"1px solid #0e2240",paddingLeft:16}}>
                  <div style={{fontSize:10,color:"#4a6fa5",marginBottom:2}}>POSITIONS</div>
                  <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:22,fontWeight:700,color:"#00d4ff"}}>{openPositions.length}</div>
                </div>
              </div>
            </div>

            {/* Capital Overview */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:16}}>
              {[
                {label:"AVAILABLE CAPITAL",value:`₹${fmt(capital)}`,sub:`Base: ₹${fmt(config.capital)}`,color:"#e2e8f0"},
                {label:"TODAY'S P&L",value:fmtPnl(dailyPnl),sub:`Limit: ₹${fmt(config.maxDailyLoss)}`,color:dailyPnl>=0?"#00ff99":"#ff4444"},
                {label:"WEEKLY P&L",value:fmtPnl(weeklyPnl),sub:"5-day performance",color:weeklyPnl>=0?"#00ff99":"#ff4444"},
                {label:"RISK EXPOSURE",value:`₹${fmt(riskExposure)}`,sub:`${fmt(riskExposure/config.capital*100)}% of capital`,color:"#ffbb00"},
                {label:"DRAWDOWN",value:`${drawdownPct.toFixed(1)}%`,sub:`Max: ${fmt(config.maxDailyLoss/config.capital*100,1)}%`,color:drawdownPct>50?"#ff4444":"#00d4ff"},
                {label:"TRADES TODAY",value:`${todayTradeCount} / ${config.maxTradesPerDay}`,sub:`Min target: ${config.minTradesPerDay}`,color: todayTradeCount>=config.maxTradesPerDay?"#ff4444":todayTradeCount>=config.minTradesPerDay?"#00ff99":"#ffbb00"},
              ].map(m=>(
                <div key={m.label} className="metric-card">
                  <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:8}}>{m.label}</div>
                  <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:20,fontWeight:700,color:m.color,marginBottom:4}}>{m.value}</div>
                  <div style={{fontSize:10,color:"#2a4a6a"}}>{m.sub}</div>
                  {m.label==="DRAWDOWN" && (
                    <div style={{marginTop:8}} className="progress-bar">
                      <div className="progress-fill" style={{width:`${Math.min(100,drawdownPct/config.maxDailyLoss*config.capital*100)}%`,background:drawdownPct>50?"#ff4444":"#00d4ff"}}/>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Middle row */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {/* Latest signals */}
              <div className="card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#a78bfa"}}>● LIVE AI SIGNALS</div>
                  <button className="btn btn-outline" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>setActiveTab("opportunities")}>VIEW ALL</button>
                </div>
                {opportunities.filter(o=>o.status==="PENDING").slice(0,4).map(o=>(
                  <div key={o.id} className="opp-card" onClick={()=>{setSelectedTrade(o);setActiveTab("opportunities");}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                      <div style={{fontWeight:600,color:"#e2e8f0",fontSize:13}}>{o.type}</div>
                      <div style={{fontSize:11,fontWeight:700,color: o.score>=70?"#00ff99":o.score>=55?"#ffbb00":"#ff4444"}}>{o.score}%</div>
                    </div>
                    <div style={{display:"flex",gap:12,fontSize:11,color:"#4a6fa5"}}>
                      <span>Entry ₹{o.premium}</span>
                      <span style={{color:"#ff4444"}}>SL ₹{o.sl}</span>
                      <span style={{color:"#00ff99"}}>Target ₹{o.target}</span>
                      <span style={{marginLeft:"auto"}}>{o.strategy}</span>
                    </div>
                    <div style={{marginTop:6}} className="progress-bar">
                      <div className="progress-fill" style={{width:`${o.score}%`,background:`linear-gradient(90deg,${o.score>=70?"#00ff99,#00d4ff":o.score>=55?"#ffbb00,#ff8800":"#ff4444,#ff6644"})`}}/>
                    </div>
                  </div>
                ))}
                {opportunities.filter(o=>o.status==="PENDING").length === 0 && (
                  <div style={{textAlign:"center",padding:"30px 0",color:"#2a4a6a",fontSize:11}}>Scanning market for opportunities...</div>
                )}
              </div>

              {/* Open Positions */}
              <div className="card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#00d4ff"}}>● OPEN POSITIONS</div>
                  <button className="btn btn-outline" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>setActiveTab("positions")}>VIEW ALL</button>
                </div>
                {openPositions.slice(0,5).map(p=>(
                  <div key={p.id} style={{padding:"10px 0",borderBottom:"1px solid #0e2240",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontWeight:600,color:"#e2e8f0",fontSize:12,marginBottom:2}}>{p.type}</div>
                      <div style={{fontSize:10,color:"#4a6fa5"}}>Entry ₹{p.entryPrice} · Qty {p.qty} · {p.strategy}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontWeight:700,fontSize:13,color:p.unrealizedPnl>=0?"#00ff99":"#ff4444"}}>{fmtPnl(p.unrealizedPnl)}</div>
                      <div style={{fontSize:10,color:"#4a6fa5"}}>Cur ₹{p.currentPrem}</div>
                    </div>
                  </div>
                ))}
                {openPositions.length === 0 && (
                  <div style={{textAlign:"center",padding:"30px 0",color:"#2a4a6a",fontSize:11}}>No open positions</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════ OPPORTUNITIES */}
        {activeTab === "opportunities" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#a78bfa",marginBottom:14}}>AI DETECTED OPPORTUNITIES</div>
              <div className="scroll" style={{maxHeight:"none"}}>
                {opportunities.map(o=>(
                  <div key={o.id} className={`opp-card ${selectedTrade?.id===o.id?"selected":""}`}
                    onClick={()=>setSelectedTrade(o)}
                    style={{opacity:o.status==="EXECUTED"?0.5:1}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div>
                        <span style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,color:"#e2e8f0",fontSize:14}}>{o.type}</span>
                        <span className={`badge badge-${o.direction==="CE"?"bull":"bear"}`} style={{marginLeft:8}}>{o.direction}</span>
                        {o.status==="EXECUTED" && <span className="badge" style={{marginLeft:8,background:"#4a6fa511",color:"#4a6fa5"}}>EXECUTED</span>}
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:18,fontWeight:700,color:o.score>=70?"#00ff99":o.score>=55?"#ffbb00":"#ff6644",fontFamily:"'Space Grotesk',sans-serif"}}>{o.score}%</div>
                        <div style={{fontSize:10,color:"#4a6fa5"}}>confidence</div>
                      </div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:8}}>
                      {[["ENTRY",`₹${o.premium}`,"#e2e8f0"],["STOP LOSS",`₹${o.sl}`,"#ff4444"],["TARGET",`₹${o.target}`,"#00ff99"],["QTY",o.qty,"#00d4ff"]].map(([l,v,c])=>(
                        <div key={l} style={{background:"#051020",borderRadius:6,padding:"6px 8px"}}>
                          <div style={{fontSize:9,color:"#4a6fa5",letterSpacing:1,marginBottom:2}}>{l}</div>
                          <div style={{fontSize:13,fontWeight:600,color:c}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:10,color:"#4a6fa5"}}>{o.strategy} · {o.instrument}</span>
                      <span style={{fontSize:10,color:"#2a4a6a"}}>{o.timestamp.toLocaleTimeString("en-IN")}</span>
                    </div>
                    {o.status === "PENDING" && (
                      <div style={{marginTop:10,display:"flex",gap:8}}>
                        <button className="btn btn-success" style={{flex:1,fontSize:11}} onClick={e=>{e.stopPropagation();executeTrade(o);setOpportunities(p=>p.map(x=>x.id===o.id?{...x,status:"EXECUTED"}:x));}}>
                          ✓ EXECUTE TRADE
                        </button>
                        <button className="btn btn-danger" style={{fontSize:11}} onClick={e=>{e.stopPropagation();setOpportunities(p=>p.filter(x=>x.id!==o.id));addLog(`Signal rejected: ${o.type}`, "INFO");}}>
                          ✕ REJECT
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {opportunities.length === 0 && (
                  <div style={{textAlign:"center",padding:"60px 0",color:"#2a4a6a"}}>
                    <div style={{fontSize:32,marginBottom:12}}>◎</div>
                    <div>Scanning market conditions...</div>
                  </div>
                )}
              </div>
            </div>

            {/* Trade Reasoning Panel */}
            <div>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#00d4ff",marginBottom:14}}>AI DECISION REPORT</div>
              {selectedTrade ? (
                <div className="card">
                  <div style={{borderBottom:"1px solid #0e2240",paddingBottom:14,marginBottom:14}}>
                    <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:4}}>INSTRUMENT</div>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:20,fontWeight:700,color:"#e2e8f0"}}>{selectedTrade.type}</div>
                    <div style={{marginTop:6,display:"flex",gap:8,flexWrap:"wrap"}}>
                      <span className="badge badge-open">STRATEGY: {selectedTrade.strategy.toUpperCase()}</span>
                      <span className={`badge badge-${selectedTrade.direction==="CE"?"bull":"bear"}`}>{selectedTrade.direction === "CE" ? "BULLISH CALL" : "BEARISH PUT"}</span>
                    </div>
                  </div>

                  <div style={{marginBottom:16}}>
                    <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:10}}>CONFIDENCE SCORE</div>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      <div style={{flex:1}} className="progress-bar">
                        <div className="progress-fill" style={{width:`${selectedTrade.score}%`,height:8,background:`linear-gradient(90deg,${selectedTrade.score>=70?"#00ff99,#00d4ff":"#ffbb00,#ff8800"})`}}/>
                      </div>
                      <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:24,fontWeight:700,color:selectedTrade.score>=70?"#00ff99":"#ffbb00",minWidth:50}}>{selectedTrade.score}%</div>
                    </div>
                  </div>

                  <div style={{marginBottom:16}}>
                    <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:10}}>ENTRY PARAMETERS</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      {[["Entry Premium",`₹${selectedTrade.premium}`],["Stop Loss",`₹${selectedTrade.sl}`],["Target Price",`₹${selectedTrade.target}`],["Quantity",`${selectedTrade.qty} units`],["Risk (₹)",`₹${fmt((selectedTrade.premium-selectedTrade.sl)*selectedTrade.qty)}`],["Reward (₹)",`₹${fmt((selectedTrade.target-selectedTrade.premium)*selectedTrade.qty)}`]].map(([l,v])=>(
                        <div key={l} style={{background:"#051020",borderRadius:6,padding:"8px 10px"}}>
                          <div style={{fontSize:10,color:"#4a6fa5",marginBottom:2}}>{l}</div>
                          <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:10}}>REASON FOR ENTRY</div>
                    {selectedTrade.reasons.map((r,i)=>(
                      <div key={i} style={{display:"flex",gap:10,marginBottom:8,padding:"8px 10px",background:"#051020",borderRadius:6,borderLeft:`3px solid ${r.includes("⚠")?"#ffbb00":"#00d4ff"}`}}>
                        <span style={{color:r.includes("⚠")?"#ffbb00":"#00d4ff",fontSize:11,minWidth:16}}>{r.includes("⚠")?"⚠":"→"}</span>
                        <span style={{fontSize:11,color:"#8faac8",lineHeight:1.5}}>{r}</span>
                      </div>
                    ))}
                  </div>
                  {selectedTrade.status === "PENDING" && (
                    <button className="btn btn-primary" style={{width:"100%",marginTop:16,padding:"10px"}} onClick={()=>{
                      executeTrade(selectedTrade);
                      setOpportunities(p=>p.map(x=>x.id===selectedTrade.id?{...x,status:"EXECUTED"}:x));
                      setSelectedTrade(p=>({...p,status:"EXECUTED"}));
                    }}>▶ EXECUTE THIS TRADE</button>
                  )}
                </div>
              ) : (
                <div className="card" style={{textAlign:"center",padding:"60px 20px",color:"#2a4a6a"}}>
                  <div style={{fontSize:40,marginBottom:12}}>◈</div>
                  <div style={{fontSize:12}}>Select a signal to view<br/>AI decision analysis</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ POSITIONS */}
        {activeTab === "positions" && (
          <div>
            <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#00d4ff",marginBottom:14}}>OPEN POSITIONS ({openPositions.length})</div>
            {openPositions.length > 0 ? (
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{borderBottom:"1px solid #0e2240"}}>
                    {["INSTRUMENT","ENTRY TIME","ENTRY ₹","CURRENT ₹","SL ₹","TARGET ₹","QTY","UNREALIZED P&L","STRATEGY","ACTION"].map(h=>(
                      <th key={h} style={{padding:"8px 10px",textAlign:"left",fontSize:10,color:"#4a6fa5",letterSpacing:1,fontWeight:600}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map(p=>(
                    <tr key={p.id} style={{borderBottom:"1px solid #050e1c"}}>
                      <td style={{padding:"10px",fontWeight:600,color:"#e2e8f0"}}>{p.type}</td>
                      <td style={{padding:"10px",color:"#4a6fa5",fontSize:11}}>{p.entryTime.toLocaleTimeString("en-IN")}</td>
                      <td style={{padding:"10px"}}>₹{p.entryPrice}</td>
                      <td style={{padding:"10px",color:p.currentPrem>p.entryPrice?"#00ff99":"#ff4444"}}>₹{p.currentPrem}</td>
                      <td style={{padding:"10px",color:"#ff4444"}}>₹{p.sl}</td>
                      <td style={{padding:"10px",color:"#00ff99"}}>₹{p.target}</td>
                      <td style={{padding:"10px"}}>{p.qty}</td>
                      <td style={{padding:"10px",fontWeight:700,color:p.unrealizedPnl>=0?"#00ff99":"#ff4444"}}>{fmtPnl(p.unrealizedPnl)}</td>
                      <td style={{padding:"10px",fontSize:10,color:"#a78bfa"}}>{p.strategy}</td>
                      <td style={{padding:"10px"}}>
                        <button className="btn btn-danger" style={{fontSize:10,padding:"4px 10px"}} onClick={()=>{
                          const pnl = Math.round((p.currentPrem - p.entryPrice)*p.qty);
                          setTrades(t=>[{...p,exitPrice:p.currentPrem,exitTime:new Date(),pnl,status:pnl>0?"WIN":"LOSS"},...t]);
                          setDailyPnl(d=>d+pnl);
                          setWeeklyPnl(w=>w+pnl);
                          updateAnalytics({...p,pnl});
                          setOpenPositions(prev=>prev.filter(x=>x.id!==p.id));
                          addLog(`MANUAL CLOSE: ${p.type} | PnL: ${fmtPnl(pnl)}`,"TRADE");
                        }}>CLOSE</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{textAlign:"center",padding:"60px",color:"#2a4a6a"}}>
                <div style={{fontSize:40,marginBottom:12}}>◎</div>
                <div>No open positions</div>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ HISTORY */}
        {activeTab === "history" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#00d4ff"}}>TRADE HISTORY ({trades.length} trades)</div>
              <div style={{display:"flex",gap:16,fontSize:11}}>
                <span style={{color:"#00ff99"}}>Wins: {analytics.wins}</span>
                <span style={{color:"#ff4444"}}>Losses: {analytics.losses}</span>
                <span style={{color:"#ffbb00"}}>Win Rate: {winRate}%</span>
              </div>
            </div>
            <div className="scroll" style={{maxHeight:"none"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{borderBottom:"1px solid #0e2240",position:"sticky",top:0,background:"#020c18"}}>
                    {["ID","DATE","INSTRUMENT","STRIKE","ENTRY ₹","EXIT ₹","QTY","P&L","STRATEGY","RESULT","REASONING"].map(h=>(
                      <th key={h} style={{padding:"8px 10px",textAlign:"left",fontSize:10,color:"#4a6fa5",letterSpacing:1,fontWeight:600}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t,i)=>(
                    <tr key={t.id||i} style={{borderBottom:"1px solid #050e1c",cursor:"pointer"}} onClick={()=>setSelectedTrade(t)}>
                      <td style={{padding:"10px",fontSize:10,color:"#4a6fa5"}}>{String(t.id).slice(-6)}</td>
                      <td style={{padding:"10px",fontSize:10,color:"#4a6fa5"}}>{t.entryTime.toLocaleDateString("en-IN")}</td>
                      <td style={{padding:"10px",fontWeight:600,color:"#e2e8f0"}}>{t.type}</td>
                      <td style={{padding:"10px"}}>{t.strike}</td>
                      <td style={{padding:"10px"}}>₹{t.entryPrice}</td>
                      <td style={{padding:"10px"}}>₹{t.exitPrice}</td>
                      <td style={{padding:"10px"}}>{t.qty}</td>
                      <td style={{padding:"10px",fontWeight:700,color:t.pnl>=0?"#00ff99":"#ff4444"}}>{fmtPnl(t.pnl)}</td>
                      <td style={{padding:"10px",fontSize:10,color:"#a78bfa"}}>{t.strategy}</td>
                      <td style={{padding:"10px"}}><span className={`badge badge-${t.pnl>=0?"win":"loss"}`}>{t.pnl>=0?"WIN":"LOSS"}</span></td>
                      <td style={{padding:"10px",maxWidth:200}}>
                        <div style={{fontSize:10,color:"#4a6fa5",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}} title={t.reasons?.join(", ")}>
                          {t.reasons?.[0] || "System generated trade"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {trades.length === 0 && (
                <div style={{textAlign:"center",padding:"60px",color:"#2a4a6a"}}>No closed trades yet</div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ ANALYTICS */}
        {activeTab === "analytics" && (
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:16}}>
            {/* Performance metrics */}
            <div className="card">
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#00d4ff",marginBottom:16}}>PERFORMANCE METRICS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[
                  {label:"WIN RATE",value:`${winRate}%`,color:winRate>=50?"#00ff99":"#ff4444"},
                  {label:"TOTAL P&L",value:fmtPnl(analytics.totalPnl),color:analytics.totalPnl>=0?"#00ff99":"#ff4444"},
                  {label:"TOTAL TRADES",value:analytics.totalTrades,color:"#e2e8f0"},
                  {label:"AVG WIN",value:`₹${fmt(Math.abs(analytics.avgWin))}`,color:"#00ff99"},
                  {label:"AVG LOSS",value:`₹${fmt(Math.abs(analytics.avgLoss))}`,color:"#ff4444"},
                  {label:"PROFIT FACTOR",value: analytics.avgLoss!==0?fmt(Math.abs(analytics.avgWin/analytics.avgLoss)):"N/A",color:"#ffbb00"},
                ].map(m=>(
                  <div key={m.label} style={{background:"#051020",borderRadius:8,padding:"14px 16px"}}>
                    <div style={{fontSize:10,color:"#4a6fa5",letterSpacing:1,marginBottom:4}}>{m.label}</div>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:22,fontWeight:700,color:m.color}}>{m.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Strategy breakdown */}
            <div className="card">
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#a78bfa",marginBottom:16}}>STRATEGY PERFORMANCE</div>
              {Object.entries(analytics.strategyStats).length > 0 ? (
                Object.entries(analytics.strategyStats).map(([strat,stats])=>(
                  <div key={strat} style={{marginBottom:14,padding:"12px",background:"#051020",borderRadius:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                      <span style={{fontWeight:600,color:"#e2e8f0",fontSize:12}}>{strat}</span>
                      <span style={{fontSize:11,color:stats.pnl>=0?"#00ff99":"#ff4444",fontWeight:700}}>{fmtPnl(stats.pnl)}</span>
                    </div>
                    <div style={{display:"flex",gap:16,fontSize:11,color:"#4a6fa5",marginBottom:8}}>
                      <span>{stats.trades} trades</span>
                      <span style={{color:"#00ff99"}}>{stats.wins}W</span>
                      <span style={{color:"#ff4444"}}>{stats.trades-stats.wins}L</span>
                      <span style={{color:"#ffbb00"}}>{stats.trades>0?Math.round(stats.wins/stats.trades*100):0}% WR</span>
                    </div>
                    <div className="progress-bar">
                      <div className="progress-fill" style={{width:`${stats.trades>0?Math.round(stats.wins/stats.trades*100):0}%`,background:"linear-gradient(90deg,#a78bfa,#00d4ff)"}}/>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{textAlign:"center",padding:"40px",color:"#2a4a6a",fontSize:11}}>No trades executed yet</div>
              )}
            </div>

            {/* Risk summary */}
            <div className="card">
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#ffbb00",marginBottom:16}}>RISK MANAGEMENT STATUS</div>
              {[
                {label:"Daily Loss Used",value:`₹${fmt(Math.abs(Math.min(0,dailyPnl)))}`,limit:`₹${fmt(config.maxDailyLoss)}`,pct:Math.abs(Math.min(0,dailyPnl))/config.maxDailyLoss*100},
                {label:"Capital at Risk",value:`₹${fmt(riskExposure)}`,limit:`₹${fmt(config.capital)}`,pct:riskExposure/config.capital*100},
                {label:"Max Trade Risk",value:`₹${fmt(config.capital*config.riskPct/100)}`,limit:`Per trade limit`,pct:config.riskPct},
              ].map(r=>(
                <div key={r.label} style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:11,color:"#8faac8"}}>{r.label}</span>
                    <span style={{fontSize:11}}><span style={{color:r.pct>70?"#ff4444":"#e2e8f0"}}>{r.value}</span> <span style={{color:"#2a4a6a"}}>/ {r.limit}</span></span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{width:`${Math.min(100,r.pct)}%`,background:r.pct>70?"linear-gradient(90deg,#ffbb00,#ff4444)":"linear-gradient(90deg,#00d4ff,#0077ff)"}}/>
                  </div>
                </div>
              ))}
            </div>

            {/* System health */}
            <div className="card">
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#00ff99",marginBottom:16}}>SYSTEM STATUS</div>
              {[
                {label:"Trading Engine",status:"ONLINE",color:"#00ff99"},
                {label:"Market Data Feed",status:"LIVE",color:"#00ff99"},
                {label:`${config.broker} API`,status:config.apiKey?"CONNECTED":"DEMO MODE",color:config.apiKey?"#00ff99":"#ffbb00"},
                {label:"AI Analysis Engine",status:"ACTIVE",color:"#00ff99"},
                {label:"Risk Monitor",status:"WATCHING",color:"#00ff99"},
                {label:"Order Executor",status:config.autoTrade?"AUTO":"MANUAL",color:config.autoTrade?"#00d4ff":"#ffbb00"},
              ].map(s=>(
                <div key={s.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #0a1628"}}>
                  <span style={{fontSize:12,color:"#8faac8"}}>{s.label}</span>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:s.color,boxShadow:`0 0 6px ${s.color}`}}/>
                    <span style={{fontSize:11,color:s.color,fontWeight:600,letterSpacing:1}}>{s.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════ OPTIONS CHAIN */}
        {activeTab === "chain" && (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            {[{label:"NIFTY",spot:market.nifty,chain},{label:"BANKNIFTY",spot:market.banknifty,chain:bnfChain}].map(({label,spot,chain:c})=>(
              <div key={label} className="card">
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#00d4ff"}}>{label} OPTIONS CHAIN</div>
                  <div style={{fontSize:12,fontFamily:"'Space Grotesk',sans-serif",color:"#e2e8f0"}}>Spot: <b>{fmt(spot)}</b></div>
                </div>
                <div className="chain-row" style={{background:"#051020",borderRadius:"4px 4px 0 0",color:"#4a6fa5",fontWeight:600}}>
                  <span>CE VOL</span><span>CE OI</span><span>CE ₹</span><span style={{textAlign:"center",color:"#e2e8f0"}}>STRIKE</span><span>PE ₹</span><span>PE OI</span><span style={{textAlign:"right"}}>PE VOL</span>
                </div>
                {c.map(row=>{
                  const isAtm = Math.abs(row.strike - spot) < 100;
                  return (
                    <div key={row.strike} className={`chain-row ${isAtm?"chain-atm":""}`}>
                      <span style={{color:"#00d4ff",fontSize:10}}>{fmt(row.ceVol,0)}</span>
                      <span style={{color:"#4a6fa5",fontSize:10}}>{fmt(row.ceOI,0)}</span>
                      <span style={{color:"#00ff99",fontWeight:600}}>₹{row.cePrem}</span>
                      <span style={{textAlign:"center",fontWeight:isAtm?700:400,color:isAtm?"#00d4ff":"#8faac8",fontSize:isAtm?13:12}}>{row.strike}</span>
                      <span style={{color:"#ff4444",fontWeight:600}}>₹{row.pePrem}</span>
                      <span style={{color:"#4a6fa5",fontSize:10}}>{fmt(row.peOI,0)}</span>
                      <span style={{textAlign:"right",color:"#ff4444",fontSize:10}}>{fmt(row.peVol,0)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ LOGS */}
        {activeTab === "logs" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:2,color:"#4a6fa5"}}>SYSTEM ACTIVITY LOG ({logs.length} entries)</div>
              <button className="btn btn-outline" style={{fontSize:10}} onClick={()=>setLogs([])}>CLEAR LOGS</button>
            </div>
            <div className="card" style={{padding:0,overflow:"hidden"}}>
              <div style={{padding:"8px 10px",background:"#051020",borderBottom:"1px solid #0e2240",display:"grid",gridTemplateColumns:"80px 70px 1fr",gap:10,fontSize:10,color:"#4a6fa5",letterSpacing:1,fontWeight:600}}>
                <span>TIME</span><span>LEVEL</span><span>MESSAGE</span>
              </div>
              <div style={{maxHeight:600,overflowY:"auto"}}>
                {logs.map(l=>(
                  <div key={l.id} className="log-entry" style={{display:"grid",gridTemplateColumns:"80px 70px 1fr",gap:10}}>
                    <span style={{color:"#2a4a6a"}}>{l.time}</span>
                    <span className={`log-${l.level}`}>{l.level}</span>
                    <span className={`log-${l.level}`}>{l.msg}</span>
                  </div>
                ))}
                {logs.length === 0 && (
                  <div style={{padding:"40px",textAlign:"center",color:"#2a4a6a",fontSize:11}}>No log entries</div>
                )}
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Footer */}
      <div style={{borderTop:"1px solid #0a1628",padding:"8px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,color:"#2a4a6a"}}>
        <span>QUANTEDGE AI · Indian Options Trading Platform · NIFTY · BANKNIFTY</span>
        <span>Broker: {config.broker} · Capital: ₹{fmt(capital)} · {new Date().toLocaleTimeString("en-IN")}</span>
        <span style={{color:"#ff4444"}}>⚠ FOR EDUCATIONAL USE ONLY — NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  );
}
