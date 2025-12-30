import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import * as dotenv from 'dotenv';

import path from 'path';

// Load envs with priority
dotenv.config({ path: path.resolve(process.cwd(), '.env.production') });
dotenv.config();

const prisma = new PrismaClient();

const ENCRYPTION_KEY =
    process.env.WALLET_ENCRYPTION_KEY ||
    'default-key-must-be-32-bytes-change-it';

// ensure key is 32 bytes for AES-256
const KEY_BUFFER = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);

function encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', KEY_BUFFER, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

async function main() {
    console.log('Starting MAINNET Seed...');


    /**
     * ======================
     * CHAINS (MAINNET)
     * ======================
     */

    // 1. BSC MAINNET
    const bsc = await prisma.chain.upsert({
        where: { slug: 'bsc' },
        update: {
            rpcUrl: process.env.RPC_URL_BSC || 'https://bsc-dataseed.binance.org',
            chainId: 56,
            explorerUrl: 'https://bscscan.com',
            name: 'BNB Smart Chain',
            encryptedPrivateKey: encrypt('ENV:HOT_WALLET_PRIVATE_KEY_BSC')
        },
        create: {
            name: 'BNB Smart Chain',
            slug: 'bsc',
            type: 'EVM',
            rpcUrl:
                process.env.RPC_URL_BSC ||
                'https://bsc-dataseed.binance.org',
            explorerUrl: 'https://bscscan.com',
            chainId: 56,
            encryptedPrivateKey: encrypt('ENV:HOT_WALLET_PRIVATE_KEY_BSC'),
            isActive: true
        }
    });
    console.log('✅ BSC Mainnet upserted');

    // 2. POLYGON MAINNET
    const polygon = await prisma.chain.upsert({
        where: { slug: 'polygon' },
        update: {
            rpcUrl: process.env.RPC_URL_POLYGON || 'https://polygon-rpc.com',
            chainId: 137,
            explorerUrl: 'https://polygonscan.com',
            name: 'Polygon',
            encryptedPrivateKey: encrypt('ENV:HOT_WALLET_PRIVATE_KEY_POLYGON')
        },
        create: {
            name: 'Polygon',
            slug: 'polygon',
            type: 'EVM',
            rpcUrl:
                process.env.RPC_URL_POLYGON ||
                'https://polygon-rpc.com',
            explorerUrl: 'https://polygonscan.com',
            chainId: 137,
            encryptedPrivateKey: encrypt('ENV:HOT_WALLET_PRIVATE_KEY_POLYGON'),
            isActive: true
        }
    });
    console.log('✅ Polygon Mainnet upserted');

    // 3. BASE MAINNET
    const base = await prisma.chain.upsert({
        where: { slug: 'base' },
        update: {
            rpcUrl: process.env.RPC_URL_BASE || 'https://mainnet.base.org',
            chainId: 8453,
            explorerUrl: 'https://basescan.org',
            name: 'Base',
            encryptedPrivateKey: encrypt('ENV:HOT_WALLET_PRIVATE_KEY_BASE')
        },
        create: {
            name: 'Base',
            slug: 'base',
            type: 'EVM',
            rpcUrl:
                process.env.RPC_URL_BASE ||
                'https://mainnet.base.org',
            explorerUrl: 'https://basescan.org',
            chainId: 8453,
            encryptedPrivateKey: encrypt('ENV:HOT_WALLET_PRIVATE_KEY_BASE'),
            isActive: true
        }
    });
    console.log('✅ Base Mainnet upserted');

    /**
     * ======================
     * NATIVE TOKENS
     * ======================
     */

    await seedToken(bsc.id, 'BNB', 'BNB Coin', true, 18);
    await seedToken(polygon.id, 'ETH', 'Ethereum', true, 18);
    await seedToken(base.id, 'ETH', 'Ethereum', true, 18);

    console.log('MAINNET Seeding finished.');
}

async function seedToken(
    chainId: string,
    symbol: string,
    name: string,
    isNative: boolean,
    decimals: number
) {
    try {
        await prisma.token.upsert({
            where: {
                chainId_symbol: {
                    chainId,
                    symbol
                }
            },
            update: {},
            create: {
                chainId,
                symbol,
                name,
                isNative,
                decimals,
                isActive: true
            }
        });

        console.log(`   🔸 Token ${symbol} seeded.`);
    } catch (e) {
        console.error(`   ❌ Failed to seed token ${symbol}`, e);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
