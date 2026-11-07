import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowRight, Download, Laptop } from "lucide-react";
import { Navbar } from "@/components/layouts/Navbar";
import { Footer } from "@/components/layouts/Footer";
import { Button } from "@/components/ui/button";
import { FaqAccordion } from "@/components/FaqAccordion";
import { macOSRelease } from "@/lib/macos-release";
import macOSPreview from "@/assets/macos-preview.png";

export const metadata: Metadata = {
  title: "TubeShuffle for macOS",
  description:
    "Meet the native TubeShuffle app for Apple Silicon. Check download availability, installation steps and how to bring your playlists from the browser.",
  alternates: { canonical: "/macos" },
  openGraph: {
    title: "TubeShuffle for macOS",
    description: "Your playlists, in a native Mac app. Download status and setup guide.",
    url: "/macos",
  },
};

const setupSteps = [
  {
    title: "Open the Mac app",
    description:
      "Extract the downloaded ZIP, keep its folder together, and open TubeShuffle.app. Your first launch starts with an empty screen.",
  },
  {
    title: "Create your library",
    description:
      "Choose Library → New library… and pick a new folder on your Mac. Library also contains your import, export and account options.",
  },
  {
    title: "Bring a playlist",
    description:
      "YouTube link imports currently require the configured owner’s Google account. Choose Library → Import YouTube playlist… (⌘L), paste a link, then Connect → Use TubeShuffle → Sign in with Google. Or bring a browser export below, with no sign-in.",
  },
];

const faqs = [
  {
    question: "Can I keep using TubeShuffle in the browser?",
    answer:
      "Yes. The browser app stays available, with its own local library. Installing the Mac app does not replace it or automatically move your data. Playlist content, queue, history and preferences are stored separately on each device; cloud storage is limited to playlist links/IDs.",
  },
  {
    question: "Can I bring my browser library to the Mac app?",
    answer:
      "Export your library as JSON from the browser dashboard. In the Mac app, create a new, empty library, choose Library → Import JSON…, and review the preview before confirming. This copies playlists and supported history while leaving the browser library intact. Queue, preferences, suggestions, credentials and media are excluded. Orphan history events are omitted and counted in the export notice; completion journal records and suggestion listening events are also outside the transfer. The JSON is unencrypted. Keep the original export and library.",
  },
  {
    question: "Do I need to sign in?",
    answer:
      "You can create or open a local library and import a JSON export without signing in. Fetching YouTube playlists in the current preview requires the configured owner’s Google account; general account access is not available yet. Choosing Use TubeShuffle selects the service configuration but does not sign you in.",
  },
  {
    question: "Will it work on my Mac?",
    answer:
      "The current build targets Apple Silicon (M-series) Macs running macOS 14 Sonoma or later. There is no Intel build available. Playback uses YouTube and requires an internet connection; media is not downloaded for offline listening.",
  },
  {
    question: "Is background playback approved for release?",
    answer:
      "Not yet. Playback when minimized, hidden or in Focus remains subject to acceptance testing and YouTube policy review. The preview is not a promise of uninterrupted background playback or an approved public release.",
  },
];

