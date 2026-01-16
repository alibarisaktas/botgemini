const engine = require('./engine');
const config = require('./config');

console.log("🚀 Starting Flow Radar...");

engine.startScanner();
engine.startRadar();

// Heartbeat
setInterval(() => {
    engine.sendTelegram(`🟡 *Flow Radar Heartbeat*\nPairs: ${engine.getHotlist().length}\nStatus: Running ✅`);
}, config.HEARTBEAT_HOURS * 3600000);
