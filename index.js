const http = require('http');
const engine = require('./engine');
const config = require('./config');

console.log("🚀 System Booting...");

// Health Check Server (Keeps Railway alive)
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
    
    // Now engine.sendTelegram will work!
    engine.sendTelegram("🟢 *Flow Radar Online*\nHigh-Conviction Logic ($100k+) active.\nStablecoins: Filtered 🛡️");
} catch (err) {
    console.error("❌ Startup Error:", err.message);
}
