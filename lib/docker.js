'use strict';

/**
 * Минимальный клиент Docker Engine API через unix-socket.
 *
 * Используется админкой оркестратора для lifecycle-операций над контейнерами
 * вишлистов (start/stop/restart/logs), обновления образов (watchtower-style
 * recreate) и провижининга новых инстансов.
 *
 * Сокет монтируется в контейнер: /var/run/docker.sock (см. docker-compose.yml).
 * Если сокет не смонтирован — все методы кидают ошибку, server.js отдаёт 503.
 */

const http = require('http');
const fs   = require('fs');

const SOCKET  = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const API     = '/v1.44';

function available() {
  try { return fs.existsSync(SOCKET); } catch { return false; }
}

function request(method, path, { body = null, timeoutMs = 30000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: SOCKET,
      method,
      path: API + path,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = buf.toString('utf8');
          try { msg = JSON.parse(msg).message || msg; } catch {}
          const err = new Error(`Docker API ${res.statusCode}: ${msg}`);
          err.status = res.statusCode;
          return reject(err);
        }
        if (raw) return resolve(buf);
        const text = buf.toString('utf8');
        if (!text) return resolve(null);
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Docker API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Логи контейнера без TTY приходят мультиплексированным потоком:
 * 8-байтовый заголовок [streamType, 0, 0, 0, sizeBE32] + payload.
 * С TTY — обычный текст (первый байт тогда печатный, > 2).
 */
function demuxLogs(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf[0] > 2) return buf.toString('utf8');
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.slice(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out;
}

const listContainers = () => request('GET', '/containers/json?all=1');
const listImages     = () => request('GET', '/images/json');
const inspect        = (name) => request('GET', `/containers/${encodeURIComponent(name)}/json`);
const inspectImage   = (ref)  => request('GET', `/images/${encodeURIComponent(ref)}/json`);
const start          = (name) => request('POST', `/containers/${encodeURIComponent(name)}/start`);
const stop           = (name) => request('POST', `/containers/${encodeURIComponent(name)}/stop?t=10`, { timeoutMs: 20000 });
const restart        = (name) => request('POST', `/containers/${encodeURIComponent(name)}/restart?t=10`, { timeoutMs: 30000 });
const remove         = (name, force = false) => request('DELETE', `/containers/${encodeURIComponent(name)}?force=${force}`);

async function logs(name, tail = 200) {
  const buf = await request(
    'GET',
    `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=1&tail=${Number(tail) || 200}`,
    { raw: true },
  );
  return demuxLogs(buf);
}

/** Тянет образ. Ответ — стрим прогресса, ждём до конца (до 5 минут). */
async function pull(ref) {
  const [image, tag = 'latest'] = ref.includes(':') && !ref.startsWith('sha256')
    ? [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)]
    : [ref, 'latest'];
  return request(
    'POST',
    `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
    { timeoutMs: 300000 },
  );
}

const create = (name, spec) => request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: spec });

const connectNetwork = (network, container) =>
  request('POST', `/networks/${encodeURIComponent(network)}/connect`, { body: { Container: container } });

/** Воспроизводимый spec из inspect-снимка — для recreate при обновлении. */
function specFromInspect(info) {
  const endpoints = {};
  for (const [net, cfg] of Object.entries(info.NetworkSettings?.Networks || {})) {
    const aliases = (cfg.Aliases || []).filter(a => !info.Id.startsWith(a));
    endpoints[net] = aliases.length ? { Aliases: aliases } : {};
  }
  return {
    Image:        info.Config.Image,
    Env:          info.Config.Env,
    Cmd:          info.Config.Cmd,
    Entrypoint:   info.Config.Entrypoint,
    Labels:       info.Config.Labels,
    ExposedPorts: info.Config.ExposedPorts,
    WorkingDir:   info.Config.WorkingDir,
    HostConfig: {
      Binds:         info.HostConfig.Binds,
      Mounts:        (info.HostConfig.Mounts && info.HostConfig.Mounts.length) ? info.HostConfig.Mounts : undefined,
      PortBindings:  info.HostConfig.PortBindings,
      RestartPolicy: info.HostConfig.RestartPolicy,
    },
    endpoints, // не часть Docker API — обрабатываем сами в recreate
  };
}

/**
 * Обновление контейнера: pull свежего образа по тому же тегу; если image id
 * изменился — пересоздание с тем же spec (env/volumes/ports/networks).
 */
async function update(name) {
  const info = await inspect(name);
  const imageRef = info.Config.Image;
  await pull(imageRef).catch(e => {
    // Локально собранные образы (wishlist-2-app) не лежат в registry — pull
    // упадёт, но recreate всё равно имеет смысл, если образ пересобран на хосте.
    console.warn(`[docker] pull ${imageRef} failed (локальный образ?): ${e.message}`);
  });
  const img = await inspectImage(imageRef);
  if (img.Id === info.Image) {
    return { updated: false, reason: 'Образ не изменился — пересоздание не требуется' };
  }
  const spec = specFromInspect(info);
  const { endpoints } = spec;
  delete spec.endpoints;
  const nets = Object.entries(endpoints);
  if (nets.length) {
    const [firstNet, firstCfg] = nets[0];
    spec.NetworkingConfig = { EndpointsConfig: { [firstNet]: firstCfg } };
  }
  const cname = info.Name.replace(/^\//, '');
  await stop(cname).catch(() => {});
  await remove(cname, true);
  await create(cname, spec);
  for (const [net, cfg] of nets.slice(1)) {
    await connectNetwork(net, cname).catch(e => console.warn(`[docker] connect ${net}: ${e.message}`));
    void cfg;
  }
  await start(cname);
  return { updated: true, image: imageRef, newImageId: img.Id };
}

module.exports = {
  available, request, listContainers, listImages, inspect, inspectImage,
  start, stop, restart, remove, logs, pull, create, connectNetwork,
  specFromInspect, update,
};
