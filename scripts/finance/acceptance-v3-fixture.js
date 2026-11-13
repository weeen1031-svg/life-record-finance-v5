import { createCategoryStore, createDefaultCategoryCatalog, isValidCategoryCatalog } from '../category-store.js';
import { assertExpenseStorageEnvironment, createExpenseRecord, createIncomeRecord } from '../storage/expense-db.js';
import { stableJson } from '../storage/json-data.js';
import { ACCEPTANCE_DATABASE_NAME } from './repository.js';

const names = ['expenses', 'incomes', 'categoryCatalog'];
const entryIndexes = [
  ['byIdempotencyKey', 'idempotencyKey', true],
  ['byOccurredOn', 'occurredOn', false],
  ['byCategoryId', 'categoryId', false],
  ['bySubcategoryId', 'subcategoryId', false],
];

function makeFixture() {
  const catalog = createDefaultCategoryCatalog();
  const expense = createExpenseRecord({
    draft: { type: 'expense', amount: '10', date: '2026-10-31', note: '隔離驗收用合成舊支出', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000101' },
    category: catalog.categories.find((item) => item.id === 'cat-food'),
    subcategory: catalog.subcategories.find((item) => item.id === 'sub-lunch'),
    now: new Date('2026-11-01T00:00:00.000Z'),
    cryptoProvider: { randomUUID: () => '00000000-0000-4000-8000-000000000201' },
  });
  const income = createIncomeRecord({
    draft: { type: 'income', amount: '20', date: '2026-11-02', note: '隔離驗收用合成舊收入', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000102' },
    category: catalog.categories.find((item) => item.id === 'income-part-time'),
    subcategory: catalog.subcategories.find((item) => item.id === 'sub-income-wage'),
    now: new Date('2026-11-02T01:00:00.000Z'),
    cryptoProvider: { randomUUID: () => '00000000-0000-4000-8000-000000000202' },
  });
  // Represents a valid legacy v3 record whose stored amount includes cents.
  expense.amountMinor = 1050;
  return { expenses: [expense], incomes: [income], categoryCatalog: [{ ...catalog, revision: 4 }] };
}

function validateV3Shape(db) {
  if (db.version !== 3 || db.objectStoreNames.length !== 3 || !names.every((name) => db.objectStoreNames.contains(name))) {
    throw new Error('驗收資料庫不是預期的三集合 v3 結構；沒有覆寫資料。');
  }
  const tx = db.transaction(names, 'readonly');
  for (const name of ['expenses', 'incomes']) {
    const store = tx.objectStore(name);
    if (store.keyPath !== 'id' || store.indexNames.length !== entryIndexes.length
      || !entryIndexes.every(([indexName, path, unique]) => store.indexNames.contains(indexName)
        && store.index(indexName).keyPath === path && store.index(indexName).unique === unique && !store.index(indexName).multiEntry)) {
      throw new Error(`驗收資料庫的 ${name} 索引與正式 v3 不一致；沒有覆寫資料。`);
    }
  }
  const catalog = tx.objectStore('categoryCatalog');
  if (catalog.keyPath !== 'id' || catalog.indexNames.length !== 0) throw new Error('驗收資料庫分類目錄結構與正式 v3 不一致；沒有覆寫資料。');
}

export function createAcceptanceV3FixtureData() { return makeFixture(); }

// Explicitly hold a v3 connection so another acceptance tab can exercise native
// IndexedDB's blocked-upgrade behavior. This function never creates/upgrades a DB.
export async function holdAcceptanceV3Connection({ environment = globalThis, onVersionChange = () => {} } = {}) {
  assertExpenseStorageEnvironment(environment);
  return new Promise((resolve, reject) => {
    let request; let failed;
    try { request = environment.indexedDB.open(ACCEPTANCE_DATABASE_NAME, 3); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = (event) => {
      failed = new Error(event.oldVersion === 0
        ? '尚未建立 v3 基準；此操作不會自行建立資料庫。'
        : '資料庫不是版本 3；為避免升級或降版，已拒絕保持連線。');
      try { request.transaction.abort(); } catch {}
    };
    request.onerror = () => reject(failed || new Error(`無法保持 v3 測試連線：${request.error?.name || '未知錯誤'}`));
    request.onblocked = () => reject(new Error('v3 測試連線受到其他分頁阻擋，請先關閉其他驗收分頁。'));
    request.onsuccess = () => {
      const db = request.result;
      try { validateV3Shape(db); }
      catch (error) { db.close(); reject(error); return; }
      db.onversionchange = () => onVersionChange();
      resolve(db);
    };
  });
}

// Explicitly seed only the fixed acceptance database. Never downgrades, clears, or replaces a database.
export async function seedAcceptanceV3Fixture({ environment = globalThis, confirmation } = {}) {
  assertExpenseStorageEnvironment(environment);
  if (confirmation !== '建立隔離測試資料') throw new Error('請先明確確認只建立虛構驗收資料。');
  const expected = makeFixture();
  return new Promise((resolve, reject) => {
    let request; let blocked = false;
    try { request = environment.indexedDB.open(ACCEPTANCE_DATABASE_NAME, 3); }
    catch (error) { reject(new Error(`無法開啟隔離測試資料庫：${error.message}`)); return; }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (blocked) {
        try { request.transaction.abort(); } catch { /* onerror reports the request's final state. */ }
        return;
      }
      if (event.oldVersion !== 0 || db.objectStoreNames.length !== 0) {
        try { request.transaction.abort(); } catch {}
        return;
      }
      try {
        for (const name of ['expenses', 'incomes']) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          for (const [indexName, path, unique] of entryIndexes) store.createIndex(indexName, path, { unique });
        }
        db.createObjectStore('categoryCatalog', { keyPath: 'id' });
      } catch {
        try { request.transaction.abort(); } catch {}
      }
    };
    request.onblocked = () => { blocked = true; reject(new Error('隔離驗收資料庫正被其他分頁使用；請關閉該驗收分頁後重新按一次。')); };
    request.onerror = () => reject(request.error?.name === 'VersionError'
      ? new Error('這個驗收設定檔的資料庫已高於 v3；為保護資料，程式不會降版或清除。請建立新的獨立 Brave 設定檔重新開始。')
      : new Error(`無法開啟隔離 v3 資料庫：${request.error?.name || '未知錯誤'}。`));
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      try { validateV3Shape(db); }
      catch (error) { db.close(); reject(error); return; }
      let tx; let result; let failure;
      try {
        tx = db.transaction(names, 'readwrite');
        const rows = {}; let remaining = names.length;
        for (const name of names) {
          const get = tx.objectStore(name).getAll();
          get.onsuccess = () => {
            rows[name] = get.result;
            if (--remaining) return;
            try {
              const empty = names.every((storeName) => rows[storeName].length === 0);
              if (empty) {
                for (const storeName of names) for (const item of expected[storeName]) tx.objectStore(storeName).add(item);
                result = { data: expected, seeded: true };
              } else if (stableJson(rows.expenses) === stableJson(expected.expenses)
                && stableJson(rows.incomes) === stableJson(expected.incomes)
                && rows.categoryCatalog.length === 1
                && isValidCategoryCatalog(rows.categoryCatalog[0])
                && rows.categoryCatalog[0].id === expected.categoryCatalog[0].id) result = { data: rows, seeded: false };
              else throw new Error('驗收資料庫已有不同內容；沒有覆寫、清除或合併。請改用新的隔離 Brave 設定檔。');
            } catch (error) { failure = error; try { tx.abort(); } catch {} }
          };
          get.onerror = () => { failure = new Error('無法檢查隔離 v3 資料；沒有回報成功。'); try { tx.abort(); } catch {} };
        }
      } catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(failure || new Error(`隔離 v3 測試資料保存失敗：${tx.error?.name || '交易中止'}。`)); };
      tx.onerror = () => {};
    };
  });
}

