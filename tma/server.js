const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../bot/.env') });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Aggressive Bypass for Telegram/Ngrok
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', '1');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // More permissive CSP
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://t.me https://*.t.me https://web.telegram.org https://*.web.telegram.org;");
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    next();
});

// Priority 1: Static Files (Manifest must be accessible)
app.use(express.static(path.join(__dirname, 'public')));

// Priority 2: Health check
app.get('/health', (req, res) => res.send('OK'));

// Priority 3: API Config
app.get('/api/config', (req, res) => {
    res.json({
        COORDINATOR_ADDRESS: process.env.COORDINATOR_ADDRESS,
        REGISTRY_ADDRESS: process.env.REGISTRY_ADDRESS,
        REPUTATION_ADDRESS: process.env.REPUTATION_ADDRESS,
        TON_API_KEY: process.env.TON_API_KEY
    });
});

// Priority 4: Mandatory Root Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// IN-MEMORY LOG STORE
const logsBank = [
    { id: Date.now(), status: 'success', badge: 'System', msg: 'TON SwarmOS Neural Bridge established.' }
];

app.post('/api/logs', (req, res) => {
    // Check if body exists (fall-back for parsing issues)
    if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid request body' });
    }
    
    const { status, badge, msg } = req.body;
    if (!status || !badge || !msg) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const newLog = { id: Date.now(), status, badge, msg };
    logsBank.push(newLog);
    if (logsBank.length > 50) logsBank.shift(); // Keep last 50
    console.log(`[LOG PUSH] ${badge}: ${msg}`);
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    res.json(logsBank);
});

// Final fallback
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  🚀 SwarmOS TMA Server`);
    console.log(`  URL: http://localhost:${PORT}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
