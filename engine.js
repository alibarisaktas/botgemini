const WebSocket = require('ws');
const config = require('./config');
const fs = require('fs');
const fetch = require('node-fetch');

const MEMORY_FILE = '/app/data/trade_memory.json';
let tradeStore = {}; 
let hotlist = [];
let collectorWs = null;
let lastUpdateId = 0; 
let startTime = Date.now();
let isConnecting = false;

let stateMemory = {
    globalThreshold: 0.3, 
    symbolData: {} 
};

// --- PERSISTENCE ---
function saveMemory() {
    try {
        const data = JSON.stringify({ 
            tradeStore, 
            startTime, 
            lastUpdateId, 
            globalThreshold: stateMemory.globalThreshold,
            symbolData: stateMemory.symbolData 
        });
        fs.writeFileSync(MEMORY_FILE, data);
        console.log("💾 Full system state persisted.");
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
            stateMemory.globalThreshold = parsed.globalThreshold || 0.3;
            stateMemory.symbolData = parsed.symbolData || {}; 
            console.log(`📁 State restored. Threshold: ${stateMemory.globalThreshold}%`);
        } catch (e) { console.log("📁 Memory corrupted or empty."); }
    }
}
setInterval(saveMemory, 300000);

// --- GLOBAL PRUNING ---
setInterval(() => {
    const cutoff = Date.now() - 10800000; // 3 hours
    let prunedCount = 0;
    Object.keys(tradeStore).forEach(s => {
        const initialCount = tradeStore[s].trades.length;
        tradeStore[s].trades = tradeStore[s].trades.filter(t => t.t > cutoff);
        if (initialCount !== tradeStore[s].trades.length) prunedCount++;
    });
    if (prunedCount > 0) console.log(`🧹 Periodic Pruning: Cleaned trades for ${prunedCount} symbols.`);
}, 300000);

// --- TELEGRAM ---
async function sendTelegram(text) {
    if (!config.TG_TOKEN || !config.TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${config.TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: config.TG_CHAT_ID, text, parse_mode: 'Markdown' })
        });
    } catch (e) {}
}

// --- ANALYSIS UTILS ---
function calculatePriceChange(trades, windowMs) {
    const now = Date.now();
    const window = trades.filter(t => t.t > now - windowMs);
    if (window.length < 2) return 0;
    const oldPrice = window[0].p;
    const newPrice = window[window.length - 1].p;
    return ((newPrice - oldPrice) / oldPrice) * 100;
}

function analyzeSymbol(s) {
    const now = Date.now();
    const data = tradeStore[s];
    if (!data || !data.trades || data.trades.length < 10) return null;

    const trades = data.trades;
    const fastWin = 600000;   // 10 min
    const baseWin = 10800000; // 3 hours

    const fast = trades.filter(t => t.t > now - fastWin); 
    const base = trades.filter(t => t.t > now - baseWin); 

    const fBuy = fast.filter(t => t.side === 'BUY').reduce((a, b) => a + b.usd, 0);
    const fSell = fast.filter(t => t.side === 'SELL').reduce((a, b) => a + b.usd, 0);
    const totalFast = fBuy + fSell;
    const fBias = totalFast > 0 ? (fBuy / totalFast) * 100 : 50;

    // --- FIX: Dynamic Unit Math (Eliminates the 18.0x plateau) ---
    const timeSinceStart = (now - startTime) / 60000; 
    const dynamicBaseMins = Math.min(180, Math.max(1, timeSinceStart)); 

    const fastTpm = fast.length / 10; 
    const baseTpm = base.length / dynamicBaseMins; 
    const actMult = baseTpm > 0 ? (fastTpm / baseTpm) : 1;
    // -------------------------------------------------------------

    const change1h = calculatePriceChange(trades, 3600000);
    const change5m = calculatePriceChange(trades, 300000);
    const threshold = stateMemory.globalThreshold;

    let label = "⚖️ MIXED TAPE";
    if (actMult >= 2.0 && fBias >= 65 && totalFast > config.WHALE_THRESHOLD_USD) {
        if (change5m > threshold || change1h > 0.5) label = "🚀 MOMENTUM BUILDING";
        else label = "🔄 ACCUMULATION (Price Lagging)";
    } else if (fBias <= 35 && actMult >= 1.5 && totalFast > config.WHALE_THRESHOLD_USD) {
        if (change5m < -threshold || change1h < -0.5) label = "⚠️ DISTRIBUTION";
        else label = "🔄 DISTRIBUTION (Price Resilient)";
    }

    return { label, fBias, actMult, totalFast, change1h, change5m, currentPrice: data.lastPrice, threshold };
}

