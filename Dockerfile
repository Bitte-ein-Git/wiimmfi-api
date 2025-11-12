# Dockerfile
FROM node:18-slim

WORKDIR /app

COPY package*.json ./

# Install *only* the minimal dependencies for headless chrome-aws-lambda
# Diese Liste ist viel kleiner und vermeidet die GUI-Konflikte.
RUN apt-get update && \
    apt-get install -yq \
    ca-certificates \
    fonts-liberation \
    libfontconfig1 \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libpango-1.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    npm install --omit=dev

COPY . .

EXPOSE 8080
CMD ["npm", "start"]
