# syntax=docker/dockerfile:1
#
# Browser-capable FLUJO for Docker brains: the published FLUJO image plus a
# headless system Chromium and the Playwright MCP server, preinstalled. A
# brain born from this image carries a working "browser" skill from day one —
# no runtime downloads, no `playwright install` failing over missing system
# libraries inside the container.
#
# Debian's chromium is used instead of Playwright's own download on purpose:
# it is revision-independent (nothing to keep in sync with the MCP server's
# playwright version) and receives updates with the distro.
#
# Built by docker-compose (service `flujo`) and used for every managed brain
# via FLUJO_IMAGE. OS-independent by construction — the container is always
# Debian, whatever the host runs.

ARG FLUJO_IMAGE=ghcr.io/mario-andreschak/flujo:latest
FROM ${FLUJO_IMAGE}

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# The Playwright MCP server, global so the seeded "browser" skill starts
# instantly (bin: playwright-mcp). Its bundled playwright never needs to
# download a browser — the system Chromium is the one and only.
RUN npm install -g @playwright/mcp \
    && npm cache clean --force

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BRAIN_BROWSER_EXECUTABLE=/usr/bin/chromium

USER node
