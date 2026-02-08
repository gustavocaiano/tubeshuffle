# Deployment Guide

## Docker Compose on a VPS (Recommended)

This project is designed to run as a set of Docker containers on any VPS (DigitalOcean, Hetzner, Linode, etc.).

### Prerequisites

- A VPS with at least 1 GB RAM
- Docker and Docker Compose installed ([install guide](https://docs.docker.com/engine/install/))
- A domain name pointing to your VPS IP (for HTTPS)
- Google OAuth credentials configured for your production domain
- Stripe account with production keys

### Step 1: Clone the Repository

```bash
git clone <your-repo-url>
cd youtube-randomizer
```

### Step 2: Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your production values:

```
# Database and Redis are handled by Docker Compose.
# These are overridden inside the containers, but you still need
# them here for the Prisma CLI to work outside Docker.
DATABASE_URL=postgresql://youtube_randomizer:changeme@localhost:5432/youtube_randomizer?schema=public
REDIS_URL=redis://localhost:6379

# You can customise the postgres credentials (used by docker-compose.yml)
POSTGRES_USER=youtube_randomizer
POSTGRES_PASSWORD=<a-strong-password>
POSTGRES_DB=youtube_randomizer

AUTH_SECRET=<generate with: openssl rand -base64 32>
AUTH_GOOGLE_ID=<from Google Cloud Console>
AUTH_GOOGLE_SECRET=<from Google Cloud Console>
YOUTUBE_API_KEY=<from Google Cloud Console>
NEXT_PUBLIC_STRIPE_PUBLIC_KEY=pk_live_...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_MONTHLY=price_...
STRIPE_PRICE_ID_YEARLY=price_...
MAX_FREE_PLAYLISTS=3
MAX_PREMIUM_PLAYLISTS=50
```

### Step 3: Build and Start

```bash
docker compose up -d --build
```

This starts three containers:
- **postgres** — PostgreSQL 16 database (port 5432)
- **redis** — Redis 7 cache (port 6379)
- **app** — Next.js application (port 3000)

### Step 4: Run Database Migrations

```bash
docker compose exec app npx prisma migrate deploy
```

### Step 5: Configure Stripe Webhooks

1. Go to [Stripe Dashboard > Webhooks](https://dashboard.stripe.com/webhooks)
2. Add endpoint: `https://yourdomain.com/api/webhooks/stripe`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET` in `.env`

### Step 6: Configure Google OAuth

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Edit your OAuth client
3. Add authorized redirect URI: `https://yourdomain.com/api/auth/callback/google`
4. Add authorized JavaScript origin: `https://yourdomain.com`

### Step 7: Set Up a Reverse Proxy (HTTPS)

Use Nginx or Caddy as a reverse proxy in front of the app container.

**Caddy (simplest — auto HTTPS):**

```
yourdomain.com {
    reverse_proxy localhost:3000
}
```

**Nginx (with certbot for Let's Encrypt):**

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Step 8: Verify

- [ ] Visit the app and test sign-in with Google
- [ ] Import a test playlist
- [ ] Shuffle and play videos
- [ ] Test Stripe payment flow (use test card 4242 4242 4242 4242)
- [ ] Verify webhook delivery in Stripe dashboard

## Useful Commands

```bash
# View logs
docker compose logs -f app

# Restart the app after .env changes
docker compose up -d --build app

# Stop everything
docker compose down

# Stop and remove all data (database + cache)
docker compose down -v

# Run Prisma Studio (browse DB)
docker compose exec app npx prisma studio
```

## Updating

```bash
git pull
docker compose up -d --build
docker compose exec app npx prisma migrate deploy
```

## Post-Deployment

### Monitoring
- Set up [UptimeRobot](https://uptimerobot.com) for uptime monitoring
- Configure Sentry DSN in environment variables for error tracking

### Scaling
- Increase VPS resources if needed (more RAM, CPU)
- Consider adding Redis persistence config for larger caches
- Monitor YouTube API quota usage in Google Cloud Console
