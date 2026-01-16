const WebSocket = require('ws');
const config = require('./config');

let tradeStore = {}; 
let hotlist = [];
let collectorWs = null;
let stateMemory = {}; 
let lastUpdateId = 0; 
let collectorTimeout = null; // Used for Debouncing

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
    const trades = tradeStore[s] || [];
    if (trades.length < 5) return null;

    const fast = trades.filter(t => t.t > now - (10 * 60000));
    const base = trades.filter(t => t.t > now - (180 * 60000));

    const fBuy = fast.filter(t => t.side === 'BUY').reduce((a, b) => a + b.usd, 0);
    const fSell = fast.filter(t => t.side === 'SELL').reduce((a, b) => a + b.usd, 0);
    const totalFast = fBuy + fSell;
    
    const fBias = totalFast > 0 ? (fBuy / totalFast) * 100 : 50;
    const fActivity = fast.length / 10;
    const bActivity = base.length / 180;
    const actMult = bActivity > 0 ? (fActivity / bActivity) : 1;

    let label = "⚖️ MIXED TAPE";
    let note = "⚪ Mixed tape. Wait for confirmation.";

    if (base.length < 50) {
        note = "🟡 Baseline warming up. Early data.";
    } else if (actMult >= 2.0 && fBias >= 65 && totalFast > 100000) {
        label = "🚀 MOMENTUM BUILDING";
        note = "🔥 Momentum building. Watch breakouts.";
    } else if (fBias <= 35 && actMult >= 1.5 && totalFast > 100000) {
        label = "⚠️ DISTRIBUTION";
        note = "🚨 Distribution pressure. Avoid chasing.";
    } else if (fBias > 58 && actMult < 1.5 && totalFast > 50000) {
        label = "📈 STEADY ACCUMULATION";
        note = "💎 Accumulation pressure. Dips likely bought.";
    }

    return { label, note, fBias, actMult, totalFast };
}

// --- STAGE A: FILTERING (WITH DEBOUNCE) ---
function startScanner() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const filtered = tickers
                .filter(t => t.s.endsWith('USDT'))
                .filter(t => !['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'DAIUSDT', 'EURUSDT', 'GBPUSDT'].includes(t.s))
                .filter(t => (parseFloat(t.c) * parseFloat(t.v)) > config.MIN_VOLUME_USDT)
                .map(t => t.s);

            if (JSON.stringify(filtered) !== JSON.stringify(hotlist)) {
                hotlist = filtered;
                console.log(`🔥 Scanner: Watchlist updated (${hotlist.length} pairs).`);
                
                // DEBOUNCE FIX: Wait 2 seconds for market calm before restarting collector
                clearTimeout(collectorTimeout);
                collectorTimeout = setTimeout(() => {
                    startCollector();
                }, 2000);
            }
        } catch (e) { console.error("Scanner Error:", e.message); }
    });
}

// --- STAGE B: COLLECTING (SAFE) ---
function startCollector() {
    if (collectorWs) {
        try {
            if (collectorWs.readyState !== WebSocket.CLOSED) {
                collectorWs.terminate();
            }
        } catch (e) { console.log("⚠️ Collector cleanup performed."); }
    }
    
    if (hotlist.length === 0) return;
    
    const streams = hotlist.slice(0, 50).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    collectorWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    
    collectorWs.on('error', (err) => console.error("Collector WS Log:", err.message));

    collectorWs.on('message', (msg) => {
        try {
            const parsed = JSON.parse(msg);
            const data = parsed.data || parsed;
            if (!data || !data.s) return;
            
            if (!tradeStore[data.s]) tradeStore[data.s] = [];
            tradeStore[data.s].push({ 
                usd: parseFloat(data.p) * parseFloat(data.q), 
                side: data.m ? 'SELL' : 'BUY', 
                t: Date.now() 
            });

            const cutoff = Date.now() - (3 * 3600000);
            if (tradeStore[data.s].length > 100) {
                tradeStore[data.s] = tradeStore[data.s].filter(t => t.t > cutoff);
            }
        } catch (e) {}
    });
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
            const cooldownDone = now - stateMemory[s].lastAlert > (config.ALERT_COOLDOWN_MIN || 25) * 60000;

            if (isNewState || cooldownDone) {
                sendTelegram(
                    `*${s}* | ${stats.label}\n` +
                    `💰 10m Vol: $${(stats.totalFast/1000).toFixed(1)}k\n` +
                    `📊 Buy Bias: ${stats.fBias.toFixed(1)}%\n` +
                    `⚡ Activity: ${stats.actMult.toFixed(1)}x normal\n` +
                    `📝 _${stats.note}_`
                );
                stateMemory[s].lastLabel = stats.label;
                stateMemory[s].lastAlert = now;
            }
        });
    }, 30000);
}

// --- LISTENER: COMMANDS ---
function startListener() {
    console.log("📥 Telegram Listener Active...");
    setInterval(async () => {
        try {
            const res = await fetch(`https://api.telegram.org/bot${config.TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
            const data = await res.json();

            if (data.ok && data.result.length > 0) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id; 

                    const msg = update.message || update.channel_post;
                    if (!msg || !msg.text) continue;
                    const text = msg.text.trim();

                    if (text === '/status') {
                        const memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
                        sendTelegram(
                            `🤖 *Bot Health Status*\n` +
                            `⏱ Uptime: ${Math.floor(process.uptime() / 60)} mins\n` +
                            `📁 Tracked Coins: ${Object.keys(tradeStore).length}\n` +
                            `🧠 Memory: ${memoryMB} MB\n` +
                            `🔥 Scanner: ${hotlist.length} pairs`
                        );
                    }

                    if (text.startsWith('/check')) {
                        let symbol = text.split(' ')[1]?.toUpperCase();
                        if (!symbol) continue;
                        if (!symbol.endsWith('USDT')) symbol += 'USDT';
                        const stats = analyzeSymbol(symbol);
                        if (!stats) {
                            sendTelegram(`❌ No data for ${symbol}. (Warming up...)`);
                            continue;
                        }
                        sendTelegram(`🔍 *Manual Check: ${symbol}*\nState: ${stats.label}\nBias: ${stats.fBias.toFixed(1)}% | Activity: ${stats.actMult.toFixed(1)}x`);
                    }
                }
            }
        } catch (e) { console.error("Listener Error:", e.message); }
    }, 5000);
}

module.exports = { startScanner, startRadar, startListener };
