/**
 * Russian translations for the OpenAPI spec.
 * Only overrides: info.description, tags[].description, and paths operation summaries/descriptions.
 * Merged on top of the base English spec by buildSpec(lang).
 */

module.exports = {
    ru: {
        info: {
            description: `
Управляющий API для [C³ CELERITY](https://github.com/ClickDevTech/hysteria-panel) — панели Hysteria 2 от Click Connect.

## Частые сценарии

1. Создать пользователя через \`POST /users\`, затем отдать \`subscriptionToken\` как \`https://your-domain/api/files/{token}\`.
2. Добавить ноду через \`POST /nodes\`, затем настроить её через \`POST /nodes/{id}/setup\`.
3. Получить общую статистику через \`GET /stats\` и статус ноды через \`GET /nodes/{id}/status\`.
4. Отключить истёкшего пользователя через \`POST /users/{userId}/disable\` и очистить устройства через \`DELETE /users/{userId}/devices\`.
5. Собрать multi-hop маршрут через \`POST /cascade/links\`, затем развернуть цепочку через \`POST /cascade/chain/deploy\`.
6. Объединить несколько реальных нод в один авто-балансировщик через \`POST /nodes\` (\`type=virtual\`); HAPP/Xray-core клиенты получат Xray balancer + observatory профиль, sing-box/Clash — \`urltest\`/\`url-test\` группу.
7. Автоматизировать действия панели через MCP: \`POST /mcp\` и \`tools/list\`.

## Аутентификация

Защищённые эндпоинты \`/api/*\` требуют аутентификации через **API-ключ** или cookie-сессию администратора.
\`/api/auth\`, \`/api/files\`, \`/api/info\`, \`/api/login\`, \`/api/login/totp\` и \`/api/logout\` не требуют API-ключ.

Создать ключ: **Панель → Настройки → Безопасность → API-ключи**

\`\`\`
X-API-Key: ck_your_key_here
\`\`\`
или
\`\`\`
Authorization: Bearer ck_your_key_here
\`\`\`

## Скоупы

| Скоуп | Доступ |
|-------|--------|
| \`users:read\` | Чтение пользователей |
| \`users:write\` | Создание / изменение / удаление пользователей |
| \`nodes:read\` | Чтение нод |
| \`nodes:write\` | Создание / изменение / удаление / синхронизация нод |
| \`stats:read\` | Статистика и группы |
| \`sync:write\` | Запуск синхронизации, кик пользователей |
| \`mcp:enabled\` | JSON-RPC эндпоинт MCP |

Сессии администратора (cookie) полностью обходят проверку скоупов.

## Лимиты Запросов

- API-ключи имеют собственный лимит в минуту, заданный при создании ключа (по умолчанию: 60/мин).
- \`POST /login\`: 10 попыток за 15 минут.
- \`POST /login/totp\`: 8 попыток за 10 минут.
- \`/files/{token}\` и \`/info/{token}\`: управляются настройкой лимита подписок.
- Операции развёртывания каскада: 10 запросов в минуту.

## Ошибки

JSON-эндпоинты возвращают ошибки в таком формате:

\`\`\`json
{ "error": "Authentication required" }
\`\`\`

Частые коды: \`400\` неверный ввод, \`401\` нет аутентификации, \`403\` не хватает скоупа или IP заблокирован, \`404\` не найдено, \`409\` конфликт, \`429\` превышен лимит, \`500\` внутренняя ошибка.

Многие тексты ошибок валидации и «не найдено» приходят на русском (например, \`userId обязателен\`, \`Пользователь не найден\`). Поле \`error\` всегда в одном формате.

**Production:** при \`NODE_ENV !== 'development'\` все \`5xx\` ответы заменяются на \`{ "error": "Internal Server Error" }\` независимо от исходного сообщения. Примеры \`5xx\` в этой документации отражают вывод в режиме разработки; в production клиентам стоит считать тело \`5xx\` непрозрачным.

## Эндпоинты вне /api

Эти эндпоинты не находятся под \`/api\` и не входят в эту спецификацию:

- \`GET /health\` — публичный health-check (возвращает \`{ status, uptime, lastSync, isSyncing, cache }\`), используется мониторингом; без аутентификации.
- \`GET /\`, \`HEAD /\` — публичная посадочная/маскировочная страница (настраивается под каждую установку).
- \`/panel/*\` — админ-панель (cookie-сессия, HTML).
- \`/ws/terminal/{nodeId}\`, \`/ws/logs\`, \`/ws/broadcast\` — WebSocket-каналы только для админ-сессии (cookie).
            `.trim(),
        },
        tags: [
            { name: 'Auth',   description: 'Вход/выход админской сессии и HTTP-аутентификация нод' },
            { name: 'Stats',  description: 'Статистика панели и группы серверов' },
            { name: 'Users',  description: 'Управление пользователями — скоуп: `users:read` / `users:write`' },
            { name: 'Nodes',  description: 'Управление нодами — скоуп: `nodes:read` / `nodes:write`' },
            { name: 'Cascade', description: 'Управление каскадными туннелями — скоуп: `nodes:read` / `nodes:write`' },
            { name: 'MCP',    description: 'Эндпоинт MCP — скоуп: `mcp:enabled`' },
            { name: 'Sync',   description: 'Синхронизация и кик пользователей — скоуп: `sync:write`' },
            { name: 'Public', description: 'Публичные эндпоинты — аутентификация не требуется' },
        ],
        operations: {
            'POST /login': {
                summary: 'Создать сессию администратора',
                description: 'Проверяет логин и пароль администратора. Если включён TOTP, возвращает 202 и требует завершить вход через `/login/totp` в той же cookie-сессии.',
            },
            'POST /login/totp': {
                summary: 'Завершить вход через TOTP',
                description: 'Завершает ожидающий вход администратора, у которого включена двухфакторная аутентификация.',
            },
            'POST /logout': {
                summary: 'Удалить сессию администратора',
                description: 'Завершает текущую cookie-сессию администратора.',
            },
            'POST /auth': {
                summary: 'Проверить пользователя при подключении',
                description: 'Вызывается нодами Hysteria для аутентификации клиентов. API-ключ не требуется.',
            },
            'GET /files/{token}': {
                summary: 'Получить конфиг подписки',
                description: 'В браузере без `format` отдаёт HTML-страницу, для приложений автоматически определяет формат по User-Agent. Может добавлять заголовки HAPP-маршрутизации и HWID.',
            },
            'GET /info/{token}': {
                summary: 'Получить информацию о подписке',
                description: 'Возвращает статус подписки, группы, использование/лимит трафика, дату истечения и число доступных серверов.',
            },
            'GET /stats': {
                summary: 'Статистика панели',
                description: 'Возвращает общее количество пользователей, нод и текущих подключений.',
            },
            'GET /groups': {
                summary: 'Список групп серверов',
                description: 'Возвращает активные группы серверов. Требуется скоуп `stats:read`.',
            },
            'POST /groups': {
                summary: 'Создать группу серверов',
                description: 'Создаёт группу серверов. Требуется скоуп `nodes:write`.',
            },
            'PUT /groups/{id}': {
                summary: 'Обновить группу серверов',
                description: 'Частично обновляет группу: изменяются только переданные поля. Требуется скоуп `nodes:write`.',
            },
            'DELETE /groups/{id}': {
                summary: 'Удалить группу серверов',
                description: 'Удаляет группу и отвязывает её от всех нод и пользователей. Требуется скоуп `nodes:write`.',
            },
            'GET /users': {
                summary: 'Список пользователей',
                description: 'Поддерживает пагинацию, фильтрацию и сортировку.',
            },
            'POST /users': {
                summary: 'Создать пользователя',
                description: 'Создаёт пользователя, генерирует `password` и `xrayUuid` и возвращает запись с токеном подписки. `groups` и `nodes` отдаются как строки ObjectId (без populate). Требуется скоуп `users:write`.',
            },
            'GET /users/{userId}': {
                summary: 'Получить пользователя по ID',
                description: 'Возвращает пользователя вместе с группами и назначенными нодами. Требуется скоуп `users:read`.',
            },
            'PUT /users/{userId}': {
                summary: 'Обновить пользователя',
                description: 'Частично обновляет пользователя: статус, группы, лимиты, дату истечения и HWID-настройки. Требуется скоуп `users:write`.',
            },
            'DELETE /users/{userId}': {
                summary: 'Удалить пользователя',
                description: 'Удаляет пользователя, очищает HWID-устройства и инвалидирует кеш подписки. Требуется скоуп `users:write`.',
            },
            'POST /users/{userId}/enable': {
                summary: 'Включить пользователя',
                description: 'Включает пользователя и добавляет его на Xray-ноды в фоне. Возвращает обновлённого пользователя; `groups` и `nodes` отдаются как строки ObjectId (без populate). Требуется скоуп `users:write`.',
            },
            'POST /users/{userId}/disable': {
                summary: 'Отключить пользователя',
                description: 'Отключает пользователя и удаляет его с Xray-нод в фоне. Возвращает обновлённого пользователя; `groups` и `nodes` отдаются как строки ObjectId (без populate). Требуется скоуп `users:write`.',
            },
            'POST /users/{userId}/reset-traffic': {
                summary: 'Сбросить трафик пользователя',
                description: 'Обнуляет счётчики отдачи/приёма. Если пользователь был отключён только из-за трафика или истечения и обнуление снова делает его «здоровым», он автоматически включается заново. Требуется скоуп `users:write`.',
            },
            'POST /users/{userId}/groups': {
                summary: 'Добавить пользователя в группы',
                description: 'Добавляет пользователя в одну или несколько групп. Требуется скоуп `users:write`.',
            },
            'DELETE /users/{userId}/groups/{groupId}': {
                summary: 'Удалить пользователя из группы',
                description: 'Удаляет пользователя из указанной группы. Требуется скоуп `users:write`.',
            },
            'GET /users/{userId}/devices': {
                summary: 'Список HWID-устройств пользователя',
                description: 'Возвращает зарегистрированные HWID-устройства и эффективный лимит устройств. Требуется скоуп `users:read`.',
            },
            'DELETE /users/{userId}/devices': {
                summary: 'Удалить все HWID-устройства пользователя',
                description: 'Удаляет все HWID-устройства пользователя и сбрасывает уведомления о лимите. Требуется скоуп `users:write`.',
            },
            'DELETE /users/{userId}/devices/{hwid}': {
                summary: 'Удалить одно HWID-устройство',
                description: 'Удаляет конкретное HWID-устройство пользователя. Требуется скоуп `users:write`.',
            },
            'POST /users/sync-from-main': {
                summary: 'Массово синхронизировать пользователей',
                description: 'Создаёт или обновляет пользователей из внешнего/основного источника данных.',
            },
            'GET /nodes': {
                summary: 'Список нод',
                description: 'Возвращает список нод с фильтрами по активности, статусу и группе. Требуется скоуп `nodes:read`.',
            },
            'POST /nodes': {
                summary: 'Создать ноду',
                description: `Создаёт **Hysteria**, **Xray**, **Virtual** (балансировщик) или **CDN** ноду. \`statsSecret\` генерируется сервером.

- \`type=hysteria\` (по умолчанию) / \`type=xray\` — обязателен \`ip\`. 409, если на том же IP уже есть нода того же \`type\`.
- \`type=virtual\` — логический балансировщик поверх реальных соседних нод. **Не передавайте** \`ip\` или \`ssh\`; передайте объект \`virtual\` с \`sources\` (или \`sourceGroup\`) и \`strategy\`.
- \`type=cdn\` — фронт, публикующий один inbound Xray-ноды через CDN. **Не передавайте** \`ip\` или \`ssh\`; передайте объект \`cdn\` с \`originNode\` и хотя бы одним из \`domain\` / включённых \`edges\`. Каждый включённый edge становится отдельной записью в подписке.

Virtual и CDN ноды не запускают setup, health-check, traffic collection и restart — они появляются только в подписках.

Требуется скоуп \`nodes:write\`.`,
            },
            'GET /nodes/{id}': {
                summary: 'Получить ноду по ID',
                description: 'Возвращает ноду с группами и количеством активных пользователей. Требуется скоуп `nodes:read`.',
            },
            'PUT /nodes/{id}': {
                summary: 'Обновить ноду',
                description: 'Частично обновляет настройки ноды и планирует отправку конфига при изменениях. При смене `type` на `virtual` или `cdn` нужно передать корректный объект `virtual` / `cdn`; `ip`, `domain`, `sni` и SSH будут очищены. При результирующем серверном типе поле `ip` (унаследованное или переданное) должно быть непустым. 409, если нода служит origin для CDN-ноды, а правка меняет её тип, транспорт или security. Требуется скоуп `nodes:write`.',
            },
            'DELETE /nodes/{id}': {
                summary: 'Удалить ноду',
                description: 'Удаляет ноду и убирает её из назначений пользователей. 409, если нода служит origin для CDN-ноды. Требуется скоуп `nodes:write`.',
            },
            'GET /nodes/check-ip': {
                summary: 'Проверить соседние ноды по IP',
                description: 'Возвращает Hysteria/Xray ноды на том же IP. Используется интерфейсом при добавлении ноды. Виртуальные ноды не имеют IP и в выдаче не появляются.',
            },
            'GET /nodes/{id}/status': {
                summary: 'Получить сохранённый статус ноды',
                description: 'Возвращает статус, который сейчас сохранён в базе панели.',
            },
            'POST /nodes/{id}/reset-status': {
                summary: 'Сбросить статус ноды',
                description: 'Помечает ноду как online и очищает последнюю ошибку/счётчик неудачных проверок здоровья.',
            },
            'GET /nodes/{id}/agent-info': {
                summary: 'Получить информацию Xray-агента',
                description: 'Запрашивает текущую информацию у CC Agent на Xray-ноде.',
            },
            'POST /nodes/{id}/sync': {
                summary: 'Синхронизировать конкретную ноду',
                description: 'Отправляет актуальный конфиг на ноду через SSH. Виртуальные ноды возвращают **400** — у них нет удалённого сервиса.',
            },
            'POST /nodes/{id}/setup': {
                summary: 'Автонастройка ноды через SSH',
                description: 'Настройка через SSH: для Hysteria — установка бинарника, конфиг, port hopping, перезапуск `hysteria-server`; для Xray — setup агента (из body используется только `restartService`). Виртуальные ноды возвращают **400** — у них нет удалённого сервиса для настройки. Обычно 30 секунд — 2 минуты; таймаут клиента ≥ 3 минуты. Нужны SSH-данные на ноде. Успех: `{ success, logs }`, ошибка: `500` с `{ success: false, error, logs }`.',
            },
            'GET /nodes/{id}/config': {
                summary: 'Получить сгенерированный конфиг ноды',
                description: 'Возвращает YAML-конфиг сервера Hysteria 2 (`text/yaml`). Для Xray используется другой pipeline конфигурации.',
            },
            'GET /nodes/{id}/users': {
                summary: 'Список пользователей на ноде',
                description: 'Возвращает включённых пользователей на ноде только с полями `userId`, `username` и `traffic`. Требуется скоуп `nodes:read`.',
            },
            'POST /nodes/{id}/groups': {
                summary: 'Добавить ноду в группы',
                description: 'Добавляет ноду в одну или несколько групп серверов. Требуется скоуп `nodes:write`.',
            },
            'DELETE /nodes/{id}/groups/{groupId}': {
                summary: 'Удалить ноду из группы',
                description: 'Удаляет ноду из указанной группы серверов. Требуется скоуп `nodes:write`.',
            },
            'POST /nodes/{id}/setup-port-hopping': {
                summary: 'Настроить port hopping',
                description: 'Применяет iptables/NAT правила port hopping на ноде через SSH.',
            },
            'POST /nodes/{id}/update-config': {
                summary: 'Отправить сгенерированный конфиг на ноду',
                description: 'Перегенерирует и загружает конфиг ноды через SSH/агент.',
            },
            'GET /cascade/links': {
                summary: 'Список каскадных связей',
                description: 'Возвращает каскадные связи с фильтрами по активности, статусу и участвующей ноде. Требуется скоуп `nodes:read`.',
            },
            'POST /cascade/links': {
                summary: 'Создать каскадную связь',
                description: 'Создаёт каскадный туннель между входной и выходной нодами. Требуется скоуп `nodes:write`.',
            },
            'GET /cascade/links/{id}': {
                summary: 'Получить каскадную связь',
                description: 'Возвращает одну каскадную связь с данными входной и выходной нод. Требуется скоуп `nodes:read`.',
            },
            'PUT /cascade/links/{id}': {
                summary: 'Обновить каскадную связь',
                description: 'Обновляет параметры каскадного туннеля и при необходимости может запустить redeploy. Требуется скоуп `nodes:write`.',
            },
            'DELETE /cascade/links/{id}': {
                summary: 'Удалить каскадную связь',
                description: 'Если связь развёрнута, сначала удаляет каскадный конфиг с нод.',
            },
            'PATCH /cascade/links/{id}/reconnect': {
                summary: 'Переподключить каскадную связь',
                description: 'Меняет входную и/или выходную ноду, при необходимости сначала снимая текущий конфиг.',
            },
            'POST /cascade/links/{id}/deploy': {
                summary: 'Развернуть каскадную связь',
                description: 'Разворачивает конфиг каскадной связи на обеих нодах. Требуется скоуп `nodes:write`.',
            },
            'POST /cascade/links/{id}/undeploy': {
                summary: 'Снять каскадную связь',
                description: 'Удаляет каскадный конфиг с нод для указанной связи. Требуется скоуп `nodes:write`.',
            },
            'POST /cascade/chain/deploy': {
                summary: 'Развернуть каскадную цепочку',
                description: 'Разворачивает всю цепочку, начиная от `nodeId` или от входной стороны `linkId`.',
            },
            'GET /cascade/links/{id}/health': {
                summary: 'Проверить здоровье каскадной связи',
                description: 'Выполняет проверку здоровья каскадной связи и возвращает статус/задержку. Требуется скоуп `nodes:read`.',
            },
            'GET /cascade/topology': {
                summary: 'Получить топологию каскада',
                description: 'Возвращает граф сети для визуальной карты.',
            },
            'POST /cascade/topology/positions': {
                summary: 'Сохранить позиции топологии',
                description: 'Сохраняет позиции нод на визуальной карте каскада. Требуется скоуп `nodes:write`.',
            },
            'POST /mcp': {
                summary: 'Потоковый HTTP-эндпоинт MCP',
                description: 'JSON-RPC 2.0 эндпоинт MCP для `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list` и `prompts/get`.',
            },
            'GET /mcp/sse': {
                summary: 'Открыть legacy SSE поток MCP',
                description: 'Устаревший MCP transport. Отдаёт событие `endpoint` с URL `/api/mcp/messages?sessionId=...`.',
            },
            'POST /mcp/messages': {
                summary: 'Отправить сообщение legacy MCP SSE',
                description: 'Принимает JSON-RPC запрос и отправляет ответ в открытый SSE поток.',
            },
            'GET /mcp/tools': {
                summary: 'Список инструментов MCP',
                description: 'Возвращает доступные MCP tools для текущего API-ключа. Требуется скоуп `mcp:enabled`.',
            },
            'GET /mcp/prompts': {
                summary: 'Список промптов MCP',
                description: 'Возвращает доступные MCP prompts. Требуется скоуп `mcp:enabled`.',
            },
            'POST /sync': {
                summary: 'Синхронизировать все ноды',
                description: 'Отправляет конфиг на все активные ноды параллельно. Возвращает ответ немедленно — синхронизация идёт в фоне.',
            },
            'POST /kick/{userId}': {
                summary: 'Кикнуть пользователя со всех нод',
                description: 'Принудительно отключает пользователя от всех нод Hysteria.',
            },
        },
        replacements: {
            'Current server': 'Текущий сервер',
            'API key in `X-API-Key` header': 'API-ключ в заголовке `X-API-Key`',
            'API key as Bearer token': 'API-ключ как Bearer-токен',
            'Invalid or missing API key': 'API-ключ отсутствует или неверен',
            'Missing required scope or IP not in allowlist': 'Не хватает нужного скоупа или IP не в allowlist',
            'Resource not found': 'Ресурс не найден',
            'Rate limit exceeded': 'Превышен лимит запросов',
            'Bytes, 0 = unlimited': 'Байты, 0 = без лимита',
            'VPN password (auto-generated on create; returned on read/write responses)': 'Пароль VPN (генерируется при создании; возвращается в ответах чтения/записи)',
            'VLESS UUID for Xray nodes': 'UUID VLESS для Xray-нод',
            'Present on `GET /users` and `GET /users/{userId}`; omitted on enable/disable/groups responses': 'Присутствует в `GET /users` и `GET /users/{userId}`; отсутствует в ответах enable/disable/groups',
            'Returns the updated user. `groups` and `nodes` are returned as ObjectId strings (no populate); call `GET /users/{userId}` for populated objects.': 'Возвращает обновлённого пользователя. `groups` и `nodes` отдаются как строки ObjectId (без populate); используйте `GET /users/{userId}` для разворачивания.',
            'Auto-generates `password` and `xrayUuid` on first save. Returns the new user; `groups` and `nodes` are returned as ObjectId strings (no populate).': 'Автоматически генерирует `password` и `xrayUuid` при первом сохранении. Возвращает нового пользователя; `groups` и `nodes` отдаются как строки ObjectId (без populate).',
            'Present on unhandled exceptions': 'Присутствует только при необработанных исключениях',
            'Bytes uploaded': 'Отправлено байт',
            'Bytes downloaded': 'Получено байт',
            'Bytes used': 'Использовано байт',
            '0 = unlimited': '0 = без лимита',
            '0 = from group, -1 = unlimited': '0 = из группы, -1 = без лимита',
            '0 = from min of groups, -1 = unlimited': '0 = минимум из групп, -1 = без лимита',
            'Override panel HWID mode': 'Переопределение режима HWID панели',
            'Start enforcing HWID limit at this time (optional)': 'Начать применять HWID-лимит с этого времени (опционально)',
            'Effective maxDevices for HWID (same rules as auth)': 'Итоговый лимит устройств для HWID (те же правила, что в auth)',
            'Port-hopping interval': 'Интервал port hopping',
            'HTTP listen address for masquerade': 'HTTP-адрес прослушивания для маскировки',
            'HTTPS listen address for masquerade': 'HTTPS-адрес прослушивания для маскировки',
            'Enable sniffing within the protocol': 'Включить sniffing внутри протокола',
            'Inline ACL rules': 'Встроенные ACL-правила',
            'Whether to use TLS cert/key files instead of ACME': 'Использовать файлы TLS-сертификата и ключа вместо ACME',
            'Unique user ID (e.g. Telegram ID)': 'Уникальный ID пользователя (например, ID в Telegram)',
            'Node ObjectId': 'ObjectId ноды',
            'Group ObjectId': 'ObjectId группы',
            'User subscription token': 'Токен подписки пользователя',
            'Force output format (overrides User-Agent detection)': 'Принудительно выбрать формат (переопределяет определение по User-Agent)',
            'Client IP:port': 'IP:порт клиента',
            'userId (only when ok=true)': 'userId (только при ok=true)',
            'Auth result': 'Результат аутентификации',
            'Authenticated': 'Аутентификация успешна',
            'Two-factor verification required': 'Требуется двухфакторная проверка',
            'Logged out': 'Сессия завершена',
            'Subscription config or browser HTML page': 'Конфиг подписки или HTML-страница для браузера',
            'Subscription disabled, expired, traffic limit reached, or HWID soft-block response': 'Подписка отключена/истекла, достигнут лимит трафика или возвращена мягкая HWID-блокировка',
            'Token not found': 'Токен не найден',
            'Subscription rate limit exceeded': 'Превышен лимит запросов к подписке',
            'No servers available': 'Нет доступных серверов',
            'Subscription info': 'Информация о подписке',
            'Statistics': 'Статистика',
            'Array of groups': 'Массив групп',
            'Paginated user list': 'Постраничный список пользователей',
            'Created user': 'Пользователь создан',
            'userId is required': 'Требуется userId',
            'User already exists': 'Пользователь уже существует',
            'User': 'Пользователь',
            'Updated user': 'Пользователь обновлён',
            'Deleted': 'Удалено',
            'HWID devices': 'HWID-устройства',
            'HWID (URL-encoded if needed)': 'HWID (URL-encoded при необходимости)',
            'Filter by enabled status': 'Фильтр по статусу включения',
            'Filter by active status': 'Фильтр по активности',
            'Filter by group ObjectId': 'Фильтр по ObjectId группы',
            'Filter links that touch this node': 'Фильтр связей, где участвует эта нода',
            '`users` must be an array': '`users` должен быть массивом',
            '`groups` must be an array': '`groups` должен быть массивом',
            '`positions` must be an array': '`positions` должен быть массивом',
            '`nodeId` or `linkId` is required': 'Требуется `nodeId` или `linkId`',
            'Sync result': 'Результат синхронизации',
            'Node IP address': 'IP-адрес ноды',
            'Matching nodes': 'Найденные ноды',
            'Node list': 'Список нод',
            'Created node': 'Нода создана',
            'Node': 'Нода',
            'Updated node': 'Нода обновлена',
            'Node status': 'Статус ноды',
            'Status reset': 'Статус сброшен',
            'Agent info': 'Информация агента',
            'Node is not an Xray node': 'Нода не является Xray-нодой',
            'Agent request failed': 'Запрос к агенту не удался',
            'Sync started/completed': 'Синхронизация запущена/завершена',
            'Setup completed successfully': 'Настройка успешно завершена',
            'Setup failed': 'Настройка не удалась',
            'Setup log lines': 'Строки лога настройки',
            'SSH credentials not configured': 'SSH-данные не настроены',
            'Install/update Hysteria binary': 'Установить/обновить бинарник Hysteria',
            'Configure iptables NAT rules for port hopping range': 'Настроить правила iptables/NAT для диапазона port hopping',
            'Enable and restart hysteria-server systemd unit': 'Включить и перезапустить юнит systemd hysteria-server',
            'Hysteria 2 config YAML': 'YAML-конфиг Hysteria 2',
            'User list': 'Список пользователей',
            'Configured': 'Настроено',
            'Failed to configure port hopping': 'Не удалось настроить port hopping',
            'Config updated': 'Конфиг обновлён',
            'Failed to update config': 'Не удалось обновить конфиг',
            'Generated keys': 'Ключи сгенерированы',
            'Node is not Xray or SSH credentials are missing': 'Нода не Xray или SSH-данные отсутствуют',
            'Cascade links': 'Каскадные связи',
            'Cascade link': 'Каскадная связь',
            'Created link': 'Связь создана',
            'Updated link': 'Связь обновлена',
            'Cascade link ObjectId': 'ObjectId каскадной связи',
            'Invalid link ID': 'Неверный ID связи',
            'Invalid link settings': 'Неверные настройки связи',
            'Invalid topology or tunnel settings': 'Неверная топология или настройки туннеля',
            'Invalid reconnect request': 'Неверный запрос переподключения',
            'Deploy chain after creation': 'Развернуть цепочку после создания',
            'Deploy failed': 'Развёртывание не удалось',
            'Deployed': 'Развёрнуто',
            'Undeployed': 'Снято',
            'Chain deployed': 'Цепочка развёрнута',
            'Chain deploy failed': 'Развёртывание цепочки не удалось',
            'Health result': 'Результат проверки здоровья',
            'Topology graph': 'Граф топологии',
            'Saved': 'Сохранено',
            'JSON-RPC response or SSE stream': 'JSON-RPC ответ или SSE-поток',
            'Invalid JSON-RPC request': 'Неверный JSON-RPC запрос',
            'SSE stream': 'SSE-поток',
            'Accepted; response is sent on the SSE stream': 'Принято; ответ будет отправлен в SSE-поток',
            'Session not found or invalid JSON-RPC request': 'Сессия не найдена или JSON-RPC запрос неверен',
            'Tool list': 'Список инструментов',
            'Prompt list': 'Список промптов',
            'Sync started': 'Синхронизация запущена',
            'Sync already in progress': 'Синхронизация уже выполняется',
            'Kicked': 'Пользователь отключён',
            'Traffic counters in bytes.': 'Счётчики трафика в байтах.',
            'Uploaded bytes': 'Отправлено байт',
            'Downloaded bytes': 'Получено байт',
            'Total used bytes': 'Всего использовано байт',
            'Traffic limit in bytes, 0 = unlimited': 'Лимит трафика в байтах, 0 = без лимита',
            'Rate-limit error response.': 'Ответ при превышении лимита запросов.',
            'Payload for creating a Hysteria or Xray node.': 'Тело запроса для создания Hysteria или Xray ноды.',
            'Display name shown in panel and subscriptions.': 'Отображаемое имя в панели и подписках.',
            'Server IP address.': 'IP-адрес сервера.',
            'Node protocol family.': 'Семейство протокола ноды.',
            'Public domain for TLS/SNI.': 'Публичный домен для TLS/SNI.',
            'Optional SNI override.': 'Опциональное переопределение SNI.',
            'Main service port.': 'Основной порт сервиса.',
            'UDP port hopping range.': 'Диапазон UDP port hopping.',
            'Hysteria stats API port.': 'Порт Hysteria Stats API.',
            'Server group ObjectIds.': 'ObjectId групп серверов.',
            '0 = unlimited.': '0 = без лимита.',
            'SSH credentials. Password or privateKey can be provided.': 'SSH-данные. Можно передать password или privateKey.',
            'Xray-specific settings when `type=xray`.': 'Настройки Xray, когда `type=xray`.',
            'Partial node update payload. Any omitted field is left unchanged.': 'Частичное обновление ноды. Пропущенные поля не меняются.',
            'Payload for creating a cascade tunnel between two Xray nodes.': 'Тело запроса для создания каскадного туннеля между двумя Xray нодами.',
            'Deploy the chain after creating the link.': 'Развернуть цепочку после создания связи.',
            'Partial cascade link update payload.': 'Частичное обновление каскадной связи.',
            'Admin session cookie returned by `/api/login`': 'Cookie-сессия администратора, возвращаемая `/api/login`',
            'Authentication error': 'Ошибка аутентификации',
            'Scope error': 'Ошибка скоупа',
            'Rate limit error': 'Ошибка лимита запросов',
            'Admin login request': 'Запрос входа администратора',
            'TOTP verification request': 'Запрос проверки TOTP',
            'Admin login response': 'Ответ входа администратора',
            'Create an enabled user': 'Создать включённого пользователя',
            'User response': 'Ответ с пользователем',
            'Create a Hysteria node': 'Создать Hysteria-ноду',
            'Node response': 'Ответ с нодой',
            'Create a cascade link': 'Создать каскадную связь',
            'Cascade link response': 'Ответ с каскадной связью',
            'Panel stats': 'Статистика панели',
            'Success': 'Успех',
            'List MCP tools': 'Список инструментов MCP',
            'JSON-RPC response': 'JSON-RPC ответ',
            'Generic JSON response': 'Общий JSON-ответ',
            'Invalid request body or parameters': 'Неверное тело запроса или параметры',
            'Missing credentials, invalid/expired API key, or failed login': 'Нет учётных данных, API-ключ неверен/истёк или ошибка входа',
            'Missing required scope or API key IP not in allowlist': 'Не хватает скоупа или IP API-ключа не в allowlist',
            'API key or login rate limit exceeded (JSON body)': 'Превышен лимит API-ключа или входа (тело JSON)',
            'Subscription endpoint rate limit exceeded (plain text body)': 'Превышен лимит подписки (тело plain text)',
            'Page size (no hard server maximum; use reasonable values)': 'Размер страницы (жёсткого лимита на сервере нет; используйте разумные значения)',
            'Missing userId': 'Отсутствует userId',
            'Duplicate IP for this protocol type': 'Дубликат IP для этого типа протокола',
            'Validation error': 'Ошибка валидации',
            'Subset of user fields returned by GET /nodes/{id}/users': 'Подмножество полей пользователя из GET /nodes/{id}/users',
            'Returns enabled users on this node with `userId`, `username`, and `traffic` only.': 'Возвращает включённых пользователей на ноде только с `userId`, `username` и `traffic`.',
            'Hysteria 2 server config (YAML)': 'Конфиг сервера Hysteria 2 (YAML)',
            'Creates a Hysteria or Xray node. `statsSecret` is generated by the server. Returns 409 if the same IP already has a node of the same `type`.': 'Создаёт Hysteria или Xray ноду. `statsSecret` генерируется сервером. Возвращает 409, если на том же IP уже есть нода того же `type`.',
            'Admin login response (200)': 'Ответ входа администратора (200)',
            'Admin login pending TOTP (202)': 'Ожидание TOTP при входе (202)',
            'Logout response': 'Ответ выхода',
            'Node auth accepted': 'Аутентификация на ноде принята',
            'Node auth rejected': 'Аутентификация на ноде отклонена',
            'Paginated users': 'Постраничный список пользователей',
            'Users on a node': 'Пользователи на ноде',
            'Bulk sync result': 'Результат массовой синхронизации',
            'Node setup completed': 'Настройка ноды завершена',
            'Node deleted': 'Нода удалена',
            'User kicked': 'Пользователь отключён',
            'Success with message': 'Успех с сообщением',
        },
    },
};
