import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "https://tubeshuffler.com"
  ),
  title: {
    default: "TubeShuffler — Fix YouTube's Broken Shuffle",
    template: "%s | TubeShuffler",
  },
  description:
    "YouTube shuffle broken? TubeShuffler fixes it. Import your playlists and get truly random playback with smart shuffle algorithms. No more hearing the same songs first.",
  keywords: [
    "YouTube shuffle broken",
    "YouTube shuffle not random",
    "fix YouTube shuffle",
    "YouTube playlist shuffler",
    "true random shuffle YouTube",
    "YouTube shuffle same songs",
    "YouTube shuffle fix",
    "random YouTube playlist",
    "shuffle YouTube playlist",
    "TubeShuffler",
  ],
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "TubeShuffler",
    title: "TubeShuffler — Fix YouTube's Broken Shuffle",
    description:
      "YouTube shuffle broken? TubeShuffler fixes it with true random playback. Import your playlists and never hear the same songs first again.",
  },
  twitter: {
    card: "summary_large_image",
    title: "TubeShuffler — Fix YouTube's Broken Shuffle",
    description:
      "YouTube shuffle broken? TubeShuffler fixes it with true random playback. Import your playlists and never hear the same songs first again.",
  },
  icons: {
    icon: "/favicon.svg",
  },
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: "/",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
