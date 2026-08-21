# ReadySupport backend — production image.
#
# The Playwright base image ships a matching Chromium build plus every system
# library it needs. Remote Browserbase sessions are the default execution mode,
# but a local browser keeps self-hosted and diagnostic runs working too.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS builder

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY supabase ./supabase
# The recorded interface inspection and the Help Center bank. The knowledge
# loader reads these at run time, so an image without them starts with no
# documentation at all.
COPY data ./data

# Railway injects PORT at runtime; EXPOSE is documentation only.
EXPOSE 8080

# The health endpoint answers as soon as the process is alive, even when
# third-party credentials are still missing (setup mode).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
