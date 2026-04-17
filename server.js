/*
  ESP32 Safety Monitor — Cloud Backend + Twilio Alerts
*/

const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const cors      = require('cors');
const path      = require('path');
const twilio    = require('twilio');

// ─── Twilio Setup ───────────────────────────────────
const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH
);

const ALERT_PHONE  = process.env.ALERT_PHONE;
const TWILIO_PHONE = process.env.TWILIO_PHONE;

// ─── App Setup ──────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const API_KEY = process.env.API_KEY || 'change-me-to-something-secret';
const PORT    = process.env.PORT    || 3000;

// ─── In-memory state ────────────────────────────────
let latest = {
  gasValue:      0,
  gasDetected:   false,
  flameDetected: false,
  servoAngle:    0,
  updatedAt:     null,
  online:        false,
};

let lastSeenAt = 0;
const OFFLINE_TIMEOUT = 5000;

// 🚨 Alert control
let lastAlertState = false;
let lastAlertTime  = 0;
const ALERT_COOLDOWN = 60000; // 1 min

// ─── Middleware ─────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth ───────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Routes ─────────────────────────────────────────

// ESP32 → backend
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

  // ─── 🚨 ALERT LOGIC ───────────────────────────────
  const alertActive = gasDetected || flameDetected;
  const now = Date.now();

  const shouldTrigger =
    alertActive &&
    (!lastAlertState || (now - lastAlertTime > ALERT_COOLDOWN));

  if (shouldTrigger) {
    let message = "🚨 SAFETY ALERT!\n";

    if (gasDetected && flameDetected) {
      message += "DANGER: Gas + Fire!";
    } else if (gasDetected) {
      message += "Gas Leak Detected!";
    } else if (flameDetected) {
      message += "Fire Detected!";
    }

    message += `\nGas Value: ${gasValue}`;

    // 📲 SMS
    client.messages.create({
      body: message,
      from: TWILIO_PHONE,
      to: ALERT_PHONE
    })
    .then(() => console.log("[TWILIO] SMS sent"))
    .catch(err => console.error("[TWILIO] SMS error:", err.message));

    // 📞 CALL
    client.calls.create({
      url: "http://demo.twilio.com/docs/voice.xml",
      to: ALERT_PHONE,
      from: TWILIO_PHONE
    })
    .then(() => console.log("[TWILIO] Call triggered"))
    .catch(err => console.error("[TWILIO] Call error:", err.message));

    lastAlertTime = now;
  }

  lastAlertState = alertActive;

  // ─── Dashboard (UNCHANGED) ───────────────────────
  broadcastToClients(latest);

  res.json({ ok: true });
});

// Polling fallback
app.get('/api/status', (req, res) => {
  checkOnlineStatus();
  res.json(latest);
});

// Serve dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ─────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] client connected:', wss.clients.size);

  checkOnlineStatus();
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(latest));
  }

  ws.on('close', () => {
    console.log('[WS] client disconnected:', wss.clients.size);
  });
});

function broadcastToClients(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

// ─── Online check ──────────────────────────────────
function checkOnlineStatus() {
  const wasOnline = latest.online;
  latest.online = (Date.now() - lastSeenAt) < OFFLINE_TIMEOUT;

  if (wasOnline && !latest.online) {
    broadcastToClients(latest);
  }
}

setInterval(checkOnlineStatus, 2000);

// ─── Start ─────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
