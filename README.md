# Hysteria Panel

Веб-панель для управления серверами [Hysteria 2](https://v2.hysteria.network/) с HTTP-авторизацией, автоматической настройкой нод и гибким распределением пользователей по группам.

## ✨ Возможности

- 🖥 **Веб-панель** — полноценный UI для управления нодами и пользователями
- 🔐 **HTTP-авторизация** — централизованная проверка клиентов через API
- 🚀 **Автонастройка нод** — установка Hysteria, сертификатов и port hopping в один клик
- 👥 **Группы серверов** — гибкая привязка пользователей к нодам
- ⚖️ **Балансировка нагрузки** — распределение по загруженности
- 📊 **Статистика** — онлайн, трафик, состояние серверов
- 📱 **Подписки** — автоформаты для Clash, Sing-box, Shadowrocket
- 🔄 **Бэкап/Восстановление** — автоматические бэкапы базы
- 🖥 **SSH-терминал** — прямой доступ к нодам из браузера

---

## 🏗 Архитектура

```
┌──────────────────────────────────────────────────────────────────┐
│                          КЛИЕНТЫ                                 │
│         (Clash, Sing-box, Shadowrocket, Hiddify, ...)           │
└─────────────────────────────┬────────────────────────────────────┘
                              │ hysteria2://user:pass@node:443
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                       HYSTERIA НОДЫ                              │
│                   (VPS в разных странах)                         │
│                                                                  │
│  ┌─────────────────────┐     ┌─────────────────────┐            │
│  │   🇳🇱 Нидерланды    │     │    🇨🇭 Швейцария    │    ...     │
│  │   Hysteria 2        │     │    Hysteria 2       │            │
│  │   :443 + hopping    │     │    :443 + hopping   │            │
│  │   Stats API :9999   │     │    Stats API :9999  │            │
│  └──────────┬──────────┘     └──────────┬──────────┘            │
└─────────────┼────────────────────────────┼───────────────────────┘
              │ POST /api/auth             │
              │ GET /online                │
              ▼                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                      HYSTERIA PANEL                              │
│                    (этот проект)                                 │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ Веб-панель │  │ HTTP Auth  │  │ Подписки   │  │ Синхрон.   │ │
│  │  /panel    │  │ /api/auth  │  │ /api/files │  │  Service   │ │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘ │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │
│  │   SSH      │  │  Backup    │  │   Stats    │                 │
│  │  Терминал  │  │  Service   │  │  Collector │                 │
│  └────────────┘  └────────────┘  └────────────┘                 │
└─────────────────────────────┬────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                         MONGODB                                  │
│        (пользователи, ноды, группы, настройки)                  │
└──────────────────────────────────────────────────────────────────┘
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

## 🚀 Установка

### Требования

- Docker + Docker Compose
- Домен для панели (для Let's Encrypt)
- VPS для нод (Ubuntu 20.04+ / Debian 11+)

### 1. Клонируйте репозиторий

```bash
git clone https://github.com/your-repo/hysteria-panel.git
cd hysteria-panel
```

### 2. Создайте файл окружения

```bash
cp docker.env.example .env
nano .env
```

**Обязательные параметры:**

```env
# Домен панели (без https://)
PANEL_DOMAIN=panel.example.com

# Email для Let's Encrypt
ACME_EMAIL=admin@example.com

# Секреты (генерируйте случайные!)
ENCRYPTION_KEY=ваш32символьныйключ  # openssl rand -hex 16
SESSION_SECRET=вашсекретсессий       # openssl rand -hex 32
MONGO_PASSWORD=парольмонго          # openssl rand -hex 16
```

### 3. Запустите

```bash
docker-compose up -d
```

### 4. Откройте панель

Перейдите на `https://ваш-домен/panel` и создайте первого администратора.

---

## 📖 API Reference

### Авторизация (для нод)

#### POST `/api/auth`

Проверка пользователя при подключении к ноде.

**Request:**
```json
{
  "addr": "1.2.3.4:12345",
  "auth": "userId:password",
  "tx": 1000000
}
```

**Response (успех):**
```json
{
  "ok": true,
  "id": "userId"
}
```

**Response (ошибка):**
```json
{
  "ok": false
}
```

---

### Подписки

#### GET `/api/files/:token`

Универсальный эндпоинт подписки. Автоматически определяет формат по User-Agent.

| User-Agent содержит | Формат |
|---------------------|--------|
| `shadowrocket` | Base64 URI list |
| `clash`, `stash`, `surge` | Clash YAML |
| `hiddify`, `sing-box`, `sfi/sfa/sfm` | Sing-box JSON |
| Browser | HTML страница |
| Другое | Plain URI list |

**Query параметры:**
- `?format=clash` — принудительно Clash YAML
- `?format=singbox` — принудительно Sing-box JSON
- `?format=uri` — Plain URI list

**Response Headers:**
```
Profile-Update-Interval: 12
Subscription-Userinfo: upload=0; download=1234567; total=10737418240; expire=1735689600
```

#### GET `/api/info/:token`

Информация о подписке.

**Response:**
```json
{
  "enabled": true,
  "groups": ["groupId1", "groupId2"],
  "traffic": { "used": 1234567, "limit": 10737418240 },
  "expire": "2025-01-01T00:00:00.000Z",
  "servers": 5
}
```

---

### Пользователи

#### GET `/api/users`

Список пользователей с пагинацией.

**Query:**
- `enabled=true|false` — фильтр по статусу
- `group=groupId` — фильтр по группе
- `page=1` — страница
- `limit=50` — лимит

**Response:**
```json
{
  "users": [...],
  "pagination": { "page": 1, "limit": 50, "total": 100, "pages": 2 }
}
```

#### POST `/api/users`

Создать пользователя.

**Body:**
```json
{
  "userId": "telegram123",
  "username": "Иван",
  "groups": ["groupId1"],
  "enabled": true,
  "trafficLimit": 10737418240,
  "expireAt": "2025-01-01T00:00:00.000Z",
  "maxDevices": 3
}
```

#### PUT `/api/users/:userId`

Обновить пользователя.

#### DELETE `/api/users/:userId`

Удалить пользователя.

#### POST `/api/users/:userId/enable`
#### POST `/api/users/:userId/disable`

Включить/отключить пользователя.

#### POST `/api/users/:userId/groups`

Добавить пользователя в группы.

**Body:**
```json
{
  "groups": ["groupId1", "groupId2"]
}
```

---

### Ноды

#### GET `/api/nodes`

Список нод.

**Query:**
- `active=true|false`
- `group=groupId`
- `status=online|offline|error`

#### POST `/api/nodes`

Создать ноду.

**Body:**
```json
{
  "name": "Нидерланды",
  "ip": "1.2.3.4",
  "domain": "nl.example.com",
  "port": 443,
  "portRange": "20000-50000",
  "groups": ["groupId"],
  "ssh": {
    "port": 22,
    "username": "root",
    "password": "encrypted"
  },
  "maxOnlineUsers": 100,
  "rankingCoefficient": 1.0
}
```

#### PUT `/api/nodes/:id`

Обновить ноду.

#### DELETE `/api/nodes/:id`

Удалить ноду.

#### GET `/api/nodes/:id/status`

Статус ноды.

**Response:**
```json
{
  "name": "Нидерланды",
  "status": "online",
  "onlineUsers": 42,
  "lastSync": "2024-01-01T12:00:00.000Z"
}
```

#### GET `/api/nodes/:id/config`

Получить сгенерированный конфиг ноды (YAML).

#### POST `/api/nodes/:id/update-config`

Обновить конфиг на ноде через SSH.

#### POST `/api/nodes/:id/setup-port-hopping`

Настроить port hopping на ноде.

---

### Группы

#### GET `/api/groups`

Список групп.

#### POST `/api/groups`

Создать группу.

**Body:**
```json
{
  "name": "Premium",
  "description": "Премиум серверы",
  "color": "#f59e0b",
  "maxDevices": 5
}
```

#### PUT `/api/groups/:id`
#### DELETE `/api/groups/:id`

---

### Синхронизация

#### POST `/api/sync`

Синхронизировать конфиги на всех нодах.

---

## 🔧 Настройка нод

### Автоматическая настройка

1. Добавьте ноду в панели (IP, SSH доступ)
2. Нажмите "⚙️ Автонастройка"
3. Панель автоматически:
   - Установит Hysteria 2
   - Настроит ACME (если указан домен)
   - Настроит port hopping
   - Откроет порты в firewall
   - Запустит сервис

### Ручная настройка

1. Установите Hysteria на сервере:
```bash
bash <(curl -fsSL https://get.hy2.sh/)
```

2. Создайте конфиг `/etc/hysteria/config.yaml`:
```yaml
listen: :443

acme:
  domains:
    - your-domain.com
  email: acme@your-domain.com

auth:
  type: http
  http:
    url: https://panel.example.com/api/auth
    insecure: false

trafficStats:
  listen: :9999
  secret: ваш_секретный_ключ

masquerade:
  type: proxy
  proxy:
    url: https://www.google.com
    rewriteHost: true
```

3. Запустите:
```bash
systemctl enable --now hysteria-server
```

4. Настройте port hopping:
```bash
iptables -t nat -A PREROUTING -p udp --dport 20000:50000 -j REDIRECT --to-port 443
```

5. Откройте порт статистики для IP панели:
```bash
iptables -A INPUT -p tcp --dport 9999 -s IP_ПАНЕЛИ -j ACCEPT
```

---

## 📊 Модели данных

### User (HyUser)

| Поле | Тип | Описание |
|------|-----|----------|
| `userId` | String | Уникальный ID (например, Telegram ID) |
| `subscriptionToken` | String | Токен для URL подписки |
| `username` | String | Имя для отображения |
| `password` | String | Пароль для Hysteria (автогенерация) |
| `enabled` | Boolean | Активен ли пользователь |
| `groups` | [ObjectId] | Группы серверов |
| `traffic.tx/rx` | Number | Отправлено/получено байт |
| `trafficLimit` | Number | Лимит трафика (0 = безлимит) |
| `maxDevices` | Number | Лимит устройств (0 = из группы, -1 = безлимит) |
| `expireAt` | Date | Дата истечения |

### Node (HyNode)

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | String | Название (Нидерланды, Германия, ...) |
| `ip` | String | IP адрес |
| `domain` | String | Домен для SNI и ACME |
| `port` | Number | Основной порт (443) |
| `portRange` | String | Диапазон портов для hopping |
| `statsPort` | Number | Порт Stats API (9999) |
| `statsSecret` | String | Секрет для Stats API |
| `groups` | [ObjectId] | Группы серверов |
| `ssh.port/username/password/privateKey` | - | SSH доступ |
| `status` | String | online/offline/error/syncing |
| `onlineUsers` | Number | Текущее количество онлайн |
| `maxOnlineUsers` | Number | Лимит онлайн (для балансировки) |
| `rankingCoefficient` | Number | Приоритет в подписке (меньше = выше) |

### ServerGroup

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | String | Название группы |
| `description` | String | Описание |
| `color` | String | Цвет для UI (#hex) |
| `active` | Boolean | Активна ли группа |
| `maxDevices` | Number | Лимит устройств (0 = без лимита) |

---

## ⚖️ Балансировка нагрузки

Настраивается в разделе "Настройки" панели.

**Параметры:**

- **Балансировка включена** — сортировка нод по загруженности
- **Скрывать перегруженные** — не выдавать ноды, где `onlineUsers >= maxOnlineUsers`

**Как работает:**

1. При запросе подписки собираются ноды пользователя
2. Если балансировка включена — сортируем по % загрузки (online/max)
3. Если скрытие включено — исключаем перегруженные
4. При равной загрузке — сортируем по `rankingCoefficient`

---

## 🔒 Лимит устройств

Ограничение одновременных подключений пользователя.

**Приоритет:**
1. Персональный лимит пользователя (`user.maxDevices > 0`)
2. Минимальный лимит из групп пользователя
3. `-1` у пользователя = безлимит

**Как работает:**

При каждом `POST /api/auth`:
1. Запрашиваем `/online` со всех нод
2. Считаем сессии этого userId
3. Если `>= maxDevices` → отклоняем подключение

---

## 💾 Бэкапы

### Автоматические бэкапы

Настраиваются в разделе "Настройки". Сохраняются в `./backups/`.

### Ручной бэкап

Кнопка "Создать бэкап" на дашборде. Файл скачивается автоматически.

### Восстановление

1. Кнопка "Восстановить БД" на дашборде
2. Загрузите `.tar.gz` архив бэкапа
3. База будет восстановлена с полной заменой

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
      MONGO_INITDB_DATABASE: hysteria
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

## 🤝 Contributing

Pull requests welcome! Пожалуйста, следуйте code style проекта.

---

## 📄 License

MIT

