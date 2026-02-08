#!/bin/sh
set -eu

PRISMA_CLI="/app/node_modules/prisma/build/index.js"
MAX_RETRIES=30
RETRY_DELAY=2

if [ ! -f "$PRISMA_CLI" ]; then
  echo "Prisma CLI not found at $PRISMA_CLI" >&2
  exit 127
fi

echo "Waiting for database to be ready..."
retry_count=0

while [ $retry_count -lt $MAX_RETRIES ]; do
  if node "$PRISMA_CLI" db push >/tmp/prisma-db-push.log 2>&1; then
    echo "Database connection successful!"
    break
  else
    retry_count=$((retry_count + 1))
    if [ $retry_count -eq $MAX_RETRIES ]; then
      echo "Failed to connect to database after $MAX_RETRIES attempts" >&2
      cat /tmp/prisma-db-push.log >&2
      exit 1
    fi
    echo "Database not ready, retrying in ${RETRY_DELAY}s... (attempt $retry_count/$MAX_RETRIES)"
    sleep $RETRY_DELAY
  fi
done

exec node server.js