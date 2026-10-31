FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/test-authority/ ./apps/test-authority/
COPY apps/territory-policy/ ./apps/territory-policy/
COPY apps/territory-sim/ ./apps/territory-sim/
COPY apps/client-server/ ./apps/client-server/
COPY apps/client/ ./apps/client/
COPY apps/demo/ ./apps/demo/
COPY apps/browser-harness/ ./apps/browser-harness/
COPY scripts/deployment.mjs scripts/serve.mjs ./scripts/
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/territory-policy/dist ./apps/territory-policy/dist
COPY --from=build --chown=node:node /app/scripts/deployment.mjs /app/scripts/serve.mjs ./scripts/
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8080
ENTRYPOINT ["node", "scripts/serve.mjs", "policy", "/config/config.json"]
