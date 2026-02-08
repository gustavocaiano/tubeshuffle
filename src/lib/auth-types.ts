import type { SubscriptionTier } from "@/types/user";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      subscription: SubscriptionTier;
    };
  }
}
