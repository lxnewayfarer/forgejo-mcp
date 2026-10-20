#!/bin/sh
set -e

# Apply database migrations before starting (idempotent).
# NOTE: `migrate deploy` runs on every container start. Prisma takes a Postgres
# advisory lock, so concurrent replica startups serialize safely. For large
# multi-replica rollouts prefer a dedicated one-shot migration job instead.
echo "[entrypoint] running prisma migrate deploy..."
npx prisma migrate deploy

echo "[entrypoint] starting: $*"
exec "$@"
