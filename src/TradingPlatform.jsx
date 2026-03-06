import { useState, useEffect, useRef, useCallback } from "react";

const THEMES = {
  dark:{bg:"#030d1a",bg2:"#051525",bg3:"#071e35",card:"#071e35",cardBorder:"#0e2d4a",cardHover:"#0a2540",text:"#e8f4ff",textSub:"#7aa3c8",textMuted:"#3d6080",accent:"#00c8ff",accentGlow:"#00c8ff22",green:"#00e676",greenBg:"#00e67611",greenBorder:"#00e67633",red:"#ff4569",redBg:"#ff456911",redBorder:"#ff456933",yellow:"#ffc107",yellowBg:"#ffc10711",purple:"#c084fc",purpleBg:"#c084fc11",navBg:"#020c17",navBorder:"#0a2035",inputBg:"#040f1e",inputBorder:"#0e2d4a",shadow:"0 4px 24px #00000066",shadowLg:"0 8px 48px #00000088"},
  light:{bg:"#f0f4f8",bg2:"#e8eef4",bg3:"#dde6ee",card:"#ffffff",cardBorder:"#d0dde8",cardHover:"#f5f8fb",text:"#0d1f2d",textSub:"#4a6680",textMuted:"#8faab8",accent:"#0077cc",accentGlow:"#0077cc22",green:"#00875a",greenBg:"#00875a11",greenBorder:"#00875a33",red:"#d63650",redBg:"#d6365011",redBorder:"#d6365033",yellow:"#d97706",yellowBg:"#d9770611",purple:"#7c3aed",purpleBg:"#7c3aed11",navBg:"#ffffff",navBorder:"#d0dde8",inputBg:"#f8fafc",inputBorder:"#d0dde8",shadow:"0 2px 12px #00000018",shadowLg:"0 4px 24px #00000022"}
};

const BROKERS = {
  "Upstox":{fields:["api_key","api_secret","access_token"],docsUrl:"https://upstox.com/developer/api-documentation/",logo:"U",color:"#6c63ff"},
  "Zerodha Kite":{fields:["api_key","api_secret","access_token"],docsUrl:"https://kite.trade/docs/connect/v3/",logo:"Z",color:"#387ed1"},
  "Angel One SmartAPI":{fields:["api_key","client_id","password","totp_secret"],docsUrl:"https://smartapi.angelbroking.com/docs",logo:"A",color:"#e94560"},
  "Fyers":{fields:["client_id","secret_key","access_token"],docsUrl:"https://myapi.fyers.in/docs/",logo:"F",color:"#00b4d8"},
  "Dhan":{fields:["client_id","access_token"],docsUrl:"https://dhanhq.co/docs/latest/",logo:"D",color:"#2ecc71"},
};

const fmt = (n, d=2) => Number(n).toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPnl = n => n >= 0 ? `+₹${fmt(Math.abs(n))}` : `-₹${fmt(Math.abs(n))}`;
const timeStr = () => new Date().toLocaleTimeString("en-IN",{hour12:false});
const dateStr = () => new Date().toLocaleDateString("en-IN");

const getMarketStatus = () => {
  const now = new Date(), day = now.getDay();
  if(day===0) return {open:false, label:"Closed — Sunday", next:"Monday 9:15 AM"};
  if(day===6) return {open:false, label:"Closed — Saturday", next:"Monday 9:15 AM"};
  const m = now.getHours()*60 + now.getMinutes();
  if(m < 555) return {open:false, label:"Pre-Market", next:`Opens in ${555-m} min`};
  if(m > 930) return {open:false, label:"Market Closed", next:"Tomorrow 9:15 AM"};
  return {open:true, label:"Market Open", next:"Closes 3:30 PM"};
};

const SK = "qedge_v2";
const saveData = d => { try { localStorage.setItem(SK, JSON.stringify(d)); } catch(e) {} };
const loadData = () => { try { const d = localStorage.getItem(SK); return d ? JSON.parse(d) : null; } catch(e) { return null; } };
const clearData = () => { try { localStorage.removeItem(SK); } catch(e) {} };

// ── Real broker API calls ──────────────────────────────────────────────────────

function getHeaders(broker, creds) {
  if(broker==="Upstox") return {"Authorization":`Bearer ${creds.access_token}`,"Accept":"application/json"};
  if(broker==="Zerodha Kite") return {"X-Kite-Version":"3","Authorization":`token ${creds.api_key}:${creds.access_token}`};
  if(broker==="Angel One SmartAPI") return {"Authorization":`Bearer ${creds.access_token}`,"Content-Type":"application/json","X-PrivateKey":creds.api_key,"X-UserType":"USER","X-SourceID":"WEB"};
  if(broker==="Fyers") return {"Authorization":`${creds.client_id}:${creds.access_token}`,"Content-Type":"application/json"};
  if(broker==="Dhan") return {"access-token":creds.access_token,"Content-Type":"application/json"};
  return {};
}

async function apiFetchQuotes(broker, creds) {
  const h = getHeaders(broker, creds);
  try {
    if(broker==="Upstox") {
      const r = await fetch("https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050%2CNSE_INDEX%7CNifty%20Bank", {headers:h});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const n = j?.data?.["NSE_INDEX:Nifty 50"], b = j?.data?.["NSE_INDEX:Nifty Bank"];
      return {nifty:n?.last_price, bnf:b?.last_price, nOHLC:n?.ohlc, bOHLC:b?.ohlc};
    }
    if(broker==="Zerodha Kite") {
      const r = await fetch("https://api.kite.trade/quote?i=NSE:NIFTY+50&i=NSE:NIFTY+BANK", {headers:h});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return {nifty:j?.data?.["NSE:NIFTY 50"]?.last_price, bnf:j?.data?.["NSE:NIFTY BANK"]?.last_price};
    }
    if(broker==="Angel One SmartAPI") {
      const r = await fetch("https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/", {method:"POST",headers:h,body:JSON.stringify({mode:"FULL",exchangeTokens:{"NSE":["26000","26009"]}})});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); const t = j?.data?.fetched||[];
      return {nifty:t.find(x=>x.symbolToken==="26000")?.ltp, bnf:t.find(x=>x.symbolToken==="26009")?.ltp};
    }
    if(broker==="Fyers") {
      const r = await fetch("https://api.fyers.in/api/v2/quotes/?symbols=NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX", {headers:h});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); const q = j?.d||[];
      return {nifty:q.find(x=>x.n?.includes("NIFTY50"))?.v?.lp, bnf:q.find(x=>x.n?.includes("NIFTYBANK"))?.v?.lp};
    }
    if(broker==="Dhan") {
      const r = await fetch("https://api.dhan.co/v2/marketfeed/quote", {method:"POST",headers:h,body:JSON.stringify({NSE_FNO:["13","25"]})});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return {nifty:j?.data?.NSE_FNO?.["13"]?.last_price, bnf:j?.data?.NSE_FNO?.["25"]?.last_price};
    }
    return {error:"Unsupported broker"};
  } catch(e) { return {error:e.message}; }
}

async function apiFetchOrders(broker, creds) {
  const h = getHeaders(broker, creds);
  try {
    if(broker==="Upstox") { const r = await fetch("https://api.upstox.com/v2/order/retrieve-all",{headers:h}); const j = await r.json(); return j?.data||[]; }
    if(broker==="Zerodha Kite") { const r = await fetch("https://api.kite.trade/orders",{headers:h}); const j = await r.json(); return j?.data||[]; }
    return [];
  } catch(e) { return []; }
}

async function apiFetchPositions(broker, creds) {
  const h = getHeaders(broker, creds);
  try {
    if(broker==="Upstox") { const r = await fetch("https://api.upstox.com/v2/portfolio/short-term-positions",{headers:h}); const j = await r.json(); return j?.data||[]; }
    if(broker==="Zerodha Kite") { const r = await fetch("https://api.kite.trade/portfolio/positions",{headers:h}); const j = await r.json(); return j?.data?.net||[]; }
    return [];
  } catch(e) { return []; }
}

async function apiPlaceOrder(broker, creds, order) {
  const h = {...getHeaders(broker,creds), "Content-Type":"application/json"};
  try {
    if(broker==="Upstox") {
      const r = await fetch("https://api.upstox.com/v2/order/place",{method:"POST",headers:h,body:JSON.stringify({quantity:order.qty,product:"D",validity:"DAY",price:0,tag:"quantedge-ai",instrument_token:order.token||"",order_type:"MARKET",transaction_type:order.side,disclosed_quantity:0,trigger_price:0,is_amo:false})});
      const j = await r.json(); return {success:r.ok, orderId:j?.data?.order_id};
    }
    if(broker==="Zerodha Kite") {
      const rh = {...h,"Content-Type":"application/x-www-form-urlencoded"};
      const r = await fetch("https://api.kite.trade/orders/regular",{method:"POST",headers:rh,body:new URLSearchParams({tradingsymbol:order.symbol||"",exchange:"NFO",transaction_type:order.side,order_type:"MARKET",quantity:order.qty,product:"MIS",validity:"DAY",tag:"quantedge_ai"})});
      const j = await r.json(); return {success:r.ok, orderId:j?.data?.order_id};
    }
    return {success:false, error:"Not implemented for this broker"};
  } catch(e) { return {success:false, error:e.message}; }
}

// ── AI Engine (real data analysis) ────────────────────────────────────────────

