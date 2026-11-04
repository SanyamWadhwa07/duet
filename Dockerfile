# Duet WebSocket server. Build from the repo root:  docker build -t duet-server .
FROM node:22-alpine
WORKDIR /app

# Install only what the server needs: ws, tsx and the @duet/ot workspace link.
# Every workspace manifest is copied so npm ci can check the lockfile.
COPY package.json package-lock.json ./
COPY packages/ot/package.json packages/ot/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/bench/package.json packages/bench/
RUN npm ci --omit=dev --workspace @duet/server && npm cache clean --force

COPY packages/ot/src packages/ot/src
COPY packages/server/src packages/server/src

ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER node
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx", "src/index.ts"]
