import crypto from 'crypto';
import axios from 'axios';
import { Order } from '@prisma/client';
import { midtransConfig } from '../../config/midtrans.js';
import { logger } from '../../libs/logger.js';
import { generateOrderId } from '../../utils/crypto.js';
import { prisma } from '../../libs/prisma.js';

export interface CreatePaymentResult {
  orderId: string;
  paymentUrl: string;
  token: string;
}

export interface MidtransNotification {
  order_id: string;
  transaction_status: string;
  fraud_status?: string;
  gross_amount: string;
  signature_key: string;
  status_code: string;
  payment_type: string;
  transaction_id: string;
  transaction_time: string;
}

import QRCode from 'qrcode';

export interface PaymentResult {
  orderId: string;
  paymentUrl?: string; // For E-Wallet (Snap)
  qrCodeUrl?: string;  // For QRIS (Result from Midtrans)
  qrImage?: string;    // Base64 Image of QR Code
  fee: number;
  total: number;
}

/**
 * GENERATE QR CODE IMAGE (Helper)
 */
const generateQrCodeImage = async (qrString: string): Promise<string> => {
  try {
    return await QRCode.toDataURL(qrString);
  } catch (err) {
    logger.error({ err }, 'Failed to generate QR Image');
    return '';
  }
};

/**
 * Get customer email for payment (falls back to default if not found)
 */
const getCustomerEmail = async (userId: string): Promise<string> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true }
    });
    return user?.email || 'customer@kiosweb3.com';
  } catch {
    return 'customer@kiosweb3.com';
  }
};

/**
 * Get customer name for payment
 */
const getCustomerName = async (userId: string): Promise<string> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true }
    });
    return user?.name || 'Customer';
  } catch {
    return 'Customer';
  }
};

/**
 * 1. CREATE DIRECT QRIS (Core API) - NO FEE
 */
export const createQrisPayment = async (order: Order): Promise<PaymentResult> => {
  const midtransOrderId = `ES-${generateOrderId()}`;
  const auth = Buffer.from(`${midtransConfig.serverKey}:`).toString('base64');

  // Fetch actual customer details
  const customerEmail = await getCustomerEmail(order.userId);
  const customerName = await getCustomerName(order.userId);

  const payload = {
    payment_type: 'qris',
    transaction_details: {
      order_id: midtransOrderId,
      gross_amount: order.amountIdr, // NO FEE
    },
    item_details: [{
      id: order.chain,
      name: `${order.symbol} Token`,
      price: order.amountIdr,
      quantity: 1,
    }],
    customer_details: {
      first_name: customerName.split(' ')[0] || 'Customer',
      last_name: customerName.split(' ').slice(1).join(' ') || '',
      email: customerEmail,
    },
    qris: { acquirer: 'gopay' } // Default acquirer
  };

  try {
    const response = await axios.post(
      `${midtransConfig.apiUrl}/v2/charge`,
      payload,
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );

    // Core API Returns 'qr_string' (Raw Payload) OR 'actions'
    const qrStringRaw = response.data.qr_string;
    const actions = response.data.actions || [];
    const qrAction = actions.find((a: any) => a.name === 'generate-qr-code');
    const qrUrlHosted = qrAction ? qrAction.url : '';

    let qrImage = '';
    let finalQrString = '';

    if (qrStringRaw) {
      // Best Case: We have raw string. Generate Image locally.
      finalQrString = qrStringRaw;
      qrImage = await generateQrCodeImage(qrStringRaw);
    } else if (qrUrlHosted) {
      // Fallback: Use Midtrans Hosted Image URL directly
      // Do NOT re-encode this as a QR. It IS the image.
      finalQrString = qrUrlHosted;
      qrImage = qrUrlHosted; // Ideally frontend loads this, but if we need base64 we'd need to fetch it. 
      // For Bot, we can send URL. For Web, URL works.
    } else {
      throw new Error('No QR String or URL returned from Midtrans');
    }

    return {
      orderId: midtransOrderId,
      qrCodeUrl: finalQrString, // Raw String or Hosted URL
      qrImage, // Base64 (if raw) or URL (if hosted)
      paymentUrl: undefined,
      fee: 0,
      total: order.amountIdr
    };

  } catch (error: any) {
    logger.error({ error: error.response?.data || error, orderId: order.id }, 'QRIS Charge Failed');
    throw new Error('Failed to generate QRIS');
  }
};

