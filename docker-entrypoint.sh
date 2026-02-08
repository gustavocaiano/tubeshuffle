#!/bin/sh
set -eu

PRISMA_CLI="/app/node_modules/prisma/build/index.js"

if [ ! -f "$PRISMA_CLI" ]; then
  echo "Prisma CLI not found at $PRISMA_CLI" >&2
  exit 127
fi

if node "$PRISMA_CLI" db push >/tmp/prisma-db-push.log 2>&1; then
  :
else
  code="$?"
  cat /tmp/prisma-db-push.log >&2 || true
  exit "$code"
fi
exec node server.js
