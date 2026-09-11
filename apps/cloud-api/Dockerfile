FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/cloud-api/package.json apps/cloud-api/package.json
RUN pnpm install --frozen-lockfile --filter @forge/cloud-api...

COPY packages/contracts packages/contracts
COPY apps/cloud-api apps/cloud-api
RUN pnpm --filter @forge/contracts build \
 && pnpm --filter @forge/cloud-api build \
 && pnpm --filter @forge/cloud-api deploy --prod --legacy /prod/cloud-api

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/cloud-api ./

USER node
EXPOSE 4790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FORGE_CLOUD_PORT||4790)+'/v1/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
