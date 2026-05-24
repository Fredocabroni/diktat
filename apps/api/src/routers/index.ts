import { router } from '../trpc.js';
import { authRouter } from './auth.js';
import { battlesRouter } from './battles.js';
import { debatesRouter } from './debates.js';
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
  battles: battlesRouter,
  debates: debatesRouter,
  feed: feedRouter,
});

export type AppRouter = typeof appRouter;
