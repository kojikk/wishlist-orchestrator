# Wishlist Orchestrator

Агрегатор для нескольких инстансов [wishlist-app](https://github.com/kojikk/wishlist). Опрашивает каждый инстанс по стабильному контракту (Wishlist Protocol), объединяет категории и брони в один представление и проксирует операции бронирования к нужному инстансу.

> **Статус:** ранний MVP. UI — заглушка с дебаг-выводом; полноценный агрегированный фронтенд появится дальше.

---

## Что это

У вас несколько вишлистов на разных доменах (личный, семейный, рабочий). У каждого — свой backend по адресу `wishlist-N.example.com`. Оркестратор:

1. Знает список инстансов из `config/instances.json`
2. У каждого вызывает `GET /api/manifest` — проверяет, что версия Wishlist Protocol совместима
3. Периодически тянет `/api/config` и `/api/bookings`
4. Отдаёт объединённый снимок через `GET /api/aggregate`
5. Проксирует операции бронирования: `POST /api/instances/:id/book` → `POST /api/book` нужного инстанса

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
│   └── registry.js              # Реестр инстансов + periodic refresh
├── public/
│   ├── index.html               # Дебаг-UI: статус инстансов и сырой /api/aggregate
│   └── theme.css                # Палитра
├── config/
│   ├── instances.json           # Список инстансов (не в git)
│   └── instances.json.example
├── data/                        # Зарезервировано под будущий state
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Быстрый старт (Docker)

```bash
git clone <repo-url> wishlist-orchestrator
cd wishlist-orchestrator

cp .env.example .env
cp config/instances.json.example config/instances.json

# Отредактировать config/instances.json — добавить свои инстансы

docker compose up -d
```

Доступно на `http://localhost:3060`.

### Локально (без Docker)

Требуется Node 18+ (нужен встроенный `fetch`).

```bash
npm install
cp .env.example .env
cp config/instances.json.example config/instances.json
npm run dev
```

Доступно на `http://localhost:3000`.

---

## Конфигурация

### `.env`

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт внутри контейнера |
| `REFRESH_INTERVAL_SEC` | `120` | Интервал опроса инстансов |
| `REQUEST_TIMEOUT_MS` | `10000` | Таймаут одного запроса к инстансу |
| `NODE_ENV` | `production` | Режим запуска |

### `config/instances.json`

```json
{
  "instances": [
    {
      "id":    "main",
      "label": "Мой вишлист",
      "url":   "http://localhost:3050"
    }
  ]
}
```

- `id` — уникальный идентификатор (используется в URL: `/api/instances/:id/book`)
- `label` — человекочитаемое имя
- `url` — базовый URL инстанса (без `/api`)

Файл монтируется как volume и hot-reload'ится при изменении.

---

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/instances` | Список инстансов со статусом каждого |
| GET | `/api/aggregate` | Объединённые категории + брони всех `ok`-инстансов |
| POST | `/api/instances/:id/book` | Прокси к `POST /api/book` инстанса (тело: `{ itemId, user }`) |
| POST | `/api/instances/:id/unbook` | Прокси к `POST /api/unbook` |
| POST | `/api/instances/:id/refresh` | Принудительный рефреш |

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