// --- SCANNER & COLLECTOR ---
function startScanner() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
    ws.on('open', () => console.log("🔍 Scanner Active..."));
    ws.on('message', (data) => {
        try {
            const tickers = JSON.parse(data);
            const filtered = tickers
                .filter(t => t.s.endsWith('USDT'))
                .filter(t => !['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'USDPUSDT', 'DAIUSDT', 'AEURUSDT', 'BUSDUSDT', 'EURIUSDT', 'EURUSDT', 'WBTCUSDT', 'WSTETHUSDT', 'WBETHUSDT'].includes(t.s))
                .filter(t => (parseFloat(t.c) * parseFloat(t.v)) > config.MIN_VOLUME_USDT)
                .map(t => t.s);

            if (JSON.stringify(filtered.sort()) !== JSON.stringify(hotlist.sort())) {
                hotlist = filtered;
                Object.keys(tradeStore).forEach(symbol => { if (!hotlist.includes(symbol)) delete tradeStore[symbol]; });
                if (!isConnecting) startCollector();
            }
        } catch (e) {}
    });
    ws.on('close', () => setTimeout(startScanner, 5000));
}

function startCollector() {
    isConnecting = true;
    if (collectorWs) {
        try { collectorWs.removeAllListeners(); if (collectorWs.readyState < 2) collectorWs.terminate(); } catch (e) {}
    }
    if (hotlist.length === 0) { isConnecting = false; return; }
    const streams = hotlist.slice(0, 40).map(s => `${s.toLowerCase()}@aggTrade`).join('/');
    collectorWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    collectorWs.on('open', () => { 
        console.log(`📡 WebSocket established with ${hotlist.slice(0, 40).length} pairs.`);
        setTimeout(() => { isConnecting = false; }, 10000); 
    });
    collectorWs.on('message', (msg) => {
        try {
            const d = JSON.parse(msg).data;
            if (!tradeStore[d.s]) tradeStore[d.s] = { trades: [], lastPrice: 0 };
            const p = parseFloat(d.p);
            tradeStore[d.s].lastPrice = p;
            tradeStore[d.s].trades.push({ usd: p * parseFloat(d.q), p, side: d.m ? 'SELL' : 'BUY', t: Date.now() });
        } catch (e) {}
    });
    collectorWs.on('close', () => { isConnecting = false; setTimeout(startCollector, 5000); });
}

// --- RADAR ---
function startRadar() {
    setInterval(() => {
        hotlist.forEach(s => {
            const stats = analyzeSymbol(s);
            if (!stats || stats.label === "⚖️ MIXED TAPE" || stats.label.includes("Lagging") || stats.label.includes("Resilient")) return;

            const now = Date.now();
            if (!stateMemory.symbolData[s]) stateMemory.symbolData[s] = { lastLabel: '', alerts: {}, pendingLabel: '', pendingCount: 0 };

            const mem = stateMemory.symbolData[s];
            const cooldownMs = config.ALERT_COOLDOWN_MIN * 60000;
            const lastAlertForLabel = mem.alerts[stats.label] || 0;

            if (stats.label !== mem.lastLabel) {
                if (stats.label === mem.pendingLabel) {
                    mem.pendingCount++;
                    if (mem.pendingCount >= 2 && now - lastAlertForLabel > cooldownMs) {
                        const pStr = stats.currentPrice > 1 ? stats.currentPrice.toFixed(2) : stats.currentPrice.toFixed(6);
                        const cStr = (stats.change1h >= 0 ? "+" : "") + stats.change1h.toFixed(2) + "%";
                        const volStr = `$${(stats.totalFast/1000).toFixed(1)}k`;
                        
                        sendTelegram(`*${s}* | ${stats.label}\n💵 Price: $${pStr} (${cStr} 1h)\n💰 10m Vol: ${volStr}\n📊 Bias: ${stats.fBias.toFixed(1)}%\n⚡️ Activity: ${stats.actMult.toFixed(1)}x`);
                        
                        mem.lastLabel = stats.label;
                        mem.alerts[stats.label] = now;
                        mem.pendingLabel = '';
                        mem.pendingCount = 0;
                    }
                } else {
                    mem.pendingLabel = stats.label;
                    mem.pendingCount = 1;
                }
            } else {
                mem.pendingLabel = '';
                mem.pendingCount = 0;
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
                    if (!msg || !msg.text) continue;
                    const text = msg.text.trim();

                    if (text.startsWith('/status')) {
                        const uptimeMin = Math.floor(process.uptime() / 60);
                        const tracked = Object.keys(tradeStore).length;
                        const baseline = Math.min(100, ((Date.now() - startTime) / 10800000 * 100)).toFixed(0);
                        sendTelegram(`🤖 *Status Report*\n⏱ Uptime: ${uptimeMin}m\n📊 Baseline: ${baseline}%\n📁 Tracked: ${tracked}\n🔥 Scanner: ${hotlist.length} pairs\n⚙️ Threshold: ${stateMemory.globalThreshold}%`);
                    }
                    else if (text.startsWith('/threshold')) {
                        const val = parseFloat(text.split(' ')[1]);
                        if (!isNaN(val)) {
                            stateMemory.globalThreshold = val;
                            sendTelegram(`✅ *Threshold Updated*\nTarget: ${val}% 5m price change.`);
                        } else {
                            sendTelegram(`❌ Current: ${stateMemory.globalThreshold}%. Usage: \`/threshold 0.5\``);
                        }
                    }
                    else if (text.startsWith('/check')) {
                        let sym = text.split(' ')[1]?.toUpperCase();
                        if (sym) {
                            if (!sym.endsWith('USDT')) sym += 'USDT';
                            const stats = analyzeSymbol(sym);
                            if (!stats) {
                                sendTelegram(`❌ No data for ${sym}.`);
                            } else {
                                const pStr = stats.currentPrice > 1 ? stats.currentPrice.toFixed(2) : stats.currentPrice.toFixed(6);
                                const cStr = (stats.change1h >= 0 ? "+" : "") + stats.change1h.toFixed(2) + "%";
                                const volStr = `$${(stats.totalFast/1000).toFixed(1)}k`;
                                sendTelegram(`🔍 *Analysis: ${sym}*\n${stats.label}\n💵 Price: $${pStr} (${cStr} 1h)\n💰 10m Vol: ${volStr}\n📊 Bias: ${stats.fBias.toFixed(1)}%\n⚡️ Activity: ${stats.actMult.toFixed(1)}x\n📈 5m: ${stats.change5m.toFixed(2)}% (Need ${stats.threshold}%)`);
                            }
                        }
                    }
                }
            }
        } catch (e) {}
    }, 5000);
}

module.exports = { startScanner, startRadar, startListener, sendTelegram, loadMemory };
