import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Navbar } from "@/components/layouts/Navbar";
import { Footer } from "@/components/layouts/Footer";
import { FaqAccordion } from "@/components/FaqAccordion";
import { auth } from "@/lib/auth";
import {
  Shuffle,
  Zap,
  Shield,
  BarChart3,
  Check,
  ArrowRight,
  Music,
  Sparkles,
  Users,
  HelpCircle,
} from "lucide-react";

export const metadata: Metadata = {
  title: "TubeShuffler — Fix YouTube's Broken Shuffle",
  description:
    "Why does YouTube shuffle play the same songs? Because it's not truly random. TubeShuffler uses real randomization algorithms so every video has an equal chance of playing. Fix your YouTube shuffle today.",
  alternates: {
    canonical: "/",
  },
};

const maxFreePlaylists = Number(process.env.MAX_FREE_PLAYLISTS ?? 3);
const maxPremiumPlaylists = Number(process.env.MAX_PREMIUM_PLAYLISTS ?? 50);

const faqs = [
  {
    question: "Why does YouTube shuffle play the same songs?",
    answer:
      "YouTube's shuffle algorithm isn't truly random. It uses a weighted system that favors recently added, popular, or frequently played videos. This means the first 20-30 videos in your playlist get disproportionately more plays. TubeShuffler uses a Fisher-Yates shuffle — a mathematically proven algorithm that gives every single video an equal probability of being picked.",
  },
  {
    question: "Is YouTube shuffle truly random?",
    answer:
      "No. YouTube's shuffle is pseudo-random at best and biased at worst. Multiple studies and user reports confirm that YouTube's shuffle tends to repeat the same subset of videos, especially in large playlists. TubeShuffler solves this by importing your entire playlist and applying real randomization on our side, completely bypassing YouTube's algorithm.",
  },
  {
    question: "How do I fix YouTube's broken shuffle?",
    answer:
      "The easiest fix is to use TubeShuffler. Just paste your YouTube playlist URL, and we'll import all your videos and shuffle them with a truly random algorithm. You can also try Smart Shuffle (avoids same artist back-to-back) or Discovery Mode (prioritizes videos you haven't heard in a while). Sign up for free — no credit card required.",
  },
  {
    question: "Why does YouTube shuffle not work properly for large playlists?",
    answer:
      "YouTube's shuffle struggles with large playlists because it only loads a portion of the playlist at a time (usually 200 videos). This means if your playlist has 1,000+ videos, shuffle can only pick from a small window. TubeShuffler loads your entire playlist — even thousands of videos — and shuffles across all of them equally.",
  },
  {
    question: "Does TubeShuffler work with any YouTube playlist?",
    answer:
      "Yes! TubeShuffler works with any public or unlisted YouTube playlist. Just paste the playlist URL or ID, and we'll import it. We support playlists of any size, including those with thousands of videos. Your Liked Videos playlist is also supported if you connect your Google account.",
  },
  {
    question: "Is TubeShuffler free?",
    answer:
      `Yes! The free plan lets you save up to ${maxFreePlaylists} playlists with true random shuffle and unlimited playlist size. If you want advanced features like Smart Shuffle, Discovery Mode, watch history tracking, and up to ${maxPremiumPlaylists} saved playlists, you can upgrade to Premium.`,
  },
];

const features = [
  {
    icon: Shuffle,
    title: "True Random Shuffle",
    description:
      "No more hearing the same songs first. Our Fisher-Yates algorithm ensures every video has an equal chance of playing.",
  },
  {
    icon: Sparkles,
    title: "Smart Shuffle",
    description:
      "Avoid hearing the same artist back-to-back. Our smart algorithm spaces out videos by channel and artist.",
  },
  {
    icon: BarChart3,
    title: "Discovery Mode",
    description:
      "Rediscover forgotten gems. Videos you've played less get higher priority in the queue.",
  },
  {
    icon: Shield,
    title: "Synced Everywhere",
    description:
      "Your playlists and preferences are saved to the cloud. Access them from any device, anytime.",
  },
  {
    icon: Zap,
    title: "Lightning Fast",
    description:
      "Aggressive caching means your playlists load instantly. No waiting, no buffering delays.",
  },
  {
    icon: Users,
    title: "No YouTube Limits",
    description:
      "Import playlists with thousands of videos. We handle the pagination so you don't have to.",
  },
];

const freeFeatures = [
  `Up to ${maxFreePlaylists} saved playlists`,
  "Random shuffle algorithm",
  "Unlimited playlist size",
  "Cloud sync across devices",
  "Basic playback controls",
];

const premiumFeatures = [
  `Up to ${maxPremiumPlaylists} saved playlists`,
  "Smart, Discovery & Energy shuffle",
  "Watch history tracking",
  "Exclude watched videos",
  "Playlist analytics",
  "Batch import",
  "Custom filters (duration, channel)",
  "Auto-cleanup deleted videos",
  "Priority support",
];

