module.exports = {
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    
    SCAN_INTERVAL_SEC: Number(process.env.SCAN_INTERVAL_SEC) || 60,
    ALERT_COOLDOWN_MIN: Number(process.env.ALERT_COOLDOWN_MIN) || 25,
    HEARTBEAT_HOURS: Number(process.env.HEARTBEAT_HOURS) || 3,
    
    MIN_VOLUME_USDT: 1000000, 
    WHALE_THRESHOLD_USD: Number(process.env.WHALE_THRESHOLD_USD) || 50000,

    // --- TEST SETTINGS ---
    DEBUG_MODE: process.env.DEBUG_MODE === 'true' || true, // Set to true to see trade flow in logs
    LOG_THROTTLE_MS: 5000 // Only log a sample every 5 seconds to keep logs clean
};
