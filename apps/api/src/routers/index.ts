import { router } from '../trpc.js';
import { authRouter } from './auth.js';
import { feedRouter } from './feed.js';
import { matchmakingRouter } from './matchmaking.js';
import { tribesRouter } from './tribes.js';
import { userRouter } from './user.js';
import { walletRouter } from './wallet.js';

export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  wallet: walletRouter,
  tribes: tribesRouter,
  matchmaking: matchmakingRouter,
  feed: feedRouter,
});

export type AppRouter = typeof appRouter;
