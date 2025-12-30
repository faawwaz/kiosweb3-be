import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middlewares/auth.middleware.js';
import * as usersService from './users.service.js';


const router = Router();

/**
 * GET /api/users/me
 * Get current user profile
 */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const user = await usersService.findUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stats = await usersService.getUserStats(userId);

    return res.json({
      user: {
        id: user.id,
        name: user.name, // Added Name
        email: user.email,
        telegramId: user.telegramId,
        telegramUsername: user.telegramUsername,
        referralCode: user.referralCode,
        createdAt: user.createdAt,
      },
      stats,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get user profile' });
  }
});

/**
 * PUT /api/users/me
 * Update current user profile
 */
router.put('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { email, name } = req.body;

    const user = await usersService.updateUser(userId, { email, name });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        telegramId: user.telegramId,
        telegramUsername: user.telegramUsername,
        referralCode: user.referralCode,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update user profile' });
  }
});



export default router;
