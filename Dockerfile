# brain — UI (vite) + brain-manager (node) in one image. The manager serves
# the static UI, the lobby API, the per-brain FLUJO proxies, and the
# brain-stem MCP endpoints.
FROM node:22-alpine AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Served from the container root; FLUJO is reached via same-origin proxies.
RUN BRAIN_BASE=/ npm run build

FROM node:22-alpine
WORKDIR /app/manager
COPY manager/package.json manager/package-lock.json ./
RUN npm ci --omit=dev
COPY manager/tsconfig.json ./
COPY manager/src ./src
COPY manager/packages ./packages
COPY --from=ui /app/dist /app/ui
ENV PORT=80 UI_DIR=/app/ui DATA_DIR=/data NODE_ENV=production
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/api/health || exit 1
CMD ["npx", "tsx", "src/index.ts"]
