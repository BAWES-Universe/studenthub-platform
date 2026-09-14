# syntax=docker/dockerfile:1
FROM node:22.19.0-bookworm-slim AS build

WORKDIR /app
# npm must see every workspace before installing, including newly added packages.
COPY . .
RUN npm ci --ignore-scripts
RUN npm run build && npm prune --omit=dev
RUN node deploy/coolify/stage-workspaces.mjs /runtime-workspaces

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
# Generated from npm's workspace links; no per-package allowlist to go stale.
COPY --from=build /runtime-workspaces/ ./
COPY deploy/coolify ./deploy/coolify

RUN chmod 0555 deploy/coolify/gateway-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["./deploy/coolify/gateway-entrypoint.sh"]
