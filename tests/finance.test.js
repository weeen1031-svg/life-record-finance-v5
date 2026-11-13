import { createStorageFixture } from './helpers/storage-fixture.js';
import { createCategoryStore } from '../scripts/category-store.js';
import { createExpenseRecord, createIncomeRecord, EXPENSE_DATABASE_VERSION } from '../scripts/storage/expense-db.js';
import { createFinanceRepository, openFinanceDatabase, financeSnapshotToken, migrateFinanceSchema, ACCEPTANCE_DATABASE_VERSION, OFFICIAL_FINANCE_ENABLED, ACCEPTANCE_DATABASE_NAME } from '../scripts/finance/repository.js';
import { applyFinanceCommand, accountBalances, accountDeletionBlockReason, validateFinanceSnapshot, parseWholeTwd, reminderStatus, resolveDefaultAccount, createMinimumFinanceCatalog, FINANCE_STORES } from '../scripts/finance/model.js';
import { createFinanceBackup, validateFinanceBackup } from '../scripts/finance/backup.js';
import { mergeFinanceSnapshots } from '../scripts/finance/merge.js';
import { calculateMonthlyBudgets } from '../scripts/finance/budget.js';
import { createFinanceController as createFinanceControllerForMode, resolveFinanceControllerMode } from '../scripts/finance/controller.js';
import { createAcceptanceV3FixtureData, holdAcceptanceV3Connection, saveAcceptanceV3CategoryCatalog, seedAcceptanceV3Fixture } from '../scripts/finance/acceptance-v3-fixture.js';
import { validateOfficialSnapshot } from '../scripts/storage/expense-db.js';
import { stableJson } from '../scripts/storage/json-data.js';
import { ACCOUNT_ORDER_KEY, attachAccountOrderInteractions, loadAccountOrder, moveAccountOrder, normalizeAccountOrder, saveAccountOrder } from '../scripts/finance/account-order.js';
import { BUDGET_ORDER_KEY, attachBudgetOrderInteractions, budgetOrderKey, loadBudgetOrder, moveBudgetOrder, normalizeBudgetOrder, saveBudgetOrder } from '../scripts/finance/budget-order.js';
import { renderAccountsScreen } from '../scripts/finance/screens.js';
import { getEntryDraftCategoryIssue, syncOfficialCategoryCache } from '../scripts/finance/category-cache.js';
import { OVERVIEW_PREFERENCES_KEY, defaultOverviewPreferences } from '../scripts/ui/overview-preferences.js';
import { createBackupPageState, renderLedgerBackupPage } from '../scripts/pages/ledger-backup.js';

