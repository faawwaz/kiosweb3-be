import { Decimal } from '@prisma/client/runtime/library';

export interface PriceQuote {
  tokenAmount: Decimal;
  tokenPriceUsd: Decimal;
  usdIdrRate: number;
  markupPercent: number;
  totalIdr: number;
  effectivePriceIdr: Decimal;
}

/**
 * Calculate token amount from IDR
 * Formula: tokenAmount = (IDR / usdIdrRate / tokenPriceUsd) × (1 - markup%)
 */
export const calculateTokenAmount = (
  amountIdr: number,
  tokenPriceUsd: number | Decimal,
  usdIdrRate: number,
  markupPercent: number = 8
): PriceQuote => {
  const tokenPrice = new Decimal(tokenPriceUsd);
  const usdAmount = new Decimal(amountIdr).div(usdIdrRate);
  const markupMultiplier = new Decimal(1).minus(new Decimal(markupPercent).div(100));
  const tokenAmount = usdAmount.div(tokenPrice).mul(markupMultiplier);

  // Effective price per token in IDR (including markup)
  const effectivePriceIdr = tokenPrice.mul(usdIdrRate).div(markupMultiplier);

  return {
    tokenAmount,
    tokenPriceUsd: tokenPrice,
    usdIdrRate,
    markupPercent,
    totalIdr: amountIdr,
    effectivePriceIdr,
  };
};

/**
 * Format token amount for display
 */
export const formatTokenAmount = (amount: Decimal | number, decimals: number = 8): string => {
  const dec = new Decimal(amount);
  return dec.toFixed(decimals);
};

/**
 * Format IDR for display
 */
export const formatIdr = (amount: number): string => {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
};

/**
 * Format USD for display
 */
export const formatUsd = (amount: number | Decimal): string => {
  const num = typeof amount === 'number' ? amount : amount.toNumber();
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
};
