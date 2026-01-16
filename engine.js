const WebSocket = require('ws');
const config = require('./config');

let tradeStore = {}; // Now stores: { 'SOLUSDT': [{p, q, usd, side, t}, ...] }
let hotlist = [];
let collectorWs = null;
let stateMemory = {}; // Tracks: { 'SOLUSDT': { lastLabel: '', lastAlert: 0 } }

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

// Stage A - Universe Filter (Updated to exclude stablecoins)
function startScanner() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const filtered = tickers
            .filter(t => t.s.endsWith('USDT')) 
            // Exclude Majors and Stables
            .filter(t => !['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'DAIUSDT'].includes(t.s))
            .filter(t => (parseFloat(t.c) * parseFloat(t.v)) > config.MIN_VOLUME_USDT)
            .map(t => t.s);

        if (JSON.stringify(filtered) !== JSON.stringify(hotlist)) {
            hotlist = filtered;
            console.log(`🔥 Stage A: Hotlist updated (${hotlist.length} symbols).`);
            startCollector();
        }
    });
}

// Stage B - Aggressive Flow Capture
function startCollector() {
    if (collectorWs) collectorWs.terminate();
    if (hotlist.length === 0) return;
    
    const streams = hotlist.slice(0, 50).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    collectorWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    
    collectorWs.on('message', (msg) => {
        const { data } = JSON.parse(msg);
        if (!tradeStore[data.s]) tradeStore[data.s] = [];
        
        const usd = parseFloat(data.p) * parseFloat(data.q);
        const side = data.m ? 'SELL' : 'BUY'; // m=true means maker was buyer -> aggressive SELL
        
        tradeStore[data.s].push({ usd, side, t: Date.now(), p: data.p });

        // Clean memory: remove trades older than 3 hours (Baseline window)
        const threeHoursAgo = Date.now() - (3 * 3600000);
        if (tradeStore[data.s].length % 100 === 0) { // Clean every 100 trades
            tradeStore[data.s] = tradeStore[data.s].filter(tr => tr.t > threeHoursAgo);
        }
    });
}

// Flow Radar - 3 Window Analysis
function startRadar() {
    setInterval(() => {
        const now = Date.now();
        hotlist.forEach(s => {
            const trades = tradeStore[s] || [];
            if (trades.length < 10) return;

            // 1. Windows
            const fast = trades.filter(t => t.t > now - (10 * 60000));   // 10m
            const steady = trades.filter(t => t.t > now - (60 * 60000)); // 1h
            const base = trades.filter(t => t.t > now - (180 * 60000)); // 3h

            // 2. Metrics (Fast Window)
            const fBuy = fast.filter(t => t.side === 'BUY').reduce((a, b) => a + b.usd, 0);
            const fSell = fast.filter(t => t.side === 'SELL').reduce((a, b) => a + b.usd, 0);
            const fBias = (fBuy / (fBuy + fSell)) * 100;
            const fActivity = fast.length / 10; // Trades per minute

            // 3. Metrics (Baseline)
            const bActivity = base.length / 180;
            const actMult = bActivity > 0 ? (fActivity / bActivity) : 1;

            // 4. Classification & Notes
            let label = "";
            let note = "";
            
            if (base.length < 100) {
                note = "🟡 Baseline warming up. Early data.";
            } else if (actMult >= 2.0 && fBias >= 65) {
                label = "🚀 MOMENTUM BUILDING";
                note = "🔥 Momentum building. Watch breakouts.";
            } else if (fBias <= 35 && actMult >= 1.5) {
                label = "⚠️ DISTRIBUTION";
                note = "🚨 Distribution pressure. Avoid chasing.";
            } else if (fBias > 58 && actMult < 1.5) {
                label = "📈 STEADY ACCUMULATION";
                note = "💎 Accumulation pressure. Dips likely bought.";
            } else {
                label = "⚖️ MIXED TAPE";
                note = "⚪ Mixed tape. Wait for confirmation.";
            }

            // 5. State-Driven Alerts (Only alert on meaningful changes)
            if (!stateMemory[s]) stateMemory[s] = { lastLabel: '', lastAlert: 0 };
            
            const isNewSignal = label !== stateMemory[s].lastLabel;
            const cooldownPassed = now - stateMemory[s].lastAlert > config.ALERT_COOLDOWN_MIN * 60000;

            if (label !== "⚖️ MIXED TAPE" && (isNewSignal || cooldownPassed)) {
                sendTelegram(
                    `*${s}* | ${label}\n` +
                    `💰 Fast Vol: $${((fBuy + fSell)/1000).toFixed(1)}k\n` +
                    `📊 Buy Bias: ${fBias.toFixed(1)}%\n` +
                    `⚡ Activity: ${actMult.toFixed(1)}x normal\n` +
                    `📝 _${note}_`
                );
                stateMemory[s].lastLabel = label;
                stateMemory[s].lastAlert = now;
            }
        });
    }, 30000); // Scan every 30 seconds
}

module.exports = { startScanner, startRadar, sendTelegram, getHotlist: () => hotlist };
