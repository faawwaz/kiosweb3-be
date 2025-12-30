import { Decimal } from '@prisma/client/runtime/library';
import { ethers } from 'ethers';
import crypto from 'crypto';
import { logger } from '../../libs/logger.js';
import { redis } from '../../libs/redis.js';
import { blockchainManager } from './engine/BlockchainManager.js';

export class BlockchainUnknownError extends Error {
  constructor(message: string, public txHash?: string) {
    super(message);
    this.name = 'BlockchainUnknownError';
  }
}

export class TxBroadcastedError extends Error {
  constructor(message: string, public txHash: string) {
    super(message);
    this.name = 'TxBroadcastedError';
  }
}

/**
 * Get hot wallet balance
 */
export const getHotWalletBalance = async (chainId: string): Promise<Decimal> => {
  const provider = blockchainManager.getProvider(chainId);
  const privateKey = blockchainManager.getPrivateKey(chainId);
  const wallet = new ethers.Wallet(privateKey, provider.provider);

  const balance = await provider.getBalance(wallet.address);
  // Ethers return bigint (wei). Convert to string then decimal.
  return new Decimal(ethers.formatEther(balance));
};

/**
 * Get hot wallet address
 */
export const getHotWalletAddress = (chainId: string): string => {
  const privateKey = blockchainManager.getPrivateKey(chainId);
  const wallet = new ethers.Wallet(privateKey);
  return wallet.address;
};


/**
 * Send native token to recipient with distributed locking
 */

// --- DISTRIBUTED REDIS LOCK (Production Grade) ---
const LOCK_TTL_MS = 180000;           // 180s (3 mins) max lock time per transaction (Prevents overlap with Zombie Worker)
const LOCK_RETRY_DELAY_MS = 1000;    // 1s wait between retries
const MAX_LOCK_RETRIES = 30;         // Maximum 30 retries (30 seconds total wait)
const LOCK_ACQUIRE_TIMEOUT_MS = 35000; // Hard timeout for lock acquisition

// Lua script for atomic lock release (prevents race condition)
// Only deletes the key if the value matches (owner verification)
const LUA_SAFE_UNLOCK = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

// --- CONFIGURABLE CONFIRMATIONS ---
const CONFIRMATIONS: Record<string, number> = {
  'bsc': 3,
  'ethereum': 1,
  'base': 3,
  'polygon': 5,
  'default': 1
};

/**
 * Custom error for lock acquisition failures
 */
export class LockAcquisitionError extends Error {
  constructor(chainId: string, attempts: number) {
    super(`Failed to acquire lock for chain ${chainId} after ${attempts} attempts`);
    this.name = 'LockAcquisitionError';
  }
}

/**
 * Atomically release lock using Lua script
 * Only releases if we still own the lock (value matches)
 */
async function safeReleaseLock(key: string, lockVal: string): Promise<boolean> {
  try {
    const result = await redis.eval(LUA_SAFE_UNLOCK, 1, key, lockVal);
    return result === 1;
  } catch (error) {
    logger.error({ error, key }, 'Failed to release lock atomically');
    return false;
  }
}

/**
 * Execute task with distributed lock (Production Grade)
 * - Prevents infinite loop with max retries and hard timeout
 * - Uses atomic lock release to prevent race conditions
 * - Generates cryptographically secure lock values
 */
async function runWithLock<T>(chainId: string, task: () => Promise<T>): Promise<T> {
  const key = `lock:chain:${chainId}`;
  // Use crypto for better uniqueness than Math.random()
  const lockVal = crypto.randomUUID();

  let attempts = 0;
  const startTime = Date.now();

  while (attempts < MAX_LOCK_RETRIES) {
    // Hard timeout check
    if (Date.now() - startTime > LOCK_ACQUIRE_TIMEOUT_MS) {
      logger.error({ chainId, attempts, elapsedMs: Date.now() - startTime }, 'Lock acquisition hard timeout exceeded');
      throw new LockAcquisitionError(chainId, attempts);
    }

    attempts++;

    // Try to acquire lock with NX (only if not exists)
    const acquired = await redis.set(key, lockVal, 'PX', LOCK_TTL_MS, 'NX');

    if (acquired === 'OK') {
      logger.debug({ chainId, lockVal, attempts }, 'Lock acquired');

      try {
        const result = await task();
        return result;
      } finally {
        // CRITICAL: Atomic lock release using Lua script
        const released = await safeReleaseLock(key, lockVal);
        if (!released) {
          // Lock was either expired or stolen - log for monitoring
          logger.warn({ chainId, lockVal }, 'Lock was not released (expired or ownership lost)');
        } else {
          logger.debug({ chainId, lockVal }, 'Lock released successfully');
        }
      }
    }

    // Log progress every 5 attempts
    if (attempts % 5 === 0) {
      logger.warn({ chainId, attempts, maxRetries: MAX_LOCK_RETRIES }, 'Still waiting for lock...');
    }

    // Wait before retry
    await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }

  // Exhausted all retries
  logger.error({ chainId, attempts }, 'Lock acquisition failed after max retries');
  throw new LockAcquisitionError(chainId, attempts);
}

