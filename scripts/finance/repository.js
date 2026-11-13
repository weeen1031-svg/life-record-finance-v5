import { assertExpenseStorageEnvironment, EXPENSE_DATABASE_NAME } from '../storage/expense-db.js';
import { stableJson } from '../storage/json-data.js';
import { applyFinanceCommand, createDefaultEntryPreferences, createMinimumFinanceCatalog, FINANCE_STORES, validateFinanceSnapshot } from './model.js';
import { mergeFinanceSnapshots } from './merge.js';
import { isFinancePreviewEnabled } from './development-preview.js';

export const FINANCE_DATABASE_VERSION = 5;
export const ACCEPTANCE_DATABASE_VERSION = 5;
export const FINANCE_RECOVERY_STORE = 'financeRecovery';
export const ACCEPTANCE_DATABASE_NAME = 'LifeRecord_FinanceAcceptance_Only_v4';
// Deliberately a source-code gate, not a URL/localStorage switch. Finance V5 is the official data path.
export const OFFICIAL_FINANCE_ENABLED = true;
export const FINANCE_GATE_REASON = '';

const entryIndexes = [['byIdempotencyKey', 'idempotencyKey', true], ['byOccurredOn', 'occurredOn'], ['byCategoryId', 'categoryId'], ['bySubcategoryId', 'subcategoryId']];
const definitions = {
  expenses: entryIndexes, incomes: entryIndexes, categoryCatalog: [], accounts: [],
  accountEvents: [['byIdempotencyKey', 'idempotencyKey', true], ['byAccountId', 'accountIds', false, true], ['byOccurredOn', 'occurredOn'], ['byEntryId', 'entryId', true]],
  financePreferences: [], reminderRules: [], [FINANCE_RECOVERY_STORE]: [],
  reminderOccurrences: [['byPeriod', 'periodKey', true], ['byRuleId', 'ruleId'], ['byDueDate', 'dueDate'], ['byEntryId', 'entryId', true]],
};
const entryPreferenceConfiguration = (preferences) => ({
  defaultEntryType: preferences?.defaultEntryType || 'expense',
  dateMode: preferences?.dateMode || 'today',
  preferredAccountId: preferences?.preferredAccountId || '',
  preferredAccountIds: preferences?.preferredAccountIds || { expense: preferences?.preferredAccountId || '', income: preferences?.preferredAccountId || '' },
});
const hasTypedAccountDefaults = (data) => Object.hasOwn(data.financePreferences?.[0]?.entryPreferences || {}, 'preferredAccountIds');
const hasV5ReminderFields = (data) => data.reminderRules.some((item) => ['entryDefaults', 'billDate', 'billSchedule'].some((field) => Object.hasOwn(item, field)))
  || data.reminderOccurrences.some((item) => ['entryDefaults', 'billDate', 'sourceRuleRevision', 'overrides'].some((field) => Object.hasOwn(item, field)));
