'use strict';

/**
 * Версии Wishlist Protocol, с которыми этот оркестратор умеет работать.
 *
 * Когда wishlist-app поднимает MAJOR (например, 2.0) — оркестратор обязан
 * выпустить апдейт. Минорные/патч-версии (1.x) должны быть обратно-совместимы.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['1.0'];

function isSupported(protocolVersion) {
  if (typeof protocolVersion !== 'string') return false;
  // Точное совпадение — простейший вариант для MVP.
  // Когда контракт стабилизируется, можно перейти на semver-проверку major.
  return SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion);
}

module.exports = { SUPPORTED_PROTOCOL_VERSIONS, isSupported };
