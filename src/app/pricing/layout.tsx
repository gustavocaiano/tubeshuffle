import type { Metadata } from "next";

const maxFreePlaylists = Number(process.env.MAX_FREE_PLAYLISTS ?? 3);
const maxPremiumPlaylists = Number(process.env.MAX_PREMIUM_PLAYLISTS ?? 50);

export const metadata: Metadata = {
  title: "Pricing",
  description:
    `TubeShuffler pricing plans. Start free with ${maxFreePlaylists} playlists and true random shuffle, or upgrade to Premium for smart shuffle, analytics, and up to ${maxPremiumPlaylists} playlists. Price in your local currency.`,
  alternates: {
    canonical: "/pricing",
  },
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
