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
        // Apply onyx voice with foreman style for Greek output
        if (parsed.voice === 'fable' || parsed.voice === 'echo' || parsed.voice === 'alloy') {
          parsed.voice = 'onyx';
        }
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
      name: 'Translator',
      short_name: 'Translator',
      start_url: '/',
      display: 'standalone',
      background_color: '#0f1117',
      theme_color: '#3b82f6',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    }));
    return;
  }

  // App Icons
  if (req.url === '/icon-192.png' || req.url === '/icon-512.png' || req.url === '/icon.png') {
    const iconBuf = Buffer.from('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', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(iconBuf);
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
      const content = fs.readFileSync(path.join(__dirname, 'login.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch(e) {
      if (!res.headersSent) { res.writeHead(404); res.end('login.html not found: ' + e.message); }
    }
    return;
  }

  // Main app
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const content = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch(e) {
      if (!res.headersSent) { res.writeHead(404); res.end('index.html not found: ' + e.message); }
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

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

server.listen(PORT, () => {
  console.log('WorkInGreece Interpreter running on port ' + PORT);
});
