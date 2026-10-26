# Hysteria Backend - Docker Image
FROM node:22-alpine

WORKDIR /app

# System dependencies: mongodb-tools for backups. The access-logs pipeline now
# talks to an external ClickHouse over HTTP (pure-JS client), so no native
# runtime libraries are needed.
RUN apk add --no-cache mongodb-tools

# Копируем зависимости
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --omit=dev

# Копируем исходники
COPY . .

# Create directories for logs, certificates, backups and access-logs data.
RUN mkdir -p logs greenlock.d/live greenlock.d/accounts backups data/access-logs && \
    chmod -R 755 greenlock.d backups data

# Порты
EXPOSE 8444 80 443

# Запуск
CMD ["node", "index.js"]

