const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const fs = require('fs');
const https = require('https');
const path = require('path');

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── HELPERS ──

function proxyOpenAI(apiPath, body, res) {
  const data = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.openai.com',
    path: apiPath,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + OPENAI_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, (apiRes) => {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': apiRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    apiRes.pipe(res);
  });
  req.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
  req.write(data);
  req.end();
}

function proxyWhisper(buf, contentType, res) {
  const req = https.request({
    hostname: 'api.openai.com',
    path: '/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + OPENAI_KEY,
      'Content-Type': contentType,
      'Content-Length': buf.length
    }
  }, (apiRes) => {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    apiRes.pipe(res);
  });
  req.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
  req.write(buf);
  req.end();
}

async function supabaseFetch(apiPath, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: new URL(SUPABASE_URL).hostname,
      path: apiPath,
      method: method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(body); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── HTTP SERVER ──

const server = createServer((req, res) => {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // ── API ROUTES ──

  // Register company
  if (req.method === 'POST' && req.url === '/api/register-company') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { company_name, email, auth_id } = JSON.parse(body);
        const company = await supabaseFetch('/rest/v1/companies', 'POST', { name: company_name, email });
        const companyId = Array.isArray(company) ? company[0]?.id : company?.id;
        if (companyId && auth_id) {
          await supabaseFetch('/rest/v1/users', 'POST', { auth_id, company_id: companyId, email, role: 'admin' });
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Translate (GPT-4o)
  if (req.method === 'POST' && req.url === '/api/translate') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { proxyOpenAI('/v1/chat/completions', JSON.parse(body), res); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // TTS
  if (req.method === 'POST' && req.url === '/api/tts') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const data = JSON.stringify(parsed);
        const req2 = https.request({
          hostname: 'api.openai.com',
          path: '/v1/audio/speech',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + OPENAI_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
          }
        }, (apiRes) => {
          res.writeHead(apiRes.statusCode, {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*'
          });
          apiRes.pipe(res);
        });
        req2.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        req2.write(data);
        req2.end();
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // STT (Whisper)
  if (req.method === 'POST' && req.url === '/api/stt') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      proxyWhisper(Buffer.concat(chunks), req.headers['content-type'], res);
    });
    return;
  }

  // Manifest
  if (req.url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify({
      name: 'WorkInGreece Διερμηνέας',
      short_name: 'Διερμηνέας',
      start_url: '/',
      display: 'standalone',
      background_color: '#0f1117',
      theme_color: '#0f1117',
      icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }]
    }));
    return;
  }

  // Service Worker
  if (req.url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end("self.addEventListener('fetch', e => {});");
    return;
  }

  // Health
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: Object.keys(rooms).length }));
    return;
  }

  // Login page
  if (req.url === '/login') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'login.html')));
    } catch(e) {
      res.writeHead(404); res.end('login.html not found');
    }
    return;
  }

  // Main app
  if (req.url === '/' || req.url === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } catch(e) {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WEBSOCKET ──

const rooms = {};

const wss = new WebSocketServer({ server });

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

wss.on('connection', (ws) => {
  let myRoom = null;
  let mySide = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'create') {
      let code = generateCode();
      while (rooms[code]) code = generateCode();
      rooms[code] = { A: ws, B: null };
      myRoom = code;
      mySide = 'A';
      ws.send(JSON.stringify({ type: 'created', code }));
      console.log('Room ' + code + ' created');
    }
    else if (msg.type === 'join') {
      const code = msg.code;
      if (!rooms[code]) {
        ws.send(JSON.stringify({ type: 'error', message: 'Λάθος κωδικός δωματίου' }));
        return;
      }
      if (rooms[code].B) {
        ws.send(JSON.stringify({ type: 'error', message: 'Το δωμάτιο είναι γεμάτο' }));
        return;
      }
      rooms[code].B = ws;
      myRoom = code;
      mySide = 'B';
      ws.send(JSON.stringify({ type: 'joined', code }));
      if (rooms[code].A && rooms[code].A.readyState === 1) {
        rooms[code].A.send(JSON.stringify({ type: 'partner_joined' }));
      }
      console.log('Room ' + code + ': B joined');
    }
    else if (msg.type === 'translation') {
      if (!myRoom || !rooms[myRoom]) return;
      const targetSide = mySide === 'A' ? 'B' : 'A';
      const target = rooms[myRoom][targetSide];
      if (target && target.readyState === 1) {
        target.send(JSON.stringify({
          type: 'play_translation',
          text: msg.text,
          voice: msg.voice,
          transcript: msg.transcript
        }));
      }
    }
    else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (!myRoom || !rooms[myRoom]) return;
    const other = mySide === 'A' ? 'B' : 'A';
    const otherWs = rooms[myRoom][other];
    if (otherWs && otherWs.readyState === 1) {
      otherWs.send(JSON.stringify({ type: 'partner_left' }));
    }
    rooms[myRoom][mySide] = null;
    if (!rooms[myRoom].A && !rooms[myRoom].B) {
      delete rooms[myRoom];
      console.log('Room ' + myRoom + ' deleted');
    }
    console.log('Room ' + myRoom + ': ' + mySide + ' disconnected');
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

server.listen(PORT, () => {
  console.log('WorkInGreece Interpreter running on port ' + PORT);
});
