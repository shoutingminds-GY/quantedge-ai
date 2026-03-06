import { useState, useEffect, useRef, useCallback } from "react";

const THEMES = {
  dark: {
    bg:"#030d1a",bg2:"#051525",bg3:"#071e35",card:"#071e35",cardBorder:"#0e2d4a",cardHover:"#0a2540",
    text:"#e8f4ff",textSub:"#7aa3c8",textMuted:"#3d6080",
    accent:"#00c8ff",accentGlow:"#00c8ff22",
    green:"#00e676",greenBg:"#00e67611",greenBorder:"#00e67633",
    red:"#ff4569",redBg:"#ff456911",redBorder:"#ff456933",
    yellow:"#ffc107",yellowBg:"#ffc10711",
    purple:"#c084fc",purpleBg:"#c084fc11",
    navBg:"#020c17",navBorder:"#0a2035",
    inputBg:"#040f1e",inputBorder:"#0e2d4a",
    shadow:"0 4px 24px #00000066",shadowLg:"0 8px 48px #00000088",
  },
  light: {
    bg:"#f0f4f8",bg2:"#e8eef4",bg3:"#dde6ee",card:"#ffffff",cardBorder:"#d0dde8",cardHover:"#f5f8fb",
    text:"#0d1f2d",textSub:"#4a6680",textMuted:"#8faab8",
    accent:"#0077cc",accentGlow:"#0077cc22",
    green:"#00875a",greenBg:"#00875a11",greenBorder:"#00875a33",
    red:"#d63650",redBg:"#d6365011",redBorder:"#d6365033",
    yellow:"#d97706",yellowBg:"#d9770611",
    purple:"#7c3aed",purpleBg:"#7c3aed11",
    navBg:"#ffffff",navBorder:"#d0dde8",
    inputBg:"#f8fafc",inputBorder:"#d0dde8",
    shadow:"0 2px 12px #00000018",shadowLg:"0 4px 24px #00000022",
  }
};

const BROKERS = {
  "Upstox":{ fields:["api_key","api_secret","access_token"], color:"#6c63ff", logoChar:"U", docsUrl:"https://upstox.com/developer/api-documentation/" },
  "Zerodha Kite":{ fields:["api_key","api_secret","access_token"], color:"#387ed1", logoChar:"Z", docsUrl:"https://kite.trade/docs/connect/v3/" },
  "Angel One SmartAPI":{ fields:["api_key","client_id","password","totp_secret"], color:"#e94560", logoChar:"A", docsUrl:"https://smartapi.angelbroking.com/docs" },
  "Fyers":{ fields:["client_id","secret_key","access_token"], color:"#00b4d8", logoChar:"F", docsUrl:"https://myapi.fyers.in/docs/" },
  "Dhan":{ fields:["client_id","access_token"], color:"#2ecc71", logoChar:"D", docsUrl:"https://dhanhq.co/docs/latest/" },
};

const STRATEGIES = ["Opening Range Breakout","VWAP Bounce","Momentum Scalp","OI Buildup","Trend Continuation","Mean Reversion","Delta Neutral"];
const INSTRUMENTS = ["NIFTY","BANKNIFTY"];

const fmt = (n,d=2) => Number(n).toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPnl = n => n>=0?`+₹${fmt(Math.abs(n))}`:`-₹${fmt(Math.abs(n))}`;
const rand = (a,b) => Math.random()*(b-a)+a;
const randInt = (a,b) => Math.floor(rand(a,b));
const pick = arr => arr[randInt(0,arr.length)];
const timeStr = () => new Date().toLocaleTimeString("en-IN",{hour12:false});
const isMarketOpen = () => {
  const now=new Date(), day=now.getDay();
  if(day===0||day===6) return false;
  const mins=now.getHours()*60+now.getMinutes();
  return mins>=555&&mins<=930;
};

function createEngine() {
  let nifty=22480+rand(-200,200), bnf=48200+rand(-400,400);
  let vN=nifty-rand(-30,30), vB=bnf-rand(-60,60);
  let trend=pick(["BULLISH","BEARISH","SIDEWAYS"]), vol=rand(0.8,1.8), mom=0;
  return {
    tick(){
      const d=rand(-22,22)*vol, dB=rand(-45,55)*vol;
      nifty=Math.max(19000,nifty+d); bnf=Math.max(40000,bnf+dB);
      vN+=(nifty-vN)*0.04; vB+=(bnf-vB)*0.04;
      vol=Math.max(0.4,Math.min(3.5,vol+rand(-0.04,0.04)));
      mom=mom*0.9+d*0.1;
      if(Math.random()<0.015) trend=pick(["BULLISH","BEARISH","SIDEWAYS"]);
      return this.snap();
    },
    snap(){return{nifty,bnf,vN,vB,trend,vol,mom};}
  };
}

function genChain(spot) {
  const atm=Math.round(spot/100)*100;
  return [-400,-300,-200,-100,0,100,200,300,400].map(d=>{
    const s=atm+d,m=spot-s;
    return{
      strike:s,
      ceOI:randInt(80000,600000),peOI:randInt(80000,600000),
      ceV:randInt(2000,40000),peV:randInt(2000,40000),
      cePrem:Math.round(Math.max(0.5,m>0?m*0.97+rand(3,45):rand(1,25))),
      pePrem:Math.round(Math.max(0.5,m<0?-m*0.97+rand(3,45):rand(1,25))),
    };
  });
}

function aiAnalyze(market, nC, bC, config, dailyPnl) {
  const opps=[];
  const capProtect=(config.capital+dailyPnl)<=config.capital*(config.minCapitalFloor/100);
  INSTRUMENTS.forEach(inst=>{
    const spot=inst==="NIFTY"?market.nifty:market.bnf;
    const vwap=inst==="NIFTY"?market.vN:market.vB;
    const chain=inst==="NIFTY"?nC:bC;
    const atm=chain.find(c=>Math.abs(c.strike-spot)<150);
    if(!atm) return;
    let score=35,reasons=[],direction=null,strategy=null;
    if(capProtect){reasons.push("⚠ Capital protection mode — only high-confidence trades");score-=15;}
    const vwapDiff=spot-vwap,vwapPct=Math.abs(vwapDiff)/spot*100;
    if(vwapPct>0.1){
      if(vwapDiff>0&&market.trend==="BULLISH"){reasons.push(`Price ${vwapPct.toFixed(2)}% above VWAP — bullish momentum`);score+=14;direction="CE";}
      else if(vwapDiff<0&&market.trend==="BEARISH"){reasons.push(`Price ${vwapPct.toFixed(2)}% below VWAP — bearish momentum`);score+=14;direction="PE";}
      else if(Math.abs(vwapDiff)<15){reasons.push("Price near VWAP — bounce setup");score+=6;strategy="VWAP Bounce";}
    }
    const oiRatio=atm.ceOI/atm.peOI;
    if(oiRatio>1.8){reasons.push(`OI ratio ${oiRatio.toFixed(2)} — heavy call writing, bearish`);score+=11;if(!direction)direction="PE";}
    else if(oiRatio<0.55){reasons.push(`OI ratio ${oiRatio.toFixed(2)} — heavy put writing, bullish`);score+=11;if(!direction)direction="CE";}
    if(atm.ceV>25000){reasons.push(`CE volume spike ${fmt(atm.ceV,0)} — institutional buying`);score+=9;if(!direction)direction="CE";}
    if(atm.peV>25000){reasons.push(`PE volume spike ${fmt(atm.peV,0)} — institutional put buying`);score+=9;if(!direction)direction="PE";}
    if(Math.abs(market.mom)>15){
      if(market.mom>0){reasons.push(`Strong upward momentum (${market.mom.toFixed(1)}) — continuation`);score+=10;if(!direction)direction="CE";strategy="Momentum Scalp";}
      else{reasons.push(`Strong downward momentum (${market.mom.toFixed(1)}) — continuation`);score+=10;if(!direction)direction="PE";strategy="Momentum Scalp";}
    }
    if(market.trend==="BULLISH"){reasons.push("Macro trend BULLISH — upside bias");score+=8;if(!direction)direction="CE";if(!strategy)strategy="Trend Continuation";}
    else if(market.trend==="BEARISH"){reasons.push("Macro trend BEARISH — downside bias");score+=8;if(!direction)direction="PE";if(!strategy)strategy="Trend Continuation";}
    else{reasons.push("Sideways — range-bound strategy optimal");score+=3;if(!strategy)strategy="Mean Reversion";}
    if(market.vol>2.2){reasons.push(`⚠ High volatility (${market.vol.toFixed(2)}x) — size reduced 50%`);score-=18;}
    else if(market.vol<1.2){reasons.push(`Low volatility (${market.vol.toFixed(2)}x) — clean conditions`);score+=7;}
    if(score<config.confidenceMin) return;
    if(!direction) direction=Math.random()>0.5?"CE":"PE";
    if(!strategy) strategy=pick(STRATEGIES);
    const strikeOffset=direction==="CE"?100:-100;
    const strike=Math.round(spot/100)*100+strikeOffset;
    const row=chain.find(c=>c.strike===strike)||atm;
    const premium=direction==="CE"?row.cePrem:row.pePrem;
    const lotSize=inst==="NIFTY"?50:15;
    const riskAmt=config.capital*(config.riskPct/100);
    const volMult=market.vol>2.2?0.5:1;
    const maxLots=Math.max(1,Math.floor(riskAmt/(premium*lotSize*0.45)*volMult));
    const qty=Math.min(maxLots,5)*lotSize;
    const sl=Math.round(premium*0.68);
    const target=Math.round(premium*1.52);
    const rr=((target-premium)/(premium-sl)).toFixed(1);
    opps.push({
      id:Date.now()+Math.random(),instrument:inst,strike,direction,
      type:`${inst} ${strike} ${direction}`,premium,sl,target,qty,strategy,
      score:Math.min(96,Math.round(score)),reasons,rr,
      timestamp:new Date(),status:"PENDING",lotSize
    });
  });
  return opps;
}

