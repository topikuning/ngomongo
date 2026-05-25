# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS builder
WORKDIR /app

# OpenSSL diperlukan oleh Prisma
RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ============ runtime ============
FROM node:24-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl tini

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000

# Migrasi Prisma TIDAK dijalankan di sini. Di Railway, migrasi dipanggil
# lewat `preDeployCommand` di railway.toml supaya tidak memotong jendela
# healthcheck. Untuk docker-compose lokal, migrasi dipanggil oleh service
# `migrate` sekali jalan (lihat docker-compose.yml).
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/server.js"]
