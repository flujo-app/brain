# brain — UI (vite) + brain-manager (node) in one image. The manager serves
# the static UI, the lobby API, the per-brain FLUJO proxies, and the
# brain-stem MCP endpoints.
FROM node:22-alpine AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build with a RELATIVE base (vite.config default './') so the same dist works
# whether it's served from the container root (this image's manager) OR mounted
# under a sub-path by a consumer (brain-online serves it at /viewer/). An
# absolute base ('/assets/…') only resolves at root and 404s under a sub-path;
# relative refs resolve against the document location, so both hosts work. The
# viewer is query-routed (?flujo=…, no path segments), so the manager's
# deep-path SPA fallback never breaks relative asset URLs.
RUN BRAIN_BASE=./ npm run build

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
