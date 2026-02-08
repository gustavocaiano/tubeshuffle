import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import "@/lib/auth-types";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  session: {
    strategy: "database",
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // Fetch subscription tier from DB
        const dbUser = await db.user.findUnique({
          where: { id: user.id },
          select: { subscription: true },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (session.user as any).subscription = dbUser?.subscription ?? "FREE";
      }
      return session;
    },
  },
});
