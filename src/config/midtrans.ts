import { env } from './env.js';

export const midtransConfig = {
  serverKey: env.MIDTRANS_SERVER_KEY,
  clientKey: env.MIDTRANS_CLIENT_KEY,
  isProduction: env.MIDTRANS_IS_PRODUCTION,
  merchantId: env.MIDTRANS_MERCHANT_ID,

  // API URLs
  get apiUrl() {
    return this.isProduction
      ? 'https://api.midtrans.com'
      : 'https://api.sandbox.midtrans.com';
  },

  get snapUrl() {
    return this.isProduction
      ? 'https://app.midtrans.com/snap/snap.js'
      : 'https://app.sandbox.midtrans.com/snap/snap.js';
  },

  // Payment expiry in minutes
  paymentExpiryMinutes: 15,
};
