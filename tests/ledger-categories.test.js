import { createCategoryStore, createDefaultCategoryCatalog, isValidCategoryCatalog, colorPalette } from '../scripts/category-store.js';
import { applyEntryPreferencesToDraft, applyResolvedAccountToDraft, createEntryDraft, getLocalDateInputValue, reconcileEntryDraftSelection, selectEntryAccount, selectEntryCategory, switchEntryDraftType, renderAddEntryForm, renderAddEntryPage, validateEntryDraft } from '../scripts/pages/add-entry.js';
import { createCategoryEditorState, switchCategoryEditorType, renderCategorySettingsPage } from '../scripts/pages/category-settings.js';
import { createExpenseRecord, createIncomeRecord, listLedgerEntries, loadOrInitializeCategoryCatalog, openExpenseDatabase, readCategoryCatalog, saveCategoryCatalog, saveExpense, saveIncome, EXPENSE_DATABASE_VERSION } from '../scripts/storage/expense-db.js';
import { filterHistoryRecordsByMonth, getHistoryRecordLabels, groupHistoryRecordsByDate, renderHistoryPage } from '../scripts/pages/history.js';
import { createStorageFixture } from './helpers/storage-fixture.js';
import { createWorkbenchState, getWorkbenchColumnBounds, renderWorkbench, resolveWorkbenchDrag, resolveWorkbenchKeyboard } from '../scripts/pages/workbench.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message);
async function rejectsCode(action, code) {
  try { await action(); } catch (error) { assert(error.code === code, `Expected ${code}, got ${error.code}`); return; }
  throw new Error(`Expected rejection: ${code}`);
}

function incomeInput(store) {
  const draft = createEntryDraft();
  switchEntryDraftType(draft, 'income');
  Object.assign(draft, { categoryId: 'income-part-time', subcategoryId: 'sub-income-wage', amount: '350', date: '2026-11-04', note: '合成測試' });
  return { draft, category: store.getCategory(draft.categoryId), subcategory: store.getSubcategory(draft.subcategoryId) };
}

