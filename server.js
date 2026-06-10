'use strict';

require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const dns     = require('dns').promises;
const Registry = require('./lib/registry');
const InstanceClient = require('./lib/instance');
const { syncCaddy, buildCaddyfile, getLastSync } = require('./lib/caddy');
const docker = require('./lib/docker');

const PORT        = Number(process.env.PORT) || 3000;
const REFRESH_MS  = (Number(process.env.REFRESH_INTERVAL_SEC) || 120) * 1000;
const CONFIG_DIR  = path.join(__dirname, 'config');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(CONFIG_DIR, 'instances.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
/** Внешний IP сервера — для DNS-проверки поддоменов в админке. */
const PUBLIC_IP   = process.env.PUBLIC_IP || null;
/** Docker-сеть, в которой живут вишлисты (и создаются новые). */
const WISHNET     = process.env.WISHLIST_NETWORK || 'wishnet';
/** Контейнеры, которые админка не имеет права останавливать/удалять. */
const PROTECTED_CONTAINERS = (process.env.PROTECTED_CONTAINERS || 'caddy,wishlist-orchestrator')
  .split(',').map(s => s.trim()).filter(Boolean);

const registry = new Registry({
  configPath:        CONFIG_PATH,
  refreshIntervalMs: REFRESH_MS,
});

// Каждый раз, когда reg перечитал instances.json — пушим новый Caddyfile.
registry.onConfigChange = (reg) => { syncCaddy(reg).catch(() => {}); };

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, p) { if (p.endsWith('.html')) res.set('Cache-Control', 'no-store'); }
}));

// ─── Public API ─────────────────────────────────────────────────────────────

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

/** Ручной триггер рефреша конкретного инстанса. */
app.post('/api/admin/instances/:id/refresh', requireAdmin, async (req, res) => {
  const client = registry.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Instance not found' });
  await client.refresh();
  res.json(client.toPublic());
});

// ── instances.json ──────────────────────────────────────────────────────────

function readInstancesConfig() {
  const raw = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  return raw ? JSON.parse(raw) : { self: null, instances: [] };
}

/** Атомарная запись (tmp + rename), чтобы fs.watch не словил пустой файл. */
function writeInstancesConfig(clean) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  // registry.loadConfig сработает через fs.watch, но дёргаем явно для скорости отклика
  registry.loadConfig();
  registry.refreshAll().catch(() => {});
}

/**
 * Валидация тела { self?, instances } → нормализованный объект или throw.
 */
function validateInstancesBody(body) {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const instances = Array.isArray(body.instances) ? body.instances : [];
  const ids = new Set();
  for (const inst of instances) {
    if (!inst || typeof inst !== 'object') throw new Error('каждый инстанс должен быть объектом');
    if (!inst.id || typeof inst.id !== 'string') throw new Error('у каждого инстанса должен быть строковый id');
    if (!/^[a-z0-9_-]+$/i.test(inst.id))         throw new Error(`некорректный id: ${inst.id} (разрешены a-z0-9_-)`);
    if (ids.has(inst.id))                        throw new Error(`дублирующийся id: ${inst.id}`);
    ids.add(inst.id);
    if (!inst.url || typeof inst.url !== 'string') throw new Error(`у инстанса ${inst.id} должен быть url`);
    try { new URL(inst.url); } catch { throw new Error(`у инстанса ${inst.id} невалидный url: ${inst.url}`); }
  }
  const self = body.self && typeof body.self === 'object' ? body.self : null;
  if (self && self.upstream) {
    try { new URL(self.upstream); } catch { throw new Error('self.upstream — невалидный url'); }
  }
  return {
    self: self ? { host: self.host || '', upstream: self.upstream || '' } : null,
    instances: instances.map(i => ({
      id:    i.id,
      label: i.label || i.id,
      url:   i.url.replace(/\/$/, ''),
      ...(i.host ? { host: i.host } : {}),
    })),
  };
}

/** Текущий instances.json целиком. */
app.get('/api/admin/config', requireAdmin, (req, res) => {
  try {
    res.json(readInstancesConfig());
  } catch (e) {
    res.status(500).json({ error: 'failed to read config: ' + e.message });
  }
});

