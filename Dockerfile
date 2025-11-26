# Hysteria Backend - Docker Image
FROM node:20-alpine

WORKDIR /app

# Устанавливаем системные зависимости (mongodump для бэкапов)
RUN apk add --no-cache mongodb-tools

# Копируем зависимости
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --omit=dev

# Копируем исходники
COPY . .

# Создаём директории для логов, сертификатов и бэкапов
RUN mkdir -p logs greenlock.d/live greenlock.d/accounts backups && \
    chmod -R 755 greenlock.d backups

# Порты
EXPOSE 8444 80 443

# Запуск
CMD ["node", "index.js"]

