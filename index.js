const http = require('http');
const config = require('./config');

console.log("🚀 System Booting...");

// 1. START WEB SERVER IMMEDIATELY
// This prevents Railway from hanging for 20 minutes.
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Flow Radar is Active ✅');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Health Check Server online on port ${PORT}`);
    
    // 2. NOW INITIALIZE ENGINE
    // We require it here to ensure the server is already "Live"
    const engine = require('./engine');
    try {
        engine.startScanner();
        engine.startRadar();
        engine.startListener();
        
        engine.sendTelegram("🟢 *Flow Radar Online*\nSystem stabilized. Logic ($100k+) active.");
    } catch (err) {
        console.error("❌ Startup Error:", err.message);
    }
});
