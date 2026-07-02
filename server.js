const { WebSocketServer } = require('ws');
const { createServer } = require('http');

const PORT = process.env.PORT || 3000;
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorkInEurope Translator Server OK');
});

const wss = new WebSocketServer({ server });

// Rooms: { roomCode: { A: ws, B: ws } }
const rooms = {};

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

wss.on('connection', (ws) => {
  let myRoom = null;
  let mySide = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // CREATE room (supervisor/εργοδηγός)
    if (msg.type === 'create') {
      let code = generateCode();
      while (rooms[code]) code = generateCode();
      rooms[code] = { A: ws, B: null };
      myRoom = code;
      mySide = 'A';
      ws.send(JSON.stringify({ type: 'created', code }));
      console.log(`Room ${code} created`);
    }

    // JOIN room (worker/εργάτης)
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

      // Notify A that B joined
      if (rooms[code].A && rooms[code].A.readyState === 1) {
        rooms[code].A.send(JSON.stringify({ type: 'partner_joined' }));
      }
      console.log(`Room ${code}: B joined`);
    }

    // TRANSLATION ready — forward to other side
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

    // PING keepalive
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
    // Clean up room
    rooms[myRoom][mySide] = null;
    if (!rooms[myRoom].A && !rooms[myRoom].B) {
      delete rooms[myRoom];
      console.log(`Room ${myRoom} deleted`);
    }
    console.log(`Room ${myRoom}: ${mySide} disconnected`);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
