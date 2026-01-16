const WebSocket = require('ws');
const config = require('./config');

let tradeStore = {}; 
let hotlist = [];
let collectorWs = null;
let stateMemory = {}; 

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

function startScanner() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const filtered = tickers
            .filter(t => t.s.endsWith('USDT'))
            .filter(t => !['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'DAIUSDT', 'EURUSDT'].includes(t.s))
            .filter(t => (parseFloat(t.c) * parseFloat(t.v)) > config.MIN_VOLUME_USDT)
            .map(t => t.s);

        if (JSON.stringify(filtered) !== JSON.stringify(hotlist)) {
            hotlist = filtered;
            console.log(`🔥 Stage A: Hotlist updated (${hotlist.length} symbols).`);
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
        const parsed = JSON.parse(msg);
        const data = parsed.data || parsed;
        if (!data || !data.s) return;
        
        if (!tradeStore[data.s]) tradeStore[data.s] = [];
        tradeStore[data.s].push({ 
            usd: parseFloat(data.p) * parseFloat(data.q), 
            side: data.m ? 'SELL' : 'BUY', 
            t: Date.now() 
        });

        if (tradeStore[data.s].length > 1000) {
            const cutoff = Date.now() - (3 * 3600000);
            tradeStore[data.s] = tradeStore[data.s].filter(t => t.t > cutoff);
        }
    });
}

function startRadar() {
    setInterval(() => {
        hotlist.forEach(s => {
            const stats = analyzeSymbol(s);
            if (!stats || stats.label === "⚖️ MIXED TAPE") return;

            const now = Date.now();
            if (!stateMemory[s]) stateMemory[s] = { lastLabel: '', lastAlert: 0 };

            const isNewState = stats.label !== stateMemory[s].lastLabel;
            const cooldownDone = now - stateMemory[s].lastAlert > config.ALERT_COOLDOWN_MIN * 60000
