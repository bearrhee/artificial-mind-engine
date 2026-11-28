FROM node:22-alpine

WORKDIR /app

# Create app directory owned by uid 1000 (standard Hugging Face Docker Spaces non-root UID).
# Runtime file persistence is directed to /tmp so strict read-only root filesystems work cleanly.
RUN chown -R 1000:1000 /app

COPY --chown=1000:1000 package.json ./package.json
COPY --chown=1000:1000 spec/openapi.yaml ./spec/openapi.yaml
COPY --chown=1000:1000 packages/sdk-ts ./packages/sdk-ts
COPY --chown=1000:1000 packages/sandbox-server ./packages/sandbox-server

USER 1000

ENV NODE_ENV=production
ENV AME_HOST=0.0.0.0
ENV AME_PORT=7860
ENV AME_STORAGE_MODE=file
ENV AME_STORAGE_PATH=/tmp/ame-sandbox-state.json

EXPOSE 7860

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.AME_PORT || 7860) + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/sandbox-server/bin/serve.mjs"]