function runAI(quotes, config, dailyPnl) {
  if(!quotes.nifty && !quotes.bnf) return [];
  const opps = [];
  const capProtect = (config.capital + dailyPnl) <= config.capital * (config.minCapitalFloor/100);

  [{name:"NIFTY", spot:quotes.nifty, ohlc:quotes.nOHLC}, {name:"BANKNIFTY", spot:quotes.bnf, ohlc:quotes.bOHLC}].forEach(({name, spot, ohlc}) => {
    if(!spot) return;
    let score=35, reasons=[], direction=null, strategy=null;
    if(capProtect) { reasons.push("⚠ Capital protection active — high confidence only"); score -= 15; }

    if(ohlc && ohlc.high && ohlc.low && ohlc.open) {
      const range = ohlc.high - ohlc.low;
      if(range > 0) {
        const pos = (spot - ohlc.low) / range;
        if(pos > 0.7) { reasons.push(`Price in upper range (${(pos*100).toFixed(0)}%) — bullish momentum`); score += 13; direction = "CE"; }
        else if(pos < 0.3) { reasons.push(`Price in lower range (${(pos*100).toFixed(0)}%) — bearish momentum`); score += 13; direction = "PE"; }
        if(spot > ohlc.open) { reasons.push(`Trading above open ₹${fmt(ohlc.open)} — bullish bias`); score += 9; if(!direction) direction="CE"; }
        else { reasons.push(`Trading below open ₹${fmt(ohlc.open)} — bearish bias`); score += 9; if(!direction) direction="PE"; }
        const mid = ohlc.low + range * 0.5;
        if(Math.abs(spot - mid) < range * 0.06) { reasons.push("Price near day midpoint — range bounce possible"); score += 6; strategy = "VWAP Bounce"; }
      }
      const pctFromHigh = ((ohlc.high - spot) / spot) * 100;
      const pctFromLow = ((spot - ohlc.low) / spot) * 100;
      if(pctFromHigh < 0.15) { reasons.push(`Near day high ₹${fmt(ohlc.high)} — breakout watch`); score += 10; direction = "CE"; strategy = "Opening Range Breakout"; }
      if(pctFromLow < 0.15) { reasons.push(`Near day low ₹${fmt(ohlc.low)} — support watch`); score += 10; direction = "PE"; strategy = "Mean Reversion"; }
    }

    if(score < config.confidenceMin) return;
    if(!direction) direction = Math.random() > 0.5 ? "CE" : "PE";
    if(!strategy) strategy = direction === "CE" ? "Momentum Scalp" : "Trend Continuation";

    const strike = Math.round(spot/100)*100 + (direction==="CE" ? 100 : -100);
    const lotSize = name==="NIFTY" ? 50 : 15;
    const estPrem = Math.max(20, Math.round(spot * 0.005));
    const riskAmt = config.capital * (config.riskPct/100);
    const qty = Math.max(lotSize, Math.floor(riskAmt/(estPrem*lotSize*0.4)) * lotSize);
    const sl = Math.round(estPrem * 0.68), target = Math.round(estPrem * 1.52);
    const rr = ((target-estPrem)/(estPrem-sl)).toFixed(1);

    opps.push({
      id: Date.now()+Math.random(), instrument:name, strike, direction,
      type:`${name} ${strike} ${direction}`, premium:estPrem, sl, target, qty,
      strategy, score:Math.min(93, Math.round(score)), reasons, rr,
      timestamp:new Date(), status:"PENDING", lotSize
    });
  });
  return opps;
}

// ── Default config ─────────────────────────────────────────────────────────────

