import { router } from "./trpc";
import { playlistRouter } from "./routers/playlist";
import { userRouter } from "./routers/user";
import { subscriptionRouter } from "./routers/subscription";

export const appRouter = router({
  playlist: playlistRouter,
  user: userRouter,
  subscription: subscriptionRouter,
});

export type AppRouter = typeof appRouter;
