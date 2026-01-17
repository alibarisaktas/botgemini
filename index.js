const http = require('http');
const config = require('./config');

console.log("🚀 System Booting...");

// 1. START WEB SERVER IMMEDIATELY
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Flow Radar is Active ✅');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Health Check Server online on port ${PORT}`);
    
    // 2. INITIALIZE ENGINE
    const engine = require('./engine');
    try {
        engine.startScanner();
        engine.startRadar();
        engine.startListener();
        
        engine.sendTelegram("🟢 *Flow Radar Online*\nFull logic stabilized. Market tracking active.");
    } catch (err) {
        console.error("❌ Startup Error:", err.message);
    }
});
