import Link from "next/link";
import Image from "next/image";
import { Coffee, Github } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#080807] text-white">
      <div className="container mx-auto flex flex-col items-center gap-4 px-4 py-8 lg:flex-row lg:justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg border border-white/15 bg-white/10">
            <Image
              src="/favicon.svg"
              alt=""
              aria-hidden="true"
              width={12}
              height={12}
              className="h-3 w-3"
            />
          </div>
          <span className="text-sm font-medium">TubeShuffle</span>
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-white/55">
          <Link
            href="/dashboard"
            className="inline-flex min-h-11 items-center rounded-lg transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/75"
          >
            Open app
          </Link>
          <a
            href="https://github.com/gustavocaiano/tubeshuffle"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/75"
          >
            <Github aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
            Source code
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <a
            href="https://buymeacoffee.com/gustavocaiano"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-white/15 bg-white/5 px-3 text-white/75 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/75"
          >
            <Coffee aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
            Buy me a coffee
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </nav>

        <p className="text-center text-sm text-white/55">
          &copy; {new Date().getFullYear()} TubeShuffle. MIT licensed.
        </p>
      </div>
    </footer>
  );
}
