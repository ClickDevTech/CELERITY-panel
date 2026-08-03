# 🤖 Руководство по использованию MCP-интеграции

> Подключите AI-ассистентов напрямую к панели C³ CELERITY для автоматизированного управления.

---

## 📖 Что такое MCP?

**Model Context Protocol (MCP)** — это протокол, который позволяет AI-ассистентам (Claude, Cursor и др.) напрямую взаимодействовать с панелью C³ CELERITY.

### ✨ Возможности

Через MCP AI может:

| Возможность | Описание |
|-------------|----------|
| 👥 **Управление пользователями** | Создание, редактирование, блокировка VPN-пользователей |
| 🖥 **Настройка серверов** | Конфигурация серверов и нод |
| 💻 **SSH-команды** | Выполнение команд на серверах удалённо |
| 📊 **Мониторинг** | Получение статистики и логов |
| 🔎 **Access Logs** | Read-only SQL-запросы к ClickHouse `access_events` |
| 🔧 **Диагностика** | Диагностика и устранение проблем |

---

## 📋 Требования

| Требование | Описание |
|------------|----------|
| 🔑 **API-ключ** | С правом `mcp:enabled` |
| 🖥 **AI-клиент** | Claude Desktop, Cursor IDE или другой HTTP-клиент с SSE |

---

## 🔐 Создание API-ключа

### Пошаговая инструкция

1. 🖱 Откройте панель → **Settings** → **API Keys**
2. ➕ Нажмите **Создать MCP API-ключ**
3. ✏️ Укажите название ключа (например, `"Claude Assistant"`)
4. 🎛 Выберите права:
   
   | Тип | Scopes | Применение |
   |-----|--------|------------|
   | 🟢 **Базовые** | `mcp:enabled` + права на чтение | Только чтение (по умолчанию) |
   | 🟡 **Расширенные** | `users:write`, `nodes:write`, `sync:write` | Операции записи |
   
5. 📋 Скопируйте ключ — **показывается только один раз!**

> ⚠️ **Важно**: Храните API-ключ в безопасном месте. Вы не сможете увидеть его снова.

---

## 🔌 Подключение AI-клиентов

### 🖥 Claude Desktop

Добавьте в файл конфигурации Claude Desktop:

