"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Laptop, LayoutDashboard } from "lucide-react";

export function Navbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-black/45 text-white backdrop-blur-xl supports-[backdrop-filter]:bg-black/25">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/15 bg-white/10 shadow-lg shadow-black/20">
            <Image
              src="/favicon.svg"
              alt=""
              aria-hidden="true"
              width={16}
              height={16}
              className="h-4 w-4"
            />
          </div>
          <span className="text-lg font-semibold tracking-tight">TubeShuffle</span>
        </Link>

        <nav aria-label="Main navigation" className="flex items-center gap-1 sm:gap-2">
          <Button asChild variant="ghost" size="sm" className="min-h-11 text-white/80 transition-colors hover:bg-white/10 hover:text-white aria-[current=page]:bg-white/10 aria-[current=page]:text-white">
            <Link href="/macos" aria-current={pathname === "/macos" ? "page" : undefined}>
              <Laptop aria-hidden="true" className="hidden size-4 sm:block" />
              macOS
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="min-h-11 min-w-11 text-white/80 transition-colors hover:bg-white/10 hover:text-white">
            <Link href="/dashboard" prefetch={false}>
              <LayoutDashboard aria-hidden="true" className="size-4" />
              <span className="sr-only sm:not-sr-only">Dashboard</span>
            </Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
