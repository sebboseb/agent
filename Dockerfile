FROM node:22-slim
WORKDIR /app

# better-sqlite3 compiles a native module at install time
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# Ledger lives on the mounted volume (Railway: mount at /data, set LEDGER_DB=/data/ledger.db)
ENV NODE_ENV=production
EXPOSE 8402
CMD ["npx", "tsx", "src/index.ts"]