function validStore(store, indexes) {
  if (store.keyPath !== 'id' || store.autoIncrement === true || store.indexNames.length !== indexes.length) return false;
  return indexes.every(([name, path, unique = false, multi = false]) => {
    if (!store.indexNames.contains(name)) return false;
    const index = store.index(name); return index.keyPath === path && index.unique === unique && index.multiEntry === multi;
  });
}
function createStore(db, name) {
  const store = db.createObjectStore(name, { keyPath: 'id' });
  for (const [index, keyPath, unique = false, multiEntry = false] of definitions[name]) store.createIndex(index, keyPath, { unique, multiEntry });
  return store;
}
function initialFinancePreferences(dataset) {
  return { id: 'finance-settings', revision: 0, generation: 0, defaults: [], budgetSchedules: [], budgetOverrides: [], entryPreferences: createDefaultEntryPreferences(), dataset };
}
export function migrateFinanceSchema(db, transaction, oldVersion, dataset = 'acceptance') {
  const nextStores = [...FINANCE_STORES, FINANCE_RECOVERY_STORE];
  if (oldVersion === 0 && db.objectStoreNames.length === 0) {
    nextStores.forEach((name) => createStore(db, name));
    // The initial catalog and required settings are committed with the schema.
    transaction.objectStore('categoryCatalog').add(createMinimumFinanceCatalog());
    transaction.objectStore('financePreferences').add(initialFinancePreferences(dataset));
    return;
  }
  const oldStores = ['expenses', 'incomes', 'categoryCatalog'];
  if (oldVersion === 4) {
    if (db.objectStoreNames.length !== FINANCE_STORES.length || !FINANCE_STORES.every((name) => db.objectStoreNames.contains(name) && validStore(transaction.objectStore(name), definitions[name]))) throw new Error('不相容的 v4 財務結構；v5 升級中止，原資料保留。');
    createStore(db, FINANCE_RECOVERY_STORE);
    return;
  }
  if (oldVersion !== 3 || db.objectStoreNames.length !== 3 || !oldStores.every((name) => db.objectStoreNames.contains(name) && validStore(transaction.objectStore(name), definitions[name]))) throw new Error('不相容的舊結構；財務資料庫升級中止，原資料保留。');
  nextStores.filter((name) => !oldStores.includes(name)).forEach((name) => createStore(db, name));
  // Required v4 settings are part of the same versionchange transaction. If
  // the browser aborts (for example because storage is full), v3 remains v3.
  transaction.objectStore('financePreferences').add(initialFinancePreferences(dataset));
  // No cursor/update/clear on the three original stores: old entries keep unspecified accounts.
}
export function financeSnapshotToken(data) {
  return stableJson(Object.fromEntries(FINANCE_STORES.map((name) => [name, [...data[name]].sort((a, b) => a.id.localeCompare(b.id))])));
}
export async function openFinanceDatabase({ mode = 'official', environment = globalThis, onOpenStatus = () => {}, allowDevelopmentPreview = false } = {}) {
  const developmentPreviewAllowed = allowDevelopmentPreview === true && isFinancePreviewEnabled(environment);
  if (mode === 'official' && !OFFICIAL_FINANCE_ENABLED && !developmentPreviewAllowed) { const error = new Error(FINANCE_GATE_REASON); error.code = 'OFFICIAL_FINANCE_DISABLED'; throw error; }
  if (!['official', 'acceptance'].includes(mode)) throw new Error('不允許的資料來源。');
  assertExpenseStorageEnvironment(environment);
  return new Promise((resolve, reject) => {
    let settled = false; let failed; let blocked = false; let cancellationRequested = false; let knownDatabaseVersion = null;
    const requestedVersion = mode === 'acceptance' ? ACCEPTANCE_DATABASE_VERSION : FINANCE_DATABASE_VERSION;
    const request = environment.indexedDB.open(mode === 'acceptance' ? ACCEPTANCE_DATABASE_NAME : EXPENSE_DATABASE_NAME, requestedVersion);
    const rejectOnce = (error) => { if (!settled) { settled = true; reject(error); } };
    const notify = (status) => { try { onOpenStatus(status); } catch { /* Status UI must not interrupt IndexedDB event handling. */ } };
    request.onupgradeneeded = (event) => {
      knownDatabaseVersion = event.oldVersion;
      if (cancellationRequested) {
        failed = new Error('升級曾被舊分頁阻擋；後續升級已要求中止。請確認實際版本後再重新操作。');
        try { request.transaction.abort(); } catch { /* The transaction may already have ended; onsuccess reports the actual version. */ }
        return;
      }
      try { migrateFinanceSchema(request.result, request.transaction, event.oldVersion, mode === 'acceptance' ? 'acceptance' : 'official'); }
      catch (error) { failed = error; request.transaction.abort(); }
    };
    request.onerror = () => {
      let actualVersion = knownDatabaseVersion;
      try { actualVersion = request.result?.version ?? actualVersion; } catch { /* After an aborted versionchange, report the version observed before it began. */ }
      const error = failed || new Error(blocked
        ? `資料庫開啟／升級被舊分頁阻擋後中止（${request.error?.name || '未完成'}）。請關閉舊分頁再重新操作。`
        : `帳戶資料庫無法開啟：${request.error?.name || '未知錯誤'}。沒有刪除或重建資料庫。`);
      if (Number.isSafeInteger(actualVersion)) {
        error.databaseVersion = actualVersion;
        error.message += ` 資料庫目前實際版本：v${actualVersion}。`;
      } else error.message += ' 升級結果未能確認，請重新開啟資料庫檢查版本。';
      if (blocked) notify({ state: 'blocked-settled', databaseVersion: actualVersion, message: Number.isSafeInteger(actualVersion) ? `已確認升級交易中止；資料庫仍為 v${actualVersion}。關閉舊分頁後可重新讀取。` : '受阻的開啟請求已結束；目前資料庫版本尚未確認，請關閉舊分頁後重新讀取。' });
      rejectOnce(error);
    };
    request.onblocked = () => {
      // IDBOpenDBRequest has no cancel(). Stop the caller promptly so the UI
      // cannot spin forever; keep handlers attached to abort any later upgrade.
      blocked = true;
      cancellationRequested = true;
      const error = new Error('資料庫正被其他分頁阻擋；已停止本次開啟，最終版本尚未確認，也不會宣稱升級已取消或完成。請關閉舊的 Life Record 分頁，再按「重新讀取」確認資料庫狀態。');
      error.code = 'FINANCE_DATABASE_BLOCKED';
      if (Number.isSafeInteger(knownDatabaseVersion)) error.databaseVersion = knownDatabaseVersion;
      notify({ state: 'blocked', message: error.message });
      rejectOnce(error);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        const actualVersion = db.version;
        db.close();
        if (blocked) notify({ state: 'blocked-resolved', databaseVersion: actualVersion, message: `受阻請求稍後才完成；已關閉連線，資料庫目前為 v${actualVersion}。請重新讀取以載入實際資料。` });
        return;
      }
      if (cancellationRequested) {
        const actualVersion = db.version;
        db.close();
        const error = new Error(`資料庫曾遭舊分頁阻擋；目前連線已關閉，沒有繼續操作。資料庫實際版本為 v${actualVersion}。請關閉舊分頁後重新操作。`);
        error.databaseVersion = actualVersion;
        notify({ state: 'blocked-resolved', databaseVersion: actualVersion, message: error.message });
        rejectOnce(error);
        return;
      }
      try {
        const expectedStores = [...FINANCE_STORES, FINANCE_RECOVERY_STORE];
        if (db.version !== requestedVersion || db.objectStoreNames.length !== expectedStores.length || !expectedStores.every((name) => db.objectStoreNames.contains(name))) throw new Error('同名資料庫結構不相容，已停止，未清空資料。');
        const tx = db.transaction(FINANCE_STORES, 'readonly');
        if (!FINANCE_STORES.every((name) => validStore(tx.objectStore(name), definitions[name]))) throw new Error('帳戶資料庫索引不相容，已停止。');
        db.onversionchange = () => db.close(); settled = true; resolve(db);
      } catch (error) {
        if (error && typeof error === 'object') {
          try { error.databaseVersion = db.version; } catch { /* Preserve the original schema error. */ }
        }
        db.close(); rejectOnce(error);
      }
    };
  });
}

