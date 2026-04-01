// /api/order.js  - Vercel Serverless Function
// Place this file in your GitHub repo at: /api/order.js
// Vercel will auto-deploy it as https://quantedge-ai-jade.vercel.app/api/order

export default async function handler(req, res) {
  // Allow CORS from your app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, token, payload } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'No token provided' });
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    let upstoxUrl, upstoxBody, method;

    if (action === 'place_order') {
      upstoxUrl = 'https://api.upstox.com/v2/order/place';
      method = 'POST';
      upstoxBody = JSON.stringify(payload);
    } else if (action === 'option_chain') {
      const { instrument_key, expiry_date } = payload;
      upstoxUrl = expiry_date 
        ? `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrument_key)}&expiry_date=${expiry_date}`
        : `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrument_key)}`;
      method = 'GET';
    } else if (action === 'fund_margin') {
      upstoxUrl = 'https://api.upstox.com/v2/user/fund-margin';
      method = 'GET';
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const fetchOpts = { method, headers };
    if (method === 'POST') fetchOpts.body = upstoxBody;

    const response = await fetch(upstoxUrl, fetchOpts);
    const data = await response.json();

    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
