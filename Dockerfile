FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY keeper/package.json keeper/package-lock.json ./keeper/
RUN cd keeper && npm ci --omit=dev

COPY keeper/src ./keeper/src
COPY keeper/fixtures ./keeper/fixtures
COPY api ./api
COPY artifacts ./artifacts

ENV SERVICE=keeper
ENV DRIP_MODE=all

CMD ["sh", "-c", "mkdir -p /data /data/rounds && if [ \"$SERVICE\" = \"api\" ]; then node api/server.js; else node keeper/src/run-all.js; fi"]
