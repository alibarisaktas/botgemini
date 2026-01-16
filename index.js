const engine = require('./engine');
const config = require('./config');

console.log("🚀 System Booting...");

// Start core processes
engine.startScanner();
engine.startRadar();

// Send initial startup signal
engine.sendTelegram("🟢 *Flow Radar Online*\nSystem has successfully connected to Binance.");

// Heartbeat Loop
setInterval(() => {
    engine.sendTelegram(`🟡 *Heartbeat*\nMonitoring: ${engine.getHotlist().length} pairs\nStatus: Running ✅`);
}, config.HEARTBEAT_HOURS * 3600000);
