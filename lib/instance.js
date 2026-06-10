'use strict';

const { isSupported, SUPPORTED_PROTOCOL_VERSIONS } = require('./schema');

const DEFAULT_TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS) || 10000;

/**
 * Публичный HTTPS-порт, по которому вишлисты доступны снаружи.
 * На kojikk-server :443 хоста занят VPN, Caddy проброшен как 8443:443,
 * поэтому публичные URL имеют вид https://host:8443.
 */
const PUBLIC_HTTPS_PORT = process.env.PUBLIC_HTTPS_PORT || '443';

function publicUrlFor(host) {
  if (!host) return null;
  const suffix = PUBLIC_HTTPS_PORT && PUBLIC_HTTPS_PORT !== '443' ? `:${PUBLIC_HTTPS_PORT}` : '';
  return `https://${host}${suffix}`;
}

/**
 * Клиент одного wishlist-инстанса.
 *
 * Знает только публичный (стабильный) контракт:
 *   GET  /api/manifest
 *   GET  /api/config
 *   GET  /api/bookings
 *   POST /api/book
 *   POST /api/unbook
 *
 * Никаких /api/admin/* — оркестратор работает только с тем, что инстанс
 * сам объявил как публичный API.
 */
class InstanceClient {
  constructor({ id, url, label, host }) {
    this.id     = id;
    this.url    = url.replace(/\/$/, '');
    this.label  = label || id;
    /** Публичный hostname для reverse-proxy. Если задан — оркестратор
     *  сгенерирует для него запись в Caddy. См. lib/caddy.js. */
    this.host   = host || null;

    /** @type {object|null} последний полученный manifest */
    this.manifest    = null;
    /** @type {object|null} последний полученный /api/config */
    this.config      = null;
    /** @type {object|null} последние брони (item_id → Booking) */
    this.bookings    = null;

    this.lastFetchedAt = null;
    this.lastLatencyMs = null;
    this.lastError     = null;
    this.status        = 'idle'; // 'idle' | 'ok' | 'error' | 'incompatible'
  }

  async _request(pathname, { method = 'GET', body = null } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT);
    try {
      const r = await fetch(this.url + pathname, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body:    body ? JSON.stringify(body) : undefined,
        signal:  ctl.signal,
      });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) {
        const err = new Error(`HTTP ${r.status} ${pathname}`);
        err.status = r.status;
        err.body = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Выполняет manifest-handshake. Проверяет, что версия протокола поддерживается.
   * Без успешного handshake остальные методы выкидывают ошибку «incompatible».
   */
  async handshake() {
    try {
      const manifest = await this._request('/api/manifest');
      if (!isSupported(manifest?.protocolVersion)) {
        this.status = 'incompatible';
        this.lastError = `Unsupported protocolVersion: ${manifest?.protocolVersion}. ` +
                         `Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`;
        this.manifest = manifest;
        return false;
      }
      this.manifest = manifest;
      this.lastError = null;
      return true;
    } catch (e) {
      this.status = 'error';
      this.lastError = e.message;
      return false;
    }
  }

  /**
   * Полный рефреш: manifest + config + bookings. Замеряем latency цикла.
   */
  async refresh() {
    const t0 = Date.now();
    const ok = await this.handshake();
    if (!ok) return;
    try {
      const [config, bookings] = await Promise.all([
        this._request('/api/config'),
        this._request('/api/bookings'),
      ]);
      this.config   = config;
      this.bookings = bookings || {};
      this.lastFetchedAt = Date.now();
      this.lastLatencyMs = Date.now() - t0;
      this.status = 'ok';
      this.lastError = null;
    } catch (e) {
      this.status = 'error';
      this.lastError = e.message;
    }
  }

  async book(itemId, user) {
    return this._request('/api/book',   { method: 'POST', body: { itemId, user } });
  }

  async unbook(itemId, user) {
    return this._request('/api/unbook', { method: 'POST', body: { itemId, user } });
  }

  /** Снимок для отдачи в /api/instances. */
  toPublic() {
    return {
      id:    this.id,
      url:   this.url,
      host:  this.host,
      publicUrl: publicUrlFor(this.host) || this.url,
      label: this.label,
      // Имя вишлиста из его собственного конфига (app.title); label — fallback.
      title: this.config?.app?.title || this.label,
      status:        this.status,
      protocolVersion: this.manifest?.protocolVersion || null,
      name:          this.manifest?.name || null,
      sources:       this.manifest?.sources || [],
      features:      this.manifest?.features || {},
      itemCount:     this._countItems(),
      categoryCount: this.config?.wishlist?.length || 0,
      lastFetchedAt: this.lastFetchedAt,
      lastLatencyMs: this.lastLatencyMs,
      lastError:     this.lastError,
    };
  }

  _countItems() {
    if (!this.config?.wishlist) return 0;
    const seen = new Set();
    for (const cat of this.config.wishlist) {
      for (const it of cat.items || []) seen.add(it.id);
    }
    return seen.size;
  }
}

module.exports = InstanceClient;
module.exports.publicUrlFor = publicUrlFor;
