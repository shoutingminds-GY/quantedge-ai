# QuantEdge AI — Automated Options Trading Platform

> **⚠️ DISCLAIMER:** This is an educational/research tool. It does **not** constitute financial advice. Automated trading involves significant risk. Always paper-trade first. Read your broker's API terms before connecting live keys. The authors are not responsible for any financial losses.

---

## What This Is

A browser-based automated options trading dashboard for **NIFTY and BANKNIFTY** on Indian exchanges.

- AI-driven trade signal detection (5 strategies)
- Real-time options chain display
- Risk management engine with daily loss limits and trade count controls
- Full activity logging and trade history
- Broker API integration: **Zerodha Kite**, **Upstox**, **Angel One SmartAPI**
- Runs entirely in a browser — no backend required for the demo/simulation mode

---

## Quick Start (GitHub Pages / Netlify / Vercel)

### Option 1 — Vite + React (recommended)

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/quantedge-ai.git
cd quantedge-ai

# 2. Install dependencies
npm install

# 3. Run locally
npm run dev

# 4. Build for production
npm run build
```

### Option 2 — Deploy to Vercel (one click)

1. Push this repo to GitHub
2. Go to https://vercel.com → Import Project → select your repo
3. Framework: **Vite** · Root: `/` · Build command: `npm run build` · Output: `dist`
4. Click Deploy

### Option 3 — Deploy to GitHub Pages

```bash
npm run build
npx gh-pages -d dist
```

---

## Project Structure

```
quantedge-ai/
├── src/
│   ├── App.jsx                  ← Main entry point
│   ├── components/
│   │   ├── TradingPlatform.jsx  ← Core platform (the main file)
│   │   ├── Dashboard.jsx
│   │   ├── Signals.jsx
│   │   ├── Positions.jsx
│   │   ├── History.jsx
│   │   ├── Analytics.jsx
│   │   ├── OptionsChain.jsx
│   │   └── ActivityLog.jsx
│   ├── engine/
│   │   ├── marketEngine.js      ← Simulated market data
│   │   ├── aiAnalysis.js        ← Signal detection logic
│   │   └── riskManager.js       ← Risk controls
│   └── brokers/
│       ├── zerodha.js           ← Kite Connect integration
│       ├── upstox.js            ← Upstox API v2
│       └── angelone.js          ← SmartAPI integration
├── public/
├── package.json
├── vite.config.js
└── README.md
```

---

## Configuration (in-app)

Click **⚙ CONFIG** in the top-right of the dashboard:

| Setting | Description | Default |
|---|---|---|
| Capital (₹) | Total trading capital | ₹1,00,000 |
| Risk per trade (%) | Max % of capital per trade | 1% |
| Max daily loss (₹) | System halts when this is hit | ₹3,000 |
| Min trades per day | Minimum signal target | 1 |
| Max trades per day | Hard cap — no new trades after this | 10 |
| Broker | Zerodha / Upstox / Angel One | Zerodha Kite |
| API Key / Secret | Your broker API credentials (encrypted in memory) | — |
| Auto-Trade | Execute signals automatically | OFF |
| Trailing Stop | Enable trailing stop loss | ON |

---

## Broker API Setup

### Zerodha Kite Connect
1. Register at https://kite.trade
2. Create an app → get `api_key` and `api_secret`
3. Paste into Config panel
4. Kite Connect docs: https://kite.trade/docs/connect/v3/

### Upstox API v2
1. Register at https://developer.upstox.com
2. Create app → get `client_id` and `client_secret`
3. Docs: https://upstox.com/developer/api-documentation/

### Angel One SmartAPI
1. Register at https://smartapi.angelbroking.com
2. Generate API key
3. Docs: https://smartapi.angelbroking.com/docs

> **Security note:** Never commit API keys to GitHub. Use environment variables:
> ```
> VITE_BROKER_API_KEY=your_key_here
> VITE_BROKER_SECRET=your_secret_here
> ```
> Add a `.env` file locally and add `.env` to `.gitignore`.

---

## Risk & Compliance Notes

- Zerodha, Upstox, and Angel One **permit** retail automated trading via their published APIs
- SEBI regulates algorithmic trading — institutional algo strategies require registration; retail API usage for personal accounts is generally accepted
- Your broker may impose order-to-trade ratio limits — avoid placing and cancelling excessive orders
- Always start with **paper trading / demo mode** before using real capital
- This platform defaults to simulation mode — no real orders are placed without a live API key + Auto-Trade enabled

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, CSS-in-JS |
| State | React hooks (useState, useEffect, useRef) |
| Simulated data | In-memory market engine |
| Live data (production) | Broker WebSocket feeds |
| Persistence (production) | PostgreSQL + FastAPI backend |
| Deployment | Vercel / Netlify / GitHub Pages |

---

## Roadmap

- [ ] Real WebSocket market data feed
- [ ] Python FastAPI backend with PostgreSQL trade database
- [ ] Backtesting engine
- [ ] Multi-user authentication
- [ ] Email/SMS alerts on trade execution
- [ ] Export trade history to CSV/Excel
- [ ] NSE holiday calendar integration

---

## License

MIT — free to use, modify, and deploy for personal and educational purposes.
