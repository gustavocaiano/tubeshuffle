"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Shuffle, LayoutDashboard } from "lucide-react";

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-black/45 text-white backdrop-blur-xl supports-[backdrop-filter]:bg-black/25">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/15 bg-white/10 shadow-lg shadow-black/20">
            <Shuffle className="h-4 w-4 text-white" />
          </div>
          <span className="text-lg font-semibold tracking-tight">TubeShuffle</span>
        </Link>

        <nav className="flex items-center gap-4">
          <Link href="/dashboard">
            <Button
              variant="ghost"
              size="sm"
              className="text-white/80 hover:bg-white/10 hover:text-white"
            >
              <LayoutDashboard className="mr-2 h-4 w-4" />
              Dashboard
            </Button>
          </Link>
        </nav>
      </div>
    </header>
  );
}