export default async function HomePage() {
  const session = await auth();
  const getStartedHref = session ? "/dashboard" : "/login";

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />

      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative overflow-hidden border-b">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/5" />
          <div className="container relative mx-auto px-4 py-24 text-center md:py-32">
            <Badge variant="secondary" className="mb-4">
              Fix YouTube&apos;s broken shuffle
            </Badge>
            <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight md:text-6xl">
              Your playlists, <span className="text-primary">truly</span> shuffled
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
              YouTube&apos;s shuffle plays the same videos first every time. TubeShuffler
              uses real randomization algorithms to give you a fresh listening
              experience — every single time.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href={getStartedHref}>
                <Button size="lg" className="min-w-[200px]">
                  Get Started Free
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/pricing">
                <Button variant="outline" size="lg" className="min-w-[200px]">
                  View Pricing
                </Button>
              </Link>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Free forever. No credit card required.
            </p>
          </div>
        </section>

        {/* Features Grid */}
        <section className="container mx-auto px-4 py-20">
          <div className="text-center">
            <h2 className="text-3xl font-bold">
              Everything you need for the perfect shuffle
            </h2>
            <p className="mt-3 text-muted-foreground">
              Built for music lovers who are tired of YouTube&apos;s repetitive
              shuffle.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <Card key={feature.title} className="border-0 shadow-sm">
                <CardHeader>
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <feature.icon className="h-5 w-5 text-primary" />
                  </div>
                  <CardTitle className="text-lg">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {feature.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Pricing Section */}
        <section className="border-t bg-muted/30 py-20">
          <div className="container mx-auto px-4">
            <div className="text-center">
              <h2 className="text-3xl font-bold">Simple, transparent pricing</h2>
              <p className="mt-3 text-muted-foreground">
                Start free. Upgrade when you need more.
              </p>
            </div>
            <div className="mx-auto mt-12 grid max-w-4xl gap-8 md:grid-cols-2">
              {/* Free Plan */}
              <Card className="relative">
                <CardHeader>
                  <CardTitle>Free</CardTitle>
                  <div className="mt-2">
                    <span className="text-4xl font-bold">Free</span>
                    <span className="text-muted-foreground"> forever</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    {freeFeatures.map((feature) => (
                      <li key={feature} className="flex items-center gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Link href={getStartedHref} className="mt-6 block">
                    <Button variant="outline" className="w-full">
                      Get Started
                    </Button>
                  </Link>
                </CardContent>
              </Card>

              {/* Premium Plan */}
              <Card className="relative border-primary shadow-lg">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge>Most Popular</Badge>
                </div>
                <CardHeader>
                  <CardTitle>Premium</CardTitle>
                  <div className="mt-2">
                    <span className="text-4xl font-bold">From 3.99</span>
                    <span className="text-muted-foreground">/month</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    or yearly (save 17%) &middot; Price in your local currency at checkout
                  </p>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    {premiumFeatures.map((feature) => (
                      <li key={feature} className="flex items-center gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Link href="/pricing" className="mt-6 block">
                    <Button className="w-full">Upgrade to Premium</Button>
                  </Link>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* FAQ Section */}
        <section className="border-t py-20">
          <div className="container mx-auto px-4">
            <div className="mx-auto max-w-3xl">
              <div className="mb-12 text-center">
                <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <HelpCircle className="h-5 w-5 text-primary" />
                </div>
                <h2 className="text-3xl font-bold">
                  Frequently asked questions
                </h2>
                <p className="mt-3 text-muted-foreground">
                  Everything you need to know about YouTube shuffle and how
                  TubeShuffler fixes it.
                </p>
              </div>
              <FaqAccordion faqs={faqs} />
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="container mx-auto px-4 py-20 text-center">
          <div className="mx-auto max-w-xl">
            <Music className="mx-auto mb-4 h-12 w-12 text-primary" />
            <h2 className="text-3xl font-bold">Ready to truly shuffle?</h2>
            <p className="mt-3 text-muted-foreground">
              Join thousands of users who have fixed their YouTube shuffle
              experience. It takes less than 30 seconds to get started.
            </p>
            <Link href={getStartedHref} className="mt-6 inline-block">
              <Button size="lg">
                Start Shuffling — It&apos;s Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      {/* JSON-LD Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            {
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: "TubeShuffler",
              url: "https://tubeshuffler.com",
              description:
                "Fix YouTube's broken shuffle. Import your playlists and get truly random playback with smart shuffle algorithms.",
              applicationCategory: "MultimediaApplication",
              operatingSystem: "Any",
              offers: [
                {
                  "@type": "Offer",
                  price: "0",
                  priceCurrency: "USD",
                  description: `Free plan with up to ${maxFreePlaylists} playlists`,
                },
                {
                  "@type": "Offer",
                  price: "3.99",
                  priceCurrency: "USD",
                  description: `Premium plan with advanced shuffle and up to ${maxPremiumPlaylists} playlists`,
                },
              ],
            },
            {
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: faqs.map((faq) => ({
                "@type": "Question",
                name: faq.question,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: faq.answer,
                },
              })),
            },
          ]),
        }}
      />

      <Footer />
    </div>
  );
}
