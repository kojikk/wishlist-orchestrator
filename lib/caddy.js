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
  const adminAddr = CADDY_ADMIN_URL
    ? new URL(CADDY_ADMIN_URL).host   // например caddy:2019
    : '0.0.0.0:2019';
  lines.push('{');
  lines.push(`\tadmin ${adminAddr} {`);
  lines.push(`\t\torigins ${CADDY_ADMIN_URL || 'http://localhost:2019'} localhost`);
  lines.push('\t}');
  // HTTP/3 (QUIC) отключён намеренно. Caddy слушает 443 внутри контейнера, наружу
  // проброшен только TCP 8443; UDP/443 снаружи не доступен (там VPN/роутер). При
  // включённом h3 Caddy слал `alt-svc: h3=":443"`, и мобильный Telegram-webview уходил
  // в QUIC на недоступный :443 → ERR_CONNECTION_CLOSED. Оставляем только h1+h2 (TCP).
  lines.push('\tservers {');
  lines.push('\t\tprotocols h1 h2');
  lines.push('\t}');
  if (CADDY_ACME_EMAIL) {
    lines.push(`\temail ${CADDY_ACME_EMAIL}`);
  } else {
    lines.push('\tauto_https off');
  }
  lines.push('}');
  lines.push('');
  // Подхватываем посторонние маршруты (например, reacher) — каждый владелец
  // кладёт свой snippet в /etc/caddy/routes/*.caddy. Orchestrator их не трогает.
  lines.push('import /etc/caddy/routes/*.caddy');
  lines.push('');

  // Без ACME email Caddy работает в HTTP-режиме (Cloudflare терминирует TLS).
  // Именованные блоки без явного порта по умолчанию слушают :443 — добавляем :80.
  const portSuffix = CADDY_ACME_EMAIL ? '' : ':80';

  // Вспомогательная функция — эмитирует HTTPS-блок (или HTTP при отсутствии ACME),
  // а при включённом ACME также явный :80-блок для CDN origin pull.
  // Явный :80-блок переопределяет авто-редирект Caddy и отдаёт контент напрямую —
  // это безопасно, т.к. CDN (Gcore) терминирует внешний TLS и тянет origin по HTTP/80.
  const emitSite = (host, upstream) => {
    lines.push(`${host}${portSuffix} {`);
    lines.push(`\treverse_proxy ${upstream}`);
    lines.push('}');
    lines.push('');
    if (CADDY_ACME_EMAIL) {
      lines.push(`${host}:80 {`);
      lines.push(`\treverse_proxy ${upstream}`);
      lines.push('}');
      lines.push('');
    }
  };

  // Сам оркестратор
  if (registry.selfHost && registry.selfUpstream) {
    emitSite(registry.selfHost, normalizeUpstream(registry.selfUpstream));
  }

  // Инстансы
  for (const client of registry.all()) {
    if (!client.host) continue;
    emitSite(client.host, normalizeUpstream(client.url));
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
      headers: {
        'Content-Type': 'text/caddyfile',
        'Origin': CADDY_ADMIN_URL, // Caddy admin API требует совпадающий Origin
      },
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
