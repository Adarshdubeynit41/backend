/*
  ESP32 Safety Monitor — Cloud Backend
  ──────────────────────────────────────
  • POST /api/data   ← ESP32 pushes sensor readings here
  • GET  /api/status ← returns latest snapshot (JSON)
  • GET  /           ← serves the dashboard (public/index.html)
  • WS   /ws         ← browser connects here for live push

  Environment variables (set in Railway / Render dashboard):
    PORT     — assigned automatically by the platform
    API_KEY  — secret key the ESP32 must send as x-api-key header
*/

const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const cors      = require('cors');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const API_KEY = process.env.API_KEY || 'change-me-to-something-secret';
const PORT    = process.env.PORT    || 3000;

// ─── In-memory state ─────────────────────────────────────────────────────────
let latest = {
  gasValue:      0,
  gasDetected:   false,
  flameDetected: false,
  servoAngle:    0,
  updatedAt:     null,
  online:        false,   // true when ESP32 is posting
};

let lastSeenAt = 0;
const OFFLINE_TIMEOUT = 5000; // ms — mark offline if no POST in 5 s

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth middleware for ESP32 route ─────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// ESP32 → backend: receive sensor data
app.post('/api/data', requireApiKey, (req, res) => {
  const { gasValue, gasDetected, flameDetected, servoAngle } = req.body;

  if (
    typeof gasValue      !== 'number' ||
    typeof gasDetected   !== 'boolean' ||
    typeof flameDetected !== 'boolean'
  ) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  lastSeenAt = Date.now();

  latest = {
    gasValue,
    gasDetected,
    flameDetected,
    servoAngle:  servoAngle ?? (gasDetected || flameDetected ? 180 : 0),
    updatedAt:   new Date().toISOString(),
    online:      true,
  };

  broadcastToClients(latest);
  res.json({ ok: true });
});

// Browser polling fallback (WebSocket preferred)
app.get('/api/status', (req, res) => {
  checkOnlineStatus();
  res.json(latest);
});

// Catch-all → serve dashboard for any unknown route (SPA behaviour)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] client connected, total:', wss.clients.size);
  // Send current state immediately on connect
  checkOnlineStatus();
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(latest));
  }

  ws.on('close', () => {
    console.log('[WS] client disconnected, total:', wss.clients.size);
  });
});

function broadcastToClients(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  });
}

// Marks device offline if no POST received recently
function checkOnlineStatus() {
  const wasOnline = latest.online;
  latest.online = (Date.now() - lastSeenAt) < OFFLINE_TIMEOUT;
  if (wasOnline && !latest.online) {
    broadcastToClients(latest);
  }
}

// Periodically check online status (so WS clients know when ESP32 goes quiet)
setInterval(() => {
  checkOnlineStatus();
}, 2000);

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`ESP32 Safety Monitor backend running on port ${PORT}`);
  console.log(`API_KEY: ${API_KEY === 'change-me-to-something-secret' ? '⚠ using default — set API_KEY env var!' : '✓ set'}`);
});
