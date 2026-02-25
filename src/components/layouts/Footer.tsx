import Link from "next/link";
import { Shuffle } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t bg-muted/30">
      <div className="container mx-auto flex flex-col items-center gap-4 px-4 py-8 md:flex-row md:justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-primary">
            <Shuffle className="h-3 w-3 text-primary-foreground" />
          </div>
          <span className="text-sm font-medium">TubeShuffler</span>
        </div>

        <nav className="flex gap-6 text-sm text-muted-foreground">
          <Link href="/dashboard" className="hover:text-foreground transition-colors">
            Open app
          </Link>
        </nav>

        <p className="text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} TubeShuffler. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
