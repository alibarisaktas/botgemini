const http = require('http'); // Built-in Node module
const engine = require('./engine');
const config = require('./config');

console.log("🚀 System Booting...");

// 1. Start the Health Check Server (Prevents Railway SIGTERM)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Flow Radar is Running ✅');
});

server.listen(config.PORT, () => {
    console.log(`✅ Health Check Server listening on port ${config.PORT}`);
});

// 2. Start the Whale Detection Logic
engine.startScanner();
engine.startRadar();

engine.sendTelegram("🟢 *Flow Radar Online*\nHealth Check server active. Monitoring Binance...");

// 3. Heartbeat Loop
setInterval(() => {
    engine.sendTelegram(`🟡 *Heartbeat*\nMonitoring: ${engine.getHotlist().length} pairs\nStatus: Running ✅`);
}, config.HEARTBEAT_HOURS * 3600000);
