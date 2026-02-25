"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Shuffle, LayoutDashboard } from "lucide-react";

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Shuffle className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="text-lg font-semibold">TubeShuffler</span>
        </Link>

        <nav className="flex items-center gap-4">
          <Link href="/dashboard">
            <Button variant="ghost" size="sm">
              <LayoutDashboard className="mr-2 h-4 w-4" />
              Dashboard
            </Button>
          </Link>
        </nav>
      </div>
    </header>
  );
}
