# syntax=docker/dockerfile:1
FROM node:22.19.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/actor-assertion/package.json packages/actor-assertion/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/login-contract/package.json packages/login-contract/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/source-connection-contract/package.json packages/source-connection-contract/package.json
COPY tools/fixtures/package.json tools/fixtures/package.json
COPY tools/legacy-import/package.json tools/legacy-import/package.json
COPY tools/reconciliation/package.json tools/reconciliation/package.json
COPY tools/search-bakeoff/package.json tools/search-bakeoff/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.19.0-bookworm-slim AS runtime

# Coolify's container healthcheck runs curl INSIDE the container. The slim base
# has neither curl nor wget, so a healthchecked deploy would be marked unhealthy
# and rolled back. Install curl in the runtime image (bookworm-slim has apt).
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
# Persist the build revision in the image filesystem rather than ENV. Runtime
# environment overrides can replace ENV defaults; the node user cannot rewrite
# this root-owned image artifact.
RUN printf '%s\n' "$SOURCE_REVISION" > /image-source-revision \
    && chmod 0444 /image-source-revision
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=build /app/packages/actor-assertion/package.json ./packages/actor-assertion/package.json
COPY --from=build /app/packages/actor-assertion/dist ./packages/actor-assertion/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/login-contract/package.json ./packages/login-contract/package.json
COPY --from=build /app/packages/login-contract/dist ./packages/login-contract/dist
COPY deploy/coolify ./deploy/coolify

RUN chmod 0555 deploy/coolify/gateway-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["./deploy/coolify/gateway-entrypoint.sh"]
