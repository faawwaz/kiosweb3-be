import { redis } from '../libs/redis';
import { z } from 'zod';
import { logger } from '../libs/logger';
import crypto from 'crypto';

const STATE_PREFIX = 'bot:state:';
const STATE_EXPIRY = 1800; // 30 minutes (reduced from 2 hours - Issue #25)
const LOCK_PREFIX = 'bot:lock:';
const LOCK_TTL = 5; // 5 seconds

export type ConversationStep =
  | 'idle'
  | 'awaiting_chain'
  | 'awaiting_amount'
  | 'awaiting_custom_amount'
  | 'awaiting_wallet_selection'
  | 'awaiting_wallet'
  | 'awaiting_voucher'
  | 'awaiting_confirmation'
  | 'awaiting_payment_method'
  | 'awaiting_otp'
  | 'awaiting_email'
  | 'awaiting_name'
  | 'awaiting_link_code'
  | 'awaiting_link_otp'
  | 'awaiting_change_email';

// Zod schema for state validation (Issue #6)
const ConversationStateSchema = z.object({
  step: z.enum([
    'idle', 'awaiting_chain', 'awaiting_amount', 'awaiting_custom_amount',
    'awaiting_wallet_selection', 'awaiting_wallet', 'awaiting_voucher',
    'awaiting_confirmation', 'awaiting_payment_method', 'awaiting_otp',
    'awaiting_email', 'awaiting_name', 'awaiting_link_code', 'awaiting_link_otp',
    'awaiting_change_email'
  ]),
  chain: z.string().optional(),
  amountIdr: z.number().optional(),
  tokenAmount: z.string().optional(),
  walletAddress: z.string().optional(),
  voucherCode: z.string().optional(),
  regName: z.string().optional(),
  regEmail: z.string().optional(),
  regReferral: z.string().optional(),
  linkCode: z.string().optional(),
  orderId: z.string().optional(),
  pendingAction: z.string().optional(),
  // Session token for hijacking prevention (Issue #4)
  sessionToken: z.string().optional(),
  lastMessageId: z.number().optional(),
  createdAt: z.number().optional(),
});

export interface ConversationState {
  step: ConversationStep;
  chain?: string;
  amountIdr?: number;
  tokenAmount?: string;
  walletAddress?: string;
  voucherCode?: string;
  regName?: string;
  regEmail?: string;
  regReferral?: string;
  linkCode?: string;
  orderId?: string;
  pendingAction?: string;
  sessionToken?: string;
  lastMessageId?: number;
  createdAt?: number;
}

// Lua script for atomic state update (Issue #9)
const LUA_ATOMIC_UPDATE = `
  local key = KEYS[1]
  local updates = cjson.decode(ARGV[1])
  local expiry = tonumber(ARGV[2])
  
  local current = redis.call('GET', key)
  local state = {}
  
  if current then
    state = cjson.decode(current)
  else
    state = { step = 'idle' }
  end
  
  for k, v in pairs(updates) do
    state[k] = v
  end
  
  redis.call('SETEX', key, expiry, cjson.encode(state))
  return cjson.encode(state)
`;

/**
 * Get conversation state for a user with schema validation (Issue #6)
 */
export const getState = async (telegramId: string): Promise<ConversationState> => {
  const key = `${STATE_PREFIX}${telegramId}`;
  const data = await redis.get(key);

  if (!data) {
    return { step: 'idle', createdAt: Date.now() };
  }

  try {
    const parsed = JSON.parse(data);
    // Validate with Zod schema (Issue #6)
    const validated = ConversationStateSchema.safeParse(parsed);

    if (!validated.success) {
      logger.warn({ telegramId, errors: validated.error.errors }, 'State validation failed, resetting');
      await redis.del(key);
      return { step: 'idle', createdAt: Date.now() };
    }

    return validated.data as ConversationState;
  } catch (e) {
    // Corrupted JSON - clear and return default
    logger.warn({ telegramId, error: e }, 'State JSON parse failed, resetting');
    await redis.del(key);
    return { step: 'idle', createdAt: Date.now() };
  }
};

/**
 * Set conversation state for a user
 */
export const setState = async (
  telegramId: string,
  state: ConversationState
): Promise<void> => {
  const key = `${STATE_PREFIX}${telegramId}`;
  // Add timestamp if not present
  if (!state.createdAt) {
    state.createdAt = Date.now();
  }
  await redis.setex(key, STATE_EXPIRY, JSON.stringify(state));
};

