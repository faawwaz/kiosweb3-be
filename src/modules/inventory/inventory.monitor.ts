import { logger } from '../../libs/logger.js';
import { blockchainManager } from '../blockchain/engine/BlockchainManager.js';
import * as inventoryService from './inventory.service.js';
import * as blockchainService from '../blockchain/blockchain.service.js';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../libs/prisma.js';

// Cache to store last known balances to reduce DB writes
// Key: chainSlug (string)
const balanceCache: Record<string, Decimal> = {};

// Rate limiting: Check balance at most every 30 seconds per chain
const RATE_LIMIT_MS = 30000;
const lastCheckTime: Record<string, number> = {};

// Track which chains are currently being monitored to prevent duplicate listeners
const runningMonitors = new Set<string>();

// Map to store native symbols for chains
const nativeSymbolMap: Record<string, string> = {};

/**
 * Start monitoring blockchain blocks for inventory updates
 * Supports Dynamic Loading (Hot Reload)
 */
export const startInventoryMonitor = async () => {
    logger.info('Starting Inventory Monitor (Dynamic Version)...');

    // Initial Load
    await refreshMonitors();

    // Schedule Dynamic Refresh (Every 5 Minutes)
    // This allows Admin to add new chains without restarting the server
    setInterval(async () => {
        await refreshMonitors();
    }, 5 * 60 * 1000);
};

/**
 * Refresh list of active chains and start monitors for new ones
 */
const refreshMonitors = async () => {
    try {
        const chains = await prisma.chain.findMany({
            where: { isActive: true },
            include: { tokens: { where: { isNative: true } } }
        });

        // 1. Identify New Chains
        for (const chain of chains) {
            // Map Chain -> Native Symbol
            if (chain.tokens.length > 0) {
                const symbol = chain.tokens[0].symbol;
                nativeSymbolMap[chain.slug] = symbol;
            } else {
                // If it was unknown, we might retry or just log
                if (!nativeSymbolMap[chain.slug]) {
                    logger.warn({ chain: chain.slug }, '❌ Monitor: No Native Token found');
                    nativeSymbolMap[chain.slug] = 'UNKNOWN';
                }
            }

            // Start Monitor if not running
            if (!runningMonitors.has(chain.slug)) {
                logger.info({ chain: chain.slug }, '🆕 Monitor: Starting new chain monitor...');
                monitorChain(chain.slug);
                runningMonitors.add(chain.slug);
            }
        }

        // 2. Identify Removed/Inactive Chains (Optional Cleanup)
        // If a chain is deactivated in DB, we should technically stop listening.
        // However, Ethers provider listener cleanup is complex without storing the provider ref.
        // For now, we just leave them running (Zombie listeners are low cost). 
        // A full "Stop" feature would require storing `Listener` objects in a Map.

    } catch (error) {
        logger.error({ error }, 'Inventory monitor refresh failed');
    }
};

/**
 * Monitor a specific chain for block updates
 */
const monitorChain = async (chainSlug: string) => {
    try {
        // Use the new Blockchain Manager to get provider
        let provider;
        try {
            provider = blockchainManager.getProvider(chainSlug);
        } catch (e) {
            logger.warn({ chain: chainSlug }, 'Provider not found in Manager (Load delayed?), retrying in 5s');
            // Retry once after delay, then give up for this cycle (next refresh will catch it)
            setTimeout(() => {
                if (!runningMonitors.has(chainSlug)) return; // Stopped?
                try {
                    const retryProvider = blockchainManager.getProvider(chainSlug);
                    setupListener(retryProvider, chainSlug);
                } catch (retryErr) {
                    runningMonitors.delete(chainSlug); // Allow retry next refresh
                }
            }, 5000);
            return;
        }

        setupListener(provider, chainSlug);

    } catch (error) {
        logger.error({ error, chain: chainSlug }, 'Failed to start chain monitor');
        runningMonitors.delete(chainSlug); // Allow retry
    }
};

/**
 * Actual Listener Setup
 */
const setupListener = async (provider: any, chainSlug: string) => {
    const hotWalletAddress = blockchainService.getHotWalletAddress(chainSlug);

    logger.info({ chain: chainSlug, address: hotWalletAddress }, '✅ Monitor Active');

    // Ethers v6 Listener
    provider.provider.on('block', async (blockNumber: number) => {
        try {
            // Throttling Check
            const lastCheck = lastCheckTime[chainSlug] || 0;
            const now = Date.now();

            if (now - lastCheck < RATE_LIMIT_MS) return;

            lastCheckTime[chainSlug] = now;

            // Fetch Balance
            const currentBalance = await blockchainService.getHotWalletBalance(chainSlug);
            const cachedBalance = balanceCache[chainSlug];

            if (!cachedBalance || !currentBalance.equals(cachedBalance)) {
                logger.debug(
                    {
                        chain: chainSlug,
                        block: blockNumber,
                        old: cachedBalance?.toString(),
                        new: currentBalance.toString()
                    },
                    '⚖️ Inventory Balance Update Detected'
                );

                // Update DB with CORRECT SYMBOL
                const symbol = nativeSymbolMap[chainSlug];
                if (!symbol || symbol === 'UNKNOWN') {
                    // Try to re-fetch symbol if missing (maybe token added late)
                    // But for now just warn
                } else {
                    await inventoryService.updateInventoryBalance(chainSlug, currentBalance, symbol);
                }

                balanceCache[chainSlug] = currentBalance;
            }

        } catch (error) {
            // Silent catch to prevent crasing listener
            logger.warn({ chain: chainSlug, error: (error as Error).message }, 'Monitor loop error');
        }
    });

    // Handle Provider Errors (Disconnects)
    provider.provider.on('error', (error: any) => {
        logger.error({ chain: chainSlug, error }, 'Provider Connection Error');
        // If critical, we might remove from runningMonitors to force restart?
        // Usually Ethers auto-reconnects.
    });
};