/** Полная замена instances.json. Тело — объект вида { self?, instances }. */
app.put('/api/admin/config', requireAdmin, (req, res) => {
  let clean;
  try { clean = validateInstancesBody(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    writeInstancesConfig(clean);
    res.json(clean);
  } catch (e) {
    res.status(500).json({ error: 'failed to write config: ' + e.message });
  }
});

// ── Валидация инстанса и DNS ────────────────────────────────────────────────

/**
 * Проверка URL кандидата перед добавлением: handshake + config.
 * Возвращает manifest-инфо, имя из конфига, количество подарков.
 */
app.post('/api/admin/validate', requireAdmin, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'невалидный url' }); }
  const probe = new InstanceClient({ id: '_probe', url });
  await probe.refresh();
  res.json({
    ok: probe.status === 'ok',
    status: probe.status,
    error: probe.lastError,
    protocolVersion: probe.manifest?.protocolVersion || null,
    appName: probe.manifest?.name || null,
    title: probe.config?.app?.title || null,
    itemCount: probe.status === 'ok' ? probe.toPublic().itemCount : null,
    latencyMs: probe.lastLatencyMs,
  });
});

/**
 * DNS-проверка поддомена: резолвим A-записи и сравниваем с PUBLIC_IP.
 * Ловит «забыл создать запись в DNS» до того, как Caddy упрётся в ACME.
 */
app.get('/api/admin/dns-check', requireAdmin, async (req, res) => {
  const host = String(req.query.host || '').trim();
  if (!host) return res.status(400).json({ error: 'host required' });
  try {
    const addrs = await dns.resolve4(host);
    const match = PUBLIC_IP ? addrs.includes(PUBLIC_IP) : null;
    res.json({ ok: match !== false, resolved: addrs, expected: PUBLIC_IP, match });
  } catch (e) {
    res.json({ ok: false, resolved: [], expected: PUBLIC_IP, match: false, error: e.code || e.message });
  }
});

// ── Caddy ───────────────────────────────────────────────────────────────────

/** Предпросмотр сгенерированного Caddyfile + результат последнего пуша. */
app.get('/api/admin/caddy', requireAdmin, (req, res) => {
  res.json({
    caddyfile: buildCaddyfile(registry),
    lastSync:  getLastSync(),
  });
});

/** Ручной триггер пересборки и пуша Caddyfile. */
app.post('/api/admin/caddy/sync', requireAdmin, async (req, res) => {
  const result = await syncCaddy(registry);
  res.json(result || { ok: false });
});

// ── Docker: lifecycle, логи, обновления, провижининг ────────────────────────

function requireDocker(req, res, next) {
  if (!docker.available()) {
    return res.status(503).json({ error: 'docker.sock не смонтирован — Docker-функции выключены' });
  }
  next();
}

/**
 * Разрешаем мутации только над контейнерами из сети вишлистов и не из
 * PROTECTED_CONTAINERS — чтобы из админки нельзя было уронить caddy,
 * сам оркестратор или вообще посторонний контейнер на хосте.
 */
async function assertManaged(name) {
  if (PROTECTED_CONTAINERS.includes(name)) {
    const err = new Error(`Контейнер ${name} защищён от управления из админки`);
    err.status = 403;
    throw err;
  }
  const info = await docker.inspect(name);
  const nets = Object.keys(info.NetworkSettings?.Networks || {});
  const managedLabel = info.Config?.Labels?.['wishlist.managed'] === 'true';
  if (!nets.includes(WISHNET) && !managedLabel) {
    const err = new Error(`Контейнер ${name} не относится к сети ${WISHNET}`);
    err.status = 403;
    throw err;
  }
  return info;
}

const dockerErr = (res, e) => res.status(e.status || 502).json({ error: e.message });