/**
 * 2. CREATE SNAP BANK TRANSFER (VA) - FIXED FEE Rp 4.000
 */
export const createSnapBankPayment = async (order: Order): Promise<PaymentResult> => {
  const midtransOrderId = `ES-${generateOrderId()}`;
  const auth = Buffer.from(`${midtransConfig.serverKey}:`).toString('base64');

  const fee = 4000; // Fixed Fee Rp 4.000
  const total = order.amountIdr + fee;

  // Fetch actual customer details
  const customerEmail = await getCustomerEmail(order.userId);
  const customerName = await getCustomerName(order.userId);

  const payload = {
    transaction_details: {
      order_id: midtransOrderId,
      gross_amount: total, // WITH FEE
    },
    enabled_payments: ['bca_va', 'bni_va', 'bri_va', 'permata_va', 'cimb_va', 'other_va'], // VIRTUAL ACCOUNTS
    // item_details must match gross_amount. Add Fee Item.
    item_details: [
      {
        id: order.chain,
        name: `${order.symbol} Token`,
        price: order.amountIdr,
        quantity: 1,
      },
      {
        id: 'FEE-VA',
        name: 'Biaya Admin Bank',
        price: fee,
        quantity: 1
      }
    ],
    customer_details: {
      first_name: customerName.split(' ')[0] || 'Customer',
      last_name: customerName.split(' ').slice(1).join(' ') || '',
      email: customerEmail,
    },
    expiry: { unit: 'minutes', duration: midtransConfig.paymentExpiryMinutes }
  };

  try {
    const response = await axios.post(
      `${midtransConfig.apiUrl}/snap/v1/transactions`,
      payload,
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } }
    );

    return {
      orderId: midtransOrderId,
      paymentUrl: response.data.redirect_url, // LINK
      qrImage: undefined,
      fee,
      total
    };

  } catch (error: any) {
    logger.error({ error: error.response?.data || error, orderId: order.id }, 'Snap E-Wallet Failed');
    throw new Error('Failed to create E-Wallet Link');
  }
};

// Deprecated old createPayment
export const createPayment = async (order: Order) => { return createSnapBankPayment(order); };

/**
 * Verify Midtrans signature
 */
export const verifySignature = (notification: MidtransNotification): boolean => {
  const { order_id, status_code, gross_amount, signature_key } = notification;

  const signatureString = `${order_id}${status_code}${gross_amount}${midtransConfig.serverKey}`;
  const expectedSignature = crypto
    .createHash('sha512')
    .update(signatureString)
    .digest('hex');

  return signature_key === expectedSignature;
};

/**
 * Check if transaction is successful
 */
export const isTransactionSuccess = (notification: MidtransNotification): boolean => {
  const { transaction_status, fraud_status } = notification;

  if (transaction_status === 'capture') {
    return fraud_status === 'accept';
  }

  return (
    transaction_status === 'settlement' ||
    transaction_status === 'paid'
  );
};

/**
 * Check if transaction is pending
 */
export const isTransactionPending = (notification: MidtransNotification): boolean => {
  return notification.transaction_status === 'pending';
};

/**
 * Check if transaction is failed/cancelled
 */
export const isTransactionFailed = (notification: MidtransNotification): boolean => {
  return (
    notification.transaction_status === 'deny' ||
    notification.transaction_status === 'cancel' ||
    notification.transaction_status === 'expire' ||
    notification.transaction_status === 'failure'
  );
};

/**
 * Get transaction status from Midtrans
 */
export const getTransactionStatus = async (
  midtransOrderId: string
): Promise<MidtransNotification> => {
  const auth = Buffer.from(`${midtransConfig.serverKey}:`).toString('base64');

  const response = await axios.get(
    `${midtransConfig.apiUrl}/v2/${midtransOrderId}/status`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    }
  );

  return response.data;
};
