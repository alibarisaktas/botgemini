const WebSocket = require('ws');
const config = require('./config');

let tradeStore = {};
let hotlist = [];
let collectorWs = null;
let lastLogTime = 0;

async function sendTelegram(text) {
    if (!config.TG_TOKEN || !config.TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${config.TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: config.TG_CHAT_ID, text, parse_mode: 'Markdown' })
        });
    } catch (e) { console.error("TG Error:", e.message); }
}

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
            console.log(`🔥 Stage A: Hotlist refreshed. ${hotlist.length} symbols.`);
            startCollector();
        }
    });
}

function startCollector() {
    if (collectorWs) collectorWs.terminate();
    if (hotlist.length === 0) return;
    
    const streams = hotlist.slice(0, 50).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    collectorWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    
    collectorWs.on('message', (msg) => {
        const { data } = JSON.parse(msg);
        if (!tradeStore[data.s]) tradeStore[data.s] = { b: 0, s: 0, p: 0 };
        const usd = parseFloat(data.p) * parseFloat(data.q);
        
        if (data.m) tradeStore[data.s].s += usd; 
        else tradeStore[data.s].b += usd;
        tradeStore[data.s].p = data.p;

        // --- STAGE B VERIFICATION LOG ---
        const now = Date.now();
        if (config.DEBUG_MODE && (now - lastLogTime > config.LOG_THROTTLE_MS)) {
            console.log(`✅ Stage B Active: Catching trades for ${data.s} ($${usd.toFixed(0)})`);
            lastLogTime = now;
        }
    });

    collectorWs.on('open', () => console.log("📡 Stage B: WebSocket Connected to Binance Streams"));
}

function startRadar() {
    setInterval(() => {
        hotlist.forEach(s => {
            const d = tradeStore[s];
            if (!d || (d.b + d.s) === 0) return;
            const bias = (d.b / (d.b + d.s)) * 100;
            const net = d.b - d.s;

            if (net > config.WHALE_THRESHOLD_USD && bias > 65) {
                const now = Date.now();
                if (!cooldowns[s] || now - cooldowns[s] > config.ALERT_COOLDOWN_MIN * 60000) {
                    sendTelegram(`🚀 *WHALE INFLOW: ${s}*\n💰 Net: +$${(net/1000).toFixed(0)}k\n📊 Bias: ${bias.toFixed(1)}%`);
                    cooldowns[s] = now;
                }
            }
            d.b *= 0.7; d.s *= 0.7; 
        });
    }, config.SCAN_INTERVAL_SEC * 1000);
}

module.exports = { startScanner, startRadar, sendTelegram, getHotlist: () => hotlist };
