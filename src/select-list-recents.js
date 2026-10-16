"use strict";

function normalize(ids) {
  if (!Array.isArray(ids)) throw new TypeError("Recent item IDs must be an array.");
  for (const id of ids) {
    if (id == null || !["string", "number", "bigint", "boolean", "symbol"].includes(typeof id))
      throw new TypeError("A recent item ID must be a non-null primitive value.");
  }
  return [...new Set(ids)];
}

/**
 * @public
 * @status experimental
 *
 * Apply a select list's recent-item change to the latest stored IDs. Use this
 * pure reducer inside a scoped state's atomic mutate() callback so concurrent
 * lists preserve each other's records without reviving removed entries.
 * @memberof require('lumine')
 * @param {Array<*>} [currentIds=[]] - Latest stored IDs in most-recent-first order.
 * @param {Array<*>} [recentIds=[]] - The list's proposed IDs, used for explicit replacement.
 * @param {Object} [change] - The change metadata supplied to recents.adapter.save().
 * @param {String} [change.type="replace"] - record, remove, clear, limit, or replace.
 * @param {*} [change.id] - Stable primitive ID for a record or removal.
 * @param {Number} [change.limit=Infinity] - Maximum number of IDs to retain.
 * @returns {Array<*>} Detached, deduplicated IDs after applying the change.
 */
function updateRecentItemIds(currentIds = [], recentIds = [], change = {}) {
  const { type = "replace", id, limit = Infinity } = change;
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0))
    throw new RangeError("The recent item limit must be a non-negative integer.");
  const current = normalize(currentIds);
  let result;
  switch (type) {
    case "record":
      normalize([id]);
      result = [...new Set([id, ...current])];
      break;
    case "remove": {
      const removed = new Set(normalize([id]));
      result = current.filter((candidate) => !removed.has(candidate));
      break;
    }
    case "clear":
      result = [];
      break;
    case "limit":
      result = current;
      break;
    case "replace":
      result = normalize(recentIds);
      break;
    default:
      throw new TypeError(`Unknown recent-item change: ${String(type)}`);
  }
  return result.slice(0, limit);
}

module.exports = { updateRecentItemIds };
