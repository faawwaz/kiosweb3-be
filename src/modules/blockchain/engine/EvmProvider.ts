import { ethers } from 'ethers';
import { Chain } from '@prisma/client';
import { logger } from '../../../libs/logger.js';

export class EvmProvider {
    public provider: ethers.Provider;
    public chainConfig: Chain;

    constructor(chainConfig: Chain) {
        this.chainConfig = chainConfig;

        // Force Static Network to prevent auto-detection spam
        const network = chainConfig.chainId ? ethers.Network.from(Number(chainConfig.chainId)) : undefined;
        const staticNetworkOpts = { staticNetwork: !!network };

        // Support Multiple RPCs (Comma Separated)
        const rpcUrls = chainConfig.rpcUrl.split(',').map(url => url.trim()).filter(url => url.length > 0);

        if (rpcUrls.length > 1) {
            // High Availability: Fallback Provider
            const providers = rpcUrls.map(url => new ethers.JsonRpcProvider(url, network, staticNetworkOpts));
            this.provider = new ethers.FallbackProvider(providers, 1); // Quorum 1 (Fastest wins usually)
        } else {
            // Single RPC
            this.provider = new ethers.JsonRpcProvider(rpcUrls[0], network, staticNetworkOpts);
        }
    }

    /**
     * Check if RPC is alive
     */
    async checkConnection(): Promise<boolean> {
        try {
            const network = await this.provider.getNetwork();
            logger.info({ chain: this.chainConfig.slug, chainId: network.chainId }, 'RPC Connected');
            return true;
        } catch (error) {
            logger.error({ chain: this.chainConfig.slug, error: (error as Error).message }, 'RPC Connection Failed');
            return false;
        }
    }

    /**
     * Get Native Balance
     */
    async getBalance(address: string): Promise<bigint> {
        return await this.provider.getBalance(address);
    }

    // TODO: Add ERC20 methods here...
}
