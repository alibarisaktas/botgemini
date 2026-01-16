const WebSocket = require('ws');
const config = require('./config');

let tradeStore = {};
let hotlist = [];
let collectorWs = null;

// Helper: Telegram using Node 22 native fetch
async function sendTelegram(text) {
    if (!config.TG_TOKEN || !config.TG_CHAT_ID) {
        console.error("❌ TG Credentials missing in Railway Variables!");
        return;
    }
    try {
        await fetch(`https://api.telegram.org/bot${config.TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: config.TG_CHAT_ID, 
                text: text, 
                parse_mode: 'Markdown' 
            })
        });
    } catch (e) { console.error("TG Error:", e.message); }
}

// Stage A: Scanner
function startScanner() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const filtered = tickers
            .filter(t => t.s.endsWith('USDT') && !['BTCUSDT', 'ETHUSDT', 'BNBUSDT'].includes(t.s))
            .filter(t => (parseFloat(t.c) * parseFloat(t.v)) > config.MIN_VOLUME_USDT)
            .map(t => t.s);

        if (JSON.stringify(filtered) !== JSON.stringify(hotlist)) {
            hotlist = filtered;
            console.log(`🔥 Hotlist Updated: ${hotlist.length} symbols active.`);
            startCollector();
        }
    });
}

// Stage B: Collector
function startCollector() {
    if (collectorWs) collectorWs.terminate();
    if (hotlist.length === 0) return;
    
    // Limits streams to 50 for stability
    const streams = hotlist.slice(0, 50).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    collectorWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    
    collectorWs.on('message', (msg) => {
        const { data } = JSON.parse(msg);
        if (!tradeStore[data.s]) tradeStore[data.s] = { b: 0, s: 0, p: 0 };
        const usd = parseFloat(data.p) * parseFloat(data.q);
        
        // m: true means buyer was maker -> Sell aggression
        if (data.m) tradeStore[data.s].s += usd; 
        else tradeStore[data.s].b += usd;
        
        tradeStore[data.s].p = data.p;
    });
}

// Flow Radar Engine
const cooldowns = {};
function startRadar() {
    setInterval(() => {
        hotlist.forEach(s => {
            const d = tradeStore[s];
            if (!d || (d.b + d.s) === 0) return;
            
            const total = d.b + d.s;
            const bias = (d.b / total) * 100;
            const net = d.b - d.s;

            if (net > config.WHALE_THRESHOLD_USD && bias > 65) {
                const now = Date.now();
                if (!cooldowns[s] || now - cooldowns[s] > config.ALERT_COOLDOWN_MIN * 60000) {
                    sendTelegram(`🚀 *WHALE INFLOW: ${s}*\n💰 Net: +$${(net/1000).toFixed(0)}k\n📊 Bias: ${bias.toFixed(1)}%\n💸 Price: ${d.p}`);
                    cooldowns[s] = now;
                }
            }
            // Decay logic to reset flow over time
            d.b *= 0.7; d.s *= 0.7; 
        });
    }, config.SCAN_INTERVAL_SEC * 1000);
}

module.exports = { startScanner, startRadar, sendTelegram, getHotlist: () => hotlist };
