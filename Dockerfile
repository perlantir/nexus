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
RUN pnpm --filter @nexus/core --filter @nexus/sdk --filter @nexus/mcp --filter @nexus/server build

FROM node:22.12-slim AS production
LABEL maintainer="Perlantir"
LABEL org.opencontainers.image.authors="Perlantir"

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

RUN addgroup --system nexus && adduser --system --ingroup nexus nexus

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

USER nexus

EXPOSE 3100
CMD ["node", "packages/server/dist/index.js"]
