"use client";

import { useSession } from "next-auth/react";
import { Navbar } from "@/components/layouts/Navbar";
import { Footer } from "@/components/layouts/Footer";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, Crown, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import Link from "next/link";

const maxFreePlaylists = Number(process.env.NEXT_PUBLIC_MAX_FREE_PLAYLISTS ?? 3);
const maxPremiumPlaylists = Number(process.env.NEXT_PUBLIC_MAX_PREMIUM_PLAYLISTS ?? 50);

const plans = [
  {
    name: "Free",
    price: "Free",
    period: " forever",
    description: "Perfect for casual listeners",
    features: [
      `Up to ${maxFreePlaylists} saved playlists`,
      "Random shuffle algorithm",
      "Unlimited playlist size",
      "Cloud sync across devices",
      "Basic playback controls",
    ],
    cta: "Get Started",
    popular: false,
  },
  {
    name: "Premium Monthly",
    price: "From 3.99",
    period: "/month",
    description: "For power users who want the best shuffle experience",
    note: "Price in your local currency at checkout",
    features: [
      `Up to ${maxPremiumPlaylists} saved playlists`,
      "Smart, Discovery & Energy shuffle",
      "Watch history tracking",
      "Exclude watched videos",
      "Playlist analytics",
      "Batch import",
      "Custom duration & channel filters",
      "Auto-cleanup deleted videos",
      "Priority email support",
    ],
    cta: "Subscribe Monthly",
    popular: true,
    priceEnv: "STRIPE_PRICE_ID_MONTHLY",
  },
  {
    name: "Premium Yearly",
    price: "From 39.99",
    period: "/year",
    description: "Save 17% with annual billing",
    note: "Price in your local currency at checkout",
    features: [
      "Everything in Premium Monthly",
      "2 months free",
      "Annual billing convenience",
    ],
    cta: "Subscribe Yearly",
    popular: false,
    priceEnv: "STRIPE_PRICE_ID_YEARLY",
  },
];

export default function PricingPage() {
  const { data: session } = useSession();

  const subscriptionStatus = trpc.subscription.getStatus.useQuery(undefined, {
    enabled: !!session,
  });

  const checkoutMutation = trpc.subscription.createCheckout.useMutation({
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const billingPortalMutation = trpc.subscription.getBillingPortal.useMutation({
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const isPremium = subscriptionStatus.data?.tier === "PREMIUM";

  const handleSubscribe = (priceEnv?: string) => {
    if (!session) {
      window.location.href = "/login";
      return;
    }

    if (isPremium) {
      billingPortalMutation.mutate();
      return;
    }

    // In production, you'd have actual price IDs
    // For now, use env vars
    const priceId =
      priceEnv === "STRIPE_PRICE_ID_YEARLY"
        ? process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_YEARLY ?? "price_yearly"
        : process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_MONTHLY ?? "price_monthly";

    checkoutMutation.mutate({ priceId });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />

      <main className="flex-1">
        <div className="container mx-auto px-4 py-16">
          <div className="text-center">
            <Badge variant="secondary" className="mb-4">
              Pricing
            </Badge>
            <h1 className="text-4xl font-bold">
              Choose the plan that fits you
            </h1>
            <p className="mx-auto mt-3 max-w-lg text-muted-foreground">
              Start with the free plan and upgrade whenever you need more
              playlists or advanced shuffle algorithms.
            </p>
          </div>

          {isPremium && (
            <div className="mx-auto mt-8 max-w-md rounded-lg border border-green-200 bg-green-50 p-4 text-center dark:border-green-900 dark:bg-green-950">
              <Crown className="mx-auto h-6 w-6 text-green-600" />
              <p className="mt-2 font-medium text-green-800 dark:text-green-200">
                You&apos;re on the Premium plan
              </p>
              <Button
                variant="outline"
                className="mt-3"
                onClick={() => billingPortalMutation.mutate()}
                disabled={billingPortalMutation.isPending}
              >
                {billingPortalMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Manage Subscription
              </Button>
            </div>
          )}

          <div className="mx-auto mt-12 grid max-w-5xl gap-8 md:grid-cols-3">
            {plans.map((plan) => (
              <Card
                key={plan.name}
                className={
                  plan.popular
                    ? "relative border-primary shadow-lg"
                    : "relative"
                }
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge>Most Popular</Badge>
                  </div>
                )}
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                  <div className="mt-2">
                    <span className="text-4xl font-bold">{plan.price}</span>
                    <span className="text-muted-foreground">
                      {plan.period}
                    </span>
                  </div>
                  {"note" in plan && plan.note && (
                    <p className="text-xs text-muted-foreground">
                      {plan.note}
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    {plan.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-sm"
                      >
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-6">
                    {plan.priceEnv ? (
                      <Button
                        className="w-full"
                        variant={plan.popular ? "default" : "outline"}
                        onClick={() => handleSubscribe(plan.priceEnv)}
                        disabled={
                          checkoutMutation.isPending ||
                          billingPortalMutation.isPending
                        }
                      >
                        {(checkoutMutation.isPending ||
                          billingPortalMutation.isPending) && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        {isPremium ? "Manage Plan" : plan.cta}
                      </Button>
                    ) : (
                      <Link href={session ? "/dashboard" : "/login"}>
                        <Button variant="outline" className="w-full">
                          {plan.cta}
                        </Button>
                      </Link>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
