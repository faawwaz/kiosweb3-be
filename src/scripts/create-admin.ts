import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';

// Load env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const prisma = new PrismaClient();

async function main() {
    const email = process.argv[2];
    const password = process.argv[3];

    if (!email || !password) {
        console.error('Usage: npx tsx src/scripts/create-admin.ts <email> <password>');
        process.exit(1);
    }

    console.log(`Making ${email} an ADMIN...`);

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.upsert({
        where: { email },
        update: {
            role: 'ADMIN',
            password: hashedPassword
        },
        create: {
            email,
            password: hashedPassword,
            name: 'Super Admin',
            role: 'ADMIN',
            referralCode: 'ADMIN001'
        }
    });

    console.log(`✅ Success! User ${user.email} is now an ADMIN.`);
    console.log(`🆔 ID: ${user.id}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
