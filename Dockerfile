# ProofPay on Render (or any Docker host). Includes Chromium for the AI verifier.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Headless Chromium plus the system libraries it needs, for the evidence collector.
RUN npx playwright install --with-deps chromium
COPY . .
EXPOSE 10000
CMD ["node", "src/server.js"]
