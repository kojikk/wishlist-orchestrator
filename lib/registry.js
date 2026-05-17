'use strict';

const fs   = require('fs');
const path = require('path');
const InstanceClient = require('./instance');

/**
 * Registry хранит набор зарегистрированных wishlist-инстансов и периодически
 * обновляет их данные.
 *
 * Источник правды — config/instances.json (см. instances.json.example).
 * Файл монтируется как volume, чтобы менять без пересборки контейнера.
 */
class Registry {
  constructor({ configPath, refreshIntervalMs }) {
    this.configPath = configPath;
    this.refreshIntervalMs = refreshIntervalMs;
    /** @type {Map<string, InstanceClient>} */
    this.clients = new Map();
    this._timer = null;
  }

  /**
   * Перечитывает config/instances.json. Новые инстансы добавляются,
   * удалённые — удаляются. Существующие сохраняют состояние/кэш.
   */
  loadConfig() {
    if (!fs.existsSync(this.configPath)) {
      console.warn(`[registry] ${path.basename(this.configPath)} not found — no instances configured`);
      return;
    }
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (e) {
      console.error(`[registry] failed to parse ${this.configPath}:`, e.message);
      return;
    }
    const declared = Array.isArray(cfg.instances) ? cfg.instances : [];
    const declaredIds = new Set(declared.map(i => i.id));

    // Add new / unchanged
    for (const inst of declared) {
      if (!inst.id || !inst.url) {
        console.warn('[registry] skipping instance without id/url:', inst);
        continue;
      }
      const existing = this.clients.get(inst.id);
      if (!existing || existing.url !== inst.url.replace(/\/$/,'')) {
        this.clients.set(inst.id, new InstanceClient(inst));
      } else {
        existing.label = inst.label || existing.label;
      }
    }
    // Drop removed
    for (const id of this.clients.keys()) {
      if (!declaredIds.has(id)) this.clients.delete(id);
    }
    console.log(`[registry] loaded ${this.clients.size} instance(s): ${[...this.clients.keys()].join(', ') || '(none)'}`);
  }

  async refreshAll() {
    await Promise.all([...this.clients.values()].map(async c => {
      try { await c.refresh(); }
      catch (e) { console.warn(`[registry] ${c.id} refresh failed:`, e.message); }
    }));
  }

  start() {
    this.loadConfig();
    this.refreshAll();
    this._timer = setInterval(() => this.refreshAll(), this.refreshIntervalMs);
    // Hot-reload instances.json
    if (fs.existsSync(this.configPath)) {
      fs.watch(this.configPath, () => {
        console.log('[registry] instances.json changed — reloading');
        setTimeout(() => { this.loadConfig(); this.refreshAll(); }, 100);
      });
    }
  }

  stop() {
    clearInterval(this._timer);
  }

  get(id) { return this.clients.get(id); }
  all()   { return [...this.clients.values()]; }
}

module.exports = Registry;
