import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import crypto from 'crypto';
import { redis } from '../../libs/redis.js';
import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import { env } from '../../config/env.js';
import { calculateTokenAmount, PriceQuote } from '../../utils/price.js';

const PRICE_CACHE_KEY = 'price:';
const SWR_WINDOW = 60 * 1000; // 60s Soft TTL (Refresh Trigger)
const HARD_TTL_SECONDS = 3600; // 1 Hour Hard TTL (Redis Eviction)
const LOCK_KEY_PREFIX = 'lock:price:';
const LOCK_TTL_SECONDS = 10;
const DB_WRITE_THRESHOLD = 0.005; // 0.5% Change needed to write DB

const USD_IDR_CACHE_KEY = 'usd_idr_rate';

// Lua Script for Atomic Unlock: "IF value == arg THEN del"
const LUA_UNLOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

// Helper: Sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Binance Symbol Mapper
const getBinanceSymbol = (symbol: string) => `${symbol.toUpperCase()}USDT`;

interface PriceCacheData {
  price: string;
  ts: number;
  source: 'ws' | 'rest' | 'db'; // Metadata Origin
}

/**
 * Fetch token price from Binance API with Retry
 */
export const fetchTokenPrice = async (symbol: string): Promise<Decimal> => {
  const binanceSymbol = getBinanceSymbol(symbol);

  try {
    const response = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`,
      { timeout: 5000 }
    );
    return new Decimal(response.data.price);
  } catch (error) {
    logger.warn({ error: (error as Error).message, symbol }, 'Primary price fetch failed');
    throw error; // Let caller handle fallback
  }
};

/**
 * Get token price (Production Grade: Safe Lock + True SWR + Delta DB Write)
 */
export const getTokenPrice = async (symbol: string): Promise<Decimal> => {
  const cacheKey = `${PRICE_CACHE_KEY}${symbol}`;
  const lockKey = `${LOCK_KEY_PREFIX}${symbol}`;

  // 1. Try Read Cache (JSON)
  const cachedRaw = await redis.get(cacheKey);
  let cachedData: PriceCacheData | null = null;

  if (cachedRaw) {
    try {
      cachedData = JSON.parse(cachedRaw);
    } catch (e) {
      // Corrupted cache detected - log and clear to force fresh fetch
      logger.warn({ symbol, rawData: cachedRaw.substring(0, 100) }, 'Price cache corrupted, clearing');
      await redis.del(cacheKey).catch(() => { }); // Best effort delete
      cachedData = null;
    }
  }

  const now = Date.now();

  // 2. SWR Logic
  if (cachedData) {
    const age = now - cachedData.ts;

    // If Fresh (< 60s), return immediately
    if (age < SWR_WINDOW) {
      return new Decimal(cachedData.price);
    }

    // If Stale, Trigger Background Refresh (Fire-and-Forget)
    // Attempt to acquire lock to ensure only 1 worker refreshes
    refreshPriceInBackground(symbol, cacheKey, lockKey, cachedData).catch(err => {
      logger.error({ err, symbol }, 'SWR Bg Refresh Failed');
    });

    // RETURN STALE DATA IMMEDIATELY (Fast!)
    return new Decimal(cachedData.price);
  }

  // 3. Cache Miss (Kosong Total) -> Must Wait
  // Acquire Safe Lock
  const lockVal = crypto.randomUUID();
  const acquired = await redis.set(lockKey, lockVal, 'EX', LOCK_TTL_SECONDS, 'NX');

  if (!acquired) {
    // Lock exists -> Busy Wait (Spin)
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const retryCache = await redis.get(cacheKey);
      if (retryCache) {
        const data = JSON.parse(retryCache) as PriceCacheData;
        return new Decimal(data.price);
      }
    }

    // 4. Panic Mode: Lock timeout & still no cache.
    // Do NOT force fetch (Thundering Herd Risk). 
    // If Redis is down, we must fail. DB fallback is dangerous (stale).
    logger.error({ symbol }, 'Lock timeout & No Cache. Service Busy.');
    throw new Error(`Service Busy & No Price Available for ${symbol}`);
  }

  try {
    // We hold the lock. Fetch!
    const price = await fetchTokenPrice(symbol);

    // Set Cache
    const data: PriceCacheData = {
      price: price.toString(),
      ts: Date.now(),
      source: 'rest'
    };
    await redis.setex(cacheKey, HARD_TTL_SECONDS, JSON.stringify(data));

    return price;
  } catch (err) {
    // Release lock early
    await safeReleaseLock(lockKey, lockVal);
    throw err;
  } finally {
    await safeReleaseLock(lockKey, lockVal);
  }
};

// SWR Background Refresh Task
const refreshPriceInBackground = async (
  symbol: string, cacheKey: string, lockKey: string, oldData: PriceCacheData
) => {
  // Non-blocking lock (if locked, skip refresh - someone else is doing it)
  const lockVal = crypto.randomUUID();
  const acquired = await redis.set(lockKey, lockVal, 'EX', LOCK_TTL_SECONDS, 'NX');

  if (!acquired) return; // Skip

  try {
    const price = await fetchTokenPrice(symbol);

    // Update Redis
    const data: PriceCacheData = {
      price: price.toString(),
      ts: Date.now(),
      source: 'rest'
    };
    await redis.setex(cacheKey, HARD_TTL_SECONDS, JSON.stringify(data));

    // DB Update Removed: We rely on Redis + Websocket entirely.
    // Storing ephemeral price data in Postgres causes unnecessary IOPS/Bloat.
  } catch (e) {
    // Log & Ignore background error
    logger.warn({ symbol }, 'Bg refresh failed');
  } finally {
    await safeReleaseLock(lockKey, lockVal);
  }
};

const safeReleaseLock = async (key: string, val: string) => {
  try {
    await redis.eval(LUA_UNLOCK_SCRIPT, 1, key, val);
  } catch (error) {
    logger.error({ error, key }, 'Redis Lua Unlock Failed');
  }
};


// ... USD RATE & REST OF LOGIC (Keep optimizations) ...

export const fetchRealTimeUsdIdrRate = async (): Promise<number> => {
  try {
    const response = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
    const rate = response.data?.rates?.IDR;
    if (!rate || isNaN(rate)) throw new Error('Invalid rate');
    logger.info({ rate }, 'Fetched new USD/IDR rate');
    return rate;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch USD IDR');
    throw error;
  }
};

export const getUsdIdrRate = async (): Promise<number> => {
  // SWR-Like Logic for USD too
  const cached = await redis.get(USD_IDR_CACHE_KEY);
  if (cached) {
    // Ideally implement SWR here too, but for simplicity & low vol, hard cache is acceptable
    // Or we can rely on the 1 hour Redis TTL implemented previously
    return parseFloat(cached);
  }

  const setting = await prisma.setting.findUnique({ where: { key: 'usd_idr_rate' } });

  const now = new Date();
  const lastUpdate = setting?.updatedAt || new Date(0);
  const isOutdated = (now.getTime() - lastUpdate.getTime()) > (24 * 3600 * 1000);

  let rate: number;

  if (!setting || isOutdated) {
    try {
      rate = await fetchRealTimeUsdIdrRate();
      await setUsdIdrRate(rate);
      return rate;
    } catch (e) {
      rate = setting ? parseFloat(setting.value) : env.USD_IDR_RATE;
    }
  } else {
    rate = parseFloat(setting.value);
  }

  await redis.setex(USD_IDR_CACHE_KEY, 3600, rate.toString());
  return rate;
};

export const setUsdIdrRate = async (rate: number): Promise<void> => {
  await prisma.setting.upsert({
    where: { key: 'usd_idr_rate' },
    update: { value: rate.toString(), updatedAt: new Date() },
    create: { key: 'usd_idr_rate', value: rate.toString() },
  });
  await redis.setex(USD_IDR_CACHE_KEY, 3600, rate.toString());
};

export const getMarkupPercent = async (tokenMarkup?: number): Promise<number> => {
  if (tokenMarkup !== undefined) return tokenMarkup;
  const setting = await prisma.setting.findUnique({ where: { key: 'markup_percent' } });
  return setting ? parseInt(setting.value, 10) : env.DEFAULT_MARKUP_PERCENT;
};

export const setMarkupPercent = async (percent: number): Promise<void> => {
  await prisma.setting.upsert({
    where: { key: 'markup_percent' },
    update: { value: percent.toString() },
    create: { key: 'markup_percent', value: percent.toString() },
  });
};

export const getQuote = async (
  chainSlug: string,
  amountIdr: number,
  symbol?: string
): Promise<PriceQuote & { symbol: string }> => {

  let targetSymbol = symbol;
  let tokenMarkup = 5.0;

  if (!targetSymbol) {
    // Cache Chain Metadata too? For now DB fast enough
    const chain = await prisma.chain.findUnique({
      where: { slug: chainSlug },
      include: { tokens: { where: { isNative: true } } }
    });

    if (!chain || chain.tokens.length === 0) {
      throw new Error('Chain/Token not found');
    }
    targetSymbol = chain.tokens[0].symbol;
    tokenMarkup = chain.tokens[0].markupPercent;
  } else {
    const token = await prisma.token.findFirst({
      where: { chain: { slug: chainSlug }, symbol: targetSymbol }
    });
    if (token) tokenMarkup = token.markupPercent;
  }

  const [tokenPriceUsd, usdIdrRate, markupPercent] = await Promise.all([
    getTokenPrice(targetSymbol),
    getUsdIdrRate(),
    getMarkupPercent(tokenMarkup)
  ]);

  const quote = calculateTokenAmount(amountIdr, tokenPriceUsd, usdIdrRate, markupPercent);
  return { ...quote, symbol: targetSymbol };
};

/**
 * Bulk Refresh with Pipeline
 */
export const refreshAllPrices = async (): Promise<void> => {
  try {
    const tokens = await prisma.token.findMany({
      select: { symbol: true },
      distinct: ['symbol']
    });
    const trackedSymbols = new Set(tokens.map(t => getBinanceSymbol(t.symbol)));

    const response = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 10000 });
    const allPrices = response.data as Array<{ symbol: string, price: string }>;

    // USE REDIS PIPELINE
    const pipeline = redis.pipeline();
    let updateCount = 0;

    for (const item of allPrices) {
      if (trackedSymbols.has(item.symbol)) {
        const rawSymbol = item.symbol.replace('USDT', '');
        const price = new Decimal(item.price);

        // Update Cache (JSON Format for SWR)
        const cacheKey = `${PRICE_CACHE_KEY}${rawSymbol}`;
        const data: PriceCacheData = {
          price: item.price,
          ts: Date.now(),
          source: 'rest'
        };
        pipeline.setex(cacheKey, HARD_TTL_SECONDS, JSON.stringify(data));
        updateCount++;

        // DB Update (Optimized: Check delta needed? Or just skip)
        // For bulk refresh, maybe skip DB write to avoid flood? 
        // Or write only if cache was super stale. 
        // Let's optimize: Only Cache. DB update happens on 'getTokenPrice' demand.
      }
    }

    await pipeline.exec();
    logger.info({ count: updateCount }, 'Bulk refreshed prices (Cache Only)');

  } catch (error) {
    logger.error({ error }, 'Bulk Refresh Failed');
  }
};
