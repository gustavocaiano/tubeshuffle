import Link from "next/link";
import { Shuffle } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#080807] text-white">
      <div className="container mx-auto flex flex-col items-center gap-4 px-4 py-8 md:flex-row md:justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg border border-white/15 bg-white/10">
            <Shuffle className="h-3 w-3 text-white" />
          </div>
          <span className="text-sm font-medium">TubeShuffler</span>
        </div>

        <nav className="flex gap-6 text-sm text-white/55">
          <Link href="/dashboard" className="transition-colors hover:text-white">
            Open app
          </Link>
        </nav>

        <p className="text-sm text-white/45">
          &copy; {new Date().getFullYear()} TubeShuffler. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
