const WebSocket = require('ws');
const config = require('./config');

let tradeStore = {}; 
let hotlist = [];
let collectorWs = null;
let stateMemory = {}; 
let lastUpdateId = 0; 
let startTime = Date.now();

// --- TELEGRAM OUTBOUND ---
async function sendTelegram(text) {
    if (!config.TG_TOKEN || !config.TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${config.TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: config.TG_CHAT_ID, text, parse_mode: 'Markdown' })
        });
    } catch (e) { console.error("TG Send Error:", e.message); }
}

// --- LOGIC: ANALYSIS ENGINE ---
function analyzeSymbol(s) {
    const now = Date.now();
    const data = tradeStore[s];
    if (!data || data.trades.length < 5) return null;

    const trades = data.trades;
    const fast = trades.filter(t => t.t > now - 600000); // 10m
    const base = trades.filter(t => t.t > now - 10800000); // 3h
    const hourAgo = trades.filter(t => t.t > now - 3600000); // 1h

    // --- Volume & Bias ---
    const fBuy = fast.filter(t => t.side === 'BUY').reduce((a, b) => a + b.usd, 0);
    const fSell = fast.filter(t => t.side === 'SELL').reduce((a, b) => a + b.usd, 0);
    const totalFast = fBuy + fSell;
    const fBias = totalFast > 0 ? (fBuy / totalFast) * 100 : 50;

    // --- Activity ---
    const fActivity = fast.length / 10;
    const bActivity = base.length / 180;
    const actMult = bActivity > 0 ? (fActivity / bActivity) : 1;

    // --- 1H Price Change ---
    let change1h = 0;
    if (hourAgo.length > 0) {
        const oldPrice = hourAgo[0].p; // Price at the start of the 1h window
        const currentPrice = data.lastPrice;
        change1h = ((currentPrice - oldPrice) / oldPrice) * 100;
    }

    let label = "⚖️ MIXED TAPE";
    if (actMult >= 2.0 && fBias >= 65 && totalFast > 100000) label = "🚀 MOMENTUM BUILDING";
    else if (fBias <= 35 && actMult >= 1.5 && totalFast > 100000) label = "⚠️ DISTRIBUTION";
    else if (fBias > 58 && actMult < 1.5 && totalFast > 50000) label = "📈 STEADY ACCUMULATION";

    return { label, fBias, actMult, totalFast, change1h, currentPrice: data.lastPrice };
}

// --- STAGE A: SCANNER ---
function startScanner() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const filtered = tickers
                .filter(t => t.s.endsWith('USDT'))
                .filter(t => !['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT'].includes(t.s))
                .filter(t => (parseFloat(t.c) * parseFloat(t.v)) > 1000000)
                .map(t => t.s);

            if (JSON.stringify(filtered) !== JSON.stringify(hotlist)) {
                hotlist = filtered;
                console.log(`🔥 Scanner: Watchlist size ${hotlist.length}`);
                startCollector();
            }
        } catch (e) { console.error("Scanner Error:", e.message); }
    });
}

// --- STAGE B: COLLECTOR ---
function startCollector() {
    if (collectorWs) {
        try { collectorWs.terminate(); } catch (e) {}
    }
    
    if (hotlist.length === 0) return;
    
    const streams = hotlist.slice(0, 40).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    collectorWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    
    collectorWs.on('message', (msg) => {
        try {
            const parsed = JSON.parse(msg);
            const data = parsed.data || parsed;
            if (!data || !data.s) return;
            
            if (!tradeStore[data.s]) {
                tradeStore[data.s] = { trades: [], lastPrice: 0 };
            }

            const price = parseFloat(data.p);
            tradeStore[data.s].lastPrice = price;
            tradeStore[data.s].trades.push({ 
                usd: price * parseFloat(data.q), 
                p: price, // Store price at time of trade
                side: data.m ? 'SELL' : 'BUY', 
                t: Date.now() 
            });

            // Memory Management: Keep 3 hours of data
            const cutoff = Date.now() - 10800000;
            if (tradeStore[data.s].trades.length > 500) {
                tradeStore[data.s].trades = tradeStore[data.s].trades.filter(t => t.t > cutoff);
            }
        } catch (e) {}
    });

    collectorWs.on('close', () => setTimeout(startCollector, 5000));
}

// --- RADAR: ALERTS ---
function startRadar() {
    setInterval(() => {
        hotlist.forEach(s => {
            const stats = analyzeSymbol(s);
            if (!stats || stats.label === "⚖️ MIXED TAPE") return;

            const now = Date.now();
            if (!stateMemory[s]) stateMemory[s] = { lastLabel: '', lastAlert: 0 };

            const isNewState = stats.label !== stateMemory[s].lastLabel;
            const cooldownDone = now - stateMemory[s].lastAlert > 1500000;

            if (isNewState || cooldownDone) {
                const priceStr = stats.currentPrice > 1 ? stats.currentPrice.toFixed(2) : stats.currentPrice.toFixed(6);
                const changeStr = (stats.change1h >= 0 ? "+" : "") + stats.change1h.toFixed(2) + "%";
                
                sendTelegram(
                    `*${s}* | ${stats.label}\n` +
                    `💵 Price: $${priceStr} (${changeStr} 1h)\n` +
                    `💰 10m Vol: $${(stats.totalFast/1000).toFixed(1)}k\n` +
                    `📊 Bias: ${stats.fBias.toFixed(1)}%\n` +
                    `⚡ Activity: ${stats.actMult.toFixed(1)}x`
                );
                
                stateMemory[s].lastLabel = stats.label;
                stateMemory[s].lastAlert = now;
            }
        });
    }, 30000);
}

// --- LISTENER: COMMANDS ---
function startListener() {
    setInterval(async () => {
        try {
            const res = await fetch(`https://api.telegram.org/bot${config.TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
            const data = await res.json();
            if (data.ok && data.result.length > 0) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id; 
                    const msg = update.message || update.channel_post;
                    if (msg && msg.text === '/status') {
                        const tracked = Object.keys(tradeStore).length;
                        const baseline = Math.min(100, ((Date.now() - startTime) / 10800000 * 100)).toFixed(0);
                        sendTelegram(`🤖 *Status Report*\n⏱ Uptime: ${Math.floor(process.uptime() / 60)}m\n📊 Baseline: ${baseline}%\n📁 Tracked: ${tracked}`);
                    }
                }
            }
        } catch (e) {}
    }, 5000);
}

module.exports = { startScanner, startRadar, startListener, sendTelegram };
