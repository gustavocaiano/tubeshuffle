import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  let event: Stripe.Event;

  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session);
        break;
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription);
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentFailed(invoice);
        break;
      }
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    return NextResponse.json(
      { error: "Error processing webhook" },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error("No userId in checkout session metadata");
    return;
  }

  const stripe = getStripe();
  const subscriptionId = session.subscription as string;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Extract period dates from the subscription object
  const sub = subscription as unknown as Record<string, unknown>;
  const periodStart =
    (sub.current_period_start as number) ??
    Math.floor(Date.now() / 1000);
  const periodEnd =
    (sub.current_period_end as number) ??
    Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

  // Create subscription record
  await db.subscription.create({
    data: {
      userId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0].price.id,
      status: subscription.status,
      currentPeriodStart: new Date(periodStart * 1000),
      currentPeriodEnd: new Date(periodEnd * 1000),
    },
  });

  // Update user to PREMIUM
  await db.user.update({
    where: { id: userId },
    data: { subscription: "PREMIUM" },
  });
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const dbSub = await db.subscription.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  });

  if (!dbSub) return;

  const sub = subscription as unknown as Record<string, unknown>;
  const periodStart =
    (sub.current_period_start as number) ??
    Math.floor(Date.now() / 1000);
  const periodEnd =
    (sub.current_period_end as number) ??
    Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

  await db.subscription.update({
    where: { stripeSubscriptionId: subscription.id },
    data: {
      status: subscription.status,
      stripePriceId: subscription.items.data[0].price.id,
      currentPeriodStart: new Date(periodStart * 1000),
      currentPeriodEnd: new Date(periodEnd * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
  });

  // Update user tier based on status
  const tier =
    subscription.status === "active" || subscription.status === "trialing"
      ? "PREMIUM"
      : "FREE";

  await db.user.update({
    where: { id: dbSub.userId },
    data: { subscription: tier },
  });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const dbSub = await db.subscription.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  });

  if (!dbSub) return;

  await db.subscription.update({
    where: { stripeSubscriptionId: subscription.id },
    data: { status: "canceled" },
  });

  await db.user.update({
    where: { id: dbSub.userId },
    data: { subscription: "FREE" },
  });
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  const user = await db.user.findFirst({
    where: { stripeCustomerId: customerId },
  });

  if (!user) return;

  console.warn(`Payment failed for user ${user.id} (${user.email})`);
}