export default function TradingPlatform() {
  const [themeMode,setThemeMode]=useState("dark");
  const T=THEMES[themeMode];
  const [authed,setAuthed]=useState(false);
  const [loginForm,setLoginForm]=useState({u:"",p:""});
  const [config,setConfig]=useState({
    capital:100000,riskPct:1,maxDailyLoss:3000,profitTarget:5000,
    minTradesDay:1,maxTradesDay:10,stopAtProfitTarget:true,
    capitalProtection:true,minCapitalFloor:97,
    broker:"Upstox",autoTrade:false,trailingStop:true,
    confidenceMin:65,maxOpenPositions:3,
    creds:{api_key:"",api_secret:"",access_token:"",client_id:"",password:"",totp_secret:""}
  });
  const [configTab,setConfigTab]=useState("general");
  const [configOpen,setConfigOpen]=useState(false);
  const engineRef=useRef(createEngine());
  const [market,setMarket]=useState(engineRef.current.snap());
  const [nChain,setNChain]=useState(genChain(22480));
  const [bChain,setBChain]=useState(genChain(48200));
  const [apiStatus,setApiStatus]=useState("DEMO");
  const [opportunities,setOpportunities]=useState([]);
  const [openPositions,setOpenPositions]=useState([]);
  const [trades,setTrades]=useState([]);
  const [dailyPnl,setDailyPnl]=useState(0);
  const [weeklyPnl,setWeeklyPnl]=useState(rand(-3000,12000));
  const [todayTrades,setTodayTrades]=useState(0);
  const [systemStatus,setSystemStatus]=useState("ACTIVE");
  const [selectedOpp,setSelectedOpp]=useState(null);
  const [activeTab,setActiveTab]=useState("dashboard");
  const [logs,setLogs]=useState([]);
  const [alerts,setAlerts]=useState([]);
  const [analytics,setAnalytics]=useState({wins:0,losses:0,totalPnl:0,avgWin:0,avgLoss:0,stratStats:{}});
  const startCapRef=useRef(100000);

  const addLog=useCallback((msg,level="INFO")=>{
    setLogs(p=>[{id:Date.now()+Math.random(),time:timeStr(),msg,level},...p].slice(0,200));
  },[]);
  const addAlert=useCallback((msg,type="info")=>{
    const id=Date.now();
    setAlerts(p=>[{id,msg,type},...p].slice(0,5));
    setTimeout(()=>setAlerts(p=>p.filter(a=>a.id!==id)),5000);
  },[]);

  useEffect(()=>{startCapRef.current=config.capital;},[config.capital]);

  const closeTrade=useCallback((pos,exitPrice,reason)=>{
    const pnl=Math.round((exitPrice-pos.entryPrice)*pos.qty);
    setTrades(p=>[{...pos,exitPrice,exitTime:new Date(),pnl,closeReason:reason,status:pnl>=0?"WIN":"LOSS"},...p]);
    setDailyPnl(d=>d+pnl);
    setWeeklyPnl(w=>w+pnl);
    setOpenPositions(p=>p.filter(x=>x.id!==pos.id));
    setAnalytics(prev=>{
      const wins=prev.wins+(pnl>0?1:0),losses=prev.losses+(pnl<=0?1:0);
      const ss={...prev.stratStats};
      if(!ss[pos.strategy])ss[pos.strategy]={trades:0,pnl:0,wins:0};
      ss[pos.strategy].trades++;ss[pos.strategy].pnl+=pnl;if(pnl>0)ss[pos.strategy].wins++;
      return{...prev,wins,losses,totalPnl:prev.totalPnl+pnl,
        avgWin:wins>0?(prev.avgWin*(wins-1)+(pnl>0?pnl:0))/wins:prev.avgWin,
        avgLoss:losses>0?(prev.avgLoss*(losses-1)+(pnl<=0?Math.abs(pnl):0))/losses:prev.avgLoss,
        stratStats:ss};
    });
    addLog(`${reason}: ${pos.type} ₹${pos.entryPrice}→₹${exitPrice} | ${fmtPnl(pnl)}`,pnl>0?"WIN":"LOSS");
    if(pnl>0)addAlert(`🎯 ${reason}: ${pos.type} ${fmtPnl(pnl)}`,"success");
    else addAlert(`❌ ${reason}: ${pos.type} ${fmtPnl(pnl)}`,"danger");
  },[addLog,addAlert]);

  // Market tick
  useEffect(()=>{
    if(!authed) return;
    const iv=setInterval(()=>{
      const snap=engineRef.current.tick();
      setMarket(snap);
      setNChain(genChain(snap.nifty));
      setBChain(genChain(snap.bnf));
      setOpenPositions(prev=>prev.map(p=>{
        const cur=Math.max(0.5,p.currentPrem+rand(-6,7));
        const upnl=Math.round((cur-p.entryPrice)*p.qty);
        if(cur<=p.sl){setTimeout(()=>closeTrade(p,p.sl,"SL HIT"),50);}
        if(cur>=p.target){setTimeout(()=>closeTrade(p,p.target,"TARGET HIT"),50);}
        return{...p,currentPrem:Math.round(cur*10)/10,unrealizedPnl:upnl};
      }));
      if(snap.vol>2.8){setSystemStatus("PAUSED");addAlert("⚡ Extreme volatility — trading paused","danger");}
      else if(snap.vol<2.2){setSystemStatus(s=>s==="PAUSED"?"ACTIVE":s);}
    },1600);
    return()=>clearInterval(iv);
  },[authed,closeTrade]);

  // AI loop
  useEffect(()=>{
    if(!authed) return;
    const iv=setInterval(()=>{
      if(systemStatus!=="ACTIVE") return;
      const curCap=config.capital+dailyPnl;
      const floor=startCapRef.current*(config.minCapitalFloor/100);
      if(curCap<=floor&&config.capitalProtection){
        setSystemStatus("HALTED");
        addAlert(`🛡 Capital floor ₹${fmt(floor)} reached — halted`,"danger");
        return;
      }
      if(dailyPnl<=-config.maxDailyLoss){setSystemStatus("HALTED");addAlert(`🚫 Daily loss limit hit — halted`,"danger");return;}
      if(config.stopAtProfitTarget&&dailyPnl>=config.profitTarget){
        setSystemStatus("TARGET_REACHED");
        addAlert(`🏆 Profit target ₹${fmt(config.profitTarget)} reached!`,"success");
        addLog(`PROFIT TARGET REACHED ₹${fmt(dailyPnl)} — stopping for day`,"WIN");
        return;
      }
      if(todayTrades>=config.maxTradesDay) return;
      const opps=aiAnalyze(market,nChain,bChain,config,dailyPnl);
      if(opps.length>0){
        setOpportunities(p=>[...opps,...p].slice(0,15));
        opps.forEach(o=>addLog(`AI SIGNAL: ${o.type} | ${o.score}% | ${o.strategy}`,"SIGNAL"));
      }
    },4500);
    return()=>clearInterval(iv);
  },[authed,market,systemStatus,dailyPnl,config,todayTrades,nChain,bChain,addLog,addAlert]);

  const executeTrade=useCallback((opp)=>{
    if(openPositions.length>=config.maxOpenPositions){addAlert("Max positions reached","warning");return;}
    const trade={...opp,id:`TRD-${Date.now()}`,entryTime:new Date(),entryPrice:opp.premium,currentPrem:opp.premium,unrealizedPnl:0,status:"OPEN"};
    setOpenPositions(p=>[...p,trade]);
    setTodayTrades(c=>c+1);
    addLog(`EXECUTED: ${opp.type} @ ₹${opp.premium} SL:₹${opp.sl} T:₹${opp.target} Qty:${opp.qty}`,"TRADE");
    addAlert(`✅ ${opp.type} @ ₹${opp.premium}`,"success");
  },[openPositions.length,config.maxOpenPositions,addLog,addAlert]);

  // Auto-trade
  useEffect(()=>{
    if(!authed||!config.autoTrade||systemStatus!=="ACTIVE") return;
    const iv=setInterval(()=>{
      if(openPositions.length>=config.maxOpenPositions) return;
      setOpportunities(prev=>{
        const p=prev.filter(o=>o.status==="PENDING"&&o.score>=config.confidenceMin);
        if(!p.length) return prev;
        executeTrade(p[0]);
        return prev.map(x=>x.id===p[0].id?{...x,status:"EXECUTED"}:x);
      });
    },7000);
    return()=>clearInterval(iv);
  },[authed,config.autoTrade,systemStatus,openPositions.length,config.maxOpenPositions,config.confidenceMin,executeTrade]);

  const capital=config.capital+dailyPnl;
  const drawdownPct=Math.abs(Math.min(0,dailyPnl))/config.capital*100;
  const profitPct=Math.max(0,dailyPnl)/config.profitTarget*100;
  const winRate=(analytics.wins+analytics.losses)>0?Math.round(analytics.wins/(analytics.wins+analytics.losses)*100):0;
  const statusColor=systemStatus==="ACTIVE"?T.green:systemStatus==="TARGET_REACHED"?T.yellow:T.red;
  const isDark=themeMode==="dark";

  const CSS=`
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500;600&display=swap');
    *{box-sizing:border-box;margin:0;padding:0;scrollbar-width:thin;scrollbar-color:${T.cardBorder} transparent;}
    html,body,#root{height:100%;background:${T.bg};}
    .syne{font-family:'Syne',sans-serif;}
    .card{background:${T.card};border:1px solid ${T.cardBorder};border-radius:12px;padding:18px;transition:border-color 0.2s;}
    .card:hover{border-color:${T.accent}44;}
    .csm{background:${T.card};border:1px solid ${T.cardBorder};border-radius:10px;padding:14px;}
    .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600;letter-spacing:0.5px;white-space:nowrap;}
    .b-bull{background:${T.greenBg};color:${T.green};border:1px solid ${T.greenBorder};}
    .b-bear{background:${T.redBg};color:${T.red};border:1px solid ${T.redBorder};}
    .b-side{background:${T.yellowBg};color:${T.yellow};}
    .b-blue{background:${T.accentGlow};color:${T.accent};}
    .b-pur{background:${T.purpleBg};color:${T.purple};border:1px solid ${T.purple}22;}
    .b-win{background:${T.greenBg};color:${T.green};}
    .b-loss{background:${T.redBg};color:${T.red};}
    .btn{padding:8px 14px;border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;cursor:pointer;border:none;transition:all 0.15s;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}
    .btn:hover{transform:translateY(-1px);filter:brightness(1.1);}
    .btn:active{transform:none;}
    .bp{background:${T.accent};color:${isDark?"#000":"#fff"};}
    .bs{background:${T.greenBg};color:${T.green};border:1px solid ${T.greenBorder};}
    .bd{background:${T.redBg};color:${T.red};border:1px solid ${T.redBorder};}
    .bo{background:transparent;color:${T.textSub};border:1px solid ${T.cardBorder};}
    .bo:hover{border-color:${T.accent};color:${T.accent};}
    .bg{background:transparent;color:${T.textMuted};border:none;}
    .inp{background:${T.inputBg};border:1px solid ${T.inputBorder};color:${T.text};padding:9px 12px;border-radius:8px;outline:none;font-family:'JetBrains Mono',monospace;font-size:12px;width:100%;transition:border 0.15s;}
    .inp:focus{border-color:${T.accent};box-shadow:0 0 0 3px ${T.accentGlow};}
    .inp::placeholder{color:${T.textMuted};}
    .tb{padding:6px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;border:none;transition:all 0.15s;white-space:nowrap;font-family:'JetBrains Mono',monospace;}
    .ta{background:${T.accent};color:${isDark?"#000":"#fff"};}
    .ti{background:transparent;color:${T.textMuted};}
    .ti:hover{color:${T.accent};background:${T.accentGlow};}
    .ocard{background:${T.card};border:1px solid ${T.cardBorder};border-radius:10px;padding:14px;margin-bottom:9px;cursor:pointer;transition:all 0.15s;}
    .ocard:hover,.ocard.sel{border-color:${T.accent};background:${T.cardHover};}
    .pbar{height:5px;background:${T.bg3};border-radius:3px;overflow:hidden;}
    .pfill{height:100%;border-radius:3px;transition:width 0.4s;}
    .pulse{animation:pulse 2s infinite;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
    .fade{animation:fadeIn 0.25s ease;}
    @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
    .metric{background:${T.card};border:1px solid ${T.cardBorder};border-radius:12px;padding:16px;position:relative;overflow:hidden;}
    .metric::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .mg::before{background:${T.green};}
    .mr::before{background:${T.red};}
    .mb::before{background:${T.accent};}
    .my::before{background:${T.yellow};}
    .mp::before{background:${T.purple};}
    .chain-row{display:grid;grid-template-columns:65px 80px 65px 80px 65px 80px 65px;gap:2px;padding:5px 8px;font-size:11px;border-bottom:1px solid ${T.bg3};align-items:center;}
    .chain-row:hover{background:${T.cardHover};}
    .catm{background:${T.accentGlow}!important;border-left:3px solid ${T.accent};}
    .logrow{padding:6px 12px;border-bottom:1px solid ${T.bg3};font-size:11px;display:grid;grid-template-columns:68px 52px 1fr;gap:8px;align-items:start;}
    .tog{width:42px;height:22px;border-radius:11px;cursor:pointer;position:relative;transition:background 0.2s;flex-shrink:0;}
    .togk{position:absolute;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 4px #0004;}
    select.inp option{background:${T.card};color:${T.text};}
    table{width:100%;border-collapse:collapse;}
    th{padding:10px 12px;text-align:left;font-size:10px;color:${T.textMuted};letter-spacing:1px;font-weight:600;white-space:nowrap;background:${T.card};position:sticky;top:0;}
    td{padding:9px 12px;border-bottom:1px solid ${T.bg3};font-size:12px;white-space:nowrap;}
    @media(max-width:900px){
      .hm{display:none!important;}
      .g2{grid-template-columns:1fr!important;}
      .g3{grid-template-columns:1fr 1fr!important;}
      .g5{grid-template-columns:1fr 1fr!important;}
      .cpanel{width:100%!important;}
      .chain-row{grid-template-columns:50px 60px 55px 70px 55px 60px 50px;font-size:10px;}
    }
    @media(max-width:600px){
      .g3{grid-template-columns:1fr!important;}
      .g5{grid-template-columns:1fr 1fr!important;}
    }
  `;

  // LOGIN
  if(!authed) return (
    <div style={{fontFamily:"'JetBrains Mono',monospace",background:T.bg,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <style>{CSS}</style>
      <div style={{width:"100%",maxWidth:380,background:T.card,border:`1px solid ${T.cardBorder}`,borderRadius:16,padding:32,boxShadow:T.shadowLg}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:10,letterSpacing:4,color:T.accent,marginBottom:8}}>QUANTEDGE AI v2.0</div>
          <div className="syne" style={{fontSize:26,fontWeight:800,color:T.text,marginBottom:4}}>Options Trading</div>
          <div style={{fontSize:10,color:T.textMuted,letterSpacing:2,marginBottom:12}}>NIFTY · BANKNIFTY · AI-POWERED</div>
          <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
            <span className="badge b-bull">LIVE SIGNALS</span>
            <span className="badge b-blue">REAL API</span>
            <span className="badge b-pur">AI ENGINE</span>
          </div>
        </div>
        {[{l:"USERNAME",k:"u",t:"text"},{l:"PASSWORD",k:"p",t:"password"}].map(f=>(
          <div key={f.k} style={{marginBottom:14}}>
            <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.l}</div>
            <input className="inp" type={f.t} placeholder={`Enter ${f.l.toLowerCase()}`} value={loginForm[f.k]}
              onChange={e=>setLoginForm(p=>({...p,[f.k]:e.target.value}))}
              onKeyDown={e=>e.key==="Enter"&&loginForm.u&&loginForm.p&&(setAuthed(true),addLog("User authenticated","INFO"))} />
          </div>
        ))}
        <button className="btn bp" style={{width:"100%",justifyContent:"center",padding:"12px",fontSize:13,marginBottom:12}}
          onClick={()=>{if(loginForm.u&&loginForm.p){setAuthed(true);addLog("Authenticated","INFO");}else addAlert("Enter credentials","danger");}}>
          ENTER PLATFORM →
        </button>
        <div style={{textAlign:"center",fontSize:10,color:T.textMuted,marginBottom:12}}>Demo: any username + password</div>
        <button className="btn bg" style={{width:"100%",justifyContent:"center",fontSize:11}} onClick={()=>setThemeMode(m=>m==="dark"?"light":"dark")}>
          {themeMode==="dark"?"☀ Light Mode":"🌙 Dark Mode"}
        </button>
      </div>
    </div>
  );

  // MAIN APP
  return (
    <div style={{fontFamily:"'JetBrains Mono',monospace",background:T.bg,minHeight:"100vh",color:T.text,fontSize:12}}>
      <style>{CSS}</style>

      {/* Alerts */}
      <div style={{position:"fixed",top:12,right:12,zIndex:9999,display:"flex",flexDirection:"column",gap:7,maxWidth:300,width:"calc(100% - 24px)"}}>
        {alerts.map(a=>(
          <div key={a.id} className="fade" style={{padding:"9px 13px",borderRadius:9,fontSize:12,
            background:a.type==="success"?T.greenBg:a.type==="danger"?T.redBg:a.type==="warning"?T.yellowBg:T.card,
            border:`1px solid ${a.type==="success"?T.greenBorder:a.type==="danger"?T.redBorder:T.cardBorder}`,
            color:a.type==="success"?T.green:a.type==="danger"?T.red:a.type==="warning"?T.yellow:T.text,
            boxShadow:T.shadow}}>{a.msg}</div>
        ))}
      </div>

      {/* Config Panel */}
      {configOpen&&(
        <div className="cpanel" style={{position:"fixed",top:0,right:0,width:330,height:"100vh",background:T.card,borderLeft:`1px solid ${T.cardBorder}`,zIndex:500,overflowY:"auto",boxShadow:T.shadowLg}}>
          <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.cardBorder}`,display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,background:T.card,zIndex:1}}>
            <div className="syne" style={{fontWeight:700,color:T.accent,fontSize:14}}>⚙ Configuration</div>
            <button className="btn bg" onClick={()=>setConfigOpen(false)} style={{fontSize:18,padding:"2px 6px"}}>✕</button>
          </div>
          <div style={{padding:"10px 18px 0",display:"flex",gap:5,borderBottom:`1px solid ${T.cardBorder}`,overflowX:"auto",paddingBottom:0}}>
            {["general","risk","broker","advanced"].map(t=>(
              <button key={t} className={`tb ${configTab===t?"ta":"ti"}`} style={{fontSize:10,padding:"5px 10px",marginBottom:10}} onClick={()=>setConfigTab(t)}>
                {t.toUpperCase()}
              </button>
            ))}
          </div>
          <div style={{padding:18}}>
            {configTab==="general"&&(
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                <div style={{background:T.accentGlow,border:`1px solid ${T.accent}33`,borderRadius:8,padding:10,fontSize:11,color:T.accent,lineHeight:1.5}}>
                  💡 Capital never drops below {config.minCapitalFloor}% floor = ₹{fmt(config.capital*config.minCapitalFloor/100)}
                </div>
                {[{l:"Starting Capital (₹)",k:"capital"},{l:"Daily Profit Target (₹)",k:"profitTarget"},{l:"Min Trades / Day",k:"minTradesDay"},{l:"Max Trades / Day",k:"maxTradesDay"}].map(f=>(
                  <div key={f.k}>
                    <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.l}</div>
                    <input className="inp" type="number" value={config[f.k]} onChange={e=>setConfig(p=>({...p,[f.k]:Number(e.target.value)}))} />
                  </div>
                ))}
                {[{l:"Stop at Profit Target",k:"stopAtProfitTarget",sub:"Halt when daily target reached"},{l:"🛡 Capital Protection",k:"capitalProtection",sub:"Never breach floor amount"}].map(f=>(
                  <div key={f.k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0"}}>
                    <div><div style={{fontSize:11,color:T.text,marginBottom:1}}>{f.l}</div><div style={{fontSize:10,color:T.textMuted}}>{f.sub}</div></div>
                    <div className="tog" style={{background:config[f.k]?T.accent:T.bg3}} onClick={()=>setConfig(p=>({...p,[f.k]:!p[f.k]}))}>
                      <div className="togk" style={{left:config[f.k]?22:2}}/>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {configTab==="risk"&&(
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                {[{l:"Risk Per Trade (%)",k:"riskPct",step:"0.1"},{l:"Max Daily Loss (₹)",k:"maxDailyLoss"},{l:"Capital Floor (%)",k:"minCapitalFloor"},{l:"Min AI Confidence (%)",k:"confidenceMin"},{l:"Max Open Positions",k:"maxOpenPositions"}].map(f=>(
                  <div key={f.k}>
                    <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.l}</div>
                    <input className="inp" type="number" step={f.step||1} value={config[f.k]} onChange={e=>setConfig(p=>({...p,[f.k]:Number(e.target.value)}))} />
                  </div>
                ))}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0"}}>
                  <div><div style={{fontSize:11,color:T.text,marginBottom:1}}>Trailing Stop Loss</div><div style={{fontSize:10,color:T.textMuted}}>Auto-adjusts SL with price</div></div>
                  <div className="tog" style={{background:config.trailingStop?T.accent:T.bg3}} onClick={()=>setConfig(p=>({...p,trailingStop:!p.trailingStop}))}>
                    <div className="togk" style={{left:config.trailingStop?22:2}}/>
                  </div>
                </div>
              </div>
            )}
            {configTab==="broker"&&(
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                <div>
                  <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>SELECT BROKER</div>
                  <select className="inp" value={config.broker} onChange={e=>setConfig(p=>({...p,broker:e.target.value}))}>
                    {Object.keys(BROKERS).map(b=><option key={b}>{b}</option>)}
                  </select>
                </div>
                <div style={{background:T.bg2,borderRadius:8,padding:11,fontSize:11,lineHeight:1.8}}>
                  <div style={{color:T.textSub,marginBottom:4,fontWeight:600}}>Required fields:</div>
                  {BROKERS[config.broker].fields.map(f=><div key={f} style={{color:T.accent}}>• {f.replace(/_/g," ").toUpperCase()}</div>)}
                  <a href={BROKERS[config.broker].docsUrl} target="_blank" rel="noreferrer" style={{color:T.accent,fontSize:10,display:"block",marginTop:8,textDecoration:"none"}}>📖 API Docs →</a>
                </div>
                {BROKERS[config.broker].fields.map(f=>(
                  <div key={f}>
                    <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:5}}>{f.replace(/_/g," ").toUpperCase()}</div>
                    <input className="inp" type="password" placeholder={`Enter ${f}`} value={config.creds[f]||""} onChange={e=>setConfig(p=>({...p,creds:{...p.creds,[f]:e.target.value}}))} />
                  </div>
                ))}
                <button className="btn bp" style={{width:"100%",justifyContent:"center"}} onClick={()=>{
                  addAlert(`Connecting to ${config.broker}...`,"info");
                  setApiStatus("CONNECTING");
                  setTimeout(()=>setApiStatus(config.creds.access_token||config.creds.api_key?"CONNECTED":"DEMO"),1500);
                  addLog(`${config.broker} connection initiated`,"INFO");
                }}>🔌 CONNECT {config.broker}</button>
                <div style={{textAlign:"center",fontSize:11,color:apiStatus==="CONNECTED"?T.green:apiStatus==="CONNECTING"?T.yellow:T.textMuted}}>
                  Status: <b>{apiStatus}</b>
                </div>
                <div style={{background:T.yellowBg,border:`1px solid ${T.yellow}33`,borderRadius:8,padding:10,fontSize:10,color:T.yellow,lineHeight:1.5}}>
                  ⚠ Credentials stored in memory only. Never saved to disk.
                </div>
              </div>
            )}
            {configTab==="advanced"&&(
              <div style={{display:"flex",flexDirection:"column",gap:13}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0"}}>
                  <div><div style={{fontSize:11,color:T.text,marginBottom:1}}>Auto-Trade Mode</div><div style={{fontSize:10,color:T.textMuted}}>Execute signals automatically</div></div>
                  <div className="tog" style={{background:config.autoTrade?T.red:T.bg3}} onClick={()=>setConfig(p=>({...p,autoTrade:!p.autoTrade}))}>
                    <div className="togk" style={{left:config.autoTrade?22:2}}/>
                  </div>
                </div>
                {config.autoTrade&&<div style={{background:T.redBg,border:`1px solid ${T.redBorder}`,borderRadius:8,padding:10,fontSize:10,color:T.red,lineHeight:1.5}}>⚠ Auto-trade places real orders when API is connected. Test in simulation first.</div>}
                <div>
                  <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:8}}>THEME</div>
                  <div style={{display:"flex",gap:8}}>
                    {["dark","light"].map(m=><button key={m} className={`btn ${themeMode===m?"bp":"bo"}`} style={{flex:1,justifyContent:"center"}} onClick={()=>setThemeMode(m)}>{m==="dark"?"🌙 Dark":"☀ Light"}</button>)}
                  </div>
                </div>
                <div style={{marginTop:4}}>
                  {systemStatus!=="ACTIVE"
                    ?<button className="btn bs" style={{width:"100%",justifyContent:"center"}} onClick={()=>{setSystemStatus("ACTIVE");addLog("System resumed","INFO");addAlert("Trading resumed","success");}}>▶ RESUME TRADING</button>
                    :<button className="btn bd" style={{width:"100%",justifyContent:"center"}} onClick={()=>{setSystemStatus("HALTED");addLog("System halted manually","WARN");}}>⏹ HALT TRADING</button>
                  }
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* NAV */}
      <div style={{background:T.navBg,borderBottom:`1px solid ${T.navBorder}`,padding:"0 14px",display:"flex",alignItems:"center",gap:10,height:50,position:"sticky",top:0,zIndex:200,boxShadow:T.shadow}}>
        <div style={{display:"flex",alignItems:"baseline",gap:5,minWidth:"fit-content"}}>
          <span className="syne" style={{fontWeight:800,fontSize:15,color:T.accent}}>QUANTEDGE</span>
          <span style={{fontSize:8,color:T.textMuted,letterSpacing:3}}>AI</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",borderRadius:20,minWidth:"fit-content",
          background:systemStatus==="ACTIVE"?T.greenBg:systemStatus==="TARGET_REACHED"?T.yellowBg:T.redBg,
          border:`1px solid ${systemStatus==="ACTIVE"?T.greenBorder:systemStatus==="TARGET_REACHED"?T.yellow+"33":T.redBorder}`}}>
          <div className={systemStatus==="ACTIVE"?"pulse":""} style={{width:5,height:5,borderRadius:"50%",background:statusColor}}/>
          <span style={{fontSize:9,fontWeight:700,letterSpacing:1,color:statusColor,whiteSpace:"nowrap"}}>
            {systemStatus==="TARGET_REACHED"?"TARGET✓":systemStatus}
          </span>
        </div>
        <div className="hm" style={{fontSize:10,color:isMarketOpen()?T.green:T.textMuted,display:"flex",alignItems:"center",gap:3}}>
          <div style={{width:4,height:4,borderRadius:"50%",background:isMarketOpen()?T.green:T.textMuted}}/>
          {isMarketOpen()?"OPEN":"CLOSED"}
        </div>
        <div style={{display:"flex",gap:2,flex:1,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
          {[["dashboard","📊 DASH"],["signals","🎯 SIGNALS"],["positions","📂 POS"],["history","📋 HIST"],["analytics","📈 STATS"],["chain","⛓ CHAIN"],["logs","📝 LOG"]].map(([k,l])=>(
            <button key={k} className={`tb ${activeTab===k?"ta":"ti"}`} style={{fontSize:10,padding:"5px 9px"}} onClick={()=>setActiveTab(k)}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:5,minWidth:"fit-content"}}>
          <button className="btn bg" style={{fontSize:15,padding:"3px 6px"}} onClick={()=>setThemeMode(m=>m==="dark"?"light":"dark")}>{themeMode==="dark"?"☀":"🌙"}</button>
          <button className="btn bo" style={{fontSize:10,padding:"5px 9px"}} onClick={()=>setConfigOpen(p=>!p)}>⚙</button>
          <button className="btn bo" style={{fontSize:10,padding:"5px 9px"}} onClick={()=>setAuthed(false)}>EXIT</button>
        </div>
      </div>

      {/* CONTENT */}
      <div style={{padding:14,paddingRight:configOpen?344:14,transition:"padding-right 0.3s"}}>

        {/* ═══ DASHBOARD ═══ */}
        {activeTab==="dashboard"&&(
          <div className="fade">
            {/* Market tickers */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}} className="g3">
              {[{l:"NIFTY 50",v:market.nifty,vwap:market.vN,chg:market.mom},{l:"BANKNIFTY",v:market.bnf,vwap:market.vB,chg:market.mom*2.1}].map(m=>(
                <div key={m.l} className="csm" style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                  <div style={{flex:1,minWidth:70}}>
                    <div style={{fontSize:9,color:T.textMuted,letterSpacing:2,marginBottom:2}}>{m.l}</div>
                    <div className="syne" style={{fontSize:20,fontWeight:700}}>{fmt(m.v)}</div>
                    <div style={{fontSize:10,color:m.chg>=0?T.green:T.red}}>{m.chg>=0?"▲":"▼"} {Math.abs(m.chg).toFixed(1)}</div>
                  </div>
                  <div style={{borderLeft:`1px solid ${T.cardBorder}`,paddingLeft:10}}>
                    <div style={{fontSize:9,color:T.textMuted,marginBottom:2}}>VWAP</div>
                    <div style={{fontWeight:600,color:m.v>m.vwap?T.green:T.red,fontSize:13}}>{fmt(m.vwap)}</div>
                    <span className={`badge ${market.trend==="BULLISH"?"b-bull":market.trend==="BEARISH"?"b-bear":"b-side"}`} style={{marginTop:3}}>{market.trend}</span>
                  </div>
                </div>
              ))}
              <div className="csm" style={{display:"flex",gap:10,alignItems:"center"}}>
                <div>
                  <div style={{fontSize:9,color:T.textMuted,letterSpacing:2,marginBottom:2}}>VOLATILITY</div>
                  <div className="syne" style={{fontSize:20,fontWeight:700,color:market.vol>2?T.red:market.vol>1.5?T.yellow:T.green}}>{market.vol.toFixed(2)}x</div>
                </div>
                <div style={{borderLeft:`1px solid ${T.cardBorder}`,paddingLeft:10}}>
                  <div style={{fontSize:9,color:T.textMuted,marginBottom:2}}>BROKER API</div>
                  <div style={{fontWeight:600,fontSize:11,color:apiStatus==="CONNECTED"?T.green:T.yellow}}>{apiStatus}</div>
                  <div style={{fontSize:9,color:T.textMuted,marginTop:1}}>{config.broker.split(" ")[0]}</div>
                </div>
              </div>
            </div>

            {/* Profit target bar */}
            {config.stopAtProfitTarget&&(
              <div style={{marginBottom:10,background:dailyPnl>=config.profitTarget?T.greenBg:T.card,border:`1px solid ${dailyPnl>=config.profitTarget?T.greenBorder:T.cardBorder}`,borderRadius:9,padding:"9px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",gap:8}}>
                <span style={{fontSize:11,color:T.textSub,whiteSpace:"nowrap"}}>🎯 Profit Target:</span>
                <div style={{flex:1,minWidth:80}} className="pbar"><div className="pfill" style={{width:`${Math.min(100,profitPct)}%`,background:`linear-gradient(90deg,${T.accent},${T.green})`}}/></div>
                <span style={{fontWeight:700,color:dailyPnl>=config.profitTarget?T.green:T.text,whiteSpace:"nowrap"}}>{fmtPnl(dailyPnl)} / ₹{fmt(config.profitTarget)}</span>
                {dailyPnl>=config.profitTarget&&<span className="badge b-win">REACHED ✓</span>}
              </div>
            )}

            {/* Capital floor bar */}
            {config.capitalProtection&&(
              <div style={{marginBottom:10,background:T.card,border:`1px solid ${T.cardBorder}`,borderRadius:9,padding:"9px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:T.textSub,whiteSpace:"nowrap"}}>🛡 Capital:</span>
                <div style={{flex:1,minWidth:80}} className="pbar"><div className="pfill" style={{width:`${Math.min(100,drawdownPct/(100-config.minCapitalFloor)*100)}%`,background:drawdownPct>2?`linear-gradient(90deg,${T.yellow},${T.red})`:T.green}}/></div>
                <span style={{fontWeight:700,fontSize:11,color:drawdownPct>2?T.red:T.green,whiteSpace:"nowrap"}}>₹{fmt(capital)} / Floor ₹{fmt(config.capital*config.minCapitalFloor/100)}</span>
              </div>
            )}

            {/* Metrics */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:12}} className="g5">
              {[
                {l:"CAPITAL",v:`₹${fmt(capital)}`,sub:`Base ₹${fmt(config.capital)}`,cls:"mb",col:T.accent},
                {l:"TODAY P&L",v:fmtPnl(dailyPnl),sub:`Limit ₹${fmt(config.maxDailyLoss)}`,cls:dailyPnl>=0?"mg":"mr",col:dailyPnl>=0?T.green:T.red},
                {l:"WEEKLY P&L",v:fmtPnl(weeklyPnl),sub:"5 days",cls:weeklyPnl>=0?"mg":"mr",col:weeklyPnl>=0?T.green:T.red},
                {l:"TRADES TODAY",v:`${todayTrades}/${config.maxTradesDay}`,sub:`Min: ${config.minTradesDay}`,cls:todayTrades>=config.maxTradesDay?"mr":todayTrades>=config.minTradesDay?"mg":"my",col:todayTrades>=config.maxTradesDay?T.red:todayTrades>=config.minTradesDay?T.green:T.yellow},
                {l:"WIN RATE",v:`${winRate}%`,sub:`${analytics.wins}W ${analytics.losses}L`,cls:winRate>=55?"mg":winRate>=45?"my":"mr",col:winRate>=55?T.green:winRate>=45?T.yellow:T.red},
              ].map(m=>(
                <div key={m.l} className={`metric ${m.cls}`}>
                  <div style={{fontSize:9,color:T.textMuted,letterSpacing:1.5,marginBottom:5}}>{m.l}</div>
                  <div className="syne" style={{fontSize:18,fontWeight:700,color:m.col,marginBottom:2}}>{m.v}</div>
                  <div style={{fontSize:10,color:T.textMuted}}>{m.sub}</div>
                </div>
              ))}
            </div>

            {/* Signals + Positions */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}} className="g2">
              <div className="card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div className="syne" style={{fontWeight:700,color:T.purple,fontSize:12}}><span className={systemStatus==="ACTIVE"?"pulse":""}>●</span> LIVE SIGNALS</div>
                  <button className="btn bo" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>setActiveTab("signals")}>ALL</button>
                </div>
                {opportunities.filter(o=>o.status==="PENDING").slice(0,4).map(o=>(
                  <div key={o.id} className="ocard" onClick={()=>{setSelectedOpp(o);setActiveTab("signals");}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                      <div style={{fontWeight:600,fontSize:12}}>{o.type}</div>
                      <div className="syne" style={{fontSize:16,fontWeight:800,color:o.score>=75?T.green:o.score>=65?T.yellow:T.red}}>{o.score}%</div>
                    </div>
                    <div style={{display:"flex",gap:8,fontSize:10,color:T.textMuted,marginBottom:5,flexWrap:"wrap"}}>
                      <span>₹{o.premium}</span><span style={{color:T.red}}>SL ₹{o.sl}</span><span style={{color:T.green}}>T ₹{o.target}</span>
                      <span style={{marginLeft:"auto",color:T.purple}}>{o.strategy.split(" ").slice(0,2).join(" ")}</span>
                    </div>
                    <div className="pbar"><div className="pfill" style={{width:`${o.score}%`,background:`linear-gradient(90deg,${o.score>=75?T.green:T.yellow},${T.accent})`}}/></div>
                  </div>
                ))}
                {opportunities.filter(o=>o.status==="PENDING").length===0&&(
                  <div style={{textAlign:"center",padding:"20px 0",color:T.textMuted,fontSize:11}}>
                    {systemStatus==="TARGET_REACHED"?"🏆 Daily target reached!":"◎ Scanning market..."}
                  </div>
                )}
              </div>
              <div className="card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div className="syne" style={{fontWeight:700,color:T.accent,fontSize:12}}>● OPEN POSITIONS ({openPositions.length})</div>
                  <button className="btn bo" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>setActiveTab("positions")}>ALL</button>
                </div>
                {openPositions.slice(0,5).map(p=>(
                  <div key={p.id} style={{padding:"9px 0",borderBottom:`1px solid ${T.bg3}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontWeight:600,fontSize:12,marginBottom:2}}>{p.type}</div>
                      <div style={{fontSize:10,color:T.textMuted}}>₹{p.entryPrice} · {p.qty} · {p.strategy.split(" ")[0]}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontWeight:700,color:p.unrealizedPnl>=0?T.green:T.red}}>{fmtPnl(p.unrealizedPnl)}</div>
                      <div style={{fontSize:10,color:T.textMuted}}>₹{p.currentPrem}</div>
                    </div>
                  </div>
                ))}
                {openPositions.length===0&&<div style={{textAlign:"center",padding:"20px 0",color:T.textMuted,fontSize:11}}>No open positions</div>}
              </div>
            </div>
          </div>
        )}

        {/* ═══ SIGNALS ═══ */}
        {activeTab==="signals"&&(
          <div className="fade" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}} >
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div className="syne" style={{fontWeight:700,color:T.purple}}>AI SIGNALS</div>
                <span className="badge b-blue">{opportunities.filter(o=>o.status==="PENDING").length} PENDING</span>
              </div>
              <div style={{maxHeight:"75vh",overflowY:"auto"}}>
                {opportunities.map(o=>(
                  <div key={o.id} className={`ocard ${selectedOpp?.id===o.id?"sel":""}`} style={{opacity:o.status==="EXECUTED"?0.5:1}} onClick={()=>setSelectedOpp(o)}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                      <div>
                        <div className="syne" style={{fontWeight:700,fontSize:14}}>{o.type}</div>
                        <div style={{display:"flex",gap:5,marginTop:4,flexWrap:"wrap"}}>
                          <span className={`badge ${o.direction==="CE"?"b-bull":"b-bear"}`}>{o.direction}</span>
                          <span className="badge b-pur">{o.strategy}</span>
                          <span className="badge b-blue">R:R {o.rr}x</span>
                          {o.status==="EXECUTED"&&<span className="badge" style={{background:T.bg3,color:T.textMuted}}>DONE</span>}
                        </div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div className="syne" style={{fontSize:22,fontWeight:800,color:o.score>=75?T.green:o.score>=65?T.yellow:T.red}}>{o.score}%</div>
                      </div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:8}}>
                      {[["ENTRY",`₹${o.premium}`,T.text],["SL",`₹${o.sl}`,T.red],["TARGET",`₹${o.target}`,T.green],["QTY",o.qty,T.accent]].map(([l,v,c])=>(
                        <div key={l} style={{background:T.bg2,borderRadius:6,padding:"6px 8px"}}>
                          <div style={{fontSize:9,color:T.textMuted,marginBottom:1}}>{l}</div>
                          <div style={{fontWeight:600,color:c,fontSize:12}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div className="pbar" style={{marginBottom:8}}><div className="pfill" style={{width:`${o.score}%`,background:`linear-gradient(90deg,${o.score>=75?T.green:T.yellow},${T.accent})`}}/></div>
                    {o.status==="PENDING"&&(
                      <div style={{display:"flex",gap:7}}>
                        <button className="btn bs" style={{flex:1,justifyContent:"center"}} onClick={e=>{e.stopPropagation();executeTrade(o);setOpportunities(p=>p.map(x=>x.id===o.id?{...x,status:"EXECUTED"}:x));}}>✓ EXECUTE</button>
                        <button className="btn bd" onClick={e=>{e.stopPropagation();setOpportunities(p=>p.filter(x=>x.id!==o.id));}}>✕</button>
                      </div>
                    )}
                  </div>
                ))}
                {opportunities.length===0&&<div style={{textAlign:"center",padding:50,color:T.textMuted}}><div style={{fontSize:32,marginBottom:10}}>◎</div>Scanning market...</div>}
              </div>
            </div>
            <div>
              <div className="syne" style={{fontWeight:700,color:T.accent,marginBottom:12}}>AI DECISION REPORT</div>
              {selectedOpp?(
                <div className="card fade">
                  <div style={{borderBottom:`1px solid ${T.cardBorder}`,paddingBottom:12,marginBottom:12}}>
                    <div style={{fontSize:9,color:T.textMuted,letterSpacing:2,marginBottom:3}}>INSTRUMENT</div>
                    <div className="syne" style={{fontSize:22,fontWeight:800}}>{selectedOpp.type}</div>
                    <div style={{display:"flex",gap:5,marginTop:6,flexWrap:"wrap"}}>
                      <span className={`badge ${selectedOpp.direction==="CE"?"b-bull":"b-bear"}`}>{selectedOpp.direction==="CE"?"BULLISH CALL":"BEARISH PUT"}</span>
                      <span className="badge b-pur">{selectedOpp.strategy}</span>
                      <span className="badge b-blue">R:R {selectedOpp.rr}x</span>
                    </div>
                  </div>
                  <div style={{marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                      <span style={{fontSize:10,color:T.textMuted,letterSpacing:1}}>AI CONFIDENCE</span>
                      <span className="syne" style={{fontSize:20,fontWeight:800,color:selectedOpp.score>=75?T.green:T.yellow}}>{selectedOpp.score}%</span>
                    </div>
                    <div className="pbar" style={{height:8}}><div className="pfill" style={{width:`${selectedOpp.score}%`,height:8,background:`linear-gradient(90deg,${selectedOpp.score>=75?T.green:T.yellow},${T.accent})`}}/></div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                    {[["Entry",`₹${selectedOpp.premium}`,T.text],["Stop Loss",`₹${selectedOpp.sl}`,T.red],["Target",`₹${selectedOpp.target}`,T.green],["Qty",selectedOpp.qty,T.accent],["Max Risk",`₹${fmt((selectedOpp.premium-selectedOpp.sl)*selectedOpp.qty)}`,T.red],["Max Profit",`₹${fmt((selectedOpp.target-selectedOpp.premium)*selectedOpp.qty)}`,T.green]].map(([l,v,c])=>(
                      <div key={l} style={{background:T.bg2,borderRadius:8,padding:"9px 11px"}}>
                        <div style={{fontSize:9,color:T.textMuted,marginBottom:2}}>{l}</div>
                        <div style={{fontWeight:700,color:c,fontSize:14}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{fontSize:10,color:T.textMuted,letterSpacing:1,marginBottom:8}}>ANALYSIS</div>
                  {selectedOpp.reasons.map((r,i)=>(
                    <div key={i} style={{display:"flex",gap:8,marginBottom:6,padding:"7px 10px",background:T.bg2,borderRadius:7,borderLeft:`3px solid ${r.includes("⚠")?T.yellow:T.accent}`}}>
                      <span style={{color:r.includes("⚠")?T.yellow:T.accent,flexShrink:0}}>→</span>
                      <span style={{fontSize:11,color:T.textSub,lineHeight:1.5}}>{r}</span>
                    </div>
                  ))}
                  {selectedOpp.status==="PENDING"&&(
                    <button className="btn bp" style={{width:"100%",justifyContent:"center",marginTop:12,padding:11,fontSize:13}} onClick={()=>{executeTrade(selectedOpp);setOpportunities(p=>p.map(x=>x.id===selectedOpp.id?{...x,status:"EXECUTED"}:x));setSelectedOpp(p=>({...p,status:"EXECUTED"}));}}>▶ EXECUTE THIS TRADE</button>
                  )}
                </div>
              ):(
                <div className="card" style={{textAlign:"center",padding:"50px 20px",color:T.textMuted}}>
                  <div style={{fontSize:32,marginBottom:10}}>◈</div>Select a signal to view AI analysis
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ POSITIONS ═══ */}
        {activeTab==="positions"&&(
          <div className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:6}}>
              <div className="syne" style={{fontWeight:700,color:T.accent}}>OPEN POSITIONS ({openPositions.length})</div>
              <span style={{fontWeight:700,color:openPositions.reduce((s,p)=>s+p.unrealizedPnl,0)>=0?T.green:T.red}}>
                Unrealized: {fmtPnl(openPositions.reduce((s,p)=>s+p.unrealizedPnl,0))}
              </span>
            </div>
            {openPositions.length>0?(
              <div style={{overflowX:"auto"}}>
                <table>
                  <thead><tr>{["INSTRUMENT","TIME","ENTRY","CURRENT","SL","TARGET","QTY","P&L","STRATEGY",""].map(h=><th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{openPositions.map(p=>(
                    <tr key={p.id}>
                      <td style={{fontWeight:600}}>{p.type}</td>
                      <td style={{color:T.textMuted}}>{p.entryTime.toLocaleTimeString("en-IN")}</td>
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
            ):(
              <div className="card" style={{textAlign:"center",padding:50,color:T.textMuted}}><div style={{fontSize:32,marginBottom:10}}>◎</div>No open positions</div>
            )}
          </div>
        )}

        {/* ═══ HISTORY ═══ */}
        {activeTab==="history"&&(
          <div className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:6}}>
              <div className="syne" style={{fontWeight:700,color:T.accent}}>TRADE HISTORY ({trades.length})</div>
              <div style={{display:"flex",gap:10,fontSize:11}}>
                <span style={{color:T.green}}>{analytics.wins}W</span>
                <span style={{color:T.red}}>{analytics.losses}L</span>
                <span style={{color:T.yellow}}>{winRate}% WR</span>
                <span style={{color:analytics.totalPnl>=0?T.green:T.red,fontWeight:700}}>{fmtPnl(analytics.totalPnl)}</span>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table>
                <thead><tr>{["TIME","INSTRUMENT","DIR","ENTRY","EXIT","QTY","P&L","STRATEGY","REASON","RESULT"].map(h=><th key={h}>{h}</th>)}</tr></thead>
                <tbody>{trades.map((t,i)=>(
                  <tr key={i}>
                    <td style={{color:T.textMuted}}>{t.entryTime?.toLocaleTimeString("en-IN")}</td>
                    <td style={{fontWeight:600}}>{t.type}</td>
                    <td><span className={`badge ${t.direction==="CE"?"b-bull":"b-bear"}`}>{t.direction}</span></td>
                    <td>₹{t.entryPrice}</td>
                    <td>₹{t.exitPrice}</td>
                    <td>{t.qty}</td>
                    <td style={{fontWeight:700,color:t.pnl>=0?T.green:T.red}}>{fmtPnl(t.pnl)}</td>
                    <td style={{color:T.purple,fontSize:10}}>{t.strategy}</td>
                    <td style={{color:T.textMuted,fontSize:10}}>{t.closeReason}</td>
                    <td><span className={`badge ${t.pnl>=0?"b-win":"b-loss"}`}>{t.pnl>=0?"WIN":"LOSS"}</span></td>
                  </tr>
                ))}</tbody>
              </table>
              {trades.length===0&&<div className="card" style={{textAlign:"center",padding:50,color:T.textMuted,marginTop:12}}><div style={{fontSize:32,marginBottom:10}}>◎</div>No trades yet</div>}
            </div>
          </div>
        )}

        {/* ═══ ANALYTICS ═══ */}
        {activeTab==="analytics"&&(
          <div className="fade" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}} >
            <div className="card">
              <div className="syne" style={{fontWeight:700,color:T.accent,marginBottom:14}}>PERFORMANCE</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {[{l:"WIN RATE",v:`${winRate}%`,c:winRate>=55?T.green:T.red},{l:"TOTAL P&L",v:fmtPnl(analytics.totalPnl),c:analytics.totalPnl>=0?T.green:T.red},{l:"AVG WIN",v:`₹${fmt(analytics.avgWin)}`,c:T.green},{l:"AVG LOSS",v:`₹${fmt(analytics.avgLoss)}`,c:T.red},{l:"PROFIT FACTOR",v:analytics.avgLoss>0?fmt(analytics.avgWin/analytics.avgLoss):"N/A",c:T.yellow},{l:"TRADES",v:analytics.wins+analytics.losses,c:T.text}].map(m=>(
                  <div key={m.l} style={{background:T.bg2,borderRadius:10,padding:"13px 14px"}}>
                    <div style={{fontSize:9,color:T.textMuted,letterSpacing:1.5,marginBottom:4}}>{m.l}</div>
                    <div className="syne" style={{fontSize:20,fontWeight:700,color:m.c}}>{m.v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="syne" style={{fontWeight:700,color:T.purple,marginBottom:14}}>STRATEGY BREAKDOWN</div>
              {Object.entries(analytics.stratStats).length>0?Object.entries(analytics.stratStats).map(([s,st])=>(
                <div key={s} style={{marginBottom:12,background:T.bg2,borderRadius:9,padding:11}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontWeight:600,fontSize:12}}>{s}</span>
                    <span style={{color:st.pnl>=0?T.green:T.red,fontWeight:700}}>{fmtPnl(st.pnl)}</span>
                  </div>
                  <div style={{display:"flex",gap:10,fontSize:10,color:T.textMuted,marginBottom:5}}>
                    <span>{st.trades} trades</span><span style={{color:T.green}}>{st.wins}W</span><span style={{color:T.red}}>{st.trades-st.wins}L</span>
                    <span style={{color:T.yellow}}>{st.trades>0?Math.round(st.wins/st.trades*100):0}%</span>
                  </div>
                  <div className="pbar"><div className="pfill" style={{width:`${st.trades>0?st.wins/st.trades*100:0}%`,background:`linear-gradient(90deg,${T.purple},${T.accent})`}}/></div>
                </div>
              )):<div style={{textAlign:"center",padding:40,color:T.textMuted,fontSize:11}}>No trades yet</div>}
            </div>
            <div className="card">
              <div className="syne" style={{fontWeight:700,color:T.yellow,marginBottom:14}}>RISK DASHBOARD</div>
              {[{l:"Daily Loss Used",v:`₹${fmt(Math.abs(Math.min(0,dailyPnl)))}`,lim:`₹${fmt(config.maxDailyLoss)}`,pct:Math.abs(Math.min(0,dailyPnl))/config.maxDailyLoss*100},{l:"Profit vs Target",v:fmtPnl(dailyPnl),lim:`₹${fmt(config.profitTarget)}`,pct:Math.max(0,dailyPnl)/config.profitTarget*100},{l:"Trades Used",v:`${todayTrades}`,lim:`${config.maxTradesDay} max`,pct:todayTrades/config.maxTradesDay*100},{l:"Capital Drawdown",v:`${drawdownPct.toFixed(1)}%`,lim:`${(100-config.minCapitalFloor)}% max`,pct:drawdownPct/(100-config.minCapitalFloor)*100}].map(r=>(
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
              <div className="syne" style={{fontWeight:700,color:T.green,marginBottom:14}}>SYSTEM HEALTH</div>
              {[{l:"Trading Engine",s:systemStatus,c:systemStatus==="ACTIVE"?T.green:T.red},{l:"Market Hours",s:isMarketOpen()?"OPEN":"CLOSED",c:isMarketOpen()?T.green:T.yellow},{l:`${config.broker.split(" ")[0]} API`,s:apiStatus,c:apiStatus==="CONNECTED"?T.green:T.yellow},{l:"AI Engine",s:"ACTIVE",c:T.green},{l:"Capital Protection",s:config.capitalProtection?"ON":"OFF",c:config.capitalProtection?T.green:T.yellow},{l:"Auto-Trade",s:config.autoTrade?"ENABLED":"MANUAL",c:config.autoTrade?T.red:T.accent},{l:"Profit Target",s:dailyPnl>=config.profitTarget?"REACHED":"MONITORING",c:dailyPnl>=config.profitTarget?T.green:T.accent}].map(s=>(
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

        {/* ═══ OPTIONS CHAIN ═══ */}
        {activeTab==="chain"&&(
          <div className="fade" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}} >
            {[{l:"NIFTY",spot:market.nifty,chain:nChain},{l:"BANKNIFTY",spot:market.bnf,chain:bChain}].map(({l,spot,chain})=>(
              <div key={l} className="card" style={{padding:0,overflow:"hidden"}}>
                <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.cardBorder}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div className="syne" style={{fontWeight:700,color:T.accent}}>{l}</div>
                  <div style={{fontSize:12}}>Spot: <b>{fmt(spot)}</b></div>
                </div>
                <div className="chain-row" style={{background:T.bg2,fontSize:9,color:T.textMuted,fontWeight:700,letterSpacing:1}}>
                  <span>CE VOL</span><span>CE OI</span><span style={{color:T.green}}>CE ₹</span>
                  <span style={{textAlign:"center",color:T.text}}>STRIKE</span>
                  <span style={{color:T.red}}>PE ₹</span><span>PE OI</span><span style={{textAlign:"right"}}>PE VOL</span>
                </div>
                {chain.map(r=>{
                  const isAtm=Math.abs(r.strike-spot)<100;
                  return(
                    <div key={r.strike} className={`chain-row ${isAtm?"catm":""}`}>
                      <span style={{color:T.accent,fontSize:10}}>{fmt(r.ceV,0)}</span>
                      <span style={{color:T.textMuted,fontSize:10}}>{fmt(r.ceOI,0)}</span>
                      <span style={{color:T.green,fontWeight:600}}>₹{r.cePrem}</span>
                      <span style={{textAlign:"center",fontWeight:isAtm?700:400,color:isAtm?T.accent:T.text,fontSize:isAtm?13:11}}>{r.strike}</span>
                      <span style={{color:T.red,fontWeight:600}}>₹{r.pePrem}</span>
                      <span style={{color:T.textMuted,fontSize:10}}>{fmt(r.peOI,0)}</span>
                      <span style={{textAlign:"right",color:T.red,fontSize:10}}>{fmt(r.peV,0)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* ═══ LOG ═══ */}
        {activeTab==="logs"&&(
          <div className="fade">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div className="syne" style={{fontWeight:700,color:T.textSub}}>ACTIVITY LOG ({logs.length})</div>
              <button className="btn bo" style={{fontSize:10}} onClick={()=>setLogs([])}>CLEAR</button>
            </div>
            <div className="card" style={{padding:0,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"68px 52px 1fr",gap:8,padding:"8px 12px",background:T.bg2,fontSize:9,color:T.textMuted,letterSpacing:1,fontWeight:700,borderBottom:`1px solid ${T.cardBorder}`}}>
                <span>TIME</span><span>LEVEL</span><span>MESSAGE</span>
              </div>
              <div style={{maxHeight:"70vh",overflowY:"auto"}}>
                {logs.map(l=>(
                  <div key={l.id} className="logrow">
                    <span style={{color:T.textMuted}}>{l.time}</span>
                    <span style={{color:l.level==="TRADE"?T.accent:l.level==="SIGNAL"?T.purple:l.level==="WIN"?T.green:l.level==="LOSS"||l.level==="ERROR"?T.red:l.level==="WARN"?T.yellow:T.textMuted,fontWeight:600}}>{l.level}</span>
                    <span style={{color:l.level==="TRADE"?T.accent:l.level==="SIGNAL"?T.purple:l.level==="WIN"?T.green:l.level==="LOSS"||l.level==="ERROR"?T.red:T.textSub,lineHeight:1.4}}>{l.msg}</span>
                  </div>
                ))}
                {logs.length===0&&<div style={{padding:40,textAlign:"center",color:T.textMuted,fontSize:11}}>No entries</div>}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{borderTop:`1px solid ${T.navBorder}`,padding:"7px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,color:T.textMuted,flexWrap:"wrap",gap:4}}>
        <span>QUANTEDGE AI v2.0 · NIFTY · BANKNIFTY</span>
        <span style={{color:T.red,fontSize:9}}>⚠ EDUCATIONAL USE ONLY — NOT FINANCIAL ADVICE</span>
      </div>
    </div>
  );
}