function recordsFixture() {
  const store = createCategoryStore();
  const income = createIncomeRecord(incomeInput(store));
  const expense = createExpenseRecord({
    draft: { ...createEntryDraft(), amount: '100', date: '2026-11-04', note: '合成支出' },
    category: store.getCategory('cat-motorcycle'), subcategory: store.getSubcategory('sub-fuel'),
  });
  const legacyExpense = { ...expense, id: 'exp_00000000-0000-4000-8000-000000000002', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000002' };
  legacyExpense.amountMinor = 10025;
  delete legacyExpense.subcategoryId;
  delete legacyExpense.subcategoryNameSnapshot;
  const legacyIncome = { ...income, id: 'inc_00000000-0000-4000-8000-000000000001', idempotencyKey: 'entry_00000000-0000-4000-8000-000000000001', schemaVersion: 1, occurredOn: '2026-10-31' };
  legacyIncome.amountMinor = 35025;
  delete legacyIncome.subcategoryId;
  delete legacyIncome.subcategoryNameSnapshot;
  return { store, income, expense, legacyExpense, legacyIncome };
}

async function seedCatalog(fixture) {
  return loadOrInitializeCategoryCatalog(createDefaultCategoryCatalog(), fixture.environment);
}

export async function runLedgerCategoryTests() {
  const tests = [];
  const test = (name, action) => tests.push({ name, action });

  test('收支預設分類獨立、原支出 ID 不變、全部色彩可編輯', () => {
    const store = createCategoryStore();
    assert(store.listCategories({ entryType: 'expense' }).length === 8, 'expense defaults changed');
    assert(store.listCategories({ entryType: 'income' }).length === 4, 'income defaults missing');
    assert(store.getCategory('cat-motorcycle').color === '#E7CE50', 'motorcycle identity changed');
    const colors = new Set(colorPalette.map((item) => item.value));
    assert(colorPalette.length === 24 && store.listCategories().every((item) => colors.has(item.color)), 'uneditable default color');
  });
  test('新增記帳保存說明依目前資料環境描述帳戶狀態', () => {
    const store = createCategoryStore();
    const draft = createEntryDraft();
    const officialPage = renderAddEntryPage(store, draft, { accounts: [{ id: 'wallet', active: true }] });
    const emptyAccountsPage = renderAddEntryPage(store, draft, { accounts: [] });
    const v3Page = renderAddEntryPage(store, draft);
    assert(officialPage.includes('收支與選取帳戶會保存在此瀏覽器。') && !officialPage.includes('帳戶仍為示範'), 'V4 頁仍把正式帳戶說成示範');
    assert(emptyAccountsPage.includes('目前沒有可用帳戶，請先至資金帳戶建立。'), '無帳戶狀態沒有明確說明');
    assert(v3Page.includes('帳戶仍為介面示範且不異動餘額。'), 'V3 說明不再反映示範帳戶狀態');
  });
  test('解除共用子分類只檢查目前大分類與子分類組合；永久刪除仍檢查全域引用', () => {
    const store = createCategoryStore();
    const second = store.addCategory({ name: '測試二', entryType: 'expense' });
    assert(store.shareSubcategory(second.id, 'sub-breakfast'), 'second category could not share breakfast');
    assert(store.setTransactionReferences([{ recordType: 'expense', categoryId: 'cat-food', subcategoryId: 'sub-breakfast' }]), 'reference audit failed');
    const secondPair = store.getSubcategoryAssociationUnlinkInfo(second.id, 'sub-breakfast');
    const foodPair = store.getSubcategoryAssociationUnlinkInfo('cat-food', 'sub-breakfast');
    assert(secondPair.referenceVerified && secondPair.canUnlink && secondPair.transactionCount === 0, 'another category transaction incorrectly blocked pair unlink');
    assert(foodPair.referenceVerified && !foodPair.canUnlink && foodPair.transactionCount === 1, 'referenced food association was not protected');
    assert(store.unlinkSubcategory(second.id, 'sub-breakfast'), 'unreferenced pair unlink failed');
    assert(store.getSubcategory('sub-breakfast').categoryIds.includes('cat-food') && !store.getSubcategory('sub-breakfast').categoryIds.includes(second.id), 'unlink removed the shared entity or other category history');
    const deletion = store.getSubcategoryDeletionInfo('sub-breakfast');
    assert(!deletion.canDelete && deletion.reason.includes('1 筆歷史交易') && deletion.reason.includes('吃'), 'permanent deletion blocker did not identify the history reference category and count');
  });
  test('無歷史引用的單一分類子分類可在確認永久刪除時連同唯一關聯安全移除', () => {
    const store = createCategoryStore();
    const category = store.addCategory({ name: '測試二', entryType: 'expense' });
    const child = store.addIndependentSubcategory(category.id, '一二三');
    store.setTransactionReferences([]);
    const info = store.getSubcategoryDeletionInfo(child.id, { categoryId: category.id });
    assert(info.referenceVerified && info.transactionCount === 0 && info.canDeleteAfterRemovingSoleAssociation, 'single unreferenced association was not recognized as safe for confirmed deletion');
    assert(info.reason === '' && store.getUsageNames(child.id).includes('測試二'), 'safe deletion reason or explicit current association was wrong');
    assert(store.unlinkSubcategory(category.id, child.id) && store.deleteSubcategory(child.id).ok, 'safe unreferenced child removal failed');
    assert(!store.getSubcategory(child.id), 'permanently deleted child still exists');
  });
  test('收入與支出皆要求屬於所選大分類的子分類', () => {
    const store = createCategoryStore(); const { draft } = incomeInput(store);
    assert(validateEntryDraft(store, draft) === '', 'valid income rejected');
    draft.subcategoryId = ''; assert(validateEntryDraft(store, draft) !== '', 'missing income child accepted');
    draft.subcategoryId = 'sub-fuel'; assert(validateEntryDraft(store, draft) !== '', 'expense child accepted for income');
    draft.subcategoryId = 'sub-income-wage'; draft.categoryId = ''; assert(validateEntryDraft(store, draft) !== '', 'missing income category accepted');
    draft.categoryId = 'income-part-time';
    draft.type = 'expense'; assert(validateEntryDraft(store, draft) !== '', 'income category accepted for expense');
    draft.categoryId = 'cat-motorcycle'; draft.subcategoryId = 'sub-fuel'; assert(validateEntryDraft(store, draft) === '', 'valid expense rejected');
    draft.categoryId = ''; assert(validateEntryDraft(store, draft) !== '', 'missing expense category accepted');
    draft.categoryId = 'cat-motorcycle'; draft.subcategoryId = ''; assert(validateEntryDraft(store, draft) !== '', 'missing expense child accepted');
    draft.subcategoryId = 'sub-lunch'; assert(validateEntryDraft(store, draft) !== '', 'unrelated expense child accepted');
  });
  test('更換大分類時只保留仍有效的同類共用子分類', () => {
    const store = createCategoryStore(); const draft = createEntryDraft();
    assert(selectEntryCategory(store, draft, 'cat-food'), 'could not select first category');
    draft.subcategoryId = 'sub-pudding-dog'; draft.expenseSubcategoryId = 'sub-pudding-dog';
    const previousKey = draft.idempotencyKey;
    assert(selectEntryCategory(store, draft, 'cat-grocery'), 'could not select shared category');
    assert(draft.subcategoryId === 'sub-pudding-dog', 'valid shared child was cleared');
    assert(draft.idempotencyKey !== previousKey, 'parent change did not rotate idempotency key');
    assert(selectEntryCategory(store, draft, 'cat-motorcycle'), 'could not select unrelated category');
    assert(draft.subcategoryId === '' && draft.expenseSubcategoryId === '', 'unrelated child was retained');
    assert(!selectEntryCategory(store, draft, 'income-other'), 'cross-type category accepted');
  });
  test('切換收支保留各自的兩層選取及共用草稿欄位', () => {
    const draft = createEntryDraft();
    Object.assign(draft, { categoryId: 'cat-food', subcategoryId: 'sub-lunch', amount: '99', date: '2026-11-03', note: '草稿' });
    const key = draft.idempotencyKey;
    switchEntryDraftType(draft, 'income'); draft.categoryId = 'income-part-time'; draft.subcategoryId = 'sub-income-wage';
    switchEntryDraftType(draft, 'expense');
    same([draft.categoryId, draft.subcategoryId, draft.amount, draft.date, draft.note], ['cat-food', 'sub-lunch', '99', '2026-11-03', '草稿'], 'expense draft lost');
    switchEntryDraftType(draft, 'income');
    same([draft.categoryId, draft.subcategoryId], ['income-part-time', 'sub-income-wage'], 'income draft lost');
    assert(key !== draft.idempotencyKey, 'submission key not rotated');
    draft.isSaving = true; assert(!switchEntryDraftType(draft, 'expense'), 'saving draft switched');
  });
  test('收入表單呈現子分類、正確順序及安全備註', () => {
    const store = createCategoryStore(); const { draft } = incomeInput(store); draft.note = '</textarea><script>synthetic()</script>';
    const html = renderAddEntryForm(store, draft);
    const ids = ['entry-category-title', 'entry-subcategory-title', 'entry-amount-title', 'entry-note-title'].map((id) => html.indexOf(`id="${id}"`));
    assert(ids.every((value, index) => value >= 0 && (!index || value > ids[index - 1])), 'incorrect entry order');
    assert(html.includes('薪資') && html.includes('儲存收入') && !html.includes('data-category-id="cat-food"'), 'wrong income controls');
    assert(html.includes('&lt;/textarea&gt;&lt;script&gt;') && !html.includes('<script>'), 'unsafe note rendering');
  });
  test('空白表單保留結果訊息，失效的分類選取才清除並提示', () => {
    const store = createCategoryStore(); const empty = createEntryDraft();
    empty.feedback = '已保存'; empty.feedbackTone = 'success';
    assert(!reconcileEntryDraftSelection(store, empty) && empty.feedback === '已保存', 'success feedback erased');
    empty.feedback = '請選擇分類'; empty.feedbackTone = 'error';
    assert(!reconcileEntryDraftSelection(store, empty) && empty.feedback === '請選擇分類', 'validation feedback erased');
    const { draft } = incomeInput(store); const key = draft.idempotencyKey;
    store.setSubcategoryHidden(draft.subcategoryId, true);
    assert(reconcileEntryDraftSelection(store, draft) && draft.subcategoryId === '' && draft.categoryId === 'income-part-time', 'invalid child not reconciled');
    assert(draft.feedbackTone === 'error' && draft.idempotencyKey !== key, 'invalid selection warning or key missing');
    store.setCategoryHidden(draft.categoryId, true);
    assert(reconcileEntryDraftSelection(store, draft) && draft.categoryId === '', 'invalid parent not cleared');
  });
  test('分類管理可切換類型，24 色及收入圖示仍可操作', () => {
    const store = createCategoryStore(); const state = createCategoryEditorState(store);
    switchCategoryEditorType(store, state, 'income');
    const html = renderCategorySettingsPage(store, state);
    assert(state.entryType === 'income' && html.includes('零用錢') && !html.includes('data-category-id="cat-food"'), 'editor types mixed');
    assert((html.match(/class="color-swatch /g) || []).length === 24, 'palette missing');
    assert(html.includes('data-icon-choice="wallet"') && html.includes('data-icon-choice="clock"'), 'income icons missing');
    assert(html.indexOf('class="subcategory-add-area"') < html.indexOf('class="assigned-subcategory-list"'), '新增／搜尋子分類操作必須固定在子分類清單上方');
    assert(html.includes('class="subcategory-existing-block"') && html.indexOf('class="subcategory-existing-block"') < html.indexOf('class="independent-subcategory-block"')
      && html.indexOf('class="independent-subcategory-block"') < html.indexOf('class="assigned-subcategory-list"'), 'A／B 新增區塊或下方關聯清單順序不正確');
  });
  test('大分類永久刪除使用顯示名稱的中央確認視窗', () => {
    const store = createCategoryStore(); const state = createCategoryEditorState(store);
    state.deleteConfirmation = { category: store.getCategory('cat-food') };
    const html = renderCategorySettingsPage(store, state);
    assert(html.includes('data-category-delete-dialog') && html.includes('role="alertdialog" aria-modal="true"'), '分類刪除不是中央模態確認介面');
    assert(html.includes('確定要刪除「吃」嗎？') && html.includes('data-action="cancel-delete-category"') && html.includes('data-action="confirm-delete-category"'), '分類刪除沒有顯示名稱或取消／確認操作');
  });
  test('同名獨立子分類與不同執行個體使用不同穩定 ID', () => {
    const store = createCategoryStore(); const a = store.addIndependentSubcategory('income-part-time', '薪資');
    const b = store.addIndependentSubcategory('income-part-time', '薪資');
    const c = createCategoryStore().addIndependentSubcategory('income-part-time', '薪資');
    assert(new Set([a.id, b.id, c.id, 'sub-income-wage']).size === 4, 'IDs reused or merged');
    const category = store.addCategory({ entryType: 'income' });
    assert(category.entryType === 'income' && !category.id.includes('demo-'), 'new income category invalid');
  });
  test('共用限制同類型，解除一處不破壞另一處', () => {
    const store = createCategoryStore();
    assert(store.shareSubcategory('income-other', 'sub-income-wage'), 'income sharing failed');
    assert(!store.shareSubcategory('cat-food', 'sub-income-wage'), 'cross-type sharing allowed');
    assert(!store.shareSubcategory('income-other', 'sub-income-wage'), 'duplicate relationship allowed');
    store.unlinkSubcategory('income-other', 'sub-income-wage');
    assert(store.isSubcategorySelectable('income-part-time', 'sub-income-wage'), 'original relation lost');
  });
  test('隱藏／恢復與搜尋維持類型隔離', () => {
    const store = createCategoryStore(); const { draft } = incomeInput(store);
    store.setCategoryHidden(draft.categoryId, true); assert(validateEntryDraft(store, draft) !== '', 'hidden category accepted');
    store.setCategoryHidden(draft.categoryId, false); store.setSubcategoryHidden(draft.subcategoryId, true);
    assert(validateEntryDraft(store, draft) !== '' && !store.searchSubcategories('薪資', 8, { entryType: 'income' }).length, 'hidden child selectable');
    store.setSubcategoryHidden(draft.subcategoryId, false); assert(validateEntryDraft(store, draft) === '', 'restore failed');
    assert(store.searchSubcategories('布丁', 8, { entryType: 'expense' })[0]?.name === '布丁狗', 'pudding search regressed');
    assert(store.searchSubcategories('布丁', 8, { entryType: 'income' }).length === 0, 'cross-type search results');
  });
  test('新收入只接受整數元並保存兩層快照，之後改名不改歷史', () => {
    const store = createCategoryStore(); const input = incomeInput(store); const record = createIncomeRecord(input);
    assert(record.schemaVersion === 2 && record.amountMinor === 35000 && record.subcategoryNameSnapshot === '薪資', 'income V2 shape wrong');
    store.updateCategory(input.category.id, { name: '新名稱', color: '#866CE8' });
    store.updateSubcategory(input.subcategory.id, { name: '新薪資' });
    same(getHistoryRecordLabels(record), { title: '薪資', description: '打工・合成測試' }, 'historical snapshot changed');
    assert(renderAddEntryForm(store, input.draft).includes('--category-color:#866CE8'), 'form color did not update');
  });
  test('新收入與支出拒絕小數元；既有小數金額保留在讀取相容路徑', async () => {
    const store = createCategoryStore(); const input = incomeInput(store);
    const decimalIncome = { ...input, draft: { ...input.draft, amount: '350.25' } };
    await rejectsCode(() => createIncomeRecord(decimalIncome), 'INVALID_AMOUNT');
    await rejectsCode(() => createIncomeRecord({ ...input, draft: { ...input.draft, amount: '90071992547410' } }), 'INVALID_AMOUNT');
    const decimalDraft = { ...input.draft, amount: '350.25' };
    assert(validateEntryDraft(store, decimalDraft).includes('整數新台幣元'), 'front end accepted fractional new income');
    const { income, expense, legacyIncome, legacyExpense } = recordsFixture();
    assert(income.amountMinor === 35000 && expense.amountMinor === 10000, 'new entry minor units are wrong');
    assert(legacyIncome.amountMinor === 35025 && legacyExpense.amountMinor === 10025, 'legacy cent values were changed');
    const fixture = createStorageFixture(); await seedCatalog(fixture);
    await rejectsCode(() => saveIncome({ ...income, amountMinor: 35025 }, fixture.environment), 'INVALID_AMOUNT');
    await rejectsCode(() => saveExpense({ ...expense, amountMinor: 10025 }, fixture.environment), 'INVALID_AMOUNT');
    assert(fixture.dump('expenses').length === 0 && fixture.dump('incomes').length === 0, 'fractional new ledger record was saved');
  });
  test('建立收入時拒絕隱藏或跨類型分類', async () => {
    const store = createCategoryStore(); const input = incomeInput(store);
    await rejectsCode(() => createIncomeRecord({ ...input, subcategory: store.getSubcategory('sub-fuel') }), 'INVALID_CATEGORY');
    await rejectsCode(() => createIncomeRecord({ ...input, category: { ...input.category, hidden: true } }), 'INVALID_CATEGORY');
  });
  test('分類刪除預設阻擋；真實引用及未解除關聯都阻擋', () => {
    const { store, income } = recordsFixture();
    assert(!store.getCategoryDeletionInfo(income.categoryId).canDelete, 'unknown references treated as zero');
    store.setTransactionReferences([income]);
    assert(!store.deleteCategory(income.categoryId).ok, 'referenced category deleted');
    store.unlinkSubcategory(income.categoryId, income.subcategoryId);
    assert(!store.deleteSubcategory(income.subcategoryId).ok, 'referenced orphan deleted');
    store.setTransactionReferences([]);
    assert(!store.deleteSubcategory('sub-income-allowance').ok, 'linked child deleted');
    store.setTransactionReferences(null); assert(!store.getSubcategoryDeletionInfo(income.subcategoryId).canDelete, 'failed audit reused');
  });
  test('無引用刪除只移除定義，保留其他共用關聯', () => {
    const store = createCategoryStore(); store.setTransactionReferences([]);
    store.shareSubcategory('income-other', 'sub-income-wage');
    assert(store.deleteCategory('income-other').ok, 'unreferenced category rejected');
    assert(store.isSubcategorySelectable('income-part-time', 'sub-income-wage'), 'shared child damaged');
    const orphan = store.addIndependentSubcategory('income-part-time', '可刪合成項目'); store.unlinkSubcategory('income-part-time', orphan.id);
    assert(store.deleteSubcategory(orphan.id).ok, 'unreferenced orphan deletion failed');
  });
  test('新支出與收入的 IndexedDB 寫入拒絕缺少任一分類識別碼', async () => {
    const { income, expense } = recordsFixture(); const fixture = createStorageFixture(); await seedCatalog(fixture);
    const missingExpenseChild = { ...expense }; delete missingExpenseChild.subcategoryId; delete missingExpenseChild.subcategoryNameSnapshot;
    const missingIncomeChild = { ...income }; delete missingIncomeChild.subcategoryId; delete missingIncomeChild.subcategoryNameSnapshot;
    const missingCategory = { ...expense, categoryId: '' };
    const missingIncomeCategory = { ...income, categoryId: '' };
    const unrelatedIncomeCategory = { ...income, categoryId: 'income-other' };
    await rejectsCode(() => saveExpense(missingExpenseChild, fixture.environment), 'INVALID_CATEGORY');
    await rejectsCode(() => saveIncome(missingIncomeChild, fixture.environment), 'INVALID_CATEGORY');
    await rejectsCode(() => saveExpense(missingCategory, fixture.environment), 'INVALID_CATEGORY');
    await rejectsCode(() => saveIncome(missingIncomeCategory, fixture.environment), 'INVALID_CATEGORY');
    await rejectsCode(() => saveExpense({ ...expense, categoryId: 'cat-food', subcategoryId: 'sub-fuel' }, fixture.environment), 'INVALID_CATEGORY');
    await rejectsCode(() => saveIncome(unrelatedIncomeCategory, fixture.environment), 'INVALID_CATEGORY');
    assert(fixture.dump('expenses').length === 0 && fixture.dump('incomes').length === 0, 'invalid classification was saved');
  });
  test('舊紀錄缺少子分類仍可讀取、不補造欄位且新寫入規則不放寬', async () => {
    const { income, expense, legacyExpense, legacyIncome } = recordsFixture();
    const fixture = createStorageFixture({ expenses: [expense, legacyExpense], incomes: [legacyIncome, income] });
    const before = JSON.stringify([fixture.dump('expenses'), fixture.dump('incomes')]);
    const rows = await listLedgerEntries(fixture.environment);
    assert(rows.length === 4, 'legacy record rejected');
    assert(JSON.stringify([fixture.dump('expenses'), fixture.dump('incomes')]) === before, 'read changed records');
    assert(getHistoryRecordLabels(legacyIncome).title === '打工', 'legacy income gained fabricated child');
    assert(getHistoryRecordLabels(legacyExpense).title === legacyExpense.categoryNameSnapshot, 'legacy expense gained fabricated child');
  });
  test('v1→v3 僅新增收入、分類結構及索引，保留支出原始內容', async () => {
    const { expense } = recordsFixture(); const fixture = createStorageFixture({ version: 1, expenses: [expense] });
    const before = JSON.stringify(fixture.dump('expenses'));
    const db = await openExpenseDatabase(fixture.environment); db.close();
    assert(fixture.version === EXPENSE_DATABASE_VERSION && fixture.storeNames.includes('incomes') && fixture.storeNames.includes('categoryCatalog'), 'upgrade missing');
    assert(JSON.stringify(fixture.dump('expenses')) === before, 'upgrade changed expenses');
  });
  test('v2→v3 保留收入及支出原始內容並新增分類目錄', async () => {
    const { expense, income } = recordsFixture(); const fixture = createStorageFixture({ version: 2, expenses: [expense], incomes: [income] });
    const before = JSON.stringify([fixture.dump('expenses'), fixture.dump('incomes')]);
    const db = await openExpenseDatabase(fixture.environment); db.close();
    assert(fixture.version === 3 && fixture.storeNames.includes('categoryCatalog'), 'v2 to v3 migration missing');
    assert(JSON.stringify([fixture.dump('expenses'), fixture.dump('incomes')]) === before, 'v2 migration changed ledger records');
  });
  test('分類設定只在首次明確載入時初始化，重新載入不覆蓋變更', async () => {
    const fixture = createStorageFixture();
    assert(await readCategoryCatalog(fixture.environment) === null, 'opening database automatically seeded catalog');
    const first = await seedCatalog(fixture);
    assert(first.initialized && first.catalog.revision === 0 && isValidCategoryCatalog(first.catalog), 'initial catalog invalid');
    const changed = createCategoryStore({ catalog: first.catalog });
    changed.updateCategory('cat-food', { name: '餐飲已保存', color: '#D94E55' });
    const next = changed.exportCatalog(); next.revision = 1;
    await saveCategoryCatalog(next, 0, fixture.environment);
    const reopened = await seedCatalog(fixture);
    assert(!reopened.initialized && reopened.catalog.revision === 1 && reopened.catalog.categories.find((item) => item.id === 'cat-food').name === '餐飲已保存', 'catalog seed overwrote saved data');
  });
  test('分類版本衝突拒絕舊分頁覆蓋，並保留先成功的修改', async () => {
    const fixture = createStorageFixture(); const { catalog } = await seedCatalog(fixture);
    const tabA = createCategoryStore({ catalog }); const tabB = createCategoryStore({ catalog });
    tabA.updateCategory('cat-food', { name: '分頁 A 分類' });
    const writeA = tabA.exportCatalog(); writeA.revision += 1;
    await saveCategoryCatalog(writeA, 0, fixture.environment);
    tabB.updateCategory('cat-food', { name: '分頁 B 過期修改' });
    const writeB = tabB.exportCatalog(); writeB.revision += 1;
    await rejectsCode(() => saveCategoryCatalog(writeB, 0, fixture.environment), 'CATEGORY_REVISION_CONFLICT');
    assert((await readCategoryCatalog(fixture.environment)).categories.find((item) => item.id === 'cat-food').name === '分頁 A 分類', 'stale tab overwrote latest catalog');
  });
  test('分類寫入交易中止時不顯示成功且舊目錄保持完整', async () => {
    const fixture = createStorageFixture(); const { catalog } = await seedCatalog(fixture);
    const changed = createCategoryStore({ catalog }); changed.updateCategory('cat-food', { name: '不可部分保存' });
    const next = changed.exportCatalog(); next.revision += 1; fixture.setAbortWrites(true);
    await rejectsCode(() => saveCategoryCatalog(next, 0, fixture.environment), 'CATEGORY_WRITE_ABORTED');
    const stored = await readCategoryCatalog(fixture.environment);
    assert(stored.revision === 0 && stored.categories.find((item) => item.id === 'cat-food')?.name === '吃', 'aborted catalog change remained');
  });
  test('刪除被收入或支出引用的分類在同一交易內拒絕且不改寫資料', async () => {
    const { expense, income } = recordsFixture(); const fixture = createStorageFixture({ version: 2, expenses: [expense], incomes: [income] });
    const { catalog } = await seedCatalog(fixture);
    const next = structuredClone(catalog);
    next.categories = next.categories.filter((item) => item.id !== 'cat-motorcycle');
    next.subcategories.forEach((item) => { item.categoryIds = item.categoryIds.filter((id) => id !== 'cat-motorcycle'); });
    next.revision += 1;
    const before = JSON.stringify([fixture.dump('expenses'), fixture.dump('incomes'), await readCategoryCatalog(fixture.environment)]);
    await rejectsCode(() => saveCategoryCatalog(next, 0, fixture.environment), 'CATEGORY_IN_USE');
    assert(JSON.stringify([fixture.dump('expenses'), fixture.dump('incomes'), await readCategoryCatalog(fixture.environment)]) === before, 'blocked deletion changed saved data');
  });
  test('刪除未被引用的分類可以保存，原子移除其子分類關聯', async () => {
    const fixture = createStorageFixture(); const { catalog } = await seedCatalog(fixture);
    const candidate = createCategoryStore({ catalog }); candidate.setTransactionReferences([]);
    const result = candidate.deleteCategory('cat-other'); assert(result.ok, 'candidate deletion failed');
    const next = candidate.exportCatalog(); next.revision += 1;
    await saveCategoryCatalog(next, 0, fixture.environment);
    const stored = await readCategoryCatalog(fixture.environment);
    assert(stored.revision === 1 && !stored.categories.some((item) => item.id === 'cat-other'), 'category deletion not saved');
    assert(stored.subcategories.some((item) => item.id === 'sub-uncategorized' && item.categoryIds.length === 0), 'subcategory definition was deleted with parent');
  });
  test('永久刪除被交易引用的子分類會在資料庫交易內阻擋', async () => {
    const { expense } = recordsFixture(); const fixture = createStorageFixture({ version: 2, expenses: [expense] });
    const { catalog } = await seedCatalog(fixture);
    const next = structuredClone(catalog); next.subcategories = next.subcategories.filter((item) => item.id !== 'sub-fuel'); next.revision += 1;
    await rejectsCode(() => saveCategoryCatalog(next, 0, fixture.environment), 'SUBCATEGORY_IN_USE');
    assert(fixture.dump('expenses').length === 1 && (await readCategoryCatalog(fixture.environment)).subcategories.some((item) => item.id === 'sub-fuel'), 'referenced subcategory or expense changed');
  });
  test('舊分頁選到已隱藏的大分類時正式入帳會拒絕並不留紀錄', async () => {
    const { expense } = recordsFixture(); const fixture = createStorageFixture(); const { catalog } = await seedCatalog(fixture);
    const candidate = createCategoryStore({ catalog }); candidate.setCategoryHidden('cat-motorcycle', true);
    const next = candidate.exportCatalog(); next.revision += 1; await saveCategoryCatalog(next, 0, fixture.environment);
    await rejectsCode(() => saveExpense(expense, fixture.environment), 'INVALID_CATEGORY');
    assert(fixture.dump('expenses').length === 0, 'stale category selection created expense');
  });
  test('新增收支時以資料庫最新分類名稱建立歷史快照', async () => {
    const { income } = recordsFixture(); const fixture = createStorageFixture(); const { catalog } = await seedCatalog(fixture);
    const renamed = createCategoryStore({ catalog }); renamed.updateCategory('income-part-time', { name: '最新收入分類' }); renamed.updateSubcategory('sub-income-wage', { name: '最新收入子分類' });
    const next = renamed.exportCatalog(); next.revision += 1;
    await saveCategoryCatalog(next, 0, fixture.environment);
    assert((await saveIncome(income, fixture.environment)).status === 'saved', 'valid income not saved');
    const saved = fixture.dump('incomes')[0];
    assert(saved.categoryNameSnapshot === '最新收入分類' && saved.subcategoryNameSnapshot === '最新收入子分類', 'stale category labels saved');
  });
  test('不相容升級中止、blocked 明確回報', async () => {
    const { expense } = recordsFixture(); const fixture = createStorageFixture({ version: 1, expenses: [expense], incompatible: true });
    await rejectsCode(() => openExpenseDatabase(fixture.environment), 'INCOMPATIBLE_DATABASE');
    assert(fixture.version === 1 && !fixture.storeNames.includes('incomes') && fixture.dump('expenses')[0].id === expense.id, 'failed upgrade changed data');
    await rejectsCode(() => openExpenseDatabase(createStorageFixture({ blocked: true }).environment), 'OPEN_BLOCKED');
  });
  test('收入僅 transaction complete 後成功，冪等鍵拒絕重複', async () => {
    const { income } = recordsFixture(); const fixture = createStorageFixture(); await seedCatalog(fixture); fixture.setHoldWrites(true); let settled = false;
    const pending = saveIncome(income, fixture.environment).then((result) => { settled = true; return result; });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert(!settled && fixture.dump('incomes').length === 0, 'request success reported as transaction complete');
    fixture.releaseWrites(); assert((await pending).status === 'saved', 'save failed'); fixture.setHoldWrites(false);
    assert((await saveIncome({ ...income, id: 'inc_00000000-0000-4000-8000-000000000099' }, fixture.environment)).status === 'duplicate', 'duplicate key allowed');
    assert(fixture.dump('incomes').length === 1, 'duplicate data left behind');
  });
  test('request 成功後交易中止不報成功、不留下收入', async () => {
    const { income } = recordsFixture(); const fixture = createStorageFixture(); await seedCatalog(fixture); fixture.setAbortWrites(true);
    await rejectsCode(() => saveIncome(income, fixture.environment), 'TRANSACTION_ABORTED');
    assert(fixture.dump('incomes').length === 0, 'aborted data retained');
  });
  test('錯誤來源／路徑在開啟前被阻擋，只使用正式 DB 名稱', async () => {
    const { income } = recordsFixture(); const fixture = createStorageFixture();
    await rejectsCode(() => saveIncome(income, { ...fixture.environment, location: { origin: 'http://localhost:5510', pathname: '/' } }), 'WRONG_ORIGIN');
    await rejectsCode(() => listLedgerEntries({ ...fixture.environment, location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/lab/' } }), 'WRONG_PATH');
    assert(fixture.openCalls.length === 0, 'guard opened database');
    await listLedgerEntries(fixture.environment);
    assert(fixture.openCalls.every((call) => call.name === 'LifeRecord_Official_V1' && call.version === EXPENSE_DATABASE_VERSION), 'unexpected database operation');
  });
  test('混合同日收支合計、日期排序與月份篩選正確', () => {
    const { expense, income, legacyIncome } = recordsFixture(); const rows = [legacyIncome, income, expense];
    const groups = groupHistoryRecordsByDate(rows);
    assert(groups.length === 2 && groups[0].date === '2026-11-04' && groups[0].records.length === 2, 'group order wrong');
    assert(groups[0].expenseTotalMinor === 10000n && groups[0].incomeTotalMinor === 35000n, 'totals wrong');
    assert(filterHistoryRecordsByMonth(rows, '2026-10').length === 1, 'month filtering wrong');
    const historyHtml = renderHistoryPage({ title: '歷史紀錄' }, { monthKey: '2026-10' });
    assert(historyHtml.indexOf('data-action="history-month-current"') > historyHtml.indexOf('class="history-month-control"'), 'return-to-current-month control is not below the month navigator');
    assert(historyHtml.includes('data-month-offset="-1"') && historyHtml.includes('data-month-offset="1"'), 'month navigation actions missing');
  });
  test('今日快捷日期採本機日曆日，工作區拖曳保留最小欄寬並可收合恢復', () => {
    const localDate = new Date(2026, 10, 5, 23, 30);
    assert(getLocalDateInputValue(localDate) === '2026-11-05', 'today shortcut did not use local calendar date');
    const bounds = getWorkbenchColumnBounds(1200);
    assert(bounds && bounds.available >= 760 && bounds.minimum > 0 && bounds.maximum < 100, 'desktop column minimums were not enforced');
    const split = resolveWorkbenchDrag('split', 700, 1200);
    assert(split.layout === 'split' && split.leftRatio >= bounds.minimum && split.leftRatio <= bounds.maximum, 'split drag ratio out of bounds');
    assert(resolveWorkbenchDrag('split', 20, 1200).layout === 'side', 'left edge did not collapse entry pane');
    assert(resolveWorkbenchDrag('split', 1180, 1200).layout === 'entry', 'right edge did not collapse side pane');
    assert(resolveWorkbenchDrag('side', 600, 1200).layout === 'split', 'side-only pane could not be restored by dragging');
    assert(resolveWorkbenchDrag('entry', 580, 1200).layout === 'split', 'entry-only pane could not be restored by dragging');
    assert(resolveWorkbenchKeyboard('split', 60, 'Shift', true, 1200).handled === false, 'unknown splitter key was handled');
    assert(resolveWorkbenchKeyboard('split', 60, 'Home', true, 1200).layout === 'side', 'keyboard collapse did not match left-side drag');
    assert(resolveWorkbenchKeyboard('split', 60, 'End', true, 1200).layout === 'entry', 'keyboard collapse did not match right-side drag');
    assert(resolveWorkbenchKeyboard('side', 60, 'Enter', false, 1200).layout === 'split', 'keyboard restore did not return to split layout');
    assert(resolveWorkbenchKeyboard('split', 99, 'ArrowRight', false, 1200).leftRatio <= bounds.maximum, 'keyboard resize exceeded column limits');
    assert(getWorkbenchColumnBounds(760) === null, 'too-narrow workbench should use pane switch mode');
    const { store } = recordsFixture();
    const workbenchHtml = renderWorkbench(store, createEntryDraft(), createWorkbenchState());
    const shortcutOrder = ['history', 'accounts', 'reminders', 'settings'].map((key) => workbenchHtml.indexOf(`data-workbench-link="${key}"`));
    assert(shortcutOrder.every((position, index) => position >= 0 && (!index || position > shortcutOrder[index - 1])), 'workbench shortcuts are missing or out of order');
    assert(workbenchHtml.includes('data-action="entry-set-today"') && workbenchHtml.includes('data-action="open-category-settings"'), 'entry quick actions missing');
    assert(!workbenchHtml.includes('open-workbench-full-panel') && !workbenchHtml.includes('toggle-workbench-focus'), 'duplicate side panel controls remain');
    const sideOnlyState = createWorkbenchState(); sideOnlyState.layout = 'side';
    const sideOnlyHtml = renderWorkbench(store, createEntryDraft(), sideOnlyState);
    assert(sideOnlyHtml.includes('workbench-grid is-side-only') && sideOnlyHtml.includes('data-workbench-splitter'), 'side-only layout has no restorable separator');
  });
  test('正式記帳偏好只套用於未編輯草稿，停用帳戶不會被選入', () => {
    const draft = createEntryDraft();
    const prefs = { defaultEntryType: 'income', dateMode: 'last-entry', lastEntryDate: '2026-10-31', preferredAccountId: 'acct-bank' };
    assert(applyEntryPreferencesToDraft(draft, prefs, [{ id: 'acct-bank' }], { today: '2026-11-06' }));
    assert(draft.type === 'income' && draft.date === '2026-10-31' && draft.accountId === 'acct-bank');
    draft.userEdited = true; draft.amount = '123';
    assert(!applyEntryPreferencesToDraft(draft, { ...prefs, defaultEntryType: 'expense', lastEntryDate: '2026-11-05' }, [{ id: 'acct-bank' }], { today: '2026-11-06' }));
    assert(draft.type === 'income' && draft.date === '2026-10-31' && draft.amount === '123', 'preference overwrote active draft');
    const fresh = createEntryDraft(); applyEntryPreferencesToDraft(fresh, prefs, [], { today: '2026-11-06' });
    assert(fresh.accountId === '', 'inactive/missing preferred account was selected');
  });
  test('收入與支出通用帳戶各自解析，分類切換更新自動值但保留手動帳戶', () => {
    const store = createCategoryStore(); const draft = createEntryDraft();
    const active = [{ id: 'cash' }, { id: 'bank' }, { id: 'other' }];
    const preferences = { defaultEntryType: 'income', dateMode: 'today', preferredAccountIds: { expense: 'cash', income: 'bank' } };
    assert(applyEntryPreferencesToDraft(draft, preferences, active, { today: '2026-11-07' }));
    assert(draft.type === 'income' && draft.accountId === 'bank', 'income default account was mixed with expense');
    switchEntryDraftType(draft, 'expense'); applyResolvedAccountToDraft(draft, 'cash', active);
    assert(draft.accountId === 'cash', 'expense did not receive its own general default');
    assert(selectEntryCategory(store, draft, 'cat-food'), 'expense category selection failed');
    applyResolvedAccountToDraft(draft, 'cash', active);
    selectEntryAccount(draft, 'other');
    assert(selectEntryCategory(store, draft, 'cat-motorcycle'), 'second expense category selection failed');
    applyResolvedAccountToDraft(draft, 'cash', active);
    assert(draft.accountId === 'other', 'category default overwrote a manual account choice');
    switchEntryDraftType(draft, 'income'); applyResolvedAccountToDraft(draft, 'bank', active);
    assert(draft.accountId === 'bank', 'income did not restore its independent account selection');
    switchEntryDraftType(draft, 'expense'); applyResolvedAccountToDraft(draft, 'cash', active);
    assert(draft.accountId === 'other', 'expense manual choice was lost while switching entry type');
    const inactive = createEntryDraft(); applyEntryPreferencesToDraft(inactive, preferences, [{ id: 'cash' }], { today: '2026-11-07' });
    assert(inactive.type === 'income' && inactive.accountId === '', 'inactive or missing typed default account was selected');
  });

  const results = [];
  for (const { name, action } of tests) {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  return { passed: results.filter((item) => item.passed).length, total: results.length, results };
}
