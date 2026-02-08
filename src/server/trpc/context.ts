import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export async function createContext() {
  const session = await auth();

  return {
    session,
    db,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
