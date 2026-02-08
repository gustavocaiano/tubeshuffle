import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "TubeShuffler pricing plans. Start free with 3 playlists and true random shuffle, or upgrade to Premium for smart shuffle, analytics, and up to 50 playlists. Price in your local currency.",
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
