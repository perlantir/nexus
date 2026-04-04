# DeciGraph Server — multi-stage Docker build
# No CACHE_BUSTER needed here — server code is not cached by browsers.
# For the dashboard (browser-cached), see Dockerfile.dashboard.
FROM node:22.12-slim AS base
LABEL maintainer="Perlantir"
LABEL org.opencontainers.image.authors="Perlantir"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY turbo.json ./
COPY packages/ packages/
RUN pnpm --filter @decigraph/core --filter @decigraph/sdk --filter @decigraph/mcp --filter @decigraph/server build

FROM node:22.12-slim AS production
LABEL maintainer="Perlantir"
LABEL org.opencontainers.image.authors="Perlantir"

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

RUN addgroup --system decigraph && adduser --system --ingroup decigraph decigraph

COPY --from=base /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=base /app/packages/core/package.json packages/core/
COPY --from=base /app/packages/core/dist packages/core/dist/
COPY --from=base /app/packages/server/package.json packages/server/
COPY --from=base /app/packages/server/dist packages/server/dist/
COPY --from=base /app/packages/sdk/package.json packages/sdk/
COPY --from=base /app/packages/sdk/dist packages/sdk/dist/
COPY --from=base /app/node_modules node_modules/
COPY --from=base /app/packages/core/node_modules packages/core/node_modules/
COPY --from=base /app/packages/server/node_modules packages/server/node_modules/

USER decigraph

# Migrations: copied as fallback if volume mount is not provided.
# In docker-compose, ./supabase/migrations is mounted as a read-only volume.
COPY supabase/migrations /app/supabase/migrations

EXPOSE 3100
CMD ["node", "packages/server/dist/index.js"]
