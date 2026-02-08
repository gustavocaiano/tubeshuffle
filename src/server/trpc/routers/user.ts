import { router, protectedProcedure } from "../trpc";

export const userRouter = router({
  /**
   * Get the current user's profile with subscription details.
   */
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      include: {
        _count: { select: { playlists: true } },
      },
    });

    if (!user) {
      return null;
    }

    const maxPlaylists =
      user.subscription === "PREMIUM"
        ? parseInt(process.env.MAX_PREMIUM_PLAYLISTS ?? "50", 10)
        : parseInt(process.env.MAX_FREE_PLAYLISTS ?? "3", 10);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      subscription: user.subscription,
      playlistCount: user._count.playlists,
      maxPlaylists,
      createdAt: user.createdAt,
    };
  }),

  /**
   * Get playlist analytics for the user (premium).
   */
  getAnalytics: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
    });

    if (user?.subscription !== "PREMIUM") {
      return null;
    }

    const totalPlays = await ctx.db.playHistory.count({
      where: { userId: ctx.session.user.id },
    });

    const completedPlays = await ctx.db.playHistory.count({
      where: { userId: ctx.session.user.id, completed: true },
    });

    const mostPlayed = await ctx.db.playHistory.groupBy({
      by: ["videoId"],
      where: { userId: ctx.session.user.id },
      _count: { videoId: true },
      orderBy: { _count: { videoId: "desc" } },
      take: 10,
    });

    const mostPlayedVideos = await ctx.db.video.findMany({
      where: { id: { in: mostPlayed.map((mp) => mp.videoId) } },
    });

    return {
      totalPlays,
      completedPlays,
      completionRate:
        totalPlays > 0
          ? Math.round((completedPlays / totalPlays) * 100)
          : 0,
      mostPlayed: mostPlayed.map((mp) => ({
        video: mostPlayedVideos.find((v) => v.id === mp.videoId),
        playCount: mp._count.videoId,
      })),
    };
  }),
});
