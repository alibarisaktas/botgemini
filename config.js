/**
 * Configuration using Railway Environment Variables.
 * Accessed via process.env.KEY_NAME
 */
module.exports = {
    // These will be pulled from your Railway "Variables" tab
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    
    // Core Engine Settings (can also be variables if you want to tweak from UI)
    SCAN_INTERVAL_SEC: Number(process.env.SCAN_INTERVAL_SEC) || 60,
    ALERT_COOLDOWN_MIN: Number(process.env.ALERT_COOLDOWN_MIN) || 25,
    HEARTBEAT_HOURS: Number(process.env.HEARTBEAT_HOURS) || 3,
    
    // Thresholds
    MIN_VOLUME_USDT: 1000000, 
    WHALE_THRESHOLD_USD: Number(process.env.WHALE_THRESHOLD_USD) || 50000 
};
