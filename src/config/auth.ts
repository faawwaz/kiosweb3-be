import { env } from './env.js';

export const authConfig = {
  secret: env.AUTH_SECRET,
  google: {
    clientId: env.AUTH_GOOGLE_ID,
    clientSecret: env.AUTH_GOOGLE_SECRET,
  },
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    webhookSecret: env.TELEGRAM_BOT_SECRET,
  },
  referral: {
    codeLength: 8,
    rewardVoucherValue: 10000, // Rp10.000
    minOrdersForValidation: 1,
  },
};
