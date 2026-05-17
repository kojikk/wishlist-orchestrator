# Wishlist Orchestrator

Агрегатор для нескольких инстансов [wishlist-app](https://github.com/kojikk/wishlist) + встроенный Caddy-прокси. Опрашивает каждый инстанс по стабильному контракту (Wishlist Protocol), объединяет категории и брони в одно представление, проксирует операции бронирования и автоматически раздаёт поддомены через Let's Encrypt.

> **Статус:** ранний MVP. UI — заглушка с дебаг-выводом; полноценный агрегированный фронтенд появится дальше.

---

## Что это

У вас несколько вишлистов на разных доменах (личный, семейный, рабочий). У каждого — свой backend по адресу `wishlist-N.example.com`. Оркестратор:

1. Знает список инстансов из `config/instances.json`
2. У каждого вызывает `GET /api/manifest` — проверяет, что версия Wishlist Protocol совместима
3. Периодически тянет `/api/config` и `/api/bookings`
4. Отдаёт объединённый снимок через `GET /api/aggregate`
5. Проксирует операции бронирования: `POST /api/instances/:id/book` → `POST /api/book` нужного инстанса
6. Запускает рядом контейнер с Caddy и автоматически генерирует ему конфиг с поддоменами + TLS-сертификатами от Let's Encrypt

Оркестратор **не имеет своей базы** — источник правды для броней остаётся за каждым инстансом.

---

## Контракт совместимости

Совместим с инстансами, объявляющими `protocolVersion: "1.0"` в `/api/manifest`. Список поддерживаемых версий — в [`lib/schema.js`](lib/schema.js).

Если инстанс отдаёт неподдерживаемую версию — он помечается статусом `incompatible` и в агрегацию не включается.

---

## Структура

```
wishlist-orchestrator/
├── server.js                    # Express, API оркестратора
├── lib/
│   ├── schema.js                # SUPPORTED_PROTOCOL_VERSIONS
│   ├── instance.js              # Клиент одного wishlist-инстанса
│   ├── registry.js              # Реестр инстансов + periodic refresh
│   └── caddy.js                 # Генератор Caddyfile + push в admin API
├── public/
│   ├── index.html               # Дебаг-UI: статус инстансов и сырой /api/aggregate
│   └── theme.css                # Палитра
├── config/
│   ├── instances.json           # Список инстансов (не в git)
│   └── instances.json.example
├── proxy/                       # Встроенный reverse-proxy
│   ├── Caddyfile                # Бутстрап-конфиг
│   ├── data/                    # Сертификаты LE — БЭКАПИТЬ!
│   └── config/
├── data/                        # Зарезервировано под будущий state
├── Dockerfile
├── docker-compose.yml           # Поднимает orchestrator + caddy + создаёт сеть wishnet
├── .env.example
└── README.md
```

---

## Быстрый старт

**Шаг 1. Поднять оркестратор + Caddy (создаст docker-сеть `wishnet`):**

```bash
git clone <repo-url> wishlist-orchestrator
cd wishlist-orchestrator

cp .env.example .env
cp config/instances.json.example config/instances.json
# Отредактировать .env и config/instances.json

docker compose up -d
```

Готово. UI оркестратора — `http://localhost:3060`, Caddy слушает 80/443.

**Шаг 2. Поднять вишлисты:**

```bash
cd ../wishlist
cp .env.example .env
docker compose up -d
```

Вишлист сам подключится к существующей сети `wishnet` (она уже создана оркестратором на шаге 1).

> Если хотите поднять вишлист до оркестратора — создайте сеть руками: `docker network create wishnet`.

---

## Конфигурация

### `.env`

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт внутри контейнера |
| `REFRESH_INTERVAL_SEC` | `120` | Интервал опроса инстансов |
| `REQUEST_TIMEOUT_MS` | `10000` | Таймаут одного запроса к инстансу |
| `NODE_ENV` | `production` | Режим запуска |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Admin API внутри docker-сети |
| `CADDY_ACME_EMAIL` | — | Email для Let's Encrypt уведомлений |
| `ADMIN_TOKEN` | — | Токен для `/admin` UI. Если пусто — админка выключена |

### `config/instances.json`

```json
{
  "self": {
    "host":     "wishlist.kojikk.ru",
    "upstream": "http://wishlist-orchestrator:3000"
  },
  "instances": [
    {
      "id":    "kojikk",
      "label": "Мой вишлист",
      "url":   "http://tg-wishlist:3000",
      "host":  "kojikk.wishlist.kojikk.ru"
    }
  ]
}
```

**Инстанс:**
- `id` — уникальный идентификатор (используется в URL: `/api/instances/:id/book`)
- `label` — человекочитаемое имя
- `url` — внутренний URL для оркестратора (обычно `http://<container>:<port>` в docker-сети)
- `host` *(опционально)* — публичный hostname. Если задан, оркестратор автоматически
  сгенерирует запись в Caddy для проксирования `https://<host>/` → `url`

**`self`** *(опционально)* — то же самое, но для самого оркестратора. Если задан,
Caddy получит запись для UI оркестратора.

Файл монтируется как volume и hot-reload'ится при изменении.

### Admin UI (`/admin`)

Альтернатива ручному редактированию JSON — встроенный UI для CRUD над инстансами.

1. Сгенерировать токен и положить в `.env`:
   ```bash
   echo "ADMIN_TOKEN=$(openssl rand -hex 32)" >> .env
   docker compose up -d
   ```
2. Открыть `http://localhost:3060/admin`, ввести токен.
3. Редактировать `self` и список инстансов через форму. После «Сохранить»:
   - атомарно перезаписывается `config/instances.json`
   - registry перечитывает инстансы
   - Caddyfile пересобирается и пушится в Caddy

Если `ADMIN_TOKEN` не задан — `/admin` отдаёт страницу «админка отключена».

---

## Reverse-proxy и поддомены

Caddy запускается как сервис внутри docker-compose.yml оркестратора. Когда в
`instances.json` есть поле `host`, оркестратор:

1. Собирает Caddyfile из всех инстансов с непустым `host`
2. Пушит в Caddy admin API (`POST http://caddy:2019/load`)
3. Caddy hot-reload'ит конфиг и получает Let's Encrypt сертификаты

**Что нужно один раз настроить:**

1. Wildcard A-запись в Cloudflare:
   ```
   Type: A   Name: *.wishlist   Content: <server-IP>   Proxy: DNS only (gray)
   ```
   Gray cloud — обязательно, потому что бесплатный Universal SSL Cloudflare не
   покрывает двухуровневые wildcard (`*.wishlist.kojikk.ru`).

2. Открыть порты 80 и 443 на сервере.

После старта оркестратор увидит Caddy по адресу `http://caddy:2019` (внутри
wishnet) и запушит конфиг. Через ~5-10 секунд Caddy получит сертификаты от LE
и поддомены станут доступны.

**Ручной триггер пересборки** (на случай если что-то рассинхронилось):
```bash
curl -X POST http://localhost:3060/api/caddy/sync
```

**Отладка:**
```bash
# что сейчас в Caddy
docker exec caddy curl -s localhost:2019/config/ | jq .

# логи Caddy
docker logs -f caddy

# логи оркестратора
docker logs -f wishlist-orchestrator | grep caddy
```

**Бэкап сертификатов:** `proxy/data/` содержит LE-сертификаты. Их потеря = повторное получение с учётом rate-limit Let's Encrypt.

---

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/instances` | Список инстансов со статусом каждого |
| GET | `/api/aggregate` | Объединённые категории + брони всех `ok`-инстансов |
| POST | `/api/instances/:id/book` | Прокси к `POST /api/book` инстанса (тело: `{ itemId, user }`) |
| POST | `/api/instances/:id/unbook` | Прокси к `POST /api/unbook` |
| POST | `/api/instances/:id/refresh` | Принудительный рефреш |
| POST | `/api/caddy/sync` | Ручная пересборка Caddyfile |
| GET | `/api/admin/config` | Текущий `instances.json` (требует `Authorization: Bearer $ADMIN_TOKEN`) |
| PUT | `/api/admin/config` | Полная замена `instances.json` (с валидацией) |

### Формат `/api/aggregate`

```jsonc
{
  "categories": [
    {
      "id": "main:electronics",      // префикс instanceId, чтобы избежать коллизий
      "instanceId": "main",
      "instanceLabel": "Мой вишлист",
      "title": "Электроника",
      "items": [
        {
          "id": "item_1234",
          "instanceId": "main",
          "name": "...",
          "links": [...]
        }
      ]
    }
  ],
  "bookings": {
    "main:item_1234": { "id": "...", "username": "...", "instanceId": "main" }
  }
}
```

Клиент должен использовать поле `instanceId` каждого item'а, чтобы отправлять `book`/`unbook` в правильный эндпоинт.

---

## Дальше

- [ ] Полноценный агрегированный UI вместо дебаг-страницы
- [ ] Подключение к `/api/reload-stream` инстансов для live-обновлений (вместо poll)
- [ ] Telegram WebApp интеграция (как у wishlist-app)
- [ ] Авторизация / приватные инстансы (per-instance secret в `instances.json`)
- [ ] Метрики и алерты на падение инстансов
