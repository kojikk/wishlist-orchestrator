# Wishlist Orchestrator

Оркестратор для нескольких инстансов [wishlist-app](https://github.com/kojikk/wishlist). Основная задача — **раздача поддоменов контейнеризированным вишлистам**: опрашивает каждый инстанс по стабильному контракту (Wishlist Protocol), показывает витрину со ссылками на все вишлисты, автоматически генерирует конфиг Caddy с TLS, а через админку умеет управлять контейнерами вишлистов вплоть до провижининга новых.

---

## Что это

У вас несколько вишлистов на разных поддоменах (свой, девушки, друзей). У каждого — свой контейнер в docker-сети `wishnet`. Оркестратор:

1. Знает список инстансов из `config/instances.json`
2. У каждого вызывает `GET /api/manifest` — проверяет совместимость Wishlist Protocol
3. Периодически тянет `/api/config` и `/api/bookings`; имя вишлиста берёт из его собственного конфига (`app.title`)
4. Показывает витрину со ссылками на публичные домены вишлистов (`/`)
5. Отдаёт объединённый снимок через `GET /api/aggregate` и проксирует бронирования
6. Генерирует Caddyfile из `instances.json` и пушит в Caddy admin API — поддомены с Let's Encrypt раздаются автоматически
7. Через админку (`/admin`) управляет контейнерами вишлистов: start/stop/restart, логи, обновление образа, **создание нового вишлиста в один клик**

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
│   ├── caddy.js                 # Генератор Caddyfile + push в admin API
│   └── docker.js                # Docker Engine API через docker.sock
├── public/
│   ├── index.html               # Витрина: карточки вишлистов
│   ├── admin.html               # Админка: инстансы/Caddy/контейнеры/провижининг
│   ├── theme.css                # Общая тема (aurora dark)
│   └── vendor/gsap.min.js       # GSAP (вендорим — CDN в РФ ненадёжны)
├── config/
│   ├── instances.json           # Список инстансов (не в git)
│   └── instances.json.example
├── data/                        # Зарезервировано под будущий state
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

> Код **запекается в образ** (volume только `./config` и `./data`) — после правки `lib/*.js` или `public/*` нужен `docker compose up -d --build`.

---

## Быстрый старт

```bash
git clone <repo-url> wishlist-orchestrator
cd wishlist-orchestrator

cp .env.example .env
cp config/instances.json.example config/instances.json
# Отредактировать .env и config/instances.json

docker compose up -d --build
```

UI — `http://localhost:3060`, админка — `http://localhost:3060/admin`.

Вишлисты подключаются к созданной оркестратором сети `wishnet` (в их compose: `networks: wishnet: external: true`).

---

## Конфигурация

### `.env`

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт внутри контейнера |
| `REFRESH_INTERVAL_SEC` | `120` | Интервал опроса инстансов |
| `REQUEST_TIMEOUT_MS` | `10000` | Таймаут одного запроса к инстансу |
| `NODE_ENV` | `production` | Режим запуска |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Admin API Caddy внутри docker-сети |
| `CADDY_ACME_EMAIL` | — | Email для Let's Encrypt. Пусто → `auto_https off` (режим за CDN) |
| `ADMIN_TOKEN` | — | Токен админки. Если пусто — админка выключена |
| `PUBLIC_HTTPS_PORT` | `443` | Внешний HTTPS-порт вишлистов (у нас 8443: хостовый 443 занят) |
| `PUBLIC_IP` | — | Внешний IP сервера — для DNS-проверки поддоменов |
| `WISHLIST_NETWORK` | `wishnet` | Docker-сеть вишлистов |
| `PROTECTED_CONTAINERS` | `caddy,wishlist-orchestrator` | Контейнеры, недоступные для управления из админки |

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
      "host":  "kojikk-wishlist.kojikk.ru"
    }
  ]
}
```

- `id` — уникальный идентификатор (используется в URL: `/api/instances/:id/book`)
- `label` — fallback-имя; на витрине показывается `app.title` из конфига самого инстанса
- `url` — внутренний URL в docker-сети
- `host` *(опционально)* — публичный hostname; если задан, Caddy получит маршрут `https://<host>` → `url`
- `self` *(опционально)* — то же для самого оркестратора

Файл монтируется как volume и hot-reload'ится при изменении.

---

## Админка (`/admin`)

Токен вводится один раз и хранится в localStorage браузера (как у самих вишлистов). Вкладки:

