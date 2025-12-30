import { redis } from '../libs/redis.js';
import { generateOTP } from './crypto.js';

const OTP_PREFIX = 'otp:';
const OTP_EXPIRY_SECONDS = 300; // 5 minutes

export interface OTPData {
  code: string;
  purpose: 'link_telegram' | 'verify_email';
  userId?: string;
  telegramId?: string;
}

/**
 * Generate and store OTP
 */
export const createOTP = async (
  identifier: string,
  data: Omit<OTPData, 'code'>
): Promise<string> => {
  const code = generateOTP();
  const key = `${OTP_PREFIX}${identifier}:${code}`;

  await redis.setex(key, OTP_EXPIRY_SECONDS, JSON.stringify({ ...data, code }));

  return code;
};

/**
 * Verify OTP
 */
export const verifyOTP = async (
  identifier: string,
  code: string
): Promise<OTPData | null> => {
  const key = `${OTP_PREFIX}${identifier}:${code}`;
  const data = await redis.get(key);

  if (!data) {
    return null;
  }

  // Delete OTP after successful verification
  await redis.del(key);

  return JSON.parse(data) as OTPData;
};

/**
 * Delete all OTPs for an identifier
 */
export const invalidateOTPs = async (identifier: string): Promise<void> => {
  const pattern = `${OTP_PREFIX}${identifier}:*`;
  const keys = await redis.keys(pattern);

  if (keys.length > 0) {
    await redis.del(...keys);
  }
};
