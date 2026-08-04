FROM node:24-bookworm-slim

ARG DEEPFILTER_VERSION=0.5.6
ARG DEEPFILTER_SHA256=14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl ffmpeg tini \
  && curl --fail --location --retry 3 \
    --output /usr/local/bin/deep-filter \
    "https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEPFILTER_VERSION}/deep-filter-${DEEPFILTER_VERSION}-aarch64-unknown-linux-gnu" \
  && echo "${DEEPFILTER_SHA256}  /usr/local/bin/deep-filter" | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/deep-filter \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.9.0 \
  && pnpm install --prod --frozen-lockfile \
  && pnpm store prune

COPY --chown=node:node \
  give_me_five.html \
  server.js \
  transcribe-worker.js \
  render-timing.js \
  marker-analysis.js \
  visual-entry.js \
  music-suitability.js \
  README.md \
  SECURITY.md \
  THIRD_PARTY_NOTICES.md \
  ./
COPY --chown=node:node assets ./assets

RUN mkdir -p /var/lib/give-me-five/session /var/lib/give-me-five/models \
  && chown -R node:node /app /var/lib/give-me-five

ENV NODE_ENV=production \
  GMF_HOST=0.0.0.0 \
  GMF_WORK_DIR=/var/lib/give-me-five/session \
  GMF_MODEL_DIR=/var/lib/give-me-five/models \
  GMF_FFMPEG_PATH=/usr/bin/ffmpeg \
  GMF_FFPROBE_PATH=/usr/bin/ffprobe \
  GMF_DEEPFILTER_PATH=/usr/local/bin/deep-filter \
  GMF_TRUST_PROXY=true \
  GMF_HTTPS=true \
  GMF_MAX_UPLOAD_MB=300 \
  GMF_MAX_RUNNING_UPLOADS=1 \
  GMF_MAX_RUNNING_ANALYSES=1 \
  GMF_MAX_RUNNING_EXPORTS=1 \
  GMF_MAX_RUNNING_TRANSCRIPTS=1

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:4173/api/health >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