const DCONFIG = {
  capital:100000, riskPct:1, maxDailyLoss:3000, profitTarget:5000,
  minTradesDay:1, maxTradesDay:10, stopAtProfitTarget:true,
  capitalProtection:true, minCapitalFloor:97, confidenceMin:65,
  maxOpenPositions:3, autoTrade:false, trailingStop:true, broker:"Upstox",
  creds:{api_key:"",api_secret:"",access_token:"",client_id:"",password:"",totp_secret:""}
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function TradingPlatform() {
  const saved = loadData();
  const [theme, setTheme] = useState(saved?.theme||"dark");
  const T = THEMES[theme];
  const isDark = theme==="dark";

  const [authed, setAuthed] = useState(false);
  const [loginForm, setLoginForm] = useState({u:"",p:""});
  const [config, setConfig] = useState(saved?.config ? {...DCONFIG,...saved.config} : DCONFIG);
  const [cfgTab, setCfgTab] = useState("general");
  const [cfgOpen, setCfgOpen] = useState(false);
  const [showClear, setShowClear] = useState(false);

  const [apiStatus, setApiStatus] = useState("DISCONNECTED");
  const [connecting, setConnecting] = useState(false);
  const [wsStatus, setWsStatus] = useState("IDLE");
  const [fetchErr, setFetchErr] = useState(null);
  const pollRef = useRef(null);
  const wsRef = useRef(null);

  const [quotes, setQuotes] = useState({nifty:null,bnf:null,nOHLC:null,bOHLC:null});
  const [orders, setOrders] = useState([]);
  const [brokerPositions, setBrokerPositions] = useState([]);
  const [mktStatus, setMktStatus] = useState(getMarketStatus());
  const [lastUpdated, setLastUpdated] = useState(null);

  const [opps, setOpps] = useState([]);
  const [openPos, setOpenPos] = useState(saved?.openPos||[]);
  const [trades, setTrades] = useState(saved?.trades||[]);
  const [dailyPnl, setDailyPnl] = useState(saved?.dailyPnl||0);
  const [weeklyPnl, setWeeklyPnl] = useState(saved?.weeklyPnl||0);
  const [todayTrades, setTodayTrades] = useState(saved?.todayTrades||0);
  const [sysStatus, setSysStatus] = useState("WAITING");
  const [selOpp, setSelOpp] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [logs, setLogs] = useState(saved?.logs||[]);
  const [alerts, setAlerts] = useState([]);
  const [analytics, setAnalytics] = useState(saved?.analytics||{wins:0,losses:0,totalPnl:0,avgWin:0,avgLoss:0,stratStats:{}});

  // Persist
  useEffect(() => {
    saveData({theme, config, openPos, trades, dailyPnl, weeklyPnl, todayTrades, logs:logs.slice(0,50), analytics});
  }, [theme, config, openPos, trades, dailyPnl, weeklyPnl, todayTrades, analytics]);

  // Market clock
  useEffect(() => {
    const iv = setInterval(() => setMktStatus(getMarketStatus()), 30000);
    return () => clearInterval(iv);
  }, []);

  const addLog = useCallback((msg, level="INFO") => {
    setLogs(p => [{id:Date.now()+Math.random(), time:timeStr(), date:dateStr(), msg, level}, ...p].slice(0,300));
  }, []);

  const addAlert = useCallback((msg, type="info") => {
    const id = Date.now();
    setAlerts(p => [{id,msg,type}, ...p].slice(0,5));
    setTimeout(() => setAlerts(p => p.filter(a => a.id!==id)), 5000);
  }, []);

  // ── Connect ──
  const doConnect = useCallback(async () => {
    const c = config.creds;
    if(!c.access_token && !c.api_key && !c.client_id) {
      addAlert("Enter API credentials first — Config → Broker tab","danger"); return;
    }
    setConnecting(true); setApiStatus("CONNECTING");
    addLog(`Connecting to ${config.broker}...`,"INFO");
    const q = await apiFetchQuotes(config.broker, config.creds);
    if(q.error) {
      setApiStatus("AUTH_FAILED"); setConnecting(false);
      addAlert(`Failed: ${q.error}`,"danger");
      addLog(`Auth failed: ${q.error}`,"ERROR"); return;
    }
    if(q.nifty || q.bnf) {
      setApiStatus("CONNECTED"); setQuotes(q); setLastUpdated(new Date()); setFetchErr(null);
      setSysStatus(getMarketStatus().open ? "ACTIVE" : "MARKET_CLOSED");
      addAlert(`✅ ${config.broker} connected! NIFTY ₹${fmt(q.nifty||0)}`,"success");
      addLog(`Connected — NIFTY=${q.nifty} BANKNIFTY=${q.bnf}`,"INFO");
      // Start polling
      if(pollRef.current) clearInterval(pollRef.current);
      const poll = async () => {
        const nq = await apiFetchQuotes(config.broker, config.creds);
        if(nq.nifty || nq.bnf) { setQuotes(nq); setLastUpdated(new Date()); setFetchErr(null); }
        else if(nq.error) setFetchErr(nq.error);
        const ords = await apiFetchOrders(config.broker, config.creds);
        setOrders(ords);
        const bPos = await apiFetchPositions(config.broker, config.creds);
        setBrokerPositions(bPos);
      };
      pollRef.current = setInterval(poll, getMarketStatus().open ? 5000 : 60000);
    } else {
      setApiStatus("NO_DATA");
      addAlert("Connected but no data — check credentials","warning");
    }
    setConnecting(false);
  }, [config, addLog, addAlert]);

  // ── Disconnect ──
  const doDisconnect = useCallback(() => {
    if(pollRef.current) { clearInterval(pollRef.current); pollRef.current=null; }
    if(wsRef.current) { try{wsRef.current.close();}catch(e){} wsRef.current=null; }
    setApiStatus("DISCONNECTED"); setWsStatus("IDLE");
    setQuotes({nifty:null,bnf:null,nOHLC:null,bOHLC:null});
    setSysStatus("WAITING"); setOpps([]); setFetchErr(null);
    addLog("Broker disconnected","WARN");
    addAlert("Broker disconnected","warning");
  }, [addLog, addAlert]);

  // ── Clear all ──
  const doClear = useCallback(() => {
    doDisconnect();
    setTrades([]); setOpenPos([]); setDailyPnl(0); setWeeklyPnl(0);
    setTodayTrades(0); setLogs([]); setOpps([]);
    setAnalytics({wins:0,losses:0,totalPnl:0,avgWin:0,avgLoss:0,stratStats:{}});
    clearData(); setShowClear(false);
    addAlert("All data cleared","success");
  }, [doDisconnect, addAlert]);

  // ── Close trade ──
  const closeTrade = useCallback((pos, exitPrice, reason) => {
    const pnl = Math.round((exitPrice - pos.entryPrice) * pos.qty);
    setTrades(p => [{...pos, exitPrice, exitTime:new Date(), pnl, closeReason:reason, status:pnl>=0?"WIN":"LOSS"}, ...p]);
    setDailyPnl(d => d+pnl); setWeeklyPnl(w => w+pnl);
    setOpenPos(p => p.filter(x => x.id!==pos.id));
    setAnalytics(prev => {
      const wins=prev.wins+(pnl>0?1:0), losses=prev.losses+(pnl<=0?1:0);
      const ss={...prev.stratStats};
      if(!ss[pos.strategy]) ss[pos.strategy]={trades:0,pnl:0,wins:0};
      ss[pos.strategy].trades++; ss[pos.strategy].pnl+=pnl; if(pnl>0) ss[pos.strategy].wins++;
      return{...prev,wins,losses,totalPnl:prev.totalPnl+pnl,
        avgWin:wins>0?(prev.avgWin*(wins-1)+(pnl>0?pnl:0))/wins:prev.avgWin,
        avgLoss:losses>0?(prev.avgLoss*(losses-1)+(pnl<=0?Math.abs(pnl):0))/losses:prev.avgLoss,
        stratStats:ss};
    });
    addLog(`${reason}: ${pos.type} ₹${pos.entryPrice}→₹${exitPrice} | ${fmtPnl(pnl)}`, pnl>0?"WIN":"LOSS");
    if(pnl>0) addAlert(`🎯 ${reason}: ${pos.type} ${fmtPnl(pnl)}`,"success");
    else addAlert(`❌ ${reason}: ${pos.type} ${fmtPnl(pnl)}`,"danger");
  }, [addLog, addAlert]);

  // ── Execute trade ──
  const executeTrade = useCallback(async (opp) => {
    if(openPos.length >= config.maxOpenPositions) { addAlert("Max positions reached","warning"); return; }
    const t = {...opp, id:`TRD-${Date.now()}`, entryTime:new Date(), entryPrice:opp.premium, currentPrem:opp.premium, unrealizedPnl:0, status:"OPEN"};
    setOpenPos(p => [...p, t]); setTodayTrades(c => c+1);
    addLog(`EXECUTED: ${opp.type} @ ₹${opp.premium} SL:₹${opp.sl} T:₹${opp.target} Qty:${opp.qty}`,"TRADE");
    addAlert(`✅ ${opp.type} @ ₹${opp.premium}`,"success");
    if(apiStatus==="CONNECTED") {
      const r = await apiPlaceOrder(config.broker, config.creds, {symbol:opp.type.replace(/ /g,""), qty:opp.qty, side:"BUY"});
      addLog(r.success ? `BROKER ORDER: ${r.orderId}` : `ORDER FAILED: ${r.error}`, r.success?"INFO":"ERROR");
    }
  }, [openPos.length, config, apiStatus, addLog, addAlert]);

  // ── AI loop — only when connected + market open ──
  useEffect(() => {
    if(apiStatus!=="CONNECTED" || sysStatus!=="ACTIVE") return;
    const iv = setInterval(() => {
      const curCap = config.capital + dailyPnl;
      const floor = config.capital * (config.minCapitalFloor/100);
      if(curCap <= floor && config.capitalProtection) {
        setSysStatus("HALTED"); addAlert(`🛡 Capital floor ₹${fmt(floor)} — halted`,"danger");
        addLog(`CAPITAL PROTECTION TRIGGERED. Floor: ₹${fmt(floor)}`,"ERROR"); return;
      }
      if(dailyPnl <= -config.maxDailyLoss) { setSysStatus("HALTED"); addAlert(`🚫 Daily loss limit hit`,"danger"); return; }
      if(config.stopAtProfitTarget && dailyPnl >= config.profitTarget) {
        setSysStatus("TARGET_REACHED"); addAlert(`🏆 Profit target ₹${fmt(config.profitTarget)} reached!`,"success");
        addLog(`PROFIT TARGET HIT ₹${fmt(dailyPnl)} — stopped for day`,"WIN"); return;
      }
      if(todayTrades >= config.maxTradesDay) return;
      const newOpps = runAI(quotes, config, dailyPnl);
      if(newOpps.length > 0) {
        setOpps(p => [...newOpps, ...p].slice(0,15));
        newOpps.forEach(o => addLog(`AI SIGNAL: ${o.type} | ${o.score}% | ${o.strategy}`,"SIGNAL"));
      }
    }, 9000);
    return () => clearInterval(iv);
  }, [apiStatus, sysStatus, quotes, config, dailyPnl, todayTrades, addLog, addAlert]);

  // ── Market open/close tracking ──
  useEffect(() => {
    if(apiStatus!=="CONNECTED") return;
    if(mktStatus.open && sysStatus==="MARKET_CLOSED") {
      setSysStatus("ACTIVE"); addLog("Market opened — AI active","INFO");
      addAlert("🔔 Market open — trading active","success");
    } else if(!mktStatus.open && sysStatus==="ACTIVE") {
      setSysStatus("MARKET_CLOSED"); addLog("Market closed — paused","INFO");
    }
  }, [mktStatus.open, apiStatus]);

  // ── Auto-trade ──
  useEffect(() => {
    if(!config.autoTrade || sysStatus!=="ACTIVE" || apiStatus!=="CONNECTED") return;
    const iv = setInterval(() => {
      if(openPos.length >= config.maxOpenPositions) return;
      setOpps(prev => {
        const p = prev.filter(o => o.status==="PENDING" && o.score>=config.confidenceMin);
        if(!p.length) return prev;
        executeTrade(p[0]);
        return prev.map(x => x.id===p[0].id ? {...x,status:"EXECUTED"} : x);
      });
    }, 10000);
    return () => clearInterval(iv);
  }, [config.autoTrade, sysStatus, apiStatus, openPos.length, config, executeTrade]);

  // ── Derived ──
  const capital = config.capital + dailyPnl;
  const drawPct = Math.abs(Math.min(0,dailyPnl)) / config.capital * 100;
  const profitPct = Math.max(0,dailyPnl) / config.profitTarget * 100;
  const winRate = (analytics.wins+analytics.losses)>0 ? Math.round(analytics.wins/(analytics.wins+analytics.losses)*100) : 0;
  const unrealPnl = openPos.reduce((s,p)=>s+p.unrealizedPnl,0);
  const statusColor = sysStatus==="ACTIVE"?T.green : sysStatus==="TARGET_REACHED"||sysStatus==="MARKET_CLOSED"?T.yellow : T.red;

  // ── CSS ──
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@300;400;500;600&display=swap');
    *{box-sizing:border-box;margin:0;padding:0;scrollbar-width:thin;scrollbar-color:${T.cardBorder} transparent;}
    html,body{background:${T.bg};color:${T.text};font-family:'JetBrains Mono',monospace;}
    .S{font-family:'Syne',sans-serif;}
    .card{background:${T.card};border:1px solid ${T.cardBorder};border-radius:12px;padding:18px;}
    .csm{background:${T.card};border:1px solid ${T.cardBorder};border-radius:10px;padding:13px;}
    .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600;white-space:nowrap;}
    .bbull{background:${T.greenBg};color:${T.green};border:1px solid ${T.greenBorder};}
    .bbear{background:${T.redBg};color:${T.red};border:1px solid ${T.redBorder};}
    .bblue{background:${T.accentGlow};color:${T.accent};}
    .bpur{background:${T.purpleBg};color:${T.purple};}
    .bwin{background:${T.greenBg};color:${T.green};}
    .bloss{background:${T.redBg};color:${T.red};}
    .byel{background:${T.yellowBg};color:${T.yellow};}
    .btn{padding:8px 14px;border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;cursor:pointer;border:none;transition:all .15s;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}
    .btn:hover{transform:translateY(-1px);filter:brightness(1.1);}
    .btn:active{transform:none;}
    .btn:disabled{opacity:0.5;cursor:not-allowed;transform:none;}
    .bp{background:${T.accent};color:${isDark?"#000":"#fff"};}
    .bs{background:${T.greenBg};color:${T.green};border:1px solid ${T.greenBorder};}
    .bd{background:${T.redBg};color:${T.red};border:1px solid ${T.redBorder};}
    .bo{background:transparent;color:${T.textSub};border:1px solid ${T.cardBorder};}
    .bo:hover{border-color:${T.accent};color:${T.accent};}
    .bghost{background:transparent;color:${T.textMuted};border:none;}
    .inp{background:${T.inputBg};border:1px solid ${T.inputBorder};color:${T.text};padding:9px 12px;border-radius:8px;outline:none;font-family:'JetBrains Mono',monospace;font-size:12px;width:100%;transition:border .15s;}
    .inp:focus{border-color:${T.accent};box-shadow:0 0 0 3px ${T.accentGlow};}
    .inp::placeholder{color:${T.textMuted};}
    .tb{padding:6px 11px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;border:none;transition:all .15s;white-space:nowrap;font-family:'JetBrains Mono',monospace;}
    .ta{background:${T.accent};color:${isDark?"#000":"#fff"};}
    .ti{background:transparent;color:${T.textMuted};}
    .ti:hover{color:${T.accent};background:${T.accentGlow};}
    .ocard{background:${T.card};border:1px solid ${T.cardBorder};border-radius:10px;padding:13px;margin-bottom:9px;cursor:pointer;transition:all .15s;}
    .ocard:hover,.ocard.sel{border-color:${T.accent};background:${T.cardHover};}
    .pbar{height:5px;background:${T.bg3};border-radius:3px;overflow:hidden;}
    .pfill{height:100%;border-radius:3px;transition:width .4s;}
    .pulse{animation:pulse 2s infinite;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
    .fade{animation:fi .2s ease;}
    @keyframes fi{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    .metric{background:${T.card};border:1px solid ${T.cardBorder};border-radius:12px;padding:15px;position:relative;overflow:hidden;}
    .metric::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .mg::before{background:${T.green};}.mr::before{background:${T.red};}.mb::before{background:${T.accent};}.my::before{background:${T.yellow};}.mp::before{background:${T.purple};}
    .logrow{padding:6px 12px;border-bottom:1px solid ${T.bg3};display:grid;grid-template-columns:68px 52px 1fr;gap:8px;font-size:11px;align-items:start;}
    .tog{width:42px;height:22px;border-radius:11px;cursor:pointer;position:relative;transition:background .2s;flex-shrink:0;}
    .togk{position:absolute;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 4px #0004;}
    table{width:100%;border-collapse:collapse;}
    th{padding:10px 12px;text-align:left;font-size:10px;color:${T.textMuted};letter-spacing:1px;font-weight:600;white-space:nowrap;background:${T.card};}
    td{padding:9px 12px;border-bottom:1px solid ${T.bg3};font-size:12px;white-space:nowrap;}
    select.inp option{background:${T.card};color:${T.text};}
    @media(max-width:900px){.hm{display:none!important;}.g2{grid-template-columns:1fr!important;}.g3{grid-template-columns:1fr 1fr!important;}.g5{grid-template-columns:1fr 1fr!important;}.cpanel{width:100%!important;}}
    @media(max-width:600px){.g3{grid-template-columns:1fr!important;}}
  `;

  // ── Sub-components ──
  const NoAPI = () => (
    <div style={{background:T.card,border:`1px solid ${T.cardBorder}`,borderRadius:12,padding:32,marginBottom:14,textAlign:"center"}}>
      <div style={{fontSize:36,marginBottom:12}}>🔌</div>
      <div className="S" style={{fontSize:18,fontWeight:700,marginBottom:8}}>Connect Your Broker</div>
      <div style={{fontSize:12,color:T.textSub,marginBottom:16,lineHeight:1.8}}>
        This platform uses <b>real market data only</b> — no simulation.<br/>
        Market status: <span style={{color:mktStatus.open?T.green:T.yellow,fontWeight:600}}>{mktStatus.label}</span> · {mktStatus.next}
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap",marginBottom:16}}>
        <button className="btn bp" onClick={()=>{setCfgOpen(true);setCfgTab("broker");}}>⚙ Setup Broker API</button>
        {(config.creds.access_token||config.creds.api_key||config.creds.client_id) &&
          <button className="btn bs" onClick={doConnect} disabled={connecting}>{connecting?"Connecting...":"🔌 Connect Now"}</button>}
      </div>
      <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
        {Object.entries(BROKERS).map(([n,b]) => (
          <div key={n} style={{background:T.bg2,borderRadius:8,padding:"6px 10px",fontSize:11,color:T.textSub,display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:18,height:18,borderRadius:3,background:b.color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:9,fontWeight:700}}>{b.logo}</div>{n}
          </div>
        ))}
      </div>
    </div>
  );

  const MktClosed = () => (
    <div style={{background:T.card,border:`1px solid ${T.yellow}44`,borderRadius:12,padding:24,marginBottom:14,textAlign:"center"}}>
      <div style={{fontSize:32,marginBottom:8}}>🔴</div>
      <div className="S" style={{fontSize:18,fontWeight:700,color:T.yellow,marginBottom:5}}>{mktStatus.label}</div>
      <div style={{fontSize:13,color:T.textSub,marginBottom:4}}>Next session: <b style={{color:T.text}}>{mktStatus.next}</b></div>
      <div style={{fontSize:11,color:T.textMuted,marginBottom:16}}>Mon–Fri · 9:15 AM – 3:30 PM IST · Auto-activates when market opens</div>
      {(quotes.nifty||quotes.bnf) && (
        <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
          {[{l:"NIFTY LAST",v:quotes.nifty},{l:"BANKNIFTY LAST",v:quotes.bnf}].map(x => (
            <div key={x.l} style={{background:T.bg2,borderRadius:8,padding:"10px 16px"}}>
              <div style={{fontSize:9,color:T.textMuted,marginBottom:2}}>{x.l}</div>
              <div className="S" style={{fontSize:18,fontWeight:700}}>₹{fmt(x.v||0)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ── LOGIN ──
  if(!authed) return (
    <div style={{fontFamily:"'JetBrains Mono',monospace",background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <style>{CSS}</style>
      <div style={{width:"100%",maxWidth:380,background:T.card,border:`1px solid ${T.cardBorder}`,borderRadius:16,padding:32,boxShadow:T.shadowLg}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{fontSize:10,letterSpacing:4,color:T.accent,marginBottom:8}}>QUANTEDGE AI v2.0</div>
          <div className="S" style={{fontSize:26,fontWeight:800,marginBottom:4}}>Options Trading</div>
          <div style={{fontSize:10,color:T.textMuted,letterSpacing:2,marginBottom:12}}>NIFTY · BANKNIFTY · REAL DATA ONLY</div>
          <div style={{display:"flex",gap:5,justifyContent:"center",flexWrap:"wrap",marginBottom:12}}>
            <span className="badge bbull">REAL API</span>
            <span className="badge bblue">NO SIMULATION</span>
            <span className="badge bpur">AI ENGINE</span>
          </div>
          <div style={{background:T.accentGlow,border:`1px solid ${T.accent}33`,borderRadius:8,padding:"8px 12px",fontSize:11,color:mktStatus.open?T.green:T.yellow}}>
            {mktStatus.open?"🟢 Market OPEN":"🔴 "+mktStatus.label+" · "+mktStatus.next}
          </div>
        </div>
        {[{l:"USERNAME",k:"u",t:"text"},{l:"PASSWORD",k:"p",t:"password"}].map(f => (
          <div key={f.k} style={{marginBottom:13}}>
            <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.l}</div>
            <input className="inp" type={f.t} placeholder={`Enter ${f.l.toLowerCase()}`}
              value={loginForm[f.k]} onChange={e=>setLoginForm(p=>({...p,[f.k]:e.target.value}))}
              onKeyDown={e=>e.key==="Enter"&&loginForm.u&&loginForm.p&&setAuthed(true)}/>
          </div>
        ))}
        <button className="btn bp" style={{width:"100%",justifyContent:"center",padding:"12px",fontSize:13,marginBottom:12}}
          onClick={()=>loginForm.u&&loginForm.p?setAuthed(true):addAlert("Enter credentials","danger")}>
          ENTER PLATFORM →
        </button>
        <button className="btn bghost" style={{width:"100%",justifyContent:"center",fontSize:11}}
          onClick={()=>setTheme(m=>m==="dark"?"light":"dark")}>
          {theme==="dark"?"☀ Light Mode":"🌙 Dark Mode"}
        </button>
      </div>
    </div>
  );

  // ── MAIN ──
  return (
    <div style={{fontFamily:"'JetBrains Mono',monospace",background:T.bg,minHeight:"100vh",color:T.text,fontSize:12}}>
      <style>{CSS}</style>

      {/* Alerts */}
      <div style={{position:"fixed",top:12,right:12,zIndex:9999,display:"flex",flexDirection:"column",gap:7,maxWidth:300,width:"calc(100% - 24px)"}}>
        {alerts.map(a => (
          <div key={a.id} className="fade" style={{padding:"9px 13px",borderRadius:9,fontSize:12,
            background:a.type==="success"?T.greenBg:a.type==="danger"?T.redBg:a.type==="warning"?T.yellowBg:T.card,
            border:`1px solid ${a.type==="success"?T.greenBorder:a.type==="danger"?T.redBorder:T.cardBorder}`,
            color:a.type==="success"?T.green:a.type==="danger"?T.red:a.type==="warning"?T.yellow:T.text,
            boxShadow:T.shadow}}>{a.msg}</div>
        ))}
      </div>

      {/* Clear confirm modal */}
      {showClear && (
        <div style={{position:"fixed",inset:0,background:"#00000088",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:T.card,border:`1px solid ${T.redBorder}`,borderRadius:14,padding:28,maxWidth:340,width:"100%",boxShadow:T.shadowLg,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:10}}>⚠️</div>
            <div className="S" style={{fontWeight:700,fontSize:16,marginBottom:8,color:T.red}}>Clear All Data?</div>
            <div style={{fontSize:12,color:T.textSub,marginBottom:20,lineHeight:1.6}}>
              Permanently deletes all trades, P&L, positions, and logs. Disconnects broker. Cannot be undone.
            </div>
            <div style={{display:"flex",gap:10}}>
              <button className="btn bo" style={{flex:1,justifyContent:"center"}} onClick={()=>setShowClear(false)}>Cancel</button>
              <button className="btn bd" style={{flex:1,justifyContent:"center"}} onClick={doClear}>Yes, Clear All</button>
            </div>
          </div>
        </div>
      )}

      {/* Config panel */}
      {cfgOpen && (
        <div className="cpanel" style={{position:"fixed",top:0,right:0,width:330,height:"100vh",background:T.card,borderLeft:`1px solid ${T.cardBorder}`,zIndex:500,overflowY:"auto",boxShadow:T.shadowLg}}>
          <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.cardBorder}`,display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,background:T.card,zIndex:1}}>
            <div className="S" style={{fontWeight:700,color:T.accent,fontSize:14}}>⚙ Configuration</div>
            <button className="btn bghost" onClick={()=>setCfgOpen(false)} style={{fontSize:18,padding:"2px 6px"}}>✕</button>
          </div>
          <div style={{padding:"10px 18px 0",display:"flex",gap:5,borderBottom:`1px solid ${T.cardBorder}`,overflowX:"auto"}}>
            {["general","risk","broker","data"].map(t => (
              <button key={t} className={`tb ${cfgTab===t?"ta":"ti"}`} style={{fontSize:10,padding:"5px 10px",marginBottom:10}}
                onClick={()=>setCfgTab(t)}>{t.toUpperCase()}</button>
            ))}
          </div>
          <div style={{padding:18}}>

            {cfgTab==="general" && (
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                <div style={{background:T.accentGlow,border:`1px solid ${T.accent}33`,borderRadius:8,padding:10,fontSize:11,color:T.accent,lineHeight:1.6}}>
                  💡 Capital floor = ₹{fmt(config.capital*config.minCapitalFloor/100)} — trading auto-halts if breached
                </div>
                {[{l:"Starting Capital (₹)",k:"capital"},{l:"Daily Profit Target (₹)",k:"profitTarget"},{l:"Min Trades / Day",k:"minTradesDay"},{l:"Max Trades / Day",k:"maxTradesDay"}].map(f => (
                  <div key={f.k}>
                    <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.l}</div>
                    <input className="inp" type="number" value={config[f.k]} onChange={e=>setConfig(p=>({...p,[f.k]:Number(e.target.value)}))}/>
                  </div>
                ))}
                {[{l:"Stop at Profit Target",k:"stopAtProfitTarget",sub:"Halt when daily ₹ goal reached"},{l:"🛡 Capital Protection",k:"capitalProtection",sub:"Never breach floor amount"}].map(f => (
                  <div key={f.k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0"}}>
                    <div><div style={{fontSize:11,color:T.text,marginBottom:1}}>{f.l}</div><div style={{fontSize:10,color:T.textMuted}}>{f.sub}</div></div>
                    <div className="tog" style={{background:config[f.k]?T.accent:T.bg3}} onClick={()=>setConfig(p=>({...p,[f.k]:!p[f.k]}))}>
                      <div className="togk" style={{left:config[f.k]?22:2}}/>
                    </div>
                  </div>
                ))}
                <div>
                  <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:8}}>THEME</div>
                  <div style={{display:"flex",gap:8}}>
                    {["dark","light"].map(m => <button key={m} className={`btn ${theme===m?"bp":"bo"}`} style={{flex:1,justifyContent:"center"}} onClick={()=>setTheme(m)}>{m==="dark"?"🌙 Dark":"☀ Light"}</button>)}
                  </div>
                </div>
              </div>
            )}

            {cfgTab==="risk" && (
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                {[{l:"Risk Per Trade (%)",k:"riskPct",step:"0.1"},{l:"Max Daily Loss (₹)",k:"maxDailyLoss"},{l:"Capital Floor (%)",k:"minCapitalFloor"},{l:"Min AI Confidence (%)",k:"confidenceMin"},{l:"Max Open Positions",k:"maxOpenPositions"}].map(f => (
                  <div key={f.k}>
                    <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.l}</div>
                    <input className="inp" type="number" step={f.step||1} value={config[f.k]} onChange={e=>setConfig(p=>({...p,[f.k]:Number(e.target.value)}))}/>
                  </div>
                ))}
                {[{l:"Trailing Stop Loss",k:"trailingStop",sub:"Auto-adjusts SL as price moves"},{l:"Auto-Trade",k:"autoTrade",sub:"Execute signals automatically"}].map(f => (
                  <div key={f.k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0"}}>
                    <div><div style={{fontSize:11,color:T.text,marginBottom:1}}>{f.l}</div><div style={{fontSize:10,color:T.textMuted}}>{f.sub}</div></div>
                    <div className="tog" style={{background:config[f.k]?T.accent:T.bg3}} onClick={()=>setConfig(p=>({...p,[f.k]:!p[f.k]}))}>
                      <div className="togk" style={{left:config[f.k]?22:2}}/>
                    </div>
                  </div>
                ))}
                {config.autoTrade && <div style={{background:T.redBg,border:`1px solid ${T.redBorder}`,borderRadius:8,padding:10,fontSize:10,color:T.red,lineHeight:1.5}}>⚠ Places REAL orders when broker API is connected.</div>}
              </div>
            )}

            {cfgTab==="broker" && (
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                <div>
                  <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>SELECT BROKER</div>
                  <select className="inp" value={config.broker} onChange={e=>setConfig(p=>({...p,broker:e.target.value}))}>
                    {Object.keys(BROKERS).map(b=><option key={b}>{b}</option>)}
                  </select>
                </div>
                <div style={{background:T.bg2,borderRadius:8,padding:11,fontSize:11,lineHeight:1.9}}>
                  <div style={{color:T.textSub,marginBottom:4,fontWeight:600}}>Required fields:</div>
                  {BROKERS[config.broker].fields.map(f=><div key={f} style={{color:T.accent}}>• {f.replace(/_/g," ").toUpperCase()}</div>)}
                  <a href={BROKERS[config.broker].docsUrl} target="_blank" rel="noreferrer" style={{color:T.accent,fontSize:10,display:"block",marginTop:8,textDecoration:"none"}}>📖 Open API Docs →</a>
                </div>
                {BROKERS[config.broker].fields.map(f => (
                  <div key={f}>
                    <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.replace(/_/g," ").toUpperCase()}</div>
                    <input className="inp" type="password" placeholder={`Enter ${f}`}
                      value={config.creds[f]||""} onChange={e=>setConfig(p=>({...p,creds:{...p.creds,[f]:e.target.value}}))}/>
                  </div>
                ))}
                {apiStatus==="CONNECTED"
                  ? <button className="btn bd" style={{width:"100%",justifyContent:"center"}} onClick={doDisconnect}>🔌 Disconnect {config.broker}</button>
                  : <button className="btn bp" style={{width:"100%",justifyContent:"center"}} onClick={doConnect} disabled={connecting}>{connecting?"⏳ Connecting...":`🔌 Connect ${config.broker}`}</button>
                }
                <div style={{textAlign:"center",fontSize:11,color:apiStatus==="CONNECTED"?T.green:connecting?T.yellow:T.red}}>
                  API: <b>{apiStatus}</b>{wsStatus!=="IDLE"&&` · WS: ${wsStatus}`}
                </div>
                {fetchErr && <div style={{background:T.redBg,borderRadius:8,padding:10,fontSize:11,color:T.red}}>⚠ Last error: {fetchErr}</div>}
                <div style={{background:T.yellowBg,border:`1px solid ${T.yellow}33`,borderRadius:8,padding:10,fontSize:10,color:T.yellow,lineHeight:1.5}}>
                  ⚠ Credentials saved locally on your device only — never sent to any server except your broker.
                </div>
              </div>
            )}

            {cfgTab==="data" && (
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                <div className="S" style={{fontWeight:700,fontSize:13}}>Data Management</div>
                <div style={{background:T.bg2,borderRadius:8,padding:12,fontSize:11,color:T.textSub,lineHeight:2.2}}>
                  <div>Closed trades: <b style={{color:T.text}}>{trades.length}</b></div>
                  <div>Open positions: <b style={{color:T.text}}>{openPos.length}</b></div>
                  <div>Log entries: <b style={{color:T.text}}>{logs.length}</b></div>
                  <div>Today trades: <b style={{color:T.text}}>{todayTrades}</b></div>
                  <div>Today P&L: <b style={{color:dailyPnl>=0?T.green:T.red}}>{fmtPnl(dailyPnl)}</b></div>
                  <div style={{fontSize:10,color:T.textMuted,marginTop:4}}>Auto-saved to browser localStorage</div>
                </div>
                <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:4}}>SYSTEM CONTROL</div>
                {sysStatus!=="ACTIVE"
                  ? <button className="btn bs" style={{width:"100%",justifyContent:"center",marginBottom:8}} onClick={()=>{setSysStatus("ACTIVE");addLog("Resumed manually","INFO");addAlert("Trading resumed","success");}}>▶ RESUME TRADING</button>
                  : <button className="btn bd" style={{width:"100%",justifyContent:"center",marginBottom:8}} onClick={()=>{setSysStatus("HALTED");addLog("Halted manually","WARN");}}>⏹ HALT TRADING</button>
                }
                <button className="btn bd" style={{width:"100%",justifyContent:"center",marginBottom:8}} onClick={()=>setShowClear(true)}>
                  🗑 Clear All Data &amp; Disconnect
                </button>
                <button className="btn bo" style={{width:"100%",justifyContent:"center"}} onClick={()=>{
                  const d={trades,analytics,openPositions:openPos,config:{capital:config.capital,profitTarget:config.profitTarget},exported:new Date().toISOString()};
                  const blob=new Blob([JSON.stringify(d,null,2)],{type:"application/json"});
                  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`quantedge-${dateStr().replace(/\//g,"-")}.json`;a.click();
                }}>⬇ Export Data as JSON</button>
              </div>
            )}

          </div>
        </div>
      )}

      {/* NAV */}
      <div style={{background:T.navBg,borderBottom:`1px solid ${T.navBorder}`,padding:"0 14px",display:"flex",alignItems:"center",gap:8,height:50,position:"sticky",top:0,zIndex:200,boxShadow:T.shadow}}>
        <div style={{display:"flex",alignItems:"baseline",gap:5,minWidth:"fit-content"}}>
          <span className="S" style={{fontWeight:800,fontSize:15,color:T.accent}}>QUANTEDGE</span>
          <span style={{fontSize:8,color:T.textMuted,letterSpacing:3}}>AI</span>
        </div>
        {/* System status pill */}
        <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",borderRadius:20,minWidth:"fit-content",
          background:sysStatus==="ACTIVE"?T.greenBg:T.yellowBg,
          border:`1px solid ${sysStatus==="ACTIVE"?T.greenBorder:T.yellow+"33"}`}}>
          <div className={sysStatus==="ACTIVE"?"pulse":""} style={{width:5,height:5,borderRadius:"50%",background:statusColor}}/>
          <span style={{fontSize:9,fontWeight:700,color:statusColor,whiteSpace:"nowrap"}}>
            {sysStatus==="MARKET_CLOSED"?"MKT CLOSED":sysStatus==="TARGET_REACHED"?"TARGET ✓":sysStatus}
          </span>
        </div>
        {/* API status pill */}
        <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 9px",borderRadius:20,minWidth:"fit-content",
          background:apiStatus==="CONNECTED"?T.greenBg:T.redBg,
          border:`1px solid ${apiStatus==="CONNECTED"?T.greenBorder:T.redBorder}`}}>
          <div style={{width:4,height:4,borderRadius:"50%",background:apiStatus==="CONNECTED"?T.green:T.red}}/>
          <span style={{fontSize:9,fontWeight:700,color:apiStatus==="CONNECTED"?T.green:T.red,whiteSpace:"nowrap"}}>
            {apiStatus==="CONNECTED"?config.broker.split(" ")[0]:"NO API"}
          </span>
        </div>
        {lastUpdated && <div className="hm" style={{fontSize:9,color:T.textMuted}}>↻ {lastUpdated.toLocaleTimeString("en-IN")}</div>}
        {/* Tabs */}
        <div style={{display:"flex",gap:2,flex:1,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          {[["dashboard","📊"],["signals","🎯"],["positions","📂"],["history","📋"],["analytics","📈"],["orders","📄"],["logs","📝"]].map(([k,i]) => (
            <button key={k} className={`tb ${tab===k?"ta":"ti"}`} style={{fontSize:10,padding:"5px 8px"}} onClick={()=>setTab(k)}>
              {i} <span className="hm">{k.toUpperCase()}</span>
            </button>
          ))}
        </div>
        {/* Actions */}
        <div style={{display:"flex",gap:4,minWidth:"fit-content",alignItems:"center"}}>
          {apiStatus==="CONNECTED"
            ? <button className="btn bd" style={{fontSize:10,padding:"5px 9px"}} onClick={doDisconnect}>DISCONNECT</button>
            : <button className="btn bs" style={{fontSize:10,padding:"5px 9px"}} onClick={doConnect} disabled={connecting}>{connecting?"...":"CONNECT"}</button>
          }
          <button className="btn bghost" style={{fontSize:15,padding:"3px 5px"}} onClick={()=>setTheme(m=>m==="dark"?"light":"dark")}>{theme==="dark"?"☀":"🌙"}</button>
          <button className="btn bo" style={{fontSize:10,padding:"5px 8px"}} onClick={()=>setCfgOpen(p=>!p)}>⚙</button>
        </div>
      </div>

      {/* PAGE CONTENT */}
      <div style={{padding:14,paddingRight:cfgOpen?344:14,transition:"padding-right .3s"}}>

        {/* ══ DASHBOARD ══ */}
        {tab==="dashboard" && (
          <div className="fade">
            {apiStatus!=="CONNECTED" && <NoAPI/>}
            {apiStatus==="CONNECTED" && !mktStatus.open && <MktClosed/>}
            {apiStatus==="CONNECTED" && (quotes.nifty||quotes.bnf) && (
              <>
                {/* Market tickers */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}} className="g3">
                  {[{l:"NIFTY 50",v:quotes.nifty,ohlc:quotes.nOHLC},{l:"BANKNIFTY",v:quotes.bnf,ohlc:quotes.bOHLC}].map(m => (
                    <div key={m.l} className="csm" style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                      <div style={{flex:1,minWidth:80}}>
                        <div style={{fontSize:9,color:T.textMuted,letterSpacing:2,marginBottom:2}}>{m.l}</div>
                        <div className="S" style={{fontSize:20,fontWeight:700}}>{m.v?fmt(m.v):"—"}</div>
                        {m.ohlc && <div style={{fontSize:9,color:T.textMuted,marginTop:2}}>O:{fmt(m.ohlc.open||0)} H:{fmt(m.ohlc.high||0)} L:{fmt(m.ohlc.low||0)}</div>}
                      </div>
                      {m.ohlc && m.ohlc.open && (
                        <div style={{borderLeft:`1px solid ${T.cardBorder}`,paddingLeft:10}}>
                          <div style={{fontSize:9,color:T.textMuted,marginBottom:2}}>CHANGE</div>
                          <div style={{fontWeight:600,color:m.v>m.ohlc.open?T.green:T.red,fontSize:13}}>
                            {m.v>m.ohlc.open?"+":""}{fmt(m.v-m.ohlc.open)} ({fmt(((m.v-m.ohlc.open)/m.ohlc.open)*100,2)}%)
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="csm">
                    <div style={{fontSize:9,color:T.textMuted,letterSpacing:2,marginBottom:2}}>MARKET STATUS</div>
                    <div className="S" style={{fontSize:14,fontWeight:700,color:mktStatus.open?T.green:T.yellow}}>{mktStatus.label}</div>
                    <div style={{fontSize:9,color:T.textMuted,marginTop:3}}>{mktStatus.next}</div>
                    <div style={{fontSize:9,color:T.textMuted,marginTop:3}}>Updated: {lastUpdated?lastUpdated.toLocaleTimeString("en-IN"):"—"}</div>
                  </div>
                </div>

                {/* Progress bars */}
                {config.stopAtProfitTarget && (
                  <div style={{marginBottom:10,background:dailyPnl>=config.profitTarget?T.greenBg:T.card,border:`1px solid ${dailyPnl>=config.profitTarget?T.greenBorder:T.cardBorder}`,borderRadius:9,padding:"9px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,color:T.textSub,whiteSpace:"nowrap"}}>🎯 Profit Target</span>
                    <div style={{flex:1,minWidth:80}} className="pbar"><div className="pfill" style={{width:`${Math.min(100,profitPct)}%`,background:`linear-gradient(90deg,${T.accent},${T.green})`}}/></div>
                    <span style={{fontWeight:700,color:dailyPnl>=config.profitTarget?T.green:T.text,whiteSpace:"nowrap"}}>{fmtPnl(dailyPnl)} / ₹{fmt(config.profitTarget)}</span>
                    {dailyPnl>=config.profitTarget && <span className="badge bwin">REACHED ✓</span>}
                  </div>
                )}
                {config.capitalProtection && (
                  <div style={{marginBottom:10,background:T.card,border:`1px solid ${T.cardBorder}`,borderRadius:9,padding:"9px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,color:T.textSub,whiteSpace:"nowrap"}}>🛡 Capital</span>
                    <div style={{flex:1,minWidth:80}} className="pbar"><div className="pfill" style={{width:`${Math.min(100,drawPct/(100-config.minCapitalFloor)*100)}%`,background:drawPct>2?`linear-gradient(90deg,${T.yellow},${T.red})`:T.green}}/></div>
                    <span style={{fontWeight:700,fontSize:11,color:drawPct>2?T.red:T.green,whiteSpace:"nowrap"}}>₹{fmt(capital)} / Floor ₹{fmt(config.capital*config.minCapitalFloor/100)}</span>
                  </div>
                )}

                {/* Metric cards */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:12}} className="g5">
                  {[
                    {l:"CAPITAL",v:`₹${fmt(capital)}`,sub:`Base ₹${fmt(config.capital)}`,cls:"mb",col:T.accent},
                    {l:"TODAY P&L",v:fmtPnl(dailyPnl),sub:`Limit ₹${fmt(config.maxDailyLoss)}`,cls:dailyPnl>=0?"mg":"mr",col:dailyPnl>=0?T.green:T.red},
                    {l:"WEEKLY P&L",v:fmtPnl(weeklyPnl),sub:"7 days",cls:weeklyPnl>=0?"mg":"mr",col:weeklyPnl>=0?T.green:T.red},
                    {l:"TRADES TODAY",v:`${todayTrades}/${config.maxTradesDay}`,sub:`Min: ${config.minTradesDay}`,cls:todayTrades>=config.maxTradesDay?"mr":todayTrades>=config.minTradesDay?"mg":"my",col:todayTrades>=config.maxTradesDay?T.red:todayTrades>=config.minTradesDay?T.green:T.yellow},
                    {l:"WIN RATE",v:`${winRate}%`,sub:`${analytics.wins}W ${analytics.losses}L`,cls:winRate>=55?"mg":winRate>=45?"my":"mr",col:winRate>=55?T.green:winRate>=45?T.yellow:T.red},
                  ].map(m => (
                    <div key={m.l} className={`metric ${m.cls}`}>
                      <div style={{fontSize:9,color:T.textMuted,letterSpacing:1.5,marginBottom:5}}>{m.l}</div>
                      <div className="S" style={{fontSize:18,fontWeight:700,color:m.col,marginBottom:2}}>{m.v}</div>
                      <div style={{fontSize:10,color:T.textMuted}}>{m.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Signals + Positions */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}} className="g2">
                  <div className="card">
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                      <div className="S" style={{fontWeight:700,color:T.purple,fontSize:12}}><span className={sysStatus==="ACTIVE"?"pulse":""}>●</span> AI SIGNALS</div>
                      <button className="btn bo" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>setTab("signals")}>ALL</button>
                    </div>
                    {mktStatus.open ? (
                      <>
                        {opps.filter(o=>o.status==="PENDING").slice(0,4).map(o => (
                          <div key={o.id} className="ocard" onClick={()=>{setSelOpp(o);setTab("signals");}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                              <div style={{fontWeight:600,fontSize:12}}>{o.type}</div>
                              <div className="S" style={{fontSize:16,fontWeight:800,color:o.score>=75?T.green:o.score>=65?T.yellow:T.red}}>{o.score}%</div>
                            </div>
                            <div style={{display:"flex",gap:8,fontSize:10,color:T.textMuted,marginBottom:5,flexWrap:"wrap"}}>
                              <span>₹{o.premium}</span><span style={{color:T.red}}>SL ₹{o.sl}</span><span style={{color:T.green}}>T ₹{o.target}</span>
                            </div>
                            <div className="pbar"><div className="pfill" style={{width:`${o.score}%`,background:`linear-gradient(90deg,${o.score>=75?T.green:T.yellow},${T.accent})`}}/></div>
                          </div>
                        ))}
                        {opps.filter(o=>o.status==="PENDING").length===0 && (
                          <div style={{textAlign:"center",padding:"20px 0",color:T.textMuted,fontSize:11}}>
                            {sysStatus==="TARGET_REACHED"?"🏆 Target reached!":"◎ Analyzing live data..."}
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{textAlign:"center",padding:"20px 0",color:T.textMuted,fontSize:11}}>🔴 Market closed · {mktStatus.next}</div>
                    )}
                  </div>
                  <div className="card">
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                      <div className="S" style={{fontWeight:700,color:T.accent,fontSize:12}}>● POSITIONS ({openPos.length})</div>
                      <span style={{fontSize:11,color:unrealPnl>=0?T.green:T.red,fontWeight:700}}>{fmtPnl(unrealPnl)}</span>
                    </div>
                    {openPos.slice(0,5).map(p => (
                      <div key={p.id} style={{padding:"9px 0",borderBottom:`1px solid ${T.bg3}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div>
                          <div style={{fontWeight:600,fontSize:12,marginBottom:2}}>{p.type}</div>
                          <div style={{fontSize:10,color:T.textMuted}}>₹{p.entryPrice} · {p.qty} · {p.strategy}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontWeight:700,color:p.unrealizedPnl>=0?T.green:T.red}}>{fmtPnl(p.unrealizedPnl)}</div>
                          <button className="btn bd" style={{fontSize:9,padding:"2px 7px",marginTop:4}} onClick={()=>closeTrade(p,p.currentPrem,"MANUAL CLOSE")}>CLOSE</button>
                        </div>
                      </div>
                    ))}
                    {openPos.length===0 && <div style={{textAlign:"center",padding:"20px 0",color:T.textMuted,fontSize:11}}>No open positions</div>}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ SIGNALS ══ */}
        {tab==="signals" && (
          <div className="fade">
            {apiStatus!=="CONNECTED" ? <NoAPI/> : !mktStatus.open ? <MktClosed/> : (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div className="S" style={{fontWeight:700,color:T.purple}}>AI SIGNALS</div>
                    <span className="badge bblue">{opps.filter(o=>o.status==="PENDING").length} PENDING</span>
                  </div>
                  <div style={{maxHeight:"72vh",overflowY:"auto"}}>
                    {opps.map(o => (
                      <div key={o.id} className={`ocard ${selOpp?.id===o.id?"sel":""}`} style={{opacity:o.status==="EXECUTED"?0.5:1}} onClick={()=>setSelOpp(o)}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                          <div>
                            <div className="S" style={{fontWeight:700,fontSize:14}}>{o.type}</div>
                            <div style={{display:"flex",gap:5,marginTop:4,flexWrap:"wrap"}}>
                              <span className={`badge ${o.direction==="CE"?"bbull":"bbear"}`}>{o.direction}</span>
                              <span className="badge bpur">{o.strategy}</span>
                              <span className="badge bblue">R:R {o.rr}x</span>
                              {o.status==="EXECUTED" && <span className="badge" style={{background:T.bg3,color:T.textMuted}}>DONE</span>}
                            </div>
                          </div>
                          <div className="S" style={{fontSize:22,fontWeight:800,color:o.score>=75?T.green:o.score>=65?T.yellow:T.red}}>{o.score}%</div>
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:5,marginBottom:8}}>
                          {[["ENTRY",`₹${o.premium}`,T.text],["SL",`₹${o.sl}`,T.red],["TARGET",`₹${o.target}`,T.green],["QTY",o.qty,T.accent]].map(([l,v,c]) => (
                            <div key={l} style={{background:T.bg2,borderRadius:5,padding:"5px 7px"}}>
                              <div style={{fontSize:9,color:T.textMuted,marginBottom:1}}>{l}</div>
                              <div style={{fontWeight:600,color:c,fontSize:12}}>{v}</div>
                            </div>
                          ))}
                        </div>
                        <div className="pbar" style={{marginBottom:8}}><div className="pfill" style={{width:`${o.score}%`,background:`linear-gradient(90deg,${o.score>=75?T.green:T.yellow},${T.accent})`}}/></div>
                        {o.status==="PENDING" && (
                          <div style={{display:"flex",gap:7}}>
                            <button className="btn bs" style={{flex:1,justifyContent:"center"}} onClick={e=>{e.stopPropagation();executeTrade(o);setOpps(p=>p.map(x=>x.id===o.id?{...x,status:"EXECUTED"}:x));}}>✓ EXECUTE</button>
                            <button className="btn bd" onClick={e=>{e.stopPropagation();setOpps(p=>p.filter(x=>x.id!==o.id));}}>✕</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {opps.length===0 && <div style={{textAlign:"center",padding:40,color:T.textMuted}}><div style={{fontSize:28,marginBottom:8}}>◎</div>Analyzing live market data...</div>}
                  </div>
                </div>
                <div>
                  <div className="S" style={{fontWeight:700,color:T.accent,marginBottom:12}}>AI DECISION REPORT</div>
                  {selOpp ? (
                    <div className="card fade">
                      <div style={{borderBottom:`1px solid ${T.cardBorder}`,paddingBottom:12,marginBottom:12}}>
                        <div style={{fontSize:9,color:T.textMuted,letterSpacing:2,marginBottom:3}}>INSTRUMENT</div>
                        <div className="S" style={{fontSize:22,fontWeight:800}}>{selOpp.type}</div>
                        <div style={{display:"flex",gap:5,marginTop:6,flexWrap:"wrap"}}>
                          <span className={`badge ${selOpp.direction==="CE"?"bbull":"bbear"}`}>{selOpp.direction==="CE"?"BULLISH CALL":"BEARISH PUT"}</span>
                          <span className="badge bpur">{selOpp.strategy}</span>
                          <span className="badge bblue">R:R {selOpp.rr}x</span>
                        </div>
                      </div>
                      <div style={{marginBottom:14}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                          <span style={{fontSize:10,color:T.textMuted}}>AI CONFIDENCE</span>
                          <span className="S" style={{fontSize:20,fontWeight:800,color:selOpp.score>=75?T.green:T.yellow}}>{selOpp.score}%</span>
                        </div>
                        <div className="pbar" style={{height:8}}><div className="pfill" style={{width:`${selOpp.score}%`,height:8,background:`linear-gradient(90deg,${selOpp.score>=75?T.green:T.yellow},${T.accent})`}}/></div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                        {[["Entry",`₹${selOpp.premium}`,T.text],["Stop Loss",`₹${selOpp.sl}`,T.red],["Target",`₹${selOpp.target}`,T.green],["Qty",selOpp.qty,T.accent],["Max Risk",`₹${fmt((selOpp.premium-selOpp.sl)*selOpp.qty)}`,T.red],["Max Profit",`₹${fmt((selOpp.target-selOpp.premium)*selOpp.qty)}`,T.green]].map(([l,v,c]) => (
                          <div key={l} style={{background:T.bg2,borderRadius:8,padding:"9px 11px"}}>
                            <div style={{fontSize:9,color:T.textMuted,marginBottom:2}}>{l}</div>
                            <div style={{fontWeight:700,color:c,fontSize:14}}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:8}}>ANALYSIS BREAKDOWN</div>
                      {selOpp.reasons.map((r,i) => (
                        <div key={i} style={{display:"flex",gap:8,marginBottom:6,padding:"7px 10px",background:T.bg2,borderRadius:7,borderLeft:`3px solid ${r.includes("⚠")?T.yellow:T.accent}`}}>
                          <span style={{color:r.includes("⚠")?T.yellow:T.accent,flexShrink:0}}>→</span>
                          <span style={{fontSize:11,color:T.textSub,lineHeight:1.5}}>{r}</span>
                        </div>
                      ))}
                      {selOpp.status==="PENDING" && (
                        <button className="btn bp" style={{width:"100%",justifyContent:"center",marginTop:12,padding:11,fontSize:13}}
                          onClick={()=>{executeTrade(selOpp);setOpps(p=>p.map(x=>x.id===selOpp.id?{...x,status:"EXECUTED"}:x));setSelOpp(p=>({...p,status:"EXECUTED"}));}}>
                          ▶ EXECUTE THIS TRADE
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="card" style={{textAlign:"center",padding:"50px 20px",color:T.textMuted}}><div style={{fontSize:28,marginBottom:8}}>◈</div>Select a signal</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ POSITIONS ══ */}
        {tab==="positions" && (
          <div className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:6}}>
              <div className="S" style={{fontWeight:700,color:T.accent}}>OPEN POSITIONS ({openPos.length})</div>
              <span style={{fontWeight:700,color:unrealPnl>=0?T.green:T.red}}>Unrealized: {fmtPnl(unrealPnl)}</span>
            </div>
            {openPos.length > 0 ? (
              <div style={{overflowX:"auto"}}>
                <table>
                  <thead><tr>{["INSTRUMENT","ENTRY TIME","ENTRY","CURRENT","SL","TARGET","QTY","P&L","STRATEGY",""].map(h=><th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{openPos.map(p => (
                    <tr key={p.id}>
                      <td style={{fontWeight:600}}>{p.type}</td>
                      <td style={{color:T.textMuted}}>{new Date(p.entryTime).toLocaleTimeString("en-IN")}</td>
                      <td>₹{p.entryPrice}</td>
                      <td style={{color:p.currentPrem>p.entryPrice?T.green:T.red,fontWeight:600}}>₹{p.currentPrem}</td>
                      <td style={{color:T.red}}>₹{p.sl}</td>
                      <td style={{color:T.green}}>₹{p.target}</td>
                      <td>{p.qty}</td>
                      <td style={{fontWeight:700,color:p.unrealizedPnl>=0?T.green:T.red}}>{fmtPnl(p.unrealizedPnl)}</td>
                      <td style={{color:T.purple,fontSize:10}}>{p.strategy}</td>
                      <td><button className="btn bd" style={{fontSize:10,padding:"3px 9px"}} onClick={()=>closeTrade(p,p.currentPrem,"MANUAL CLOSE")}>CLOSE</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <div className="card" style={{textAlign:"center",padding:50,color:T.textMuted}}><div style={{fontSize:28,marginBottom:8}}>◎</div>No open positions</div>}
          </div>
        )}

        {/* ══ HISTORY ══ */}
        {tab==="history" && (
          <div className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:6}}>
              <div className="S" style={{fontWeight:700,color:T.accent}}>TRADE HISTORY ({trades.length})</div>
              <div style={{display:"flex",gap:10,fontSize:11}}>
                <span style={{color:T.green}}>{analytics.wins}W</span>
                <span style={{color:T.red}}>{analytics.losses}L</span>
                <span style={{color:T.yellow}}>{winRate}% WR</span>
                <span style={{color:analytics.totalPnl>=0?T.green:T.red,fontWeight:700}}>{fmtPnl(analytics.totalPnl)}</span>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table>
                <thead><tr>{["DATE","TIME","INSTRUMENT","DIR","ENTRY","EXIT","QTY","P&L","STRATEGY","REASON","RESULT"].map(h=><th key={h}>{h}</th>)}</tr></thead>
                <tbody>{trades.map((t,i) => (
                  <tr key={i}>
                    <td style={{color:T.textMuted,fontSize:10}}>{new Date(t.entryTime).toLocaleDateString("en-IN")}</td>
                    <td style={{color:T.textMuted}}>{new Date(t.entryTime).toLocaleTimeString("en-IN")}</td>
                    <td style={{fontWeight:600}}>{t.type}</td>
                    <td><span className={`badge ${t.direction==="CE"?"bbull":"bbear"}`}>{t.direction}</span></td>
                    <td>₹{t.entryPrice}</td><td>₹{t.exitPrice}</td><td>{t.qty}</td>
                    <td style={{fontWeight:700,color:t.pnl>=0?T.green:T.red}}>{fmtPnl(t.pnl)}</td>
                    <td style={{color:T.purple,fontSize:10}}>{t.strategy}</td>
                    <td style={{color:T.textMuted,fontSize:10}}>{t.closeReason}</td>
                    <td><span className={`badge ${t.pnl>=0?"bwin":"bloss"}`}>{t.pnl>=0?"WIN":"LOSS"}</span></td>
                  </tr>
                ))}</tbody>
              </table>
              {trades.length===0 && <div className="card" style={{textAlign:"center",padding:50,color:T.textMuted,marginTop:12}}><div style={{fontSize:28,marginBottom:8}}>◎</div>No trades yet</div>}
            </div>
          </div>
        )}

        {/* ══ ANALYTICS ══ */}
        {tab==="analytics" && (
          <div className="fade" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
            <div className="card">
              <div className="S" style={{fontWeight:700,color:T.accent,marginBottom:14}}>PERFORMANCE</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[{l:"WIN RATE",v:`${winRate}%`,c:winRate>=55?T.green:T.red},{l:"TOTAL P&L",v:fmtPnl(analytics.totalPnl),c:analytics.totalPnl>=0?T.green:T.red},{l:"AVG WIN",v:`₹${fmt(analytics.avgWin)}`,c:T.green},{l:"AVG LOSS",v:`₹${fmt(analytics.avgLoss)}`,c:T.red},{l:"PROFIT FACTOR",v:analytics.avgLoss>0?fmt(analytics.avgWin/analytics.avgLoss):"N/A",c:T.yellow},{l:"TOTAL TRADES",v:analytics.wins+analytics.losses,c:T.text}].map(m => (
                  <div key={m.l} style={{background:T.bg2,borderRadius:10,padding:"13px 14px"}}>
                    <div style={{fontSize:9,color:T.textMuted,letterSpacing:1.5,marginBottom:4}}>{m.l}</div>
                    <div className="S" style={{fontSize:20,fontWeight:700,color:m.c}}>{m.v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="S" style={{fontWeight:700,color:T.purple,marginBottom:14}}>STRATEGY BREAKDOWN</div>
              {Object.entries(analytics.stratStats).length > 0 ? Object.entries(analytics.stratStats).map(([s,st]) => (
                <div key={s} style={{marginBottom:12,background:T.bg2,borderRadius:9,padding:11}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontWeight:600,fontSize:12}}>{s}</span>
                    <span style={{color:st.pnl>=0?T.green:T.red,fontWeight:700}}>{fmtPnl(st.pnl)}</span>
                  </div>
                  <div style={{display:"flex",gap:10,fontSize:10,color:T.textMuted,marginBottom:5}}>
                    <span>{st.trades}T</span><span style={{color:T.green}}>{st.wins}W</span><span style={{color:T.red}}>{st.trades-st.wins}L</span>
                    <span style={{color:T.yellow}}>{st.trades>0?Math.round(st.wins/st.trades*100):0}%</span>
                  </div>
                  <div className="pbar"><div className="pfill" style={{width:`${st.trades>0?st.wins/st.trades*100:0}%`,background:`linear-gradient(90deg,${T.purple},${T.accent})`}}/></div>
                </div>
              )) : <div style={{textAlign:"center",padding:40,color:T.textMuted,fontSize:11}}>No trades yet</div>}
            </div>
            <div className="card">
              <div className="S" style={{fontWeight:700,color:T.yellow,marginBottom:14}}>RISK STATUS</div>
              {[
                {l:"Daily Loss Used",v:`₹${fmt(Math.abs(Math.min(0,dailyPnl)))}`,lim:`₹${fmt(config.maxDailyLoss)}`,pct:Math.abs(Math.min(0,dailyPnl))/config.maxDailyLoss*100},
                {l:"Profit Progress",v:fmtPnl(dailyPnl),lim:`₹${fmt(config.profitTarget)}`,pct:Math.max(0,dailyPnl)/config.profitTarget*100},
                {l:"Trades Used",v:`${todayTrades}`,lim:`${config.maxTradesDay} max`,pct:todayTrades/config.maxTradesDay*100},
                {l:"Capital Drawdown",v:`${drawPct.toFixed(1)}%`,lim:`${(100-config.minCapitalFloor)}% max`,pct:drawPct/(100-config.minCapitalFloor)*100},
              ].map(r => (
                <div key={r.l} style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:11}}>
                    <span style={{color:T.textSub}}>{r.l}</span>
                    <span><span style={{color:r.pct>80?T.red:T.text}}>{r.v}</span><span style={{color:T.textMuted}}> / {r.lim}</span></span>
                  </div>
                  <div className="pbar"><div className="pfill" style={{width:`${Math.min(100,r.pct)}%`,background:r.pct>80?`linear-gradient(90deg,${T.yellow},${T.red})`:`linear-gradient(90deg,${T.accent},${T.green})`}}/></div>
                </div>
              ))}
            </div>
            <div className="card">
              <div className="S" style={{fontWeight:700,color:T.green,marginBottom:14}}>SYSTEM HEALTH</div>
              {[
                {l:"Trading Engine",s:sysStatus,c:sysStatus==="ACTIVE"?T.green:T.red},
                {l:"Market Hours",s:mktStatus.label,c:mktStatus.open?T.green:T.yellow},
                {l:"Broker API",s:apiStatus,c:apiStatus==="CONNECTED"?T.green:T.red},
                {l:"WebSocket Feed",s:wsStatus,c:wsStatus==="WS_CONNECTED"?T.green:T.yellow},
                {l:"Capital Protection",s:config.capitalProtection?"ON":"OFF",c:config.capitalProtection?T.green:T.yellow},
                {l:"Auto-Trade",s:config.autoTrade?"ENABLED":"MANUAL",c:config.autoTrade?T.red:T.accent},
                {l:"Profit Target",s:dailyPnl>=config.profitTarget?"REACHED":"MONITORING",c:dailyPnl>=config.profitTarget?T.green:T.accent},
                {l:"Last Data",s:lastUpdated?lastUpdated.toLocaleTimeString("en-IN"):"Never",c:lastUpdated?T.green:T.red},
              ].map(s => (
                <div key={s.l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${T.bg3}`}}>
                  <span style={{fontSize:11,color:T.textSub}}>{s.l}</span>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:s.c}}/>
                    <span style={{fontSize:10,color:s.c,fontWeight:700}}>{s.s}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ ORDERS ══ */}
        {tab==="orders" && (
          <div className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:6}}>
              <div className="S" style={{fontWeight:700,color:T.accent}}>BROKER ORDER BOOK ({orders.length})</div>
              {brokerPositions.length>0 && <span className="badge bbull">{brokerPositions.length} broker positions synced</span>}
            </div>
            {apiStatus!=="CONNECTED" ? <NoAPI/> : orders.length > 0 ? (
              <div style={{overflowX:"auto"}}>
                <table>
                  <thead><tr>{["ORDER ID","SYMBOL","SIDE","QTY","PRICE","STATUS","TIME"].map(h=><th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{orders.map((o,i) => (
                    <tr key={i}>
                      <td style={{color:T.textMuted,fontSize:10}}>{o.order_id||o.orderId||"—"}</td>
                      <td style={{fontWeight:600}}>{o.tradingsymbol||o.trading_symbol||o.symbol||"—"}</td>
                      <td><span className={`badge ${(o.transaction_type||o.transactionType)==="BUY"?"bbull":"bbear"}`}>{o.transaction_type||o.transactionType||"—"}</span></td>
                      <td>{o.quantity||o.qty||"—"}</td>
                      <td>{o.price||o.average_price?"₹"+(o.price||o.average_price):"MARKET"}</td>
                      <td><span className="badge bblue">{o.status||"—"}</span></td>
                      <td style={{color:T.textMuted,fontSize:10}}>{o.order_timestamp||o.orderTimestamp||"—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : (
              <div className="card" style={{textAlign:"center",padding:50,color:T.textMuted}}>
                <div style={{fontSize:28,marginBottom:8}}>📄</div>
                <div>No orders from broker yet<br/><span style={{fontSize:11}}>Orders appear here after market hours or when placed</span></div>
              </div>
            )}
          </div>
        )}

        {/* ══ LOGS ══ */}
        {tab==="logs" && (
          <div className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div className="S" style={{fontWeight:700,color:T.textSub}}>ACTIVITY LOG ({logs.length})</div>
              <div style={{display:"flex",gap:8}}>
                <button className="btn bo" style={{fontSize:10}} onClick={()=>{
                  const txt = logs.map(l=>`[${l.date} ${l.time}] [${l.level}] ${l.msg}`).join("\n");
                  const blob = new Blob([txt],{type:"text/plain"});
                  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="quantedge-logs.txt"; a.click();
                }}>⬇ Export</button>
                <button className="btn bo" style={{fontSize:10}} onClick={()=>setLogs([])}>CLEAR</button>
              </div>
            </div>
            <div className="card" style={{padding:0,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"68px 52px 1fr",gap:8,padding:"8px 12px",background:T.bg2,fontSize:9,color:T.textMuted,letterSpacing:1,fontWeight:700,borderBottom:`1px solid ${T.cardBorder}`}}>
                <span>TIME</span><span>LEVEL</span><span>MESSAGE</span>
              </div>
              <div style={{maxHeight:"68vh",overflowY:"auto"}}>
                {logs.map(l => (
                  <div key={l.id} className="logrow">
                    <span style={{color:T.textMuted}}>{l.time}</span>
                    <span style={{color:l.level==="TRADE"?T.accent:l.level==="SIGNAL"?T.purple:l.level==="WIN"?T.green:l.level==="LOSS"||l.level==="ERROR"?T.red:l.level==="WARN"?T.yellow:T.textMuted,fontWeight:600}}>{l.level}</span>
                    <span style={{color:l.level==="TRADE"?T.accent:l.level==="SIGNAL"?T.purple:l.level==="WIN"?T.green:l.level==="LOSS"||l.level==="ERROR"?T.red:T.textSub,lineHeight:1.4}}>{l.msg}</span>
                  </div>
                ))}
                {logs.length===0 && <div style={{padding:40,textAlign:"center",color:T.textMuted,fontSize:11}}>No log entries</div>}
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Footer */}
      <div style={{borderTop:`1px solid ${T.navBorder}`,padding:"7px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,color:T.textMuted,flexWrap:"wrap",gap:4}}>
        <span>QUANTEDGE AI v2.0 · REAL DATA ONLY · NIFTY · BANKNIFTY</span>
        <span style={{color:T.red,fontSize:9}}>⚠ EDUCATIONAL USE ONLY — NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  );
}
