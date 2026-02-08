# API Documentation

This app uses [tRPC](https://trpc.io) for type-safe API communication. All endpoints are accessible via the tRPC client.

## Authentication

Most endpoints require authentication. The tRPC context includes the user session from NextAuth.js. Unauthenticated requests to protected procedures will receive a `401 UNAUTHORIZED` error.

## Routers

### `playlist` Router

#### `playlist.list` (Query, Protected)
List all playlists for the authenticated user.

**Returns:** Array of playlists with video counts.

#### `playlist.get` (Query, Protected)
Get a single playlist with all its videos.

**Input:**
```typescript
{ id: string }
```

**Returns:** Playlist with videos array ordered by position.

#### `playlist.import` (Mutation, Protected)
Import a YouTube playlist by URL.

**Input:**
```typescript
{ url: string }  // YouTube playlist URL or ID
```

**Returns:** Created playlist with videos.

**Errors:**
- `400 BAD_REQUEST` — Invalid URL format
- `403 FORBIDDEN` — Playlist limit reached (free: 3, premium: 50)
- `500 INTERNAL_SERVER_ERROR` — YouTube API error

#### `playlist.shuffle` (Mutation, Protected)
Shuffle the videos of a playlist.

**Input:**
```typescript
{
  playlistId: string;
  preset: "RANDOM" | "SMART" | "DISCOVERY" | "ENERGY";  // default: "RANDOM"
  excludeWatched: boolean;  // default: false
}
```

**Returns:** Array of shuffled videos.

**Errors:**
- `403 FORBIDDEN` — Premium preset without subscription
- `404 NOT_FOUND` — Playlist not found

#### `playlist.sync` (Mutation, Protected)
Sync a playlist with fresh YouTube data.

**Input:**
```typescript
{ id: string }
```

#### `playlist.delete` (Mutation, Protected)
Delete a playlist.

**Input:**
```typescript
{ id: string }
```

#### `playlist.recordPlay` (Mutation, Protected)
Record play history for a video.

**Input:**
```typescript
{
  playlistId: string;
  videoId: string;
  watchedSeconds: number;
  completed: boolean;
}
```

### `user` Router

#### `user.getProfile` (Query, Protected)
Get the current user's profile.

**Returns:**
```typescript
{
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  subscription: "FREE" | "PREMIUM";
  playlistCount: number;
  maxPlaylists: number;
  createdAt: Date;
}
```

#### `user.getAnalytics` (Query, Protected, Premium)
Get listening analytics.

**Returns:** `null` for free users, analytics object for premium:
```typescript
{
  totalPlays: number;
  completedPlays: number;
  completionRate: number;
  mostPlayed: Array<{ video: Video; playCount: number }>;
}
```

### `subscription` Router

#### `subscription.getStatus` (Query, Protected)
Get current subscription status.

**Returns:**
```typescript
{
  tier: "FREE" | "PREMIUM";
  subscription: {
    id: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null;
}
```

#### `subscription.createCheckout` (Mutation, Protected)
Create a Stripe Checkout session.

**Input:**
```typescript
{ priceId: string }
```

**Returns:** `{ url: string }` — Redirect URL to Stripe Checkout.

#### `subscription.getBillingPortal` (Mutation, Protected)
Create a Stripe Billing Portal session.

**Returns:** `{ url: string }` — Redirect URL to Stripe portal.

## Webhook Endpoints

### `POST /api/webhooks/stripe`
Handles Stripe webhook events. Verifies webhook signatures. Processes:
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
