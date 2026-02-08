import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Extract YouTube playlist ID from a URL or plain ID string.
 */
export function extractPlaylistId(input: string): string | null {
  // If it's already a plain ID (no slashes or dots)
  if (/^[A-Za-z0-9_-]+$/.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);
    const listParam = url.searchParams.get("list");
    if (listParam) return listParam;
  } catch {
    // Not a valid URL
  }

  // Try to find list= parameter in arbitrary string
  const match = input.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Format seconds into HH:MM:SS or MM:SS.
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Parse ISO 8601 duration (PT1H2M3S) to seconds.
 */
export function parseIsoDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Truncate a string to a max length with ellipsis.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}
