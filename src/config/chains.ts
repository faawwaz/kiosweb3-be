import { env } from './env.js';

export type ChainId = 'bsc' | 'eth' | 'base';

export interface ChainConfig {
  id: ChainId;
  name: string;
  symbol: string;
  rpcUrl: string;
  explorerUrl: string;
  chainId: number;
  decimals: number;
}

export const chains: Record<ChainId, ChainConfig> = {
  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    symbol: 'BNB',
    rpcUrl: env.RPC_URL_BSC,
    explorerUrl: 'https://bscscan.com',
    chainId: 56,
    decimals: 18,
  },
  eth: {
    id: 'eth',
    name: 'Ethereum',
    symbol: 'ETH',
    rpcUrl: env.RPC_URL_ETH,
    explorerUrl: 'https://etherscan.io',
    chainId: 1,
    decimals: 18,
  },
  base: {
    id: 'base',
    name: 'Base',
    symbol: 'ETH',
    rpcUrl: env.RPC_URL_BASE,
    explorerUrl: 'https://basescan.org',
    chainId: 8453,
    decimals: 18,
  },
};

export const getChain = (chainId: ChainId): ChainConfig => {
  const chain = chains[chainId];
  if (!chain) {
    throw new Error(`Invalid chain: ${chainId}`);
  }
  return chain;
};

export const getExplorerTxUrl = (chainId: ChainId, txHash: string): string => {
  const chain = getChain(chainId);
  return `${chain.explorerUrl}/tx/${txHash}`;
};

export const supportedChains = Object.keys(chains) as ChainId[];
