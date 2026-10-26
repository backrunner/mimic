FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
RUN npm install --global pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM build AS production-deps
RUN CI=true pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 MIMIC_DATA_DIR=/data MIMIC_INGRESS_HOST=0.0.0.0 MIMIC_BROKER_HOST=0.0.0.0 BODY_SIZE_LIMIT=2M
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/dashboard/build ./apps/dashboard/build
COPY --from=build /app/scripts/start.mjs /app/scripts/dashboard.mjs ./scripts/
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build /app/LICENSES ./LICENSES
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3210 3211 3215
STOPSIGNAL SIGTERM
CMD ["node", "scripts/start.mjs"]
