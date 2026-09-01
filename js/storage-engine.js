(function(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZeroBudgetStorageEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const WRITE_LOCK_KEY = 'zeroBudget_write_lock';
  const DEFAULT_LOCK_TTL_MS = 5000;

  function createCoordinator({ storage, now, ownerId, lockKey = WRITE_LOCK_KEY,
    ttlMs = DEFAULT_LOCK_TTL_MS, error }) {
    function instant() {
      try {
        const value = now();
        if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid clock');
        return value.getTime();
      } catch { throw error('CLOCK_FAILED'); }
    }
    function readLock() {
      let raw;
      try { raw = storage.getItem(lockKey); } catch { throw error('STORAGE_READ_FAILED'); }
      if (raw === null) return null;
      try {
        const value = JSON.parse(raw);
        return typeof value.ownerId === 'string' && Number.isFinite(value.expiresAt) ? value : null;
      } catch { return null; }
    }
    function acquire() {
      const timestamp = instant();
      const current = readLock();
      if (current && current.ownerId !== ownerId && current.expiresAt > timestamp) throw error('STORE_BUSY');
      const lock = { ownerId, expiresAt: timestamp + ttlMs };
      try { storage.setItem(lockKey, JSON.stringify(lock)); } catch { throw error('STORE_BUSY'); }
      const claimed = readLock();
      if (!claimed || claimed.ownerId !== ownerId || claimed.expiresAt !== lock.expiresAt) throw error('STORE_BUSY');
      return lock;
    }
    function release() {
      try {
        const current = readLock();
        if (!current || current.ownerId !== ownerId) return true;
        storage.removeItem(lockKey);
        return true;
      } catch { return false; }
    }
    return Object.freeze({ acquire, release, readLock });
  }

  return Object.freeze({ WRITE_LOCK_KEY, DEFAULT_LOCK_TTL_MS, createCoordinator });
});
