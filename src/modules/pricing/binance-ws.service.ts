import WebSocket from 'ws';
import { redis } from '../../libs/redis.js';
import { logger } from '../../libs/logger.js';
import { prisma } from '../../libs/prisma.js';

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const PRICE_CACHE_KEY_PREFIX = 'price:';
const PRICE_HARD_TTL_SECONDS = 3600; // 1 Hour backup
const RECONNECT_INTERVAL = 5000;
const WATCHDOG_INTERVAL = 30000; // 30s Check
const METRICS_INTERVAL = 60000; // 1 Minute

let ws: WebSocket | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let lastMessageTime = Date.now();
let isReconnecting = false;
let supportedSymbols = new Set<string>();

// Metrics
let metrics = {
    updates: 0,
    drops: 0,
    errors: 0,
    maxLag: 0
};

/**
 * Load Supported Tokens from DB to Memory
 * Only process these symbols to save CPU
 */
export const updateSupportedTokens = async () => {
    try {
        const tokens = await prisma.token.findMany({
            select: { symbol: true },
            distinct: ['symbol']
        });

        const newSet = new Set<string>();
        tokens.forEach(t => {
            // Map Token Symbol (e.g. BTC) -> Binance Symbol (BTCUSDT)
            newSet.add(`${t.symbol.toUpperCase()}USDT`);
        });

        supportedSymbols = newSet;
        logger.info({ count: supportedSymbols.size }, 'Updated supported WSS symbols');
    } catch (error) {
        logger.error({ error }, 'Failed to update supported tokens');
    }
};

/**
 * Initialize Binance WebSocket
 */
export const initBinanceWS = async () => {
    await updateSupportedTokens();
    connect();
    setInterval(updateSupportedTokens, 10 * 60 * 1000);
};

const connect = () => {
    if (ws || isReconnecting) return;

    logger.info('Connecting to Binance WS...');
    isReconnecting = true;

    ws = new WebSocket(BINANCE_WS_URL);

    ws.on('open', () => {
        logger.info('✅ Binance WS Connected');
        isReconnecting = false;
        lastMessageTime = Date.now();
        startWatchdog();
        startMetricsLogger();
    });

    ws.on('message', (data: WebSocket.Data) => {
        lastMessageTime = Date.now();
        try {
            const tickers = JSON.parse(data.toString());
            if (Array.isArray(tickers)) processTickers(tickers);
        } catch (error) { metrics.errors++; }
    });

    ws.on('error', (err) => {
        logger.error({ err: err.message }, 'Binance WS Error');
        metrics.errors++;
    });

    ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, 'Binance WS Closed, Reconnecting...');
        ws = null;
        stopWatchdog();
        stopMetricsLogger();
        setTimeout(() => {
            isReconnecting = false;
            connect();
        }, RECONNECT_INTERVAL);
    });
};

const startMetricsLogger = () => {
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = setInterval(() => {
        // Only log if something happened
        if (metrics.updates > 0 || metrics.errors > 0 || metrics.drops > 0) {
            logger.info({ ...metrics }, 'WS Metrics (1m)');
        }
        // Reset counters
        metrics = { updates: 0, drops: 0, errors: 0, maxLag: 0 };
    }, METRICS_INTERVAL);
};

const stopMetricsLogger = () => {
    if (metricsTimer) clearInterval(metricsTimer);
};

/**
 * Process Batch Tickers
 * Use Redis Pipeline for Speed + Event Time Check
 */
const processTickers = async (tickers: any[]) => {
    if (supportedSymbols.size === 0) return;

    const mainPipeline = redis.pipeline();
    let count = 0;
    const now = Date.now();

    for (const t of tickers) {
        const symbol = t.s;
        const price = t.c;
        const eventTime = t.E; // Binance Event Timestamp

        // Lag Detection
        const lag = now - eventTime;
        if (lag > metrics.maxLag) metrics.maxLag = lag;

        // Drop if stale > 5s (Network Congestion / Buffer Bloat protection)
        if (lag > 5000) {
            metrics.drops++;
            continue;
        }


        if (supportedSymbols.has(symbol)) {
            const rawSymbol = symbol.replace('USDT', '');

            // 1. Update Local Memory Cache
            localPriceCache.set(symbol, Number(price));

            // DEBUG ONCE PER SYMBOL (Throttle logic or just simple debug log)
            // logger.debug({ symbol, price }, '✅ WS Price Update');

            // 2. Format Cache Data (JSON) with Source: 'ws' metadata
            const cacheKey = `${PRICE_CACHE_KEY_PREFIX}${rawSymbol}`;
            const data = JSON.stringify({
                price,
                ts: eventTime, // Use Valid Event Time!
                source: 'ws'
            });

            mainPipeline.setex(cacheKey, PRICE_HARD_TTL_SECONDS, data);
            count++;
        }
    }

    if (count > 0) {
        metrics.updates += count;
        await mainPipeline.exec();
    }
};

/**
 * Watchdog: Kill connection if silent
 */
const startWatchdog = () => {
    if (watchdogTimer) clearInterval(watchdogTimer);

    watchdogTimer = setInterval(() => {
        const silentDuration = Date.now() - lastMessageTime;
        if (silentDuration > WATCHDOG_INTERVAL * 2 && ws) {
            logger.error({ silentDuration }, '🚨 Binance WS Frozen/Silent. Force Terminating...');
            ws.terminate();
        }
    }, WATCHDOG_INTERVAL);
};

const stopWatchdog = () => {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
};

// --- PUBLIC ACCESSOR ---

// Local Memory Cache for Sync Access (Faster than Redis for frequently accessed bot commands)
const localPriceCache = new Map<string, number>();

/**
 * Get Price from Local Memory Cache (Instant, Sync)
 * @param symbol Pair Symbol e.g. "BNBUSDT"
 */
export const getPrice = (symbol: string): number => {
    const price = localPriceCache.get(symbol);

    // DEBUG LOG
    if (!price) {
        logger.debug({
            requested: symbol,
            cacheSize: localPriceCache.size,
            available: Array.from(localPriceCache.keys()).slice(0, 5)
        }, '⚠️ Price Cache MISS');
    }

    return price || 0;
};

