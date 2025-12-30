import { Router, Request, Response } from 'express';
import { prisma } from '../../libs/prisma.js';
import { logger } from '../../libs/logger.js';
import * as usersService from '../users/users.service.js';
import { authLimiter } from '../../middlewares/rate-limit.middleware.js';
import { generateToken } from '../../utils/jwt.js';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import { OAuth2Client } from 'google-auth-library';
import bcrypt from 'bcryptjs';
import { redis } from '../../libs/redis.js';
import { sendOtpEmail } from '../../services/mailer.service.js';

const router = Router();
const googleClient = new OAuth2Client(process.env.AUTH_GOOGLE_ID);

const OTP_PREFIX = 'api:otp:reg:';
const OTP_EXPIRY = 300; // 5 minutes

/**
 * 1A. REGISTER INIT (Input Details -> Send OTP)
 */
router.post('/register/init', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password, name, referralCode } = req.body;

    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Valid email and password (min 6 chars) required' });
    }

    // Check availability
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already registered. Please Login or Reset Password.' });

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Hash Password NOW
    const hashedPassword = await bcrypt.hash(password, 10);

    // Save Temporary Registration Data to Redis
    const regData = {
      email,
      password: hashedPassword,
      name: name || email.split('@')[0],
      referralCode,
      otp
    };

    await redis.setex(`${OTP_PREFIX}${email}`, OTP_EXPIRY, JSON.stringify(regData));

    // Send Email
    await sendOtpEmail(email, otp);

    return res.json({ message: 'OTP sent to email. Please verify to activate account.' });
  } catch (error) {
    logger.error({ error }, 'Register Init error');
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

/**
 * 1B. REGISTER COMPLETE (Verify OTP & Activate)
 */
router.post('/register/complete', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP required' });
    }

    // Retrieve pending data
    const storedData = await redis.get(`${OTP_PREFIX}${email}`);
    if (!storedData) {
      return res.status(400).json({ error: 'Registration session expired. Please register again.' });
    }

    const regData = JSON.parse(storedData);

    // Verify OTP
    if (regData.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // Double check user existence (race condition)
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Create User (Password already hashed in Redis data)
    const user = await usersService.createUser({
      email: regData.email,
      password: regData.password,
      name: regData.name,
      referredByCode: regData.referralCode,
    });

    // Clear Redis
    await redis.del(`${OTP_PREFIX}${email}`);

    const token = generateToken(user.id);
    const { password: _, ...userSafe } = user as any;

    return res.status(201).json({
      message: 'Registration successful',
      token,
      user: userSafe
    });

  } catch (error) {
    logger.error({ error }, 'Registration error');
    return res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * 2. LOGIN (Email/Password)
 */
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userAny = user as any;
    if (!userAny.password) {
      return res.status(401).json({ error: 'Please login with Google or Reset Password' });
    }

    const validPassword = await bcrypt.compare(password, userAny.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user.id);
    const { password: _, ...userSafe } = userAny;

    return res.json({
      message: 'Login successful',
      token,
      user: userSafe
    });

  } catch (error) {
    logger.error({ error }, 'Login error');
    return res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * 3. GOOGLE OAUTH (Token Exchange)
 */
router.post('/google', authLimiter, async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Google ID Token required' });

    // Verify Token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.AUTH_GOOGLE_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Invalid Google Token' });
    }

    const { email, sub: googleId, name } = payload;

    // Check DB
    let user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      // LINK ACCOUNT & LOGIN
      if (user.googleId !== googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { googleId }
        });
        logger.info({ userId: user.id }, 'Linked existing account with Google');
      }
    } else {
      // REGISTER NEW USER
      user = await usersService.createUser({
        email,
        name: name || 'Google User',
        googleId,
      });
    }

    const token = generateToken(user.id);
    const { password: _, ...userSafe } = user as any;

    return res.json({
      message: 'Google Login successful',
      token,
      user: userSafe
    });

  } catch (error) {
    logger.error({ error }, 'Google Auth error');
    return res.status(401).json({ error: 'Google authentication failed' });
  }
});

/**
 * 4. GENERATE LINK CODE (Web -> Bot)
 * New Secure Flow: User generates code in Web, inputs in Bot.
 * Issue #7: Use crypto for secure generation, shorter expiry
 */
router.post('/link/generate-code', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const LinkCodeExpiry = 600; // 10 mins (reduced from 15)
    const MAX_RETRIES = 10;

    // Issue #7: Check rate limit - max 3 codes per 10 minutes per user
    const rateLimitKey = `link_code_rate:${userId}`;
    const currentCount = await redis.incr(rateLimitKey);
    if (currentCount === 1) {
      await redis.expire(rateLimitKey, 600); // 10 minute window
    }
    if (currentCount > 3) {
      return res.status(429).json({
        error: 'Terlalu banyak permintaan. Coba lagi dalam 10 menit.'
      });
    }

    let code: string | null = null;

    // Issue #7: Use crypto.randomInt for secure generation
    const crypto = await import('crypto');

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Cryptographically secure random 6-digit number
      const candidate = crypto.randomInt(100000, 1000000).toString();
      const existingKey = `link_code:${candidate}`;

      // Atomic check-and-set to prevent TOCTOU race
      const setResult = await redis.set(existingKey, userId, 'EX', LinkCodeExpiry, 'NX');
      if (setResult) {
        code = candidate;
        break;
      }

      logger.debug({ attempt, candidate }, 'Link code collision, retrying');
    }

    if (!code) {
      // Fallback: Use more random bytes for guaranteed uniqueness
      const bytes = crypto.randomBytes(4);
      const num = (bytes.readUInt32BE(0) % 900000) + 100000;
      code = num.toString();

      // Force set even if collision (user can always regenerate)
      await redis.setex(`link_code:${code}`, LinkCodeExpiry, userId);
      logger.warn({ userId }, 'Used fallback link code generation after max retries');
    }

    return res.json({
      code,
      expiresIn: LinkCodeExpiry,
      message: 'Kode berhasil dibuat. Masukkan kode ini di Telegram Bot.'
    });
  } catch (error) {
    logger.error({ error }, 'Generate Link Code error');
    return res.status(500).json({ error: 'Gagal membuat kode' });
  }
});

/**
 * 5. FORGOT PASSWORD (Request OTP)
 */
router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save to Redis (Prefix beda biar gak bentrok sama register)
    const RESET_PREFIX = 'api:otp:reset:';
    await redis.setex(`${RESET_PREFIX}${email}`, OTP_EXPIRY, otp);

    // Send Email
    await sendOtpEmail(email, otp);

    return res.json({ message: 'OTP sent to email. Please verify to reset password.' });

  } catch (error) {
    logger.error({ error }, 'Forgot Password error');
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

/**
 * 6. RESET PASSWORD (Verify OTP & Set New Password)
 */
router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Email, OTP, and New Password (min 6 chars) required' });
    }

    const RESET_PREFIX = 'api:otp:reset:';
    const storedOtp = await redis.get(`${RESET_PREFIX}${email}`);

    if (!storedOtp || storedOtp !== otp) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword }
    });

    // Clear OTP
    await redis.del(`${RESET_PREFIX}${email}`);

    return res.json({ message: 'Password reset successful. You can now login.' });

  } catch (error) {
    logger.error({ error }, 'Reset Password error');
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;