| Платформа | Путь к конфигу |
|-----------|----------------|
| 🍎 **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| 🪟 **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "celerity": {
      "url": "https://your-panel.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### 📝 Cursor IDE

Создайте файл `.cursor/mcp.json` в корне проекта:

```json
{
  "mcpServers": {
    "celerity": {
      "url": "https://your-panel.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### 🔧 Кастомный клиент

Любой HTTP-клиент с поддержкой SSE может подключиться:

| Параметр | Значение |
|----------|----------|
| 📍 **Endpoint** | `https://your-panel.com/api/mcp` |
| 🔐 **Auth** | `Authorization: Bearer YOUR_API_KEY` |
| 📦 **Content-Type** | `application/json` |
| 📡 **Accept** | `text/event-stream` (для стриминга) |

<details>
<summary>📖 Пример запроса</summary>

```bash
curl -X POST https://your-panel.com/api/mcp \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
```

</details>

---

## 🛠 Доступные инструменты

### 🔍 query — Чтение данных

> Универсальный инструмент для получения данных из панели.

| Ресурс | Описание | Требуемый scope |
|--------|----------|-----------------|
| `users` | 👥 Список пользователей | `users:read` |
| `nodes` | 🖥 Список серверов | `nodes:read` |
| `groups` | 📁 Группы серверов | `stats:read` |
| `stats` | 📊 Статистика трафика | `stats:read` |
| `logs` | 📜 Системные логи (winston-буфер панели, не ClickHouse) | `stats:read` |

**Параметры:**

| Параметр | Обязательно | Описание |
|----------|-------------|----------|
| `resource` | ✅ Да | Тип ресурса |
| `id` | ❌ Нет | Конкретный ID элемента |
| `filter` | ❌ Нет | Фильтры (зависят от ресурса) |
| `limit`, `page` | ❌ Нет | Пагинация |
| `sortBy`, `sortOrder` | ❌ Нет | Сортировка |

<details>
<summary>📖 Пример: Получить всех активных пользователей</summary>

```json
{
  "name": "query",
  "arguments": {
    "resource": "users",
    "filter": { "enabled": true },
    "limit": 50
  }
}
```

</details>

---

### 🔎 query_access_logs — Access-логи ClickHouse

> Требуется scope: `stats:read`. Нужны включённые Access Logs и настроенный ClickHouse в настройках панели.

Выполняет **read-only** SQL-запрос к таблице ClickHouse `access_events` (события подключений Xray). Это **не** то же самое, что `query` / `resource=logs` (системные логи панели).

Разрешены: `SELECT`, `WITH`, `EXPLAIN`, `DESCRIBE`, `SHOW`. Мутации отклоняются; результат ограничен (по умолчанию 1000 строк, таймаут 30с).

**Параметры:**

| Параметр | Обязательно | Описание |
|----------|-------------|----------|
| `sql` | ✅ Да | Один read-only SQL-запрос ClickHouse |

<details>
<summary>📖 Пример: Недавние accepted-подключения пользователя</summary>

```json
{
  "name": "query_access_logs",
  "arguments": {
    "sql": "SELECT event_time, node_id, source_ip, dest_host, dest_ip, dest_port, action FROM access_events WHERE email = 'user123' AND event_time >= now() - INTERVAL 1 DAY ORDER BY event_time DESC LIMIT 100"
  }
}
```

</details>

---

### 👤 manage_user — Управление пользователями

> Требуется scope: `users:write`

**Доступные действия:** `create` | `update` | `delete` | `enable` | `disable` | `reset_traffic`

<details>
<summary>📖 Пример: Создать пользователя</summary>

```json
{
  "name": "manage_user",
  "arguments": {
    "action": "create",
    "userId": "user123",
    "data": {
      "username": "Иван Иванов",
      "trafficLimit": 107374182400,
      "maxDevices": 3,
      "groups": ["groupId1"]
    }
  }
}
```

</details>

---

### 🖥 manage_node — Управление серверами

> Требуется scope: `nodes:write`

**Доступные действия:** `create` | `update` | `delete` | `sync` | `setup` | `reset_status` | `update_config`

<details>
<summary>📖 Пример: Настроить ноду через SSH</summary>

```json
{
  "name": "manage_node",
  "arguments": {
    "action": "setup",
    "id": "nodeId123",
    "setupOptions": {
      "installHysteria": true,
      "setupPortHopping": true,
      "restartService": true
    }
  }
}
```

</details>

---

### 📁 manage_group — Управление группами

> Требуется scope: `nodes:write`

**Доступные действия:** `create` | `update` | `delete`

---

### 🔗 manage_cascade — Каскадные туннели

> Требуется scope: `nodes:write`

**Доступные действия:** `create` | `update` | `delete` | `deploy` | `undeploy` | `reconnect`

---

### 💻 execute_ssh — Выполнение команд

> Требуется scope: `nodes:write`

Выполняет shell-команду на сервере и возвращает вывод.

<details>
<summary>📖 Пример: Проверить статус сервиса</summary>

```json
{
  "name": "execute_ssh",
  "arguments": {
    "nodeId": "nodeId123",
    "command": "systemctl status hysteria-server"
  }
}
```

</details>

---

### 🖥 ssh_session — Интерактивная SSH-сессия

> Требуется scope: `nodes:write`

**Доступные действия:** `start` | `input` | `close`

---

### ⚙️ system_action — Системные операции

> Требуется scope: `sync:write`

**Доступные действия:** `sync_all` | `clear_cache` | `backup` | `kick_user`

---

### 🗺 get_topology — Топология сети

> Требуется scope: `nodes:read`

Возвращает все активные ноды и связи между ними.

---

### ❤️ health_check — Проверка состояния

> ✅ Scope не требуется

Возвращает uptime, статус синхронизации, статистику кэша, использование памяти.

---

## 📝 Готовые промпты

> Промпты — это предустановленные сценарии, которые появляются как slash-команды в Claude Desktop (например, `/panel_overview`).

| Промпт | Описание |
|--------|----------|
| 📊 `panel_overview` | Обзор системы: ноды, пользователи, здоровье |
| 🔍 `audit_nodes` | Найти проблемные ноды и предложить исправления |
| 👤 `user_report` | Детальный отчёт по конкретному пользователю |
| 🖥 `setup_new_node` | Пошаговое добавление новой ноды |
| 🔧 `troubleshoot_node` | Диагностика ноды через SSH |
| ⏰ `manage_expired_users` | Поиск и обработка истёкших пользователей |

---

## 💡 Примеры использования

### 📊 "Покажи состояние всех серверов"

AI выполнит:

| Шаг | Инструмент | Цель |
|-----|------------|------|
| 1 | `health_check` | Общее состояние |
| 2 | `query` с `resource=nodes` | Список нод |
| 3 | — | Сформирует отчёт с проблемными нодами |

---

### 👤 "Создай пользователя testuser с лимитом 50 ГБ"

AI выполнит:

```
manage_user → action=create, userId=testuser, trafficLimit=53687091200
```

---

### 🔧 "Почему нода DE-01 не работает?"

AI выполнит:

| Шаг | Инструмент | Цель |
|-----|------------|------|
| 1 | `query` с `resource=nodes`, `id=<DE-01-id>` | Получить lastError |
| 2 | `execute_ssh` с `systemctl status hysteria-server` | Проверить сервис |
| 3 | — | Проанализирует и предложит решение |

---

### 🖥 "Настрой новый сервер 192.168.1.100"

AI использует промпт `setup_new_node`:

| Шаг | Действие |
|-----|----------|
| 1 | 📋 Сбор данных (IP, домен, SSH-реквизиты) |
| 2 | 🆕 Создание ноды через `manage_node` |
| 3 | ⚙️ Автонастройка через `manage_node action=setup` |
| 4 | ✅ Проверка статуса |

---

## 🔑 Права доступа (Scopes)

| Scope | Описание | Уровень |
|-------|----------|---------|
| `mcp:enabled` | 🟢 Базовое право для MCP-доступа | Обязательно |
| `users:read` | 👁 Чтение пользователей | Чтение |
| `users:write` | ✏️ Создание, изменение, удаление | Запись |
| `nodes:read` | 👁 Чтение серверов и статистики | Чтение |
| `nodes:write` | ✏️ Управление серверами, SSH-команды | Запись |
| `stats:read` | 👁 Чтение статистики, системных логов и access-логов ClickHouse | Чтение |
| `sync:write` | ✏️ Синхронизация, бэкапы, системные операции | Запись |

---

## 🛡 Безопасность

| Рекомендация | Описание |
|--------------|----------|
| 🔒 **Безопасное хранение** | Храните API-ключи в безопасном месте |
| 🎯 **Минимум прав** | Используйте минимально необходимые права |
| 🔄 **Ротация ключей** | Периодически меняйте ключи |
| 📝 **Аудит** | Все MCP-операции логируются в системных логах панели |

---

## 📚 Источники

| Файл | Описание |
|------|----------|
| `src/services/mcpService.js` | Реестр инструментов |
| `src/routes/mcp.js` | MCP-эндпоинты |
| `src/mcp/prompts.js` | Предустановленные промпты |
| `src/locales/ru.json` | Локализация интерфейса MCP |
