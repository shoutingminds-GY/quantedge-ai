// /api/order.js - Vercel Serverless Function
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET request - return outbound IP (what Upstox sees)
  if (req.method === 'GET') {
    try {
      const r = await fetch('https://api.ipify.org?format=json');
      const d = await r.json();
      return res.status(200).json({ 
        outbound_ip: d.ip,
        message: 'This is the IP Upstox sees. Whitelist this in Upstox Developer App.'
      });
    } catch(e) {
      return res.status(200).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, token, payload } = req.body;
  if (!token) return res.status(400).json({ error: 'No token' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    let url, method = 'GET', body;

    if (action === 'place_order') {
      url = 'https://api.upstox.com/v2/order/place';
      method = 'POST';
      body = JSON.stringify(payload);
    } else if (action === 'option_chain') {
      const { instrument_key, expiry_date } = payload;
      url = expiry_date
        ? `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrument_key)}&expiry_date=${expiry_date}`
        : `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(instrument_key)}`;
    } else if (action === 'fund_margin') {
      const r1 = await fetch('https://api.upstox.com/v2/user/fund-margin?segment=FO', { headers });
      if (r1.ok) { const d = await r1.json(); return res.status(200).json(d); }
      const r2 = await fetch('https://api.upstox.com/v2/user/fund-margin', { headers });
      const d2 = await r2.json();
      return res.status(r2.status).json(d2);
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const opts = { method, headers };
    if (body) opts.body = body;
    const r = await fetch(url, opts);
    const d = await r.json();
    return res.status(r.status).json(d);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
