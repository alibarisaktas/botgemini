const http = require('http');
const config = require('./config');

// 1. START SERVER IMMEDIATELY (Railway sees this and marks "Success")
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Flow Radar is Active ✅');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Health Check Server online on port ${PORT}`);
    
    // 2. NOW LOAD AND START THE ENGINE
    const engine = require('./engine');
    try {
        engine.startScanner();
        engine.startRadar();
        engine.startListener();
        
        engine.sendTelegram("🟢 *Flow Radar Online*\nSystem stabilized.");
    } catch (err) {
        console.error("❌ Startup Error:", err.message);
    }
});
