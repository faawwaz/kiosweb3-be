import crypto from 'crypto';
import { promisify } from 'util';
import { logger } from '../../../libs/logger.js';
import { env } from '../../../config/env.js';

const scryptAsync = promisify(crypto.scrypt);

// Use validated env (already validated min 32 chars in env.ts)
const ENCRYPTION_KEY = env.WALLET_ENCRYPTION_KEY;

export class WalletManager {

    /**
     * Decrypt Private Key (Async)
     * Format Input: 
     * - New: "Salt:IV:EncryptedText"
     * - Legacy: "IV:EncryptedText" (Uses default salt)
     */
    static async decrypt(encryptedText: string): Promise<string> {
        try {
            const parts = encryptedText.split(':');

            let salt = 'salt'; // Default Legacy Salt
            let ivHex: string;
            let encryptedHex: string;

            if (parts.length === 3) {
                // New Format: Salt:IV:Encrypted
                salt = parts[0];
                ivHex = parts[1];
                encryptedHex = parts[2];
            } else if (parts.length === 2) {
                // Legacy Format: IV:Encrypted
                ivHex = parts[0];
                encryptedHex = parts[1];
            } else {
                throw new Error('Invalid encrypted format');
            }

            const iv = Buffer.from(ivHex, 'hex');
            const encrypted = Buffer.from(encryptedHex, 'hex');

            // Derive Key specifically for this salt (Async)
            const key = (await scryptAsync(ENCRYPTION_KEY!, salt, 32)) as Buffer;

            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(encrypted);
            decrypted = Buffer.concat([decrypted, decipher.final()]);

            return decrypted.toString();
        } catch (error) {
            logger.error({ error }, 'Failed to decrypt wallet');
            throw new Error('Wallet decryption failed');
        }
    }

    /**
     * Encrypt Private Key (Secure Random Salt - Async)
     * Format: "SaltHex:IVHex:EncryptedTextHex"
     */
    static async encrypt(text: string): Promise<string> {
        // 1. Generate Random Salt
        const salt = crypto.randomBytes(16).toString('hex');

        // 2. Derive Key (Async)
        const key = (await scryptAsync(ENCRYPTION_KEY!, salt, 32)) as Buffer;

        // 3. Encrypt
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text);
        encrypted = Buffer.concat([encrypted, cipher.final()]);

        // 4. Return Format: Salt:IV:Content
        return `${salt}:${iv.toString('hex')}:${encrypted.toString('hex')}`;
    }
}
