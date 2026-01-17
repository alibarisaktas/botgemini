const WebSocket = require('ws');
const config = require('./config');
const fs = require('fs');

// --- PERSISTENCE CONFIG ---
const MEMORY_FILE = '/app/data/trade_memory.json';

let tradeStore = {}; 
let hotlist = [];
let collectorWs = null;
let stateMemory = {}; 
let lastUpdateId = 0; 
let startTime = Date.now();

// --- PERSISTENCE LOGIC ---
function saveMemory() {
    try {
        const data = JSON.stringify({ tradeStore, startTime, lastUpdateId });
        // Use a temp file for safer writing if you prefer, but this is fine for now
        fs.writeFileSync(MEMORY_FILE, data);
        console.log("💾 Memory saved to persistent volume.");
    } catch (e) { console.error("💾 Save Error:", e.message); }
}

function loadMemory() {
    if (fs.existsSync(MEMORY_FILE)) {
        try {
            const raw = fs.readFileSync(MEMORY_FILE);
            const parsed = JSON.parse(raw);
            tradeStore = parsed.tradeStore || {};
            startTime = parsed.startTime || Date.now();
            lastUpdateId = parsed.lastUpdateId || 0;
            console.log("📁 Persistence: Data restored from volume.");
        } catch (e) { console.log("📁 Persistence: Memory file empty or corrupt."); }
    }
}

setInterval(saveMemory, 300000); // Save every 5 mins

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
    if (!data || !data.trades || data.trades.length < 5) return null;

    const trades = data.trades;
    const fast = trades.filter(t => t.t > now - 600000);
    const base = trades.filter(t => t.t > now - 10800000);
    const hourAgo = trades.filter(t => t.t > now - 3600000);

    const fBuy = fast.filter(t => t.side === 'BUY').reduce((a, b) => a + b.usd, 0);
    const fSell = fast.filter(t => t.side === 'SELL').reduce((a, b) => a + b.usd, 0);
    const totalFast = fBuy + fSell;
    const fBias = totalFast > 0 ? (fBuy / totalFast) * 100 : 50;

    const fActivity = fast.length / 10;
    const bActivity = base.length / 180;
    const actMult = bActivity > 0 ? (fActivity / bActivity) : 1;

    let change1h = 0;
    if (hourAgo.length > 0 && hourAgo[0]) {
        const oldPrice = hourAgo[0].p; 
        const currentPrice = data.lastPrice;
        if (oldPrice > 0) change1h = ((currentPrice - oldPrice) / oldPrice) * 100;
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
                .filter(t => t.s.endsWith('USDT') && !['BTCUSDT','ETHUSDT','BNBUSDT','USDCUSDT'].includes(t.s) && (parseFloat(t.c) * parseFloat(t.v)) > 1000000)
                .map(t => t.s);

            if (JSON.stringify(filtered) !== JSON.stringify(hotlist)) {
                hotlist = filtered;
                
                // --- MEMORY CLEANER ---
                Object.keys(tradeStore).forEach(symbol => {
                    if (!hotlist.includes(symbol)) delete tradeStore[symbol];
                });

                console.log(`🔥 Scanner: Watchlist size ${hotlist.length}. Memory cleaned.`);
                startCollector();
            }
        } catch (e) {}
    });
    ws.on('error', (e) => console.log("Scanner WS Error:", e.message));
    ws.on('close', () => setTimeout(startScanner, 5000));
}

