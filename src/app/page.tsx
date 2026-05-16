import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Navbar } from "@/components/layouts/Navbar";
import { Footer } from "@/components/layouts/Footer";
import { FaqAccordion } from "@/components/FaqAccordion";
import {
  ArrowRight,
  CheckCircle2,
  CircleOff,
  Database,
  Headphones,
  HelpCircle,
  ListMusic,
  LockKeyhole,
  Music2,
  Play,
  ShieldCheck,
  Shuffle,
  Sparkles,
} from "lucide-react";

export const metadata: Metadata = {
  title: "TubeShuffle — A Better YouTube Playlist Shuffle",
  description:
    "Import a public YouTube playlist, build smoother energy-flow queues, get daily song suggestions, and keep your library local in the browser.",
  alternates: {
    canonical: "/",
  },
};

const faqs = [
  {
    question: "Why does YouTube shuffle play the same songs?",
    answer:
      "Large YouTube playlists can feel repetitive because the player often works from a loaded window of items instead of giving every video the same chance. TubeShuffle imports the available playlist items first, then creates the playback queue locally.",
  },
  {
    question: "What is Normal Shuffle?",
    answer:
      "Normal Shuffle uses Fisher-Yates randomization: every imported video has an equal chance to land anywhere in the queue.",
  },
  {
    question: "What is Smart Shuffle?",
    answer:
      "Smart Shuffle infers rough energy and mood from YouTube metadata, titles, tags, duration, and playlist context. It then builds a queue that moves through similar energies with smoother transitions. It does not claim real BPM or direct audio analysis.",
  },
  {
    question: "What are Daily Suggestions?",
    answer:
      "Each playlist can show five fresh YouTube suggestions per browser day. The first load uses a server-side YouTube search, then TubeShuffle caches that set locally for the rest of the day.",
  },
  {
    question: "Does Smart Shuffle use real BPM?",
    answer:
      "No. YouTube's public API does not provide BPM or audio energy. TubeShuffle uses explainable metadata signals and keeps the copy honest about that limitation.",
  },
  {
    question: "Does TubeShuffle store my playlists on a server?",
    answer:
      "No. Imported playlists, queue state, and preferences are stored in your browser with IndexedDB and local storage. Clearing browser data removes them.",
  },
  {
    question: "Can it play YouTube audio only?",
    answer:
      "YouTube playback still uses the official embedded player. Focus mode covers the rendered video with a calm audio-style interface, while keeping the YouTube iframe present for compliant playback.",
  },
  {
    question: "Does it work with private playlists or Liked Videos?",
    answer:
      "TubeShuffle has no Google login, so it works with public playlists that the YouTube API can read and embed. Private account-only collections are not imported.",
  },
];

const bentoFeatures = [
  {
    icon: ShieldCheck,
    title: "Local-first by default",
    description:
      "Your imported playlists live in this browser, not in a TubeShuffle account or hosted database.",
    className: "md:col-span-2",
    visual: "privacy",
  },
  {
    icon: Sparkles,
    title: "Smart energy flow",
    description:
      "Normal stays pure random. Smart groups nearby moods and moves the queue through smoother energy waves.",
    className: "",
    visual: "modes",
  },
  {
    icon: Music2,
    title: "Daily suggestions",
    description:
      "Five fresh YouTube finds per playlist each day, cached in this browser after the first search.",
    className: "",
    visual: "suggestions",
  },
  {
    icon: Headphones,
    title: "Audio focus",
    description:
      "Cover the video render with a calm listening screen when you want less visual noise.",
    className: "",
    visual: "focus",
  },
  {
    icon: ListMusic,
    title: "Queue you can fix",
    description:
      "Jump to a track, move it up, play it next, or remove it without rebuilding the whole queue.",
    className: "md:col-span-2",
    visual: "queue",
  },
];

const antiSaas = [
  "No account wall",
  "No subscription prompt",
  "No cloud playlist database",
  "No fake BPM claims",
];

const steps = [
  {
    label: "Paste",
    title: "Drop in a playlist URL",
    description: "Public YouTube playlist links or IDs are enough.",
  },
  {
    label: "Import",
    title: "Save it locally",
    description: "Metadata and videos are stored in your browser.",
  },
  {
    label: "Listen",
    title: "Shuffle with a flow",
    description: "Use Normal, Smart energy flow, or scroll for daily suggestions.",
  },
];

