'use strict';

require('dotenv').config();
const express = require('express');
const path    = require('path');
const Registry = require('./lib/registry');

const PORT       = Number(process.env.PORT) || 3000;
const REFRESH_MS = (Number(process.env.REFRESH_INTERVAL_SEC) || 120) * 1000;
const CONFIG_DIR = path.join(__dirname, 'config');
const PUBLIC_DIR = path.join(__dirname, 'public');

const registry = new Registry({
  configPath:        path.join(CONFIG_DIR, 'instances.json'),
  refreshIntervalMs: REFRESH_MS,
});

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

/** Ручной триггер рефреша конкретного инстанса. */
app.post('/api/instances/:id/refresh', async (req, res) => {
  const client = registry.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Instance not found' });
  await client.refresh();
  res.json(client.toPublic());
});

// ─── Start ──────────────────────────────────────────────────────────────────

registry.start();

app.listen(PORT, () => {
  console.log(`Wishlist orchestrator running on :${PORT}`);
  console.log(`Refresh interval: ${REFRESH_MS / 1000}s`);
});
