import { isValidCategoryCatalog } from '../category-store.js';
import { isFinanceAppOrigin, isFinanceAppPath } from '../finance/app-location.js';
import { stableJson } from './json-data.js';

// Official database V3 adds a durable category catalog and lookup indexes.
export const EXPENSE_DATABASE_NAME = 'LifeRecord_Official_V1';
export const EXPENSE_DATABASE_VERSION = 3;
const EXPENSE_STORE = 'expenses';
const INCOME_STORE = 'incomes';
const CATEGORY_STORE = 'categoryCatalog';
const CATEGORY_CATALOG_ID = 'ledger-categories';
const EXPENSE_RECORD_SCHEMA_VERSION = 1;
// Record V2 adds income subcategory snapshots; existing V1 records remain readable.
const INCOME_RECORD_SCHEMA_VERSION = 2;

export class ExpenseStorageError extends Error {
  constructor(message, code = 'STORAGE_ERROR', cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ExpenseStorageError';
    this.code = code;
  }
}

export function createIdempotencyKey(cryptoProvider = globalThis.crypto) {
  if (typeof cryptoProvider?.randomUUID === 'function') return `entry_${cryptoProvider.randomUUID()}`;
  if (typeof cryptoProvider?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoProvider.getRandomValues(bytes);
    return `entry_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new ExpenseStorageError('目前瀏覽器無法產生安全的記錄識別碼，請使用 Brave 重新開啟本機網站。', 'CRYPTO_UNAVAILABLE');
}

export function assertExpenseStorageEnvironment(environment = globalThis) {
  if (!isFinanceAppOrigin(environment.location?.origin)) {
    throw new ExpenseStorageError('儲存已阻擋：記帳版只能從 HTTPS GitHub Pages 網站保存。', 'WRONG_ORIGIN');
  }
  if (!isFinanceAppPath(environment.location?.pathname)) {
    throw new ExpenseStorageError(`儲存已阻擋：請從記帳版網址路徑 ${'/life-record-finance-v5/'} 開啟。`, 'WRONG_PATH');
  }
  if (!environment.indexedDB) {
    throw new ExpenseStorageError('此瀏覽器環境無法使用 IndexedDB，記帳資料沒有保存。', 'INDEXEDDB_UNAVAILABLE');
  }
}

export function parseTwdAmountToMinor(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized) || normalized.length > 14) return null;
  const wholeTwd = BigInt(normalized);
  if (wholeTwd <= 0n || wholeTwd > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 100))) return null;
  return Number(wholeTwd * 100n);
}

export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isValidUtcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const datePart = value.slice(0, 10);
  const [hour, minute, second, millisecond] = value.slice(11, -1).split(/[:.]/).map(Number);
  return isValidDateOnly(datePart) && hour <= 23 && minute <= 59 && second <= 59 && millisecond <= 999;
}

function hasCompleteSubcategorySnapshot(record) {
  return typeof record.subcategoryId === 'string' && record.subcategoryId.length > 0
    && typeof record.subcategoryNameSnapshot === 'string' && record.subcategoryNameSnapshot.length > 0;
}

function hasLegacyMissingSubcategory(record) {
  return record.subcategoryId === undefined && record.subcategoryNameSnapshot === undefined;
}

function isValidExpenseRecord(record) {
  return record
    && typeof record.id === 'string'
    && /^exp_[a-zA-Z0-9-]{16,80}$/.test(record.id)
    && typeof record.idempotencyKey === 'string'
    && /^entry_[a-zA-Z0-9-]{16,80}$/.test(record.idempotencyKey)
    && record.recordType === 'expense'
    && record.schemaVersion === EXPENSE_RECORD_SCHEMA_VERSION
    && record.currency === 'TWD'
    && Number.isSafeInteger(record.amountMinor)
    && record.amountMinor > 0
    && isValidDateOnly(record.occurredOn)
    && typeof record.note === 'string'
    && record.note.length <= 160
    && typeof record.categoryId === 'string'
    && record.categoryId.length > 0
    && typeof record.categoryNameSnapshot === 'string'
    && record.categoryNameSnapshot.length > 0
    && (hasCompleteSubcategorySnapshot(record) || hasLegacyMissingSubcategory(record))
    && isValidUtcTimestamp(record.createdAt);
}

function isValidIncomeRecord(record) {
  return record
    && typeof record.id === 'string'
    && /^inc_[a-zA-Z0-9-]{16,80}$/.test(record.id)
    && typeof record.idempotencyKey === 'string'
    && /^entry_[a-zA-Z0-9-]{16,80}$/.test(record.idempotencyKey)
    && record.recordType === 'income'
    && [1, INCOME_RECORD_SCHEMA_VERSION].includes(record.schemaVersion)
    && record.currency === 'TWD'
    && Number.isSafeInteger(record.amountMinor)
    && record.amountMinor > 0
    && isValidDateOnly(record.occurredOn)
    && typeof record.note === 'string'
    && record.note.length <= 160
    && typeof record.categoryId === 'string'
    && record.categoryId.length > 0
    && typeof record.categoryNameSnapshot === 'string'
    && record.categoryNameSnapshot.length > 0
    && (record.schemaVersion === 1 || hasCompleteSubcategorySnapshot(record))
    && isValidUtcTimestamp(record.createdAt);
}

function isValidCategorySelection(category, subcategory, entryType) {
  return category?.entryType === entryType
    && !category.hidden
    && typeof category.id === 'string' && category.id.length > 0
    && typeof category.name === 'string' && category.name.trim().length > 0
    && subcategory?.entryType === entryType
    && !subcategory.hidden
    && typeof subcategory.id === 'string' && subcategory.id.length > 0
    && typeof subcategory.name === 'string' && subcategory.name.trim().length > 0
    && Array.isArray(subcategory.categoryIds) && subcategory.categoryIds.includes(category.id);
}

export function createExpenseRecord({ draft, category, subcategory, now = new Date(), cryptoProvider = globalThis.crypto }) {
  const amountMinor = parseTwdAmountToMinor(draft?.amount);
  if (!amountMinor) throw new ExpenseStorageError('金額格式無效，請輸入大於 0 的整數新台幣元。', 'INVALID_AMOUNT');
  if (!isValidDateOnly(draft?.date)) throw new ExpenseStorageError('日期格式無效，請重新選擇有效日期。', 'INVALID_DATE');
  if (draft?.type !== 'expense') throw new ExpenseStorageError('目前只支援儲存支出。', 'UNSUPPORTED_TYPE');
  if (!isValidCategorySelection(category, subcategory, 'expense')) {
    throw new ExpenseStorageError('分類資料不完整，支出沒有保存。', 'INVALID_CATEGORY');
  }
  if (typeof draft?.note !== 'string' || draft.note.length > 160) {
    throw new ExpenseStorageError('備註格式無效，請縮短至 160 個字元以內。', 'INVALID_NOTE');
  }
  if (typeof draft?.idempotencyKey !== 'string' || !/^entry_[a-zA-Z0-9-]{16,80}$/.test(draft.idempotencyKey)) {
    throw new ExpenseStorageError('記錄識別碼無效，請重新整理表單後再試。', 'INVALID_IDEMPOTENCY_KEY');
  }
  const createdAt = now.toISOString();
  const record = {
    id: `exp_${createIdempotencyKey(cryptoProvider).slice(6)}`,
    idempotencyKey: draft.idempotencyKey,
    recordType: 'expense',
    schemaVersion: EXPENSE_RECORD_SCHEMA_VERSION,
    currency: 'TWD',
    amountMinor,
    occurredOn: draft.date,
    note: String(draft.note ?? '').trim().slice(0, 160),
    categoryId: category.id,
    categoryNameSnapshot: category.name,
    subcategoryId: subcategory.id,
    subcategoryNameSnapshot: subcategory.name,
    createdAt,
  };
  if (!isValidExpenseRecord(record)) throw new ExpenseStorageError('支出資料格式檢查失敗，沒有保存。', 'INVALID_RECORD');
  return record;
}

export function createIncomeRecord({ draft, category, subcategory, now = new Date(), cryptoProvider = globalThis.crypto }) {
  const amountMinor = parseTwdAmountToMinor(draft?.amount);
  if (!amountMinor) throw new ExpenseStorageError('金額格式無效，請輸入大於 0 的整數新台幣元。', 'INVALID_AMOUNT');
  if (!isValidDateOnly(draft?.date)) throw new ExpenseStorageError('日期格式無效，請重新選擇有效日期。', 'INVALID_DATE');
  if (draft?.type !== 'income') throw new ExpenseStorageError('收入資料類型不正確，沒有保存。', 'UNSUPPORTED_TYPE');
  if (!isValidCategorySelection(category, subcategory, 'income')) {
    throw new ExpenseStorageError('請選擇可使用且互相關聯的收入大分類與子分類。', 'INVALID_CATEGORY');
  }
  if (typeof draft?.note !== 'string' || draft.note.length > 160) {
    throw new ExpenseStorageError('備註格式無效，請縮短至 160 個字元以內。', 'INVALID_NOTE');
  }
  if (typeof draft?.idempotencyKey !== 'string' || !/^entry_[a-zA-Z0-9-]{16,80}$/.test(draft.idempotencyKey)) {
    throw new ExpenseStorageError('記錄識別碼無效，請重新整理表單後再試。', 'INVALID_IDEMPOTENCY_KEY');
  }
  const record = {
    id: `inc_${createIdempotencyKey(cryptoProvider).slice(6)}`,
    idempotencyKey: draft.idempotencyKey,
    recordType: 'income',
    schemaVersion: INCOME_RECORD_SCHEMA_VERSION,
    currency: 'TWD',
    amountMinor,
    occurredOn: draft.date,
    note: String(draft.note ?? '').trim().slice(0, 160),
    categoryId: category.id,
    categoryNameSnapshot: category.name,
    subcategoryId: subcategory.id,
    subcategoryNameSnapshot: subcategory.name,
    createdAt: now.toISOString(),
  };
  if (!isValidIncomeRecord(record)) throw new ExpenseStorageError('收入資料格式檢查失敗，沒有保存。', 'INVALID_RECORD');
  return record;
}

function isLegacyStoreStructureValid(store, expectedIndexCount = 3) {
  try {
    const idempotencyIndex = store.index('byIdempotencyKey');
    const dateIndex = store.index('byOccurredOn');
    const categoryIndex = store.index('byCategoryId');
    return store.keyPath === 'id'
      && store.indexNames.length === expectedIndexCount
      && store.indexNames.contains('byIdempotencyKey')
      && idempotencyIndex.keyPath === 'idempotencyKey'
      && idempotencyIndex.unique
      && !idempotencyIndex.multiEntry
      && store.indexNames.contains('byOccurredOn')
      && dateIndex.keyPath === 'occurredOn'
      && !dateIndex.unique
      && !dateIndex.multiEntry
      && store.indexNames.contains('byCategoryId')
      && categoryIndex.keyPath === 'categoryId'
      && !categoryIndex.unique
      && !categoryIndex.multiEntry;
  } catch {
    return false;
  }
}

function isStoreStructureValid(store) {
  try {
    const subcategoryIndex = store.index('bySubcategoryId');
    return isLegacyStoreStructureValid(store, 4)
      && store.indexNames.length === 4
      && subcategoryIndex.keyPath === 'subcategoryId'
      && !subcategoryIndex.unique
      && !subcategoryIndex.multiEntry;
  } catch {
    return false;
  }
}

function addSubcategoryIndex(store) {
  store.createIndex('bySubcategoryId', 'subcategoryId', { unique: false });
}

function createExpenseStore(db) {
  const store = db.createObjectStore(EXPENSE_STORE, { keyPath: 'id' });
  store.createIndex('byIdempotencyKey', 'idempotencyKey', { unique: true });
  store.createIndex('byOccurredOn', 'occurredOn', { unique: false });
  store.createIndex('byCategoryId', 'categoryId', { unique: false });
  addSubcategoryIndex(store);
}

function createIncomeStore(db) {
  const store = db.createObjectStore(INCOME_STORE, { keyPath: 'id' });
  store.createIndex('byIdempotencyKey', 'idempotencyKey', { unique: true });
  store.createIndex('byOccurredOn', 'occurredOn', { unique: false });
  store.createIndex('byCategoryId', 'categoryId', { unique: false });
  addSubcategoryIndex(store);
}

function createCategoryStore(db) {
  db.createObjectStore(CATEGORY_STORE, { keyPath: 'id' });
}

function validateCategoryStore(store) {
  return store.keyPath === 'id' && store.indexNames.length === 0;
}

function validateDatabaseShape(db) {
  if (db.version !== EXPENSE_DATABASE_VERSION
    || db.objectStoreNames.length !== 3
    || !db.objectStoreNames.contains(EXPENSE_STORE)
    || !db.objectStoreNames.contains(INCOME_STORE)
    || !db.objectStoreNames.contains(CATEGORY_STORE)) {
    throw new ExpenseStorageError('正式記帳資料庫結構與目前程式不相容；未修改資料。', 'INCOMPATIBLE_DATABASE');
  }

  const transaction = db.transaction([EXPENSE_STORE, INCOME_STORE, CATEGORY_STORE], 'readonly');
  const valid = isStoreStructureValid(transaction.objectStore(EXPENSE_STORE))
    && isStoreStructureValid(transaction.objectStore(INCOME_STORE))
    && validateCategoryStore(transaction.objectStore(CATEGORY_STORE));
  if (!valid) throw new ExpenseStorageError('正式記帳資料庫的索引或鍵值結構不相容；未修改資料。', 'INCOMPATIBLE_DATABASE');
}

export function openExpenseDatabase(environment = globalThis) {
  assertExpenseStorageEnvironment(environment);
  const { indexedDB } = environment;

  return new Promise((resolve, reject) => {
    let request;
    let blocked = false;
    let settled = false;
    let upgradeFailure = null;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      request = indexedDB.open(EXPENSE_DATABASE_NAME, EXPENSE_DATABASE_VERSION);
    } catch (error) {
      rejectOnce(new ExpenseStorageError('無法開啟正式記帳資料庫；資料沒有保存。', 'OPEN_FAILED', error));
      return;
    }

    request.onupgradeneeded = (event) => {
      try {
        const db = request.result;
        if (event.oldVersion === 0 && db.objectStoreNames.length === 0) {
          createExpenseStore(db);
          createIncomeStore(db);
          createCategoryStore(db);
          return;
        }
        if (event.oldVersion === 1
          && db.objectStoreNames.length === 1
          && db.objectStoreNames.contains(EXPENSE_STORE)
          && !db.objectStoreNames.contains(INCOME_STORE)
          && isLegacyStoreStructureValid(request.transaction.objectStore(EXPENSE_STORE))) {
          addSubcategoryIndex(request.transaction.objectStore(EXPENSE_STORE));
          createIncomeStore(db);
          createCategoryStore(db);
          return;
        }
        if (event.oldVersion === 2
          && db.objectStoreNames.length === 2
          && db.objectStoreNames.contains(EXPENSE_STORE)
          && db.objectStoreNames.contains(INCOME_STORE)
          && isLegacyStoreStructureValid(request.transaction.objectStore(EXPENSE_STORE))
          && isLegacyStoreStructureValid(request.transaction.objectStore(INCOME_STORE))) {
          addSubcategoryIndex(request.transaction.objectStore(EXPENSE_STORE));
          addSubcategoryIndex(request.transaction.objectStore(INCOME_STORE));
          createCategoryStore(db);
          return;
        }
        upgradeFailure = new ExpenseStorageError('正式資料庫版本或支出結構不相容；升級已中止，原支出未變更。', 'INCOMPATIBLE_DATABASE');
        request.transaction.abort();
      } catch (error) {
        upgradeFailure = new ExpenseStorageError('無法安全建立收入資料結構；升級已中止，原支出未變更。', 'SCHEMA_CREATE_FAILED', error);
        request.transaction.abort();
      }
    };

    request.onblocked = () => {
      blocked = true;
      rejectOnce(new ExpenseStorageError('資料庫正被其他分頁阻擋，請先關閉舊的 Life Record 分頁後重試。', 'OPEN_BLOCKED'));
    };

    request.onerror = () => rejectOnce(upgradeFailure || new ExpenseStorageError('無法開啟正式記帳資料庫；資料沒有保存。', 'OPEN_FAILED', request.error));

    request.onsuccess = () => {
      const db = request.result;
      if (blocked || settled) {
        db.close();
        return;
      }
      try {
        validateDatabaseShape(db);
        db.onversionchange = () => db.close();
        settled = true;
        resolve(db);
      } catch (error) {
        db.close();
        rejectOnce(error instanceof ExpenseStorageError ? error : new ExpenseStorageError('正式記帳資料庫結構驗證失敗。', 'INCOMPATIBLE_DATABASE', error));
      }
    };
  });
}

function validateCatalogForStorage(catalog) {
  if (!isValidCategoryCatalog(catalog)) {
    throw new ExpenseStorageError('分類目錄格式不相容；沒有修改資料。', 'INVALID_CATEGORY_CATALOG');
  }
}

function getCatalogRow(rows) {
  if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 1 && rows[0]?.id !== CATEGORY_CATALOG_ID)) {
    throw new ExpenseStorageError('分類目錄資料列數量或識別碼不相容；沒有修改資料。', 'INVALID_CATEGORY_CATALOG');
  }
  return rows[0] ?? null;
}

export async function readCategoryCatalog(environment = globalThis) {
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    let request;
    let result;
    let transaction;
    try {
      transaction = db.transaction(CATEGORY_STORE, 'readonly');
      request = transaction.objectStore(CATEGORY_STORE).getAll();
      request.onsuccess = () => {
        try { result = getCatalogRow(request.result); }
        catch (error) { result = error; }
      };
    } catch (error) {
      db.close();
      reject(new ExpenseStorageError('無法讀取已保存的分類設定。', 'CATEGORY_READ_START_FAILED', error));
      return;
    }
    transaction.oncomplete = () => {
      db.close();
      if (result instanceof Error) { reject(result); return; }
      if (result) {
        try { validateCatalogForStorage(result); }
        catch (error) { reject(error); return; }
      }
      resolve(result);
    };
    transaction.onabort = () => {
      const error = transaction.error || request?.error;
      db.close();
      reject(new ExpenseStorageError('讀取分類設定的資料庫交易已中止。', 'CATEGORY_READ_ABORTED', error));
    };
    transaction.onerror = () => {};
  });
}

export async function loadOrInitializeCategoryCatalog(defaultCatalog, environment = globalThis) {
  validateCatalogForStorage(defaultCatalog);
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    let request;
    let outcome = null;
    let failure = null;
    let transaction;
    try {
      transaction = db.transaction(CATEGORY_STORE, 'readwrite');
      const store = transaction.objectStore(CATEGORY_STORE);
      request = store.getAll();
      request.onsuccess = () => {
        let current;
        try { current = getCatalogRow(request.result); }
        catch (error) { failure = error; transaction.abort(); return; }
        if (current) {
          try {
            validateCatalogForStorage(current);
            outcome = { catalog: current, initialized: false };
          } catch (error) {
            failure = error;
            transaction.abort();
          }
          return;
        }
        const addRequest = store.add(defaultCatalog);
        addRequest.onsuccess = () => { outcome = { catalog: defaultCatalog, initialized: true }; };
        addRequest.onerror = () => { failure = new ExpenseStorageError('無法初始化分類設定；現有資料未清除。', 'CATEGORY_SEED_FAILED', addRequest.error); };
      };
      request.onerror = () => { failure = new ExpenseStorageError('無法檢查分類設定；現有資料未修改。', 'CATEGORY_READ_FAILED', request.error); };
    } catch (error) {
      db.close();
      reject(new ExpenseStorageError('無法開始分類設定初始化；現有資料未修改。', 'CATEGORY_INIT_START_FAILED', error));
      return;
    }
    transaction.oncomplete = () => {
      db.close();
      if (!outcome) {
        reject(failure || new ExpenseStorageError('分類設定初始化未取得結果。', 'CATEGORY_INIT_FAILED'));
        return;
      }
      resolve(outcome);
    };
    transaction.onabort = () => {
      const error = transaction.error || request?.error;
      db.close();
      reject(failure || new ExpenseStorageError('分類設定初始化交易已中止；現有資料未清除。', 'CATEGORY_INIT_ABORTED', error));
    };
    transaction.onerror = () => {};
  });
}

export async function saveCategoryCatalog(nextCatalog, expectedRevision, environment = globalThis) {
  validateCatalogForStorage(nextCatalog);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || nextCatalog.revision !== expectedRevision + 1) {
    throw new ExpenseStorageError('分類版本資訊無效；沒有保存變更。', 'INVALID_CATEGORY_REVISION');
  }
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    let transaction;
    let currentRequest;
    let failure = null;
    let committed = false;
    const abortWith = (error) => {
      if (!failure) failure = error;
      try { transaction.abort(); } catch {}
    };
    try {
      transaction = db.transaction([CATEGORY_STORE, EXPENSE_STORE, INCOME_STORE], 'readwrite');
      currentRequest = transaction.objectStore(CATEGORY_STORE).getAll();
      currentRequest.onsuccess = () => {
        let current;
        try { current = getCatalogRow(currentRequest.result); }
        catch (error) { abortWith(error); return; }
        if (!current) {
          abortWith(new ExpenseStorageError('分類目錄尚未初始化；請重新載入分類設定。', 'CATEGORY_CATALOG_MISSING'));
          return;
        }
        try { validateCatalogForStorage(current); }
        catch (error) { abortWith(error); return; }
        if (current.revision !== expectedRevision) {
          abortWith(new ExpenseStorageError('另一個分頁已更新分類設定。已載入版本較舊，請重新讀取後再套用。', 'CATEGORY_REVISION_CONFLICT'));
          return;
        }

        const currentCategories = new Map(current.categories.map((item) => [item.id, item]));
        const nextCategories = new Map(nextCatalog.categories.map((item) => [item.id, item]));
        const currentSubcategories = new Map(current.subcategories.map((item) => [item.id, item]));
        const nextSubcategories = new Map(nextCatalog.subcategories.map((item) => [item.id, item]));
        for (const [id, item] of nextCategories) {
          if (currentCategories.has(id) && currentCategories.get(id).entryType !== item.entryType) {
            abortWith(new ExpenseStorageError('既有大分類不能變更收入／支出類型。', 'CATEGORY_TYPE_IMMUTABLE'));
            return;
          }
        }
        for (const [id, item] of nextSubcategories) {
          if (currentSubcategories.has(id) && currentSubcategories.get(id).entryType !== item.entryType) {
            abortWith(new ExpenseStorageError('既有子分類不能變更收入／支出類型。', 'SUBCATEGORY_TYPE_IMMUTABLE'));
            return;
          }
        }

        const removedCategoryIds = [...currentCategories.keys()].filter((id) => !nextCategories.has(id));
        const removedSubcategoryIds = [...currentSubcategories.keys()].filter((id) => !nextSubcategories.has(id));
        const removedAssociationChecks = [];
        for (const [subcategoryId, child] of currentSubcategories) {
          if (removedSubcategoryIds.includes(subcategoryId)) continue;
          const nextChild = nextSubcategories.get(subcategoryId);
          for (const categoryId of child.categoryIds) {
            if (!nextChild?.categoryIds.includes(categoryId)) removedAssociationChecks.push({ categoryId, subcategoryId });
          }
        }
        const countChecks = [];
        for (const id of removedCategoryIds) {
          for (const name of [EXPENSE_STORE, INCOME_STORE]) countChecks.push({ name, index: 'byCategoryId', id, type: 'category' });
        }
        for (const id of removedSubcategoryIds) {
          for (const name of [EXPENSE_STORE, INCOME_STORE]) countChecks.push({ name, index: 'bySubcategoryId', id, type: 'subcategory' });
        }
        const writeCatalog = () => {
          const putRequest = transaction.objectStore(CATEGORY_STORE).put(nextCatalog);
          putRequest.onsuccess = () => { committed = true; };
          putRequest.onerror = () => abortWith(new ExpenseStorageError('無法保存分類設定。', 'CATEGORY_WRITE_FAILED', putRequest.error));
        };
        const totalChecks = countChecks.length + removedAssociationChecks.length;
        if (!totalChecks) { writeCatalog(); return; }
        let remaining = totalChecks;
        const finishCheck = () => {
          remaining -= 1;
          if (remaining === 0 && !failure) writeCatalog();
        };
        for (const check of countChecks) {
          const countRequest = transaction.objectStore(check.name).index(check.index).count(check.id);
          countRequest.onsuccess = () => {
            if (countRequest.result > 0) {
              abortWith(new ExpenseStorageError(
                check.type === 'category'
                  ? `仍有 ${countRequest.result} 筆已保存紀錄引用大分類，已阻止刪除。`
                  : `仍有 ${countRequest.result} 筆已保存紀錄引用子分類，已阻止刪除。`,
                check.type === 'category' ? 'CATEGORY_IN_USE' : 'SUBCATEGORY_IN_USE',
              ));
              return;
            }
            finishCheck();
          };
          countRequest.onerror = () => abortWith(new ExpenseStorageError('無法確認已保存紀錄是否引用此分類；已安全阻止變更。', 'CATEGORY_REFERENCE_CHECK_FAILED', countRequest.error));
        }
        for (const check of removedAssociationChecks) {
          for (const name of [EXPENSE_STORE, INCOME_STORE]) {
            const request = transaction.objectStore(name).index('bySubcategoryId').getAll(check.subcategoryId);
            request.onsuccess = () => {
              if (request.result.some((record) => record.categoryId === check.categoryId)) {
                abortWith(new ExpenseStorageError('此大分類與子分類的組合仍有歷史交易，不能解除這項關聯。其他大分類對同一子分類的交易不會阻擋。', 'CATEGORY_SUBCATEGORY_IN_USE'));
                return;
              }
              finishCheck();
            };
            request.onerror = () => abortWith(new ExpenseStorageError('無法確認此大分類與子分類的交易關聯；已安全阻止變更。', 'CATEGORY_REFERENCE_CHECK_FAILED', request.error));
          }
        }
      };
    } catch (error) {
      db.close();
      reject(new ExpenseStorageError('無法開始分類保存交易；資料未修改。', 'CATEGORY_WRITE_START_FAILED', error));
      return;
    }
    transaction.oncomplete = () => {
      db.close();
      if (!committed) {
        reject(failure || new ExpenseStorageError('分類保存交易完成但未確認寫入。', 'CATEGORY_WRITE_UNCONFIRMED'));
        return;
      }
      resolve(nextCatalog);
    };
    transaction.onabort = () => {
      const error = transaction.error || currentRequest?.error;
      db.close();
      reject(failure || new ExpenseStorageError('分類保存交易已中止；現有分類設定保留。', 'CATEGORY_WRITE_ABORTED', error));
    };
    transaction.onerror = () => {};
  });
}

async function saveRecord(storeName, record, isValidRecord, label, environment) {
  assertExpenseStorageEnvironment(environment);
  if (typeof record?.categoryId !== 'string' || !record.categoryId
    || typeof record?.subcategoryId !== 'string' || !record.subcategoryId) {
    throw new ExpenseStorageError(`${label}必須同時選擇有效的大分類與子分類，沒有寫入資料庫。`, 'INVALID_CATEGORY');
  }
  if (!isValidRecord(record)) throw new ExpenseStorageError(`${label}資料格式檢查失敗，沒有寫入資料庫。`, 'INVALID_RECORD');
  if (record.amountMinor % 100 !== 0) throw new ExpenseStorageError(`${label}新紀錄金額必須是整數新台幣元；舊有小數紀錄仍保留原值。`, 'INVALID_AMOUNT');
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    let catalogRequest;
    let writeRequest;
    let requestKey = null;
    let duplicate = false;
    let failure = null;
    let transaction;
    let catalogRevision = null;
    try {
      transaction = db.transaction([CATEGORY_STORE, storeName], 'readwrite');
      catalogRequest = transaction.objectStore(CATEGORY_STORE).get(CATEGORY_CATALOG_ID);
      catalogRequest.onsuccess = () => {
        let catalog;
        try {
          catalog = catalogRequest.result;
          validateCatalogForStorage(catalog);
          catalogRevision = catalog.revision;
        } catch (error) {
          failure = error;
          transaction.abort();
          return;
        }
        const category = catalog.categories.find((item) => item.id === record.categoryId);
        const subcategory = catalog.subcategories.find((item) => item.id === record.subcategoryId);
        if (!isValidCategorySelection(category, subcategory, record.recordType)) {
          failure = new ExpenseStorageError(`${label}分類已被其他分頁隱藏、移除或解除關聯；請重新選擇分類。`, 'INVALID_CATEGORY');
          transaction.abort();
          return;
        }
        const currentRecord = {
          ...record,
          categoryNameSnapshot: category.name,
          subcategoryNameSnapshot: subcategory.name,
        };
        writeRequest = transaction.objectStore(storeName).add(currentRecord);
        writeRequest.onsuccess = () => { requestKey = writeRequest.result; };
        writeRequest.onerror = () => { duplicate = writeRequest.error?.name === 'ConstraintError'; };
      };
      catalogRequest.onerror = () => {
        failure = new ExpenseStorageError('無法驗證目前分類設定；記帳沒有寫入。', 'CATEGORY_READ_FAILED', catalogRequest.error);
      };
    } catch (error) {
      db.close();
      reject(new ExpenseStorageError(`無法開始${label}保存交易；資料沒有保存。`, 'TRANSACTION_START_FAILED', error));
      return;
    }

    transaction.oncomplete = () => {
      db.close();
      if (requestKey === null) {
        reject(new ExpenseStorageError('資料庫交易完成但沒有取得紀錄識別碼，請重新讀取歷史紀錄確認。', 'MISSING_RESULT'));
        return;
      }
      resolve({ status: 'saved', recordId: requestKey, catalogRevision });
    };
    transaction.onabort = () => {
      const error = transaction.error || writeRequest?.error || catalogRequest?.error;
      db.close();
      if (duplicate || error?.name === 'ConstraintError') {
        resolve({ status: 'duplicate' });
        return;
      }
      reject(failure || new ExpenseStorageError(`${label}保存交易已中止，沒有確認保存成功；請稍後到歷史紀錄確認。`, 'TRANSACTION_ABORTED', error));
    };
    transaction.onerror = () => {};
  });
}

export function saveExpense(record, environment = globalThis) {
  return saveRecord(EXPENSE_STORE, record, isValidExpenseRecord, '支出', environment);
}

export function saveIncome(record, environment = globalThis) {
  return saveRecord(INCOME_STORE, record, (item) => item?.schemaVersion === INCOME_RECORD_SCHEMA_VERSION && isValidIncomeRecord(item), '收入', environment);
}

export async function listExpenses(environment = globalThis) {
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    let request;
    let records;
    let transaction;
    try {
      transaction = db.transaction(EXPENSE_STORE, 'readonly');
      request = transaction.objectStore(EXPENSE_STORE).getAll();
      request.onsuccess = () => { records = request.result; };
    } catch (error) {
      db.close();
      reject(new ExpenseStorageError('無法讀取支出紀錄。', 'READ_START_FAILED', error));
      return;
    }

    transaction.oncomplete = () => {
      db.close();
      const allRecords = records || [];
      if (!allRecords.every(isValidExpenseRecord)) {
        reject(new ExpenseStorageError('歷史紀錄中有不符合目前資料結構的內容；已停止顯示，原資料未修改。', 'INVALID_STORED_RECORD'));
        return;
      }
      const validRecords = allRecords;
      validRecords.sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt));
      resolve(validRecords);
    };
    transaction.onabort = () => {
      const error = transaction.error || request?.error;
      db.close();
      reject(new ExpenseStorageError('讀取支出紀錄的資料庫交易已中止。', 'READ_ABORTED', error));
    };
    transaction.onerror = () => {};
  });
}

export async function listLedgerEntries(environment = globalThis) {
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    let expenseRequest;
    let incomeRequest;
    let expenses;
    let incomes;
    let transaction;
    try {
      transaction = db.transaction([EXPENSE_STORE, INCOME_STORE], 'readonly');
      expenseRequest = transaction.objectStore(EXPENSE_STORE).getAll();
      incomeRequest = transaction.objectStore(INCOME_STORE).getAll();
      expenseRequest.onsuccess = () => { expenses = expenseRequest.result; };
      incomeRequest.onsuccess = () => { incomes = incomeRequest.result; };
    } catch (error) {
      db.close();
      reject(new ExpenseStorageError('無法讀取歷史紀錄。', 'READ_START_FAILED', error));
      return;
    }

    transaction.oncomplete = () => {
      db.close();
      const expenseRecords = expenses || [];
      const incomeRecords = incomes || [];
      if (!expenseRecords.every(isValidExpenseRecord) || !incomeRecords.every(isValidIncomeRecord)) {
        reject(new ExpenseStorageError('歷史紀錄中有不符合目前資料結構的內容；已停止顯示，原資料未修改。', 'INVALID_STORED_RECORD'));
        return;
      }
      resolve([...expenseRecords, ...incomeRecords].sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt)));
    };
    transaction.onabort = () => {
      const error = transaction.error || expenseRequest?.error || incomeRequest?.error;
      db.close();
      reject(new ExpenseStorageError('讀取歷史紀錄的資料庫交易已中止。', 'READ_ABORTED', error));
    };
    transaction.onerror = () => {};
  });
}

export function validateOfficialSnapshot(data) {
  if (!data || Object.keys(data).sort().join(',') !== 'categoryCatalog,expenses,incomes'
    || !Array.isArray(data.expenses) || !Array.isArray(data.incomes) || !Array.isArray(data.categoryCatalog)
    || data.expenses.length + data.incomes.length > 50000 || data.categoryCatalog.length !== 1
    || !isValidCategoryCatalog(data.categoryCatalog[0])) throw new ExpenseStorageError('備份的資料集合或分類目錄不完整。', 'INVALID_BACKUP_DATA');
  stableJson(data);
  const catalog = data.categoryCatalog[0];
  const categories = new Map(catalog.categories.map((item) => [item.id, item]));
  const subcategories = new Map(catalog.subcategories.map((item) => [item.id, item]));
  let historicalReferences = 0;
  for (const [name, validator] of [['expenses', isValidExpenseRecord], ['incomes', isValidIncomeRecord]]) {
    const ids = new Set(); const keys = new Set();
    for (const record of data[name]) {
      if (!validator(record) || !(hasCompleteSubcategorySnapshot(record) || hasLegacyMissingSubcategory(record)) || ids.has(record.id) || keys.has(record.idempotencyKey)) throw new ExpenseStorageError('備份包含無效或重複的收支紀錄。', 'INVALID_BACKUP_RECORD');
      ids.add(record.id); keys.add(record.idempotencyKey);
      const category = categories.get(record.categoryId);
      const child = subcategories.get(record.subcategoryId);
      if ((category && category.entryType !== record.recordType) || (child && child.entryType !== record.recordType)) throw new ExpenseStorageError('備份中的收支與分類類型不一致。', 'INVALID_BACKUP_REFERENCE');
      if (!category || !child || !child.categoryIds.includes(record.categoryId)) historicalReferences += 1;
    }
  }
  return { expenses: data.expenses.length, incomes: data.incomes.length, categories: catalog.categories.length, subcategories: catalog.subcategories.length, historicalReferences };
}

export function officialSnapshotToken(data) {
  return stableJson({ ...data, expenses: [...data.expenses].sort((a, b) => a.id.localeCompare(b.id)), incomes: [...data.incomes].sort((a, b) => a.id.localeCompare(b.id)) });
}

// All stores are read in one readonly transaction: one consistent local snapshot.
export async function readOfficialSnapshot(environment = globalThis) {
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    const data = {}; let tx;
    try {
      tx = db.transaction([EXPENSE_STORE, INCOME_STORE, CATEGORY_STORE], 'readonly');
      for (const name of [EXPENSE_STORE, INCOME_STORE, CATEGORY_STORE]) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { data[name] = request.result; };
      }
    } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); try { validateOfficialSnapshot(data); resolve(data); } catch (error) { reject(error); } };
    tx.onabort = () => { db.close(); reject(new ExpenseStorageError('完整資料讀取已中止，沒有產生備份。', 'SNAPSHOT_ABORTED', tx.error)); };
    tx.onerror = () => {};
  });
}

// Complete replacement is explicitly confirmed by UI. It never deletes/recreates a database.
// The same transaction checks the preview snapshot, replaces all three stores,
// and advances catalog revision so stale category editors cannot overwrite it.
export async function restoreOfficialSnapshot(input, expectedToken, environment = globalThis) {
  const data = structuredClone(input);
  validateOfficialSnapshot(data);
  if (typeof expectedToken !== 'string' || !expectedToken) throw new ExpenseStorageError('缺少還原前資料版本，請重新預覽。', 'RESTORE_PREVIEW_REQUIRED');
  const db = await openExpenseDatabase(environment);
  return new Promise((resolve, reject) => {
    let tx; let failure; let restoredRevision; const current = {}; let pending = 3;
    const abort = (error) => { failure ||= error; try { tx.abort(); } catch {} };
    try {
      tx = db.transaction([EXPENSE_STORE, INCOME_STORE, CATEGORY_STORE], 'readwrite');
      for (const name of [EXPENSE_STORE, INCOME_STORE, CATEGORY_STORE]) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => {
          current[name] = request.result;
          if (--pending) return;
          try {
            validateOfficialSnapshot(current);
            if (officialSnapshotToken(current) !== expectedToken) throw new ExpenseStorageError('預覽後資料已被其他操作或分頁更新，還原已取消；請重新選檔預覽。', 'RESTORE_CONFLICT');
            restoredRevision = Math.max(current.categoryCatalog[0].revision, data.categoryCatalog[0].revision) + 1;
            if (!Number.isSafeInteger(restoredRevision)) throw new Error('分類版本已達上限，無法安全還原。');
            data.categoryCatalog[0].revision = restoredRevision;
            for (const storeName of [EXPENSE_STORE, INCOME_STORE, CATEGORY_STORE]) {
              const store = tx.objectStore(storeName);
              store.clear().onerror = () => abort(new Error('無法替換資料集合。'));
              for (const row of data[storeName]) store.add(row).onerror = () => abort(new Error('還原寫入失敗，已取消全部變更。'));
            }
          } catch (error) { abort(error); }
        };
      }
    } catch (error) { if (tx) abort(error); else { db.close(); reject(error); return; } }
    tx.oncomplete = () => { db.close(); resolve({ revision: restoredRevision }); };
    tx.onabort = () => { db.close(); reject(failure || new ExpenseStorageError('還原交易中止，原資料已保留。', 'RESTORE_ABORTED', tx.error)); };
    tx.onerror = () => {};
  });
}
