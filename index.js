const http = require('http');

// 1. START SERVER IMMEDIATELY 
// This tells Railway "I am alive" within 1 second of booting.
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Flow Radar is Active ✅');
});

// Use Railway's preferred port
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Health Check Server online on port ${PORT}`);
    
    // 2. NOW LOAD THE ENGINE (After server is verified)
    const engine = require('./engine');
    try {
        engine.startScanner();
        engine.startRadar();
        engine.startListener();
        
        engine.sendTelegram("🟢 *Flow Radar Online*\nSystem stabilized and monitoring.");
    } catch (err) {
        console.error("❌ Startup Error:", err.message);
    }
});
