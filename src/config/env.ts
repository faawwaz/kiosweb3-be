import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),

  // Database
  DATABASE_URL: z.string(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Auth.js
  AUTH_SECRET: z.string().min(32),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_BOT_SECRET: z.string().optional(),

  // Midtrans
  MIDTRANS_SERVER_KEY: z.string(),
  MIDTRANS_CLIENT_KEY: z.string(),
  MIDTRANS_IS_PRODUCTION: z.string().default('false').transform((v) => v === 'true'),
  MIDTRANS_MERCHANT_ID: z.string(),

  // Hot Wallet Private Keys
  HOT_WALLET_PRIVATE_KEY_BSC: z.string().optional(),
  HOT_WALLET_PRIVATE_KEY_ETH: z.string().optional(),
  HOT_WALLET_PRIVATE_KEY_BASE: z.string().optional(),

  // Wallet Encryption Key (Required for blockchain operations)
  WALLET_ENCRYPTION_KEY: z.string().min(32, 'WALLET_ENCRYPTION_KEY must be at least 32 characters'),

  // Pricing
  DEFAULT_MARKUP_PERCENT: z.string().default('8').transform(Number),
  USD_IDR_RATE: z.string().default('15800').transform(Number),

  // RPC URLs
  RPC_URL_BSC: z.string().default('https://bsc-dataseed.binance.org'),
  RPC_URL_ETH: z.string().default('https://eth.llamarpc.com'),
  RPC_URL_BASE: z.string().default('https://mainnet.base.org'),

  // App URL
  APP_URL: z.string().default('http://localhost:3000'),

  // CORS Allowed Origins (comma-separated for multiple origins)
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // SMTP Mailer
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.string().default('587').transform(Number),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('EceranStore <no-reply@eceran.store>'),

  // Monitoring (Sentry)
  SENTRY_DSN: z.string().optional(), // Optional for local dev/build
  SENTRY_ENVIRONMENT: z.string().default('production'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