- **Обзор** — health-дашборд: статус, latency, количество подарков, ошибки; ручной опрос инстанса
- **Инстансы** — редактор `instances.json`: на каждую строку кнопки «проверить URL» (manifest-handshake: версия протокола, имя, количество подарков) и «DNS» (сверка A-записи хоста с `PUBLIC_IP`)
- **Caddy** — предпросмотр сгенерированного Caddyfile, результат последнего пуша, ручной синк
- **Контейнеры** — все контейнеры сети `wishnet`: start/stop/restart, логи, удаление, «обновить образ» (pull + watchtower-style recreate с сохранением env/volumes/сетей)
- **+ Новый вишлист** — провижининг: id, домен, образ → оркестратор создаёт контейнер `wl-<id>` (named volumes, `wishnet`, без публикации портов), регистрирует в `instances.json`, Caddy получает маршрут автоматически. Админ-токен нового вишлиста генерируется и показывается один раз

Для Docker-функций в контейнер монтируется `/var/run/docker.sock`. Защита: мутации разрешены только контейнерам сети `wishnet`, `PROTECTED_CONTAINERS` недоступны.

После провижининга остаются два ручных шага: A-запись DNS на IP сервера (grey cloud!) и URL мини-аппы у BotFather.

---

## Reverse-proxy и поддомены

Caddy живёт отдельным стеком (`~/ingress`), подключён к сетям `ingress` и `wishnet`. Оркестратор пушит ему конфиг по admin API при каждом изменении `instances.json`.

Режимы (по `CADDY_ACME_EMAIL`):
- **Задан** → Caddy сам терминирует TLS через Let's Encrypt (наш случай: прямой TLS на `:8443`, без Cloudflare — CF троттлится на росс. сетевом пути)
- **Пуст** → `auto_https off`, блоки на `:80` (режим «за CDN», который терминирует TLS снаружи)

HTTP/3 отключён намеренно (`servers { protocols h1 h2 }`): наружу проброшен только TCP 8443, UDP/443 недоступен — h3 ломал мобильный Telegram-webview.

**Отладка:**
```bash
docker exec caddy curl -s localhost:2019/config/ | jq .   # текущий конфиг Caddy
docker logs -f caddy                                      # логи Caddy
docker logs -f wishlist-orchestrator | grep caddy          # логи синка
```

---

## API

### Публичное

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/instances` | Список инстансов со статусом, `title` и `publicUrl` |
| GET | `/api/aggregate` | Объединённые категории + брони всех `ok`-инстансов |
| POST | `/api/instances/:id/book` | Прокси к `POST /api/book` инстанса (тело: `{ itemId, user }`) |
| POST | `/api/instances/:id/unbook` | Прокси к `POST /api/unbook` |

### Админское (`Authorization: Bearer $ADMIN_TOKEN`)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/admin/ping` | Проверка токена |
| GET / PUT | `/api/admin/config` | Чтение / полная замена `instances.json` (с валидацией) |
| POST | `/api/admin/instances/:id/refresh` | Принудительный опрос инстанса |
| POST | `/api/admin/validate` | Handshake-проверка URL кандидата (`{ url }`) |
| GET | `/api/admin/dns-check?host=` | Сверка A-записи с `PUBLIC_IP` |
| GET | `/api/admin/caddy` | Предпросмотр Caddyfile + результат последнего синка |
| POST | `/api/admin/caddy/sync` | Ручная пересборка и пуш Caddyfile |
| GET | `/api/admin/docker/containers` | Контейнеры сети вишлистов |
| GET | `/api/admin/docker/images` | Локальные образы |
| POST | `/api/admin/docker/:name/start\|stop\|restart` | Lifecycle |
| GET | `/api/admin/docker/:name/logs?tail=` | Логи контейнера |
| POST | `/api/admin/docker/:name/update` | Pull + recreate на свежем образе |
| DELETE | `/api/admin/docker/:name` | Удаление контейнера (volumes остаются) |
| POST | `/api/admin/provision` | Создание нового вишлиста (`{ id, image, host?, label?, extraEnv? }`) |

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
        { "id": "item_1234", "instanceId": "main", "name": "...", "links": [...] }
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

- [ ] Подключение к `/api/reload-stream` инстансов для live-обновлений (вместо poll)
- [ ] История доступности инстансов (uptime-бар в обзоре)
- [ ] Бэкапы config/bookings инстансов по расписанию
- [ ] Режим обслуживания: заглушка в Caddy вместо 502 для остановленного инстанса
- [ ] Авторизация / приватные инстансы (per-instance secret в `instances.json`)