function HeroPlayerMock() {
  const queue = [
    { title: "Midnight Tape — Side A", meta: "03:42" },
    { title: "Rain on Neon Glass", meta: "04:18" },
    { title: "Cab Ride Interlude", meta: "02:55" },
  ];

  return (
    <div className="relative mx-auto mt-14 max-w-5xl">
      <div className="absolute -inset-6 rounded-[3rem] bg-white/10 blur-3xl" />
      <div className="relative overflow-hidden rounded-[2rem] border border-white/15 bg-white/[0.07] p-4 shadow-2xl shadow-black/50 backdrop-blur-xl md:p-5">
        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="relative min-h-[330px] overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#12110f] p-6">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_35%_20%,rgba(255,255,255,0.16),transparent_28%),radial-gradient(circle_at_70%_80%,rgba(245,158,11,0.22),transparent_30%)]" />
            <div className="relative flex h-full flex-col justify-between">
              <div className="flex items-center justify-between">
                <Badge className="border-white/15 bg-white/10 text-white hover:bg-white/10">
                  Audio focus
                </Badge>
                <div className="flex gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  <span className="h-2 w-2 rounded-full bg-amber-300" />
                  <span className="h-2 w-2 rounded-full bg-emerald-300" />
                </div>
              </div>

              <div className="space-y-5">
                <div className="flex h-24 w-24 items-center justify-center rounded-[1.75rem] border border-white/10 bg-white/10 shadow-2xl shadow-black/40">
                  <Headphones className="h-10 w-10 text-white" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/45">
                    Now shuffling
                  </p>
                  <h3 className="mt-2 text-3xl font-black tracking-tight text-white md:text-5xl">
                    A queue that moves in waves.
                  </h3>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black">
                    <Play className="ml-0.5 h-5 w-5 fill-current" />
                  </div>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full w-2/3 rounded-full bg-white" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[1.5rem] border border-white/10 bg-black/20 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-white">Upcoming queue</p>
                <p className="text-xs text-white/50">3 of 128 imported videos</p>
              </div>
              <Shuffle className="h-5 w-5 text-white/60" />
            </div>
            <div className="space-y-2">
              {queue.map((item, index) => (
                <div
                  key={item.title}
                  className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.05] p-3 transition-colors hover:bg-white/[0.09]"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-sm font-bold text-white">
                    {index + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">
                      {item.title}
                    </p>
                    <p className="text-xs text-white/45">{item.meta}</p>
                  </div>
                  <div className="h-7 w-1 rounded-full bg-white/20 transition-colors group-hover:bg-white" />
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-white/60">
              <div className="rounded-2xl bg-white/[0.06] p-3">
                <p className="text-lg font-black text-white">Normal</p>
                <p>Pure random</p>
              </div>
              <div className="rounded-2xl bg-white/[0.06] p-3">
                <p className="text-lg font-black text-white">Smart</p>
                <p>Energy flow</p>
              </div>
              <div className="rounded-2xl bg-white/[0.06] p-3">
                <p className="text-lg font-black text-white">Daily</p>
                <p>Fresh finds</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BentoVisual({ visual }: { visual: string }) {
  if (visual === "queue") {
    return (
      <div className="mt-6 space-y-2">
        {["Play next", "Move up", "Remove"].map((action, index) => (
          <div
            key={action}
            className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.05] p-3"
          >
            <span className="text-sm text-white/80">{action}</span>
            <span className="rounded-full bg-white/10 px-2 py-1 font-mono text-xs text-white/50">
              0{index + 1}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (visual === "privacy") {
    return (
      <div className="mt-8 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-4">
          <Database className="mx-auto h-6 w-6 text-emerald-300" />
          <p className="mt-2 text-xs text-white/55">Browser DB</p>
        </div>
        <div className="flex items-center justify-center">
          <CircleOff className="h-7 w-7 text-white/35" />
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.05] p-4">
          <LockKeyhole className="mx-auto h-6 w-6 text-amber-200" />
          <p className="mt-2 text-xs text-white/55">No account</p>
        </div>
      </div>
    );
  }

  if (visual === "focus") {
    return (
      <div className="mt-8 rounded-3xl border border-white/10 bg-[#0d0d0b] p-4">
        <div className="flex items-center gap-3 rounded-2xl bg-white/[0.06] p-3">
          <Headphones className="h-8 w-8 text-white" />
          <div>
            <p className="text-sm font-semibold text-white">Video covered</p>
            <p className="text-xs text-white/45">Audio-style interface</p>
          </div>
        </div>
      </div>
    );
  }

  if (visual === "suggestions") {
    return (
      <div className="mt-8 space-y-2">
        {["Fresh find 01", "Fresh find 02", "Fresh find 03", "Fresh find 04", "Fresh find 05"].map((title, index) => (
          <div
            key={title}
            className="flex items-center gap-3 rounded-2xl border border-amber-200/10 bg-amber-200/[0.06] p-3"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-200/15 text-xs font-black text-amber-100">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{title}</p>
              <p className="text-xs text-white/45">Cached for today</p>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-8 flex h-28 items-end gap-2">
      {[64, 36, 82, 48, 70].map((height, index) => (
        <div
          key={index}
          className="w-full rounded-t-2xl bg-white/15 transition-all duration-500 group-hover:bg-white/30"
          style={{ height: `${height}%` }}
        />
      ))}
    </div>
  );
}

export default function HomePage() {
  const getStartedHref = "/dashboard";

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />

      <main className="flex-1 overflow-hidden bg-[#080807] text-white">
        <section className="relative border-b border-white/10">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.16),transparent_26rem),radial-gradient(circle_at_20%_30%,rgba(245,158,11,0.16),transparent_28rem),linear-gradient(180deg,rgba(255,255,255,0.04),transparent)]" />
          <div className="container relative mx-auto px-4 py-20 md:py-28">
            <div className="mx-auto max-w-4xl text-center">
              <Badge className="mb-6 border-white/15 bg-white/10 px-4 py-1.5 text-white hover:bg-white/10">
                Local-first YouTube playlist shuffling
              </Badge>
              <h1 className="text-balance text-5xl font-black tracking-[-0.07em] text-white md:text-7xl lg:text-8xl">
                Stop hearing the same first twenty songs.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-8 text-white/65 md:text-xl">
                Import a public YouTube playlist, shuffle the entire available
                queue locally, move through smoother energy arcs, and find five
                fresh suggestions for each playlist every day.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link href={getStartedHref}>
                  <Button
                    size="lg"
                    className="min-w-[220px] rounded-full bg-white text-black hover:bg-white/90"
                  >
                    Open the app
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
                <a href="#how-it-works">
                  <Button
                    size="lg"
                    variant="outline"
                    className="rounded-full border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"
                  >
                    See how it works
                  </Button>
                </a>
              </div>
              <p className="mt-4 text-sm text-white/45">
                Free. No login. Saved in your browser.
              </p>
            </div>

            <HeroPlayerMock />
          </div>
        </section>

        <section className="border-b border-white/10 py-8">
          <div className="container mx-auto grid gap-3 px-4 sm:grid-cols-2 lg:grid-cols-4">
            {antiSaas.map((item) => (
              <div
                key={item}
                className="flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white/65"
              >
                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="container mx-auto px-4 py-20 md:py-28">
          <div className="mb-12 max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-white/35">
              Built like a music tool
            </p>
            <h2 className="mt-4 text-4xl font-black tracking-tight md:text-6xl">
              Less SaaS dashboard. More listening room.
            </h2>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {bentoFeatures.map((feature) => (
              <div
                key={feature.title}
                className={`group min-h-[280px] rounded-[2rem] border border-white/10 bg-white/[0.045] p-6 shadow-2xl shadow-black/20 transition-all duration-500 hover:-translate-y-1 hover:border-white/25 hover:bg-white/[0.07] ${feature.className}`}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-white transition-transform duration-500 group-hover:scale-110">
                  <feature.icon className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-2xl font-black tracking-tight text-white">
                  {feature.title}
                </h3>
                <p className="mt-3 max-w-xl text-sm leading-6 text-white/60">
                  {feature.description}
                </p>
                <BentoVisual visual={feature.visual} />
              </div>
            ))}
          </div>
        </section>

        <section id="how-it-works" className="border-y border-white/10 bg-white/[0.03] py-20">
          <div className="container mx-auto px-4">
            <div className="mx-auto max-w-3xl text-center">
              <Badge className="border-white/15 bg-white/10 text-white hover:bg-white/10">
                Three steps
              </Badge>
              <h2 className="mt-5 text-4xl font-black tracking-tight md:text-5xl">
                From YouTube URL to better queue.
              </h2>
            </div>
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {steps.map((step) => (
                <div
                  key={step.label}
                  className="rounded-[2rem] border border-white/10 bg-[#11100e] p-6"
                >
                  <div className="mb-8 inline-flex rounded-full bg-white text-black px-3 py-1 font-mono text-xs font-bold">
                    {step.label}
                  </div>
                  <h3 className="text-2xl font-black tracking-tight">{step.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-white/60">
                    {step.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 py-20 md:py-28">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-white/35">
                Honest controls
              </p>
              <h2 className="mt-4 text-4xl font-black tracking-tight md:text-5xl">
                Normal when you want chance. Smart when you want a wave.
              </h2>
              <p className="mt-5 text-white/60">
                TubeShuffle keeps the promise clear: one mathematically fair
                random queue, one metadata-inferred energy flow, and daily
                suggestions that are cached locally after the first YouTube search.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-[2rem] border border-white/10 bg-white/[0.05] p-6">
                <Shuffle className="h-8 w-8 text-white" />
                <h3 className="mt-6 text-3xl font-black">Normal</h3>
                <p className="mt-2 text-sm text-white/60">
                  Fisher-Yates randomization across the imported queue.
                </p>
              </div>
              <div className="rounded-[2rem] border border-white/10 bg-white/[0.05] p-6">
                <Sparkles className="h-8 w-8 text-amber-200" />
                <h3 className="mt-6 text-3xl font-black">Smart</h3>
                <p className="mt-2 text-sm text-white/60">
                  Moves through inferred energies instead of spacing artists.
                </p>
              </div>
              <div className="rounded-[2rem] border border-white/10 bg-white/[0.05] p-6">
                <Music2 className="h-8 w-8 text-emerald-200" />
                <h3 className="mt-6 text-3xl font-black">Daily</h3>
                <p className="mt-2 text-sm text-white/60">
                  Five suggested YouTube videos per playlist, per browser day.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-white/10 bg-[#11100e] py-20">
          <div className="container mx-auto px-4">
            <div className="mx-auto max-w-3xl text-center">
              <HelpCircle className="mx-auto mb-5 h-9 w-9 text-white/55" />
              <h2 className="text-4xl font-black tracking-tight md:text-5xl">
                Questions before you shuffle?
              </h2>
              <p className="mt-4 text-white/55">
                The important details: where data lives, what the modes do, and
                what YouTube embeds allow.
              </p>
            </div>
            <div className="mx-auto mt-10 max-w-3xl rounded-[2rem] border border-white/10 bg-white/[0.04] p-4 md:p-6">
              <FaqAccordion faqs={faqs} />
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 py-20 text-center md:py-28">
          <div className="mx-auto max-w-2xl rounded-[2.5rem] border border-white/10 bg-white/[0.06] p-8 shadow-2xl shadow-black/30 md:p-12">
            <Music2 className="mx-auto mb-5 h-12 w-12 text-white" />
            <h2 className="text-4xl font-black tracking-tight md:text-5xl">
              Bring one playlist. Leave with a better queue.
            </h2>
            <p className="mt-4 text-white/60">
              Open the dashboard, import a public playlist, and shuffle it from
              your browser library.
            </p>
            <Link href={getStartedHref} className="mt-8 inline-block">
              <Button
                size="lg"
                className="rounded-full bg-white text-black hover:bg-white/90"
              >
                Start shuffling
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            {
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: "TubeShuffle",
              url: "https://tubeshuffle.com",
              description:
                "Local-first YouTube playlist shuffler with Normal queues, Smart energy flow, and daily suggestions.",
              applicationCategory: "MultimediaApplication",
              operatingSystem: "Any",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
                description: "Free local-first YouTube playlist shuffler",
              },
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
