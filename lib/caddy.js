'use strict';

/**
 * Caddy auto-sync.
 *
 * Из текущего registry строится Caddyfile и пушится в Caddy admin API
 * (`POST http://<CADDY_ADMIN>/load`). Caddy валидирует и hot-reload'ит конфиг.
 *
 * Адрес Caddy и собственный домен оркестратор берёт из ENV:
 *   - CADDY_ADMIN_URL    — например http://caddy:2019 (внутри docker-сети)
 *   - CADDY_ACME_EMAIL   — email для Let's Encrypt уведомлений
 *
 * Если CADDY_ADMIN_URL не задан — синк отключён (логи это явно скажут).
 */

const CADDY_ADMIN_URL  = process.env.CADDY_ADMIN_URL  || null;
const CADDY_ACME_EMAIL = process.env.CADDY_ACME_EMAIL || null;

/**
 * Превращает URL в host:port для Caddy upstream.
 * @example normalizeUpstream('http://tg-wishlist:3000/') => 'tg-wishlist:3000'
 */
function normalizeUpstream(url) {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname}:${port}`;
  } catch {
    return url; // fallback — пусть Caddy сам ругнётся, если что
  }
}

/**
 * Строит Caddyfile из registry.
 * Только инстансы с непустым `host` попадают в конфиг.
 */
function buildCaddyfile(registry) {
  const lines = [];
  lines.push('# Автогенерировано wishlist-orchestrator. Правки руками будут перезаписаны.');
  lines.push('');
  lines.push('{');
  lines.push('\tadmin 0.0.0.0:2019');
  if (CADDY_ACME_EMAIL) lines.push(`\temail ${CADDY_ACME_EMAIL}`);
  lines.push('}');
  lines.push('');

  // Сам оркестратор
  if (registry.selfHost && registry.selfUpstream) {
    lines.push(`${registry.selfHost} {`);
    lines.push(`\treverse_proxy ${normalizeUpstream(registry.selfUpstream)}`);
    lines.push('}');
    lines.push('');
  }

  // Инстансы
  for (const client of registry.all()) {
    if (!client.host) continue;
    lines.push(`${client.host} {`);
    lines.push(`\treverse_proxy ${normalizeUpstream(client.url)}`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Пушит Caddyfile в admin API. Возвращает {ok, status, body}.
 */
async function pushToCaddy(caddyfile) {
  if (!CADDY_ADMIN_URL) {
    return { ok: false, skipped: true, reason: 'CADDY_ADMIN_URL not set' };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${CADDY_ADMIN_URL}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/caddyfile' },
      body: caddyfile,
      signal: ctl.signal,
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Полный цикл: build → push → лог.
 */
async function syncCaddy(registry) {
  if (!CADDY_ADMIN_URL) {
    console.log('[caddy] CADDY_ADMIN_URL not set — sync skipped');
    return;
  }
  const caddyfile = buildCaddyfile(registry);
  const result = await pushToCaddy(caddyfile);
  if (result.ok) {
    const hosts = [
      ...(registry.selfHost ? [registry.selfHost] : []),
      ...registry.all().filter(c => c.host).map(c => c.host),
    ];
    console.log(`[caddy] synced ${hosts.length} host(s): ${hosts.join(', ') || '(none)'}`);
  } else if (result.skipped) {
    console.log(`[caddy] skipped: ${result.reason}`);
  } else {
    console.warn(`[caddy] push failed:`, result.error || `HTTP ${result.status}: ${result.body}`);
  }
}

module.exports = { buildCaddyfile, pushToCaddy, syncCaddy };