/**
 * Send native token to recipient (Sequential per Chain via Redis Lock)
 */
export const sendNativeToken = async (
  chainId: string,
  to: string,
  amount: Decimal
): Promise<string> => {
  return runWithLock(chainId, async () => {
    const provider = blockchainManager.getProvider(chainId);
    const privateKey = blockchainManager.getPrivateKey(chainId);
    const wallet = new ethers.Wallet(privateKey, provider.provider);

    const value = ethers.parseEther(amount.toString());

    logger.info(
      { chainId, to, amount: amount.toString() },
      'Sending native token (Locked)...'
    );

    try {
      // 1. Gas Price Boost (10%)
      const feeData = await provider.provider.getFeeData();
      let gasPrice = feeData.gasPrice;

      if (gasPrice) {
        gasPrice = (gasPrice * 110n) / 100n;
      }

      // 2. Refresh Nonce Manually (Critical for High Load)
      const nonce = await provider.provider.getTransactionCount(wallet.address, 'latest');

      // 3. Send Tx
      const tx = await wallet.sendTransaction({
        to,
        value,
        gasPrice: gasPrice || undefined,
        nonce
      });

      logger.info(
        { chainId, txHash: tx.hash, amount: amount.toString(), nonce },
        'Transaction sent, waiting for confirmation...'
      );

      // 4. Wait (Configurable confirmations)
      try {
        const confs = CONFIRMATIONS[chainId] || CONFIRMATIONS['default'];
        const receipt = await tx.wait(confs);

        if (!receipt || receipt.status === 0) {
          throw new Error('Transaction reverted on-chain');
        }

        logger.info(
          { chainId, txHash: receipt.hash, blockNumber: receipt.blockNumber, confirmations: confs },
          'Transaction confirmed'
        );

        return receipt.hash;

      } catch (waitError: any) {
        // CRITICAL: If wait fails (timeout/network) BUT tx was broadcast, we MUST return the hash
        // so the system knows money is moving/moved.
        if (tx.hash) {
          logger.warn({ chainId, txHash: tx.hash, error: waitError.message }, 'Transaction broadcasted but confirmation wait failed/timed out');
          throw new TxBroadcastedError(`Transaction broadcasted but not confirmed: ${waitError.message}`, tx.hash);
        }
        throw waitError;
      }
    } catch (e: any) {
      if (e instanceof TxBroadcastedError) throw e; // Pass through

      if (e.message.includes('nonce')) {
        logger.warn({ chainId, error: e.message }, 'Nonce error detected, retrying logic might be needed');
      }
      throw e;
    }
  });
};

/**
 * Check if address is valid
 */
export const isValidAddress = (address: string): boolean => {
  return ethers.isAddress(address);
};

/**
 * Estimate transfer cost
 */
export const estimateTransferCost = async (
  chainId: string,
  to: string,
  amount: Decimal
): Promise<Decimal> => {
  try {
    const provider = blockchainManager.getProvider(chainId);
    const privateKey = blockchainManager.getPrivateKey(chainId);
    const wallet = new ethers.Wallet(privateKey, provider.provider);

    const value = ethers.parseEther(amount.toString());

    const gasEstimate = await wallet.estimateGas({
      to,
      value
    });

    const feeData = await provider.provider.getFeeData();
    // Prefer maxFeePerGas for EIP-1559, else gasPrice
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || 3000000000n; // fallback 3 gwei

    const costWei = gasEstimate * gasPrice;
    return new Decimal(ethers.formatEther(costWei));

  } catch (error) {
    logger.error({ error, chainId }, 'Failed to estimate transfer cost');
    // Fallback to safe default? No, better throw so UI knows.
    throw error;
  }
};

/**
 * Get Gas Price (Legacy format for compatibility)
 */
export const getGasPrice = async (chainId: string): Promise<bigint> => {
  const provider = blockchainManager.getProvider(chainId);
  const fee = await provider.provider.getFeeData();
  return fee.gasPrice || 0n;
};

/**
 * Estimate Standard Native Transfer Fee (Lightweight)
 * Returns fee in Ether (Decimal)
 */
export const estimateGasFeeNative = async (chainId: string): Promise<Decimal> => {
  try {
    const provider = blockchainManager.getProvider(chainId);
    const feeData = await provider.provider.getFeeData();
    // Standard Gas Limit for Native Transfer is 21,000
    // Use maxFeePerGas for EIP-1559 or gasPrice
    const price = feeData.maxFeePerGas || feeData.gasPrice || 3000000000n; // 3 gwei fallback
    const totalWei = price * 21000n;
    return new Decimal(ethers.formatEther(totalWei));
  } catch (error) {
    logger.warn({ chainId }, 'Failed to estimate gas fee, using default');
    // Minor Bug Fix: 0.0001 is too low for ETH Mainnet (approx 0.0004 needed for 20gwei)
    const safeFallback = chainId === 'eth' || chainId === '1' ? '0.002' : '0.0005';
    return new Decimal(safeFallback);
  }
};
