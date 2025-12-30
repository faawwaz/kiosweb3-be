import { customAlphabet } from 'nanoid';

// Referral code generator - uppercase alphanumeric, easy to read
const referralAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const generateReferralCode = customAlphabet(referralAlphabet, 8);

// Voucher code generator
const voucherAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
export const generateVoucherCode = customAlphabet(voucherAlphabet, 12);

// OTP generator - 6 digits
const otpAlphabet = '0123456789';
export const generateOTP = customAlphabet(otpAlphabet, 6);

// Order ID generator for Midtrans
const orderIdAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
export const generateOrderId = customAlphabet(orderIdAlphabet, 16);
