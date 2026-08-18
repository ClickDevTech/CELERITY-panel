# C³ CELERITY

⚡ **Быстро, просто и надолго**

[English](README.md) | **[Русский](README.ru.md)**

[License: MIT](LICENSE)
[Docker Pulls](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[Docker Image Size](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[Node.js](package.json)
[Hysteria](https://v2.hysteria.network/)
[Xray](https://xtls.github.io/)
[![Telegram](https://img.shields.io/badge/Telegram-Chat-2CA5E0?logo=telegram&logoColor=white)](https://t.me/+JKFdEr7TqvIyOTFi)
[![Поддержать](https://img.shields.io/badge/%E2%99%A5-%D0%9F%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%B0%D1%82%D1%8C-EC4899)](https://celerity.help)

**C³ CELERITY** by Click Connect — современная веб-панель для управления серверами [Hysteria 2](https://v2.hysteria.network/) и [Xray VLESS](https://xtls.github.io/) с централизованной авторизацией, автоматической настройкой нод и гибким распределением пользователей по группам.

**Создана для скорости:** Лёгкая архитектура, оптимизированная для быстрой работы на любом масштабе.

  
*Дашборд — мониторинг серверов и статистика в реальном времени*

## ⚡ Быстрый старт

> Нужно обновить уже установленную панель? См. [Безопасное обновление на проде](docs/safe-update.ru.md).

**1. Установите Docker** (если не установлен):

```bash
curl -fsSL https://get.docker.com | sh
```

**2. Разверните панель (Docker Hub — рекомендуется):**

```bash
mkdir hysteria-panel && cd hysteria-panel

# Скачать необходимые файлы
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker-compose.hub.yml
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker.env.example

# Создать конфиг SSL (обязательно для HTTPS)
mkdir -p greenlock.d
curl -o greenlock.d/config.json https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/greenlock.d/config.json

cp docker.env.example .env
nano .env  # Укажите домен, email и секреты
docker compose -f docker-compose.hub.yml up -d
```

**Альтернатива: сборка из исходников** (для разработки или кастомизации)

```bash
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel
cp docker.env.example .env
nano .env  # Укажите домен, email и секреты
docker compose up -d
```

**3. Откройте** `https://ваш-домен/panel`
> Планируете управлять панелью из AI-ассистента? См. [Гайд по настройке MCP](docs/mcp-user-guide.ru.md).

**Локальная разработка (только HTTP, без домена и SSL):**

Хотите попробовать панель на ноутбуке без публичного домена и сертификата? Используйте локальный compose-файл — он ставит `USE_CADDY=true` (обычный HTTP, без Greenlock/ACME) и публикует порт `3000` напрямую, с дев-дефолтами, так что запускается без `.env`:
```bash
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel
docker compose -f docker-compose.local.yml up -d
# Откройте http://localhost:3000/panel
```
> Локальный режим **без TLS** и не для продакшена. Ссылки на подписки предполагают HTTPS, поэтому используйте его только для тестов UI/API.

**Обязательные переменные `.env`:**

```env
PANEL_DOMAIN=panel.example.com
ACME_EMAIL=admin@example.com
ENCRYPTION_KEY=ваш32символьныйключ  # openssl rand -hex 16
SESSION_SECRET=секретсессий         # openssl rand -hex 32
MONGO_PASSWORD=парольмонго         # openssl rand -hex 16
```

---

## 🐳 Dokploy (разработка и релиз)

Используйте `docker-compose.dokploy.yml` при деплое через Dokploy с Traefik.

### Режим разработки (сборка из текущей ветки)

1. В Dokploy создайте проект из этого репозитория/ветки.
2. Укажите путь к compose-файлу: `docker-compose.dokploy.yml`.
3. Добавьте переменные окружения из `docker.env.example`, минимум:
   - `MONGO_PASSWORD`
   - `PANEL_DOMAIN`
   - `ACME_EMAIL`
   - `ENCRYPTION_KEY`
   - `SESSION_SECRET`
   - `DOKPLOY_PANEL_HOST` (домен для правила Traefik `Host(...)`)
   - `DOKPLOY_TRAEFIK_SERVICE_PORT` (порт Traefik/backend, по умолчанию `3000`)
4. Запустите деплой: Dokploy выполнит `build: .` и поднимет стек.

Этот режим удобен для проверки изменений из ветки до публикации релизного образа.

### Режим релиза (образ из Docker Hub)

Если нужен стабильный деплой по тегам Docker Hub (без сборки), замените источник `backend` в compose на образ:

```yaml
backend:
  image: clickdevtech/hysteria-panel:latest
  # или зафиксируйте тег релиза, например clickdevtech/hysteria-panel:v1.2.3
  restart: always
  depends_on:
    mongo:
      condition: service_healthy
    redis:
      condition: service_healthy
  expose:
    - "${DOKPLOY_TRAEFIK_SERVICE_PORT:-3000}"
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.celerity.rule=Host(`${DOKPLOY_PANEL_HOST}`)"
    - "traefik.http.routers.celerity.entrypoints=websecure"
    - "traefik.http.routers.celerity.tls=true"
    - "traefik.http.services.celerity.loadbalancer.server.port=${DOKPLOY_TRAEFIK_SERVICE_PORT:-3000}"
  env_file:
    - .env
```

`latest` подходит для быстрых обновлений, фиксированный тег — для предсказуемых прод-выкаток.

---

## ✨ Возможности

- 🖥 **Веб-панель** — полноценный UI для управления нодами и пользователями
- 🔐 **Двойной протокол** — Hysteria 2 и Xray VLESS на одной панели
- 🛡️ **2FA для панели (TOTP)** — единый сценарий подтверждения TOTP для входа администратора и чувствительных действий безопасности
- 🚀 **Автонастройка нод** — установка Hysteria/Xray, сертификатов и port hopping в один клик
- 👥 **Группы серверов** — гибкая привязка пользователей к нодам
- ⚖️ **Балансировка нагрузки** — распределение по загруженности
- 🚫 **Фильтрация трафика (ACL)** — блокировка рекламы, доменов, IP; маршрутизация через прокси
- 🧩 **Расширенный конфиг Hysteria** — опциональные параметры ACME challenge, режимы masquerade, resolver, speed test, sniffing и настройка QUIC
- 📊 **Статистика** — онлайн, трафик, состояние серверов
- 📱 **Подписки** — автоформаты для Clash, Sing-box, Shadowrocket, Hiddify
- 🔄 **Бэкап/Восстановление** — автоматические бэкапы с поддержкой S3
- 💻 **SSH-терминал** — прямой доступ к нодам из браузера
- 🔑 **API-ключи** — безопасный внешний доступ со скоупами, IP-фильтром и rate limiting
- 🪝 **Вебхуки** — уведомления о событиях с подписью HMAC-SHA256
- 🗺 **Карта сети** — визуальная каскадная топология с Forward/Reverse Chain *(бета)*
- 🤖 **MCP-интеграция** — нативная поддержка AI-ассистентов (Claude, Cursor и др.) для управления панелью
- 📡 **Внешние проберы** — отдельный агент с настоящим ядром sing-box проверяет подключение к нодам из реальных сетей ([гайд](docs/probes.ru.md))

---

## ⚠️ Бета-функции

### Карта сети и каскадная топология

> **Статус:** бета — функциональность работает, но рекомендуется проверка после деплоя.

Каскадная топология позволяет строить цепочки серверов, где клиент подключается к одной ноде, а трафик выходит через другую. Это полезно в сценариях, где точка входа должна находиться в определённой сети или юрисдикции — например, когда требуется подключение через IP-адреса локальных облачных провайдеров.

#### Зачем это нужно

В корпоративных и операторских сетях часто применяется фильтрация по IP-диапазонам. Трафик к известным хостинг-провайдерам может проходить без ограничений, тогда как соединения с зарубежными IP блокируются или ограничиваются. Каскадная топология решает эту проблему: клиент подключается к серверу в «доверенном» диапазоне, а трафик прозрачно проксируется на внешний сервер.

#### Используемые механизмы Xray

Панель генерирует конфигурации Xray-core с использованием следующих механизмов:

| Механизм | Назначение |
|----------|------------|
| **Reverse Proxy** | Xray bridge/portal — позволяет серверу за NAT инициировать соединение к публичному узлу и принимать через него трафик |
| **Outbound Chaining** | Последовательное проксирование через несколько outbound с помощью `proxySettings.tag` |
| **REALITY** | Маскировка TLS-handshake под соединение с легитимным сайтом; не требует домена и сертификата |
| **Transport Layer Proxy** | Режим `transportLayer: true` для корректного применения REALITY в цепочке хопов |

#### Режимы связей

**Reverse Proxy** — классическая схема Xray reverse. Bridge-сервер (обычно за рубежом) инициирует постоянное соединение к Portal-серверу. Клиент подключается к Portal, трафик выходит через Bridge.

```
Клиент ──▶ Portal (вход) ◀── туннель ── Bridge (выход) ──▶ Интернет
                          (bridge инициирует соединение)
```

- Portal может находиться за NAT или firewall — входящие соединения не требуются
- Подходит для сценариев, где точка входа должна быть в определённой сети

**Forward Chain** — прямая цепочка outbound. Portal устанавливает соединение через relay-ноды к exit-Bridge.

```
Клиент ──▶ Portal ──▶ Relay (опц.) ──▶ Bridge (выход) ──▶ Интернет
           (chained outbounds)
```

- Все ноды в цепочке должны иметь публичный IP
- Поддерживается REALITY на каждом хопе для шифрования межсерверного трафика

#### REALITY между нодами

Tunnel-REALITY настраивается **независимо** от клиентского REALITY на Portal-ноде. Это позволяет:

- Шифровать межсерверный трафик без привлечения внимания
- Использовать разные SNI/destination для клиента и для туннеля
- Автоматически генерировать x25519 ключи и shortId при создании связи

#### Рекомендации после деплоя

1. Проверьте статусы хопов на карте сети
2. Убедитесь, что трафик выходит через ожидаемый Bridge (проверьте exit IP)
3. Для Forward Chain — подтвердите доступность каждого relay по его `tunnelPort`

#### Ограничения

| Ограничение | Причина |
|-------------|---------|
| REALITY + WebSocket | WebSocket не поддерживает uTLS fingerprint, необходимый для REALITY |
| Forward Chain без публичного IP | Каждый хоп должен принимать входящие соединения |
| Смешанные режимы в одной цепочке | Reverse и Forward используют разные механизмы Xray и не комбинируются |
| Один порт на relay для двух хопов | Relay, являющийся одновременно bridge и portal, требует разные порты для входящего и исходящего туннеля |


---

## 🏗 Архитектура

```
                              ┌─────────────────┐
                              │     КЛИЕНТЫ     │
                              │ Clash, Sing-box │
                              │   Shadowrocket  │
                              └────────┬────────┘
                                       │
                    hysteria2:// или vless://
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
     │  Hysteria Node  │      │   Xray Node     │      │  Hysteria Node  │
     │   :443 + hop    │      │  VLESS Reality  │      │   :443 + hop    │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
              │                        │                        │
              │    POST /api/auth      │   CC Agent API         │
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

**Hysteria:**

1. Клиент подключается к ноде с `userId:password`
2. Нода отправляет `POST /api/auth` на панель
3. Панель проверяет пользователя и возвращает `{ "ok": true/false }`

**Xray:**

1. Клиент подключается с UUID (xrayUuid)
2. CC Agent на ноде управляет списком пользователей через API
3. Панель синхронизирует пользователей с нодой без перезагрузки Xray

### Группы серверов

Вместо жёстких "планов" используются гибкие группы:

- Создайте группу (например, "Европа", "Premium")
- Привяжите к ней ноды
- Привяжите пользователей
- Пользователь получает в подписке только ноды из своих групп

---

## 🔧 Типы нод

### Hysteria 2

Быстрый UDP-протокол на базе QUIC с поддержкой port hopping и обфускации.

**Преимущества:**

- Высокая скорость на нестабильных сетях
- Port hopping для обхода блокировок
- Обфускация Salamander и Gecko (Gecko требует Hysteria 2.9.x)

**Настройки:**

- Порт, диапазон портов для hopping
- ACME или self-signed сертификаты
- Obfs (`salamander` или `gecko`) с паролем

**Расширенные настройки Hysteria в панели:**

- Интервал Port Hopping (`hopInterval`)
- Расширенный ACME (тип challenge, альтернативные порты, DNS challenge provider/config)
- Режимы masquerade: `proxy` и `string`
- Лимиты bandwidth (`up` / `down`) и `ignoreClientBandwidth`
- Встроенные `speedTest`, `disableUDP`, `udpIdleTimeout`
- Protocol sniffing (`sniff`) и параметры QUIC (`quic`)
- Кастомный DNS resolver (`resolver`)
- Режим источника ACL (`inline` или `file`) + пути к GeoIP/GeoSite
- Расширенные секции опциональны и не попадают в сгенерированный конфиг, пока не включены в UI

### Xray VLESS

Современный протокол с поддержкой Reality и различных транспортов.

**Преимущества:**

- Reality — маскировка под легитимный HTTPS трафик
- Множество транспортов (TCP, WebSocket, gRPC, XHTTP)
- Не требует домена для Reality

**Транспорты:**


| Транспорт | Описание                                 | Поддержка клиентами |
| --------- | ---------------------------------------- | ------------------- |
| TCP       | Прямое соединение, максимальная скорость | Все клиенты         |
| WebSocket | Работает через CDN и прокси              | Все клиенты         |
| gRPC      | Мультиплексирование, хорош для CDN       | Все клиенты         |
| XHTTP     | Новый splithttp транспорт                | Ограниченная*       |


*XHTTP поддерживается не всеми клиентами (Clash/Sing-box пока не поддерживают)

**Безопасность:**


| Режим   | Описание                                       |
| ------- | ---------------------------------------------- |
| Reality | Маскировка под популярный сайт, не нужен домен |
| TLS     | Классический TLS с сертификатом                |
| None    | Без шифрования (не рекомендуется)              |


---

## 🚀 Настройка Xray ноды

### Автоматическая настройка (рекомендуется)

1. Добавьте ноду в панели:
  - Тип: **Xray**
  - IP, SSH доступ
  - Безопасность: Reality (рекомендуется)
  - Транспорт: TCP (рекомендуется для Reality)
2. Нажмите "⚙️ Автонастройка"
3. Панель автоматически:
  - Установит Xray-core
  - Сгенерирует Reality ключи (x25519)
  - Загрузит конфиг
  - Установит CC Agent для управления пользователями
  - Откроет порты в firewall
  - Запустит сервисы

### Reality настройки


| Поле        | Описание                        | Пример                     |
| ----------- | ------------------------------- | -------------------------- |
| Dest        | Куда маскироваться (домен:порт) | `www.google.com:443`       |
| SNI         | Server Name Indication          | `www.google.com`           |
| Private Key | Приватный ключ x25519           | Генерируется автоматически |
| Public Key  | Публичный ключ (для клиентов)   | Генерируется автоматически |
| Short IDs   | Идентификаторы сессий           | Генерируются автоматически |


### CC Agent

CC Agent — это лёгкий HTTP-сервис на ноде для управления пользователями Xray без перезагрузки.

**Возможности:**

- Добавление/удаление пользователей на лету
- Сбор статистики трафика
- Health check

Agent устанавливается автоматически при автонастройке Xray ноды.

---

## 🔧 Настройка Hysteria ноды

### Понимание конфигурации

#### Порты

- **Основной порт (443)** — порт, на котором слушает Hysteria
- **Диапазон портов (20000-50000)** — UDP порты для port hopping
- **Порт статистики (9999)** — внутренний порт для сбора статистики

#### Домен и SNI


| Поле       | Назначение                          | Пример                        |
| ---------- | ----------------------------------- | ----------------------------- |
| **Domain** | Для ACME/Let's Encrypt сертификатов | `de1.example.com` → `1.2.3.4` |
| **SNI**    | Для маскировки (domain fronting)    | `www.google.com`              |


**Сценарии:**

1. **Простая настройка**: Укажите домен, SNI оставьте пустым
2. **Domain fronting**: Укажите домен для сертификатов, SNI — популярный домен
3. **Без домена**: Оставьте пустым — будет self-signed сертификат

### Автоматическая настройка (рекомендуется)

1. Добавьте ноду в панели (IP, SSH доступ)
2. Нажмите "⚙️ Автонастройка"
3. Панель автоматически:
  - Установит Hysteria 2
  - Настроит ACME или self-signed сертификаты
  - Настроит port hopping
  - Откроет порты в firewall
  - Запустит сервис

### Обфускация (Salamander / Gecko)

Hysteria поддерживает обфускацию для маскировки трафика:

1. В настройках ноды включите **Obfs**
2. Выберите **Salamander** или **Gecko** (`gecko` требует Hysteria 2.9.x)
3. Укажите **пароль обфускации**
4. Сохраните и обновите конфиг

Клиенты автоматически получат выбранный тип `obfs` и пароль в подписке.

### Панель и нода на одном VPS

Можно запустить панель и ноду на одном VPS (панель TCP, нода UDP на 443).

**Вариант 1: Использовать домен панели (рекомендуется)**

- Укажите для ноды тот же домен что у панели
- Сертификаты панели скопируются автоматически

**Вариант 2: Без домена (self-signed)**

- Оставьте поле домена пустым
- Будет сгенерирован самоподписанный сертификат

---

## 📖 API

### Аутентификация через API-ключ

Все эндпоинты `/api/`* (кроме `/api/auth` и `/api/files`) требуют аутентификации.

**Создать ключ:** Настройки → Безопасность → API-ключи → Создать ключ

**Использование:**

```http
# Вариант 1 — заголовок
X-API-Key: ck_your_key_here

# Вариант 2 — Bearer токен
Authorization: Bearer ck_your_key_here
```

#### Скоупы (права доступа)


| Скоуп         | Доступ                                              |
| ------------- | --------------------------------------------------- |
| `users:read`  | Чтение пользователей                                |
| `users:write` | Создание / изменение / удаление пользователей       |
| `nodes:read`  | Чтение нод                                          |
| `nodes:write` | Создание / изменение / удаление / синхронизация нод |
| `stats:read`  | Статистика и группы                                 |
| `sync:write`  | Запуск синхронизации, кик пользователей             |


#### Rate Limiting

Каждый ключ имеет настраиваемый лимит (по умолчанию: 60 req/мин).  
При превышении возвращается `429` с заголовками `X-RateLimit-Limit` / `X-RateLimit-Remaining`.

---

### Авторизация (для нод)

#### POST `/api/auth`

Проверка пользователя при подключении к Hysteria ноде.

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


| User-Agent                      | Формат                   |
| ------------------------------- | ------------------------ |
| `shadowrocket`                  | Base64 URI list          |
| `clash`, `stash`, `surge`       | Clash YAML               |
| `hiddify`, `sing-box`, `karing` | Sing-box JSON            |
| Браузер                         | HTML страница с QR-кодом |
| Другое                          | Plain URI list           |


**Query параметры:** `?format=clash`, `?format=singbox`, `?format=uri`

#### GET `/api/files/info/:token`

Информация о подписке (статус, трафик, срок действия).

### Пользователи

Требуемый скоуп: `users:read` (GET) / `users:write` (POST, PUT, DELETE)


| Метод  | Эндпоинт                             | Описание                                              |
| ------ | ------------------------------------ | ----------------------------------------------------- |
| GET    | `/api/users`                         | Список пользователей (пагинация, фильтры, сортировка) |
| GET    | `/api/users/:userId`                 | Получить пользователя                                 |
| POST   | `/api/users`                         | Создать пользователя                                  |
| PUT    | `/api/users/:userId`                 | Обновить пользователя                                 |
| DELETE | `/api/users/:userId`                 | Удалить пользователя                                  |
| POST   | `/api/users/:userId/enable`          | Включить                                              |
| POST   | `/api/users/:userId/disable`         | Отключить                                             |
| POST   | `/api/users/:userId/groups`          | Добавить в группы                                     |
| DELETE | `/api/users/:userId/groups/:groupId` | Удалить из группы                                     |
| POST   | `/api/users/sync-from-main`          | Синхронизация с внешней БД                            |


### Ноды

Требуемый скоуп: `nodes:read` (GET) / `nodes:write` (POST, PUT, DELETE)


| Метод  | Эндпоинт                            | Описание                    |
| ------ | ----------------------------------- | --------------------------- |
| GET    | `/api/nodes`                        | Список нод                  |
| GET    | `/api/nodes/:id`                    | Получить ноду               |
| POST   | `/api/nodes`                        | Создать ноду                |
| PUT    | `/api/nodes/:id`                    | Обновить ноду               |
| DELETE | `/api/nodes/:id`                    | Удалить ноду                |
| GET    | `/api/nodes/:id/config`             | Получить конфиг (YAML/JSON) |
| GET    | `/api/nodes/:id/status`             | Статус ноды                 |
| POST   | `/api/nodes/:id/reset-status`       | Сбросить статус на online   |
| GET    | `/api/nodes/:id/users`              | Пользователи на ноде        |
| POST   | `/api/nodes/:id/sync`               | Синхронизировать ноду       |
| POST   | `/api/nodes/:id/update-config`      | Отправить конфиг через SSH  |
| POST   | `/api/nodes/:id/setup`              | Автонастройка через SSH     |
| POST   | `/api/nodes/:id/setup-port-hopping` | Настроить port hopping      |
| POST   | `/api/nodes/:id/groups`             | Добавить ноду в группы      |
| DELETE | `/api/nodes/:id/groups/:groupId`    | Удалить из группы           |
| GET    | `/api/nodes/:id/agent-info`         | Инфо от CC Agent (Xray)     |


### Статистика и синхронизация


| Метод | Эндпоинт            | Скоуп        | Описание                  |
| ----- | ------------------- | ------------ | ------------------------- |
| GET   | `/api/stats`        | `stats:read` | Статистика панели         |
| GET   | `/api/groups`       | `stats:read` | Список групп серверов     |
| POST  | `/api/sync`         | `sync:write` | Синхронизировать все ноды |
| POST  | `/api/kick/:userId` | `sync:write` | Кикнуть пользователя      |


---

## 🪝 Вебхуки

Отправляйте уведомления о событиях в реальном времени на любой HTTP-эндпоинт.

**Настройка:** Настройки → Безопасность → Вебхуки

### Формат запроса

```http
POST https://your-endpoint.com/webhook
Content-Type: application/json
X-Webhook-Event: user.created
X-Webhook-Timestamp: 1700000000
X-Webhook-Signature: sha256=<hmac>
User-Agent: C3-Celerity-Webhook/1.0

{
  "event": "user.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": { ... }
}
```

### Проверка подписи

```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_SECRET)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
// сравните с заголовком X-Webhook-Signature
```

### События


| Событие                 | Когда                       |
| ----------------------- | --------------------------- |
| `user.created`          | Создан пользователь         |
| `user.updated`          | Обновлён пользователь       |
| `user.deleted`          | Удалён пользователь         |
| `user.enabled`          | Пользователь включён        |
| `user.disabled`         | Пользователь отключён       |
| `user.traffic_exceeded` | Достигнут лимит трафика     |
| `user.expired`          | Истёк срок подписки         |
| `node.online`           | Нода перешла в онлайн       |
| `node.offline`          | Нода ушла в оффлайн         |
| `node.error`            | Ошибка ноды                 |
| `host.disk_low`         | На сервере панели мало места (порог warning) |
| `host.disk_critical`    | На сервере панели критично мало места |
| `host.disk_recovered`   | Место на сервере панели восстановилось выше порога |
| `sync.completed`        | Завершён цикл синхронизации |
| `probe.node_unreachable` | Пробер не достучался до инбаунда ноды из своей точки |
| `probe.target_unreachable` | Ресурс из чек-листа стал недоступен через ноду |
| `probe.offline`         | Пробер перестал присылать отчёты |

Пороги оповещений о диске настраиваются в **Настройки → Безопасность → Вебхуки**
(`Предупреждение: свободно меньше %` и `Критично: свободно меньше ГБ`). Алерты
приходят один раз при пересечении порога (с гистерезисом, чтобы не было спама),
а событие восстановления отправляется, когда место вернулось выше порога
предупреждения.

---

## 📡 Внешние диагностические проберы

Пробер — отдельный Go-бинарник, который ставится на ваш собственный сервер. Он
получает скрытую подписку, поднимает настоящее ядро sing-box и подключается к
нодам так же, как это делает клиент. Это показывает, доступна ли нода из
конкретной сети.

Включается в **Настройки → Проберы**, дальше добавляете пробер и запускаете
сгенерированную команду установки на нужном хосте. Результаты хранятся по точкам
наблюдения и никогда не подменяют `node.status`: сбой может быть и на стороне
самого пробера.

Коды отказов сразу указывают на причину: `net_unreachable` (порт режется на
пути), `handshake_failed` (мёртвый destination REALITY или DPI), `auth_rejected`
(пользователь не доехал до запущенного ядра), `tunnel_no_data` (сломанный
outbound или ACL), `degraded` и `core_down` — отказ собственного ядра пробера.

📖 **Полный гайд:** [Русский](docs/probes.ru.md) · [English](docs/probes.md)

---

## 🧹 Место на диске и обслуживание

MongoDB и панель перестают работать, когда на сервере заканчивается место,
поэтому следите за свободным местом (на дашборде есть график **Диск**, а
вебхуки могут прислать оповещение — см. выше). Чаще всего диск забивает Docker:
со временем накапливаются неиспользуемые образы, контейнеры и логи.

**Ограничьте размер логов контейнеров** (чтобы логи не забили диск). Добавьте
к каждому сервису в `docker-compose.yml`:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

**Периодически освобождайте место**, занятое неиспользуемыми данными Docker:

```bash
# Безопасно: удалить только висячие образы и кэш сборки
docker image prune -f
docker builder prune -f

# Агрессивно: удалить ВСЕ неиспользуемые образы (при следующем деплое скачаются заново)
docker system prune -a -f
```

Обычно достаточно еженедельного `cron`-задания с `docker image prune -f`.

---

## 📊 Модели данных

### Пользователь


| Поле                | Тип        | Описание                                         |
| ------------------- | ---------- | ------------------------------------------------ |
| `userId`            | String     | Уникальный ID                                    |
| `username`          | String     | Отображаемое имя                                 |
| `subscriptionToken` | String     | Токен для URL подписки                           |
| `xrayUuid`          | String     | UUID для Xray VLESS (авто-генерация)             |
| `enabled`           | Boolean    | Активен ли пользователь                          |
| `groups`            | [ObjectId] | Группы серверов                                  |
| `nodes`             | [ObjectId] | Прямая привязка к нодам                          |
| `traffic`           | Object     | `{ tx, rx, lastUpdate }` — использованный трафик |
| `trafficLimit`      | Number     | Лимит трафика в байтах (0 = безлимит)            |
| `maxDevices`        | Number     | Лимит устройств (0 = из группы, -1 = безлимит)   |
| `expireAt`          | Date       | Дата истечения                                   |


### Нода


| Поле                 | Тип        | Описание                                           |
| -------------------- | ---------- | -------------------------------------------------- |
| `type`               | String     | `hysteria` или `xray`                              |
| `name`               | String     | Название                                           |
| `flag`               | String     | Флаг страны (эмодзи)                               |
| `ip`                 | String     | IP адрес                                           |
| `domain`             | String     | Домен для SNI/ACME                                 |
| `sni`                | String     | Кастомный SNI для маскировки                       |
| `port`               | Number     | Основной порт (443)                                |
| `portRange`          | String     | Диапазон портов для hopping                        |
| `portConfigs`        | Array      | Мультипорт: `[{ name, port, portRange, enabled }]` |
| `obfs`               | Object     | Обфускация: `{ type: 'salamander' \| 'gecko', password }` |
| `statsPort`          | Number     | Порт статистики Hysteria (9999)                    |
| `statsSecret`        | String     | Секрет для API статистики                          |
| `groups`             | [ObjectId] | Группы серверов                                    |
| `outbounds`          | Array      | Прокси для ACL: `[{ name, type, addr }]`           |
| `aclRules`           | [String]   | Правила ACL                                        |
| `maxOnlineUsers`     | Number     | Макс. онлайн для балансировки                      |
| `rankingCoefficient` | Number     | Коэффициент сортировки (1.0)                       |
| `status`             | String     | online/offline/error/syncing                       |
| `traffic`            | Object     | `{ tx, rx, lastUpdate }` — трафик ноды             |
| `xray`               | Object     | Настройки Xray (см. ниже)                          |


#### Xray настройки (node.xray)


| Поле                | Тип      | Описание                          |
| ------------------- | -------- | --------------------------------- |
| `transport`         | String   | tcp, ws, grpc, xhttp              |
| `security`          | String   | reality, tls, none                |
| `flow`              | String   | xtls-rprx-vision (для tcp)        |
| `fingerprint`       | String   | chrome, firefox, safari, etc.     |
| `alpn`              | [String] | ALPN протоколы (h3, h2, http/1.1) |
| `realityDest`       | String   | Куда маскироваться                |
| `realitySni`        | [String] | Server names                      |
| `realityPrivateKey` | String   | Приватный ключ x25519             |
| `realityPublicKey`  | String   | Публичный ключ                    |
| `realityShortIds`   | [String] | Short IDs                         |
| `realitySpiderX`    | String   | Стартовый URL REALITY-паука при пробе (по умолчанию пусто; рекомендуется уникальное значение на ноду) |
| `wsPath`            | String   | WebSocket путь                    |
| `wsHost`            | String   | WebSocket host header             |
| `grpcServiceName`   | String   | gRPC service name                 |
| `xhttpPath`         | String   | XHTTP путь                        |
| `xhttpHost`         | String   | XHTTP host header                 |
| `xhttpMode`         | String   | auto, packet-up, stream-up        |
| `xhttpXPaddingBytes` | String  | Длина набивки XHTTP, `"мин-макс"` или число (пусто — 100-1000 по умолчанию). Передаётся клиентам в подписке; инбаунд принимает объединение с диапазоном по умолчанию, поэтому клиенты, которые его не читают, продолжают работать |
| `xhttpScMaxEachPostBytes` | String | Порог разбиения загрузки в packet-up, байт (пусто — 1000000). Инбаунд принимает не меньше значения по умолчанию, поэтому меньшее значение действует только на клиентов, которые его прочитали |
| `xhttpNoGrpcHeader` | Boolean  | Не отправлять gRPC content-type в stream-up/stream-one (только клиент) |
| `xhttpXmuxMaxConcurrency` | String | XMUX: потоков на соединение, напр. `"16-32"` (только клиент) |
| `xhttpXmuxHMaxRequestTimes` | String | XMUX: запросов на соединение, напр. `"600-900"` (только клиент) |
| `xhttpXmuxHMaxReusableSecs` | String | XMUX: время жизни соединения в секундах, напр. `"1800-3000"` (только клиент) |
| `apiPort`           | Number   | Порт gRPC API Xray (61000)        |
| `inboundTag`        | String   | Тег inbound (vless-in)            |
| `agentPort`         | Number   | Порт CC Agent (62080)             |
| `agentToken`        | String   | Токен агента                      |
| `agentTls`          | Boolean  | TLS для CC Agent                  |


### Группа серверов


| Поле                | Тип    | Описание                    |
| ------------------- | ------ | --------------------------- |
| `name`              | String | Название группы             |
| `description`       | String | Описание                    |
| `color`             | String | Цвет для UI (#hex)          |
| `maxDevices`        | Number | Лимит устройств для группы  |
| `subscriptionTitle` | String | Название в профиле подписки |


---

## 🚫 Фильтрация трафика (ACL)

Управление маршрутизацией на каждой Hysteria ноде. Доступ: **Панель → Нода → Фильтрация трафика**.

### Встроенные действия


| Действие      | Описание      |
| ------------- | ------------- |
| `reject(...)` | Заблокировать |
| `direct(...)` | Пропустить    |


### Примеры правил

```
reject(suffix:doubleclick.net)     # Блокировка рекламы
reject(suffix:googlesyndication.com)
reject(geoip:cn)                   # Блокировка китайских IP
reject(geoip:private)              # Блокировка приватных IP
direct(all)                        # Разрешить всё остальное
```

### Маршрутизация через свой прокси

1. Добавьте прокси (например, `my-proxy`, SOCKS5, `1.2.3.4:1080`)
2. Используйте в правилах: `my-proxy(geoip:ru)`

---

## ⚖️ Балансировка нагрузки

Настраивается в **Настройки**:

- **Балансировка включена** — сортировка нод по загруженности
- **Скрывать перегруженные** — не выдавать перегруженные ноды

Алгоритм:

1. Получаем ноды пользователя из групп
2. Сортируем по % загрузки (online/max)
3. Фильтруем перегруженные если включено
4. При равной загрузке — по `rankingCoefficient`

---

## 🔒 Лимит устройств

**Приоритет:**

1. Персональный лимит пользователя (`maxDevices > 0`)
2. Минимальный лимит из групп пользователя
3. `-1` = безлимит

**Device Grace Period** — задержка (в секундах) перед учётом отключённого устройства, чтобы избежать ложных срабатываний при переподключении.

---

## 📱 Настройка страницы подписки

Кастомизируйте HTML-страницу подписки в **Настройки → Подписка**:


| Поле           | Описание                                       |
| -------------- | ---------------------------------------------- |
| `Logo URL`     | URL логотипа для шапки страницы                |
| `Page Title`   | Заголовок страницы                             |
| `Support URL`  | Ссылка на поддержку (кнопка внизу страницы)    |
| `Web Page URL` | URL профиля (заголовок `profile-web-page-url`) |


Страница подписки автоматически показывает:

- QR-код для импорта в приложение
- Статистику трафика и срок действия
- Список локаций с кнопками копирования

---

## 💾 Бэкапы

### Автобэкапы

Настраиваются в **Настройки → Бэкапы**:

- Интервал (в часах)
- Количество локальных копий

### Ручной бэкап

Кнопка на дашборде — файл автоматически скачивается.

### Восстановление

Загрузите `.tar.gz` архив через интерфейс.

### S3-совместимое хранилище

Бэкапы можно автоматически загружать в S3-совместимое хранилище (AWS S3, MinIO, Backblaze B2, Cloudflare R2 и др.).

**Настройка:** Настройки → Бэкапы → S3


| Поле                | Описание                                                    |
| ------------------- | ----------------------------------------------------------- |
| `Endpoint`          | URL хранилища (для MinIO и др.). Для AWS S3 оставьте пустым |
| `Region`            | Регион (например, `us-east-1`)                              |
| `Bucket`            | Имя бакета                                                  |
| `Prefix`            | Префикс/папка для бэкапов                                   |
| `Access Key ID`     | Ключ доступа                                                |
| `Secret Access Key` | Секретный ключ                                              |
| `Keep Last`         | Сколько бэкапов хранить в S3                                |


**Примеры настройки:**

```env
# AWS S3
Endpoint: (пусто)
Region: eu-central-1
Bucket: my-backups

# MinIO
Endpoint: https://minio.example.com
Region: us-east-1
Bucket: backups

# Cloudflare R2
Endpoint: https://<account-id>.r2.cloudflarestorage.com
Region: auto
Bucket: my-backups
```

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
    image: clickdevtech/hysteria-panel:latest
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


| Переменная           | Обязательно | Описание                                      |
| -------------------- | ----------- | --------------------------------------------- |
| `PANEL_DOMAIN`       | ✅           | Домен панели                                  |
| `DOKPLOY_PANEL_HOST` | ❌           | Хост Traefik в Dokploy (правило `Host(...)`) |
| `DOKPLOY_TRAEFIK_SERVICE_PORT` | ❌   | Порт Traefik/backend сервиса в Dokploy (default: `3000`) |
| `ACME_EMAIL`         | ✅           | Email для Let's Encrypt                       |
| `ENCRYPTION_KEY`     | ✅           | Ключ шифрования SSH (32 символа)              |
| `SESSION_SECRET`     | ✅           | Секрет сессий                                 |
| `MONGO_PASSWORD`     | ✅           | Пароль MongoDB (для Docker)                   |
| `MONGO_USER`         | ❌           | Пользователь MongoDB (default: hysteria)      |
| `MONGO_URI`          | ❌           | URI подключения к MongoDB (для не-Docker)     |
| `REDIS_URL`          | ❌           | URL Redis для кэша (default: память)          |
| `USE_CADDY`          | ❌           | Отдавать HTTP на `PORT` за reverse-proxy вместо Greenlock HTTPS. Используется в `docker-compose.yml`/`docker-compose.dokploy.yml`. Не задано = standalone HTTPS через Greenlock (нужен реальный домен и публичные порты 80/443) |
| `PORT`               | ❌           | HTTP-порт backend при `USE_CADDY=true` (default: `3000`) |
| `PANEL_IP_WHITELIST` | ❌           | IP whitelist для панели                       |
| `SYNC_INTERVAL`      | ❌           | Интервал синхронизации в минутах (default: 2) |
| `API_DOCS_ENABLED`   | ❌           | Интерактивная документация на `/api/docs`     |
| `LOG_LEVEL`          | ❌           | Уровень логирования (default: info)           |


---

## 🤝 Участие в разработке

Pull requests приветствуются!

---

## 📄 Лицензия

MIT
