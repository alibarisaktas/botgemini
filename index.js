const http = require('http');
const engine = require('./engine');
const config = require('./config');

console.log("🚀 System Booting...");

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Flow Radar is Active ✅');
});

server.listen(config.PORT, () => {
    console.log(`✅ Health Check Server listening on port ${config.PORT}`);
});

// Start All Modules
engine.startScanner();
engine.startRadar();
engine.startListener(); // Starts listening for /check commands

engine.sendTelegram("🟢 *Flow Radar Online*\nLogic: Multi-Window Analysis\nStablecoins: Filtered 🛡️\nThreshold: $100k+ High Conviction");