export default function MacOSPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#080807] text-white">
      <Navbar />
      <main id="main-content" className="flex-1">
        <section className="relative border-b border-white/10">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(255,255,255,0.1),transparent_65%)]"
          />
          <div className="relative mx-auto max-w-6xl px-4 pb-12 pt-12 sm:px-6 md:pb-16 md:pt-20">
            <div className="mx-auto max-w-2xl text-center">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-white/65">
                <Laptop aria-hidden="true" className="size-4" />
                TubeShuffle for macOS
              </p>
              <h1 className="mt-5 text-balance text-4xl font-bold tracking-[-0.05em] sm:text-6xl">
                Your playlists.<br />A place on your Mac.
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-pretty text-base leading-7 text-white/65 sm:text-lg">
                Familiar shuffle, a native window. Keep your library on your Mac,
                with the browser always a click away.
              </p>
              <p className="mt-5 text-sm text-white/55">
                macOS 14+ <span aria-hidden="true">·</span> Apple Silicon <span aria-hidden="true">·</span> ZIP download
              </p>

              <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6">
                <p id="download-status" className="font-semibold">
                  {macOSRelease ? `Version ${macOSRelease.version}` : "Public download is not available yet"}
                </p>
                {!macOSRelease && (
                  <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-6 text-white/60">
                    The Mac app is in preview. A signed, notarized release is still
                    being prepared. You can keep listening in the browser.
                  </p>
                )}
                <div className="mt-5 flex flex-col items-stretch justify-center gap-3 sm:flex-row">
                  {macOSRelease ? (
                    <Button asChild size="lg" className="min-h-11 rounded-full bg-white text-black transition-colors hover:bg-white/90">
                      <a href={macOSRelease.downloadURL}>
                        <Download aria-hidden="true" /> Download for Mac
                      </a>
                    </Button>
                  ) : (
                    <Button disabled size="lg" aria-describedby="download-status" className="min-h-11 rounded-full border border-white/15 bg-white/10 text-white disabled:opacity-60">
                      <Download aria-hidden="true" /> Download for Mac
                    </Button>
                  )}
                  <Button asChild size="lg" variant="outline" className="min-h-11 rounded-full border-white/20 bg-transparent text-white transition-colors hover:bg-white/10 hover:text-white">
                    <Link href="/dashboard" prefetch={false}>
                      Open in browser <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
                {macOSRelease && (
                  <div className="mt-4 space-y-3 text-sm text-white/60">
                    <a href={macOSRelease.releaseNotesURL} className="inline-flex min-h-11 items-center rounded-lg underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
                      Release notes
                    </a>
                    <details className="text-left">
                      <summary className="flex min-h-11 cursor-pointer items-center rounded-lg focus-visible:outline-2 focus-visible:outline-white">Verify download (SHA-256)</summary>
                      <code className="mt-2 block break-all text-xs leading-5">{macOSRelease.sha256}</code>
                    </details>
                  </div>
                )}
              </div>
              <a href="#installation" className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-white/65 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
                Installation &amp; setup <ArrowDown aria-hidden="true" className="size-4" />
              </a>
            </div>

            <figure className="mt-10 md:mt-14">
              <Image
                src={macOSPreview}
                alt="The native TubeShuffle app with a player, thumbnail queue and Library menu."
                sizes="(max-width: 1152px) 100vw, 1104px"
                className="h-auto w-full rounded-2xl shadow-2xl shadow-black/40 outline outline-1 -outline-offset-1 outline-white/10 sm:rounded-3xl"
              />
              <figcaption className="mt-3 text-center text-xs text-white/50">
                Native app preview with a sample playlist.
              </figcaption>
            </figure>
          </div>
        </section>

        <section id="installation" aria-labelledby="installation-heading" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-12 sm:px-6 md:py-16">
          <h2 id="installation-heading" className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">From download to your first shuffle</h2>
          <p className="mt-3 text-pretty text-sm leading-6 text-white/60">
            {macOSRelease ? "Start with a new local library." : "Once the public download is available, these are the steps to get started."}
          </p>
          <ol className="mt-8 grid gap-6 md:grid-cols-3 md:gap-8">
            {setupSteps.map((step, index) => (
              <li key={step.title} className="border-t border-white/15 pt-5">
                <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-full bg-white/10 text-sm font-semibold tabular-nums">{index + 1}</span>
                <h3 className="mt-4 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 text-pretty text-sm leading-6 text-white/60">{step.description}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6">
            <h3 className="font-semibold">Bring your browser library</h3>
            <p className="mt-2 text-pretty text-sm leading-6 text-white/65">
              In the browser dashboard, choose <strong className="font-medium text-white/85">Export library</strong>.
              In your new, empty Mac library, choose <strong className="font-medium text-white/85">Library → Import JSON…</strong> and
              review the preview before confirming. No sign-in is needed.
            </p>
            <p className="mt-2 text-sm leading-6 text-white/55">
              Your browser library stays intact. Queue and preferences stay separate;
              see the transfer details below for other exclusions and omitted events.
            </p>
          </div>
        </section>

        <section aria-labelledby="macos-questions" className="border-t border-white/10 bg-white/[0.02]">
          <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 md:py-16">
            <h2 id="macos-questions" className="mb-6 text-2xl font-bold tracking-tight sm:text-3xl">Before you move a playlist</h2>
            <FaqAccordion faqs={faqs} />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