/** Контейнеры сети вишлистов (+ управляемые по label). */
app.get('/api/admin/docker/containers', requireAdmin, requireDocker, async (req, res) => {
  try {
    const list = await docker.listContainers();
    const out = list
      .filter(c => Object.keys(c.NetworkSettings?.Networks || {}).includes(WISHNET)
                || c.Labels?.['wishlist.managed'] === 'true')
      .map(c => {
        const name = (c.Names?.[0] || '').replace(/^\//, '');
        return {
          name,
          image:  c.Image,
          state:  c.State,            // running | exited | ...
          status: c.Status,           // "Up 2 days"
          created: c.Created,
          labels: c.Labels || {},
          protected: PROTECTED_CONTAINERS.includes(name),
          // какой инстанс registry смотрит в этот контейнер (по hostname в url)
          instanceId: registry.all().find(i => {
            try { return new URL(i.url).hostname === name; } catch { return false; }
          })?.id || null,
        };
      });
    res.json({ containers: out });
  } catch (e) { dockerErr(res, e); }
});

/** Локальные образы (для провижининга). */
app.get('/api/admin/docker/images', requireAdmin, requireDocker, async (req, res) => {
  try {
    const list = await docker.listImages();
    res.json({
      images: list
        .flatMap(i => (i.RepoTags || []).filter(t => t !== '<none>:<none>'))
        .sort(),
    });
  } catch (e) { dockerErr(res, e); }
});

for (const action of ['start', 'stop', 'restart']) {
  app.post(`/api/admin/docker/:name/${action}`, requireAdmin, requireDocker, async (req, res) => {
    try {
      await assertManaged(req.params.name);
      await docker[action](req.params.name);
      res.json({ ok: true, action });
    } catch (e) { dockerErr(res, e); }
  });
}

app.get('/api/admin/docker/:name/logs', requireAdmin, requireDocker, async (req, res) => {
  try {
    await assertManaged(req.params.name);
    const text = await docker.logs(req.params.name, req.query.tail || 200);
    res.json({ logs: text });
  } catch (e) { dockerErr(res, e); }
});

/**
 * Обновление: pull свежего образа по тому же тегу, при изменении image id —
 * пересоздание контейнера с тем же spec (env/volumes/ports/networks).
 * Для локально собранных образов pull тихо фейлится — тогда сначала пересобери
 * образ на хосте (docker compose build), потом жми «обновить».
 */
app.post('/api/admin/docker/:name/update', requireAdmin, requireDocker, async (req, res) => {
  try {
    await assertManaged(req.params.name);
    const result = await docker.update(req.params.name);
    res.json(result);
  } catch (e) { dockerErr(res, e); }
});

/** Удаление контейнера (volumes остаются). */
app.delete('/api/admin/docker/:name', requireAdmin, requireDocker, async (req, res) => {
  try {
    await assertManaged(req.params.name);
    await docker.remove(req.params.name, true);
    res.json({ ok: true });
  } catch (e) { dockerErr(res, e); }
});

/**
 * Провижининг нового вишлиста: контейнер wl-<id> из выбранного образа,
 * named volumes для data/config, сеть вишлистов, запись в instances.json
 * (что автоматически тянет за собой Caddy-синк). Порт наружу не публикуется —
 * трафик ходит через Caddy по docker-сети.
 *
 * Тело: { id, image, host?, label?, adminToken?, extraEnv? }
 * Ответ содержит adminToken — отдай его владельцу нового вишлиста.
 */
app.post('/api/admin/provision', requireAdmin, requireDocker, async (req, res) => {
  const { id, image, host, label, adminToken, extraEnv } = req.body || {};
  if (!id || !/^[a-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'id обязателен (строчные a-z0-9_-)' });
  }
  if (!image) return res.status(400).json({ error: 'image обязателен' });
  if (registry.get(id)) return res.status(409).json({ error: `Инстанс ${id} уже существует` });
  const cname = `wl-${id}`;

  try {
    await docker.inspectImage(image);
  } catch {
    return res.status(400).json({ error: `Образ ${image} не найден локально` });
  }
  const exists = await docker.inspect(cname).then(() => true).catch(() => false);
  if (exists) return res.status(409).json({ error: `Контейнер ${cname} уже существует` });

  const token = adminToken || crypto.randomBytes(32).toString('hex');
  const env = {
    PORT: '3000',
    NODE_ENV: 'production',
    DB_PATH: '/app/data/wishlist.db',
    ADMIN_TOKEN: token,
    ...(typeof extraEnv === 'object' && extraEnv ? extraEnv : {}),
  };

  try {
    await docker.create(cname, {
      Image: image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'wishlist.managed': 'true', 'wishlist.instance-id': id },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Mounts: [
          { Type: 'volume', Source: `wl-${id}-data`,   Target: '/app/data' },
          { Type: 'volume', Source: `wl-${id}-config`, Target: '/app/config' },
        ],
      },
      NetworkingConfig: { EndpointsConfig: { [WISHNET]: {} } },
    });
    await docker.start(cname);

    // Регистрируем в instances.json → registry reload → Caddy sync
    const cfg = readInstancesConfig();
    cfg.instances = cfg.instances || [];
    cfg.instances.push({
      id,
      label: label || id,
      url: `http://${cname}:3000`,
      ...(host ? { host } : {}),
    });
    writeInstancesConfig(validateInstancesBody(cfg));

    res.json({
      ok: true,
      container: cname,
      url: `http://${cname}:3000`,
      host: host || null,
      publicUrl: host ? InstanceClient.publicUrlFor(host) : null,
      adminToken: token,
    });
  } catch (e) {
    // Чистим за собой наполовину созданный контейнер
    await docker.remove(cname, true).catch(() => {});
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

registry.start();

app.listen(PORT, () => {
  console.log(`Wishlist orchestrator running on :${PORT}`);
  console.log(`Refresh interval: ${REFRESH_MS / 1000}s`);
  console.log(`Docker socket: ${docker.available() ? 'available' : 'NOT mounted — docker features off'}`);
});