export function createFinanceRepository({ mode = 'official', environment = globalThis, onOpenStatus = () => {}, allowDevelopmentPreview = false } = {}) {
  const dataset = mode === 'acceptance' ? 'acceptance' : 'official';
  const localRecoveryAvailable = () => mode === 'acceptance' || (mode === 'official' && (OFFICIAL_FINANCE_ENABLED || (allowDevelopmentPreview === true && isFinancePreviewEnabled(environment))));
  let initialized = false;
  let initializationPromise = null;
  async function transact(write, action, { readRecovery = false } = {}) {
    const db = await openFinanceDatabase({ mode, environment, onOpenStatus, allowDevelopmentPreview });
    const decorateDatabaseError = (error) => {
      const actualVersion = db.version;
      if (error && typeof error === 'object') {
        error.databaseVersion = actualVersion;
        if (!String(error.message || '').includes(`資料庫目前版本 v${actualVersion}`)) error.message = `${error.message || '資料庫操作失敗。'}（資料庫目前版本 v${actualVersion}；原始資料未清除）。`;
        return error;
      }
      const wrapped = new Error(`資料庫目前版本 v${actualVersion}；${String(error)}`);
      wrapped.databaseVersion = actualVersion;
      return wrapped;
    };
    return new Promise((resolve, reject) => {
      const recoveryAvailable = db.objectStoreNames.contains(FINANCE_RECOVERY_STORE);
      let tx; let failure; let outcome; const data = {}; let recoveryPoint = null; let remaining = FINANCE_STORES.length + (readRecovery && recoveryAvailable ? 1 : 0);
      const abort = (error) => { failure ||= error; try { tx.abort(); } catch {} };
      const put = (name, record) => {
        const request = tx.objectStore(name).put(record);
        request.onerror = () => abort(new Error(`保存中止（${request.error?.name || '寫入失敗'}），整筆操作已回復。`));
      };
      try {
        const transactionStores = recoveryAvailable ? [...FINANCE_STORES, FINANCE_RECOVERY_STORE] : FINANCE_STORES;
        tx = db.transaction(transactionStores, write ? 'readwrite' : 'readonly');
        const finishReads = () => {
          if (--remaining) return;
          try { outcome = action(data, { put, tx, recoveryPoint }); } catch (error) { abort(error); }
        };
        for (const name of FINANCE_STORES) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            data[name] = request.result;
            finishReads();
          };
        }
        if (readRecovery && recoveryAvailable) {
          const request = tx.objectStore(FINANCE_RECOVERY_STORE).get('last-operation');
          request.onsuccess = () => { recoveryPoint = request.result || null; finishReads(); };
          request.onerror = () => abort(new Error(`讀取復原點失敗（${request.error?.name || '未知錯誤'}）。`));
        }
      } catch (error) { if (tx) abort(error); else { db.close(); reject(decorateDatabaseError(error)); return; } }
      tx.oncomplete = () => { db.close(); resolve(outcome); };
      tx.onabort = () => { db.close(); reject(decorateDatabaseError(failure || new Error(`資料庫交易已中止（${tx.error?.name || '讀寫失敗'}）；沒有確認保存成功。`))); };
      tx.onerror = () => {};
    });
  }
  async function initializeOnce() {
    if (initialized) return;
    if (!initializationPromise) {
      initializationPromise = transact(true, (data, { put }) => {
        if (!data.categoryCatalog.length) {
          if (data.expenses.length || data.incomes.length) throw new Error('有舊收支卻缺少分類目錄，不能猜測重建。');
          data.categoryCatalog = [createMinimumFinanceCatalog()]; put('categoryCatalog', data.categoryCatalog[0]);
        }
        if (!data.financePreferences.length) {
          // Repair only the missing settings row. Existing accounts, entries,
          // reminders and events stay untouched and are validated below.
          data.financePreferences = [initialFinancePreferences(dataset)]; put('financePreferences', data.financePreferences[0]);
        } else {
          if (data.financePreferences.length !== 1) throw new Error('財務設定筆數不正確，已停止初始化。');
          // Additive recovery is repeatable: never reset user preferences.
          const settings = data.financePreferences[0]; let changed = false;
          if (!Array.isArray(settings.defaults)) { settings.defaults = []; changed = true; }
          if (!Array.isArray(settings.budgetSchedules)) { settings.budgetSchedules = []; changed = true; }
          if (!Array.isArray(settings.budgetOverrides)) { settings.budgetOverrides = []; changed = true; }
          if (!settings.entryPreferences) { settings.entryPreferences = createDefaultEntryPreferences(); changed = true; }
          if (!Number.isSafeInteger(settings.generation)) { settings.generation = 0; changed = true; }
          if (!Number.isSafeInteger(settings.revision)) throw new Error('財務設定版本資料不正確，不能安全補齊。');
          if (settings.dataset !== dataset) throw new Error('資料來源不一致；不會改寫既有設定。');
          if (changed) put('financePreferences', settings);
        }
        validateFinanceSnapshot(data);
        if (data.financePreferences[0].dataset !== dataset) throw new Error('資料來源不一致。');
        return data;
      }).then((data) => { initialized = true; return data; }).catch((error) => {
        // A failed transaction leaves initialized false, allowing an explicit
        // reopen/retry. Include the real DB version on all initialization errors.
        throw error;
      }).finally(() => { initializationPromise = null; });
    }
    return initializationPromise;
  }
  return {
    async initialize() {
      const initial = await initializeOnce();
      if (initial) return initial;
      return transact(false, (data) => { validateFinanceSnapshot(data); if (data.financePreferences[0].dataset !== dataset) throw new Error('資料來源不一致。'); return data; });
    },
    async read() {
      await initializeOnce();
      return transact(false, (data) => { validateFinanceSnapshot(data); if (data.financePreferences[0].dataset !== dataset) throw new Error('資料來源不一致。'); return data; });
    },
    async execute(command, context) {
      await initializeOnce();
      const preserveRecoveryDuringRefresh = localRecoveryAvailable() && command.kind === 'refresh-reminders';
      return transact(true, (data, { put, tx, recoveryPoint }) => {
        if (!Number.isSafeInteger(context?.expectedGeneration) || context.expectedGeneration !== data.financePreferences[0]?.generation) throw new Error('資料曾經還原，或缺少資料世代，請重新讀取後再操作。');
        const beforeToken = financeSnapshotToken(data);
        const result = applyFinanceCommand(data, command, { ...context, dataset });
        if (result.status === 'duplicate') return result;
        // A day-boundary refresh may materialize reminder occurrences after a
        // browser restart. Keep the local undo point valid only when that
        // automatic refresh is the sole change since the destructive action.
        if (preserveRecoveryDuringRefresh && recoveryPoint?.dataset === dataset && recoveryPoint.afterToken === beforeToken) {
          const changedStores = FINANCE_STORES.filter((name) => stableJson(data[name]) !== stableJson(result.data[name]));
          if (changedStores.every((name) => name === 'reminderOccurrences')) {
            tx.objectStore(FINANCE_RECOVERY_STORE).put({ ...recoveryPoint, afterToken: financeSnapshotToken(result.data) });
          }
        }
        const undoSourceType = command.kind === 'undo-reminder-payment'
          ? data.reminderOccurrences.find((item) => item.id === command.occurrenceId)?.entryType
          : '';
        const sourceEntryType = undoSourceType || command.entryType;
        for (const name of FINANCE_STORES) {
          const prior = new Map(data[name].map((item) => [item.id, item]));
          for (const row of result.data[name]) {
            if (!prior.has(row.id) || stableJson(prior.get(row.id)) !== stableJson(row)) put(name, row);
            prior.delete(row.id);
          }
          if (prior.size) {
            for (const id of prior.keys()) {
              const removed = prior.get(id);
              const reminderDelete = command.kind === 'delete-reminder' && ['reminderRules', 'reminderOccurrences'].includes(name);
              const safeAccountDelete = command.kind === 'delete-account' && ['accounts', 'accountEvents'].includes(name);
              const entryStore = sourceEntryType === 'income' ? 'incomes' : 'expenses';
              const safeRecordDelete = (command.kind === 'delete-entry' && name === entryStore && id === command.entryId)
                || (command.kind === 'undo-reminder-payment' && command.expectedCompletionMode === 'created' && name === entryStore && id === command.entryId);
              const safeSourceEventDelete = ['edit-entry', 'split-entry', 'delete-entry', 'undo-reminder-payment'].includes(command.kind)
                && name === 'accountEvents'
                && removed?.entryId === command.entryId
                && removed?.type === sourceEntryType;
              if (!reminderDelete && !safeAccountDelete && !safeRecordDelete && !safeSourceEventDelete) throw new Error('一般操作不允許刪除既有資料。');
              tx.objectStore(name).delete(id);
            }
          }
        }
        return result;
      }, { readRecovery: preserveRecoveryDuringRefresh });
    },
    async resetAcceptance(expectedToken, { confirmation, backupSaved, displayPreferences = null } = {}) {
      if (!localRecoveryAvailable()) throw new Error('目前資料環境尚未開放恢復初始狀態。');
      const confirmationPhrase = mode === 'acceptance' ? '重設合成資料' : OFFICIAL_FINANCE_ENABLED ? '重設正式記帳資料' : '重設預覽資料';
      if (confirmation !== confirmationPhrase || backupSaved !== true) throw new Error('請先保存完整備份、勾選確認並輸入指定確認詞。');
      await initializeOnce();
      return transact(true, (current, { tx }) => {
        validateFinanceSnapshot(current);
        if (current.financePreferences[0].dataset !== dataset) throw new Error('資料來源不符，已拒絕恢復初始狀態。');
        if (!expectedToken || financeSnapshotToken(current) !== expectedToken) { const error = new Error('預覽後資料已變更，歸零取消；請重新匯出備份並確認摘要。'); error.code = 'FINANCE_CONFLICT'; throw error; }
        // Return the isolated finance dataset to the same built-in categories
        // used on first initialization. Keep the revision moving forward so
        // old tabs cannot write their pre-reset catalog back.
        const nextCatalog = createMinimumFinanceCatalog();
        nextCatalog.revision = current.categoryCatalog[0].revision + 1;
        const nextPreferences = {
          id: 'finance-settings', revision: current.financePreferences[0].revision + 1,
          generation: current.financePreferences[0].generation + 1, defaults: [], budgetSchedules: [],
          budgetOverrides: [], entryPreferences: createDefaultEntryPreferences(), dataset,
        };
        const next = Object.fromEntries(FINANCE_STORES.map((name) => [name, []]));
        next.categoryCatalog = [nextCatalog]; next.financePreferences = [nextPreferences];
        validateFinanceSnapshot(next);
        tx.objectStore(FINANCE_RECOVERY_STORE).put({ id: 'last-operation', dataset, action: 'reset', createdAt: new Date().toISOString(), afterToken: financeSnapshotToken(next), before: structuredClone(current), displayPreferences: displayPreferences === null ? null : structuredClone(displayPreferences), beforeSummary: validateFinanceSnapshot(current) });
        for (const name of FINANCE_STORES) {
          const store = tx.objectStore(name);
          store.clear();
          for (const item of next[name]) store.add(item);
        }
        return next;
      }, { readRecovery: false });
    },
    async restoreAcceptance(input, expectedToken, { formatVersion = 2, importMode = 'replace' } = {}) {
      if (mode !== 'acceptance') throw new Error('正式還原啟用條件尚未完成。');
      if (!['replace', 'merge'].includes(importMode)) throw new Error('匯入方式無效。');
      await initializeOnce();
      const data = structuredClone(input); validateFinanceSnapshot(data);
      if (data.financePreferences[0].dataset !== 'acceptance') throw new Error('只能還原合成驗證備份。');
      if (!Array.isArray(data.financePreferences[0].budgetSchedules)) data.financePreferences[0].budgetSchedules = [];
      if (!Array.isArray(data.financePreferences[0].budgetOverrides)) data.financePreferences[0].budgetOverrides = [];
      const backupHasEntryPreferences = Boolean(data.financePreferences[0].entryPreferences);
      if (!backupHasEntryPreferences) data.financePreferences[0].entryPreferences = createDefaultEntryPreferences();
      return transact(true, (current, { tx }) => {
        validateFinanceSnapshot(current);
        if (!expectedToken || financeSnapshotToken(current) !== expectedToken) { const error = new Error('預覽後已有新資料，還原取消；請重新選檔。'); error.code = 'FINANCE_CONFLICT'; throw error; }
        if (importMode === 'merge') {
          const merged = mergeFinanceSnapshots(current, data);
          if (!merged.hasChanges) return current;
          merged.data.categoryCatalog[0].revision = Math.max(current.categoryCatalog[0].revision, data.categoryCatalog[0].revision) + 1;
          validateFinanceSnapshot(merged.data);
          tx.objectStore(FINANCE_RECOVERY_STORE).put({ id: 'last-operation', dataset: 'acceptance', action: 'merge', createdAt: new Date().toISOString(), afterToken: financeSnapshotToken(merged.data), before: structuredClone(current), displayPreferences: null, beforeSummary: validateFinanceSnapshot(current) });
          for (const name of FINANCE_STORES) {
            const oldIds = new Set(current[name].map((item) => item.id)); const store = tx.objectStore(name);
            for (const item of merged.data[name]) if (!oldIds.has(item.id) || stableJson(current[name].find((prior) => prior.id === item.id)) !== stableJson(item)) store.put(item);
          }
          return merged.data;
        }
        const currentHasBudgets = (current.financePreferences[0].budgetSchedules || []).length > 0 || (current.financePreferences[0].budgetOverrides || []).length > 0;
        const backupHasBudgetFields = Array.isArray(data.financePreferences[0].budgetSchedules) && Array.isArray(data.financePreferences[0].budgetOverrides);
        if (currentHasBudgets && (formatVersion < 3 || !backupHasBudgetFields)) throw new Error('這份舊備份不含每月預算；為避免遺失現有預算，已拒絕完整還原。');
        const currentEntryPreferences = current.financePreferences[0].entryPreferences || createDefaultEntryPreferences();
        if (!backupHasEntryPreferences && stableJson(entryPreferenceConfiguration(currentEntryPreferences)) !== stableJson(entryPreferenceConfiguration(createDefaultEntryPreferences()))) throw new Error('這份舊備份不含已保存的記帳偏好；為避免遺失目前設定，已拒絕完整還原。');
        if (formatVersion < 5 && hasV5ReminderFields(current)) throw new Error('這份舊備份沒有定期收支的新欄位；為避免遺失目前提醒設定，已拒絕完整還原。請使用格式 5 備份。');
        if (hasTypedAccountDefaults(current) && formatVersion < 6
          && stableJson(entryPreferenceConfiguration(data.financePreferences[0].entryPreferences)) !== stableJson(entryPreferenceConfiguration(current.financePreferences[0].entryPreferences))) throw new Error('這份舊備份沒有分開保存收入與支出的通用帳戶；為避免遺失目前設定，已拒絕完整還原。請使用格式 6 備份。');
        for (const name of ['categoryCatalog', 'financePreferences', 'accounts', 'reminderRules', 'reminderOccurrences']) {
          const old = new Map(current[name].map((item) => [item.id, item.revision]));
          for (const item of data[name]) { item.revision = Math.max(item.revision, old.get(item.id) || 0) + 1; if (!Number.isSafeInteger(item.revision)) throw new Error('版本超出範圍。'); }
        }
        data.financePreferences[0].generation = Math.max(current.financePreferences[0].generation, data.financePreferences[0].generation) + 1;
        validateFinanceSnapshot(data);
        tx.objectStore(FINANCE_RECOVERY_STORE).put({ id: 'last-operation', dataset: 'acceptance', action: 'replace', createdAt: new Date().toISOString(), afterToken: financeSnapshotToken(data), before: structuredClone(current), displayPreferences: null, beforeSummary: validateFinanceSnapshot(current) });
        for (const name of FINANCE_STORES) {
          const store = tx.objectStore(name); store.clear();
          for (const item of data[name]) store.add(item);
        }
        return data;
      });
    },
    async restoreOfficial(input, expectedToken, { formatVersion = 3, importMode = 'replace' } = {}) {
      if (mode !== 'official') throw new Error('正式還原只能由正式資料存取入口執行。');
      const developmentPreviewAllowed = !OFFICIAL_FINANCE_ENABLED && allowDevelopmentPreview === true && isFinancePreviewEnabled(environment);
      const officialDataOperationsAvailable = OFFICIAL_FINANCE_ENABLED || developmentPreviewAllowed;
      if (!['replace', 'merge'].includes(importMode)) throw new Error('匯入方式無效。');
      if (importMode === 'merge' && !officialDataOperationsAvailable) throw new Error('目前資料環境未開放加入備份。');
      await initializeOnce();
      const data = structuredClone(input); validateFinanceSnapshot(data);
      if (data.financePreferences[0].dataset !== 'official') throw new Error('正式資料只接受標示為 official 的完整八集合備份。');
      if (!Array.isArray(data.financePreferences[0].budgetSchedules)) data.financePreferences[0].budgetSchedules = [];
      if (!Array.isArray(data.financePreferences[0].budgetOverrides)) data.financePreferences[0].budgetOverrides = [];
      const backupHasEntryPreferences = Boolean(data.financePreferences[0].entryPreferences);
      if (!backupHasEntryPreferences) data.financePreferences[0].entryPreferences = createDefaultEntryPreferences();
      return transact(true, (current, { tx }) => {
        validateFinanceSnapshot(current);
        if (current.financePreferences[0].dataset !== 'official') throw new Error('目前資料庫來源不符，已拒絕還原。');
        if (!expectedToken || financeSnapshotToken(current) !== expectedToken) { const error = new Error('預覽後資料已變更，還原取消；請重新檢查備份摘要。'); error.code = 'FINANCE_CONFLICT'; throw error; }
        if (importMode === 'merge') {
          if (!officialDataOperationsAvailable || formatVersion !== 6) throw new Error('加入備份需要格式 6 的完整備份；請重新選取最新版備份。');
          const merged = mergeFinanceSnapshots(current, data);
          if (!merged.hasChanges) return current;
          merged.data.categoryCatalog[0].revision = Math.max(current.categoryCatalog[0].revision, data.categoryCatalog[0].revision) + 1;
          if (!Number.isSafeInteger(merged.data.categoryCatalog[0].revision)) throw new Error('分類版本超出範圍；資料沒有變更。');
          validateFinanceSnapshot(merged.data);
          if (officialDataOperationsAvailable) tx.objectStore(FINANCE_RECOVERY_STORE).put({ id: 'last-operation', dataset: 'official', action: 'merge', createdAt: new Date().toISOString(), afterToken: financeSnapshotToken(merged.data), before: structuredClone(current), displayPreferences: null, beforeSummary: validateFinanceSnapshot(current) });
          for (const name of FINANCE_STORES) {
            const currentRows = new Map(current[name].map((item) => [item.id, item]));
            const store = tx.objectStore(name);
            for (const item of merged.data[name]) {
              const previous = currentRows.get(item.id);
              if (!previous || stableJson(previous) !== stableJson(item)) store.put(item);
            }
          }
          return merged.data;
        }
        const currentHasBudgets = (current.financePreferences[0].budgetSchedules || []).length > 0 || (current.financePreferences[0].budgetOverrides || []).length > 0;
        const backupHasBudgetFields = Array.isArray(data.financePreferences[0].budgetSchedules) && Array.isArray(data.financePreferences[0].budgetOverrides);
        if (currentHasBudgets && (formatVersion < 3 || !backupHasBudgetFields)) throw new Error('這份舊備份不含每月預算；為避免遺失現有預算，已拒絕完整還原。');
        const currentEntryPreferences = current.financePreferences[0].entryPreferences || createDefaultEntryPreferences();
        if (!backupHasEntryPreferences && stableJson(entryPreferenceConfiguration(currentEntryPreferences)) !== stableJson(entryPreferenceConfiguration(createDefaultEntryPreferences()))) throw new Error('這份舊備份不含已保存的記帳偏好；為避免遺失目前設定，已拒絕完整還原。');
        if (formatVersion < 5 && hasV5ReminderFields(current)) throw new Error('這份舊備份沒有定期收支的新欄位；為避免遺失目前提醒設定，已拒絕完整還原。請使用格式 5 備份。');
        if (hasTypedAccountDefaults(current) && formatVersion < 6
          && stableJson(entryPreferenceConfiguration(data.financePreferences[0].entryPreferences)) !== stableJson(entryPreferenceConfiguration(current.financePreferences[0].entryPreferences))) throw new Error('這份舊備份沒有分開保存收入與支出的通用帳戶；為避免遺失目前設定，已拒絕完整還原。請使用格式 6 備份。');
        for (const name of ['categoryCatalog', 'financePreferences', 'accounts', 'reminderRules', 'reminderOccurrences']) {
          const old = new Map(current[name].map((item) => [item.id, item.revision]));
          for (const item of data[name]) { item.revision = Math.max(item.revision, old.get(item.id) || 0) + 1; if (!Number.isSafeInteger(item.revision)) throw new Error('版本超出範圍。'); }
        }
        data.financePreferences[0].generation = Math.max(current.financePreferences[0].generation, data.financePreferences[0].generation) + 1;
        validateFinanceSnapshot(data);
        if (officialDataOperationsAvailable) tx.objectStore(FINANCE_RECOVERY_STORE).put({ id: 'last-operation', dataset: 'official', action: 'replace', createdAt: new Date().toISOString(), afterToken: financeSnapshotToken(data), before: structuredClone(current), displayPreferences: null, beforeSummary: validateFinanceSnapshot(current) });
        for (const name of FINANCE_STORES) { const store = tx.objectStore(name); store.clear(); for (const item of data[name]) store.add(item); }
        return data;
      });
    },
    async getRecoveryPoint() {
      if (!localRecoveryAvailable()) return null;
      await initializeOnce();
      return transact(false, (current, { recoveryPoint }) => {
        if (!recoveryPoint || recoveryPoint.dataset !== dataset) return null;
        validateFinanceSnapshot(recoveryPoint.before);
        return { action: recoveryPoint.action, createdAt: recoveryPoint.createdAt, afterToken: recoveryPoint.afterToken, beforeSummary: recoveryPoint.beforeSummary, displayPreferences: recoveryPoint.displayPreferences ?? null };
      }, { readRecovery: true });
    },
    async undoLastOperation(expectedToken, { confirmation } = {}) {
      if (!localRecoveryAvailable()) throw new Error('目前資料環境尚未開放本機復原。');
      if (confirmation !== '復原上一個操作') throw new Error('復原確認無效；資料未變更。');
      await initializeOnce();
      return transact(true, (current, { tx, recoveryPoint }) => {
        validateFinanceSnapshot(current);
        if (!recoveryPoint || recoveryPoint.dataset !== dataset || !expectedToken || financeSnapshotToken(current) !== expectedToken || recoveryPoint.afterToken !== expectedToken) throw new Error('上次操作後的資料已有變動，為避免刪掉新紀錄，快速復原已停止；請使用先前下載的 JSON 備份。');
        const restored = structuredClone(recoveryPoint.before); validateFinanceSnapshot(restored);
        restored.categoryCatalog[0].revision = Math.max(restored.categoryCatalog[0].revision, current.categoryCatalog[0].revision) + 1;
        const restoredSettings = restored.financePreferences[0]; const currentSettings = current.financePreferences[0];
        restoredSettings.revision = Math.max(restoredSettings.revision, currentSettings.revision) + 1;
        restoredSettings.generation = Math.max(restoredSettings.generation, currentSettings.generation) + 1;
        for (const name of ['accounts', 'reminderRules', 'reminderOccurrences']) {
          const currentById = new Map(current[name].map((item) => [item.id, item]));
          for (const item of restored[name]) item.revision = Math.max(item.revision, currentById.get(item.id)?.revision || 0) + 1;
        }
        validateFinanceSnapshot(restored);
        for (const name of FINANCE_STORES) { const store = tx.objectStore(name); store.clear(); for (const item of restored[name]) store.add(item); }
        tx.objectStore(FINANCE_RECOVERY_STORE).delete('last-operation');
        return restored;
      }, { readRecovery: true });
    },
  };
}
