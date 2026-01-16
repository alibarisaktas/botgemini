const http = require('http');
const engine = require('./engine');
const config = require('./config');

console.log("🚀 System Booting...");

// Health Check Server for Railway
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Flow Radar is Active ✅');
});

server.listen(config.PORT || 3000, () => {
    console.log(`✅ Health Check Server online.`);
});

// Initialize Engine Modules
try {
    engine.startScanner();
    engine.startRadar();
    engine.startListener();
    
    // Test Telegram Connection
    engine.sendTelegram("🟢 *Flow Radar Online*\nLogic: High Conviction ($100k+)\nStablecoins: Filtered 🛡️");
} catch (err) {
    console.error("❌ Startup Error:", err.message);
}
