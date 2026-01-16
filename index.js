const engine = require('./engine');
const config = require('./config');

console.log("🚀 System Booting...");

engine.startScanner();
engine.startRadar();

engine.sendTelegram("🟢 *Flow Radar Online*\nVerifying Stage A & B connection...");

setInterval(() => {
    engine.sendTelegram(`🟡 *Heartbeat*\nMonitoring: ${engine.getHotlist().length} pairs\nStatus: Running ✅`);
}, config.HEARTBEAT_HOURS * 3600000);
