import { router } from '../trpc.js';
import { authRouter } from './auth.js';
import { userRouter } from './user.js';
import { walletRouter } from './wallet.js';

export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  wallet: walletRouter,
});

export type AppRouter = typeof appRouter;
