import { router } from '../trpc.js';
import { authRouter } from './auth.js';
import { battlesRouter } from './battles.js';
import { debatesRouter } from './debates.js';
import { factCheckRouter } from './fact-check.js';
import { feedRouter } from './feed.js';
import { matchmakingRouter } from './matchmaking.js';
import { pushSubscriptionsRouter } from './push-subscriptions.js';
import { reportsRouter } from './reports.js';
import { take5Router } from './take5.js';
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
  factCheck: factCheckRouter,
  feed: feedRouter,
  pushSubscriptions: pushSubscriptionsRouter,
  reports: reportsRouter,
  take5: take5Router,
});

export type AppRouter = typeof appRouter;
