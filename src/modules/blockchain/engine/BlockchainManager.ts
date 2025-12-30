import { prisma } from '../../../libs/prisma.js';
import { logger } from '../../../libs/logger.js';
import { EvmProvider } from './EvmProvider.js';
import { WalletManager } from './WalletManager.js';
import { Chain, Token } from '@prisma/client';

export class BlockchainManager {
    private static instance: BlockchainManager;
    private providers: Map<string, EvmProvider> = new Map();
    private tokens: Map<string, Token[]> = new Map(); // ChainId -> Tokens
    private privateKeys: Map<string, string> = new Map(); // ChainId -> Decrypted Key (In Memory Securely)

    private constructor() { }

    public static getInstance(): BlockchainManager {
        if (!BlockchainManager.instance) {
            BlockchainManager.instance = new BlockchainManager();
        }
        return BlockchainManager.instance;
    }

    /**
     * Initialize Engine: Load active chains from DB
     */
    public async init() {
        try {
            logger.info('⛓️ Initializing Blockchain Enginer...');
            const start = Date.now();

            const chains = await prisma.chain.findMany({
                where: { isActive: true },
                include: { tokens: { where: { isActive: true } } }
            });

            this.providers.clear();
            this.tokens.clear();
            this.privateKeys.clear();

            for (const chain of chains) {
                // 1. Setup Provider
                if (chain.type === 'EVM') {
                    const provider = new EvmProvider(chain);
                    this.providers.set(chain.slug, provider);
                    this.providers.set(chain.id, provider); // Support access by ID too
                }

                // 2. Cache Tokens
                this.tokens.set(chain.slug, chain.tokens);
                this.tokens.set(chain.id, chain.tokens);

                // 3. Decrypt Wallet (Env Reference Pattern)
                try {
                    // Step A: Decrypt the content from DB
                    // The DB content is ALWAYS encrypted. 
                    // It can decrypt to: "0x123..." (Raw Key) OR "ENV:HOT_WALLET_BSC" (Reference)
                    const decryptedContent = await WalletManager.decrypt(chain.encryptedPrivateKey);

                    let privateKey = '';

                    // Step B: Check if it's a reference to an Env Var
                    if (decryptedContent.startsWith('ENV:')) {
                        const envVarName = decryptedContent.split(':')[1];
                        const envValue = process.env[envVarName];

                        if (envValue) {
                            privateKey = envValue;
                        } else {
                            logger.error({ chain: chain.slug, envVar: envVarName }, 'Referenced Env Var not found');
                        }
                    } else {
                        // It's a raw private key (Legacy compatibility)
                        privateKey = decryptedContent;
                    }

                    if (privateKey) {
                        this.privateKeys.set(chain.slug, privateKey);
                        this.privateKeys.set(chain.id, privateKey);
                    } else {
                        logger.warn({ chain: chain.slug }, '⚠️ No Private Key found (Check ENV or DB)');
                    }

                } catch (e) {
                    logger.error({ chain: chain.slug, error: (e as Error).message }, 'Failed to load wallet');
                }
            }

            logger.info({
                count: chains.length,
                duration: `${Date.now() - start}ms`
            }, '✅ Blockchain Engine Ready');

        } catch (error) {
            logger.error({ error }, '❌ Fatal: Failed to initialize Blockchain Engine');
            // Do not throw, allow server to start but log fatal error
        }
    }

    /**
     * Get Provider for a chain (slug or UUID)
     */
    public getProvider(chainRef: string): EvmProvider {
        const provider = this.providers.get(chainRef);
        if (!provider) {
            throw new Error(`Blockchain Provider not found for: ${chainRef}`);
        }
        return provider;
    }

    /**
     * Get Private Key (Internal Use Only)
     */
    public getPrivateKey(chainRef: string): string {
        const key = this.privateKeys.get(chainRef);
        if (!key) throw new Error(`Wallet not loaded for chain: ${chainRef}`);
        return key;
    }

    /**
     * Refresh Config (Call this after Admin Config Change)
     */
    public async refresh() {
        await this.init();
    }
}

export const blockchainManager = BlockchainManager.getInstance();