const assert = (condition, message = 'assertion failed') => { if (!condition) throw new Error(message); };
const same = (a, b) => assert(stableJson(a) === stableJson(b), '原始資料或關聯改變');
// These tests exercise isolated data unless a case explicitly selects official mode.
const createFinanceController = (onChange, options = {}) => createFinanceControllerForMode(onChange, { mode: 'acceptance', ...options });
async function rejects(action, fragment = '') { try { await action(); } catch (error) { assert(!fragment || error.message.includes(fragment), `錯誤原因不符：${error.message}`); return; } throw new Error('沒有拒絕不安全操作'); }
const context = { today: '2026-11-05', now: '2026-11-05T00:00:00.000Z', expectedGeneration: 0 };
const key = (n) => `entry_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = (kind, n, extra = {}) => ({ kind, idempotencyKey: key(n), date: '2026-01-01', ...extra });
async function setup({ old = false } = {}) {
  const store = createCategoryStore();
  const draft = { type: 'expense', amount: '10', date: '2026-01-01', note: '合成舊資料', idempotencyKey: key(900) };
  const expense = createExpenseRecord({ draft, category: store.getCategory('cat-food'), subcategory: store.getSubcategory('sub-lunch') });
  const income = createIncomeRecord({ draft: { ...draft, type: 'income', idempotencyKey: key(901) }, category: store.getCategory('income-part-time'), subcategory: store.getSubcategory('sub-income-wage') });
  const expenses = old ? [{ ...expense, amountMinor: 1050 }] : [];
  const incomes = old ? [{ ...income, amountMinor: 1050 }] : [];
  // Most finance command tests need a populated existing catalog. Keep them
  // on a v3 baseline; separate coverage below verifies genuinely fresh v4.
  const fixture = createStorageFixture({ version: 3, expenses, incomes, catalog: store.exportCatalog() });
  const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
  const data = await repository.initialize();
  return { fixture, repository, data, original: { expenses, incomes, catalog: store.exportCatalog() } };
}
function createCatalogV3Fixture() {
  return createStorageFixture({ version: 3, catalog: createCategoryStore().exportCatalog() });
}
async function accounts(setupResult) {
  const { repository } = setupResult;
  let result = await repository.execute(command('create-account', 1, { name: '合成現金', type: 'cash', openingTwd: 1000 }), context);
  result = await repository.execute(command('create-account', 2, { name: '合成銀行', type: 'bank', openingTwd: 2000 }), context);
  return result.data;
}
const record = (n, accountId, extra = {}) => command('record', n, { entryType: 'expense', categoryId: 'cat-food', subcategoryId: 'sub-lunch', amountTwd: 100, accountId, ...extra });
const expectedFinanceBackupData = (data) => {
  const copy = structuredClone(data);
  const preferences = copy.financePreferences?.[0]?.entryPreferences;
  if (preferences) preferences.preferredAccountIds ||= {
    expense: preferences.preferredAccountId || '',
    income: preferences.preferredAccountId || '',
  };
  return copy;
};
function attachDownloadFixture(environment) {
  const downloads = [];
  environment.URL = { createObjectURL: (blob) => { downloads.blob = blob; return 'blob:finance-backup'; }, revokeObjectURL() {} };
  environment.Blob = class { constructor(parts, options) { this.parts = parts; this.type = options?.type || ''; } };
  environment.document = { createElement: (tag) => ({ tagName: tag, click() { downloads.push({ filename: this.download, href: this.href }); } }) };
  environment.setTimeout = () => 0;
  return downloads;
}

export async function runFinanceTests() {
  const tests = []; const test = (name, action) => tests.push({ name, action });
  test('V3 備份頁使用可存取的深色選檔器並顯示檔名與驗證狀態', () => {
    const state = { ...createBackupPageState(), catalogReady: true, selectedBackupName: 'LifeRecord.json', fileValidationStatus: '格式驗證通過' };
    const html = renderLedgerBackupPage(state);
    assert(html.includes('class="finance-file-picker"') && html.includes('type="file"') && html.includes('data-backup-file'), 'V3 匯入沒有使用原生檔案選擇器');
    assert(html.includes('LifeRecord.json') && html.includes('格式驗證通過') && html.includes('role="status"'), '選檔名稱或驗證狀態沒有顯示');
  });
  test('帳戶顯示順序只保存識別碼偏好、讀回穩定且不改財務資料', async () => {
    const values = new Map(); const accessed = [];
    const environment = { location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/' }, localStorage: {
      getItem(keyName) { accessed.push(keyName); return values.get(keyName) ?? null; },
      setItem(keyName, value) { accessed.push(keyName); values.set(keyName, value); },
    } };
    const accountsList = [{ id: 'wallet' }, { id: 'bank-post' }, { id: 'bank-main' }];
    const moved = moveAccountOrder(['wallet', 'bank-post', 'bank-main'], 'bank-main', 'up');
    assert(moved.join('|') === 'wallet|bank-main|bank-post', 'keyboard reorder did not move adjacent account');
    saveAccountOrder(moved, environment, 'acceptance');
    const loaded = loadAccountOrder(environment, 'acceptance');
    assert(loaded.error === '' && normalizeAccountOrder(accountsList, loaded.ids).join('|') === moved.join('|'), 'account display order did not persist');
    assert(ACCOUNT_ORDER_KEY === 'LifeRecord_UI_AccountOrder_v1' && accessed.every((item) => item === `${ACCOUNT_ORDER_KEY}_acceptance`), 'order preference accessed an unrelated browser key');
    assert(normalizeAccountOrder([...accountsList, { id: 'new-cash' }], loaded.ids).at(-1) === 'new-cash', 'new account should append without losing saved ordering');
    const wrongOrigin = { ...environment, location: { origin: 'http://localhost:5510', pathname: '/' } };
    await rejects(() => saveAccountOrder(moved, wrongOrigin, 'acceptance'));
  });
  test('聚焦帳戶卡片可用上下方向鍵排序並保存偏好', async () => {
    const values = new Map(); const storage = { getItem: (keyName) => values.get(keyName) ?? null, setItem: (keyName, value) => values.set(keyName, value) };
    const parent = { cards: [], insertBefore(node, reference) { this.cards.splice(this.cards.indexOf(node), 1); const index = reference ? this.cards.indexOf(reference) : this.cards.length; this.cards.splice(index, 0, node); } };
    parent.cards = ['acct-a', 'acct-b', 'acct-c'].map((id) => ({ dataset: { accountSortItem: id }, parentElement: parent, classList: { add() {}, remove() {} }, getBoundingClientRect() { return { left: 0, top: parent.cards.indexOf(this) * 100, width: 240, height: 80 }; }, animate() {}, closest(selector) { return selector.includes('finance-account-grid') ? parent : selector.includes('data-account-sort-item') ? this : null; }, querySelector() { return { textContent: this.dataset.accountSortItem }; }, get previousElementSibling() { return parent.cards[parent.cards.indexOf(this) - 1] || null; }, get nextElementSibling() { return parent.cards[parent.cards.indexOf(this) + 1] || null; } }));
    const handlers = {}; const status = { dataset: {}, textContent: '' };
    const root = { addEventListener: (name, handler) => { handlers[name] = handler; }, querySelectorAll: () => parent.cards, querySelector: () => status };
    const document = { elementFromPoint: () => null };
    const environment = { document, location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/' }, localStorage: storage, matchMedia: () => ({ matches: false }) };
    let saved = [];
    attachAccountOrderInteractions(root, { environment, mode: 'acceptance', onSaved: (ids) => { saved = ids; } });
    let prevented = false;
    handlers.keydown({ key: 'ArrowUp', target: parent.cards[1], preventDefault() { prevented = true; } });
    assert(prevented && parent.cards.map((card) => card.dataset.accountSortItem).join('|') === 'acct-b|acct-a|acct-c', 'keyboard move did not reorder focused card');
    assert(saved.join('|') === 'acct-b|acct-a|acct-c' && JSON.parse(values.get(`${ACCOUNT_ORDER_KEY}_acceptance`)).ids[0] === 'acct-b', 'keyboard order did not persist');
  });
  test('每月預算卡片依月份保存排序、鍵盤可排序且新項目接在後方', async () => {
    const values = new Map(); const storage = { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) };
    const environment = { location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/' }, localStorage: storage };
    const budgets = [
      { id: 'budget-a', categoryId: 'cat-a', subcategoryId: '' },
      { id: 'budget-b', categoryId: 'cat-b', subcategoryId: '' },
      { id: 'budget-c', categoryId: 'cat-c', subcategoryId: '' },
    ];
    saveBudgetOrder(['budget-b', 'budget-a'], '2026-11', environment, 'acceptance');
    const loaded = loadBudgetOrder(environment, 'acceptance', '2026-11');
    assert(normalizeBudgetOrder(budgets, loaded.ids).join('|') === 'cat-b::|cat-a::|cat-c::', 'new budget rows were not appended after saved order');
    assert(loadBudgetOrder(environment, 'acceptance', '2026-12').ids.length === 0
      && loadBudgetOrder(environment, 'official', '2026-11').ids.length === 0, 'budget ordering leaked across month or data mode');
    assert(moveBudgetOrder(['a', 'b', 'c'], 'c', 'up').join('|') === 'a|c|b' && BUDGET_ORDER_KEY === 'LifeRecord_UI_BudgetOrder_v1', 'budget keyboard order helper is incorrect');
    const wrongOrigin = { ...environment, location: { origin: 'http://localhost:5510', pathname: '/' } };
    await rejects(() => saveBudgetOrder(['budget-a'], '2026-11', wrongOrigin, 'acceptance'));

    const handlers = {}; const status = { dataset: {}, textContent: '' };
    const list = { dataset: { budgetMonth: '2026-11' }, cards: [], querySelectorAll: () => list.cards, querySelector: () => status,
      insertBefore(node, reference) { list.cards.splice(list.cards.indexOf(node), 1); const index = reference ? list.cards.indexOf(reference) : list.cards.length; list.cards.splice(index, 0, node); } };
    list.cards = ['budget-a', 'budget-b', 'budget-c'].map((id) => ({ dataset: { budgetSortItem: id }, parentElement: list, isConnected: true,
      closest(selector) { return selector.includes('finance-budget-card-list') ? list : selector.includes('data-budget-sort-item') ? this : null; },
      getBoundingClientRect() { return { left: 0, top: list.cards.indexOf(this) * 100, width: 280, height: 80 }; },
      getAnimations: () => [], animate() {}, classList: { add() {}, remove() {} }, get previousElementSibling() { return list.cards[list.cards.indexOf(this) - 1] || null; }, get nextElementSibling() { return list.cards[list.cards.indexOf(this) + 1] || null; } }));
    const root = { addEventListener(name, handler) { handlers[name] = handler; }, removeEventListener() {} };
    const domEnvironment = { ...environment, document: { elementFromPoint: () => null }, matchMedia: () => ({ matches: false }) };
    let savedMonth = ''; let savedIds = [];
    attachBudgetOrderInteractions(root, { environment: domEnvironment, mode: 'acceptance', onSaved: (month, ids) => { savedMonth = month; savedIds = ids; } });
    let prevented = false;
    handlers.keydown({ key: 'ArrowUp', target: list.cards[1], preventDefault() { prevented = true; } });
    assert(prevented && list.cards.map((row) => row.dataset.budgetSortItem).join('|') === 'budget-b|budget-a|budget-c', 'focused card keyboard sort did not change visible order');
    assert(savedMonth === '2026-11' && savedIds.join('|') === 'budget-b|budget-a|budget-c'
      && JSON.parse(values.get(`${BUDGET_ORDER_KEY}_acceptance_2026-11`)).ids.join('|') === savedIds.join('|'), 'budget keyboard order was not persisted for the current month');
  });
  test('帳戶卡片採用顯示偏好排序且轉帳只更換方向圖示', async () => {
    const base = await setup(); const data = await accounts(base); const before = stableJson(data);
    const state = { data, accountView: '', accountOrder: [...data.accounts].reverse().map((item) => item.id), editingAccount: null, values: {}, busy: false };
    const h = {
      state, today: () => '2026-11-05', value: (form, field, fallback = '') => state.values[form]?.[field] ?? fallback,
      button: (action, label, attrs = '') => `<button data-finance-action="${action}" ${attrs}>${label}</button>`,
      input: (form, field, label) => `<label>${label}<input data-finance-form="${form}" data-finance-field="${field}"></label>`,
      select: (form, field, label) => `<label>${label}<select data-finance-form="${form}" data-finance-field="${field}"></select></label>`,
      accounts: () => [], section: (title, content) => `<section><h2>${title}</h2>${content}</section>`, money: (amount) => String(amount),
    };
    const reordered = renderAccountsScreen(h);
    assert(reordered.indexOf(`data-account-sort-item="${data.accounts[1].id}"`) < reordered.indexOf(`data-account-sort-item="${data.accounts[0].id}"`), 'account cards did not follow display order');
    assert(reordered.includes('data-account-sortable') && reordered.includes('aria-keyshortcuts="ArrowUp ArrowDown"') && reordered.includes('finance-account-order-help') && !reordered.includes('data-finance-action="move-account-order"'), 'account cards must retain accessible keyboard sorting without visible move buttons');
    state.accountView = 'transfer';
    const transfer = renderAccountsScreen(h);
    assert(transfer.includes('finance-transfer-arrow') && transfer.includes('arrowLeftRight') === false && /finance-transfer-arrow[^>]*>\s*<svg/.test(transfer), 'transfer direction icon not rendered as a horizontal icon');
    const expectedIds = state.accountOrder;
    const fromIds = [...transfer.matchAll(/data-field="fromAccountId" data-account-id="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
    const toIds = [...transfer.matchAll(/data-field="toAccountId" data-account-id="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
    assert(fromIds.join('|') === expectedIds.join('|') && toIds.join('|') === expectedIds.join('|'), 'transfer selectors did not follow the same persisted account order as cards');
    state.accountView = 'adjustment';
    const adjustment = renderAccountsScreen(h);
    const adjustmentIds = [...adjustment.matchAll(/data-field="accountId" data-account-id="([^"]*)"/g)].map((match) => match[1]).filter(Boolean);
    assert(adjustmentIds.join('|') === expectedIds.join('|'), 'adjustment selector did not follow the card order');
    assert(stableJson(data) === before, 'display reordering altered account/ledger data');
  });
  test('正式 V5 閘門開啟正式資料庫並包含本機復原集合', async () => {
    const fixture = createStorageFixture({ version: 0 });
    const db = await openFinanceDatabase({ environment: fixture.environment });
    assert(OFFICIAL_FINANCE_ENABLED && fixture.openCalls.length === 1
      && fixture.openCalls[0].name === 'LifeRecord_Official_V1'
      && fixture.version === 5 && db.objectStoreNames.contains('financeRecovery')
      && EXPENSE_DATABASE_VERSION === 3, '正式 V5 資料庫未開啟或遺漏安全復原集合');
  });
  test('Finance Controller 預設連接 V5 正式來源，隔離來源仍需明確指定', async () => {
    assert(resolveFinanceControllerMode(false) === 'acceptance' && resolveFinanceControllerMode(true) === 'official', 'controller mode did not follow the official gate');
    assert(resolveFinanceControllerMode() === 'official' && OFFICIAL_FINANCE_ENABLED, 'current official V5 gate is not active');
  });
  test('帳戶可刪除僅含起始異動且無引用的帳戶，並保留其他異動順序', async () => {
    const s = await setup(); let data = await accounts(s);
    let result = await s.repository.execute(command('create-account', 120, { name: '可刪除測試帳戶', type: 'cash', openingTwd: 500 }), context);
    data = result.data; const removable = data.accounts.at(-1);
    result = await s.repository.execute(command('create-account', 130, { name: '較晚建立的保留帳戶', type: 'bank', openingTwd: 250 }), context);
    data = result.data;
    assert(accountDeletionBlockReason(data, removable.id) === '', 'an unused account with only its opening event should be eligible');
    result = await s.repository.execute({ kind: 'delete-account', accountId: removable.id, expectedRevision: removable.revision, confirmed: true }, context);
    data = result.data;
    assert(!data.accounts.some((item) => item.id === removable.id) && !data.accountEvents.some((event) => event.lines.some((line) => line.accountId === removable.id)), 'safe removal must atomically remove its opening event');
    assert(data.accountEvents.every((event, index) => event.sequence === index + 1) && data.accounts.some((item) => item.name === '較晚建立的保留帳戶'), 'removal must retain later accounts and restore contiguous event order');
    validateFinanceSnapshot(data);

    result = await s.repository.execute(command('create-account', 121, { name: '預設引用帳戶', type: 'cash', openingTwd: 0 }), context); data = result.data;
    const defaulted = data.accounts.at(-1);
    result = await s.repository.execute(command('set-default', 122, { entryType: 'expense', categoryId: 'cat-food', accountId: defaulted.id, expectedRevision: data.financePreferences[0].revision }), context); data = result.data;
    await rejects(() => s.repository.execute({ kind: 'delete-account', accountId: defaulted.id, expectedRevision: defaulted.revision, confirmed: true }, context), '預設設定');
    assert(data.accounts.some((item) => item.id === defaulted.id), 'default reference must preserve account');
    result = await s.repository.execute(command('create-account', 128, { name: '通用偏好引用帳戶', type: 'bank', openingTwd: 0 }), context); data = result.data;
    const preferred = data.accounts.at(-1);
    result = await s.repository.execute(command('set-entry-preferences', 129, { defaultEntryType: 'expense', dateMode: 'today', preferredAccountId: preferred.id, expectedRevision: data.financePreferences[0].revision }), context); data = result.data;
    await rejects(() => s.repository.execute({ kind: 'delete-account', accountId: preferred.id, expectedRevision: preferred.revision, confirmed: true }, context), '預設設定');
  });
  test('交易異動或提醒預設引用的帳戶不可永久刪除', async () => {
    const s = await setup(); let data = await accounts(s);
    const cash = data.accounts[0];
    data = (await s.repository.execute(record(123, cash.id), context)).data;
    assert(accountDeletionBlockReason(data, cash.id), 'posted transaction and movement must block deletion');
    await rejects(() => s.repository.execute({ kind: 'delete-account', accountId: cash.id, expectedRevision: cash.revision, confirmed: true }, context), '異動紀錄');

    const other = await setup();
    let otherData = await other.repository.execute(command('create-account', 124, { name: '提醒引用帳戶', type: 'bank', openingTwd: 0 }), context).then((row) => row.data);
    const bank = otherData.accounts[0];
    otherData = (await other.repository.execute(command('create-reminder', 125, { name: '測試提醒', entryType: 'expense', amountTwd: 10, date: '2026-11-05', repeat: 'once', advanceDays: 1, note: '', entryDefaults: { categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: bank.id, paymentMethod: 'direct' } }), context)).data;
    assert(accountDeletionBlockReason(otherData, bank.id).includes('提醒'), 'reminder default reference must be detected');
  });
  test('帳戶刪除中止會完整回復，且保留帳戶與起始異動', async () => {
    const s = await setup();
    const created = await s.repository.execute(command('create-account', 126, { name: '中止刪除測試', type: 'cash', openingTwd: 0 }), context);
    const account = created.data.accounts[0]; const before = stableJson(created.data); s.fixture.setAbortWrites(true);
    await rejects(() => s.repository.execute({ kind: 'delete-account', accountId: account.id, expectedRevision: account.revision, confirmed: true }, context));
    s.fixture.setAbortWrites(false); same(await s.repository.read(), created.data);
    assert(stableJson(await s.repository.read()) === before, 'aborted account deletion left partial changes');
  });
  test('錯誤來源及路徑不開啟任何資料庫', async () => {
    for (const location of [{ origin: 'http://127.0.0.1:5510', pathname: '/' }, { origin: 'https://friend.github.io', pathname: '/other/' }]) {
      const fixture = createStorageFixture({ version: 0 }); fixture.environment.location = location;
      await rejects(() => openFinanceDatabase({ mode: 'acceptance', environment: fixture.environment })); assert(!fixture.openCalls.length);
    }
  });
  test('開啟入口只使用新的固定資料庫；初始化不產生收支', async () => {
    const { fixture, data } = await setup(); assert(fixture.storeNames.length === 9 && !data.accounts.length && !data.expenses.length);
    assert(ACCEPTANCE_DATABASE_VERSION === 5 && fixture.openCalls.every((item) => item.name === ACCEPTANCE_DATABASE_NAME && item.version === ACCEPTANCE_DATABASE_VERSION));
  });
  test('既有隔離財務 v4 升至內部 v5 只新增復原集合，不改原八集合內容', () => {
    const configs = {
      expenses: { byIdempotencyKey: ['idempotencyKey', true, false], byOccurredOn: ['occurredOn', false, false], byCategoryId: ['categoryId', false, false], bySubcategoryId: ['subcategoryId', false, false] },
      incomes: { byIdempotencyKey: ['idempotencyKey', true, false], byOccurredOn: ['occurredOn', false, false], byCategoryId: ['categoryId', false, false], bySubcategoryId: ['subcategoryId', false, false] },
      categoryCatalog: {}, accounts: {}, financePreferences: {}, reminderRules: {},
      accountEvents: { byIdempotencyKey: ['idempotencyKey', true, false], byAccountId: ['accountIds', false, true], byOccurredOn: ['occurredOn', false, false], byEntryId: ['entryId', true, false] },
      reminderOccurrences: { byPeriod: ['periodKey', true, false], byRuleId: ['ruleId', false, false], byDueDate: ['dueDate', false, false], byEntryId: ['entryId', true, false] },
      financeRecovery: {},
    };
    const storeNames = (values) => Object.assign([...values], { contains: (name) => values.includes(name) });
    const definitions = new Map(FINANCE_STORES.map((name) => [name, { keyPath: 'id', autoIncrement: false, indexes: Object.fromEntries(Object.entries(configs[name]).map(([index, [keyPath, unique, multiEntry]]) => [index, { keyPath, unique, multiEntry }])), records: [{ id: `${name}-keep`, marker: name }] }]));
    const metadata = (definition) => ({ keyPath: definition.keyPath, autoIncrement: definition.autoIncrement, indexNames: storeNames(Object.keys(definition.indexes)), index(name) { return definition.indexes[name]; }, createIndex(name, keyPath, options = {}) { definition.indexes[name] = { keyPath, unique: options.unique === true, multiEntry: options.multiEntry === true }; } });
    const db = { get objectStoreNames() { return storeNames([...definitions.keys()]); }, createObjectStore(name, options) { const definition = { keyPath: options.keyPath, autoIncrement: false, indexes: {}, records: [] }; definitions.set(name, definition); return metadata(definition); } };
    const transaction = { objectStore(name) { return metadata(definitions.get(name)); } };
    const prior = new Map([...definitions].map(([name, definition]) => [name, structuredClone(definition.records)]));
    migrateFinanceSchema(db, transaction, 4, 'acceptance');
    assert(db.objectStoreNames.length === 9 && db.objectStoreNames.contains('financeRecovery'), 'v5 did not add the recovery store');
    for (const name of FINANCE_STORES) same(definitions.get(name).records, prior.get(name));
  });
  test('全新資料庫首次使用與隔離歸零共用兩組最小其他分類', async () => {
    const fixture = createStorageFixture({ version: 0 });
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const initial = await repository.initialize();
    same(initial.categoryCatalog[0], createMinimumFinanceCatalog());
    assert(initial.expenses.length === 0 && initial.incomes.length === 0 && initial.accounts.length === 0, '首次使用產生了交易或帳戶');
    assert(initial.categoryCatalog[0].categories.map((item) => `${item.entryType}:${item.id}`).join('|') === 'expense:cat-other-expense|income:cat-other-income', '收入與支出沒有保留各自不同的大分類 ID');
    assert(initial.categoryCatalog[0].subcategories.map((item) => `${item.entryType}:${item.categoryIds[0]}:${item.id}`).join('|') === 'expense:cat-other-expense:sub-other-expense|income:cat-other-income:sub-other-income', '收入與支出沒有保留各自有效且分開的子分類關聯');
    assert(initial.categoryCatalog[0].categories.every((item) => item.name === '其他') && initial.categoryCatalog[0].subcategories.every((item) => item.name === '未分類'), '首次使用或隔離歸零的最低分類名稱錯誤');
    const reset = await repository.resetAcceptance(financeSnapshotToken(initial), { confirmation: '重設合成資料', backupSaved: true });
    same(reset.categoryCatalog[0], createMinimumFinanceCatalog(1));
    assert(reset.financePreferences[0].entryPreferences.preferredAccountIds.expense === '' && reset.financePreferences[0].entryPreferences.preferredAccountIds.income === '', '最小基準以外建立了付款帳戶預設');
  });
  test('原生 v3 驗收基準使用固定合成收入、支出與有效分類；確認不足或錯誤來源不開啟資料庫', async () => {
    const fixtureData = createAcceptanceV3FixtureData();
    const summary = validateOfficialSnapshot(fixtureData);
    assert(summary.expenses === 1 && summary.incomes === 1 && fixtureData.expenses[0].amountMinor === 1050);
    assert(fixtureData.expenses[0].note.includes('合成') && fixtureData.incomes[0].note.includes('合成'));
    const fixture = createStorageFixture({ version: 0 });
    await rejects(() => seedAcceptanceV3Fixture({ environment: fixture.environment, confirmation: '' }), '確認');
    assert(fixture.openCalls.length === 0, '未確認時嘗試開啟資料庫');
    fixture.environment.location = { origin: 'http://localhost:5510', pathname: '/' };
    await rejects(() => seedAcceptanceV3Fixture({ environment: fixture.environment, confirmation: '建立隔離測試資料' }));
    assert(fixture.openCalls.length === 0, '錯誤來源嘗試開啟資料庫');
  });
  test('v3 舊分頁保持工具只允許已存在且相容的 v3，錯誤來源不開啟資料庫', async () => {
    const fixtureData = createAcceptanceV3FixtureData();
    const heldFixture = createStorageFixture({ version: 3, expenses: fixtureData.expenses, incomes: fixtureData.incomes, catalog: fixtureData.categoryCatalog[0] });
    const db = await holdAcceptanceV3Connection({ environment: heldFixture.environment });
    assert(db.version === 3 && heldFixture.version === 3, '保持舊連線不應升級'); db.close();
    const wrong = createStorageFixture({ version: 3, expenses: fixtureData.expenses, incomes: fixtureData.incomes, catalog: fixtureData.categoryCatalog[0] });
    wrong.environment.location = { origin: 'http://localhost:5510', pathname: '/' };
    await rejects(() => holdAcceptanceV3Connection({ environment: wrong.environment }));
    assert(wrong.openCalls.length === 0, '錯誤來源嘗試開啟資料庫');
  });
  test('明確建立 v3 基準只建立固定三集合、可重試核對但不自行升級或覆蓋', async () => {
    const fixture = createStorageFixture({ version: 0 });
    const first = await seedAcceptanceV3Fixture({ environment: fixture.environment, confirmation: '建立隔離測試資料' });
    assert(first.seeded && fixture.version === 3 && fixture.storeNames.length === 3, 'seed 操作不應自行升級至 v4');
    same(fixture.dump('expenses'), first.data.expenses); same(fixture.dump('incomes'), first.data.incomes);
    assert(fixture.dump('expenses')[0].amountMinor === 1050, '舊分金額未原值保留');
    const retry = await seedAcceptanceV3Fixture({ environment: fixture.environment, confirmation: '建立隔離測試資料' });
    assert(!retry.seeded && fixture.dump('expenses').length === 1 && fixture.dump('incomes').length === 1, '重試不得重複寫入');
    assert(fixture.openCalls.every((item) => item.name === ACCEPTANCE_DATABASE_NAME && item.version === 3), '建立基準只可開啟固定驗收資料庫 v3');
    const sourceData = createAcceptanceV3FixtureData(); const mismatch = structuredClone(sourceData); mismatch.expenses[0].note = '其他既有合成內容';
    const occupied = createStorageFixture({ version: 3, expenses: mismatch.expenses, incomes: mismatch.incomes, catalog: mismatch.categoryCatalog[0] });
    const occupiedBefore = occupied.dump('expenses');
    await rejects(() => seedAcceptanceV3Fixture({ environment: occupied.environment, confirmation: '建立隔離測試資料' }), '不同');
    same(occupied.dump('expenses'), occupiedBefore);
    const wrongPath = createStorageFixture({ version: 0 });
    wrongPath.environment.location = { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/lab/finance/' };
    await rejects(() => seedAcceptanceV3Fixture({ environment: wrongPath.environment, confirmation: '建立隔離測試資料' }));
    assert(wrongPath.openCalls.length === 0, '錯誤路徑嘗試開啟資料庫');
    const lateBlocked = createStorageFixture({ version: 0, blocked: true });
    await rejects(() => seedAcceptanceV3Fixture({ environment: lateBlocked.environment, confirmation: '建立隔離測試資料' }), '正被其他分頁使用');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(lateBlocked.version === 0 && lateBlocked.storeNames.length === 0, 'v3 建立請求在 blocked 後仍留下部分資料庫結構');
  });
  test('隔離 v3 分類可用共用模型編輯，原生升級同庫保留新分類 ID 與全部舊資料', async () => {
    const original = createAcceptanceV3FixtureData();
    const fixture = createStorageFixture({ version: 3, expenses: original.expenses, incomes: original.incomes, catalog: original.categoryCatalog[0] });
    const editor = createCategoryStore({ catalog: original.categoryCatalog[0], ready: true });
    const category = editor.addCategory({ name: '測試1', entryType: 'expense', icon: 'tag', color: '#8795A7' });
    const child = editor.addIndependentSubcategory(category.id, '測試1 子分類');
    const nextCatalog = editor.exportCatalog(); nextCatalog.revision += 1;
    const saved = await saveAcceptanceV3CategoryCatalog({ environment: fixture.environment, catalog: nextCatalog, expectedRevision: original.categoryCatalog[0].revision });
    const beforeUpgrade = { expenses: fixture.dump('expenses'), incomes: fixture.dump('incomes') };
    assert(fixture.version === 3 && saved.categories.some((item) => item.id === category.id && item.name === '測試1'), 'v3 category save changed the version or lost the category');
    assert(saved.subcategories.some((item) => item.id === child.id && item.categoryIds.includes(category.id)), 'v3 category save lost the valid child link');
    await rejects(() => saveAcceptanceV3CategoryCatalog({ environment: fixture.environment, catalog: nextCatalog, expectedRevision: original.categoryCatalog[0].revision }), '另一個分頁');
    const checked = await seedAcceptanceV3Fixture({ environment: fixture.environment, confirmation: '建立隔離測試資料' });
    assert(!checked.seeded && checked.data.categoryCatalog[0].categories.some((item) => item.id === category.id), 'repeat baseline check did not return the user-entered v3 category');
    same(fixture.dump('expenses'), beforeUpgrade.expenses); same(fixture.dump('incomes'), beforeUpgrade.incomes);
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const upgraded = await repository.initialize();
    assert(fixture.version === 5 && upgraded.categoryCatalog[0].categories.some((item) => item.id === category.id), 'v3→v4 finance schema upgrade did not preserve the custom category');
    assert(upgraded.categoryCatalog[0].subcategories.some((item) => item.id === child.id && item.categoryIds.includes(category.id)), 'v3→v4 upgrade did not preserve the subcategory relation');
    same(upgraded.expenses, beforeUpgrade.expenses); same(upgraded.incomes, beforeUpgrade.incomes);
    assert(fixture.openCalls.every((call) => call.name === ACCEPTANCE_DATABASE_NAME), 'v3 classification test accessed a different or official database');
  });
  test('驗收頁可先在隔離 v3 建立分類，升級後預算、提醒及分類預設共用同一 ID', async () => {
    const fixture = createStorageFixture({ version: 0 });
    const controller = createFinanceController(() => {}, { environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (financeAction, extra = {}) => controller.click({ dataset: { financeAction, ...extra } });
    input('v3fixture', 'confirmation', '建立隔離測試資料');
    await click('seed-v3-fixture');
    assert(controller.renderSetting('acceptance').includes('隔離 v3 測試分類'), 'v3 category editor did not appear after creating the isolated baseline');
    input('candidate-category', 'entryType', 'expense'); input('candidate-category', 'name', '測試1');
    input('candidate-category', 'icon', 'tag'); input('candidate-category', 'color', '#8795A7');
    await click('create-candidate-category');
    let catalog = fixture.dump('categoryCatalog')[0];
    const category = catalog.categories.find((item) => item.name === '測試1');
    assert(fixture.version === 3 && category, 'test category was not saved into the isolated v3 database');
    input('catalog', 'categoryId', category.id); input('catalog', 'subcategoryName', '測試1 子分類');
    await click('add-candidate-subcategory');
    catalog = fixture.dump('categoryCatalog')[0];
    const child = catalog.subcategories.find((item) => item.name === '測試1 子分類');
    assert(child?.categoryIds.includes(category.id), 'test subcategory did not keep its valid category relation');
    input('gate', 'confirmation', '合成測試'); await click('connect');
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const upgraded = await repository.read();
    assert(fixture.version === 5 && upgraded.categoryCatalog[0].categories.some((item) => item.id === category.id), 'upgrade did not preserve the v3 category ID');
    assert(upgraded.categoryCatalog[0].subcategories.some((item) => item.id === child.id && item.categoryIds.includes(category.id)), 'upgrade did not preserve the subcategory link');
    input('budget', 'categoryId', category.id);
    const budget = controller.renderSetting('budget');
    await click('choose-reminder-category', { form: 'reminder', categoryId: category.id });
    await click('choose-reminder-subcategory', { form: 'reminder', subcategoryId: child.id });
    const reminders = controller.render('reminders');
    const defaults = controller.renderSetting('defaults');
    assert(budget.includes(`data-category-id="${category.id}"`) && budget.includes(`data-subcategory-id="${child.id}"`), 'budget did not offer the upgraded category and child');
    assert(reminders.includes(`data-category-id="${category.id}"`) && reminders.includes(`data-subcategory-id="${child.id}"`), 'reminders did not offer the upgraded category and child');
    assert(defaults.includes(`data-category-id="${category.id}"`), 'category defaults did not offer the upgraded category');
    assert(fixture.openCalls.every((call) => call.name === ACCEPTANCE_DATABASE_NAME), 'end-to-end classification flow accessed a database other than the isolated acceptance database');
  });
  test('v3→v4 財務 schema 加入五集合並附加本機復原集合，舊收支與小數金額原樣保留', async () => {
    const { fixture, data, original } = await setup({ old: true }); assert(fixture.version === 5 && fixture.storeNames.length === 9);
    same(data.expenses, original.expenses); same(data.incomes, original.incomes); same(data.categoryCatalog[0], original.catalog);
    assert(data.expenses[0].accountId === undefined && data.expenses[0].amountMinor === 1050);
  });
  test('不相容舊結構及 blocked 後解除阻擋拒絕，不重建或升級資料庫', async () => {
    const bad = createStorageFixture({ version: 3, incompatible: true });
    await rejects(() => openFinanceDatabase({ mode: 'acceptance', environment: bad.environment })); assert(bad.version === 3 && bad.storeNames.length === 3);
    const original = createAcceptanceV3FixtureData();
    const blocked = createStorageFixture({ version: 3, blocked: true, expenses: original.expenses, incomes: original.incomes, catalog: original.categoryCatalog[0] });
    await rejects(() => openFinanceDatabase({ mode: 'acceptance', environment: blocked.environment }), '阻擋');
    assert(blocked.version === 3 && blocked.storeNames.length === 3, 'blocked request continued the later versionchange upgrade');
    same(blocked.dump('expenses'), original.expenses); same(blocked.dump('incomes'), original.incomes); same(blocked.dump('categoryCatalog'), original.categoryCatalog);
  });
  test('blocked 後 versionchange 才到達時中止升級，v3 原始資料仍完整', async () => {
    const original = createAcceptanceV3FixtureData();
    const fixture = createStorageFixture({ version: 3, blocked: true, expenses: original.expenses, incomes: original.incomes, catalog: original.categoryCatalog[0] });
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    await rejects(() => repository.initialize(), '阻擋');
    assert(fixture.version === 3 && fixture.storeNames.length === 3, 'late upgrade event did not abort its versionchange transaction');
    same(fixture.dump('expenses'), original.expenses); same(fixture.dump('incomes'), original.incomes); same(fixture.dump('categoryCatalog'), original.categoryCatalog);
  });
  test('blocked 開啟立即結束等待；延後到達的升級仍中止且可重試', async () => {
    const original = createAcceptanceV3FixtureData();
    const fixture = createStorageFixture({ version: 3, blocked: true, holdBlocked: true, expenses: original.expenses, incomes: original.incomes, catalog: original.categoryCatalog[0] });
    const statuses = [];
    const outcome = await Promise.race([
      openFinanceDatabase({ mode: 'acceptance', environment: fixture.environment, onOpenStatus: (status) => statuses.push(status) }).then(() => ({ opened: true }), (error) => ({ error })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
    ]);
    assert(outcome.error?.code === 'FINANCE_DATABASE_BLOCKED' && !outcome.timeout, 'blocked open did not return a retryable error promptly');
    assert(outcome.error.message.includes('最終版本尚未確認') && fixture.version === 3, 'blocked state claimed an upgrade was cancelled or left the known database changed');
    fixture.releaseBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(fixture.version === 3 && fixture.storeNames.length === 3, 'late upgrade committed after the caller had stopped waiting');
    same(fixture.dump('expenses'), original.expenses); same(fixture.dump('incomes'), original.incomes); same(fixture.dump('categoryCatalog'), original.categoryCatalog);
    assert(statuses.some((status) => status.state === 'blocked') && statuses.some((status) => status.state === 'blocked-settled' && status.databaseVersion === 3), 'late cancellation did not report the actual v3 state');
    fixture.setBlocked(false);
    const reopened = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    assert((await reopened.initialize()).financePreferences.length === 1 && fixture.version === 5, 'retry after releasing the old connection did not complete initialization');
  });
  test('v3 升級初始化與結構同一交易；容量失敗保留 v3，重新開啟可重試', async () => {
    const original = createAcceptanceV3FixtureData();
    const fixture = createStorageFixture({ version: 3, expenses: original.expenses, incomes: original.incomes, catalog: original.categoryCatalog[0] });
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    fixture.setAbortUpgrades(true);
    const error = await (async () => { try { await repository.initialize(); } catch (caught) { return caught; } throw new Error('升級容量錯誤未拒絕'); })();
    assert(error.databaseVersion === 3 && error.message.includes('v3'), '升級失敗沒有回報實際 v3 版本');
    assert(fixture.version === 3 && fixture.storeNames.length === 3, '中止的 versionchange 留下部分 v4 結構');
    same(fixture.dump('expenses'), original.expenses); same(fixture.dump('incomes'), original.incomes); same(fixture.dump('categoryCatalog'), original.categoryCatalog);
    fixture.setAbortUpgrades(false);
    const reopened = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const upgraded = await reopened.initialize();
    assert(fixture.version === 5 && upgraded.financePreferences.length === 1, '重新開啟後未完整建立 v4 財務設定與 v5 復原集合');
    same(upgraded.expenses, original.expenses); same(upgraded.incomes, original.incomes); same(upgraded.categoryCatalog, original.categoryCatalog);
  });
  test('v4 設定初始化中止後不開放資料，重新開啟可補齊且保留帳戶與異動', async () => {
    const s = await setup(); const withAccount = await accounts(s);
    const partial = { id: 'finance-settings', revision: 4, generation: 7, dataset: 'acceptance' };
    s.fixture.replaceRecords('financePreferences', [partial]);
    const repository = createFinanceRepository({ mode: 'acceptance', environment: s.fixture.environment });
    s.fixture.setAbortWrites(true);
    const error = await (async () => { try { await repository.initialize(); } catch (caught) { return caught; } throw new Error('初始化中止未拒絕'); })();
    assert(error.databaseVersion === 5 && error.message.includes('v5'), 'v4 財務資料庫初始化失敗沒有回報隔離資料庫實際版本');
    same(s.fixture.dump('financePreferences'), [partial]); same(s.fixture.dump('accounts'), withAccount.accounts); same(s.fixture.dump('accountEvents'), withAccount.accountEvents);
    s.fixture.setAbortWrites(false);
    const repaired = await repository.initialize();
    assert(repaired.financePreferences[0].revision === 4 && repaired.financePreferences[0].generation === 7 && repaired.financePreferences[0].entryPreferences, '重試沒有只補足缺少的設定欄位');
    same(repaired.accounts, withAccount.accounts); same(repaired.accountEvents, withAccount.accountEvents);
  });
  test('分類快取收到新目錄後立即同步；失效選取顯示警告但保留草稿', async () => {
    const source = createCategoryStore(); const view = createCategoryStore();
    assert(syncOfficialCategoryCache(view, source.exportCatalog()).ok, '初始目錄快取同步失敗');
    const added = source.addCategory({ name: '測試1', entryType: 'expense', icon: 'tag', color: '#8795A7' });
    const child = source.addIndependentSubcategory(added.id, '測試1子分類');
    const nextCatalog = source.exportCatalog(); nextCatalog.revision += 1;
    assert(syncOfficialCategoryCache(view, nextCatalog).changed, '快取沒有偵測到目錄 revision 變更');
    assert(view.getCategory(added.id)?.name === '測試1' && view.isSubcategorySelectable(added.id, child.id), '新大分類或子分類沒有在共用目錄立即可見');
    const draft = { type: 'expense', categoryId: added.id, subcategoryId: child.id, amount: '1200', note: '保留草稿', accountId: 'cash-id' };
    source.setCategoryHidden(added.id, true); const hidden = source.exportCatalog(); hidden.revision += 1;
    syncOfficialCategoryCache(view, hidden);
    assert(getEntryDraftCategoryIssue(hidden, draft).includes('草稿內容已保留'), '失效分類沒有清楚要求重新選擇');
    assert(draft.categoryId === added.id && draft.subcategoryId === child.id && draft.amount === '1200' && draft.note === '保留草稿' && draft.accountId === 'cash-id', '分類刷新清除了使用者草稿');
  });
  test('同一候選目錄刷新後，預算、提醒與分類預設立即共用新分類；失效時保留各頁草稿', async () => {
    const s = await setup(); let lastPublished = null;
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment, onData: (data, context) => { lastPublished = { data, context }; } });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    controller.input({ dataset: { financeForm: 'budget', financeField: 'amountTwd' }, value: '8888' });
    controller.input({ dataset: { financeForm: 'budget', financeField: 'categoryId' }, value: 'cat-food' });
    controller.input({ dataset: { financeForm: 'reminder', financeField: 'name' }, value: '保留提醒草稿' });
    controller.input({ dataset: { financeForm: 'reminder', financeField: 'amountTwd' }, value: '690' });
    const before = await s.repository.read();
    const editor = createCategoryStore({ catalog: before.categoryCatalog[0], ready: true });
    const added = editor.addCategory({ name: '測試1', entryType: 'expense', icon: 'tag', color: '#8795A7' });
    const child = editor.addIndependentSubcategory(added.id, '測試1子分類');
    const catalog = editor.exportCatalog(); catalog.revision += 1;
    await s.repository.execute({ kind: 'save-category-catalog', catalog, expectedRevision: before.categoryCatalog[0].revision }, { ...context, expectedGeneration: before.financePreferences[0].generation });
    await controller.onEnter();
    assert(lastPublished?.data.categoryCatalog[0].categories.some((item) => item.id === added.id), 'controller 沒有發布最新分類目錄');
    assert(controller.renderSetting('budget').includes(`data-category-id="${added.id}"`), '預算選擇器看不到新增分類');
    await controller.click({ dataset: { financeAction: 'choose-reminder-category', form: 'reminder', categoryId: added.id } });
    await controller.click({ dataset: { financeAction: 'choose-reminder-subcategory', form: 'reminder', subcategoryId: child.id } });
    assert(controller.render('reminders').includes(`data-category-id="${added.id}"`) && controller.render('reminders').includes(`data-subcategory-id="${child.id}"`), '提醒選擇器看不到新增分類及子分類');
    await controller.click({ dataset: { financeAction: 'choose-default-type', entryType: 'expense' } });
    await controller.click({ dataset: { financeAction: 'choose-default-category', categoryId: added.id } });
    assert(controller.renderSetting('defaults').includes(`data-category-id="${added.id}"`), '分類預設帳戶看不到新增分類');
    assert(controller.renderSetting('budget').includes('value="8888"') && controller.render('reminders').includes('保留提醒草稿'), '重新讀取覆蓋了金額或提醒草稿');

    const current = await s.repository.read();
    const currentEditor = createCategoryStore({ catalog: current.categoryCatalog[0], ready: true });
    currentEditor.setCategoryHidden(added.id, true); const hidden = currentEditor.exportCatalog(); hidden.revision += 1;
    await s.repository.execute({ kind: 'save-category-catalog', catalog: hidden, expectedRevision: current.categoryCatalog[0].revision }, { ...context, expectedGeneration: current.financePreferences[0].generation });
    controller.input({ dataset: { financeForm: 'budget', financeField: 'categoryId' }, value: added.id });
    controller.input({ dataset: { financeForm: 'budget', financeField: 'subcategoryId' }, value: child.id });
    controller.input({ dataset: { financeForm: 'budget', financeField: 'amountTwd' }, value: '8888' });
    await controller.onEnter();
    const budgetAfterHide = controller.renderSetting('budget');
    assert(budgetAfterHide.includes('草稿內容已保留') && budgetAfterHide.includes('value="8888"'), '分類失效後沒有保留預算草稿並提示重選');
  });
  test('FinanceBackup 6 還原需先預覽與輸入確認，再經中央二次確認；取消不寫入', async () => {
    const s = await setup(); let restorePublished = false; let lastChange = {}; const downloads = attachDownloadFixture(s.fixture.environment);
    const controller = createFinanceController((change) => { lastChange = change; }, { environment: s.fixture.environment, onData: (_data, context) => { if (context.reason === 'restore') restorePublished = true; } });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    let data = await s.repository.read();
    data = (await s.repository.execute(command('create-account', 995, { name: '還原基準帳戶', type: 'cash', openingTwd: 250 }), { ...context, expectedGeneration: data.financePreferences[0].generation })).data;
    await controller.click({ dataset: { financeAction: 'reload' } });
    const backup = await createFinanceBackup(data); const checkedBackup = await validateFinanceBackup(backup.text); const chosen = { name: 'LifeRecord-test.json', size: backup.text.length, text: async () => backup.text };
    const fileInput = { hasAttribute: (name) => name === 'data-finance-file', files: [chosen] };
    const previewAndOpen = async () => {
      await controller.file(fileInput);
      const previewHtml = controller.renderSetting('ledger');
      assert(previewHtml.includes('備份已通過驗證') && previewHtml.includes('下載目前資料完整備份'), '設定頁沒有顯示驗證摘要或事前備份步驟');
      assert(previewHtml.includes('data-finance-import-preview-dialog') && previewHtml.includes('role="dialog" aria-modal="true"')
        && previewHtml.includes('>覆蓋目前資料</label>') && previewHtml.includes('>加入新資料</label>'), '匯入預覽與覆蓋／加入選項沒有在中央彈窗中顯示');
      assert(controller.renderSetting('ledger').includes('LifeRecord-test.json') && controller.renderSetting('ledger').includes('格式與資料關聯驗證通過') && lastChange.preserveScroll, '選檔沒有顯示檔名／驗證狀態或造成捲動跳位');
      await controller.click({ dataset: { financeAction: 'export-before-restore' } });
      assert(downloads.at(-1)?.filename.includes('LifeRecord_Acceptance_FinanceBackup_') && downloads.at(-1)?.filename.includes('_'), '匯入前備份檔名缺少環境或時間');
      controller.input({ dataset: { financeForm: 'restore', financeField: 'backupSaved' }, type: 'checkbox', checked: true });
      controller.input({ dataset: { financeForm: 'restore', financeField: 'confirmation' }, value: '還原合成資料' });
      await controller.click({ dataset: { financeAction: 'restore' } });
      const finalHtml = controller.render('backup');
      assert(finalHtml.includes('data-finance-restore-dialog') && !finalHtml.includes('data-finance-import-preview-dialog'), '沒有切換到單一中央最終確認視窗');
    };
    await previewAndOpen();
    const beforeCancel = await s.repository.read();
    await controller.click({ dataset: { financeAction: 'cancel-restore-final' } });
    same(await s.repository.read(), beforeCancel); assert(!restorePublished, '取消最終確認仍執行還原');
    await previewAndOpen();
    await controller.click({ dataset: { financeAction: 'confirm-restore-final' } });
    const restored = await s.repository.read();
    const expectedRestored = structuredClone(checkedBackup.data);
    for (const name of ['categoryCatalog', 'financePreferences', 'accounts', 'reminderRules', 'reminderOccurrences']) {
      const old = new Map(beforeCancel[name].map((item) => [item.id, item.revision]));
      for (const item of expectedRestored[name]) item.revision = Math.max(item.revision, old.get(item.id) || 0) + 1;
    }
    expectedRestored.financePreferences[0].generation = Math.max(beforeCancel.financePreferences[0].generation, expectedRestored.financePreferences[0].generation) + 1;
    same(restored, expectedRestored); assert(restorePublished, '最終確認成功後沒有發布還原後資料供應用程式刷新快取');
  });
  test('設定頁快速備份下載含時間與環境且不改資料；無效匯入保持原狀', async () => {
    const s = await setup(); let lastChange = {}; const downloads = attachDownloadFixture(s.fixture.environment);
    const controller = createFinanceController((change) => { lastChange = change; }, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    const before = await s.repository.read();
    await controller.click({ dataset: { financeAction: 'export' } });
    assert(lastChange.preserveScroll === true && lastChange.focus !== true, '快速備份完成時沒有保留捲動位置');
    assert(downloads.at(-1)?.filename.startsWith('LifeRecord_Acceptance_FinanceBackup_') && /_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\dZ\.json$/.test(downloads.at(-1).filename), '快速備份檔名缺少日期、時間或資料環境');
    const downloaded = await validateFinanceBackup(downloads.blob.parts[0]);
    assert(downloaded.summary.dataset === 'acceptance', '下載內容的資料環境與畫面不符');
    same(await s.repository.read(), before);
    await controller.file({ hasAttribute: (name) => name === 'data-finance-file', files: [{ size: 10, text: async () => '{invalid' }] });
    same(await s.repository.read(), before);
    assert(controller.renderSetting('ledger').includes('JSON 格式無效') || controller.renderSetting('ledger').includes('無法解析'), '無效備份沒有顯示錯誤');
  });
  test('起始餘額可追溯但不列收入，可改名停用恢復，不改開帳金額', async () => {
    const s = await setup(); let data = await accounts(s); const item = data.accounts[0];
    assert(accountBalances(data).get(item.id) === 1000n && !data.incomes.length && data.accountEvents[0].type === 'opening');
    data = (await s.repository.execute({ kind: 'edit-account', accountId: item.id, expectedRevision: 1, name: '合成改名', active: false }, context)).data;
    assert(!data.accounts[0].active && data.accounts[0].revision === 2);
    await rejects(() => s.repository.execute(record(3, item.id), context), '帳戶');
    data = (await s.repository.execute({ kind: 'edit-account', accountId: item.id, expectedRevision: 2, name: '合成改名', active: true }, context)).data;
    assert(data.accounts[0].active && data.accountEvents.length === 2);
    await rejects(() => s.repository.execute({ kind: 'edit-account', accountId: item.id, expectedRevision: 1, name: '舊版本', active: true }, context), '重新讀取');
  });
  test('帳戶識別色使用既有帳戶欄位保存、讀回及 FinanceBackup 格式 5 往返，舊帳戶可省略顏色', async () => {
    const s = await setup();
    let data = (await s.repository.execute(command('create-account', 71, { name: '合成色彩現金', type: 'cash', color: '#6F9A8C', openingTwd: 125 }), context)).data;
    const account = data.accounts[0];
    assert(account.color === '#6F9A8C' && account.revision === 1 && accountBalances(data).get(account.id) === 125n, '帳戶顏色保存時改變了其他帳戶資料');
    data = (await s.repository.execute({ kind: 'edit-account', accountId: account.id, expectedRevision: account.revision, name: account.name, active: true, color: '#B18B72' }, context)).data;
    assert(data.accounts[0].color === '#B18B72' && data.accounts[0].id === account.id && data.accountEvents.length === 1, '修改識別色改變帳戶 ID 或新增了餘額異動');
    const backup = await createFinanceBackup(data); const checked = await validateFinanceBackup(backup.text);
    assert(checked.formatVersion === 6 && checked.data.accounts[0].color === '#B18B72', '格式 5 備份沒有保留帳戶識別色');
    await s.repository.restoreAcceptance(checked.data, financeSnapshotToken(data), { formatVersion: checked.formatVersion });
    assert((await s.repository.read()).accounts[0].color === '#B18B72', '還原後帳戶識別色遺失');
    const legacy = structuredClone(data); delete legacy.accounts[0].color; validateFinanceSnapshot(legacy);
    const invalid = structuredClone(data); invalid.accounts[0].color = '#000000';
    await rejects(() => Promise.resolve(validateFinanceSnapshot(invalid)), '識別色');
  });
  test('整數元精度與上限；拒絕浮點、空白及科學記號', () => {
    for (const bad of ['', '1.5', '1e3', 'NaN', '0', '-1', '9007199254740992']) assert(parseWholeTwd(bad) === null);
    assert(parseWholeTwd('123') === 123 && parseWholeTwd('-5', true) === -5 && parseWholeTwd('0', true) === 0);
  });
  test('新收支原子連動；簽帳金融卡扣銀行；收入支出分開', async () => {
    const s = await setup(); const data = await accounts(s); const [cash, bank] = data.accounts;
    await s.repository.execute(record(3, bank.id, { paymentMethod: 'debit-card' }), context);
    await s.repository.execute(record(4, cash.id, { entryType: 'income', categoryId: 'income-part-time', subcategoryId: 'sub-income-wage', amountTwd: 200 }), context);
    const actual = await s.repository.read(); assert(actual.expenses.length === 1 && actual.incomes.length === 1);
    assert(accountBalances(actual).get(bank.id) === 1900n && accountBalances(actual).get(cash.id) === 1200n);
    await rejects(() => s.repository.execute(record(5, cash.id, { paymentMethod: 'debit-card' }), context), '銀行');
  });
  test('正式分類保存保留穩定 ID 與歷史快照，並在交易中阻擋移除已引用關聯', async () => {
    const s = await setup({ old: true });
    const before = await s.repository.read();
    const rename = createCategoryStore({ catalog: before.categoryCatalog[0], ready: true });
    rename.updateCategory('cat-food', { name: '合成餐飲新名' });
    const renamed = rename.exportCatalog(); renamed.revision += 1;
    let result = await s.repository.execute({ kind: 'save-category-catalog', catalog: renamed, expectedRevision: before.categoryCatalog[0].revision }, context);
    assert(result.data.categoryCatalog[0].categories.find((item) => item.id === 'cat-food')?.name === '合成餐飲新名', '分類名稱或穩定 ID 遺失');
    assert(result.data.expenses[0].categoryNameSnapshot === '吃', '分類改名不應改寫舊交易快照');
    await rejects(() => s.repository.execute({ kind: 'save-category-catalog', catalog: renamed, expectedRevision: before.categoryCatalog[0].revision }, context), '其他分頁更新');
    const unlinked = structuredClone(result.data.categoryCatalog[0]);
    unlinked.subcategories.find((item) => item.id === 'sub-lunch').categoryIds = unlinked.subcategories.find((item) => item.id === 'sub-lunch').categoryIds.filter((id) => id !== 'cat-food');
    unlinked.revision += 1;
    const beforeUnsafeUnlink = await s.repository.read();
    await rejects(() => s.repository.execute({ kind: 'save-category-catalog', catalog: unlinked, expectedRevision: result.data.categoryCatalog[0].revision }, context));
    same(await s.repository.read(), beforeUnsafeUnlink);
  });
  test('前後端資料層仍要求有效兩層分類與關聯；早於起始日拒絕', async () => {
    const s = await setup(); const data = await accounts(s); const id = data.accounts[0].id;
    for (const extra of [{ categoryId: '' }, { subcategoryId: '' }, { subcategoryId: 'sub-income-wage' }, { amountTwd: '1.5' }, { date: '2025-12-31' }]) await rejects(() => s.repository.execute(record(3, id, extra), context));
    assert(!(await s.repository.read()).expenses.length);
  });
  test('允許負餘額並警告；同一冪等鍵只保存一次', async () => {
    const s = await setup(); const data = await accounts(s); const cmd = record(3, data.accounts[0].id, { amountTwd: 1500 });
    const result = await s.repository.execute(cmd, context); assert(result.warnings.length && accountBalances(result.data).get(data.accounts[0].id) === -500n);
    assert((await s.repository.execute(cmd, context)).status === 'duplicate'); assert((await s.repository.read()).expenses.length === 1);
  });
  test('轉帳與校正不影響收支，校正要求原因及最新餘額', async () => {
    const s = await setup(); const data = await accounts(s); const [cash, bank] = data.accounts;
    let result = await s.repository.execute(command('transfer', 3, { fromAccountId: cash.id, toAccountId: bank.id, amountTwd: 50 }), context);
    assert(accountBalances(result.data).get(cash.id) === 950n && accountBalances(result.data).get(bank.id) === 2050n);
    const adjustment = command('adjustment', 4, { accountId: cash.id, targetTwd: 900, expectedBalanceTwd: '950', note: '合成盤點差額' });
    result = await s.repository.execute(adjustment, context); assert(accountBalances(result.data).get(cash.id) === 900n && !result.data.expenses.length && !result.data.incomes.length);
    await rejects(() => s.repository.execute({ ...adjustment, idempotencyKey: key(5) }, context), '重新讀取');
    await rejects(() => s.repository.execute({ ...adjustment, idempotencyKey: key(6), expectedBalanceTwd: '900', note: '' }, context), '原因');
    await rejects(() => s.repository.execute(command('transfer', 7, { fromAccountId: cash.id, toAccountId: cash.id, amountTwd: 10 }), context));
  });
  test('分類預設帳戶保存、單筆切換，停用預設不再套用', async () => {
    const s = await setup(); const data = await accounts(s); const [cash, bank] = data.accounts;
    let result = await s.repository.execute({ kind: 'set-default', categoryId: 'cat-food', entryType: 'expense', accountId: bank.id, expectedRevision: 0 }, context);
    assert(resolveDefaultAccount(result.data, 'expense', 'cat-food') === bank.id);
    result = await s.repository.execute(record(3, cash.id), context); assert(result.data.expenses[0].accountId === cash.id);
    result = await s.repository.execute({ kind: 'edit-account', accountId: bank.id, expectedRevision: 1, name: bank.name, active: false }, context);
    assert(resolveDefaultAccount(result.data, 'expense', 'cat-food') === '');
  });
  test('分類預設草稿跨分類保留，不設定可明確保存且多筆變更原子提交', async () => {
    const fixture = createCatalogV3Fixture();
    const controller = createFinanceController(() => {}, { environment: fixture.environment });
    const click = (financeAction, extra = {}) => controller.click({ dataset: { financeAction, ...extra } });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await click('connect');
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    await repository.execute(command('create-account', 81, { name: '合成現金', type: 'cash', openingTwd: 100, date: '2026-01-01' }), context);
    await repository.execute(command('create-account', 82, { name: '合成銀行', type: 'bank', openingTwd: 200, date: '2026-01-01' }), context);
    let data = await repository.read(); const [cash, bank] = data.accounts;
    data = (await repository.execute({ kind: 'set-default', categoryId: 'cat-food', entryType: 'expense', accountId: bank.id, expectedRevision: data.financePreferences[0].revision }, context)).data;
    await click('reload');
    await click('choose-default-type', { entryType: 'expense' });
    await click('choose-default-category', { categoryId: 'cat-food' });
    await click('choose-default-account', { accountId: '' });
    await click('choose-default-category', { categoryId: 'cat-motorcycle' });
    await click('choose-default-account', { accountId: cash.id });
    await click('choose-default-category', { categoryId: 'cat-food' });
    let html = controller.renderSetting('defaults');
    assert(html.includes('data-account-id="" data-choice-card="account" aria-pressed="true"'), '切回「吃」後沒有顯示暫存的「不設定」');
    assert(html.includes('尚未儲存：') && html.includes('吃') && html.includes('機車') && controller.hasUnsavedDefaultDrafts(), '未保存分類沒有清楚列出');
    const before = await repository.read();
    fixture.setAbortWrites(true);
    await click('save-default');
    fixture.setAbortWrites(false);
    same(await repository.read(), before);
    assert(controller.hasUnsavedDefaultDrafts() && controller.renderSetting('defaults').includes('未完成：'), '失敗後分類草稿被清除或沒有錯誤回饋');
    await click('save-default');
    data = await repository.read();
    assert(!controller.hasUnsavedDefaultDrafts() && data.financePreferences[0].revision === before.financePreferences[0].revision + 1, '多分類保存沒有一次完成或只增加一次版本');
    assert(!data.financePreferences[0].defaults.some((item) => item.categoryId === 'cat-food') && data.financePreferences[0].defaults.some((item) => item.categoryId === 'cat-motorcycle' && item.accountId === cash.id), '「不設定」或第二個分類預設沒有正確寫入');
  });
  test('交易完成前不回報成功；abort/容量失敗不留部分收支或異動', async () => {
    const s = await setup(); const data = await accounts(s); const before = await s.repository.read();
    s.fixture.setAbortWrites(true); await rejects(() => s.repository.execute(record(3, data.accounts[0].id), context)); s.fixture.setAbortWrites(false);
    same(await s.repository.read(), before);
    s.fixture.setHoldWrites(true); let finished = false;
    const pending = s.repository.execute(record(4, data.accounts[0].id), context).then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0)); assert(!finished); s.fixture.releaseWrites(); await pending; s.fixture.setHoldWrites(false); assert(finished);
  });
  test('單次提醒不入帳，狀態含提前、當日、逾期；編輯取消可追溯', async () => {
    const s = await setup(); const before = await accounts(s);
    let data = (await s.repository.execute(command('create-reminder', 10, { name: '合成電話費', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-06' }), context)).data;
    const item = data.reminderOccurrences[0]; assert(reminderStatus(item, '2026-11-05') === '即將到期' && reminderStatus(item, '2026-11-06') === '今日到期' && reminderStatus(item, '2026-11-07') === '已逾期');
    same(data.accountEvents, before.accountEvents); assert(!data.expenses.length);
    data = (await s.repository.execute({ kind: 'edit-occurrence', occurrenceId: item.id, expectedRevision: 1, name: '合成修改', amountTwd: 120, date: '2026-11-08', note: '合成備註' }, context)).data;
    assert(data.reminderOccurrences[0].amountTwd === 120);
    data = (await s.repository.execute({ kind: 'cancel-occurrence', occurrenceId: item.id, expectedRevision: 2 }, context)).data;
    assert(data.reminderOccurrences[0].status === 'cancelled' && !data.expenses.length);
  });
  test('每月31日遇短月取月底、下月恢復；閏年及期次防重', async () => {
    const s = await setup();
    let data = (await s.repository.execute(command('create-reminder', 10, { name: '合成月底', entryType: 'income', amountTwd: 100, repeat: 'monthly', advanceDays: 1, date: '2024-01-31' }), { ...context, today: '2024-03-01' })).data;
    assert(data.reminderOccurrences.some((item) => item.dueDate === '2024-02-29') && data.reminderOccurrences.some((item) => item.dueDate === '2024-03-31'));
    const count = data.reminderOccurrences.length;
    data = (await s.repository.execute({ kind: 'refresh-reminders' }, { ...context, today: '2024-03-01' })).data; assert(data.reminderOccurrences.length === count);
    assert(data.reminderOccurrences.some((item) => reminderStatus(item, '2024-03-01') === '已逾期'));
  });
  test('定期項目保存分類／帳戶／付款方式快照；帳單日支援跨月、月底及不晚於期限', async () => {
    const s = await setup(); const data = await accounts(s); const cash = data.accounts.find((item) => item.type === 'cash');
    let result = await s.repository.execute(command('create-reminder', 31, { name: '合成月費', entryType: 'expense', amountTwd: 100, repeat: 'monthly', advanceDays: 1, date: '2026-11-05', entryDefaults: { categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: cash.id, paymentMethod: 'cash' }, billSchedule: { monthsBeforeDue: 0, day: 15 } }), context);
    let dataAfter = result.data; const rule = dataAfter.reminderRules[0]; const november = dataAfter.reminderOccurrences.find((item) => item.dueDate === '2026-11-05');
    assert(rule.entryDefaults.accountId === cash.id && rule.entryDefaults.paymentMethod === 'cash' && november.entryDefaults.categoryId === 'cat-food' && november.sourceRuleRevision === rule.revision && Array.isArray(november.overrides));
    assert(november.billDate === '2026-11-05', '帳單日期不可晚於付款期限');
    const s2 = await setup();
    dataAfter = (await s2.repository.execute(command('create-reminder', 32, { name: '合成跨月帳單', entryType: 'expense', amountTwd: 100, repeat: 'monthly', advanceDays: 1, date: '2024-03-30', billSchedule: { monthsBeforeDue: 1, day: 31 } }), { ...context, today: '2024-03-01' })).data;
    const march = dataAfter.reminderOccurrences.find((item) => item.dueDate === '2024-03-30');
    assert(march?.billDate === '2024-02-29', '跨月帳單日應使用閏年二月月底');
    const s3 = await setup();
    dataAfter = (await s3.repository.execute(command('create-reminder', 33, { name: '合成閏年年費', entryType: 'expense', amountTwd: 100, repeat: 'yearly', advanceDays: 1, date: '2024-02-29', billSchedule: { monthsBeforeDue: 1, day: 31 } }), { ...context, today: '2025-01-01' })).data;
    same(dataAfter.reminderOccurrences.map((item) => item.dueDate), ['2024-02-29', '2025-02-28', '2026-02-28']);
    same(dataAfter.reminderOccurrences.map((item) => item.billDate), ['2024-01-31', '2025-01-31', '2026-01-31']);
  });
  test('定期項目可不指定帳戶；確認正式入帳時仍須補選相符有效帳戶', async () => {
    const s = await setup(); const data = await accounts(s); const cash = data.accounts.find((item) => item.type === 'cash');
    const result = await s.repository.execute(command('create-reminder', 39, { name: '合成未指定帳戶', entryType: 'expense', amountTwd: 80, repeat: 'once', advanceDays: 1, date: '2026-11-06', entryDefaults: { categoryId: '', subcategoryId: '', accountId: '', paymentMethod: 'cash' } }), context);
    const occurrence = result.data.reminderOccurrences[0]; assert(occurrence.entryDefaults.accountId === '');
    await rejects(() => s.repository.execute(record(40, '', { reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision, paymentMethod: 'cash' }), context), '可使用的帳戶');
    const saved = await s.repository.execute(record(41, cash.id, { reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision, paymentMethod: 'cash' }), context);
    assert(saved.status === 'saved' && saved.data.reminderOccurrences[0].status === 'completed');
  });
  test('修改定期預設只影響未來未修改期次；保留今天、完成與個別覆寫', async () => {
    const s = await setup(); let data = await accounts(s); const cash = data.accounts[0];
    data = (await s.repository.execute(command('create-reminder', 34, { name: '合成月租', entryType: 'expense', amountTwd: 100, repeat: 'monthly', advanceDays: 1, date: '2026-10-05', entryDefaults: { categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: cash.id, paymentMethod: 'cash' } }), context)).data;
    const rule = data.reminderRules[0]; const october = data.reminderOccurrences.find((item) => item.dueDate === '2026-10-05');
    data = (await s.repository.execute(record(35, cash.id, { reminderOccurrenceId: october.id, expectedOccurrenceRevision: october.revision, date: '2026-10-05' }), context)).data;
    const december = data.reminderOccurrences.find((item) => item.dueDate === '2026-12-05');
    data = (await s.repository.execute({ kind: 'edit-occurrence', occurrenceId: december.id, expectedRevision: december.revision, name: '合成月租-本期', amountTwd: 150, date: december.dueDate, note: '本期調整' }, context)).data;
    data = (await s.repository.execute({ kind: 'refresh-reminders' }, { ...context, today: '2026-12-15' })).data;
    const january = data.reminderOccurrences.find((item) => item.dueDate === '2027-01-05');
    assert(january, '應自動建立下個月期次');
    data = (await s.repository.execute({ kind: 'edit-reminder', ruleId: rule.id, expectedRevision: rule.revision, name: '合成月租-新預設', amountTwd: 200, advanceDays: 2, note: '之後沿用', entryDefaults: { categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: cash.id, paymentMethod: 'cash' }, applyFuture: true }, context)).data;
    assert(data.reminderOccurrences.find((item) => item.dueDate === '2026-10-05').status === 'completed');
    assert(data.reminderOccurrences.find((item) => item.dueDate === '2026-11-05').amountTwd === 100, '今日期次不可被後續預設改寫');
    assert(data.reminderOccurrences.find((item) => item.dueDate === '2026-12-05').amountTwd === 150 && data.reminderOccurrences.find((item) => item.dueDate === '2026-12-05').name === '合成月租-本期', '個別修改值應保留');
    const updated = data.reminderOccurrences.find((item) => item.dueDate === '2027-01-05');
    assert(updated.amountTwd === 200 && updated.name === '合成月租-新預設' && updated.sourceRuleRevision === data.reminderRules[0].revision);
  });
  test('新增記帳與提醒卡確認共用期次入帳鍵，競速只建立一筆收支和異動', async () => {
    const s = await setup(); let data = await accounts(s); const accountId = data.accounts[0].id;
    data = (await s.repository.execute(command('create-reminder', 36, { name: '合成雙入口', entryType: 'expense', amountTwd: 25, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const item = data.reminderOccurrences[0]; const cmd = record(37, accountId, { reminderOccurrenceId: item.id, expectedOccurrenceRevision: item.revision, date: '2026-11-05' });
    const first = await s.repository.execute(cmd, context); const second = await s.repository.execute(cmd, context);
    assert(first.status === 'saved' && second.status === 'duplicate');
    const current = await s.repository.read();
    assert((await s.repository.execute({ kind: 'link-reminder', occurrenceId: item.id, expectedRevision: item.revision, entryId: current.expenses[0].id, confirmed: true }, context)).status === 'duplicate');
    const saved = await s.repository.read(); assert(saved.expenses.length === 1 && saved.accountEvents.filter((row) => row.type === 'expense').length === 1 && saved.reminderOccurrences[0].status === 'completed');
  });
  test('有定期收支預設引用時，分類刪除或解除子分類關聯會被阻擋', async () => {
    const s = await setup(); let data = await accounts(s); const accountId = data.accounts[0].id;
    data = (await s.repository.execute(command('create-reminder', 38, { name: '合成分類引用', entryType: 'expense', amountTwd: 20, repeat: 'once', advanceDays: 1, date: '2026-11-05', entryDefaults: { categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId, paymentMethod: 'cash' } }), context)).data;
    const catalog = structuredClone(data.categoryCatalog[0]); catalog.revision += 1; catalog.subcategories.find((item) => item.id === 'sub-lunch').categoryIds = ['cat-other'];
    for (const category of catalog.categories) if (category.subcategoryOrder) category.subcategoryOrder = category.subcategoryOrder.filter((id) => catalog.subcategories.find((item) => item.id === id)?.categoryIds.includes(category.id));
    await rejects(() => s.repository.execute({ kind: 'save-category-catalog', expectedRevision: data.categoryCatalog[0].revision, catalog }, context), '定期收支');
  });
  test('手動確認提醒原子入帳且只能一次，重複確認不再變動餘額', async () => {
    const s = await setup(); const initial = await accounts(s);
    let data = (await s.repository.execute(command('create-reminder', 10, { name: '合成提醒', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const item = data.reminderOccurrences[0]; const cmd = record(11, initial.accounts[0].id, { reminderOccurrenceId: item.id, expectedOccurrenceRevision: 1, date: '2026-11-05' });
    const before = await s.repository.read(); s.fixture.setAbortWrites(true); await rejects(() => s.repository.execute(cmd, context)); s.fixture.setAbortWrites(false); same(await s.repository.read(), before);
    data = (await s.repository.execute(cmd, context)).data; assert(data.reminderOccurrences[0].status === 'completed' && data.expenses.length === 1 && data.expenses[0].reminderOccurrenceId === item.id);
    assert((await s.repository.execute(cmd, context)).status === 'duplicate'); assert((await s.repository.read()).expenses.length === 1);
  });
  test('停止後續只取消今天之後的待辦；保留已完成、今日與歷史期次', async () => {
    const s = await setup(); const initial = await accounts(s);
    let data = (await s.repository.execute(command('create-reminder', 10, { name: '合成月費', entryType: 'expense', amountTwd: 100, repeat: 'monthly', advanceDays: 1, date: '2026-10-05' }), context)).data;
    const rule = data.reminderRules[0]; const item = data.reminderOccurrences[0];
    await s.repository.execute(record(11, initial.accounts[0].id, { reminderOccurrenceId: item.id, expectedOccurrenceRevision: 1, date: '2026-10-05' }), context);
    data = (await s.repository.execute({ kind: 'edit-reminder', ruleId: rule.id, expectedRevision: 1, name: '合成新名稱', amountTwd: 200, advanceDays: 2 }, context)).data;
    assert(data.reminderOccurrences.find((row) => row.dueDate === '2026-11-05').amountTwd === 100 && data.reminderOccurrences.find((row) => row.dueDate === '2026-12-05').amountTwd === 200);
    await rejects(() => s.repository.execute({ kind: 'cancel-reminder', ruleId: rule.id, expectedRevision: 1 }, context));
    data = (await s.repository.execute({ kind: 'cancel-reminder', ruleId: rule.id, expectedRevision: 2 }, context)).data;
    assert(data.reminderOccurrences.find((row) => row.dueDate === '2026-10-05').status === 'completed');
    assert(data.reminderOccurrences.find((row) => row.dueDate === '2026-11-05').status === 'pending', '今日待辦必須保留');
    assert(data.reminderOccurrences.find((row) => row.dueDate === '2026-12-05').status === 'cancelled', '未來待辦應取消');
  });
  test('完整 v2 備份涵蓋八集合，篡改、缺集合、無效關聯與來源混用拒絕', async () => {
    const s = await setup(); const data = await accounts(s); const result = await s.repository.execute(record(3, data.accounts[0].id), context);
    const backup = await createFinanceBackup(result.data); const parsed = await validateFinanceBackup(backup.text); same(parsed.data, expectedFinanceBackupData(result.data));
    const bad = JSON.parse(backup.text); bad.data.accounts[0].name = '遭修改'; await rejects(() => validateFinanceBackup(JSON.stringify(bad)), 'SHA');
    const missing = structuredClone(result.data); delete missing.accountEvents; await rejects(() => createFinanceBackup(missing));
    const broken = structuredClone(result.data); broken.accountEvents[2].lines[0].accountId = 'missing'; await rejects(() => createFinanceBackup(broken));
    await rejects(() => s.repository.restoreAcceptance({ ...result.data, financePreferences: [{ ...result.data.financePreferences[0], dataset: 'official' }] }, 'anything'));
  });
  test('合成完整還原交易中止維持原資料，預覽後有新寫入拒絕覆蓋', async () => {
    const s = await setup(); const data = await accounts(s); const original = await s.repository.read();
    const backup = (await validateFinanceBackup((await createFinanceBackup(original)).text)).data;
    const token = financeSnapshotToken(original);
    await s.repository.execute(record(3, data.accounts[0].id), context);
    await rejects(() => s.repository.restoreAcceptance(backup, token), '新資料');
    const latest = await s.repository.read(); const latestToken = financeSnapshotToken(latest);
    s.fixture.setAbortWrites(true); await rejects(() => s.repository.restoreAcceptance(backup, latestToken)); s.fixture.setAbortWrites(false); same(await s.repository.read(), latest);
    await s.repository.restoreAcceptance(backup, latestToken); const restored = await s.repository.read();
    same(restored.accountEvents, backup.accountEvents); same(restored.expenses, backup.expenses); same(restored.incomes, backup.incomes);
    assert(restored.categoryCatalog[0].revision > backup.categoryCatalog[0].revision && restored.accounts.every((item) => item.revision > 1));
    await rejects(() => s.repository.execute(record(5, restored.accounts[0].id), context), '世代');
    assert(!(await s.repository.read()).expenses.length);
  });
  test('純驗證拒絕異動順序及校正目標偽造，操作不變更輸入', async () => {
    const s = await setup(); const data = await accounts(s); const before = stableJson(data);
    const result = applyFinanceCommand(data, command('adjustment', 3, { accountId: data.accounts[0].id, targetTwd: 900, expectedBalanceTwd: '1000', note: '合成校正' }), context);
    assert(stableJson(data) === before); const bad = structuredClone(result.data); bad.accountEvents[2].targetTwd = 100;
    await rejects(() => Promise.resolve(validateFinanceSnapshot(bad)));
    bad.accountEvents[2].sequence = 1; await rejects(() => Promise.resolve(validateFinanceSnapshot(bad)));
  });
  test('頁面載入與渲染不開啟資料庫，文字安全呈現與安全警示保留', () => {
    const controller = createFinanceController(() => {}); const html = controller.render('accounts');
    assert(html.includes('合成測試') && html.includes('正式帳戶與提醒尚未開放') && html.includes('data-finance-action="connect"'));
    assert(!html.includes('data-page="ledger"') && !html.includes('清空'));
  });
  test('帳戶頁採固定上下順序；設定從記帳設定入口開啟且測試連線保留於分頁', async () => {
    const fixture = createCatalogV3Fixture();
    const renders = [];
    const controller = createFinanceController((options) => renders.push(options), { environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (action, view) => controller.click({ dataset: { financeAction: action, view } });
    input('gate', 'confirmation', '合成測試'); await click('connect');
    input('account', 'name', '合成現金帳戶'); input('account', 'openingTwd', '100'); await controller.click({ dataset: { financeAction: 'save-account' } });
    let html = controller.render('accounts');
    assert(html.includes('finance-account-layout') && html.includes('finance-account-operations') && html.includes('全部帳戶總額'));
    const positions = ['finance-account-operation-nav', 'finance-account-panel-slot', 'finance-total', 'finance-account-grid', 'finance-account-event-history'].map((name) => html.indexOf(name));
    assert(positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]), '帳戶操作未在左側、資金及異動未在右側依序顯示');
    assert(!html.includes('data-view="preferences"') && !html.includes('data-view="budget"') && !html.includes('data-view="default"'), '記帳設定仍混在帳戶操作列');
    assert(html.includes('finance-account-type') && html.includes('finance-account-status'), '帳戶類型與狀態沒有分開呈現');
    assert(!html.includes('立即記帳') && !html.includes('記一筆收支'), '資金帳戶頁不應重複顯示記帳表單');
    const settings = controller.renderSetting('ledger');
    assert(settings.includes('<h2>記帳偏好</h2>') && settings.includes('<h2>分類預設帳戶</h2>') && !settings.includes('finance-budget-screen') && !settings.includes('管理分類'), '記帳設定應只呈現偏好及分類預設兩組設定');
    const opensBeforePageSwitch = fixture.openCalls.length;
    assert(!controller.openAccountView('budget') && controller.renderSetting('budget').includes('finance-budget-screen') && !controller.renderSetting('budget').includes('finance-account-layout'), '每月預算仍與資金帳戶共用頁面');
    assert(controller.renderSetting('preferences').includes('通用預設帳戶') && !controller.renderSetting('preferences').includes('帳戶轉帳'), '記帳偏好頁混入資金帳戶內容');
    assert(controller.renderSetting('defaults').includes('使用順序：分類專屬預設'), '分類預設帳戶說明不完整');
    assert(controller.renderSetting('acceptance').includes('開發驗收工具') && controller.renderSetting('acceptance').includes('v3 升級基準'), '隔離資料庫工具未集中到獨立驗收區');
    assert(!controller.render('accounts').includes('v3 升級基準') && !controller.render('reminders').includes('v3 升級基準') && !controller.renderSetting('budget').includes('v3 升級基準'), '工程測試工具混入日常帳戶／提醒／預算畫面');
    assert(!controller.render('reminders').includes('輸入「合成測試」'), '同一分頁切換頁面時要求重新連線');
    assert(fixture.openCalls.length === opensBeforePageSwitch, '頁面切換重複開啟資料庫');
    await click('account-view', 'account'); html = controller.render('accounts');
    assert(html.includes('finance-account-type-grid') && html.includes('data-choice-card="account-type"') && html.includes('finance-account-color-grid'), '帳戶建立沒有類型圖卡或識別色選擇');
    const colorGrid = html.slice(html.indexOf('finance-account-color-grid'), html.indexOf('</fieldset>', html.indexOf('finance-account-color-grid')));
    assert((colorGrid.match(/data-account-color="/g) || []).length === 24 && !colorGrid.includes('<span>霧藍灰</span>'), '帳戶識別色不是 24 色純色卡片');
    const testRepository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const existingAccount = (await testRepository.read()).accounts[0]; const colorBefore = existingAccount.color;
    assert(existingAccount.color === '#C39451', '未指定顏色的現金帳戶沒有使用預設金黃色識別');
    await controller.click({ dataset: { financeAction: 'edit-account', id: existingAccount.id } });
    await controller.click({ dataset: { financeAction: 'choose-account-color', accountColor: '#9B819B' } });
    html = controller.render('accounts');
    assert(html.includes(`data-account-sort-item="${existingAccount.id}" tabindex="0"`) && html.includes(`style="--account-color:#9B819B" data-account-sort-item="${existingAccount.id}"`), 'account color draft must preview on its matching card before saving');
    assert((await testRepository.read()).accounts[0].color === colorBefore, 'color preview wrote to finance storage before save');
    await click('close-operation');
    html = controller.render('accounts');
    assert(html.includes(`style="--account-color:${colorBefore}" data-account-sort-item="${existingAccount.id}"`) && (await testRepository.read()).accounts[0].color === colorBefore, 'cancelling account edit must restore stored color');
    await controller.click({ dataset: { financeAction: 'edit-account', id: existingAccount.id } });
    await controller.click({ dataset: { financeAction: 'choose-account-color', accountColor: '#9B819B' } });
    fixture.setAbortWrites(true); await controller.click({ dataset: { financeAction: 'save-account' } }); fixture.setAbortWrites(false);
    html = controller.render('accounts');
    assert(html.includes(`style="--account-color:#9B819B" data-account-sort-item="${existingAccount.id}"`) && (await testRepository.read()).accounts[0].color === colorBefore, 'failed save should keep the draft preview while preserving persisted color');
    await controller.click({ dataset: { financeAction: 'save-account' } });
    assert((await testRepository.read()).accounts[0].color === '#9B819B' && colorBefore !== '#9B819B', '帳戶圖卡選色未保存');
    await controller.click({ dataset: { financeAction: 'delete-account', id: existingAccount.id } });
    html = controller.render('accounts');
    assert(html.includes('role="alertdialog"') && html.includes('刪除預覽「合成現金帳戶」') && html.includes('$100') && html.includes('data-finance-action="confirm-delete-account"'), 'unused account deletion preview must show the starting balance impact');
    await click('cancel-delete-account');
    await testRepository.execute(command('create-account', 127, { name: '可刪除空帳戶', type: 'cash', openingTwd: 0 }), context);
    await click('reload');
    const emptyAccount = (await testRepository.read()).accounts.find((item) => item.name === '可刪除空帳戶');
    await controller.click({ dataset: { financeAction: 'delete-account', id: emptyAccount.id } });
    assert(controller.render('accounts').includes('刪除預覽「可刪除空帳戶」') && controller.render('accounts').includes('data-finance-action="confirm-delete-account"'), 'unused account should show a centered deletion preview');
    await click('confirm-delete-account');
    assert(controller.render('accounts').includes('最後確認刪除「可刪除空帳戶」') && controller.render('accounts').includes('再次確認並永久刪除'), 'account deletion must require a second explicit confirmation');
    await click('confirm-delete-account');
    assert(!(await testRepository.read()).accounts.some((item) => item.id === emptyAccount.id), 'confirmed unused account should be removed');
    const beforeTransferSwitch = renders.length;
    await click('account-view', 'transfer'); html = controller.render('accounts');
    assert(html.includes('data-finance-action="choose-account-option"') && html.includes('data-field="fromAccountId"') && html.includes('data-field="toAccountId"'), '轉帳沒有改用來源／目的帳戶卡片選擇器');
    assert(!renders.slice(beforeTransferSwitch).some((options) => options?.focus), '切換帳戶操作會觸發自動定位／捲動');
    assert(html.includes('finance-transfer-arrow') && html.includes('轉出帳戶') && html.includes('轉入帳戶'), '轉帳方向不清楚');
    await controller.click({ dataset: { financeAction: 'choose-account-option', form: 'transfer', field: 'fromAccountId', accountId: existingAccount.id } });
    html = controller.render('accounts');
    assert(html.includes(`已選：${existingAccount.name}`) && html.includes('aria-pressed="true"'), '轉帳帳戶選取回饋不明顯');
    assert(!html.includes('data-finance-action="account-view" data-view="events"') && !html.includes('data-finance-action="account-view" data-view="entry"'), '帳戶頁仍有重複異動分頁或記帳表單');
    assert(controller.renderSetting('defaults').includes('預設專屬') || controller.renderSetting('defaults').includes('分類專屬預設'), '分類預設帳戶頁缺少優先順序說明');
    await click('account-view', 'adjustment');
    await controller.click({ dataset: { financeAction: 'choose-account-option', form: 'adjustment', field: 'accountId', accountId: existingAccount.id } }); html = controller.render('accounts');
    assert(html.includes(`已選：${existingAccount.name}`) && html.includes('data-field="accountId"'), '餘額校正帳戶選取回饋不明顯');
    assert(html.includes('finance-important') && html.includes('薪水、一般收入或朋友還錢') && !html.includes('<p data-operation-hint>只用於盤點'), '必要的餘額校正警告被提示開關標記');
    const budgetSelection = controller.renderSetting('budget');
    assert(/data-choice-card="category" aria-pressed="true"[^>]*style="--category-color:#[0-9A-Fa-f]{6}"/.test(budgetSelection), 'budget category selection is missing its custom color token');
    await click('new-reminder'); html = controller.render('reminders');
    assert(!html.includes('class="finance-reminder-editor-slot" hidden') && !html.includes('finance-reminder-editor-toggle') && html.includes('<h2>新增定期項目</h2>'), '提醒新增表單未固定展開或仍有收合控制');
    assert(html.includes('data-operation-hint') && html.includes('提醒不會自動入帳') && html.includes('finance-important'));
    assert(html.indexOf('finance-reminder-operations') < html.indexOf('finance-reminder-main') && html.indexOf('finance-reminder-editor-slot') < html.indexOf('finance-reminder-rule-list'), '提醒頁新增／編輯區沒有放在左側、定期規則沒有放在右側');
    assert(html.includes('<summary>進階選項</summary>') && html.includes('付款／收款方式（選填）') && html.includes('不會由帳戶類型推測'), '提醒付款方式沒有保留於進階選項或未說明帳戶和方式不同');
    assert(/data-finance-action="choose-reminder-category"[^>]*style="--choice-color:#[0-9A-Fa-f]{6}"/.test(html), 'reminder category selection is missing its custom color token');
    await controller.click({ dataset: { financeAction: 'choose-reminder-category', form: 'reminder', categoryId: 'cat-food' } });
    html = controller.render('reminders');
    assert(/finance-reminder-subcategory-grid[\s\S]*?aria-pressed="false" style="--choice-color:#[0-9A-Fa-f]{6}"/.test(html), 'reminder subcategory selection should inherit the selected category color');
  });
  test('候選分類更新後預算、提醒與分類預設讀到同一目錄且不開啟正式 v3', async () => {
    const fixture = createStorageFixture({ version: 0 });
    const controller = createFinanceController(() => {}, { environment: fixture.environment });
    const click = (financeAction) => controller.click({ dataset: { financeAction } });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await click('connect');
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const before = await repository.read();
    const store = createCategoryStore({ catalog: before.categoryCatalog[0], ready: true });
    const category = store.addCategory({ name: '223', icon: 'tag', color: '#8795A7', entryType: 'expense' });
    const child = store.addIndependentSubcategory(category.id, '2233');
    const catalog = store.exportCatalog();
    catalog.revision = before.categoryCatalog[0].revision + 1;
    await repository.execute({ kind: 'save-category-catalog', catalog, expectedRevision: before.categoryCatalog[0].revision }, context);
    await click('reload');
    controller.input({ dataset: { financeForm: 'budget', financeField: 'categoryId' }, value: category.id });
    const budget = controller.renderSetting('budget');
    const defaults = controller.renderSetting('defaults');
    controller.input({ dataset: { financeForm: 'reminder', financeField: 'categoryId' }, value: category.id });
    const reminders = controller.render('reminders');
    assert(budget.includes(`data-category-id="${category.id}"`) && budget.includes(`data-subcategory-id="${child.id}"`), '候選預算沒有顯示新分類及其有效子分類');
    assert(defaults.includes(`data-category-id="${category.id}"`), '候選分類預設帳戶沒有顯示新分類');
    assert(reminders.includes(`data-category-id="${category.id}"`) && reminders.includes(`data-subcategory-id="${child.id}"`), '候選提醒沒有讀到同一分類及子分類');
    assert(fixture.openCalls.length > 0 && fixture.openCalls.every((call) => call.name === ACCEPTANCE_DATABASE_NAME), '候選分類操作開啟了正式 v3 或其他資料庫');
  });
  test('隔離驗收頁可用共用分類模型新增、改名、隱藏及解除關聯，候選選擇器即時更新', async () => {
    const fixture = createStorageFixture({ version: 0 });
    const controller = createFinanceController(() => {}, { environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (financeAction, extra = {}) => controller.click({ dataset: { financeAction, ...extra } });
    input('gate', 'confirmation', '合成測試'); await click('connect');
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    assert(controller.renderSetting('acceptance').includes('候選 v4 測試分類管理'), '隔離驗收頁沒有容易找到的候選分類管理入口');
    input('candidate-category', 'entryType', 'expense'); input('candidate-category', 'name', '測試一');
    input('candidate-category', 'icon', 'tag'); input('candidate-category', 'color', '#8795A7'); await click('create-candidate-category');
    let data = await repository.read(); const category = data.categoryCatalog[0].categories.find((item) => item.name === '測試一');
    assert(category && category.entryType === 'expense' && !category.hidden, '候選大分類沒有保存到隔離目錄');
    input('catalog', 'categoryId', category.id); input('catalog', 'subcategoryName', '測試子一'); await click('add-candidate-subcategory');
    data = await repository.read(); const child = data.categoryCatalog[0].subcategories.find((item) => item.name === '測試子一');
    assert(child?.categoryIds.includes(category.id), '候選子分類未以穩定關聯連到新大分類');
    controller.renderSetting('budget'); input('budget', 'categoryId', category.id);
    let budget = controller.renderSetting('budget');
    await click('choose-reminder-category', { form: 'reminder', categoryId: category.id });
    let reminders = controller.render('reminders');
    await click('choose-default-type', { entryType: 'expense' }); await click('choose-default-category', { categoryId: category.id });
    let defaults = controller.renderSetting('defaults');
    assert(budget.includes(`data-category-id="${category.id}"`) && budget.includes(`data-subcategory-id="${child.id}"`), '預算沒有即時讀取新增候選分類／子分類');
    assert(reminders.includes(`data-category-id="${category.id}"`) && reminders.includes(`data-subcategory-id="${child.id}"`), '提醒沒有即時讀取新增候選分類／子分類');
    assert(defaults.includes(`data-category-id="${category.id}"`), '分類預設帳戶沒有即時讀取新增候選分類');
    input('catalog', 'categoryId', category.id); input('catalog', 'name', '測試一改名'); await click('save-catalog');
    budget = controller.renderSetting('budget'); reminders = controller.render('reminders'); defaults = controller.renderSetting('defaults');
    assert(budget.includes('測試一改名') && reminders.includes('測試一改名') && defaults.includes('測試一改名'), '候選分類改名未同步到所有選擇器');
    const reopened = createFinanceController(() => {}, { environment: fixture.environment });
    reopened.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await reopened.click({ dataset: { financeAction: 'connect' } });
    assert(reopened.renderSetting('budget').includes(`data-category-id="${category.id}"`)
      && reopened.render('reminders').includes(`data-category-id="${category.id}"`)
      && reopened.renderSetting('defaults').includes(`data-category-id="${category.id}"`), '重新連接候選資料後分類沒有從同一個保存目錄讀回');
    input('catalog', 'categoryId', category.id); await click('toggle-candidate-category');
    budget = controller.renderSetting('budget'); reminders = controller.render('reminders'); defaults = controller.renderSetting('defaults');
    assert(!budget.includes(`data-category-id="${category.id}"`) && !reminders.includes(`data-category-id="${category.id}"`) && !defaults.includes(`data-category-id="${category.id}"`), '隱藏候選分類仍出現在選擇器');
    input('catalog', 'categoryId', category.id); await click('toggle-candidate-category');
    input('catalog', 'subcategoryId', child.id); await click('unlink-candidate-subcategory');
    input('budget', 'categoryId', category.id); budget = controller.renderSetting('budget');
    await click('choose-reminder-category', { form: 'reminder', categoryId: category.id }); reminders = controller.render('reminders');
    assert(!budget.includes(`data-subcategory-id="${child.id}"`) && !reminders.includes(`data-subcategory-id="${child.id}"`), '解除關聯後候選子分類仍出現在選擇器');
    assert(fixture.openCalls.length > 0 && fixture.openCalls.every((call) => call.name === ACCEPTANCE_DATABASE_NAME), '候選分類入口碰觸了正式或其他資料庫');
  });
  test('首次開啟預算使用其他分類及有效未分類子分類', async () => {
    const fixture = createStorageFixture({ version: 0 }); const controller = createFinanceController(() => {}, { environment: fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    const first = controller.renderSetting('budget');
    assert(first.includes('data-choice-summary="budget-category"') && first.includes('data-category-id="cat-other-expense"') && first.includes('data-subcategory-id="sub-other-expense"'), '首次顯示沒有使用初始「其他 → 未分類」目錄');
    await controller.click({ dataset: { financeAction: 'choose-budget-scope', subcategoryId: 'sub-other-expense' } });
    const selected = controller.renderSetting('budget');
    assert(selected.includes('data-subcategory-id="sub-other-expense" data-choice-card="chip" aria-pressed="true"'), '初次開啟後無法直接選擇有效子分類');
  });
  test('定期提醒依規則預設收合並顯示期次摘要，展開狀態在頁面重繪間保留', async () => {
    const s = await setup();
    const expansionStorage = new Map();
    s.fixture.environment.sessionStorage = { getItem: (key) => expansionStorage.get(key) ?? null, setItem: (key, value) => expansionStorage.set(key, value) };
    await s.repository.execute(command('create-reminder', 710, { name: '合成 GPT 訂閱', entryType: 'expense', amountTwd: 690, repeat: 'monthly', advanceDays: 1, date: '2026-11-05' }), context);
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    let html = controller.render('reminders');
    const groupId = html.match(/data-finance-action="toggle-reminder-rule" data-id="([^"]+)"/)?.[1];
    assert(groupId && (html.match(/class="finance-reminder-rule-group"/g) || []).length === 1, '定期項目沒有按規則分成單一群組');
    assert(html.includes('aria-expanded="false"') && html.includes('期待處理') && html.includes('最近 '), '收合列沒有期數與最近到期摘要，或預設未收合');
    const beforeToggle = html.match(/data-id="([^"]+)"[^>]*aria-expanded="false"/)?.[1];
    assert(beforeToggle === groupId, '展開控制沒有穩定指向目前規則');
    await controller.click({ dataset: { financeAction: 'toggle-reminder-rule', id: groupId } });
    html = controller.render('reminders');
    assert(html.includes('aria-expanded="true"') && !html.includes('class="finance-reminder-rule-occurrences" hidden'), '規則展開後沒有顯示期次');
    const occurrences = (await s.repository.read()).reminderOccurrences;
    const reviewButtons = (html.match(/data-finance-action="review-occurrence"/g) || []).length;
    assert(reviewButtons === occurrences.length, '期次未唯一列在其規則分組中');
    await controller.click({ dataset: { financeAction: 'toggle-reminder-rule', id: groupId } });
    assert(controller.render('reminders').includes('aria-expanded="false"'), '可收合的規則沒有關閉');
    await controller.click({ dataset: { financeAction: 'toggle-reminder-rule', id: groupId } });
    assert(controller.render('reminders').includes('aria-expanded="true"'), '重繪後沒有記住使用者展開狀態');
    const reopenedController = createFinanceController(() => {}, { environment: s.fixture.environment });
    reopenedController.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await reopenedController.click({ dataset: { financeAction: 'connect' } });
    assert(reopenedController.render('reminders').includes('aria-expanded="true"'), '重新載入頁面控制器後仍記得展開狀態');
  });
  test('每月預算設定頁獨立呈現進度卡及可修改入口', async () => {
    const s = await setup(); const data = await accounts(s);
    await s.repository.execute(command('set-budget', 870, { categoryId: 'cat-food', subcategoryId: '', month: '2026-11', amountTwd: 10000, applyFuture: true, expectedRevision: data.financePreferences[0].revision }), context);
    const persisted = await s.repository.read();
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    const html = controller.renderSetting('budget');
    assert(html.includes('每月預算（整數元）') && html.includes('finance-budget-progress') && html.includes('NT$10,000'), '10,000 元預算卡片顯示錯誤');
    assert(html.indexOf('finance-budget-editor') < html.indexOf('finance-budget-overview') && html.includes('finance-budget-screen'), '預算編輯區與進度區沒有形成左／右欄結構');
    assert(!html.includes('finance-account-layout') && !html.includes('帳戶異動明細') && !html.includes('帳戶轉帳'), '預算頁包含無關的帳戶區塊');
    const card = html.indexOf('NT$10,000');
    assert(card >= 0 && html.includes('data-finance-action="edit-budget"'), '預算卡缺少金額或修改入口');
    assert(persisted.financePreferences[0].budgetSchedules[0].amountTwd === 10000, '預算設定未保留原始元金額');
  });
  test('預算 100／1,000／10,000／12,000 元經表單、儲存、讀取、計算與八集合備份往返保持正確', async () => {
    const fixture = createCatalogV3Fixture();
    const controller = createFinanceController(() => {}, { environment: fixture.environment });
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (financeAction) => controller.click({ dataset: { financeAction } });
    input('gate', 'confirmation', '合成測試'); await click('connect');
    const categories = (await repository.read()).categoryCatalog[0].categories.filter((item) => item.entryType === 'expense' && !item.hidden).slice(0, 4);
    const cases = [100, 1000, 10000, 12000];
    for (let index = 0; index < cases.length; index += 1) {
      const amountTwd = cases[index]; const month = `2026-0${index + 1}`; const category = categories[index];
      input('budget', 'month', month); input('budget', 'categoryId', category.id); input('budget', 'subcategoryId', '');
      input('budget', 'amountTwd', String(amountTwd)); input('budget', 'applyFuture', 'true'); await click('save-budget');
      const read = await repository.read();
      const saved = read.financePreferences[0].budgetSchedules.find((item) => item.categoryId === category.id && item.effectiveFromMonth === month);
      assert(saved?.amountTwd === amountTwd, `表單或保存把 ${amountTwd} 元改成 ${saved?.amountTwd} 元`);
      const calculated = calculateMonthlyBudgets(read, month).find((item) => item.categoryId === category.id);
      assert(calculated?.budgetTwd === amountTwd && calculated.budgetMinor === BigInt(amountTwd) * 100n, `${amountTwd} 元預算計算單位錯誤`);
      input('budget', 'month', month);
      const screen = controller.renderSetting('budget');
      assert(screen.includes(`NT$${amountTwd.toLocaleString('zh-TW')}`), `${amountTwd} 元畫面顯示錯誤`);
      if (amountTwd === 10000) {
        const targetRule = read.financePreferences[0].budgetSchedules.find((item) => item.categoryId === category.id && item.effectiveFromMonth === month);
        const marker = screen.indexOf(`data-budget-id="${targetRule.id}"`);
        const targetStart = screen.lastIndexOf('<article', marker);
        const targetCard = screen.slice(targetStart, screen.indexOf('</article>', marker) + 10);
        assert(targetCard.includes('NT$10,000') && !targetCard.includes('NT$100.00'), '10,000 元預算卡片被當成 10,000 分顯示');
      }
    }
    const before = await repository.read();
    const exported = await createFinanceBackup(before);
    const validated = await validateFinanceBackup(exported.text);
    assert(validated.data.financePreferences[0].budgetSchedules.length === 4, '備份缺少預算設定');
    await repository.restoreAcceptance(validated.data, financeSnapshotToken(before), { formatVersion: validated.formatVersion });
    const restored = await repository.read();
    for (const amountTwd of cases) assert(restored.financePreferences[0].budgetSchedules.some((item) => item.amountTwd === amountTwd), `備份還原後缺少 ${amountTwd} 元預算`);
    for (let index = 0; index < cases.length; index += 1) {
      const calculated = calculateMonthlyBudgets(restored, `2026-0${index + 1}`).find((item) => item.categoryId === categories[index].id);
      assert(calculated?.budgetMinor === BigInt(cases[index]) * 100n, `還原後 ${cases[index]} 元預算金額不符`);
    }
  });
  test('實際頁面控制流程：明確啟用、帳戶、分類預設、收支、提醒確認及重新連接', async () => {
    const fixture = createCatalogV3Fixture(); let renders = 0;
    const controller = createFinanceController(() => { renders += 1; }, { environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (action, id) => controller.click({ dataset: { financeAction: action, id } });
    controller.render('accounts'); controller.render('reminders'); assert(!fixture.openCalls.length);
    await click('connect'); assert(!fixture.openCalls.length && controller.render('accounts').includes('未完成'));
    input('gate', 'confirmation', '合成測試'); await click('connect');
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    for (const [field, val] of Object.entries({ name: '<img src=x onerror=alert(1)>', type: 'cash', openingTwd: '1000', date: '2026-01-01' })) input('account', field, val);
    await click('save-account'); let data = await repository.read(); const cash = data.accounts[0];
    assert(cash && controller.render('accounts').includes('&lt;img') && !controller.render('accounts').includes('<img src=x'));
    await controller.click({ dataset: { financeAction: 'choose-default-type', entryType: 'expense' } });
    await controller.click({ dataset: { financeAction: 'choose-default-category', categoryId: 'cat-food' } });
    await controller.click({ dataset: { financeAction: 'choose-default-account', accountId: cash.id } });
    await click('save-default');
    input('budget', 'month', '2026-11'); input('budget', 'categoryId', 'cat-food'); input('budget', 'subcategoryId', ''); input('budget', 'amountTwd', '50'); input('budget', 'applyFuture', 'true'); await click('save-budget');
    data = await repository.read(); assert(data.financePreferences[0].budgetSchedules.length === 1 && controller.renderSetting('budget').includes('2026-11 預算進度'));
    input('entry', 'entryType', 'expense'); input('entry', 'categoryId', 'cat-food'); input('entry', 'subcategoryId', 'sub-lunch'); input('entry', 'amountTwd', '100'); input('entry', 'date', '2026-11-05'); input('entry', 'accountId', cash.id); await click('record');
    assert((await repository.read()).expenses.length === 1 && controller.renderSetting('budget').includes('本月已超出預算'));
    for (const [field, val] of Object.entries({ name: '合成控制流程提醒', entryType: 'expense', amountTwd: '50', repeat: 'once', advanceDays: '1', date: '2026-11-05' })) input('reminder', field, val);
    await click('save-reminder'); data = await repository.read(); const occurrence = data.reminderOccurrences[0]; assert(occurrence);
    const reminderHtml = controller.render('reminders');
    const reminderStart = reminderHtml.indexOf('<article class="finance-reminder-card');
    const reminderEnd = reminderHtml.indexOf('</article>', reminderStart);
    const reminderCard = reminderHtml.slice(reminderStart, reminderEnd);
     assert(reminderCard.indexOf('finance-reminder-card-content') < reminderCard.indexOf('finance-reminder-card-operations') && reminderCard.includes('確認付款並記帳') && reminderHtml.includes('data-danger="true"'), '提醒卡片主要操作或危險刪除入口不在清楚的右側操作區');
    await click('review-occurrence', occurrence.id); assert(controller.render('reminders').includes('確認付款並記帳') && controller.render('reminders').includes('已經記過帳？關聯既有交易'));
    await click('posting-new');
    input('entry', 'categoryId', 'cat-food'); input('entry', 'subcategoryId', 'sub-lunch'); await click('record');
    data = await repository.read(); assert(data.expenses.length === 2 && data.reminderOccurrences[0].status === 'completed');
    await click('disconnect'); assert(controller.render('accounts').includes('合成測試'));
    input('gate', 'confirmation', '合成測試'); await click('connect');
    assert(controller.render('accounts').includes('$850') && renders > 10);
  });
  test('包含提醒完成關聯與分類預設的八集合備份可以完整回讀', async () => {
    const s = await setup(); let data = await accounts(s); const cash = data.accounts[0];
    await s.repository.execute({ kind: 'set-default', categoryId: 'cat-food', entryType: 'expense', accountId: cash.id, expectedRevision: 0 }, context);
    data = (await s.repository.execute(command('create-reminder', 10, { name: '合成完整提醒', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const item = data.reminderOccurrences[0];
    data = (await s.repository.execute(record(11, cash.id, { reminderOccurrenceId: item.id, expectedOccurrenceRevision: 1, date: '2026-11-05' }), context)).data;
    data = (await s.repository.execute(record(12, cash.id, { entryType: 'income', categoryId: 'income-part-time', subcategoryId: 'sub-income-wage' }), context)).data;
    const parsed = await validateFinanceBackup((await createFinanceBackup(data)).text); same(parsed.data, expectedFinanceBackupData(data)); assert(parsed.formatVersion === 6);
    assert(Object.values(data).every((rows) => rows.length > 0));
    await s.repository.restoreAcceptance(parsed.data, financeSnapshotToken(data), { formatVersion: parsed.formatVersion });
    const restored = await s.repository.read(); assert(accountBalances(restored).get(cash.id) === accountBalances(data).get(cash.id));
    assert(restored.reminderOccurrences[0].entryId === data.expenses[0].id && restored.financePreferences[0].defaults[0].accountId === cash.id);
  });
  test('格式 5 保存定期項目快照；格式 4 若省略目前提醒設定，完整還原會拒絕', async () => {
    const s = await setup(); const data = await accounts(s); const cash = data.accounts[0];
    const current = (await s.repository.execute(command('create-reminder', 41, { name: '合成格式相容', entryType: 'expense', amountTwd: 90, repeat: 'monthly', advanceDays: 1, date: '2026-11-05', entryDefaults: { categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: cash.id, paymentMethod: 'cash' }, billSchedule: { monthsBeforeDue: 1, day: 31 } }), context)).data;
    const exported = await createFinanceBackup(current); const parsed = await validateFinanceBackup(exported.text);
    assert(parsed.formatVersion === 6 && parsed.data.reminderRules[0].entryDefaults.accountId === cash.id && parsed.data.reminderOccurrences[0].sourceRuleRevision === 1);
    const legacy = JSON.parse(exported.text); legacy.formatVersion = 4; delete legacy.sha256;
    for (const row of legacy.data.reminderRules) for (const field of ['entryDefaults', 'billDate', 'billSchedule']) delete row[field];
    for (const row of legacy.data.reminderOccurrences) for (const field of ['entryDefaults', 'billDate', 'sourceRuleRevision', 'overrides']) delete row[field];
    legacy.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(legacy))))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const older = await validateFinanceBackup(JSON.stringify(legacy)); assert(older.formatVersion === 4);
    await rejects(() => s.repository.restoreAcceptance(older.data, financeSnapshotToken(current), { formatVersion: older.formatVersion }), '新欄位');
    same(await s.repository.read(), current);
  });
  test('年度提醒跨年及 2/29 的明確規則，不漂移、不重複產生', async () => {
    const s = await setup();
    let data = (await s.repository.execute(command('create-reminder', 70, { name: '合成年費', entryType: 'expense', amountTwd: 300, repeat: 'yearly', advanceDays: 1, date: '2024-02-29' }), { ...context, today: '2027-12-31' })).data;
    same(data.reminderOccurrences.map((item) => item.dueDate), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
    const ids = data.reminderOccurrences.map((item) => item.id);
    data = (await s.repository.execute({ kind: 'refresh-reminders' }, { ...context, today: '2028-01-01' })).data;
    assert(new Set(data.reminderOccurrences.map((item) => item.id)).size === 6 && ids.every((id) => data.reminderOccurrences.some((item) => item.id === id)));
    const backup = await validateFinanceBackup((await createFinanceBackup(data)).text); same(backup.data, expectedFinanceBackupData(data));
  });
  test('已自行記帳：只加關聯，不新增收支、分錄或再扣帳', async () => {
    const s = await setup(); const initial = await accounts(s);
    await s.repository.execute(record(3, initial.accounts[0].id), context);
    let data = (await s.repository.execute(command('create-reminder', 70, { name: '合成已付款', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const before = structuredClone(data); const item = data.reminderOccurrences[0];
    const cmd = { kind: 'link-reminder', occurrenceId: item.id, expectedRevision: item.revision, entryId: data.expenses[0].id, confirmed: true };
    data = (await s.repository.execute(cmd, context)).data;
    assert(data.expenses.length === 1 && data.reminderOccurrences[0].completionMode === 'linked'); same(data.accountEvents, before.accountEvents);
    const { reminderOccurrenceId, ...recordAfter } = data.expenses[0]; same(recordAfter, before.expenses[0]); assert(reminderOccurrenceId === item.id);
    assert((await s.repository.execute(cmd, context)).status === 'duplicate');
    const validatedBackup = await validateFinanceBackup((await createFinanceBackup(data)).text); same(validatedBackup.data, expectedFinanceBackupData(data));
    await s.repository.restoreAcceptance(validatedBackup.data, financeSnapshotToken(data), { formatVersion: validatedBackup.formatVersion }); const restored = await s.repository.read();
    same(restored.accountEvents, before.accountEvents); assert(restored.reminderOccurrences[0].entryId === restored.expenses[0].id);
  });
  test('關聯拒絕不同收支類型、重複關聯、未確認與過期版本', async () => {
    const s = await setup(); const initial = await accounts(s);
    await s.repository.execute(record(3, initial.accounts[0].id), context);
    await s.repository.execute(record(4, initial.accounts[0].id, { entryType: 'income', categoryId: 'income-part-time', subcategoryId: 'sub-income-wage' }), context);
    let data;
    for (const n of [70, 71]) data = (await s.repository.execute(command('create-reminder', n, { name: '合成關聯保護', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const first = data.reminderOccurrences[0]; const second = data.reminderOccurrences[1];
    const cmd = { kind: 'link-reminder', occurrenceId: first.id, expectedRevision: first.revision, entryId: data.expenses[0].id, confirmed: true };
    for (const extra of [{ entryId: data.incomes[0].id }, { confirmed: false }, { expectedRevision: 0 }]) await rejects(() => s.repository.execute({ ...cmd, ...extra }, context));
    await s.repository.execute(cmd, context);
    await rejects(() => s.repository.execute({ ...cmd, occurrenceId: second.id }, context));
    assert((await s.repository.read()).reminderOccurrences[1].status === 'pending');
  });
  test('關聯交易中止回復主紀錄及期次，不誤報完成；舊未指定帳戶紀錄也可關聯', async () => {
    const s = await setup({ old: true });
    const data = (await s.repository.execute(command('create-reminder', 70, { name: '合成舊紀錄', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const cmd = { kind: 'link-reminder', occurrenceId: data.reminderOccurrences[0].id, expectedRevision: 1, entryId: data.expenses[0].id, confirmed: true };
    s.fixture.setAbortWrites(true); await rejects(() => s.repository.execute(cmd, context)); s.fixture.setAbortWrites(false); same(await s.repository.read(), data);
    const result = await s.repository.execute(cmd, context); assert(result.data.expenses[0].accountId === undefined && !result.data.accountEvents.length && result.data.expenses[0].amountMinor === 1050);
  });
  test('取消不刪除；明確確認後可刪除未關聯提醒及期次；中止不留部分刪除', async () => {
    const s = await setup(); let data = (await s.repository.execute(command('create-reminder', 70, { name: '合成取消刪除', entryType: 'expense', amountTwd: 100, repeat: 'monthly', advanceDays: 1, date: '2026-10-05' }), context)).data;
    const rule = data.reminderRules[0];
    data = (await s.repository.execute({ kind: 'cancel-reminder', ruleId: rule.id, expectedRevision: 1 }, context)).data;
    assert(data.reminderOccurrences.length === 3 && data.reminderOccurrences.find((item) => item.dueDate === '2026-11-05').status === 'pending' && data.reminderOccurrences.filter((item) => item.dueDate > context.today).every((item) => item.status === 'cancelled'));
    const cmd = { kind: 'delete-reminder', ruleId: rule.id, expectedRevision: 2, expectedOccurrences: 3, confirmed: true };
    await rejects(() => s.repository.execute({ ...cmd, confirmed: false }, context));
    await rejects(() => s.repository.execute({ ...cmd, expectedOccurrences: 2 }, context));
    s.fixture.setAbortWrites(true); await rejects(() => s.repository.execute(cmd, context)); s.fixture.setAbortWrites(false); same(await s.repository.read(), data);
    data = (await s.repository.execute(cmd, context)).data; assert(!data.reminderRules.length && !data.reminderOccurrences.length);
  });
  test('有歷史付款的提醒可安全刪除規則並保留原交易與帳戶異動', async () => {
    for (const mode of ['created', 'linked']) {
      const s = await setup(); let data = await accounts(s);
      data = (await s.repository.execute(record(3, data.accounts[0].id), context)).data;
      data = (await s.repository.execute(command('create-reminder', 70, { name: '合成交易保護', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
      let occurrence = data.reminderOccurrences[0]; const rule = data.reminderRules[0];
      if (mode === 'created') data = (await s.repository.execute(record(70, data.accounts[0].id, { reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision }), context)).data;
      else data = (await s.repository.execute({ kind: 'link-reminder', occurrenceId: occurrence.id, expectedRevision: occurrence.revision, entryId: data.expenses[0].id, confirmed: true }, context)).data;
      occurrence = data.reminderOccurrences[0];
      const beforeEntries = structuredClone(data.expenses); const beforeEvents = structuredClone(data.accountEvents);
      const deleteCommand = { kind: 'delete-reminder', ruleId: rule.id, expectedRevision: rule.revision, expectedOccurrences: 1, confirmed: true, preserveTransactions: true };
      await rejects(() => s.repository.execute({ ...deleteCommand, preserveTransactions: false }, context), '明確選擇保留歷史收支');
      s.fixture.setAbortWrites(true); await rejects(() => s.repository.execute(deleteCommand, context)); s.fixture.setAbortWrites(false); same(await s.repository.read(), data);
      data = (await s.repository.execute(deleteCommand, context)).data;
      assert(!data.reminderRules.length && !data.reminderOccurrences.length, 'confirmed reminder rule was not deleted');
      same(data.accountEvents, beforeEvents);
      assert(data.expenses.length === beforeEntries.length && data.expenses.every((item) => !item.reminderOccurrenceId), 'real transactions were removed or left with an orphan reminder link');
    }
  });
  test('撤銷提醒自動入帳會原子撤回收支及帳戶事件，並可重新確認同一期', async () => {
    const s = await setup(); let data = await accounts(s); const accountId = data.accounts[0].id;
    data = (await s.repository.execute(record(3, accountId), context)).data;
    data = (await s.repository.execute(command('create-reminder', 71, { name: '合成撤銷車貸', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    let occurrence = data.reminderOccurrences[0];
    data = (await s.repository.execute(record(71, accountId, { reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision }), context)).data;
    occurrence = data.reminderOccurrences[0];
    assert(occurrence.status === 'completed' && data.expenses.length === 2 && accountBalances(data).get(accountId) === 800n, 'initial reminder posting did not create one transaction and movement');
    const undo = { kind: 'undo-reminder-payment', occurrenceId: occurrence.id, expectedRevision: occurrence.revision, entryId: occurrence.entryId, expectedCompletionMode: 'created', confirmed: true };
    await rejects(() => s.repository.execute({ ...undo, expectedRevision: 1 }, context), '本期期次已變更');
    s.fixture.setAbortWrites(true); await rejects(() => s.repository.execute(undo, context)); s.fixture.setAbortWrites(false); same(await s.repository.read(), data);
    data = (await s.repository.execute(undo, context)).data;
    occurrence = data.reminderOccurrences[0];
    assert(occurrence.status === 'pending' && !occurrence.entryId && data.expenses.length === 1 && data.accountEvents.length === 3 && accountBalances(data).get(accountId) === 900n, 'undo left a transaction, movement or completed occurrence behind');
    data = (await s.repository.execute(record(72, accountId, { reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision }), context)).data;
    const repeat = await s.repository.execute(record(73, accountId, { reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision }), context);
    assert(data.expenses.length === 2 && repeat.status === 'duplicate' && (await s.repository.read()).expenses.length === 2, 'same period could not be safely re-confirmed exactly once');
  });
  test('撤銷提醒自動收款會刪除正確收入集合並恢復帳戶餘額', async () => {
    const s = await setup(); let data = await accounts(s); const accountId = data.accounts[0].id;
    data = (await s.repository.execute(command('create-reminder', 75, { name: '合成退款收入', entryType: 'income', amountTwd: 120, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    let occurrence = data.reminderOccurrences[0];
    data = (await s.repository.execute(record(75, accountId, { entryType: 'income', categoryId: 'income-part-time', subcategoryId: 'sub-income-wage', amountTwd: 120, reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision }), context)).data;
    occurrence = data.reminderOccurrences[0];
    assert(data.incomes.length === 1 && accountBalances(data).get(accountId) === 1120n, '自動收款未新增收入及入帳異動');
    data = (await s.repository.execute({ kind: 'undo-reminder-payment', occurrenceId: occurrence.id, expectedRevision: occurrence.revision, entryId: occurrence.entryId, expectedCompletionMode: 'created', confirmed: true }, context)).data;
    assert(data.reminderOccurrences[0].status === 'pending' && data.incomes.length === 0 && data.expenses.length === 0
      && data.accountEvents.length === 2 && accountBalances(data).get(accountId) === 1000n, '撤銷收款刪錯集合或未恢復餘額');
  });
  test('撤銷關聯既有交易只解除提醒關聯，不刪交易或改帳戶異動', async () => {
    const s = await setup({ old: true }); let data = await accounts(s);
    data = (await s.repository.execute(command('create-reminder', 74, { name: '合成已記帳關聯', entryType: 'expense', amountTwd: 10, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context)).data;
    let occurrence = data.reminderOccurrences[0]; const source = structuredClone(data.expenses[0]);
    data = (await s.repository.execute({ kind: 'link-reminder', occurrenceId: occurrence.id, expectedRevision: occurrence.revision, entryId: source.id, confirmed: true }, context)).data;
    occurrence = data.reminderOccurrences[0]; const events = structuredClone(data.accountEvents);
    data = (await s.repository.execute({ kind: 'undo-reminder-payment', occurrenceId: occurrence.id, expectedRevision: occurrence.revision, entryId: source.id, expectedCompletionMode: 'linked', confirmed: true }, context)).data;
    assert(data.reminderOccurrences[0].status === 'pending' && !data.expenses[0].reminderOccurrenceId && data.expenses[0].amountMinor === source.amountMinor && data.expenses[0].id === source.id, 'linked transaction was altered or deleted');
    same(data.accountEvents, events);
  });
  test('V4 分類保存只禁止移除有交易的關聯，不阻止解除其他分類的共用關聯', async () => {
    const s = await setup(); let data = await accounts(s); const cash = data.accounts[0].id;
    await s.repository.execute(record(3, cash, { subcategoryId: 'sub-breakfast' }), context);
    data = await s.repository.read();
    let editor = createCategoryStore({ catalog: data.categoryCatalog[0] });
    const second = editor.addCategory({ name: '測試二', entryType: 'expense' });
    assert(editor.shareSubcategory(second.id, 'sub-breakfast'), 'failed to add a shared category association');
    let catalog = editor.exportCatalog(); catalog.revision = data.categoryCatalog[0].revision + 1;
    data = (await s.repository.execute({ kind: 'save-category-catalog', catalog, expectedRevision: data.categoryCatalog[0].revision }, context)).data;
    catalog = structuredClone(data.categoryCatalog[0]);
    const breakfast = catalog.subcategories.find((item) => item.id === 'sub-breakfast'); breakfast.categoryIds = breakfast.categoryIds.filter((id) => id !== second.id);
    catalog.revision = data.categoryCatalog[0].revision + 1;
    data = (await s.repository.execute({ kind: 'save-category-catalog', catalog, expectedRevision: data.categoryCatalog[0].revision }, context)).data;
    assert(data.categoryCatalog[0].subcategories.find((item) => item.id === 'sub-breakfast').categoryIds.includes('cat-food')
      && !data.categoryCatalog[0].subcategories.find((item) => item.id === 'sub-breakfast').categoryIds.includes(second.id)
      && data.expenses[0].subcategoryId === 'sub-breakfast', 'unlinking the unused pair changed the original shared category or transaction');
    catalog = structuredClone(data.categoryCatalog[0]);
    catalog.subcategories.find((item) => item.id === 'sub-breakfast').categoryIds = [];
    catalog.revision = data.categoryCatalog[0].revision + 1;
    await rejects(() => s.repository.execute({ kind: 'save-category-catalog', catalog, expectedRevision: data.categoryCatalog[0].revision }, context), '此子分類關聯已有歷史交易引用');
  });
  test('提醒介面兩種確認路徑、取消視圖、焦點要求及明確成功訊息', async () => {
    const fixture = createCatalogV3Fixture(); const focusCalls = [];
    const controller = createFinanceController((options) => { if (options?.focus) focusCalls.push(options); }, { environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (financeAction, id) => controller.click({ dataset: { financeAction, id } });
    input('gate', 'confirmation', '合成測試'); await click('connect');
    const repo = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    await repo.execute(command('create-account', 1, { name: '合成現金', type: 'cash', openingTwd: 1000 }), context);
    let data = await repo.read(); await repo.execute(record(3, data.accounts[0].id), context);
    await repo.execute(command('create-reminder', 70, { name: '合成卡片', entryType: 'expense', amountTwd: 100, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context);
    await click('reload'); data = await repo.read(); const item = data.reminderOccurrences[0];
    const beforeCancel = await repo.read();
    await click('review-occurrence', item.id); let html = controller.render('reminders');
    assert(html.includes('data-reminder-posting-dialog') && html.includes('role="dialog" aria-modal="true"') && html.includes('finance-posting-dialog')
      && html.indexOf('data-reminder-posting-dialog') > html.indexOf('</main></div>') && !html.includes('finance-reminder-transient-slot'), '付款確認沒有移出左側欄並置中呈現');
    assert(html.includes('確認付款並記帳') && html.includes('data-finance-focus') && html.includes('已經記過帳？關聯既有交易') && html.includes('2026-11-05') && html.includes(item.periodKey) && focusCalls.length, '提醒付款確認缺少期限、期次或焦點');
    await click('cancel-posting'); same(await repo.read(), beforeCancel);
    await click('review-occurrence', item.id); html = controller.render('reminders');
    await click('posting-existing'); input('link', 'entryId', data.expenses[0].id); await click('link-existing'); html = controller.render('reminders');
    assert(html.includes('沒有新增收支') && html.includes('沒有再次扣款'), '關聯既有交易後沒有明確說明不會新增或扣款');
    assert((await repo.read()).expenses.length === 1, '關聯既有交易卻新增了第二筆收支');
    await click('undo-occurrence', item.id); html = controller.render('reminders');
    assert(html.includes('data-reminder-undo-dialog') && html.includes('只解除提醒與交易關聯') && html.includes('原收支及帳戶異動完全保留') && html.includes('只解除提醒關聯'), 'linked reminder undo did not show a clear central confirmation');
    const beforeUndoCancel = await repo.read(); await click('cancel-undo-occurrence'); same(await repo.read(), beforeUndoCancel);
    await click('delete-rule', data.reminderRules[0].id); html = controller.render('reminders');
    assert(html.includes('刪除「合成卡片」提醒') && html.includes('解除其提醒關聯') && html.includes('role="alertdialog"') && html.includes('confirm-delete-rule'), '提醒刪除確認沒有說明關聯影響');
    assert(html.includes('停止後續提醒') && html.includes('刪除提醒，保留歷史收支'), '提醒刪除視窗沒有列出停止後續及保留歷史收支的選項');
    await click('cancel-delete-rule');
    const beforeStop = await repo.read();
    await click('request-stop-rule', data.reminderRules[0].id); html = controller.render('reminders');
    assert(html.includes('data-reminder-stop-dialog') && html.includes('cancel-stop-rule') && html.includes('confirm-stop-rule'), 'stop reminder did not open a central confirmation dialog');
    same(await repo.read(), beforeStop);
    await click('cancel-stop-rule'); same(await repo.read(), beforeStop);
    await click('request-stop-rule', data.reminderRules[0].id); await click('confirm-stop-rule');
    const stoppedRuleData = await repo.read();
    assert(!stoppedRuleData.reminderRules.find((row) => row.id === data.reminderRules[0].id).active
      && stoppedRuleData.reminderOccurrences[0].status === 'completed' && stoppedRuleData.expenses.length === 1
      && stoppedRuleData.accountEvents.length === beforeStop.accountEvents.length, 'confirmed stop changed completed history or account events');
    await click('delete-rule', data.reminderRules[0].id); await click('confirm-delete-rule');
    const afterDelete = await repo.read();
    assert(!afterDelete.reminderRules.length && afterDelete.expenses.length === 1 && !afterDelete.expenses[0].reminderOccurrenceId && afterDelete.accountEvents.length === beforeUndoCancel.accountEvents.length, 'deleting linked reminder damaged the historical transaction');
    html = controller.render('reminders'); assert(html.includes('提醒已刪除，歷史收支與帳戶異動均保留。'), '安全刪除提醒後沒有顯示成功訊息');
  });
  test('提醒分類與帳戶預設進入確認表單後固定沿用，手動改分類不會被預設覆蓋', async () => {
    const s = await setup(); let data = await accounts(s); const account = data.accounts[1];
    await s.repository.execute(command('create-reminder', 704, { name: '合成手機費', entryType: 'expense', amountTwd: 590, repeat: 'monthly', advanceDays: 1, date: '2026-11-10', entryDefaults: { categoryId: 'cat-mobile', subcategoryId: 'sub-phone-bill', accountId: account.id, paymentMethod: 'bank-transfer' } }), context);
    data = await s.repository.read(); const rule = data.reminderRules[0]; const item = data.reminderOccurrences[0];
    assert(rule.entryDefaults.categoryId === 'cat-mobile' && item.entryDefaults.categoryId === 'cat-mobile' && item.entryDefaults.subcategoryId === 'sub-phone-bill', '規則或期次沒有保存分類快照');
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' }); await controller.click({ dataset: { financeAction: 'connect' } });
    await controller.click({ dataset: { financeAction: 'edit-rule', id: rule.id } });
    let html = controller.render('reminders');
    assert(html.includes('finance-reminder-picker') && html.includes('choose-reminder-category') && html.includes('choose-reminder-subcategory') && html.includes('choose-reminder-account'), '提醒預設未使用圖示卡片浮動選擇器');
    await controller.click({ dataset: { financeAction: 'review-occurrence', id: item.id } }); html = controller.render('reminders');
    assert(html.includes('data-current-category="cat-mobile"') && html.includes('data-current-subcategory="sub-phone-bill"') && html.includes('本次分類：手機 → 電話費'), '確認表單沒有沿用本期大分類與子分類快照');
    const other = data.categoryCatalog[0].categories.find((entry) => entry.entryType === 'expense' && entry.id !== 'cat-mobile' && !entry.hidden);
    controller.input({ dataset: { financeForm: 'entry', financeField: 'categoryId' }, value: other.id }); html = controller.render('reminders');
    assert(html.includes(`data-current-category="${other.id}"`) && !html.includes('data-current-category="cat-mobile"'), '手動改選分類後又被提醒預設覆蓋');
  });
  test('提醒新增表單固定展開；週期重繪及右側操作保留左側草稿', async () => {
    const s = await setup();
    await accounts(s);
    await s.repository.execute(command('create-reminder', 705, { name: '合成既有規則', entryType: 'expense', amountTwd: 80, repeat: 'monthly', advanceDays: 1, date: '2026-11-10' }), context);
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' }); await controller.click({ dataset: { financeAction: 'connect' } });
    const data = await s.repository.read(); const rule = data.reminderRules[0]; const occurrence = data.reminderOccurrences[0];
    let html = controller.render('reminders');
    assert(!html.includes('finance-reminder-editor-toggle') && !html.includes('class="finance-reminder-editor-slot" hidden')
      && html.includes('<h2>新增定期項目</h2>') && !html.includes('finance-reminder-operation-toolbar')
      && html.indexOf('<h2>新增定期項目</h2>') === html.lastIndexOf('<h2>新增定期項目</h2>'), '新增表單應固定展開且只保留一個標題');
    await controller.click({ dataset: { financeAction: 'new-reminder' } });
    controller.input({ dataset: { financeForm: 'reminder', financeField: 'name' }, value: '尚未保存草稿' });
    controller.input({ dataset: { financeForm: 'reminder', financeField: 'amountTwd' }, value: '456' });
    for (const [field, value] of Object.entries({ entryType: 'expense', date: '2026-11-21', categoryId: 'cat-food', subcategoryId: 'sub-dinner', accountId: (await s.repository.read()).accounts[0].id, note: '備註草稿', advanceDays: '3' })) {
      controller.input({ dataset: { financeForm: 'reminder', financeField: field }, value });
    }
    for (const repeat of ['once', 'monthly', 'yearly', 'once']) {
      controller.input({ dataset: { financeForm: 'reminder', financeField: 'repeat' }, value: repeat });
      html = controller.render('reminders');
      const repeatIndex = html.indexOf('data-finance-field="repeat"');
      const advanceIndex = html.indexOf('data-finance-field="advanceDays"');
      const hintIndex = html.indexOf('class="finance-reminder-cycle-context"');
      const noteIndex = html.indexOf('data-finance-field="note"');
      const nameIndex = html.indexOf('data-finance-field="name"');
      const typeIndex = html.indexOf('data-finance-action="choose-reminder-type"');
      assert(repeatIndex >= 0 && repeatIndex < advanceIndex && advanceIndex < hintIndex && hintIndex < noteIndex
        && nameIndex >= 0 && nameIndex < typeIndex
        && html.includes(`value="${repeat}"`) && html.includes('value="尚未保存草稿"') && html.includes('value="456"')
        && html.includes('value="2026-11-21"') && html.includes('data-subcategory-id="sub-dinner"') && html.includes('value="備註草稿"')
        && html.includes(`data-account-id="${(await s.repository.read()).accounts[0].id}"`)
        && html.includes('value="3"') && !html.includes('class="finance-reminder-editor-slot" hidden'), `切換 ${repeat} 時表單欄位錯位或草稿消失`);
    }
    const editorHtml = html.slice(html.indexOf('class="finance-reminder-editor-slot"'), html.indexOf('class="finance-reminder-main"'));
    assert(!editorHtml.includes('value="monthly" selected') && editorHtml.includes('data-finance-action="choose-reminder-type"')
      && editorHtml.includes('>支出</button>') && editorHtml.includes('>收入</button>') && !editorHtml.includes('預計支出'), '週期切換完成後收支按鈕或週期預設不正確');
    await controller.click({ dataset: { financeAction: 'toggle-reminder-rule', id: rule.id } });
    assert(controller.render('reminders').includes('value="尚未保存草稿"'), '操作右側提醒清單覆蓋左側新增草稿');
    await controller.click({ dataset: { financeAction: 'review-occurrence', id: occurrence.id } });
    assert(controller.render('reminders').includes('value="尚未保存草稿"') && controller.render('reminders').includes('確認付款並記帳'), '開啟本期確認時新增草稿遭清除或固定表單消失');
    await controller.click({ dataset: { financeAction: 'cancel-posting' } });
    assert(controller.render('reminders').includes('value="尚未保存草稿"'), '取消本期確認後未恢復新增草稿');
    controller.prepareReminderPage();
    assert(controller.render('reminders').includes('value="尚未保存草稿"'), '再次進入提醒頁沒有恢復新項目草稿');
    await controller.click({ dataset: { financeAction: 'edit-rule', id: rule.id } });
    await controller.click({ dataset: { financeAction: 'new-reminder' } });
    assert(controller.render('reminders').includes('value="尚未保存草稿"'), '切換規則編輯後新項目草稿遺失');
  });
  test('提醒確認缺少有效分類時明確指出必要欄位而不假裝完成', async () => {
    const s = await setup();
    await s.repository.execute(command('create-reminder', 706, { name: '缺少分類測試', entryType: 'expense', amountTwd: 80, repeat: 'once', advanceDays: 1, date: '2026-11-10' }), context);
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' }); await controller.click({ dataset: { financeAction: 'connect' } });
    const occurrence = (await s.repository.read()).reminderOccurrences[0];
    await controller.click({ dataset: { financeAction: 'review-occurrence', id: occurrence.id } });
    await controller.click({ dataset: { financeAction: 'record' } });
    const html = controller.render('reminders');
    assert(html.includes('未完成：請選擇仍有效的大分類。') && html.includes('確認付款並記帳') && !html.includes('已完成提醒：新增了 1 筆'), '缺少分類時未指出原因或被當成已入帳');
  });
  test('沒有交易關聯的提醒可確認永久刪除並立即更新資料', async () => {
    const fixture = createStorageFixture({ version: 0 });
    const controller = createFinanceController(() => {}, { environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (action, id) => controller.click({ dataset: { financeAction: action, id } });
    input('gate', 'confirmation', '合成測試'); await click('connect');
    const repo = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    await repo.execute(command('create-reminder', 91, { name: '未關聯測試提醒', entryType: 'expense', amountTwd: 50, repeat: 'once', advanceDays: 1, date: '2026-11-05' }), context);
    const rule = (await repo.read()).reminderRules[0];
    await click('reload'); await click('delete-rule', rule.id);
    let html = controller.render('reminders');
    assert(html.includes('data-finance-action="confirm-delete-rule"') && html.includes('<svg') && html.includes('role="alertdialog"') && html.includes('確定要刪除「未關聯測試提醒」嗎？'), '刪除確認未顯示中央對話框及項目名稱');
    await click('confirm-delete-rule');
    const result = await repo.read();
    assert(result.reminderRules.length === 0 && result.reminderOccurrences.length === 0, '未關聯提醒未真正刪除');
    assert(controller.render('reminders').includes('提醒與未入帳期次已刪除'), '刪除成功後沒有明確回饋');
  });
  test('候選正式資料的八集合備份可驗證，正式資料庫以 V5 結構開啟', async () => {
    const s = await setup({ old: true }); const data = await accounts(s);
    const candidate = structuredClone(data); candidate.financePreferences[0].dataset = 'official';
    for (const name of ['accounts', 'accountEvents', 'reminderRules', 'reminderOccurrences']) for (const item of candidate[name]) item.dataset = 'official';
    const backup = await validateFinanceBackup((await createFinanceBackup(candidate)).text); same(backup.data, expectedFinanceBackupData(candidate));
    same(backup.data.expenses, s.original.expenses); same(backup.data.incomes, s.original.incomes);
    await rejects(() => s.repository.restoreAcceptance(candidate, financeSnapshotToken(data)));
    const fixture = createStorageFixture({ version: 0 });
    const db = await openFinanceDatabase({ environment: fixture.environment });
    assert(OFFICIAL_FINANCE_ENABLED && fixture.openCalls.length === 1
      && fixture.openCalls[0].name === 'LifeRecord_Official_V1'
      && fixture.version === 5 && db.objectStoreNames.contains('financeRecovery'), '正式 V5 資料庫或復原集合未開啟');
  });
  test('每月預算按實際支出月份計算、可設定子分類、只改當月或沿用未來且納入備份', async () => {
    const s = await setup({ old: true });
    let data = await accounts(s);
    const cash = data.accounts[0].id;
    await s.repository.execute(command('set-budget', 80, { categoryId: 'cat-food', subcategoryId: '', month: '2026-01', amountTwd: 20, applyFuture: true, expectedRevision: data.financePreferences[0].revision }), context);
    await s.repository.execute(record(81, cash, { date: '2026-01-10', amountTwd: 5 }), context);
    await s.repository.execute(record(82, cash, { date: '2026-02-10', amountTwd: 25 }), context);
    data = await s.repository.read();
    let january = calculateMonthlyBudgets(data, '2026-01')[0];
    let february = calculateMonthlyBudgets(data, '2026-02')[0];
    assert(january.budgetMinor === 2000n && january.actualMinor === 1550n && !january.exceeded, 'January did not include the legacy cents without rounding');
    assert(february.budgetMinor === 2000n && february.actualMinor === 2500n && february.exceeded, 'recurring default or overbudget calculation failed');
    await s.repository.execute(command('set-budget', 83, { categoryId: 'cat-food', subcategoryId: '', month: '2026-02', amountTwd: 30, applyFuture: false, expectedRevision: data.financePreferences[0].revision }), context);
    await s.repository.execute(record(84, cash, { date: '2026-03-10', amountTwd: 25 }), context);
    data = await s.repository.read();
    february = calculateMonthlyBudgets(data, '2026-02')[0];
    const march = calculateMonthlyBudgets(data, '2026-03')[0];
    assert(february.budgetMinor === 3000n && !february.exceeded && march.budgetMinor === 2000n && march.exceeded, 'current-month override changed future schedule');
    await s.repository.execute(command('set-budget', 85, { categoryId: 'cat-food', subcategoryId: 'sub-lunch', month: '2026-02', amountTwd: 10, applyFuture: true, expectedRevision: data.financePreferences[0].revision }), context);
    data = await s.repository.read();
    assert(calculateMonthlyBudgets(data, '2026-02').some((item) => item.subcategoryId === 'sub-lunch' && item.budgetMinor === 1000n), 'subcategory budget was not scoped by its stable ID');
    const backup = await validateFinanceBackup((await createFinanceBackup(data)).text);
    assert(backup.formatVersion === 6 && backup.summary.budgetSchedules === 2 && backup.summary.budgetOverrides === 1, 'budget settings were not included in the versioned finance backup');
    const prior = structuredClone(backup.data); delete prior.financePreferences[0].budgetSchedules; delete prior.financePreferences[0].budgetOverrides;
    await rejects(() => s.repository.restoreAcceptance(prior, financeSnapshotToken(data), { formatVersion: 2 }), '不含每月預算');
  });
  test('候選分類管理可持久保存名稱，另一個過期分頁不能覆蓋新版本', async () => {
    const fixture = createCatalogV3Fixture();
    const first = createFinanceController(() => {}, { environment: fixture.environment });
    const second = createFinanceController(() => {}, { environment: fixture.environment });
    const input = (controller, form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (controller, financeAction, extra = {}) => controller.click({ dataset: { financeAction, ...extra } });
    input(first, 'gate', 'confirmation', '合成測試'); await click(first, 'connect');
    input(second, 'gate', 'confirmation', '合成測試'); await click(second, 'connect');
    assert(first.renderSetting('acceptance').includes('finance-candidate-catalog') && second.renderSetting('acceptance').includes('finance-candidate-catalog'), '分類驗收工具沒有移到專用頁面');
    input(first, 'catalog', 'categoryId', 'cat-food'); input(first, 'catalog', 'name', '吃-驗收保存');
    await click(first, 'save-catalog');
    input(second, 'catalog', 'categoryId', 'cat-food'); input(second, 'catalog', 'name', '吃-舊版本');
    await click(second, 'save-catalog');
    const repository = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    const data = await repository.read();
    assert(data.categoryCatalog[0].categories.find((item) => item.id === 'cat-food').name === '吃-驗收保存');
    assert(second.renderSetting('acceptance').includes('分類已在其他分頁更新'), 'stale catalog page did not report a conflict');
    await click(first, 'reload'); assert(first.renderSetting('acceptance').includes('吃-驗收保存'), 'saved catalog name was not read back');
  });
  test('舊八集合 v2 備份仍可驗證，舊格式缺少預算欄位可讀但不能覆蓋已有預算', async () => {
    const s = await setup(); const data = await accounts(s);
    const envelope = JSON.parse((await createFinanceBackup(data)).text);
    envelope.formatVersion = 2; delete envelope.sha256;
    delete envelope.data.financePreferences[0].budgetSchedules; delete envelope.data.financePreferences[0].budgetOverrides;
    delete envelope.data.financePreferences[0].entryPreferences;
    envelope.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(envelope))))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const validated = await validateFinanceBackup(JSON.stringify(envelope));
    assert(validated.formatVersion === 2 && validated.data.financePreferences[0].budgetSchedules === undefined, 'legacy v2 backup was not accepted as read-only compatible');
  });
  test('偏好操作面板可保存設定，候選記帳表單套用收支、日期與帳戶預設', async () => {
    const fixture = createCatalogV3Fixture();
    const controller = createFinanceController(() => {}, { environment: fixture.environment });
    const input = (form, field, value) => controller.input({ dataset: { financeForm: form, financeField: field }, value });
    const click = (financeAction, extra = {}) => controller.click({ dataset: { financeAction, ...extra } });
    input('gate', 'confirmation', '合成測試'); await click('connect');
    const repo = createFinanceRepository({ mode: 'acceptance', environment: fixture.environment });
    await repo.execute(command('create-account', 1, { name: '合成預設帳戶', type: 'cash', openingTwd: 100, date: '2026-01-01' }), context);
    await click('reload');
    let data = await repo.read(); const accountId = data.accounts[0].id;
    assert(!controller.openAccountView('preferences'), '記帳偏好不可再塞入資金帳戶操作分頁');
    let html = controller.renderSetting('preferences');
    assert(html.includes('新增記帳時先顯示'), '記帳偏好獨立頁沒有打開');
    assert(html.includes(`data-choice-field="preferredAccountId" data-choice-value="${accountId}" data-choice-card="account"`) && html.includes('style="--account-color:'), '記帳偏好帳戶卡片沒有提供帳戶識別色');
    assert(html.includes('data-choice-field="dateMode" data-choice-value="today"') && html.includes('data-choice-field="dateMode" data-choice-value="last-entry"'), '日期偏好沒有保留今天與上次使用日期選項');
    await click('choose-preference', { choiceField: 'defaultEntryType', choiceValue: 'income' });
    await click('choose-preference', { choiceField: 'dateMode', choiceValue: 'last-entry' });
    await click('choose-preference', { choiceField: 'preferredAccountId', choiceValue: accountId });
    await click('save-preferences');
    data = await repo.read();
    assert(data.financePreferences[0].entryPreferences.defaultEntryType === 'income', '預設收支類型沒有保存');
    assert(data.financePreferences[0].entryPreferences.dateMode === 'last-entry', '日期模式沒有保存');
    await repo.execute(record(2, accountId, { entryType: 'income', categoryId: 'income-part-time', subcategoryId: 'sub-income-wage', date: '2026-11-03' }), context);
    await click('reload');
    html = controller.renderSetting('preferences');
    assert(html.includes('data-choice-field="defaultEntryType" data-choice-value="income" data-choice-card="chip" aria-pressed="true"') && html.includes('data-choice-field="dateMode" data-choice-value="last-entry" data-choice-card="chip" aria-pressed="true"') && html.includes(`data-choice-field="preferredAccountId" data-choice-value="${accountId}" data-choice-card="account" aria-pressed="true"`) && !html.includes('finance-account-layout'), '偏好沒有保存在獨立設定頁或混入帳戶畫面');
    assert(!controller.render('accounts').includes('預設收支類型') && !controller.render('accounts').includes('finance-budget-screen'), '資金帳戶頁混入記帳偏好或預算');
  });
  test('記帳偏好保存、日期預設與帳戶優先順序正確，舊備份不會覆蓋自訂偏好', async () => {
    const s = await setup(); let data = await accounts(s);
    const [cash, bank] = data.accounts;
    data = (await s.repository.execute({ kind: 'set-entry-preferences', defaultEntryType: 'income', dateMode: 'last-entry', preferredAccountId: bank.id, expectedRevision: data.financePreferences[0].revision }, context)).data;
    assert(resolveDefaultAccount(data, 'expense', 'cat-motorcycle') === bank.id, 'global preferred account fallback failed');
    await s.repository.execute({ kind: 'set-default', categoryId: 'cat-food', entryType: 'expense', accountId: cash.id, expectedRevision: data.financePreferences[0].revision }, context);
    data = await s.repository.read(); assert(resolveDefaultAccount(data, 'expense', 'cat-food') === cash.id, 'category account default did not take priority');
    const saved = await s.repository.execute(record(88, cash.id, { date: '2026-11-04' }), context);
    assert(saved.data.financePreferences[0].entryPreferences.lastEntryDate === '2026-11-04', 'last entry date was not recorded atomically');
    await s.repository.execute({ kind: 'edit-account', accountId: bank.id, expectedRevision: bank.revision, name: bank.name, active: false }, context);
    data = await s.repository.read(); assert(resolveDefaultAccount(data, 'expense', 'cat-motorcycle') === '', 'inactive preferred account was auto-selected');
    const backup = await validateFinanceBackup((await createFinanceBackup(data)).text);
    assert(backup.formatVersion === 6 && backup.data.financePreferences[0].entryPreferences.defaultEntryType === 'income');
    const older = structuredClone(data); delete older.financePreferences[0].entryPreferences;
    await rejects(() => s.repository.restoreAcceptance(older, financeSnapshotToken(data), { formatVersion: 3 }), '不含已保存的記帳偏好');
    same(await s.repository.read(), data);
  });
  test('隔離歸零要求已保存備份與確認詞；交易中止完整回復，成功後跨世代且保留兩組獨立其他分類', async () => {
    const s = await setup(); let data = await accounts(s); const accountId = data.accounts[0].id;
    data = (await s.repository.execute(record(990, accountId), context)).data;
    data = (await s.repository.execute(command('create-reminder', 991, { name: '合成待辦', amountTwd: 30, date: '2026-11-08', entryType: 'expense', repeat: 'once', advanceDays: 1, note: '' }), context)).data;
    const before = await s.repository.read(); const token = financeSnapshotToken(before);
    await rejects(() => s.repository.resetAcceptance(token, { confirmation: '重設合成資料', backupSaved: false }), '請先保存');
    await rejects(() => s.repository.resetAcceptance(token, { confirmation: '錯誤確認', backupSaved: true }), '指定確認詞');
    same(await s.repository.read(), before);
    s.fixture.setAbortWrites(true);
    await rejects(() => s.repository.resetAcceptance(token, { confirmation: '重設合成資料', backupSaved: true }));
    s.fixture.setAbortWrites(false);
    same(await s.repository.read(), before);
    const reset = await s.repository.resetAcceptance(token, { confirmation: '重設合成資料', backupSaved: true });
    assert(reset.expenses.length === 0 && reset.incomes.length === 0 && reset.accounts.length === 0 && reset.accountEvents.length === 0 && reset.reminderRules.length === 0 && reset.reminderOccurrences.length === 0, '歸零後仍有舊記帳資料');
    assert(reset.financePreferences[0].generation === before.financePreferences[0].generation + 1, 'generation 未前進');
    const initialCatalog = createMinimumFinanceCatalog(before.categoryCatalog[0].revision + 1);
    same(reset.categoryCatalog[0], initialCatalog);
    assert(reset.financePreferences[0].defaults.length === 0 && reset.financePreferences[0].budgetSchedules.length === 0 && reset.financePreferences[0].budgetOverrides.length === 0, '重設後仍有舊記帳偏好或預算');
    assert(createMinimumFinanceCatalog(7).revision === 7, '最低分類 helper 不可重複產生固定 revision');
    await rejects(() => s.repository.execute(record(992, accountId), { ...context, expectedGeneration: before.financePreferences[0].generation }), '資料曾經還原');
  });
  test('初始狀態恢復在正式 V5 與隔離驗收皆提供備份及二次確認保護', async () => {
    const s = await setup(); const acceptance = createFinanceController(() => {}, { environment: s.fixture.environment, mode: 'acceptance' });
    acceptance.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await acceptance.click({ dataset: { financeAction: 'connect' } });
    const acceptanceHtml = acceptance.render('backup');
    assert(acceptanceHtml.includes('恢復初始狀態') && acceptanceHtml.includes('先下載完整備份') && !acceptanceHtml.includes('data-finance-action="reset-acceptance"'), '隔離資料在完成備份確認前不可執行重設');
    const acceptanceSettings = acceptance.renderSetting('ledger');
    assert(acceptanceHtml.includes('目前沒有可復原的操作') && acceptanceSettings.includes('隔離驗收工具與復原測試'), '隔離區沒有說明復原點何時出現或提供明確工具入口');
    const actionCards = [...acceptanceSettings.matchAll(/<section class="finance-data-action-card[^"]*">/g)];
    const actionOrder = ['快速備份', '匯入備份', '復原上一個操作', '恢復初始狀態'].map((label) => acceptanceSettings.indexOf(`<h3>${label}</h3>`));
    assert(actionCards.length === 4 && actionOrder.every((position, index) => position >= 0 && (index === 0 || position > actionOrder[index - 1])), '資料管理沒有依序顯示四張操作卡');
    const officialFixture = createStorageFixture({ version: 0 });
    const official = createFinanceController(() => {}, { environment: officialFixture.environment, mode: 'official' });
    await official.onEnter();
    const officialHtml = official.render('backup');
    assert(officialHtml.includes('V5 正式版') && officialHtml.includes('恢復初始狀態')
      && officialHtml.includes('先下載完整備份') && !officialHtml.includes('data-finance-action="reset-acceptance"'), '正式 V5 未顯示有備份保護的重設入口');
    assert(officialFixture.openCalls.every((item) => item.name === 'LifeRecord_Official_V1'), '正式 V5 操作了預期以外的資料庫');
  });
  test('復原確認詞輸入後立即通知介面更新確認按鈕', () => {
    const changes = [];
    const controller = createFinanceController((change) => changes.push(change), { mode: 'acceptance', environment: {} });
    controller.input({ dataset: { financeForm: 'recovery', financeField: 'confirmation' }, value: '復原上一個操作' });
    assert(changes.some((change) => change.field?.form === 'recovery' && change.field.field === 'confirmation'), '復原確認詞輸入沒有觸發欄位重繪');
  });
  test('資料管理恢復初始狀態須先下載備份、輸入確認並二次確認；取消不寫入且只清理目前環境偏好', async () => {
    const s = await setup(); const downloads = attachDownloadFixture(s.fixture.environment); const localValues = new Map([
      ['LifeRecord_UI_AccountOrder_v1_acceptance', '{"version":1,"ids":[]}'],
      ['LifeRecord_UI_BudgetOrder_v1_acceptance_2026-11', '{"version":1,"ids":[]}'],
      [OVERVIEW_PREFERENCES_KEY, JSON.stringify({ ...defaultOverviewPreferences(), personal: { blocks: ['recent', 'monthly', 'budget'], focus: ['cat-food::sub-lunch'], budgetCollapsed: true } })],
      ['LifeRecord_UI_OperationHints_v1', 'keep-hints'],
      ['LifeRecord_UI_AccountOrder_v1_official', 'keep-other-environment'],
    ]);
    s.fixture.environment.localStorage = {
      get length() { return localValues.size; },
      key(index) { return [...localValues.keys()][index] ?? null; },
      getItem(name) { return localValues.get(name) ?? null; },
      setItem(name, value) { localValues.set(name, String(value)); },
      removeItem(name) { localValues.delete(name); },
    };
    const sessionValues = new Map([['LifeRecord_Finance_acceptance_ReminderRuleExpansion_v1', '["old-rule"]']]);
    s.fixture.environment.sessionStorage = {
      getItem(name) { return sessionValues.get(name) ?? null; },
      setItem(name, value) { sessionValues.set(name, String(value)); },
      removeItem(name) { sessionValues.delete(name); },
    };
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    let data = await s.repository.read();
    data = (await s.repository.execute(command('create-account', 2001, { name: '待重設帳戶', type: 'cash', openingTwd: 500 }), { ...context, expectedGeneration: data.financePreferences[0].generation })).data;
    data = (await s.repository.execute(record(2002, data.accounts[0].id), { ...context, expectedGeneration: data.financePreferences[0].generation })).data;
    await controller.click({ dataset: { financeAction: 'reload' } });
    const before = await s.repository.read();
    const prepareReset = async () => {
      await controller.click({ dataset: { financeAction: 'export' } });
      assert(downloads.at(-1)?.filename.startsWith('LifeRecord_Acceptance_FinanceBackup_'), '重設前未下載目前環境的備份');
      same(await s.repository.read(), before);
      controller.input({ dataset: { financeForm: 'reset', financeField: 'backupSaved' }, type: 'checkbox', checked: true });
      controller.input({ dataset: { financeForm: 'reset', financeField: 'confirmation' }, value: '恢復初始狀態' });
      await controller.click({ dataset: { financeAction: 'reset-acceptance' } });
      assert(controller.renderSetting('ledger').includes('data-finance-reset-dialog'), '沒有顯示中央二次確認視窗');
    };
    await prepareReset();
    await controller.click({ dataset: { financeAction: 'cancel-reset-confirmation' } });
    same(await s.repository.read(), before);
    await prepareReset();
    await controller.click({ dataset: { financeAction: 'confirm-reset-acceptance' } });
    const resetData = await s.repository.read();
    assert(!resetData.expenses.length && !resetData.incomes.length && !resetData.accounts.length && !resetData.accountEvents.length && !resetData.reminderRules.length && !resetData.reminderOccurrences.length, '重設後仍有舊記帳資料');
    const reopenedRepository = createFinanceRepository({ mode: 'acceptance', environment: s.fixture.environment });
    same(await reopenedRepository.read(), resetData);
    const initialCatalog = createMinimumFinanceCatalog(before.categoryCatalog[0].revision + 1);
    same(resetData.categoryCatalog[0], initialCatalog);
    const overviewAfterReset = JSON.parse(localValues.get(OVERVIEW_PREFERENCES_KEY));
    same(overviewAfterReset.personal, { blocks: ['recent', 'monthly', 'budget'], focus: ['cat-food::sub-lunch'], budgetCollapsed: true });
    same(overviewAfterReset.preview, defaultOverviewPreferences().preview);
    assert(localValues.has(OVERVIEW_PREFERENCES_KEY) && localValues.has('LifeRecord_UI_OperationHints_v1') && localValues.has('LifeRecord_UI_AccountOrder_v1_official'), '重設清除了全域偏好或其他資料環境偏好');
    assert(!localValues.has('LifeRecord_UI_AccountOrder_v1_acceptance') && !localValues.has('LifeRecord_UI_BudgetOrder_v1_acceptance_2026-11') && !sessionValues.has('LifeRecord_Finance_acceptance_ReminderRuleExpansion_v1'), '重設未清除此隔離環境專屬的記帳顯示偏好');
    const reopenedController = createFinanceController(() => {}, { environment: s.fixture.environment, mode: 'acceptance' });
    reopenedController.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await reopenedController.click({ dataset: { financeAction: 'connect' } });
    assert(reopenedController.render('backup').includes('本機復原點') && reopenedController.render('backup').includes('同一瀏覽器設定檔重開後仍保留'), '重新連接後沒有讀回本機復原點');
    await reopenedController.click({ dataset: { financeAction: 'open-recovery-undo' } });
    reopenedController.input({ dataset: { financeForm: 'recovery', financeField: 'confirmation' }, value: '復原上一個操作' });
    await reopenedController.click({ dataset: { financeAction: 'confirm-recovery-undo' } });
    const afterUndo = await reopenedRepository.read();
    assert(afterUndo.expenses.length === before.expenses.length && afterUndo.accounts.length === before.accounts.length, '重開後復原未還原操作前的收支與帳戶');
  });
  test('隔離備份加入按穩定 ID 略過重複、拒絕衝突並可復原匯入', async () => {
    const s = await setup(); const base = await accounts(s); const current = await s.repository.read();
    const incoming = applyFinanceCommand(current, record(2010, current.accounts[0].id, { amountTwd: 35 }), { ...context, dataset: 'acceptance' }).data;
    const preview = mergeFinanceSnapshots(current, incoming);
    assert(preview.hasChanges && preview.totalAdded >= 2, '合併預覽沒有列出新增收支與帳戶異動');
    const beforeToken = financeSnapshotToken(current);
    const merged = await s.repository.restoreAcceptance(incoming, beforeToken, { formatVersion: 6, importMode: 'merge' });
    assert(merged.expenses.length === current.expenses.length + 1, '合併沒有加入新的收支');
    assert(!mergeFinanceSnapshots(merged, incoming).hasChanges, '再次加入相同備份沒有略過既有資料');
    const conflict = structuredClone(incoming); conflict.expenses[0].note = '同 ID 不同內容';
    await rejects(() => mergeFinanceSnapshots(merged, conflict), '內容不同');
    const recovery = await s.repository.getRecoveryPoint();
    const reverted = await s.repository.undoLastOperation(financeSnapshotToken(await s.repository.read()), { confirmation: '復原上一個操作' });
    assert(recovery?.action === 'merge' && reverted.expenses.length === current.expenses.length && reverted.accounts.length === base.accounts.length, '匯入合併復原點沒有回到匯入前狀態');
    const nextBase = await s.repository.read();
    const nextImport = applyFinanceCommand(nextBase, record(2011, nextBase.accounts[0].id, { amountTwd: 20 }), { ...context, dataset: 'acceptance' }).data;
    await s.repository.restoreAcceptance(nextImport, financeSnapshotToken(nextBase), { formatVersion: 6, importMode: 'replace' });
    const afterImport = await s.repository.read();
    const afterNewEntry = (await s.repository.execute(record(2012, afterImport.accounts[0].id, { amountTwd: 10 }), { ...context, expectedGeneration: afterImport.financePreferences[0].generation })).data;
    await rejects(() => s.repository.undoLastOperation(financeSnapshotToken(afterNewEntry), { confirmation: '復原上一個操作' }), '資料已有變動');
  });
  test('刪除預算須確認與最新版本，中止完整回復，不變更舊收支與帳戶', async () => {
    const s = await setup({ old: true }); let data = await accounts(s);
    data = (await s.repository.execute({ kind: 'set-budget', categoryId: 'cat-food', month: '2026-11', amountTwd: 10000, applyFuture: true, expectedRevision: data.financePreferences[0].revision }, context)).data;
    const before = structuredClone(data); const id = data.financePreferences[0].budgetSchedules[0].id;
    const deletion = { kind: 'delete-budget', budgetId: id, expectedRevision: data.financePreferences[0].revision, confirmed: true };
    await rejects(() => s.repository.execute({ ...deletion, confirmed: false }, context), '確認');
    await rejects(() => s.repository.execute({ ...deletion, expectedRevision: -1 }, context), '已被修改');
    same(await s.repository.read(), before);
    s.fixture.setAbortWrites(true); await rejects(() => s.repository.execute(deletion, context)); s.fixture.setAbortWrites(false); same(await s.repository.read(), before);
    const deleted = (await s.repository.execute(deletion, context)).data;
    assert(deleted.financePreferences[0].budgetSchedules.length === 0);
    for (const key of ['expenses', 'incomes', 'accounts', 'accountEvents', 'categoryCatalog']) same(deleted[key], before[key]);
    assert(deleted.expenses[0].amountMinor === 1050 && deleted.incomes[0].amountMinor === 1050);
    await rejects(() => s.repository.execute(deletion, context), '已被修改');
  });
  test('預算一至六張保留獨立卡片，編輯載入整數元，取消刪除不變更資料', async () => {
    const s = await setup(); let lastChange = {}; const controller = createFinanceController((options) => { lastChange = options; }, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' }); await controller.click({ dataset: { financeAction: 'connect' } });
    const categories = s.data.categoryCatalog[0].categories.filter((item) => item.entryType === 'expense').slice(0, 6);
    await s.repository.execute({ kind: 'set-budget', categoryId: categories[0].id, month: '2026-11', amountTwd: 10000, applyFuture: true, expectedRevision: (await s.repository.read()).financePreferences[0].revision }, context);
    await controller.click({ dataset: { financeAction: 'reload' } });
    controller.input({ dataset: { financeForm: 'budget', financeField: 'month' }, value: '2026-11' });
    const coloredBudget = controller.renderSetting('budget');
    assert(coloredBudget.includes(`--budget-category-color:${categories[0].color}`) && coloredBudget.includes('finance-budget-category-icon'), '預算卡片沒有使用分類識別色和圖示');
    for (let count = 1; count <= 6; count += 1) {
      const data = await s.repository.read();
      await s.repository.execute({ kind: 'set-budget', categoryId: categories[count - 1].id, month: '2026-11', amountTwd: 10000, applyFuture: true, expectedRevision: data.financePreferences[0].revision }, context);
      await controller.click({ dataset: { financeAction: 'reload' } });
      controller.input({ dataset: { financeForm: 'budget', financeField: 'month' }, value: '2026-11' });
      const html = controller.renderSetting('budget');
      assert((html.match(/<article class="finance-budget-card /g) || []).length === count, `${count} 張卡片數量不符`);
      assert((html.match(/data-finance-action="delete-budget"/g) || []).length === count, '缺少卡片右側刪除入口');
    }
    const rowsToSort = calculateMonthlyBudgets(await s.repository.read(), '2026-11').map(budgetOrderKey).reverse();
    const localValues = new Map(); s.fixture.environment.localStorage = { getItem: (name) => localValues.get(name) ?? null, setItem: (name, value) => localValues.set(name, value) };
    saveBudgetOrder(rowsToSort, '2026-11', s.fixture.environment, 'acceptance');
    const freshController = createFinanceController(() => {}, { environment: s.fixture.environment });
    freshController.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await freshController.click({ dataset: { financeAction: 'connect' } });
    freshController.input({ dataset: { financeForm: 'budget', financeField: 'month' }, value: '2026-11' });
    const orderedHtml = freshController.renderSetting('budget');
    const renderedIds = [...orderedHtml.matchAll(/data-budget-sort-item="([^"]+)"/g)].map((match) => match[1]);
    assert(renderedIds.join('|') === rowsToSort.join('|') && orderedHtml.includes('aria-keyshortcuts="ArrowUp ArrowDown"')
      && !orderedHtml.includes('move-budget-order'), '預算卡片顯示順序未依月份偏好載入，或出現顯眼移動按鈕');
    const before = await s.repository.read(); const budgetId = before.financePreferences[0].budgetSchedules[0].id;
    await controller.click({ dataset: { financeAction: 'edit-budget', budgetId } });
    assert(controller.renderSetting('budget').includes('value="10000"'), '編輯預算把元轉成分');
    await controller.click({ dataset: { financeAction: 'delete-budget', budgetId } });
    assert(lastChange.preserveScroll && lastChange.focusBudgetDeleteCancel, '開啟刪除確認未保留頁面位置或焦點');
    const confirmation = controller.renderSetting('budget');
    assert(confirmation.includes('data-budget-delete-dialog') && confirmation.includes('每月預算嗎？') && confirmation.includes('只刪除預算設定，不影響已記錄的交易。'), '刪除未顯示中央確認對話框及影響說明');
    assert(confirmation.includes('data-budget-delete-cancel') && confirmation.includes('data-budget-delete-confirm'), '刪除確認缺少取消或確認操作');
    await controller.click({ dataset: { financeAction: 'cancel-delete-budget' } }); same(await s.repository.read(), before);
    assert(lastChange.preserveScroll && lastChange.focusBudgetDeleteId === budgetId, '取消確認未回到原預算操作');
    await controller.click({ dataset: { financeAction: 'delete-budget', budgetId } });
    await controller.click({ dataset: { financeAction: 'confirm-delete-budget' } });
    const afterDelete = await s.repository.read();
    assert(!afterDelete.financePreferences[0].budgetSchedules.some((item) => item.id === budgetId), '確認後未刪除指定預算設定');
    const remainingBudgets = afterDelete.financePreferences[0].budgetSchedules.length;
    await controller.click({ dataset: { financeAction: 'confirm-delete-budget' } });
    assert((await s.repository.read()).financePreferences[0].budgetSchedules.length === remainingBudgets, '重複確認造成再次變更');
    assert(controller.getBudgetRows('2026-11') === null, '合成預算不可流入正式工作區摘要');
  });
  test('既有預算編輯預設只改當月，勾選未來才改後續月份', async () => {
    const s = await setup(); let data = await s.repository.read();
    data = (await s.repository.execute({ kind: 'set-budget', categoryId: 'cat-food', month: '2026-11', amountTwd: 10000, applyFuture: true, expectedRevision: data.financePreferences[0].revision }, context)).data;
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    const input = (field, value) => controller.input({ dataset: { financeForm: 'budget', financeField: field }, value });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' }); await controller.click({ dataset: { financeAction: 'connect' } });
    input('month', '2026-11'); input('categoryId', 'cat-food'); input('amountTwd', '12000');
    await controller.click({ dataset: { financeAction: 'save-budget' } }); data = await s.repository.read();
    assert(calculateMonthlyBudgets(data, '2026-11')[0].budgetTwd === 12000 && calculateMonthlyBudgets(data, '2026-12')[0].budgetTwd === 10000, '未勾選未來卻修改後續月份');
    input('month', '2026-12'); input('amountTwd', '15000'); input('applyFuture', 'true'); await controller.click({ dataset: { financeAction: 'save-budget' } }); data = await s.repository.read();
    assert(calculateMonthlyBudgets(data, '2026-12')[0].budgetTwd === 15000 && calculateMonthlyBudgets(data, '2027-01')[0].budgetTwd === 15000 && calculateMonthlyBudgets(data, '2026-11')[0].budgetTwd === 12000, '未來套用或跨年預算錯誤');
  });
  test('typed general account defaults inherit by transaction type and protect FinanceBackup v5 restore', async () => {
    const s = await setup(); let data = await accounts(s); const [cash, bank] = data.accounts;
    data = (await s.repository.execute({ kind: 'set-entry-preferences', defaultEntryType: 'expense', dateMode: 'today', preferredAccountId: '', preferredAccountIds: { expense: cash.id, income: bank.id }, expectedRevision: data.financePreferences[0].revision }, context)).data;
    assert(resolveDefaultAccount(data, 'expense', 'cat-motorcycle') === cash.id, 'expense category without an override did not inherit the expense default');
    assert(resolveDefaultAccount(data, 'income', 'income-part-time') === bank.id, 'income used the expense default account');
    data = (await s.repository.execute({ kind: 'set-default', categoryId: 'cat-food', entryType: 'expense', accountId: bank.id, expectedRevision: data.financePreferences[0].revision }, context)).data;
    assert(resolveDefaultAccount(data, 'expense', 'cat-food') === bank.id, 'category-specific account did not take priority');
    assert(resolveDefaultAccount(data, 'expense', 'cat-mobile') === cash.id, 'category without a specific override did not inherit the general account');
    data = (await s.repository.execute({ kind: 'edit-account', accountId: cash.id, expectedRevision: cash.revision, name: cash.name, active: false }, context)).data;
    assert(resolveDefaultAccount(data, 'expense', 'cat-mobile') === '', 'inactive general account was auto-selected');
    assert(resolveDefaultAccount(data, 'expense', 'cat-food') === bank.id, 'inactive general account overrode a valid category-specific account');

    const backup = await validateFinanceBackup((await createFinanceBackup(data)).text);
    assert(backup.formatVersion === 6, 'typed general defaults require FinanceBackup format 6');
    same(backup.data.financePreferences[0].entryPreferences.preferredAccountIds, { expense: cash.id, income: bank.id });
    const legacy = JSON.parse((await createFinanceBackup(data)).text);
    legacy.formatVersion = 5; delete legacy.data.financePreferences[0].entryPreferences.preferredAccountIds; delete legacy.sha256;
    legacy.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(legacy))))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const older = await validateFinanceBackup(JSON.stringify(legacy));
    await rejects(() => s.repository.restoreAcceptance(older.data, financeSnapshotToken(data), { formatVersion: older.formatVersion }), '格式 6');
    same(await s.repository.read(), data);
  });
  test('recreating a stopped reminder with the same name creates an independent rule and occurrence history', async () => {
    const s = await setup(); let data = await accounts(s); const cash = data.accounts[0];
    data = (await s.repository.execute(command('create-reminder', 920, { name: 'GPT 訂閱', entryType: 'expense', amountTwd: 690, repeat: 'monthly', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const oldRule = data.reminderRules[0]; const oldCurrent = data.reminderOccurrences.find((item) => item.ruleId === oldRule.id && item.dueDate === '2026-11-05');
    data = (await s.repository.execute(record(921, cash.id, { reminderOccurrenceId: oldCurrent.id, expectedOccurrenceRevision: oldCurrent.revision, date: oldCurrent.dueDate, amountTwd: 690 }), context)).data;
    data = (await s.repository.execute({ kind: 'cancel-reminder', ruleId: oldRule.id, expectedRevision: oldRule.revision }, context)).data;
    const oldCompleted = data.reminderOccurrences.find((item) => item.id === oldCurrent.id);
    data = (await s.repository.execute(command('create-reminder', 922, { name: 'GPT 訂閱', entryType: 'expense', amountTwd: 720, repeat: 'monthly', advanceDays: 1, date: '2026-11-05' }), context)).data;
    const newRule = data.reminderRules.find((item) => item.id !== oldRule.id && item.name === oldRule.name);
    const newCurrent = data.reminderOccurrences.find((item) => item.ruleId === newRule?.id && item.dueDate === '2026-11-05');
    assert(newRule && newRule.id !== oldRule.id && newRule.active, 'same-name reminder was not created as a new active rule');
    assert(oldCompleted.status === 'completed' && oldCompleted.entryId && data.reminderRules.find((item) => item.id === oldRule.id).active === false, 'old completed reminder history was changed');
    assert(newCurrent?.status === 'pending' && newCurrent.id !== oldCurrent.id, 'new reminder reused a cancelled/completed occurrence');
    assert(data.expenses.length === 1 && data.accountEvents.filter((item) => item.type === 'expense').length === 1, 'recreating a rule duplicated a transaction or account event');
  });
  test('category default drafts keep explicit unset state across categories and inherit the typed general default', async () => {
    const s = await setup(); let data = await accounts(s); const [cash, bank] = data.accounts;
    data = (await s.repository.execute({ kind: 'set-entry-preferences', defaultEntryType: 'expense', dateMode: 'today', preferredAccountId: '', preferredAccountIds: { expense: cash.id, income: bank.id }, expectedRevision: data.financePreferences[0].revision }, context)).data;
    const controller = createFinanceController(() => {}, { environment: s.fixture.environment });
    controller.input({ dataset: { financeForm: 'gate', financeField: 'confirmation' }, value: '合成測試' });
    await controller.click({ dataset: { financeAction: 'connect' } });
    const choose = (financeAction, extra = {}) => controller.click({ dataset: { financeAction, ...extra } });
    await choose('choose-default-type', { entryType: 'expense' });
    await choose('choose-default-category', { categoryId: 'cat-food' });
    await choose('choose-default-account', { accountId: '' });
    await choose('choose-default-category', { categoryId: 'cat-motorcycle' });
    await choose('choose-default-account', { accountId: bank.id });
    await choose('choose-default-category', { categoryId: 'cat-food' });
    const draftHtml = controller.renderSetting('defaults');
    assert(draftHtml.includes(`data-account-id="${cash.id}" data-choice-card="account" aria-pressed="true"`) && draftHtml.includes('data-account-id="" data-choice-card="account" aria-pressed="false"'), '未設定分類專屬帳戶時，介面未顯示沿用中的通用預設帳戶');
    assert(draftHtml.includes('此分類沒有專屬預設') && draftHtml.includes(cash.name), 'UI did not explain inheritance from the general expense account');
    await choose('save-default');
    const saved = await s.repository.read();
    assert(!saved.financePreferences[0].defaults.some((item) => item.categoryId === 'cat-food' && item.entryType === 'expense'), 'explicit unset created a category-specific account instead of inheriting');
    assert(saved.financePreferences[0].defaults.some((item) => item.categoryId === 'cat-motorcycle' && item.accountId === bank.id), 'switching categories lost the other unsaved account choice');
    assert(resolveDefaultAccount(saved, 'expense', 'cat-food') === cash.id && resolveDefaultAccount(saved, 'expense', 'cat-motorcycle') === bank.id, 'category and general default priority was incorrect after batch save');
  });
  test('history edit updates an income/expense record and its account event atomically while preserving identity and creation time', async () => {
    const s = await setup(); let data = await accounts(s); const [cash, bank] = data.accounts;
    data = (await s.repository.execute(record(930, cash.id, { note: '原支出' }), context)).data;
    let expense = data.expenses[0]; const originalCreatedAt = expense.createdAt; const originalKey = expense.idempotencyKey;
    data = (await s.repository.execute({ kind: 'edit-entry', entryType: 'expense', entryId: expense.id, expectedEditRevision: 0, amountMinor: 12500, date: '2026-11-20', note: '更新支出', categoryId: 'cat-motorcycle', subcategoryId: 'sub-fuel', accountId: bank.id, paymentMethod: 'direct' }, context)).data;
    expense = data.expenses[0];
    const expenseEvent = data.accountEvents.find((item) => item.id === expense.financeEventId);
    assert(expense.id === data.expenses[0].id && expense.idempotencyKey === originalKey && expense.createdAt === originalCreatedAt && expense.modifiedAt === context.now, 'expense identity or creation time was changed');
    assert(expense.amountMinor === 12500 && expense.occurredOn === '2026-11-20' && expense.categoryId === 'cat-motorcycle' && expense.subcategoryId === 'sub-fuel' && expense.note === '更新支出', 'expense fields did not update');
    assert(expenseEvent?.lines[0].accountId === bank.id && expenseEvent.lines[0].deltaTwd === -125 && expenseEvent.occurredOn === expense.occurredOn && accountBalances(data).get(cash.id) === 1000n && accountBalances(data).get(bank.id) === 1875n, 'expense account movement did not follow the edit');
    await rejects(() => s.repository.execute({ kind: 'edit-entry', entryType: 'expense', entryId: expense.id, expectedEditRevision: 0, amountMinor: 13000, date: '2026-11-20', note: '過期版本', categoryId: 'cat-motorcycle', subcategoryId: 'sub-fuel', accountId: bank.id, paymentMethod: 'direct' }, context), '其他分頁修改');
    data = (await s.repository.execute(command('record', 931, { entryType: 'income', categoryId: 'income-part-time', subcategoryId: 'sub-income-wage', amountTwd: 300, accountId: cash.id, paymentMethod: 'cash', date: '2026-11-21' }), context)).data;
    const income = data.incomes[0]; const incomeCreatedAt = income.createdAt;
    data = (await s.repository.execute({ kind: 'edit-entry', entryType: 'income', entryId: income.id, expectedEditRevision: 0, amountMinor: 35000, date: '2026-11-22', note: '打工更新', categoryId: 'income-part-time', subcategoryId: 'sub-income-wage', accountId: cash.id, paymentMethod: 'cash' }, context)).data;
    assert(data.incomes[0].createdAt === incomeCreatedAt && data.incomes[0].amountMinor === 35000 && accountBalances(data).get(cash.id) === 1350n, 'income edit or account balance failed');
  });
  test('legacy cent-value entry keeps exact amount when edited without amount change', async () => {
    const s = await setup({ old: true }); const data = await s.repository.read(); const record = data.expenses[0]; const createdAt = record.createdAt;
    const edited = (await s.repository.execute({ kind: 'edit-entry', entryType: 'expense', entryId: record.id, expectedEditRevision: 0, amountMinor: record.amountMinor, date: '2026-01-02', note: '保留分金額', categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: '', paymentMethod: 'direct' }, context)).data;
    assert(edited.expenses[0].amountMinor === 1050 && edited.expenses[0].createdAt === createdAt && edited.expenses[0].modifiedAt === context.now, 'legacy fractional amount was rounded or creation timestamp changed');
    await rejects(() => s.repository.execute({ kind: 'edit-entry', entryType: 'expense', entryId: record.id, expectedEditRevision: 1, amountMinor: 1150, date: '2026-01-02', note: '改金額', categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: '', paymentMethod: 'direct' }, context), '整數元');
  });
  test('splitting replaces one entry with independent dated/accounted entries and permits a different total', async () => {
    const s = await setup(); let data = await accounts(s); const [cash, bank] = data.accounts;
    data = (await s.repository.execute(record(932, cash.id, { amountTwd: 100, date: '2026-10-31', note: '手機費' }), context)).data;
    const source = data.expenses[0];
    data = (await s.repository.execute({ kind: 'split-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, splits: [
      { date: '2026-10-31', amountTwd: '40', note: '手機費', categoryId: 'cat-food', subcategoryId: 'sub-dinner', accountId: cash.id, paymentMethod: 'cash' },
      { idempotencyKey: key(933), date: '2026-11-01', amountTwd: '50', note: '訂閱費', categoryId: 'cat-motorcycle', subcategoryId: 'sub-fuel', accountId: bank.id, paymentMethod: 'direct' },
    ] }, context)).data;
    assert(data.expenses.length === 2 && data.expenses[0].id === source.id && data.expenses[0].amountMinor === 4000 && data.expenses[1].amountMinor === 5000, 'split did not replace source with two independent rows');
    assert(data.expenses[0].createdAt === source.createdAt && data.expenses[0].editRevision === 1 && data.expenses[1].id !== source.id, 'split identity handling was incorrect');
    assert(data.accountEvents.filter((item) => item.type === 'expense').length === 2 && accountBalances(data).get(cash.id) === 960n && accountBalances(data).get(bank.id) === 1950n, 'split movements were not applied to both accounts');
    assert(data.accountEvents.filter((item) => item.type === 'expense').reduce((sum, item) => sum - item.lines[0].deltaTwd, 0) === 90, 'split total 90 did not replace original 100');
    await rejects(() => s.repository.execute({ kind: 'split-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, splits: [] }, context), '已在其他分頁修改');
  });
  test('含付款分配明細的紀錄不會被單筆編輯或拆分覆蓋', async () => {
    const s = await setup(); let data = await accounts(s); const [cash, bank] = data.accounts;
    data = (await s.repository.execute(record(937, cash.id, { amountTwd: 100, note: '混合付款' }), context)).data;
    const source = data.expenses[0];
    source.paymentSplits = [{ accountId: cash.id, amountTwd: 40 }, { accountId: bank.id, amountTwd: 60 }];
    validateFinanceSnapshot(data);
    const before = stableJson(data);
    await rejects(() => applyFinanceCommand(data, { kind: 'edit-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, amountMinor: 9000, date: source.occurredOn, note: source.note, categoryId: source.categoryId, subcategoryId: source.subcategoryId, accountId: cash.id, paymentMethod: 'cash' }, { ...context, dataset: 'acceptance' }), '多筆付款');
    await rejects(() => applyFinanceCommand(data, { kind: 'split-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, splits: [] }, { ...context, dataset: 'acceptance' }), '多筆付款');
    assert(stableJson(data) === before, 'blocked operation mutated the mixed-payment source');
  });
  test('修改或刪除較早交易時保留後續餘額校正的實際目標', async () => {
    const s = await setup(); let data = await accounts(s); const cash = data.accounts[0];
    data = (await s.repository.execute(record(938, cash.id, { amountTwd: 100, date: '2026-11-01' }), context)).data;
    data = (await s.repository.execute(command('adjustment', 939, { accountId: cash.id, date: '2026-11-03', targetTwd: '800', expectedBalanceTwd: '900', note: '月結校正' }), context)).data;
    let adjustment = data.accountEvents.find((item) => item.type === 'adjustment');
    assert(accountBalances(data).get(cash.id) === 800n && adjustment.lines[0].deltaTwd === -100, 'initial checkpoint was wrong');
    const source = data.expenses.find((item) => item.idempotencyKey === key(938));
    data = (await s.repository.execute({ kind: 'edit-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, amountMinor: 20000, date: source.occurredOn, note: source.note, categoryId: source.categoryId, subcategoryId: source.subcategoryId, accountId: cash.id, paymentMethod: 'cash' }, context)).data;
    adjustment = data.accountEvents.find((item) => item.type === 'adjustment');
    assert(accountBalances(data).get(cash.id) === 800n && adjustment.lines[0].deltaTwd === 0, 'editing an earlier entry changed the recorded checkpoint');
    data = (await s.repository.execute({ kind: 'delete-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 1, confirmed: true }, context)).data;
    adjustment = data.accountEvents.find((item) => item.type === 'adjustment');
    assert(!data.expenses.some((item) => item.id === source.id) && accountBalances(data).get(cash.id) === 800n && adjustment.lines[0].deltaTwd === -200, 'deleting an earlier entry did not preserve the checkpoint');
  });
  test('編輯或拆分交易交易中止時，來源收支與帳戶異動完整回復', async () => {
    const s = await setup(); let data = await accounts(s); const cash = data.accounts[0];
    data = (await s.repository.execute(record(940, cash.id, { amountTwd: 100 }), context)).data;
    const source = data.expenses[0]; const before = await s.repository.read();
    s.fixture.setAbortWrites(true);
    await rejects(() => s.repository.execute({ kind: 'edit-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, amountMinor: 20000, date: source.occurredOn, note: '中止修改', categoryId: source.categoryId, subcategoryId: source.subcategoryId, accountId: cash.id, paymentMethod: 'cash' }, context));
    s.fixture.setAbortWrites(false);
    same(await s.repository.read(), before);
    s.fixture.setAbortWrites(true);
    await rejects(() => s.repository.execute({ kind: 'split-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, splits: [
      { date: source.occurredOn, amountTwd: '40', note: '甲', categoryId: source.categoryId, subcategoryId: source.subcategoryId, accountId: cash.id, paymentMethod: 'cash' },
      { idempotencyKey: key(941), date: source.occurredOn, amountTwd: '50', note: '乙', categoryId: source.categoryId, subcategoryId: source.subcategoryId, accountId: cash.id, paymentMethod: 'cash' },
    ] }, context));
    s.fixture.setAbortWrites(false);
    same(await s.repository.read(), before);
  });
  test('delete requires confirmation, blocks reminder links, removes account effect atomically and rolls back on abort', async () => {
    const s = await setup(); let data = await accounts(s); const cash = data.accounts[0];
    data = (await s.repository.execute(record(934, cash.id, { amountTwd: 25 }), context)).data;
    const source = data.expenses[0]; const beforeBalance = accountBalances(data).get(cash.id);
    await rejects(() => s.repository.execute({ kind: 'delete-entry', entryType: 'expense', entryId: source.id, expectedEditRevision: 0, confirmed: false }, context), '明確確認');
    data = (await s.repository.execute({ kind: 'create-reminder', ...command('create-reminder', 935), name: '關聯提醒', entryType: 'expense', amountTwd: 25, date: '2026-11-05', repeat: 'once', advanceDays: 1, note: '' }, context)).data;
    const occurrence = data.reminderOccurrences[0];
    data = (await s.repository.execute(record(936, cash.id, { amountTwd: 25, reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision }), context)).data;
    let linked = data.expenses.find((item) => item.reminderOccurrenceId === occurrence.id);
    await rejects(() => s.repository.execute({ kind: 'split-entry', entryType: 'expense', entryId: linked.id, expectedEditRevision: 0, splits: [] }, context), '提醒或其他資料引用');
    const completedOccurrence = data.reminderOccurrences.find((item) => item.id === occurrence.id);
    data = (await s.repository.execute({ kind: 'edit-entry', entryType: 'expense', entryId: linked.id, expectedEditRevision: 0, expectedOccurrenceRevision: completedOccurrence.revision, amountMinor: 3000, date: linked.occurredOn, note: linked.note, categoryId: linked.categoryId, subcategoryId: linked.subcategoryId, accountId: cash.id, paymentMethod: 'cash' }, context)).data;
    linked = data.expenses.find((item) => item.id === linked.id);
    const updatedOccurrence = data.reminderOccurrences.find((item) => item.id === occurrence.id);
    assert(linked?.reminderOccurrenceId === occurrence.id && updatedOccurrence.entryId === linked.id && updatedOccurrence.amountTwd === 30, 'editing a reminder-linked entry broke the bidirectional link or amount snapshot');
    await rejects(() => s.repository.execute({ kind: 'delete-entry', entryType: 'expense', entryId: linked.id, expectedEditRevision: 1, confirmed: true }, context), '被提醒');
    assert((await s.repository.read()).expenses.some((item) => item.id === linked.id), 'linked record was deleted');
    const unlinkedSetup = await setup(); let unlinked = await accounts(unlinkedSetup);
    unlinked = (await unlinkedSetup.repository.execute(record(937, unlinked.accounts[0].id, { amountTwd: 25 }), context)).data;
    const removable = unlinked.expenses[0]; const balanceBefore = accountBalances(unlinked).get(unlinked.accounts[0].id);
    const deleted = (await unlinkedSetup.repository.execute({ kind: 'delete-entry', entryType: 'expense', entryId: removable.id, expectedEditRevision: 0, confirmed: true }, context)).data;
    assert(!deleted.expenses.some((item) => item.id === removable.id) && accountBalances(deleted).get(unlinked.accounts[0].id) === balanceBefore + 25n, 'delete did not reverse the account impact');
    assert(!deleted.accountEvents.some((item) => item.entryId === removable.id) && deleted.accountEvents.every((item, index) => item.sequence === index + 1), 'delete left an orphan event or sequence gap');
    const beforeAbort = (await unlinkedSetup.repository.execute(record(938, unlinked.accounts[0].id, { amountTwd: 10 }), context)).data;
    const stable = structuredClone(beforeAbort); const abortTarget = stable.expenses[0]; unlinkedSetup.fixture.setAbortWrites(true);
    await rejects(() => unlinkedSetup.repository.execute({ kind: 'delete-entry', entryType: 'expense', entryId: abortTarget.id, expectedEditRevision: 0, confirmed: true }, context));
    unlinkedSetup.fixture.setAbortWrites(false);
    assert(stableJson(await unlinkedSetup.repository.read()) === stableJson(stable), 'aborted delete partially changed finance stores');
    assert(beforeBalance < 1000n, 'test did not create the expected initial account movement');
  });

  const results = [];
  for (const item of tests) { try { await item.action(); results.push({ name: item.name, passed: true }); } catch (error) { results.push({ name: item.name, passed: false, error: error.message }); } }
  return { passed: results.filter((item) => item.passed).length, total: results.length, results, scope: '記憶體 IndexedDB 事件模擬；未存取 Brave 或任何真實資料庫' };
}
