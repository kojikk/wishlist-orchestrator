'use strict';

require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const Registry = require('./lib/registry');
const { syncCaddy } = require('./lib/caddy');

const PORT        = Number(process.env.PORT) || 3000;
const REFRESH_MS  = (Number(process.env.REFRESH_INTERVAL_SEC) || 120) * 1000;
const CONFIG_DIR  = path.join(__dirname, 'config');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(CONFIG_DIR, 'instances.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

const registry = new Registry({
  configPath:        CONFIG_PATH,
  refreshIntervalMs: REFRESH_MS,
});

// Каждый раз, когда reg перечитал instances.json — пушим новый Caddyfile.
registry.onConfigChange = (reg) => { syncCaddy(reg).catch(() => {}); };

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, p) { if (p.endsWith('.html')) res.set('Cache-Control', 'no-store'); }
}));

// ─── API ────────────────────────────────────────────────────────────────────

/** Список зарегистрированных инстансов с их статусом. */
app.get('/api/instances', (req, res) => {
  res.json({
    instances: registry.all().map(c => c.toPublic()),
  });
});

/**
 * Агрегированный снимок: все категории всех инстансов + объединённые брони.
 * Каждая категория и каждый item помечается `instanceId`, чтобы клиент знал,
 * куда отправлять book/unbook.
 */
app.get('/api/aggregate', (req, res) => {
  const categories = [];
  const bookings = {};
  for (const c of registry.all()) {
    if (c.status !== 'ok') continue;
    for (const cat of c.config?.wishlist || []) {
      categories.push({
        ...cat,
        id:         `${c.id}:${cat.id}`,
        instanceId: c.id,
        instanceLabel: c.label,
        items: (cat.items || []).map(it => ({
          ...it,
          instanceId: c.id,
          // Item.id оставляем как есть — он уникален в пределах инстанса;
          // глобальная уникальность обеспечивается парой (instanceId, id)
        })),
      });
    }
    for (const [itemId, bk] of Object.entries(c.bookings || {})) {
      bookings[`${c.id}:${itemId}`] = { ...bk, instanceId: c.id };
    }
  }
  res.json({ categories, bookings });
});

/** Прокси-бронирование: оркестратор делегирует POST /api/book нужному инстансу. */
app.post('/api/instances/:id/book', async (req, res) => {
  const client = registry.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Instance not found' });
  const { itemId, user } = req.body;
  if (!itemId || !user?.id) return res.status(400).json({ error: 'itemId and user required' });
  try {
    const out = await client.book(itemId, user);
    // Принудительный рефреш броней этого инстанса, чтобы /api/aggregate отдавал свежее
    client.refresh().catch(() => {});
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, instanceBody: e.body || null });
  }
});

app.post('/api/instances/:id/unbook', async (req, res) => {
  const client = registry.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Instance not found' });
  const { itemId, user } = req.body;
  if (!itemId || !user?.id) return res.status(400).json({ error: 'itemId and user required' });
  try {
    const out = await client.unbook(itemId, user);
    client.refresh().catch(() => {});
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, instanceBody: e.body || null });
  }
});

/** Ручной триггер пересборки и пуша Caddyfile. */
app.post('/api/caddy/sync', async (req, res) => {
  await syncCaddy(registry);
  res.json({ ok: true });
});

/** Ручной триггер рефреша конкретного инстанса. */
app.post('/api/instances/:id/refresh', async (req, res) => {
  const client = registry.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Instance not found' });
  await client.refresh();
  res.json(client.toPublic());
});

// ─── Admin API ──────────────────────────────────────────────────────────────
// Защищены ADMIN_TOKEN (Bearer). Если ADMIN_TOKEN не задан в .env — endpoints
// отдают 503: админка осознанно выключена, чтобы случайно не запустить
// оркестратор с открытым редактированием конфига.

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_TOKEN не задан в .env — админка выключена' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/** Проверка наличия токена и его валидности (для UI: показать форму логина или нет). */
app.get('/api/admin/ping', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'disabled' });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ ok: true });
});

/** Текущий instances.json целиком. */
app.get('/api/admin/config', requireAdmin, (req, res) => {
  try {
    const raw = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
    const cfg = raw ? JSON.parse(raw) : { self: null, instances: [] };
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: 'failed to read config: ' + e.message });
  }
});

/**
 * Полная замена instances.json. Тело — объект вида { self?, instances }.
 * Валидируем минимально, чтобы не положить registry: id+url у каждого инстанса.
 * Запись атомарная (tmp + rename), чтобы fs.watch не словил пустой файл.
 */
app.put('/api/admin/config', requireAdmin, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'body must be an object' });
  }
  const instances = Array.isArray(body.instances) ? body.instances : [];
  // Базовая валидация
  const ids = new Set();
  for (const inst of instances) {
    if (!inst || typeof inst !== 'object') return res.status(400).json({ error: 'каждый инстанс должен быть объектом' });
    if (!inst.id || typeof inst.id !== 'string') return res.status(400).json({ error: 'у каждого инстанса должен быть строковый id' });
    if (!/^[a-z0-9_-]+$/i.test(inst.id))         return res.status(400).json({ error: `некорректный id: ${inst.id} (разрешены a-z0-9_-)` });
    if (ids.has(inst.id))                        return res.status(400).json({ error: `дублирующийся id: ${inst.id}` });
    ids.add(inst.id);
    if (!inst.url || typeof inst.url !== 'string') return res.status(400).json({ error: `у инстанса ${inst.id} должен быть url` });
    try { new URL(inst.url); } catch { return res.status(400).json({ error: `у инстанса ${inst.id} невалидный url: ${inst.url}` }); }
  }
  // Self — опционально
  const self = body.self && typeof body.self === 'object' ? body.self : null;
  if (self && self.upstream) {
    try { new URL(self.upstream); } catch { return res.status(400).json({ error: `self.upstream — невалидный url` }); }
  }

  const clean = {
    self: self ? { host: self.host || '', upstream: self.upstream || '' } : null,
    instances: instances.map(i => ({
      id:    i.id,
      label: i.label || i.id,
      url:   i.url.replace(/\/$/, ''),
      ...(i.host ? { host: i.host } : {}),
    })),
  };

  try {
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
    // registry.loadConfig сработает через fs.watch, но дёргаем явно для скорости отклика
    registry.loadConfig();
    registry.refreshAll().catch(() => {});
    res.json(clean);
  } catch (e) {
    res.status(500).json({ error: 'failed to write config: ' + e.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

registry.start();

app.listen(PORT, () => {
  console.log(`Wishlist orchestrator running on :${PORT}`);
  console.log(`Refresh interval: ${REFRESH_MS / 1000}s`);
});
