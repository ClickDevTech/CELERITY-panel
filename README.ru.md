# C³ CELERITY

⚡ **Быстро, просто и надолго**

[English](README.md) | **[Русский](README.ru.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](package.json)
[![Hysteria](https://img.shields.io/badge/Hysteria-2.x-9B59B6)](https://v2.hysteria.network/)

**C³ CELERITY** by Click Connect — современная веб-панель для управления серверами [Hysteria 2](https://v2.hysteria.network/) с централизованной HTTP-авторизацией, автоматической настройкой нод и гибким распределением пользователей по группам.

## ⚡ Быстрый старт

**1. Установите Docker** (если не установлен):
```bash
curl -fsSL https://get.docker.com | sh
```

**2. Разверните панель:**
```bash
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel
cp docker.env.example .env
nano .env  # Укажите домен, email и секреты
docker compose up -d
```

**3. Откройте** `https://ваш-домен/panel`

**Обязательные переменные `.env`:**
```env
PANEL_DOMAIN=panel.example.com
ACME_EMAIL=admin@example.com
ENCRYPTION_KEY=ваш32символьныйключ  # openssl rand -hex 16
SESSION_SECRET=секретсессий         # openssl rand -hex 32
MONGO_PASSWORD=парольмонго         # openssl rand -hex 16
```

---

## ✨ Возможности

- 🖥 **Веб-панель** — полноценный UI для управления нодами и пользователями
- 🔐 **HTTP-авторизация** — централизованная проверка клиентов через API
- 🚀 **Автонастройка нод** — установка Hysteria, сертификатов и port hopping в один клик
- 👥 **Группы серверов** — гибкая привязка пользователей к нодам
- ⚖️ **Балансировка нагрузки** — распределение по загруженности
- 📊 **Статистика** — онлайн, трафик, состояние серверов
- 📱 **Подписки** — автоформаты для Clash, Sing-box, Shadowrocket
- 🔄 **Бэкап/Восстановление** — автоматические бэкапы базы
- 💻 **SSH-терминал** — прямой доступ к нодам из браузера

---

## 🏗 Архитектура

```
                              ┌─────────────────┐
                              │     КЛИЕНТЫ     │
                              │ Clash, Sing-box │
                              │   Shadowrocket  │
                              └────────┬────────┘
                                       │
                          hysteria2://user:pass@host
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
     │      Нода       │      │      Нода       │      │      Нода       │
     │   Hysteria 2    │      │   Hysteria 2    │      │   Hysteria 2    │
     │   :443 + hop    │      │   :443 + hop    │      │   :443 + hop    │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
              │                        │                        │
              │    POST /api/auth      │                        │
              │    GET /online         │                        │
              └────────────────────────┼────────────────────────┘
                                       ▼
                          ┌────────────────────────┐
                          │    HYSTERIA PANEL      │
                          │                        │
                          │  • Веб-панель (/panel) │
                          │  • HTTP Auth API       │
                          │  • Подписки            │
                          │  • SSH-терминал        │
                          │  • Сбор статистики     │
                          └───────────┬────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │       MongoDB          │
                          └────────────────────────┘
```

### Как работает авторизация

1. Клиент подключается к ноде Hysteria с `userId:password`
2. Нода отправляет `POST /api/auth` на панель
3. Панель проверяет: существует ли пользователь, активен ли, не превышен ли лимит устройств/трафика
4. Возвращает `{ "ok": true, "id": "userId" }` или `{ "ok": false }`

### Группы серверов

Вместо жёстких "планов" используются гибкие группы:
- Создайте группу (например, "Европа", "Premium")
- Привяжите к ней ноды
- Привяжите пользователей
- Пользователь получает в подписке только ноды из своих групп

---

## 📖 API

### Авторизация (для нод)

#### POST `/api/auth`

Проверка пользователя при подключении.

```json
// Запрос
{ "addr": "1.2.3.4:12345", "auth": "userId:password" }

// Ответ (успех)
{ "ok": true, "id": "userId" }

// Ответ (ошибка)
{ "ok": false }
```

### Подписки

#### GET `/api/files/:token`

Универсальный эндпоинт подписки. Автоматически определяет формат по User-Agent.

| User-Agent | Формат |
|------------|--------|
| `shadowrocket` | Base64 URI list |
| `clash`, `stash`, `surge` | Clash YAML |
| `hiddify`, `sing-box` | Sing-box JSON |
| Браузер | HTML страница |
| Другое | Plain URI list |

**Query параметры:** `?format=clash`, `?format=singbox`, `?format=uri`

### Пользователи

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| GET | `/api/users` | Список пользователей |
| GET | `/api/users/:userId` | Получить пользователя |
| POST | `/api/users` | Создать пользователя |
| PUT | `/api/users/:userId` | Обновить пользователя |
| DELETE | `/api/users/:userId` | Удалить пользователя |
| POST | `/api/users/:userId/enable` | Включить |
| POST | `/api/users/:userId/disable` | Отключить |

### Ноды

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| GET | `/api/nodes` | Список нод |
| GET | `/api/nodes/:id` | Получить ноду |
| POST | `/api/nodes` | Создать ноду |
| PUT | `/api/nodes/:id` | Обновить ноду |
| DELETE | `/api/nodes/:id` | Удалить ноду |
| GET | `/api/nodes/:id/config` | Получить конфиг (YAML) |
| POST | `/api/nodes/:id/update-config` | Отправить конфиг через SSH |

### Синхронизация

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| POST | `/api/sync` | Синхронизировать все ноды |

---

## 🔧 Настройка нод

### Автоматическая (рекомендуется)

1. Добавьте ноду в панели (IP, SSH доступ)
2. Нажмите "⚙️ Автонастройка"
3. Панель автоматически:
   - Установит Hysteria 2
   - Настроит ACME сертификаты
   - Настроит port hopping
   - Откроет порты в firewall
   - Запустит сервис

### Ручная

```bash
# Установка Hysteria
bash <(curl -fsSL https://get.hy2.sh/)

# Создайте конфиг /etc/hysteria/config.yaml
listen: :443

acme:
  domains: [ваш-домен.com]
  email: acme@ваш-домен.com

auth:
  type: http
  http:
    url: https://panel.example.com/api/auth
    insecure: false

trafficStats:
  listen: :9999
  secret: ваш_секрет

masquerade:
  type: proxy
  proxy:
    url: https://www.google.com
    rewriteHost: true
```

```bash
# Запуск
systemctl enable --now hysteria-server

# Port hopping
iptables -t nat -A PREROUTING -p udp --dport 20000:50000 -j REDIRECT --to-port 443
```

---

## 📊 Модели данных

### Пользователь

| Поле | Тип | Описание |
|------|-----|----------|
| `userId` | String | Уникальный ID |
| `subscriptionToken` | String | Токен для URL подписки |
| `enabled` | Boolean | Активен ли пользователь |
| `groups` | [ObjectId] | Группы серверов |
| `trafficLimit` | Number | Лимит трафика в байтах (0 = безлимит) |
| `maxDevices` | Number | Лимит устройств (0 = из группы, -1 = безлимит) |
| `expireAt` | Date | Дата истечения |

### Нода

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | String | Название |
| `ip` | String | IP адрес |
| `domain` | String | Домен для SNI/ACME |
| `port` | Number | Основной порт (443) |
| `portRange` | String | Диапазон портов для hopping |
| `groups` | [ObjectId] | Группы серверов |
| `maxOnlineUsers` | Number | Макс. онлайн для балансировки |
| `status` | String | online/offline/error |

### Группа серверов

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | String | Название группы |
| `color` | String | Цвет для UI (#hex) |
| `maxDevices` | Number | Лимит устройств для группы |

---

## ⚖️ Балансировка нагрузки

Настраивается в разделе "Настройки":

- **Балансировка включена** — сортировка нод по загруженности
- **Скрывать перегруженные** — не выдавать ноды, где онлайн >= максимум

Алгоритм:
1. Получаем ноды пользователя из групп
2. Сортируем по % загрузки (online/max)
3. Фильтруем перегруженные если включено
4. При равной загрузке — по `rankingCoefficient`

---

## 🔒 Лимит устройств

Ограничение одновременных подключений пользователя.

**Приоритет:**
1. Персональный лимит пользователя (`maxDevices > 0`)
2. Минимальный лимит из групп пользователя
3. `-1` = безлимит

При каждом `POST /api/auth`:
1. Запрашиваем `/online` со всех нод
2. Считаем сессии этого userId
3. Отклоняем если `>= maxDevices`

---

## 💾 Бэкапы

- **Автобэкапы** — настраиваются в Настройках
- **Ручной бэкап** — кнопка на дашборде, автоскачивание
- **Восстановление** — загрузите `.tar.gz` архив

---

## 🐳 Docker Compose

```yaml
version: '3.8'

services:
  mongo:
    image: mongo:7
    restart: always
    volumes:
      - mongo_data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER:-hysteria}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD}

  backend:
    build: .
    restart: always
    depends_on:
      - mongo
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./logs:/app/logs
      - ./greenlock.d:/app/greenlock.d
      - ./backups:/app/backups
    env_file:
      - .env

volumes:
  mongo_data:
```

---

## 📝 Переменные окружения

| Переменная | Обязательно | Описание |
|------------|-------------|----------|
| `PANEL_DOMAIN` | ✅ | Домен панели |
| `ACME_EMAIL` | ✅ | Email для Let's Encrypt |
| `ENCRYPTION_KEY` | ✅ | Ключ шифрования SSH (32 символа) |
| `SESSION_SECRET` | ✅ | Секрет сессий |
| `MONGO_PASSWORD` | ✅ | Пароль MongoDB |
| `MONGO_USER` | ❌ | Пользователь MongoDB (default: hysteria) |
| `PANEL_IP_WHITELIST` | ❌ | IP whitelist для панели |
| `SYNC_INTERVAL` | ❌ | Интервал синхронизации в минутах (default: 2) |

---

## 🤝 Участие в разработке

Pull requests приветствуются!

---

## 📄 Лицензия

MIT