// --- STAGE B: COLLECTOR (Crash-Proof Fix) ---
function startCollector() {
    if (collectorWs) {
        try {
            // Remove all listeners first to prevent a dying socket from triggering an error event
            collectorWs.removeAllListeners();
            
            // Only terminate if not already closed
            if (collectorWs.readyState !== WebSocket.CLOSED && collectorWs.readyState !== WebSocket.CLOSING) {
                collectorWs.terminate();
            }
        } catch (e) { console.log("⚠️ Collector cleanup race handled."); }
        collectorWs = null;
    }
    
    if (hotlist.length === 0) return;
    
    const streams = hotlist.slice(0, 40).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    collectorWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    
    // --- THE CRITICAL FIX: Explicit error listener on the instance ---
    collectorWs.on('error', (err) => {
        // Ignore the "closed before established" error specifically
        if (err.message && err.message.includes('closed before')) return;
        console.error("Collector Instance Error:", err.message);
    });

    collectorWs.on('message', (msg) => {
        try {
            const parsed = JSON.parse(msg);
            const data = parsed.data || parsed;
            if (!data || !data.s) return;
            
            if (!tradeStore[data.s]) tradeStore[data.s] = { trades: [], lastPrice: 0 };
            const p = parseFloat(data.p);
            tradeStore[data.s].lastPrice = p;
            tradeStore[data.s].trades.push({ usd: p * parseFloat(data.q), p: p, side: data.m ? 'SELL' : 'BUY', t: Date.now() });
            
            const cutoff = Date.now() - 10800000;
            if (tradeStore[data.s].trades.length > 500) {
                tradeStore[data.s].trades = tradeStore[data.s].trades.filter(t => t.t > cutoff);
            }
        } catch (e) {}
    });

    collectorWs.on('close', () => {
        if (collectorWs) setTimeout(startCollector, 5000);
    });
}

function startRadar() {
    setInterval(() => {
        hotlist.forEach(s => {
            const stats = analyzeSymbol(s);
            if (!stats || stats.label === "⚖️ MIXED TAPE") return;
            const now = Date.now();
            if (!stateMemory[s]) stateMemory[s] = { lastLabel: '', lastAlert: 0 };
            if (stats.label !== stateMemory[s].lastLabel || now - stateMemory[s].lastAlert > 1500000) {
                const pStr = stats.currentPrice > 1 ? stats.currentPrice.toFixed(2) : stats.currentPrice.toFixed(6);
                const cStr = (stats.change1h >= 0 ? "+" : "") + stats.change1h.toFixed(2) + "%";
                sendTelegram(`*${s}* | ${stats.label}\n💵 Price: $${pStr} (${cStr} 1h)\n💰 10m Vol: $${(stats.totalFast/1000).toFixed(1)}k\n📊 Bias: ${stats.fBias.toFixed(1)}%\n⚡ Activity: ${stats.actMult.toFixed(1)}x`);
                stateMemory[s].lastLabel = stats.label; stateMemory[s].lastAlert = now;
            }
        });
    }, 30000);
}

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
                        sendTelegram(`🤖 *Status Report*\n⏱ Uptime: ${Math.floor(process.uptime() / 60)}m\n📊 Baseline: ${baseline}%\n📁 Tracked: ${tracked}\n🔥 Scanner: ${hotlist.length} pairs`);
                    }
                    if (msg && msg.text.startsWith('/check')) {
                        let sym = msg.text.split(' ')[1]?.toUpperCase();
                        if (!sym) continue;
                        if (!sym.endsWith('USDT')) sym += 'USDT';
                        const stats = analyzeSymbol(sym);
                        if (!stats) { sendTelegram(`❌ No data for ${sym}.`); continue; }
                        const pStr = stats.currentPrice > 1 ? stats.currentPrice.toFixed(2) : stats.currentPrice.toFixed(6);
                        const cStr = (stats.change1h >= 0 ? "+" : "") + stats.change1h.toFixed(2) + "%";
                        sendTelegram(`🔍 *Check: ${sym}*\n${stats.label}\n💵 Price: $${pStr} (${cStr} 1h)\n📊 Bias: ${stats.fBias.toFixed(1)}%\n⚡ Activity: ${stats.actMult.toFixed(1)}x`);
                    }
                }
            }
        } catch (e) {}
    }, 5000);
}

module.exports = { startScanner, startRadar, startListener, sendTelegram, loadMemory };
