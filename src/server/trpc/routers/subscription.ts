import { z } from "zod/v4";
import { router, protectedProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import Stripe from "stripe";

function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stripe is not configured.",
    });
  }
  return new Stripe(key);
}

export const subscriptionRouter = router({
  /**
   * Get current subscription status.
   */
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      include: {
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }

    const activeSubscription = user.subscriptions[0];

    return {
      tier: user.subscription,
      subscription: activeSubscription
        ? {
            id: activeSubscription.id,
            status: activeSubscription.status,
            currentPeriodEnd: activeSubscription.currentPeriodEnd,
            cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd,
          }
        : null,
    };
  }),

  /**
   * Create a Stripe Checkout session for subscription.
   */
  createCheckout: protectedProcedure
    .input(
      z.object({
        priceId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const stripe = getStripeClient();

      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
      });

      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Create or retrieve Stripe customer
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: user.id },
        });
        customerId = customer.id;

        await ctx.db.user.update({
          where: { id: user.id },
          data: { stripeCustomerId: customerId },
        });
      }

      const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: `${baseUrl}/dashboard?upgraded=true`,
        cancel_url: `${baseUrl}/pricing`,
        metadata: { userId: user.id },
        // Let Stripe auto-detect payment methods and currency based on customer locale
        // Configure multi-currency prices in the Stripe Dashboard
      });

      return { url: session.url };
    }),

  /**
   * Create a Stripe Billing Portal session.
   */
  getBillingPortal: protectedProcedure.mutation(async ({ ctx }) => {
    const stripe = getStripeClient();

    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
    });

    if (!user?.stripeCustomerId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No subscription found.",
      });
    }

    const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${baseUrl}/dashboard`,
    });

    return { url: session.url };
  }),
});
