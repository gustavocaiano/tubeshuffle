# Next Steps

A checklist of everything you need to set up before running the app.

---

## 1. Prerequisites

- [ ] **Node.js** >= 18 installed
- [ ] **Docker** & **Docker Compose** installed (for PostgreSQL + Redis)

---

## 2. Start the Database & Redis

```bash
docker compose up -d postgres redis
```

This spins up PostgreSQL 16 and Redis 7 locally.

---

## 3. Copy `.env.example` to `.env`

```bash
cp .env.example .env
```

Then fill in each section as described below.

---

## 4. API Keys & Secrets to Gather

### 4.1 — Auth Secret (NextAuth)

Generate a random secret for NextAuth session encryption:

```bash
openssl rand -base64 32
```

Set it as `AUTH_SECRET` in your `.env`.

### 4.2 — Google OAuth Credentials (`AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET`)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth client ID**
5. Choose **Web application**
6. Set **Authorized redirect URIs** to: `http://localhost:3000/api/auth/callback/google`
7. Copy the **Client ID** → `AUTH_GOOGLE_ID`
8. Copy the **Client Secret** → `AUTH_GOOGLE_SECRET`

### 4.3 — YouTube Data API Key (`YOUTUBE_API_KEY`)

1. In the same Google Cloud project, go to **APIs & Services > Library**
2. Search for **YouTube Data API v3** and enable it
3. Go to **APIs & Services > Credentials**
4. Click **Create Credentials > API Key**
5. (Recommended) Restrict the key to **YouTube Data API v3** only
6. Copy the key → `YOUTUBE_API_KEY`

> **Note:** The free quota is 10,000 units/day. A playlist fetch costs ~3 units, a video list costs ~5 units per page. This is usually enough for development but monitor usage in production.

### 4.4 — Stripe Keys (`STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`, etc.)

> **Skip this step** if you want to develop without payments first. The app should work with the FREE tier only.

1. Create a [Stripe account](https://dashboard.stripe.com/register)
2. Go to **Developers > API Keys**
3. Copy the **Publishable key** → `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`
4. Copy the **Secret key** → `STRIPE_SECRET_KEY`
5. Set up a webhook endpoint:
   - Go to **Developers > Webhooks**
   - Add endpoint: `http://localhost:3000/api/webhooks/stripe` (use Stripe CLI for local dev)
   - Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`
6. Create products/prices:
   - Go to **Products** and create a subscription product
   - Create a **Monthly** price → copy its ID to `STRIPE_PRICE_ID_MONTHLY`
   - Create a **Yearly** price → copy its ID to `STRIPE_PRICE_ID_YEARLY`

For local webhook testing, install the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

### 4.5 — Resend API Key (`RESEND_API_KEY`) — Optional

> **Skip this** unless you need transactional emails right away.

1. Create an account at [resend.com](https://resend.com)
2. Go to **API Keys** and create one
3. Copy it → `RESEND_API_KEY`
4. Set `FROM_EMAIL` to a verified sender address (or use `onboarding@resend.dev` for testing)

### 4.6 — Sentry DSN (`SENTRY_DSN`) — Optional

> **Skip this** unless you want error monitoring from day one.

1. Create a project at [sentry.io](https://sentry.io)
2. Choose **Next.js** as the platform
3. Copy the DSN → `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`

### 4.7 — Redis (`REDIS_URL`) — Optional

Already handled by Docker Compose. The default `redis://localhost:6379` in `.env.example` works out of the box. If Redis is not running, caching is gracefully disabled.

---

## 5. Initialize the Database

After setting `DATABASE_URL` in `.env`, run Prisma migrations to create all tables:

```bash
npx prisma migrate dev --name init
```

This will also generate the Prisma client.

---

## 6. Install Dependencies & Run

```bash
npm install
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

---

## 7. Summary Table

| Variable                         | Required? | Where to get it                     |
| -------------------------------- | --------- | ----------------------------------- |
| `DATABASE_URL`                   | Yes       | Auto from Docker Compose            |
| `AUTH_SECRET`                    | Yes       | `openssl rand -base64 32`           |
| `AUTH_GOOGLE_ID`                 | Yes       | Google Cloud Console (OAuth)        |
| `AUTH_GOOGLE_SECRET`             | Yes       | Google Cloud Console (OAuth)        |
| `YOUTUBE_API_KEY`                | Yes       | Google Cloud Console (API Key)      |
| `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`  | No*       | Stripe Dashboard                    |
| `STRIPE_SECRET_KEY`             | No*       | Stripe Dashboard                    |
| `STRIPE_WEBHOOK_SECRET`         | No*       | Stripe CLI / Dashboard              |
| `STRIPE_PRICE_ID_MONTHLY`       | No*       | Stripe Dashboard (Products)         |
| `STRIPE_PRICE_ID_YEARLY`        | No*       | Stripe Dashboard (Products)         |
| `REDIS_URL`                     | No        | Docker Compose (auto)               |
| `RESEND_API_KEY`                | No        | resend.com                          |
| `FROM_EMAIL`                    | No        | Your verified domain                |
| `SENTRY_DSN`                    | No        | sentry.io                           |

*\*Required only when you want to test payments/subscriptions.*

---

## 8. Recommended Development Order

1. **Get Google OAuth + YouTube API working** — this is the core of the app
2. **Build and test playlist import + shuffle** — the main feature
3. **Add Stripe** — once the core flow works
4. **Add Resend emails** — welcome emails, subscription confirmations
5. **Add Sentry** — before going to production
6. **Deploy** — see `DEPLOYMENT.md`
