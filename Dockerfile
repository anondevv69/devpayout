FROM node:20-slim

WORKDIR /app

# Root package (viem)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Keeper package
COPY keeper/package.json keeper/package-lock.json ./keeper/
RUN cd keeper && npm ci --omit=dev

# Keeper source + fixtures
COPY keeper/src ./keeper/src
COPY keeper/fixtures ./keeper/fixtures

CMD ["sh", "-c", "mkdir -p /data && (test -f /data/holders.csv || cp keeper/fixtures/holders-devs.csv /data/holders.csv 2>/dev/null || true); node keeper/src/index.js"]
