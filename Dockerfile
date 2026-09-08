FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir "modal==1.4.0"
WORKDIR /app
COPY . .
ENV NODE_ENV=production
CMD ["node", "src/railway-server.js"]