/**
 * Atomic state update using Lua script (Issue #9)
 * Prevents race conditions in GET → MERGE → SET pattern
 */
export const updateStateAtomic = async (
  telegramId: string,
  updates: Partial<ConversationState>
): Promise<ConversationState> => {
  const key = `${STATE_PREFIX}${telegramId}`;

  try {
    const result = await redis.eval(
      LUA_ATOMIC_UPDATE,
      1,
      key,
      JSON.stringify(updates),
      STATE_EXPIRY.toString()
    ) as string;

    return JSON.parse(result) as ConversationState;
  } catch (e) {
    // Fallback to non-atomic if Lua fails (e.g., no cjson)
    logger.warn({ error: e }, 'Lua atomic update failed, using fallback');
    const currentState = await getState(telegramId);
    const newState = { ...currentState, ...updates };
    await setState(telegramId, newState);
    return newState;
  }
};

/**
 * Update conversation state with lock (Issue #9)
 * More reliable than Lua for complex updates
 * Throws error if lock cannot be acquired to prevent race conditions
 */
export const updateState = async (
  telegramId: string,
  updates: Partial<ConversationState>
): Promise<ConversationState> => {
  const key = `${STATE_PREFIX}${telegramId}`;
  const lockKey = `${LOCK_PREFIX}${telegramId}`;
  const lockValue = crypto.randomUUID();

  // Try to acquire lock with retries
  let acquired = await redis.set(lockKey, lockValue, 'EX', LOCK_TTL, 'NX');

  if (!acquired) {
    // Wait briefly and retry up to 3 times
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 50 * (i + 1))); // 50ms, 100ms, 150ms
      acquired = await redis.set(lockKey, lockValue, 'EX', LOCK_TTL, 'NX');
      if (acquired) break;
    }

    if (!acquired) {
      // Critical: Don't proceed without lock - throw error to prevent race condition
      logger.warn({ telegramId }, 'State update lock contention - operation rejected');
      throw new Error('Operation in progress, please wait');
    }
  }

  try {
    const currentState = await getState(telegramId);
    const newState = { ...currentState, ...updates };
    await setState(telegramId, newState);
    return newState;
  } finally {
    // Release lock safely using Lua for atomicity
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(luaScript, 1, lockKey, lockValue);
  }
};

/**
 * Clear conversation state
 */
export const clearState = async (telegramId: string): Promise<void> => {
  const key = `${STATE_PREFIX}${telegramId}`;
  await redis.del(key);
};

/**
 * Reset to idle state with fresh session
 */
export const resetState = async (telegramId: string): Promise<void> => {
  await setState(telegramId, {
    step: 'idle',
    sessionToken: crypto.randomUUID(),
    createdAt: Date.now()
  });
};

/**
 * Refresh state TTL without modifying content
 */
export const refreshStateTTL = async (telegramId: string): Promise<void> => {
  const key = `${STATE_PREFIX}${telegramId}`;
  const data = await redis.get(key);
  if (data) {
    await redis.expire(key, STATE_EXPIRY);
  }
};

/**
 * Validate session token to prevent hijacking (Issue #4)
 */
export const validateSession = async (
  telegramId: string,
  messageId?: number
): Promise<boolean> => {
  const state = await getState(telegramId);

  // Check if state is too old (30 min idle = suspicious)
  if (state.createdAt) {
    const age = Date.now() - state.createdAt;
    if (age > 30 * 60 * 1000 && state.step !== 'idle') {
      logger.warn({ telegramId, age }, 'Session too old, resetting');
      await resetState(telegramId);
      return false;
    }
  }

  return true;
};

/**
 * Acquire a distributed lock for critical operations (Issue #1)
 */
export const acquireUserLock = async (
  telegramId: string,
  operation: string,
  ttlSeconds: number = 10
): Promise<string | null> => {
  const lockKey = `bot:userlock:${telegramId}:${operation}`;
  const lockValue = crypto.randomUUID();

  const acquired = await redis.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX');
  return acquired ? lockValue : null;
};

/**
 * Release a distributed lock
 */
export const releaseUserLock = async (
  telegramId: string,
  operation: string,
  lockValue: string
): Promise<void> => {
  const lockKey = `bot:userlock:${telegramId}:${operation}`;
  const current = await redis.get(lockKey);
  if (current === lockValue) {
    await redis.del(lockKey);
  }
};
