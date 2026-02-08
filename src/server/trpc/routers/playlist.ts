import { z } from "zod/v4";
import { router, protectedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import { extractPlaylistId } from "@/lib/utils";
import { importPlaylist, syncPlaylist, deletePlaylist } from "@/server/services/playlist-service";
import { shuffleVideos } from "@/server/services/shuffle-service";

export const playlistRouter = router({
  /**
   * List all playlists for the current user.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.playlist.findMany({
      where: { userId: ctx.session.user.id },
      include: {
        _count: { select: { videos: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  }),

  /**
   * Get a single playlist with its videos.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const playlist = await ctx.db.playlist.findUnique({
        where: { id: input.id },
        include: {
          videos: { orderBy: { position: "asc" } },
          _count: { select: { playHistory: true } },
        },
      });

      if (!playlist || playlist.userId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Playlist not found.",
        });
      }

      return playlist;
    }),

  /**
   * Import a YouTube playlist by URL.
   */
  import: protectedProcedure
    .input(z.object({ url: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        include: { _count: { select: { playlists: true } } },
      });

      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      }

      // Feature gate: free users limited to 3 playlists
      const maxPlaylists =
        user.subscription === "PREMIUM"
          ? parseInt(process.env.MAX_PREMIUM_PLAYLISTS ?? "50", 10)
          : parseInt(process.env.MAX_FREE_PLAYLISTS ?? "3", 10);

      if (user._count.playlists >= maxPlaylists) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            user.subscription === "FREE"
              ? `Free users can save up to ${maxPlaylists} playlists. Upgrade to Premium for more.`
              : `You've reached the maximum of ${maxPlaylists} playlists.`,
        });
      }

      const playlistId = extractPlaylistId(input.url);
      if (!playlistId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Invalid YouTube playlist URL. Please paste a valid YouTube playlist link.",
        });
      }

      try {
        const playlist = await importPlaylist(ctx.session.user.id, playlistId);
        return playlist;
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to import playlist. Please try again.",
        });
      }
    }),

  /**
   * Shuffle the videos of a playlist.
   */
  shuffle: protectedProcedure
    .input(
      z.object({
        playlistId: z.string(),
        preset: z
          .enum(["RANDOM", "SMART", "DISCOVERY", "ENERGY"])
          .default("RANDOM"),
        excludeWatched: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const playlist = await ctx.db.playlist.findUnique({
        where: { id: input.playlistId },
        include: {
          videos: true,
          playHistory: {
            where: { userId: ctx.session.user.id },
          },
        },
      });

      if (!playlist || playlist.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Feature gate: premium presets require subscription
      if (input.preset !== "RANDOM") {
        const user = await ctx.db.user.findUnique({
          where: { id: ctx.session.user.id },
        });

        if (user?.subscription !== "PREMIUM") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Advanced shuffle modes require a Premium subscription.",
          });
        }
      }

      let videosToShuffle = playlist.videos;

      // Premium: exclude watched videos
      if (input.excludeWatched) {
        const user = await ctx.db.user.findUnique({
          where: { id: ctx.session.user.id },
        });

        if (user?.subscription !== "PREMIUM") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Exclude watched requires a Premium subscription.",
          });
        }

        const watchedIds = new Set(
          playlist.playHistory
            .filter((ph) => ph.completed)
            .map((ph) => ph.videoId)
        );

        videosToShuffle = videosToShuffle.filter(
          (v) => !watchedIds.has(v.id)
        );
      }

      const shuffled = shuffleVideos(
        videosToShuffle,
        input.preset,
        playlist.playHistory
      );

      // Update the playlist's shuffle preset
      await ctx.db.playlist.update({
        where: { id: input.playlistId },
        data: { shufflePreset: input.preset },
      });

      return shuffled;
    }),

  /**
   * Sync a playlist with fresh YouTube data.
   */
  sync: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const playlist = await ctx.db.playlist.findUnique({
        where: { id: input.id },
      });

      if (!playlist || playlist.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      await syncPlaylist(input.id);

      return ctx.db.playlist.findUnique({
        where: { id: input.id },
        include: { videos: { orderBy: { position: "asc" } } },
      });
    }),

  /**
   * Delete a playlist.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await deletePlaylist(input.id, ctx.session.user.id);
      return { success: true };
    }),

  /**
   * Record play history for a video.
   */
  recordPlay: protectedProcedure
    .input(
      z.object({
        playlistId: z.string(),
        videoId: z.string(),
        watchedSeconds: z.number().default(0),
        completed: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.playHistory.create({
        data: {
          userId: ctx.session.user.id,
          playlistId: input.playlistId,
          videoId: input.videoId,
          watchedSeconds: input.watchedSeconds,
          completed: input.completed,
        },
      });
    }),
});
