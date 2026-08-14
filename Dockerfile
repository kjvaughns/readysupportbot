# ReadySupport
#
# No browser is installed in this image. Playwright connects to Browserbase
# over CDP, so the browser runs there — which is the whole point of the
# persistent context. That keeps the image small and means a redeploy never
# discards the Readymode session.

FROM node:22-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree that gets copied forward.
RUN npm prune --omit=dev


FROM node:22-slim AS runtime

ENV NODE_ENV=production
# Belt and braces: nothing here should ever try to download a browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Run as the unprivileged user the base image already provides.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Verified selectors are mounted or baked in at deploy time. Without them the
# live workflows refuse to run rather than guessing — see docs/SELECTOR_DISCOVERY.md.
RUN mkdir -p /app/config && chown node:node /app/config

USER node

EXPOSE 3000

# The platform health check uses /health; /ready is the cheaper liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No init system and no wrapper script: the app installs its own SIGTERM
# handler, which finishes the job in flight before exiting. Wrapping it in a
# shell would swallow the signal and kill a workflow mid-change.
CMD ["node", "dist/index.js"]