// Allows a user-entered synthetic category to be saved into the same isolated
// v3 baseline before the native versionchange upgrade. It never opens the
// official database name and never modifies the v3 income/expense stores.
export async function saveAcceptanceV3CategoryCatalog({ environment = globalThis, catalog, expectedRevision } = {}) {
  assertExpenseStorageEnvironment(environment);
  if (!Number.isSafeInteger(expectedRevision) || !isValidCategoryCatalog(catalog) || catalog.revision !== expectedRevision + 1) {
    throw new Error('v3 測試分類目錄或版本資料無效，沒有保存。');
  }
  const store = createCategoryStore({ catalog, ready: true });
  if (!isValidCategoryCatalog(store.exportCatalog())) throw new Error('v3 測試分類目錄無效，沒有保存。');
  return new Promise((resolve, reject) => {
    let request; let openFailure; let blocked = false;
    try { request = environment.indexedDB.open(ACCEPTANCE_DATABASE_NAME, 3); }
    catch (error) { reject(new Error(`無法開啟隔離 v3 分類：${error.message}`)); return; }
    request.onupgradeneeded = () => {
      openFailure = new Error('尚未建立 v3 驗收基準；分類保存不會自行建立或升級資料庫。');
      try { request.transaction.abort(); } catch {}
    };
    request.onblocked = () => { blocked = true; reject(new Error('v3 分類保存受到其他分頁阻擋；請關閉舊驗收分頁後重試。')); };
    request.onerror = () => reject(openFailure || new Error(request.error?.name === 'VersionError'
      ? 'v3 驗收資料已升級或版本不符；未進行降版。'
      : `無法開啟隔離 v3 分類：${request.error?.name || '未知錯誤'}。`));
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      try { validateV3Shape(db); }
      catch (error) { db.close(); reject(error); return; }
      let tx; let failure; let result;
      try {
        tx = db.transaction(['categoryCatalog'], 'readwrite');
        const catalogStore = tx.objectStore('categoryCatalog');
        const get = catalogStore.get('ledger-categories');
        get.onsuccess = () => {
          const current = get.result;
          if (!current || current.revision !== expectedRevision) {
            failure = new Error('v3 測試分類已被另一個分頁修改，請重新載入後再保存。');
            try { tx.abort(); } catch {}
            return;
          }
          const put = catalogStore.put(catalog);
          put.onsuccess = () => { result = catalog; };
          put.onerror = () => { failure = new Error(`v3 測試分類保存失敗（${put.error?.name || '寫入失敗'}）。`); try { tx.abort(); } catch {} };
        };
        get.onerror = () => { failure = new Error('無法讀取 v3 測試分類版本，沒有保存。'); try { tx.abort(); } catch {} };
      } catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(failure || new Error(`v3 測試分類保存已中止（${tx.error?.name || '讀寫失敗'}）。`)); };
      tx.onerror = () => {};
    };
  });
}
