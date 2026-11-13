import { createCategoryStore, isValidCategoryCatalog } from '../scripts/category-store.js';
import { createEntryDraft } from '../scripts/pages/add-entry.js';
import { createExpenseRecord, createIncomeRecord, readOfficialSnapshot, restoreOfficialSnapshot, officialSnapshotToken, validateOfficialSnapshot, readCategoryCatalog, saveCategoryCatalog, saveExpense } from '../scripts/storage/expense-db.js';
import { createLedgerBackup, validateLedgerBackup, MAX_BACKUP_BYTES } from '../scripts/storage/ledger-backup.js';
import { stableJson, parseStrictJson } from '../scripts/storage/json-data.js';
import { aggregateLedger, createPreviewRecords, renderFinancePanel } from '../scripts/pages/finance-panels.js';
import { createStorageFixture } from './helpers/storage-fixture.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b, message) => assert(stableJson(a) === stableJson(b), message);
async function rejects(action, code) {
  try { await action(); } catch (error) { if (code) assert(error.code === code, `Expected ${code}, received ${error.code}`); return; }
  throw new Error('Expected operation to be rejected');
}
function sampleData() {
  const store = createCategoryStore();
  const expense = createExpenseRecord({ draft: { ...createEntryDraft(), amount: '100', date: '2026-11-05', note: '合成支出' }, category: store.getCategory('cat-food'), subcategory: store.getSubcategory('sub-lunch') });
  Object.assign(expense, { id: 'exp_00000000-0000-4000-8000-000000000001', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000001' });
  const previous = { ...expense, id: 'exp_00000000-0000-4000-8000-000000000002', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000002', amountMinor: 20000, occurredOn: '2026-10-31' };
  const income = createIncomeRecord({ draft: { ...createEntryDraft(), type: 'income', amount: '400', date: '2026-11-04', note: '合成收入' }, category: store.getCategory('income-part-time'), subcategory: store.getSubcategory('sub-income-wage') });
  Object.assign(income, { id: 'inc_00000000-0000-4000-8000-000000000003', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000003' });
  return { expenses: [expense, previous], incomes: [income], categoryCatalog: [store.exportCatalog()] };
}
const fixtureFor = (data) => createStorageFixture({ version: 3, expenses: data.expenses, incomes: data.incomes, catalog: data.categoryCatalog[0] });
const read = (fixture) => readOfficialSnapshot(fixture.environment);

export async function runLedgerIntegrationTests() {
  const tests = [];
  const test = (name, action) => tests.push({ name, action });

  test('大分類排序永久保存、子分類排序僅影響目前大分類且不更改收支', async () => {
    const data = sampleData(); const fixture = fixtureFor(data); const store = createCategoryStore({ catalog: data.categoryCatalog[0] });
    const originalOtherParent = store.listSubcategories('cat-mobile');
    store.moveCategory('cat-shopee', 0); store.moveSubcategory('cat-shopee', 'sub-household', 0);
    const catalog = store.exportCatalog(); catalog.revision += 1;
    await saveCategoryCatalog(catalog, 0, fixture.environment);
    const reloaded = createCategoryStore({ catalog: await readCategoryCatalog(fixture.environment) });
    assert(reloaded.listCategories({ entryType: 'expense' })[0].id === 'cat-shopee', 'parent order not persisted');
    assert(reloaded.listSubcategories('cat-shopee')[0].id === 'sub-household', 'child order not persisted');
    same(reloaded.listSubcategories('cat-mobile'), originalOtherParent, 'shared child changed other parent ordering');
    same(fixture.dump('expenses'), data.expenses, 'reorder changed expenses'); same(fixture.dump('incomes'), data.incomes, 'reorder changed incomes');
  });
  test('排序保留同名不同 ID；解除共用會清理本地順序但保留另一處', () => {
    const store = createCategoryStore(); const first = store.addIndependentSubcategory('cat-shopee', '合成同名'); const second = store.addIndependentSubcategory('cat-shopee', '合成同名');
    store.moveSubcategory('cat-shopee', second.id, 0); store.shareSubcategory('cat-mobile', second.id);
    store.unlinkSubcategory('cat-shopee', second.id);
    assert(store.isSubcategorySelectable('cat-mobile', second.id) && store.getSubcategory(first.id), 'shared or same-name identity lost');
    assert(isValidCategoryCatalog(store.exportCatalog()), 'unlink left invalid ordering');
    const bad = store.exportCatalog(); bad.categories[0].subcategoryOrder = ['does-not-exist'];
    assert(!isValidCategoryCatalog(bad), 'invalid ordering accepted');
  });
  test('完整 JSON 匯出再驗證保留原始紀錄與關聯', async () => {
    const data = sampleData(); const store = createCategoryStore({ catalog: data.categoryCatalog[0] });
    store.moveCategory('cat-shopee', 0); store.moveSubcategory('cat-shopee', 'sub-household', 0); store.setCategoryHidden('cat-mobile', true); store.shareSubcategory('cat-entertainment', 'sub-electronics');
    store.updateCategory('cat-shopee', { name: '合成購物', color: '#E16DB0', icon: 'gift' }); data.categoryCatalog = [store.exportCatalog()];
    const before = stableJson(data); const backup = await createLedgerBackup(data); const parsed = await validateLedgerBackup(backup.text);
    same(parsed.data, data, 'backup round trip altered data'); assert(stableJson(data) === before, 'export mutated source');
    assert(parsed.summary.expenses === 2 && parsed.summary.incomes === 1, 'counts wrong');
  });
  test('完整還原原子替換三個集合，只前進分類 revision', async () => {
    const original = sampleData(); const target = sampleData(); target.incomes = []; target.expenses[0].note = '目標原始合成資料'; target.categoryCatalog[0].revision = 8;
    const fixture = fixtureFor(target); const token = officialSnapshotToken(await read(fixture));
    const backup = await validateLedgerBackup((await createLedgerBackup(original)).text);
    const result = await restoreOfficialSnapshot(backup.data, token, fixture.environment);
    const restored = await read(fixture); assert(result.revision === 9, 'revision did not advance');
    same(restored.expenses, original.expenses, 'expenses did not restore exactly'); same(restored.incomes, original.incomes, 'incomes did not restore exactly');
    const restoredCatalog = { ...restored.categoryCatalog[0], revision: original.categoryCatalog[0].revision };
    same(restoredCatalog, original.categoryCatalog[0], 'category identities or relations changed');
    await validateLedgerBackup((await createLedgerBackup(restored)).text);
  });
  test('還原中止時 clear 與部分 add 全部回復原狀', async () => {
    const target = sampleData(); target.expenses[0].note = '必須保留'; const fixture = fixtureFor(target); const before = await read(fixture);
    fixture.setAbortWrites(true);
    await rejects(() => restoreOfficialSnapshot(sampleData(), officialSnapshotToken(before), fixture.environment));
    same(await read(fixture), before, 'aborted restore left partial replacement');
  });
  test('還原只有 transaction complete 才回報成功', async () => {
    const fixture = fixtureFor(sampleData()); const before = await read(fixture); fixture.setHoldWrites(true); let settled = false;
    const pending = restoreOfficialSnapshot(sampleData(), officialSnapshotToken(before), fixture.environment).then(() => { settled = true; });
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    assert(!settled, 'request success treated as completed restore'); same(await read(fixture), before, 'uncommitted restore leaked');
    fixture.releaseWrites(); await pending; assert(settled, 'restore never completed');
  });
  test('預覽後其他分頁新增收支時拒絕還原且保留新增紀錄', async () => {
    const data = sampleData(); const fixture = fixtureFor(data); const token = officialSnapshotToken(await read(fixture));
    const extra = { ...data.expenses[0], id: 'exp_00000000-0000-4000-8000-000000000099', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000099' };
    await saveExpense(extra, fixture.environment); const changed = await read(fixture);
    await rejects(() => restoreOfficialSnapshot(data, token, fixture.environment), 'RESTORE_CONFLICT'); same(await read(fixture), changed, 'conflict overwrote new expense');
  });
  test('預覽後分類修改會阻擋還原，還原後過期分類編輯也會阻擋', async () => {
    const data = sampleData(); const fixture = fixtureFor(data); const token = officialSnapshotToken(await read(fixture));
    const changed = structuredClone(data.categoryCatalog[0]); changed.revision = 1; changed.categories[0].name = '新合成名稱';
    await saveCategoryCatalog(changed, 0, fixture.environment);
    await rejects(() => restoreOfficialSnapshot(data, token, fixture.environment), 'RESTORE_CONFLICT');
    const current = await read(fixture); await restoreOfficialSnapshot(data, officialSnapshotToken(current), fixture.environment);
    changed.revision = 2;
    await rejects(() => saveCategoryCatalog(changed, 1, fixture.environment), 'CATEGORY_REVISION_CONFLICT');
  });
  test('SHA-256 不符、截斷 JSON 與不支援版本拒絕', async () => {
    const backup = await createLedgerBackup(sampleData()); const parsed = JSON.parse(backup.text); parsed.data.expenses[0].note = '遭修改';
    await rejects(() => validateLedgerBackup(JSON.stringify(parsed))); await rejects(() => validateLedgerBackup(backup.text.slice(0, -8)));
    parsed.formatVersion = 99; await rejects(() => validateLedgerBackup(JSON.stringify(parsed)));
  });
  test('筆數不符、遺漏集合、未支援新集合拒絕', async () => {
    const parsed = JSON.parse((await createLedgerBackup(sampleData())).text); parsed.counts.expenses += 1;
    await rejects(() => validateLedgerBackup(JSON.stringify(parsed)));
    const missing = sampleData(); delete missing.incomes; await rejects(() => createLedgerBackup(missing));
    await rejects(() => createLedgerBackup({ ...sampleData(), futureAccounts: [] }));
  });
  test('重複 JSON 欄位、危險屬性與非 JSON 空白拒絕', async () => {
    await rejects(() => Promise.resolve(parseStrictJson('{"x":1,"x":2}')));
    await rejects(() => Promise.resolve(parseStrictJson('{"__proto__":{}}')));
    await rejects(() => Promise.resolve(parseStrictJson('\u00a0{}')));
    same(parseStrictJson('{"name":"測試\\\"名稱","value":[true,null,1.25]}'), { name: '測試"名稱', value: [true, null, 1.25] }, 'strict JSON parser rejected valid escaping');
  });
  test('重複紀錄 ID、冪等鍵與跨類型關聯拒絕', async () => {
    const duplicate = sampleData(); duplicate.expenses.push(structuredClone(duplicate.expenses[0])); await rejects(() => createLedgerBackup(duplicate));
    const invalid = sampleData(); invalid.categoryCatalog[0].subcategories[0].categoryIds.push('income-other'); await rejects(() => createLedgerBackup(invalid));
  });
  test('舊紀錄缺少子分類或已失去分類目錄仍原樣保存並提示', async () => {
    const data = sampleData(); const legacy = data.expenses[0]; delete legacy.subcategoryId; delete legacy.subcategoryNameSnapshot; legacy.categoryId = 'old-memory-category';
    const validated = await validateLedgerBackup((await createLedgerBackup(data)).text);
    assert(validated.summary.historicalReferences === 1, 'legacy warning missing'); same(validated.data.expenses[0], legacy, 'legacy reference was fabricated');
  });
  test('無效日曆日、非整數金額及 UTC 時間拒絕', async () => {
    for (const update of [{ occurredOn: '2026-02-30' }, { amountMinor: 1.2 }, { createdAt: '2026-11-05T25:00:00.000Z' }]) {
      const data = sampleData(); Object.assign(data.expenses[0], update); await rejects(() => createLedgerBackup(data));
    }
    const doc = JSON.parse((await createLedgerBackup(sampleData())).text); doc.exportedAt = '2026-02-30T00:00:00.000Z'; await rejects(() => validateLedgerBackup(JSON.stringify(doc)));
  });
  test('大小上限與 SHA-256 執行失敗不回報匯出成功', async () => {
    await rejects(() => validateLedgerBackup(' '.repeat(MAX_BACKUP_BYTES + 1)));
    await rejects(() => createLedgerBackup(sampleData(), { cryptoProvider: { subtle: { digest: async () => { throw new Error('synthetic digest failure'); } } } }));
  });
  test('錯誤來源與路徑不開啟正式資料庫', async () => {
    const fixture = fixtureFor(sampleData()); const bad = { ...fixture.environment, location: { origin: 'http://localhost:5510', pathname: '/' } };
    await rejects(() => readOfficialSnapshot(bad), 'WRONG_ORIGIN');
    await rejects(() => restoreOfficialSnapshot(sampleData(), 'token', bad), 'WRONG_ORIGIN');
    await rejects(() => readOfficialSnapshot({ ...fixture.environment, location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/lab/' } }), 'WRONG_PATH');
    assert(fixture.openCalls.length === 0, 'wrong origin touched database');
  });
  test('還原版本溢位或未完成預覽時不修改任何資料', async () => {
    const data = sampleData(); data.categoryCatalog[0].revision = Number.MAX_SAFE_INTEGER; const fixture = fixtureFor(data); const before = await read(fixture);
    await rejects(() => restoreOfficialSnapshot(sampleData(), '', fixture.environment), 'RESTORE_PREVIEW_REQUIRED');
    await rejects(() => restoreOfficialSnapshot(sampleData(), officialSnapshotToken(before), fixture.environment));
    same(await read(fixture), before, 'unsafe revision changed data');
  });
  test('真實統計按日期分月，收入支出分開且不計成餘額', () => {
    const data = sampleData(); const summary = aggregateLedger([...data.expenses, ...data.incomes], new Date(2026, 10, 5));
    assert(summary.income === 40000n && summary.expense === 10000n && summary.count === 2, 'monthly totals wrong');
    assert(summary.days.at(-1).amount === 10000n && summary.months.at(-2).expense === 20000n, 'daily or cross-month totals wrong');
    assert(summary.categories.length === 1 && summary.categories[0].amount === 10000n, 'category totals wrong');
    data.expenses[0].subcategoryNameSnapshot = '<img src=x onerror=synthetic()>';
    const html = renderFinancePanel(createCategoryStore(), { source: 'personal', panel: 'overview', records: [...data.expenses, ...data.incomes], loading: false, error: '' });
    assert(html.includes('&lt;img') && !html.includes('<img'), 'finance labels interpreted as HTML');
  });
  test('範例只在記憶體，切回我的資料後不混入範例預算與提醒', () => {
    const store = createCategoryStore(); const before = stableJson(store.exportCatalog()); const sample = createPreviewRecords();
    const preview = renderFinancePanel(store, { source: 'preview', panel: 'overview', records: [] });
    const personal = renderFinancePanel(store, { source: 'personal', panel: 'overview', records: [], loading: false, error: '' });
    assert(sample.length === 3 && preview.includes('範例預算') && preview.includes('範例提醒'), 'preview unavailable');
    assert(!personal.includes('範例預算') && personal.includes('本月尚無已保存的收支紀錄'), 'sample leaked into real view');
    assert(stableJson(store.exportCatalog()) === before, 'preview mutated catalog');
  });
  test('空資料備份可驗證；排序欄位可省略且不共享陣列參照', async () => {
    const data = sampleData(); data.expenses = []; data.incomes = []; validateOfficialSnapshot(data);
    await validateLedgerBackup((await createLedgerBackup(data)).text);
    const store = createCategoryStore({ catalog: data.categoryCatalog[0] }); store.moveSubcategory('cat-shopee', 'sub-household', 0);
    const copy = store.exportCatalog(); copy.categories.find((item) => item.id === 'cat-shopee').subcategoryOrder.reverse();
    assert(store.listSubcategories('cat-shopee')[0].id === 'sub-household', 'catalog exported mutable sorting reference');
  });

  const results = [];
  for (const { name, action } of tests) {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  return { passed: results.filter((item) => item.passed).length, total: results.length, results, scope: 'Synthetic data and in-memory IndexedDB event simulation only; no Brave database access' };
}
