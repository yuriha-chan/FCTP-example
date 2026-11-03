FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/test-authority/ ./apps/test-authority/
COPY apps/territory-policy/ ./apps/territory-policy/
COPY apps/territory-sim/ ./apps/territory-sim/
COPY apps/client-server/ ./apps/client-server/
COPY apps/frontend/ ./apps/frontend/
COPY apps/demo/ ./apps/demo/
COPY apps/browser-harness/ ./apps/browser-harness/
COPY scripts/deployment.mjs scripts/serve.mjs ./scripts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --allow-build=esbuild --store-dir=/pnpm/store
RUN pnpm exec tsc -b apps/demo && pnpm run build:frontend && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ARG GIT_COMMIT=unknown
ARG GIT_DESCRIBE=
ARG GIT_DIRTY=false
ARG BUILD_TIME=
ENV FCTP_GIT_COMMIT=$GIT_COMMIT \
    FCTP_GIT_DESCRIBE=$GIT_DESCRIBE \
    FCTP_GIT_DIRTY=$GIT_DIRTY \
    FCTP_BUILD_TIME=$BUILD_TIME
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/client-server/dist ./apps/client-server/dist
COPY --from=build --chown=node:node /app/dist/apps/demo/client-server.js ./dist/apps/demo/client-server.js
COPY --from=build --chown=node:node /app/dist/frontend ./dist/frontend
COPY --from=build --chown=node:node /app/scripts/deployment.mjs /app/scripts/serve.mjs ./scripts/
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8080
ENTRYPOINT ["node", "scripts/serve.mjs", "client", "/config/config.json"]
