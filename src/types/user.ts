export type SubscriptionTier = "FREE" | "PREMIUM";

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  subscription: SubscriptionTier;
  playlistCount: number;
  maxPlaylists: number;
}
