// In-memory event-contract fixture. It never accesses browser IndexedDB and does
// not claim to reproduce browser locking, durability or crash recovery.
const clone = (value) => structuredClone(value);
const names = (values) => Object.assign([...values], { contains: (name) => values.includes(name) });
const legacyIndexes = () => ({
  byIdempotencyKey: { keyPath: 'idempotencyKey', unique: true, multiEntry: false },
  byOccurredOn: { keyPath: 'occurredOn', unique: false, multiEntry: false },
  byCategoryId: { keyPath: 'categoryId', unique: false, multiEntry: false },
});
const currentIndexes = () => ({ ...legacyIndexes(), bySubcategoryId: { keyPath: 'subcategoryId', unique: false, multiEntry: false } });

export function createStorageFixture({ version = 2, expenses = [], incomes = [], catalog = null, blocked = false, holdBlocked = false, incompatible = false, abortWrites = false, holdWrites = false, abortUpgrades = false } = {}) {
  let currentVersion = version;
  let closedCount = 0;
  let shouldAbortWrites = abortWrites;
  let shouldHoldWrites = holdWrites;
  let shouldHoldNextOpen = false;
  let definitions = new Map();
  const openCalls = [];
  const heldCompletions = [];
  const heldBlockedOpens = [];
  const heldOpens = [];
  const expenseIndexes = version >= 3 ? currentIndexes() : legacyIndexes();
  if (version >= 1) definitions.set('expenses', { keyPath: incompatible ? 'wrong' : 'id', indexes: expenseIndexes, records: clone(expenses) });
  if (version >= 2) definitions.set('incomes', { keyPath: 'id', indexes: version >= 3 ? currentIndexes() : legacyIndexes(), records: clone(incomes) });
  if (version >= 3) definitions.set('categoryCatalog', { keyPath: 'id', indexes: {}, records: catalog ? [clone(catalog)] : [] });

  function storeMetadata(name) {
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Unknown fixture store: ${name}`);
    return {
      keyPath: definition.keyPath,
      indexNames: names(Object.keys(definition.indexes)),
      index(indexName) {
        if (!definition.indexes[indexName]) throw new Error('Missing fixture index');
        const index = definition.indexes[indexName];
        return {
          ...index,
          count(key) {
            const request = {};
            return request;
          },
        };
      },
      createIndex(indexName, keyPath, options = {}) {
        if (definition.indexes[indexName]) throw new Error('Duplicate fixture index');
        definition.indexes[indexName] = { keyPath, unique: options.unique === true, multiEntry: options.multiEntry === true };
      },
      add(record) {
        const key = record[definition.keyPath];
        if (definition.records.some((row) => row[definition.keyPath] === key)) throw new Error('ConstraintError');
        definition.records.push(clone(record));
        return { result: key };
      },
      put(record) {
        const key = record[definition.keyPath]; const prior = definition.records.findIndex((row) => row[definition.keyPath] === key);
        if (prior >= 0) definition.records.splice(prior, 1, clone(record)); else definition.records.push(clone(record));
        return { result: key };
      },
    };
  }

  const db = {
    get version() { return currentVersion; },
    get objectStoreNames() { return names([...definitions.keys()]); },
    close() { closedCount += 1; },
    createObjectStore(name, options) {
      if (definitions.has(name)) throw new Error('Duplicate fixture store');
      definitions.set(name, { keyPath: options.keyPath, indexes: {}, records: [] });
      return storeMetadata(name);
    },
    transaction(storeNames, mode) {
      const scope = typeof storeNames === 'string' ? [storeNames] : storeNames;
      const snapshot = new Map(scope.map((name) => [name, clone(definitions.get(name).records)]));
      let pending = 0;
      let ended = false;
      let completionQueued = false;
      const tx = { error: null };
      const abort = (error) => {
        if (ended) return;
        ended = true;
        tx.error = error;
        tx.onabort?.();
      };
      const complete = () => {
        if (ended || pending) return;
        ended = true;
        if (mode === 'readwrite') for (const [name, records] of snapshot) definitions.get(name).records = clone(records);
        tx.oncomplete?.();
      };
      const settle = () => queueMicrotask(() => {
        if (ended || pending || completionQueued) return;
        completionQueued = true;
        if (mode === 'readwrite' && shouldHoldWrites) heldCompletions.push(complete);
        else complete();
      });
      const schedule = (request, execute) => {
        pending += 1;
        queueMicrotask(() => {
          if (ended) return;
          try { execute(request); }
          catch (error) { request.error = error; request.onerror?.(); abort(error); return; }
          pending -= 1;
          completionQueued = false;
          settle();
        });
      };
      tx.abort = () => abort({ name: 'AbortError' });
      tx.objectStore = (name) => {
        if (!scope.includes(name)) throw new Error('Store outside fixture transaction');
        const metadata = storeMetadata(name);
        const definition = definitions.get(name);
        const records = snapshot.get(name);
        const objectStore = {
          ...metadata,
          get(key) {
            const request = {};
            schedule(request, (item) => { item.result = clone(records.find((row) => row[definition.keyPath] === key)); item.onsuccess?.(); });
            return request;
          },
          getAll() {
            const request = {};
            schedule(request, (item) => { item.result = clone(records); item.onsuccess?.(); });
            return request;
          },
          add(record) { return write(record, false); },
          put(record) { return write(record, true); },
          delete(key) {
            if (mode !== 'readwrite') throw new Error('Readonly fixture delete');
            const request = {};
            schedule(request, (item) => {
              const index = records.findIndex((row) => row[definition.keyPath] === key);
              if (index >= 0) records.splice(index, 1);
              item.onsuccess?.();
              if (shouldAbortWrites) abort({ name: 'QuotaExceededError' });
            });
            return request;
          },
          clear() {
            if (mode !== 'readwrite') throw new Error('Readonly fixture clear');
            const request = {};
            schedule(request, (item) => { records.splice(0); item.onsuccess?.(); });
            return request;
          },
          index(indexName) {
            const index = definition.indexes[indexName];
            if (!index) throw new Error('Missing fixture index');
            return {
              ...index,
              count(key) {
                const request = {};
                schedule(request, (item) => { item.result = records.filter((row) => row[index.keyPath] === key).length; item.onsuccess?.(); });
                return request;
              },
              getAll(key) {
                const request = {};
                schedule(request, (item) => {
                  item.result = clone(key === undefined ? records : records.filter((row) => row[index.keyPath] === key));
                  item.onsuccess?.();
                });
                return request;
              },
            };
          },
        };
        function write(record, replace) {
          if (mode !== 'readwrite') throw new Error('Readonly fixture write');
          const request = {};
          schedule(request, (item) => {
            const key = record[definition.keyPath];
            const prior = records.findIndex((row) => row[definition.keyPath] === key);
            if (prior >= 0 && !replace) {
              item.error = { name: 'ConstraintError' };
              item.onerror?.();
              abort(item.error);
              return;
            }
            for (const index of Object.values(definition.indexes)) {
              if (!index.unique) continue;
              const value = record[index.keyPath];
              if (value !== undefined && records.some((row, rowIndex) => rowIndex !== prior && row[index.keyPath] === value)) {
                item.error = { name: 'ConstraintError' };
                item.onerror?.();
                abort(item.error);
                return;
              }
            }
            if (prior >= 0) records.splice(prior, 1, clone(record));
            else records.push(clone(record));
            item.result = key;
            item.onsuccess?.();
            if (shouldAbortWrites) abort({ name: 'QuotaExceededError' });
          });
          return request;
        }
        return objectStore;
      };
      settle();
      return tx;
    },
  };

  const environment = {
    location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/' },
    indexedDB: {
      open(name, targetVersion) {
        openCalls.push({ name, version: targetVersion });
        const request = {};
        const proceed = () => {
          if (currentVersion > targetVersion) {
            request.error = { name: 'VersionError' };
            request.onerror?.();
            return;
          }
          request.result = db;
          if (currentVersion < targetVersion) {
            const oldVersion = currentVersion;
            const previousDefinitions = clone([...definitions]);
            let aborted = false;
            currentVersion = targetVersion;
            request.transaction = {
              objectStore: storeMetadata,
              abort() { aborted = true; },
            };
            request.onupgradeneeded?.({ oldVersion });
            if (abortUpgrades) aborted = true;
            if (aborted) {
              definitions = new Map(previousDefinitions);
              currentVersion = oldVersion;
              request.error = { name: abortUpgrades ? 'QuotaExceededError' : 'AbortError' };
              request.onerror?.();
              return;
            }
          }
          request.onsuccess?.();
        };
        queueMicrotask(() => {
          if (shouldHoldNextOpen) { shouldHoldNextOpen = false; heldOpens.push(proceed); return; }
          if (blocked) {
            request.onblocked?.();
            // Model the native sequence where a blocking connection later
            // closes and the same open request proceeds to onupgradeneeded.
            if (holdBlocked) heldBlockedOpens.push(proceed);
            else queueMicrotask(proceed);
            return;
          }
          proceed();
        });
        return request;
      },
    },
  };
  return {
    environment,
    openCalls,
    get version() { return currentVersion; },
    get storeNames() { return [...definitions.keys()]; },
    get closedCount() { return closedCount; },
    dump: (name) => clone(definitions.get(name)?.records),
    setAbortWrites(value) { shouldAbortWrites = Boolean(value); },
    setAbortUpgrades(value) { abortUpgrades = Boolean(value); },
    setHoldWrites(value) { shouldHoldWrites = Boolean(value); },
    releaseWrites() { heldCompletions.splice(0).forEach((complete) => complete()); },
    setBlocked(value, hold = holdBlocked) { blocked = Boolean(value); holdBlocked = Boolean(hold); },
    releaseBlocked() { blocked = false; heldBlockedOpens.splice(0).forEach((proceed) => proceed()); },
    holdNextOpen() { shouldHoldNextOpen = true; },
    releaseHeldOpen() { heldOpens.splice(0).forEach((proceed) => proceed()); },
    replaceRecords(name, records) { if (!definitions.has(name)) throw new Error(`Unknown fixture store: ${name}`); definitions.get(name).records = clone(records); },
  };
}
