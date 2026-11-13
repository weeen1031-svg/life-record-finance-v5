import { renderAccountsScreen, renderRemindersScreen } from './screens.js';
import { renderFinanceSettingsScreen } from './settings-screens.js';
import { escapeHTML as esc } from '../escape-html.js';
import { icon } from '../icons.js';
import { categoryIconChoices, colorPalette, createCategoryStore } from '../category-store.js';
import { createIdempotencyKey } from '../storage/expense-db.js';
import { getLocalDateInputValue } from '../pages/add-entry.js';
import { accountBalances, accountDeletionBlockReason, getAccountColor, resolveDefaultAccount } from './model.js';
import { mergeFinanceSnapshots } from './merge.js';
import { FINANCE_GATE_REASON, OFFICIAL_FINANCE_ENABLED, createFinanceRepository, financeSnapshotToken } from './repository.js';
import { isFinancePreviewEnabled } from './development-preview.js';
import { isFinanceAppLocation } from './app-location.js';
import { createFinanceBackup, validateFinanceBackup, FINANCE_BACKUP_LIMIT } from './backup.js';
import { holdAcceptanceV3Connection, saveAcceptanceV3CategoryCatalog, seedAcceptanceV3Fixture } from './acceptance-v3-fixture.js';
import { calculateMonthlyBudgets, isValidBudgetMonth } from './budget.js';
import { ACCOUNT_ORDER_KEY, attachAccountOrderInteractions as bindAccountOrderInteractions, loadAccountOrder, normalizeAccountOrder } from './account-order.js';
import { BUDGET_ORDER_KEY, attachBudgetOrderInteractions as bindBudgetOrderInteractions, budgetOrderKey, loadBudgetOrder, normalizeBudgetOrder, saveBudgetOrder } from './budget-order.js';

const baseReminderDefaults = (rule, occurrence) => rule?.entryDefaults || occurrence?.entryDefaults || { categoryId: '', subcategoryId: '', accountId: '', paymentMethod: 'direct' };

export function resolveFinanceControllerMode(officialEnabled = OFFICIAL_FINANCE_ENABLED) {
  return officialEnabled ? 'official' : 'acceptance';
}

// No database access on import/render. The formal controller follows the gate;
// before approval, the same UI remains isolated in acceptance mode.
export function createFinanceController(onChange, { environment = globalThis, mode = resolveFinanceControllerMode(), onData = () => {}, allowDevelopmentPreview = false } = {}) {
  if (!['official', 'acceptance'].includes(mode)) throw new Error('不允許的財務資料模式。');
  const officialModeAvailable = OFFICIAL_FINANCE_ENABLED || (mode === 'official' && allowDevelopmentPreview);
  const reminderExpansionKey = `LifeRecord_Finance_${mode}_ReminderRuleExpansion_v1`;
  const readExpandedReminderRules = () => {
    try {
      const parsed = JSON.parse(environment.sessionStorage?.getItem(reminderExpansionKey) || '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.length <= 200) : []);
    } catch { return new Set(); }
  };
  const state = { data: null, v3Catalog: null, busy: false, operationStatus: '', categoryWarning: '', notice: '', values: {}, keys: {}, categoryDefaultDrafts: new Map(), reminderDrafts: new Map(), editingAccount: null, deleteAccount: null, editingRule: null, editingOccurrence: null, undoOccurrence: null, preview: null, token: '', restoreBackupReadyToken: '', finalRestoreDialog: false, resetExportedToken: '', resetDialog: false, recoveryPoint: null, recoveryDialog: false, selectedBackupName: '', backupValidationStatus: '', v3FixtureReady: false, heldLegacyDb: null, accountView: 'account', accountEventsExpanded: true, accountManagementMode: false, accountOrder: [], accountOrderLoaded: false, accountOrderError: '', budgetOrderByMonth: new Map(), budgetOrderErrorsByMonth: new Map(), budgetOrderError: '', postingPath: 'choice', showCancelled: false, expandedReminderRules: readExpandedReminderRules(), reminderAutoOpenPicker: null, deleteRule: null, stopRule: null, refreshedOn: '', mode };
  function draftCategoryIssue(catalog, draft, entryType) {
    if (!catalog || (!draft?.categoryId && !draft?.subcategoryId)) return '';
    const category = catalog.categories.find((item) => item.id === draft.categoryId && item.entryType === entryType && !item.hidden);
    if (!category) return '原選取的大分類已變更、隱藏或不再可用；草稿內容已保留，請重新選擇。';
    if (draft.subcategoryId && !catalog.subcategories.some((item) => item.id === draft.subcategoryId && item.entryType === entryType && !item.hidden && item.categoryIds.includes(category.id))) {
      return '原選取的子分類已變更、隱藏或解除關聯；草稿內容已保留，請重新選擇。';
    }
    return '';
  }
  function updateCategoryDraftWarning(data = state.data) {
    const catalog = data?.categoryCatalog?.[0];
    if (!catalog) { state.categoryWarning = ''; return; }
    for (const [form, draft] of Object.entries(state.values)) {
      const type = form === 'budget' ? 'expense'
        : form === 'default' ? (draft.entryType || 'expense')
          : form === 'rule-edit' ? (state.editingRule?.entryType || 'expense')
            : form === 'occ-edit' ? (state.editingOccurrence?.entryType || 'expense')
              : (draft.entryType || state.posting?.entryType || 'expense');
      const issue = draftCategoryIssue(catalog, draft, type);
      if (issue) { state.categoryWarning = issue; return; }
    }
    for (const [key, draft] of state.reminderDrafts) {
      const rule = key.startsWith('rule:') ? data.reminderRules.find((item) => item.id === key.slice(5)) : null;
      const occurrence = key.startsWith('occ:') ? data.reminderOccurrences.find((item) => item.id === key.slice(4)) : null;
      const issue = draftCategoryIssue(catalog, draft, rule?.entryType || occurrence?.entryType || draft.entryType || 'expense');
      if (issue) { state.categoryWarning = issue; return; }
    }
    for (const draft of state.categoryDefaultDrafts.values()) {
      const issue = draftCategoryIssue(catalog, draft, draft.entryType);
      if (issue) { state.categoryWarning = issue; return; }
    }
    state.categoryWarning = '';
  }
  const saveExpandedReminderRules = () => {
    try { environment.sessionStorage?.setItem(reminderExpansionKey, JSON.stringify([...state.expandedReminderRules])); } catch { /* UI state remains usable when tab storage is unavailable. */ }
  };
  const publishData = (data, reason = 'refresh') => {
    state.data = data;
    updateCategoryDraftWarning(data);
    onData(data, { mode, reason });
    return data;
  };
  const repository = createFinanceRepository({ mode, environment, allowDevelopmentPreview, onOpenStatus: (status) => {
    if (!['blocked', 'blocked-settled', 'blocked-resolved'].includes(status?.state)) return;
    state.operationStatus = status.message;
    onChange({ preserveScroll: true });
  } });
  let enterPromise = null;
  const today = () => getLocalDateInputValue();
  const values = (form) => state.values[form] ||= {};
  const value = (form, field, fallback = '') => values(form)[field] ?? fallback;
  const developmentPreviewActive = mode === 'official' && !OFFICIAL_FINANCE_ENABLED
    && allowDevelopmentPreview === true && isFinancePreviewEnabled(environment);
  const localRecoveryEnabled = mode === 'acceptance' || developmentPreviewActive || (mode === 'official' && OFFICIAL_FINANCE_ENABLED);
  const mergeImportAvailable = mode === 'acceptance' || developmentPreviewActive || (mode === 'official' && OFFICIAL_FINANCE_ENABLED);
  const selectedImportMode = () => mergeImportAvailable && value('restore', 'importMode', 'replace') === 'merge' ? 'merge' : 'replace';
  const key = (form) => state.keys[form] ||= createIdempotencyKey();
  const reset = (form) => { delete state.values[form]; delete state.keys[form]; };
  const reminderFormName = () => state.editingRule ? 'rule-edit' : state.editingOccurrence ? 'occ-edit' : 'reminder';
  const reminderDraftKey = () => state.editingRule ? `rule:${state.editingRule.id}` : state.editingOccurrence ? `occ:${state.editingOccurrence.id}` : 'new';
  const cacheReminderDraft = () => { state.reminderDrafts.set(reminderDraftKey(), structuredClone(values(reminderFormName()))); };
  const openReminderEditor = ({ rule = null, occurrence = null } = {}) => {
    cacheReminderDraft();
    state.editingRule = rule; state.editingOccurrence = occurrence; state.posting = null;
    const key = reminderDraftKey(); const form = reminderFormName();
    if (state.reminderDrafts.has(key)) state.values[form] = structuredClone(state.reminderDrafts.get(key));
    else reset(form);
  };
  const defaultDraftKey = (categoryId, entryType) => `${entryType}:${categoryId}`;
  const savedDefaultAccount = (categoryId, entryType) => state.data?.financePreferences[0].defaults.find((item) => item.categoryId === categoryId && item.entryType === entryType)?.accountId || '';
  const money = (amount, signed = false) => { const n = BigInt(amount); return `${n < 0n ? '−' : signed ? '+' : ''}$${(n < 0n ? -n : n).toLocaleString('zh-TW')}`; };
  const repaint = (focus = false, result = false, extra = {}) => onChange({ focus, result, ...extra });
  const categoryWarning = () => state.categoryWarning ? `<p class="finance-important" role="alert">${esc(state.categoryWarning)}</p>` : '';
  const processingMessage = () => state.operationStatus || '處理中，請稍候…';
  const button = (action, label, attrs = '') => `<button type="button" class="quiet-button" data-finance-action="${action}" ${state.busy ? 'disabled' : ''} ${attrs}>${label}</button>`;
  const input = (form, field, label, fallback = '', type = 'text', extra = '') => `<label class="finance-field">${label}<input type="${type}" data-finance-form="${form}" data-finance-field="${field}" value="${esc(value(form, field, fallback))}" ${extra} ${state.busy ? 'disabled' : ''}></label>`;
  const select = (form, field, label, options, fallback = '') => `<label class="finance-field">${label}<select data-finance-form="${form}" data-finance-field="${field}" ${state.busy ? 'disabled' : ''}>${options.map(([id, name]) => `<option value="${esc(id)}" ${String(value(form, field, fallback)) === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`;
  const dataEnvironmentLabel = () => mode === 'acceptance' ? '隔離驗收資料' : developmentPreviewActive ? '此瀏覽器設定檔的 V4 開發預覽資料' : 'V5 正式記帳資料';
  const dataEnvironmentSlug = () => mode === 'acceptance' ? 'Acceptance' : developmentPreviewActive ? 'V4_DevPreview' : 'V5_Official';
  function downloadFinanceBackup(backup) {
    const urlApi = environment.URL || globalThis.URL;
    const BlobType = environment.Blob || globalThis.Blob;
    const doc = environment.document || globalThis.document;
    if (!urlApi?.createObjectURL || !BlobType || !doc?.createElement) throw new Error('目前瀏覽器無法安全啟動備份下載；資料沒有變更。');
    const url = urlApi.createObjectURL(new BlobType([backup.text], { type: 'application/json' }));
    const link = doc.createElement('a');
    const stamp = new Date().toISOString().replace('T', '_').replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
    link.href = url;
    link.download = `LifeRecord_${dataEnvironmentSlug()}_FinanceBackup_${stamp}.json`;
    link.click();
    (environment.setTimeout || globalThis.setTimeout)(() => urlApi.revokeObjectURL?.(url), 1000);
    return link.download;
  }
  function clearFinanceDisplayPreferences() {
    try {
      const storage = environment.localStorage;
      if (!isFinanceAppLocation(environment) || !storage?.removeItem) return '本機記帳顯示偏好未能清除。';
      storage.removeItem(`${ACCOUNT_ORDER_KEY}_${mode}`);
      environment.sessionStorage?.removeItem(reminderExpansionKey);
      state.expandedReminderRules.clear();
      const budgetPrefix = `${BUDGET_ORDER_KEY}_${mode}_`;
      if (typeof storage.key === 'function' && Number.isSafeInteger(storage.length)) {
        const keys = [];
        for (let index = 0; index < storage.length; index += 1) {
          const name = storage.key(index);
          if (name?.startsWith(budgetPrefix)) keys.push(name);
        }
        keys.forEach((name) => storage.removeItem(name));
      }
      // Global overview and operation-hint preferences are intentionally kept;
      // overview settings are shared across data modes and cannot be reset safely here.
      return '';
    } catch {
      return '本機記帳顯示偏好未能全部清除；已完成的財務資料重設仍有效。';
    }
  }
  function captureFinanceDisplayPreferences() {
    try {
      const storage = environment.localStorage; const session = environment.sessionStorage;
      if (!isFinanceAppLocation(environment) || !storage?.getItem) return null;
      const accountKey = `${ACCOUNT_ORDER_KEY}_${mode}`; const budgetPrefix = `${BUDGET_ORDER_KEY}_${mode}_`; const budgetOrders = [];
      if (typeof storage.key === 'function' && Number.isSafeInteger(storage.length)) for (let index = 0; index < storage.length; index += 1) {
        const keyName = storage.key(index); if (keyName?.startsWith(budgetPrefix)) budgetOrders.push([keyName, storage.getItem(keyName)]);
      }
      return { mode, accountOrder: storage.getItem(accountKey), budgetOrders, reminderExpansion: session?.getItem(reminderExpansionKey) ?? null };
    } catch { return null; }
  }
  function restoreFinanceDisplayPreferences(snapshot) {
    if (!snapshot || snapshot.mode !== mode) return '記帳畫面偏好未能復原。';
    try {
      const storage = environment.localStorage; const session = environment.sessionStorage;
      if (!isFinanceAppLocation(environment) || !storage?.setItem || !storage?.removeItem) return '記帳畫面偏好未能復原。';
      const accountKey = `${ACCOUNT_ORDER_KEY}_${mode}`; const budgetPrefix = `${BUDGET_ORDER_KEY}_${mode}_`;
      storage.removeItem(accountKey);
      if (typeof storage.key === 'function' && Number.isSafeInteger(storage.length)) {
        const keys = []; for (let index = 0; index < storage.length; index += 1) { const keyName = storage.key(index); if (keyName?.startsWith(budgetPrefix)) keys.push(keyName); }
        keys.forEach((keyName) => storage.removeItem(keyName));
      }
      if (snapshot.accountOrder !== null) storage.setItem(accountKey, snapshot.accountOrder);
      for (const [keyName, value] of snapshot.budgetOrders || []) if (keyName.startsWith(budgetPrefix) && typeof value === 'string') storage.setItem(keyName, value);
      if (snapshot.reminderExpansion === null) session?.removeItem(reminderExpansionKey); else session?.setItem(reminderExpansionKey, snapshot.reminderExpansion);
      const expandedIds = JSON.parse(snapshot.reminderExpansion || '[]');
      state.expandedReminderRules = new Set(Array.isArray(expandedIds) ? expandedIds.filter((id) => typeof id === 'string') : []);
      state.accountOrderLoaded = false;
      return '';
    } catch { return '記帳畫面偏好未能全部復原。'; }
  }
  function orderedAccounts(source = state.data?.accounts || []) {
    if (!state.accountOrderLoaded) {
      const preference = loadAccountOrder(environment, mode);
      state.accountOrder = normalizeAccountOrder(source, preference.ids);
      state.accountOrderError = preference.error;
      state.accountOrderLoaded = true;
    } else state.accountOrder = normalizeAccountOrder(source, state.accountOrder);
    const rows = new Map(source.map((item) => [item.id, item]));
    return state.accountOrder.map((id) => rows.get(id)).filter(Boolean);
  }
  const accounts = () => [['', '請選擇帳戶'], ...orderedAccounts().filter((item) => item.active).map((item) => [item.id, item.name])];
  function initializeBudgetDraft() {
    if (!state.data) return;
    const draft = values('budget');
    const catalog = state.data.categoryCatalog[0];
    const categories = catalog.categories.filter((item) => item.entryType === 'expense' && !item.hidden);
    if (!draft.month) draft.month = today().slice(0, 7);
    if (!draft.categoryId) draft.categoryId = categories[0]?.id || '';
    // Do not discard a stale selection during a background refresh. Explicit
    // user category changes validate/clear incompatible children in handlers.
  }
  const activeCatalog = () => state.data?.categoryCatalog?.[0] || state.v3Catalog || null;
  async function saveCandidateCatalog(mutator, { resetForm = '', clearCatalogFields = [] } = {}) {
    if (mode !== 'acceptance') throw new Error('候選測試分類只允許修改隔離驗收資料。');
    const current = activeCatalog();
    if (!current) throw new Error('請先建立或載入隔離 v3 測試基準，或連接候選 v4 資料。');
    const store = createCategoryStore({ catalog: current, ready: true });
    if (state.data) {
      const references = [
        ...state.data.expenses.map((item) => ({ ...item, recordType: 'expense' })),
        ...state.data.incomes.map((item) => ({ ...item, recordType: 'income' })),
      ];
      if (!store.setTransactionReferences(references)) throw new Error('無法確認候選資料中的分類引用；沒有變更。');
    }
    const result = mutator(store);
    if (!result) throw new Error('分類操作未完成，請檢查名稱及目前選擇。');
    const catalog = store.exportCatalog();
    catalog.revision = current.revision + 1;
    if (state.data) {
      await execute({ kind: 'save-category-catalog', catalog, expectedRevision: current.revision }, resetForm || undefined);
    } else {
      state.v3Catalog = await saveAcceptanceV3CategoryCatalog({ environment, catalog, expectedRevision: current.revision });
      state.v3FixtureReady = true;
      if (resetForm) reset(resetForm);
    }
    for (const field of clearCatalogFields) delete values('catalog')[field];
  }
  const section = (title, content) => `<section class="finance-section"><h2>${title}</h2>${content}</section>`;
  function entryForm() {
    const form = 'entry'; const type = value(form, 'entryType', state.posting?.entryType || state.data.financePreferences[0].entryPreferences?.defaultEntryType || 'expense');
    const preferences = state.data.financePreferences[0].entryPreferences || {};
    const defaultDate = preferences.dateMode === 'last-entry' && preferences.lastEntryDate ? preferences.lastEntryDate : today();
    const store = createCategoryStore({ catalog: state.data.categoryCatalog[0] });
    const categories = store.listCategories({ entryType: type, includeHidden: false });
    const category = value(form, 'categoryId', state.posting?.entryDefaults?.categoryId || '');
    const children = store.listSubcategories(category, { includeHidden: false });
    const defaultAccount = state.posting?.entryDefaults?.accountId || resolveDefaultAccount(state.data, type, category);
    const paymentMethods = [['direct', '依帳戶處理'], ['cash', '現金'], ['convenience-store', '超商繳費'], ['bank-transfer', '銀行轉帳'], ['debit-card', '簽帳金融卡']];
    const noteDefault = state.posting ? `${state.posting.name}${state.posting.note ? ' · ' + state.posting.note : ''}`.slice(0, 160) : '';
    const selectedCategory = categories.find((item) => item.id === category);
    const selectedChild = children.find((item) => item.id === value(form, 'subcategoryId', state.posting?.entryDefaults?.subcategoryId || ''));
    const savedDefaults = state.posting?.entryDefaults || {};
    const savedCategoryValid = !state.posting || categories.some((item) => item.id === savedDefaults.categoryId);
    const savedChildValid = !state.posting || !savedDefaults.subcategoryId || store.listSubcategories(savedDefaults.categoryId, { includeHidden: false }).some((item) => item.id === savedDefaults.subcategoryId);
    const savedAccountValid = !state.posting || !savedDefaults.accountId || state.data.accounts.some((item) => item.id === savedDefaults.accountId && item.active);
    const reminderClassification = state.posting ? `<p class="finance-reminder-current-classification" data-current-category="${esc(selectedCategory?.id || '')}" data-current-subcategory="${esc(selectedChild?.id || '')}">本次分類：${selectedCategory ? `${esc(selectedCategory.name)}${selectedChild ? ` → ${esc(selectedChild.name)}` : ' → 請選子分類'}` : '請選擇有效分類與子分類'}</p>${!savedCategoryValid || !savedChildValid ? '<p class="finance-important">提醒原本設定的分類已無效，請重新選擇；不會自動替換成其他分類。</p>' : ''}${!savedAccountValid ? '<p class="finance-important">提醒原本設定的帳戶已停用或不存在，請重新選擇。</p>' : ''}` : '';
    return section(state.posting ? '確認本期實際收支' : '單筆收支與帳戶連動', `${state.posting ? `<p class="finance-important">來源：${esc(state.posting.name)} · 這次只完成本期，不會修改未來預設。</p>` : `<p>${mode === 'official' ? '正式資料保存前會再次驗證分類與帳戶。' : '僅保存隔離測試資料；分類、子分類與帳戶會在保存時再次驗證。'}</p>`}<div class="finance-fields">
      ${select(form, 'entryType', '收支類型', (state.posting ? [[type, type === 'income' ? '收入' : '支出']] : [['expense', '支出'], ['income', '收入']]), type)}
      ${select(form, 'categoryId', '大分類', [['', '請選擇大分類'], ...categories.map((item) => [item.id, item.name])])}
      ${select(form, 'subcategoryId', '子分類', [['', '請選擇子分類'], ...children.map((item) => [item.id, item.name])], value(form, 'subcategoryId', state.posting?.entryDefaults?.subcategoryId || ''))}
      ${input(form, 'amountTwd', '金額（整數元）', state.posting?.amountTwd || '', 'number', 'min="1" step="1"')}
      ${input(form, 'date', '實際收付日期', state.posting ? today() : defaultDate, 'date')}
      ${select(form, 'accountId', '付款／收款帳戶', accounts(), defaultAccount)}
      ${state.posting ? `<details class="finance-reminder-advanced"><summary>付款方式（選填）</summary>${select(form, 'paymentMethod', '付款／收款方式', paymentMethods, state.posting?.entryDefaults?.paymentMethod || 'direct')}<p data-operation-hint>帳戶是資金來源；付款方式是另一項紀錄，不會依現金或銀行帳戶自動猜測。</p></details>` : select(form, 'paymentMethod', '付款／收款方式', paymentMethods, 'direct')}
      ${input(form, 'note', '備註', noteDefault, 'text', 'maxlength="160"')}
      </div>${reminderClassification}${state.posting ? `<div class="finance-form-footer">${button('cancel-posting', '取消確認')}${button('record', `確認並新增${type === 'income' ? '收入' : '支出'}`)}</div>` : button('record', '保存合成收支')}`);
  }
  function reminderEntryDefaults(form, base, entryType) {
    const catalog = createCategoryStore({ catalog: state.data.categoryCatalog[0] });
    const saved = base?.entryDefaults || {};
    const categoryId = value(form, 'categoryId', saved.categoryId || '');
    const categories = catalog.listCategories({ entryType, includeHidden: false });
    const children = catalog.listSubcategories(categoryId, { includeHidden: false });
    const accountId = value(form, 'accountId', saved.accountId || '');
    const subcategoryId = value(form, 'subcategoryId', saved.subcategoryId || '');
    const selectedCategory = categories.find((item) => item.id === categoryId);
    const selectedChild = children.find((item) => item.id === subcategoryId);
    const selectedAccount = state.data.accounts.find((item) => item.id === accountId && item.active);
    const autoOpenPicker = state.reminderAutoOpenPicker?.form === form ? state.reminderAutoOpenPicker.picker : '';
    const categoryChoices = categories.map((item) => button('choose-reminder-category', `<span aria-hidden="true">${icon(item.icon || 'tag', 22)}</span><span>${esc(item.name)}</span>`, `data-form="${form}" data-category-id="${esc(item.id)}" aria-pressed="${item.id === categoryId}" style="--choice-color:${esc(item.color || '#8795A7')}"`)).join('');
    const childChoices = children.map((item) => button('choose-reminder-subcategory', esc(item.name), `data-form="${form}" data-subcategory-id="${esc(item.id)}" aria-pressed="${item.id === subcategoryId}" style="--choice-color:${esc(selectedCategory?.color || '#8795A7')}"`)).join('');
    const accountChoices = [button('choose-reminder-account', `<span class="finance-choice-account-icon">${icon('wallet', 18)}</span><span><strong>不指定帳戶</strong><small>確認記帳時再選擇</small></span>`, `data-form="${form}" data-account-id="" aria-pressed="${!accountId}" style="--account-color:#8795A7"`), ...orderedAccounts().filter((item) => item.active).map((item) => { const color = getAccountColor(item); return button('choose-reminder-account', `<span class="finance-choice-account-icon">${icon(item.type === 'bank' ? 'bank' : 'wallet', 18)}</span><span><strong>${esc(item.name)}</strong><small>${item.type === 'bank' ? '銀行帳戶' : '現金帳戶'}</small></span>`, `data-form="${form}" data-account-id="${esc(item.id)}" aria-pressed="${accountId === item.id}" style="--account-color:${esc(color)}"`); })].join('');
    const picker = (label, selectedText, placeholder, content, klass, step, accent, hasSelection, hint, leading = '') => `<details class="finance-reminder-picker ${klass} ${hasSelection ? 'has-selection' : 'is-unselected'}"${klass === autoOpenPicker ? ' open' : ''} data-form="${esc(form)}" style="--reminder-picker-color:${esc(accent || '#8795A7')}"><summary aria-label="${esc(`${label}：${selectedText || placeholder}`)}">${leading || `<span class="finance-reminder-picker-step" aria-hidden="true">${step}</span>`}<span class="finance-reminder-picker-copy"><span>${label}</span><strong>${esc(selectedText || placeholder)}</strong></span><span class="finance-reminder-picker-chevron" aria-hidden="true">${icon('chevron', 14)}</span></summary><div class="finance-reminder-picker-popover"><div class="finance-reminder-picker-popover-heading"><strong>選擇${label}</strong><small>${esc(hint)}</small></div>${content || '<p class="finance-empty">目前沒有可用項目。</p>'}</div></details>`;
    const categoryValue = selectedCategory?.name || (categoryId ? '分類需重新選擇' : '選擇大分類');
    const childValue = selectedChild?.name || (subcategoryId ? '子分類需重新選擇' : selectedCategory ? '選擇子分類' : '先選大分類');
    const accountValue = selectedAccount?.name || (accountId ? '帳戶需重新選擇' : '不指定帳戶');
    const categoryColor = selectedCategory?.color || '#8795A7';
    const accountColor = selectedAccount ? getAccountColor(selectedAccount) : '#8795A7';
    const accountIcon = selectedAccount?.type === 'bank' ? 'bank' : 'wallet';
    const accountLeading = `<span class="finance-reminder-account-icon" aria-hidden="true" style="--account-color:${esc(accountColor)}">${icon(accountIcon, 18)}</span>`;
    const html = `<section class="finance-reminder-defaults"><div class="finance-reminder-defaults-heading"><div><h3>記帳時帶入的預設</h3><p>依序選擇大分類、子分類與資金帳戶；每項都可以留空。</p></div><span class="finance-reminder-optional-badge">選填</span></div><div class="finance-reminder-default-grid">${picker('大分類', selectedCategory?.name || '', categoryValue, `<div class="finance-reminder-category-grid">${categoryChoices}</div>`, 'is-category', 1, categoryColor, Boolean(selectedCategory), '選擇此提醒記帳時預先帶入的大分類')}${picker('子分類', selectedChild?.name || '', childValue, `<div class="finance-reminder-subcategory-grid">${childChoices || '<p class="finance-empty">請先選擇大分類。</p>'}</div>`, 'is-subcategory', 2, categoryColor, Boolean(selectedChild), selectedCategory ? '依大分類選擇子分類' : '請先選擇大分類')}${picker('資金帳戶', selectedAccount?.name || '', accountValue, `<div class="finance-reminder-account-grid">${accountChoices}</div>`, 'is-account', 3, accountColor, Boolean(selectedAccount), '選擇帳戶，或保留不指定', accountLeading)}</div><p data-operation-hint>付款方式可在進階選項設定；未指定帳戶時，確認本期前仍需選擇帳戶。</p></section>`;
    if (autoOpenPicker) state.reminderAutoOpenPicker = null;
    return html;
  }
  function orderedBudgetRows(rows, month) {
    let ids = state.budgetOrderByMonth.get(month);
    if (!ids) {
      const preference = loadBudgetOrder(environment, mode, month);
      ids = normalizeBudgetOrder(rows, preference.ids);
      state.budgetOrderByMonth.set(month, ids);
      state.budgetOrderErrorsByMonth.set(month, preference.error);
    } else ids = normalizeBudgetOrder(rows, ids);
    state.budgetOrderByMonth.set(month, ids);
    state.budgetOrderError = state.budgetOrderErrorsByMonth.get(month) || '';
    const byId = new Map(rows.map((item) => [budgetOrderKey(item), item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }
  function saveBudgetDisplayOrder(focusedOrder, month) {
    if (!state.data || !isValidBudgetMonth(month) || !Array.isArray(focusedOrder)) throw new Error('無法更新此月份的預算排列。');
    const rows = calculateMonthlyBudgets(state.data, month);
    const current = orderedBudgetRows(rows, month).map(budgetOrderKey);
    const available = new Set(current);
    const focusSet = new Set(focusedOrder.filter((id) => available.has(id)));
    const nextFocus = focusedOrder.filter((id, index, list) => available.has(id) && list.indexOf(id) === index);
    if (nextFocus.length !== focusSet.size || !nextFocus.length) return current;
    let cursor = 0;
    const next = current.map((id) => focusSet.has(id) ? nextFocus[cursor++] : id);
    saveBudgetOrder(next, month, environment, mode);
    state.budgetOrderByMonth.set(month, next);
    state.budgetOrderErrorsByMonth.set(month, '');
    state.budgetOrderError = '';
    return next;
  }
  const helpers = () => ({ state, today, value, button, input, select, accounts, accountRecords: () => orderedAccounts(), orderBudgetRows: orderedBudgetRows, section, entryForm, reminderEntryDefaults, reminderFutureCount: (ruleId) => state.data.reminderOccurrences.filter((item) => item.ruleId === ruleId && item.status === 'pending' && item.dueDate > today()).length, money });
  const accountPage = () => renderAccountsScreen(helpers());
  const reminderPage = () => renderRemindersScreen(helpers());
  function acceptanceTools(enabled = false) {
    if (mode !== 'acceptance' || !enabled) return '';
    const catalog = activeCatalog();
    const preparingV4 = !state.data && Boolean(state.v3Catalog);
    const selectedId = value('catalog', 'categoryId', catalog?.categories[0]?.id || '');
    const selected = catalog?.categories.find((item) => item.id === selectedId);
    const selectedChildren = catalog?.subcategories.filter((item) => item.categoryIds.includes(selectedId)) || [];
    const selectedChildId = value('catalog', 'subcategoryId', selectedChildren[0]?.id || '');
    const selectedChild = selectedChildren.find((item) => item.id === selectedChildId);
    const catalogManager = catalog ? `<section class="finance-section finance-dev-tool finance-candidate-catalog"><h3>${preparingV4 ? '隔離 v3 測試分類' : '候選 v4 測試分類管理'}</h3><p class="finance-important">${preparingV4 ? '只修改固定驗收資料庫中的合成 v3 分類；v3→v4 時會沿用同一個分類目錄與 ID。日常正式 v3 不會被讀取或搬移。' : '只會修改本頁連接的隔離驗收資料。預算、提醒及分類預設帳戶會讀取同一份目錄。'}</p><div class="finance-fields">${select('candidate-category', 'entryType', '新增分類類型', [['expense', '支出'], ['income', '收入']], 'expense')}${input('candidate-category', 'name', '新增大分類名稱', '', 'text', 'maxlength="40"')}${select('candidate-category', 'icon', '圖示', categoryIconChoices.map((item) => [item.id, item.label]), 'tag')}${select('candidate-category', 'color', '識別色', colorPalette.map((item) => [item.value, item.name]), '#8795A7')}</div><div class="finance-form-footer">${button('create-candidate-category', preparingV4 ? '新增 v3 測試大分類' : '新增測試大分類')}</div><hr><div class="finance-fields">${select('catalog', 'categoryId', '管理大分類', catalog.categories.map((item) => [item.id, `${item.hidden ? '已隱藏 · ' : ''}${item.entryType === 'income' ? '收入' : '支出'} · ${item.name}`]), selectedId)}${input('catalog', 'name', '大分類名稱', selected?.name || '', 'text', 'maxlength="40"')}${select('catalog', 'subcategoryId', '管理此分類的子分類', selectedChildren.map((item) => [item.id, `${item.hidden ? '已隱藏 · ' : ''}${item.name}`]), selectedChildId)}${input('catalog', 'subcategoryName', '新增子分類名稱', '', 'text', 'maxlength="40"')}</div><div class="finance-actions">${button('save-catalog', '保存大分類名稱')}${button('toggle-candidate-category', selected?.hidden ? '顯示大分類' : '隱藏大分類', selected ? '' : 'disabled')}${button('add-candidate-subcategory', '新增子分類', selected && !selected.hidden ? '' : 'disabled')}${button('toggle-candidate-subcategory', selectedChild?.hidden ? '顯示子分類' : '隱藏子分類', selectedChild ? '' : 'disabled')}${button('unlink-candidate-subcategory', '解除子分類關聯', selectedChild ? '' : 'disabled')}</div></section>` : '<section class="finance-section finance-dev-tool"><h3>v3 升級分類準備</h3><p>先建立隔離 v3 基準，即可在升級前使用共用分類模型加入合成測試分類。</p></section>';
    const upgradeTools = `<section class="finance-section finance-dev-tool"><h3>v3 升級基準與舊分頁連線</h3><p>建立符合正式 v3 結構的合成收入、支出與分類；可在同一基準加入「測試1」等合成分類，之後由同一個原生版本升級交易保留。其他版本或不同資料會遭拒，不會清除或覆蓋。</p><div class="finance-fields">${input('v3fixture', 'confirmation', '輸入「建立隔離測試資料」')}${button('seed-v3-fixture', '建立／核對 v3 測試基準')}</div>${state.v3FixtureReady ? `<p class="finance-important">v3 合成基準已核對。分類目錄 ${catalog?.categories.length ?? '—'} 個大分類、${catalog?.subcategories.length ?? '—'} 個子分類。完成分類準備後，輸入「合成測試」連接；這會在同一隔離資料庫上執行 v3→v4 升級。</p>${button('hold-v3-connection', state.heldLegacyDb ? '舊連線已保持' : '保持舊分頁連線', state.heldLegacyDb ? 'disabled' : '')}${state.heldLegacyDb ? button('release-v3-connection', '釋放舊分頁連線') : ''}` : ''}</section>`;
    return `${catalogManager}<details class="finance-acceptance-tools"><summary>其他開發驗收工具</summary><p data-operation-hint>以下操作只用於隔離測試設定檔；不得在日常資料上執行。</p>${upgradeTools}</details>`;
  }
  function backupSummary(summary, exportedAt) {
    const exported = new Date(exportedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    return `<div class="finance-backup-summary"><p><strong>來源：</strong>${esc(summary.dataset === 'official' ? (developmentPreviewActive ? 'V4 開發預覽資料' : 'V5 正式記帳資料') : '隔離驗收資料')}　<strong>備份時間：</strong>${esc(exported)}</p><ul><li>大分類 ${summary.categories}、子分類 ${summary.subcategories}</li><li>支出 ${summary.expenses} 筆、收入 ${summary.incomes} 筆</li><li>帳戶 ${summary.accounts} 個、帳戶異動 ${summary.accountEvents} 筆</li><li>預算排程 ${summary.budgetSchedules} 筆、指定月份預算 ${summary.budgetOverrides} 筆</li><li>定期項目 ${summary.reminderRules} 個、提醒期次 ${summary.reminderOccurrences} 筆</li></ul></div>`;
  }
  function restoreFinalDialog() {
    if (!state.finalRestoreDialog) return '';
    const importMode = selectedImportMode();
    const description = importMode === 'merge'
      ? '加入備份中尚未存在且關聯完整的資料；相同資料會略過，遇到識別碼衝突時整筆取消。'
      : `以已驗證備份完整取代「${esc(dataEnvironmentLabel())}」中的八個記帳資料集合。`;
    const recoveryCopy = mode === 'acceptance'
      ? '系統會在同一交易保存操作前復原點；本機空間不足時整筆操作取消，原資料保留。'
      : developmentPreviewActive
        ? '系統會在本機保存操作前復原點；如需回到操作前資料，也可用已保存的備份完整覆蓋匯入。'
        : '系統會在本機保存操作前復原點；同一瀏覽器設定檔重開後仍可復原。';
    const scopeCopy = mode === 'acceptance'
      ? '只作用於目前隔離驗收資料，不影響正式資料或其他生活模組。'
      : developmentPreviewActive
        ? '只作用於目前 V4 開發預覽；不會改變正式啟用閘門或其他生活模組。'
        : '只作用於目前 V5 正式記帳資料及支援的八個資料集合。';
    return `<div class="finance-dialog-backdrop" data-finance-restore-dialog><section class="finance-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="finance-restore-final-title" aria-describedby="finance-restore-final-description"><h2 id="finance-restore-final-title">再次確認匯入備份</h2><p id="finance-restore-final-description">${description}已先下載目前資料備份；Repository 會在同一資料庫交易再次比對資料，失敗不會留下部分變更。${recoveryCopy} ${scopeCopy}</p><div class="finance-form-footer">${button('cancel-restore-final', '取消')}${button('confirm-restore-final', importMode === 'merge' ? '確認加入備份' : '確認覆蓋資料', 'data-danger="true"')}</div></section></div>`;
  }
  function recoveryDialog() {
    if (!state.recoveryDialog || !state.recoveryPoint || !localRecoveryEnabled) return '';
    const point = state.recoveryPoint; const canUndo = point.afterToken === financeSnapshotToken(state.data);
    const actionName = { reset: '恢復初始狀態', replace: '覆蓋匯入備份', merge: '加入匯入備份' }[point.action] || '資料操作';
    return `<div class="finance-dialog-backdrop" data-finance-recovery-dialog><section class="finance-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="finance-recovery-title" aria-describedby="finance-recovery-description"><h2 id="finance-recovery-title">復原上一個操作</h2><p id="finance-recovery-description">將復原「${esc(actionName)}」前保存的「${esc(dataEnvironmentLabel())}」，包含收支、分類、帳戶異動、預算及提醒。此復原點保存在本機，關閉瀏覽器後仍保留。${canUndo ? '' : '操作後資料已有變動，為避免移除新紀錄，目前不能直接復原；請使用先前下載的 JSON 備份。'}</p><ul><li>操作前收入 ${point.beforeSummary.incomes} 筆、支出 ${point.beforeSummary.expenses} 筆</li><li>帳戶 ${point.beforeSummary.accounts} 個、異動 ${point.beforeSummary.accountEvents} 筆</li><li>預算 ${point.beforeSummary.budgetSchedules + point.beforeSummary.budgetOverrides} 筆、提醒 ${point.beforeSummary.reminderRules + point.beforeSummary.reminderOccurrences} 筆</li></ul>${canUndo ? input('recovery', 'confirmation', '輸入「復原上一個操作」') : ''}<div class="finance-form-footer">${button('cancel-recovery-undo', '取消')}${canUndo ? button('confirm-recovery-undo', '確認復原', value('recovery', 'confirmation') === '復原上一個操作' ? 'data-danger="true"' : 'disabled') : ''}</div></section></div>`;
  }
  function resetFinalDialog() {
    if (!state.resetDialog || !localRecoveryEnabled || !state.data) return '';
    const environmentScope = mode === 'acceptance' ? '隔離驗收環境' : developmentPreviewActive ? '此瀏覽器設定檔的 V4 開發預覽' : 'V5 正式記帳資料';
    return `<div class="finance-dialog-backdrop" data-finance-reset-dialog><section class="finance-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="finance-reset-final-title" aria-describedby="finance-reset-final-description"><h2 id="finance-reset-final-title">確認恢復初始狀態</h2><p id="finance-reset-final-description">目前環境：${esc(dataEnvironmentLabel())}。將清除此${environmentScope}的收入、支出、大分類與子分類、帳戶及異動、預算、定期項目、期次與記帳偏好，再保留支出與收入各自獨立的「其他 → 未分類」基本分類。此動作不影響其他資料環境、日記、睡眠或全域系統設定。你已先下載現況備份；系統也會在本機保存操作前復原點，同一瀏覽器設定檔重開後仍可復原。復原點需要足夠本機儲存空間；空間不足時整筆重設取消、原資料保留。若重設後已有其他記帳資料變更，為保護新資料會停用快速復原。</p><ul><li>收入 ${state.data.incomes.length}、支出 ${state.data.expenses.length}</li><li>大分類 ${state.data.categoryCatalog[0]?.categories.length || 0}、子分類 ${state.data.categoryCatalog[0]?.subcategories.length || 0}</li><li>帳戶 ${state.data.accounts.length}、異動 ${state.data.accountEvents.length}</li><li>預算排程 ${state.data.financePreferences[0]?.budgetSchedules.length || 0}、指定月份預算 ${state.data.financePreferences[0]?.budgetOverrides.length || 0}</li><li>定期項目 ${state.data.reminderRules.length}、提醒期次 ${state.data.reminderOccurrences.length}</li><li>重設後不建立帳戶、交易或示範金額；通用付款帳戶為「不指定」。</li><li>只清除此環境專屬的帳戶／預算排序與提醒展開狀態；共用總覽布局及全域設定保留。</li></ul><div class="finance-form-footer">${button('cancel-reset-confirmation', '取消')}${button('confirm-reset-acceptance', '恢復初始狀態', 'data-danger="true"')}</div></section></div>`;
  }
  function resetPanel() {
    if (!localRecoveryEnabled) return `<section class="finance-data-action-card finance-data-action-card-danger"><div><h3>恢復初始狀態</h3><p>目前資料環境尚未開放恢復初始狀態。此資料不會被清除。</p></div><button type="button" class="quiet-button" disabled aria-disabled="true">尚未開放</button></section>`;
    if (!state.data) return `<section class="finance-data-action-card finance-data-action-card-danger"><div><h3>恢復初始狀態</h3><p>目前環境：${esc(dataEnvironmentLabel())}。先連接此記帳資料，才可重設它。</p></div><button type="button" class="quiet-button" disabled aria-disabled="true">尚未連接資料</button></section>`;
    const ready = state.resetExportedToken === financeSnapshotToken(state.data);
    const scope = mode === 'acceptance' ? '目前隔離驗收環境' : developmentPreviewActive ? '目前已啟用的 V4 開發預覽' : '目前 V5 正式記帳資料';
    return `<section class="finance-data-action-card finance-data-action-card-danger"><div><h3>恢復初始狀態</h3><p>僅作用於${scope}。先下載完整備份，再勾選已保存並輸入確認詞；其他資料環境與生活模組不受影響。</p><small>只保留支出與收入各自的「其他 → 未分類」分類；不建立帳戶或示範交易。完成後可用本機復原點回復上一個狀態。</small></div><div class="finance-data-action-controls">${button('export', ready ? '重新下載重設前備份' : '先下載完整備份')}${ready ? `<label class="finance-backup-saved"><input type="checkbox" data-finance-form="reset" data-finance-field="backupSaved" ${value('reset', 'backupSaved') === 'true' ? 'checked' : ''}>我已確認備份檔已保存</label>${input('reset', 'confirmation', '輸入「恢復初始狀態」')}${button('reset-acceptance', '繼續確認恢復', value('reset', 'backupSaved') === 'true' && value('reset', 'confirmation') === '恢復初始狀態' ? '' : 'disabled')}` : ''}</div></section>`;
  }
  function restorePreview() {
    if (!state.preview || state.finalRestoreDialog) return '';
    const ready = Boolean(state.token) && state.restoreBackupReadyToken === state.token;
    const importMode = selectedImportMode();
    const phrase = importMode === 'merge' ? (mode === 'acceptance' ? '加入合成資料' : '加入新資料') : mode === 'official' ? '完整還原' : '還原合成資料';
    let mergePreview = null; let mergeError = '';
    if (importMode === 'merge') {
      if (state.preview.formatVersion !== 6) mergeError = '加入新資料需要格式 6 的完整備份。請在備份來源重新下載最新版備份。';
      else { try { mergePreview = mergeFinanceSnapshots(state.data, state.preview.data); } catch (error) { mergeError = error.message || String(error); } }
    }
    const modeChoices = mergeImportAvailable ? `<fieldset class="finance-import-mode"><legend>匯入方式</legend><label><input type="radio" name="finance-import-mode" value="replace" data-finance-form="restore" data-finance-field="importMode" ${importMode === 'replace' ? 'checked' : ''}>覆蓋目前資料</label><label><input type="radio" name="finance-import-mode" value="merge" data-finance-form="restore" data-finance-field="importMode" ${importMode === 'merge' ? 'checked' : ''}>加入新資料</label></fieldset>` : '';
    const mergeResult = importMode === 'merge' ? mergeError
      ? `<p class="finance-important">${esc(mergeError)}</p>`
      : `<p class="finance-merge-result">${mergePreview.totalAdded ? `預計加入 ${mergePreview.totalAdded} 筆新資料${mergePreview.changedSettings ? '，並合併相容的記帳偏好' : ''}；相同資料會略過。` : mergePreview.changedSettings ? '沒有新增項目，會合併一項相容的記帳偏好。' : '備份資料都已存在，加入後不會變更內容。'} 衝突時會取消整次操作。</p>` : '';
    const importVerb = importMode === 'merge' ? '加入' : '覆蓋';
    const modeDescription = importMode === 'merge'
      ? '依穩定識別碼合併支援的八個記帳資料集合；相同內容略過，識別碼衝突或關聯不完整時整次取消。'
      : `以備份完整${importVerb}「${esc(dataEnvironmentLabel())}」目前支援的八個記帳資料集合。`;
    const recoveryNote = localRecoveryEnabled
      ? '系統會在本機保存操作前復原點。'
      : '目前資料環境尚未開放本機快速復原；如需回到操作前資料，可用剛保存的備份選擇覆蓋匯入。';
    const importPrompt = mergeImportAvailable ? '請核對摘要，並選擇要如何匯入。' : '請核對摘要，並完成匯入前確認。';
    return `<div class="finance-dialog-backdrop finance-import-preview-backdrop" data-finance-import-preview-dialog><section class="finance-import-preview finance-import-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="finance-import-preview-title" tabindex="-1"><div class="finance-import-preview-heading"><div><span class="eyebrow">BACKUP IMPORT</span><h2 id="finance-import-preview-title" tabindex="-1">備份已通過驗證</h2><p>${importPrompt}</p></div></div>${backupSummary(state.preview.summary, state.preview.exportedAt)}${modeChoices}<p class="finance-important">${modeDescription}不影響其他資料環境、日記、睡眠或全域設定。</p>${mergeResult}<div class="finance-import-backup-step"><strong>先保存目前資料</strong><p>匯入前先下載目前環境的完整備份；${recoveryNote}若資料在預覽後變動，流程會取消並要求重新檢查。</p>${button('export-before-restore', ready ? '重新下載目前資料備份' : '下載目前資料完整備份')}${ready ? `<label class="finance-backup-saved"><input type="checkbox" data-finance-form="restore" data-finance-field="backupSaved" ${value('restore', 'backupSaved') === 'true' ? 'checked' : ''}>我已確認目前備份檔已保存至安全位置</label>` : ''}</div>${input('restore', 'confirmation', `輸入「${phrase}」確認`)}<div class="finance-form-footer">${button('cancel-restore', '取消匯入')}${button('restore', `繼續確認${importVerb}`, ready && value('restore', 'backupSaved') === 'true' && !mergeError ? '' : 'disabled')}</div></section></div>`;
  }
  function recoveryActionCard() {
    const point = state.recoveryPoint;
    let description = '';
    let detail = '';
    let control = '';
    if (!localRecoveryEnabled) {
      const label = developmentPreviewActive ? '此瀏覽器設定檔的 V4 開發預覽' : 'V5 正式記帳資料';
      description = `目前連接「${label}」；此資料區尚未開放本機復原。`;
      detail = '一般記帳仍會逐筆保存，JSON 備份可另外保存。';
      control = '<button type="button" class="quiet-button" disabled aria-disabled="true">尚未開放</button>';
    } else if (!point) {
      description = '目前沒有可復原的操作。';
      detail = '完成恢復初始狀態或匯入備份後，操作前資料會保存在這裡；同一瀏覽器設定檔重開後仍可復原。';
      control = button('open-recovery-undo', '目前沒有復原點', 'disabled');
    } else {
      const action = { reset: '恢復初始狀態', replace: '覆蓋匯入備份', merge: '加入匯入備份' }[point.action] || '資料操作';
      const valid = point.afterToken === financeSnapshotToken(state.data);
      const stamp = new Date(point.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      description = `上次操作：${action} · ${stamp}。同一瀏覽器設定檔重開後仍保留。`;
      detail = valid ? '目前資料未變動，可復原操作前的完整資料。清除網站資料或換裝置後，請使用已保存的 JSON 備份。' : '操作後資料已變動；為保護新紀錄，快速復原已停用，可使用先前下載的 JSON 備份。';
      control = button('open-recovery-undo', valid ? '復原上一個操作' : '目前無法復原', valid ? '' : 'disabled');
    }
    return `<section class="finance-data-action-card finance-data-action-card-recovery"><div class="finance-data-action-copy"><h3>復原上一個操作</h3><p>${esc(description)}</p><small>${esc(detail)}</small></div><div class="finance-data-action-state" aria-hidden="true"></div><div class="finance-data-action-controls">${control}</div></section>`;
  }
  function recoveryPanel() {
    const point = state.recoveryPoint;
    if (!localRecoveryEnabled) {
      const label = developmentPreviewActive ? '此瀏覽器設定檔的 V4 開發預覽' : 'V5 正式記帳資料';
      return `<section class="finance-recovery-point" aria-labelledby="finance-recovery-point-title"><div><h3 id="finance-recovery-point-title">復原上一個操作</h3><p>目前連接「${esc(label)}」；此資料區尚未開放本機復原。</p><small>一般記帳仍會逐筆保存，JSON 備份可另外保存。</small></div></section>`;
    }
    if (!point) return `<section class="finance-recovery-point" aria-labelledby="finance-recovery-point-title"><div><h3 id="finance-recovery-point-title">本機復原點</h3><p>目前沒有可復原的操作。</p><small>完成一次「恢復初始狀態」、覆蓋匯入或加入匯入後，操作前資料會保存在這裡；同一瀏覽器設定檔重開後仍可復原。</small></div>${button('open-recovery-undo', '目前沒有復原點', 'disabled')}</section>`;
    const action = { reset: '恢復初始狀態', replace: '覆蓋匯入備份', merge: '加入匯入備份' }[point.action] || '資料操作';
    const valid = point.afterToken === financeSnapshotToken(state.data);
    const stamp = new Date(point.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    return `<section class="finance-recovery-point" aria-labelledby="finance-recovery-point-title"><div><h3 id="finance-recovery-point-title">本機復原點</h3><p>上次操作：${esc(action)} · ${esc(stamp)}。同一瀏覽器設定檔重開後仍保留。</p><small>${valid ? '目前資料未變動，可復原操作前的完整資料。清除網站資料或換裝置後，請使用已保存的 JSON 備份。' : '操作後資料已變動；為保護新紀錄，快速復原已停用，可使用先前下載的 JSON 備份。'}</small></div>${button('open-recovery-undo', '復原上一個操作', valid ? '' : 'disabled')}</section>`;
  }
  function backupFilePicker(disabled = false) {
    const status = state.backupValidationStatus;
    return `<label class="finance-file-picker${disabled ? ' is-disabled' : ''}"><span class="finance-file-picker-action">選擇檔案</span><span class="finance-file-picker-name">${esc(state.selectedBackupName || '尚未選擇檔案')}</span><span class="finance-file-picker-status" title="${esc(status)}" role="status" aria-live="polite">${esc(status)}</span><input type="file" accept=".json,application/json" data-finance-file aria-label="選擇 FinanceBackup JSON 檔案" ${disabled ? 'disabled' : ''}></label>`;
  }
  function dataManagementFilePicker(disabled = false) {
    const status = state.backupValidationStatus;
    const name = state.selectedBackupName || '尚未選擇檔案';
    return `<div class="finance-data-import-picker"><div class="finance-data-import-state"><span class="finance-data-import-name" title="${esc(name)}">${esc(name)}</span><span class="finance-data-import-status" title="${esc(status)}" role="status" aria-live="polite">${esc(status)}</span></div><label class="finance-data-file-picker${disabled ? ' is-disabled' : ''}"><span class="finance-file-picker-action">選擇檔案</span><input type="file" accept=".json,application/json" data-finance-file aria-label="選擇 FinanceBackup JSON 檔案" ${disabled ? 'disabled' : ''}></label></div>`;
  }
  function dataManagementSection() {
    const hasData = Boolean(state.data);
    const status = state.busy ? processingMessage() : state.notice;
    return `<section class="finance-section ledger-data-management" aria-labelledby="ledger-data-management-title"><div class="finance-panel-heading"><div><h2 id="ledger-data-management-title">資料管理</h2><p>目前環境：<strong>${esc(dataEnvironmentLabel())}</strong>。備份檔是未加密 JSON，請妥善保存。</p></div></div><div class="finance-data-action-grid"><section class="finance-data-action-card finance-data-action-card-backup"><div class="finance-data-action-copy"><h3>快速備份</h3><p>備份目前記帳資料並驗證資料關聯；下載不會更動資料。</p></div><div class="finance-data-action-state" aria-hidden="true"></div><div class="finance-data-action-controls">${button('export', '下載完整備份', hasData ? '' : 'disabled')}</div></section><section class="finance-data-action-card finance-data-action-card-import"><div class="finance-data-action-copy"><h3>匯入備份</h3><p>選擇已匯出的 Life Record 備份檔。</p></div>${dataManagementFilePicker(state.busy || !hasData)}</section>${recoveryActionCard()}${resetPanel()}</div>${restorePreview()}${status ? `<p class="finance-result finance-data-management-status" role="status" aria-live="polite">${esc(status)}</p>` : ''}<details class="ledger-advanced-settings"><summary>進階／開發設定</summary><div><a class="quiet-button" href="#ledger-settings/backup" data-page="ledger-settings" data-settings-subview="backup">記帳資料備份與安全管理</a>${mode === 'acceptance' ? '<a class="quiet-button" href="#ledger-settings/acceptance" data-page="ledger-settings" data-settings-subview="acceptance">隔離驗收工具與復原測試</a>' : ''}</div></details></section>${restoreFinalDialog()}${resetFinalDialog()}${recoveryDialog()}`;
  }
  function backupSection() {
    const label = mode === 'official' ? '記帳資料備份與還原' : '隔離驗收資料備份與還原';
    return `<section class="finance-section finance-backup-details"><h2>${label}</h2><p>FinanceBackup v6 涵蓋目前支援的八個資料集合。JSON 是明文；SHA-256 用於檢查內容一致性，不代表加密。</p>${button('export', '下載完整備份', state.data ? '' : 'disabled')}${backupFilePicker(state.busy || !state.data)}${restorePreview()}${recoveryPanel()}${restoreFinalDialog()}${resetPanel()}${resetFinalDialog()}${recoveryDialog()}</section>`;
  }
  function render(page) {
    if (page === 'accounts' && state.data) orderedAccounts(state.data.accounts);
    const settingsView = ['default', 'preferences', 'budget'].includes(state.accountView);
    const heading = page === 'accounts' ? (settingsView ? '記帳設定' : '資金帳戶') : page === 'backup' ? '記帳資料備份與還原' : '定期收支與提醒';
    const pageIcon = page === 'accounts' ? (settingsView ? 'settings-2' : 'landmark') : 'bell';
    const pageEyebrow = page === 'accounts' ? (settingsView ? 'LEDGER SETTINGS' : 'ACCOUNTS') : 'RECURRING PAYMENTS';
    const financeHeading = (copy, actions = '') => `<div class="page-heading finance-page-heading"><div><div class="eyebrow finance-page-eyebrow"><span class="eyebrow-spark">${icon(pageIcon, 15)}</span> ${pageEyebrow}</div><h1>${heading}</h1><p class="page-subtitle">${copy}</p></div>${actions ? `<div class="page-heading-actions finance-toolbar">${actions}</div>` : ''}</div>`;
    const operationStatus = state.busy ? processingMessage() : state.notice;
    const gate = `<div class="finance-safety-note"><strong>正式帳戶與提醒尚未開放</strong><p>目前可操作的內容只使用獨立測試資料，不會讀取或修改正式收支、分類及帳戶。</p><p>完成資料安全驗收前，正式資料不會變更。</p></div>`;
    if (!state.data && mode === 'official') return `<div data-finance-workspace aria-busy="${state.busy}">${financeHeading(developmentPreviewActive ? '目前使用此瀏覽器設定檔的 V4 開發預覽。' : 'V5 正式記帳資料載入中。')}${!officialModeAvailable ? gate : ''}<p class="finance-result" role="status" aria-live="polite">${esc(state.busy ? processingMessage() : state.notice || (officialModeAvailable ? '尚未載入正式記帳資料。' : FINANCE_GATE_REASON))}</p>${categoryWarning()}</div>`;
    if (!state.data) return `<div data-finance-workspace>${financeHeading('目前尚未啟用此瀏覽器設定檔的 V4 開發版。', '<a class="primary-button finance-v4-entry-link" href="#ledger-settings/backup" data-page="ledger-settings" data-settings-subview="backup">V4 開發版：備份與啟用</a>')}${gate}${section('隔離驗收資料（選用）', `<p>這是另一個獨立資料來源。試用一般 V4 功能不需要連接它；請從「V4 開發版：備份與啟用」完成目前瀏覽器設定檔的備份確認。</p><div class="finance-fields">${input('gate', 'confirmation', '輸入「合成測試」以開始')}${button('connect', '連接隔離驗收資料')}</div>`)}<p role="status" aria-live="polite">${esc(state.operationStatus || state.notice)}</p>${acceptanceTools()}</div>`;
    const headingCopy = mode === 'official' ? (settingsView ? '管理記帳預設與每月計畫' : '管理資金帳戶及異動') : '目前使用獨立測試資料；正式保存尚未開放';
    if (page === 'backup') return `<div data-finance-workspace aria-busy="${state.busy}"><div class="page-heading"><div><h1>${heading}</h1><p>${developmentPreviewActive ? '目前使用此瀏覽器設定檔的 V4 開發預覽。' : '完整備份目前 V5 正式記帳資料；JSON 為明文，請存放在安全位置。'}</p></div></div>${developmentPreviewActive ? '<p class="finance-preview-state"><strong>目前狀態：V4 開發預覽</strong>。資料操作只作用於目前設定檔。</p>' : mode === 'official' ? '<p class="finance-preview-state"><strong>目前狀態：V5 正式版</strong>。記帳、歷史、帳戶、預算、提醒與設定共用正式資料。</p>' : ''}${mode === 'acceptance' ? `${gate}<div class="finance-synthetic-badge">目前連接獨立測試資料；不影響正式收支</div>` : ''}${operationStatus ? `<p class="finance-result" tabindex="-1" role="status" aria-live="polite">${esc(operationStatus)}</p>` : ''}${categoryWarning()}${backupSection()}${acceptanceTools()}</div>`;
    const actions = `${mode === 'acceptance' ? '<a class="quiet-button finance-v4-entry-link" href="#ledger-settings/backup" data-page="ledger-settings" data-settings-subview="backup">V4 開發版與備份</a>' : ''}${button('reload', '重新讀取')}${mode === 'acceptance' ? button('disconnect', '離開測試資料') : ''}`;
    return `<div data-finance-workspace aria-busy="${state.busy}">${financeHeading(headingCopy, actions)}${mode === 'acceptance' ? `${gate}<div class="finance-synthetic-badge">本分頁已連接測試資料；此為獨立驗收資料，並非 V4 開發版。<a href="#ledger-settings/backup" data-page="ledger-settings" data-settings-subview="backup">前往啟用 V4 開發版</a></div>` : ''}${operationStatus ? `<p class="finance-result" tabindex="-1" role="status" aria-live="polite">${esc(operationStatus)}</p>` : ''}${categoryWarning()}${page === 'accounts' ? accountPage() : reminderPage()}${acceptanceTools()}</div>`;
  }
  function renderSetting(view) {
    if (view === 'acceptance') {
      if (mode !== 'acceptance') return '<div class="finance-empty">開發驗收工具僅能在明確隔離的測試模式中使用。</div>';
      return `<div class="finance-setting-page" data-finance-workspace><div class="page-heading inner-page-heading"><div><div class="eyebrow">Life Record · 測試專區</div><h1>開發驗收工具</h1><p class="page-subtitle">目前此頁只連接隔離驗收資料，未啟用目前瀏覽器設定檔的 V4 開發版。</p><a class="quiet-button finance-v4-entry-link" href="#ledger-settings/backup" data-page="ledger-settings" data-settings-subview="backup">前往啟用 V4 開發版</a></div></div><p class="finance-result" tabindex="-1" role="status" aria-live="polite">${esc(state.busy ? processingMessage() : state.notice || '尚未執行驗收操作。')}</p>${categoryWarning()}${acceptanceTools(true)}${state.data ? backupSection() : section('連接隔離驗收資料', `<p class="finance-important">僅限隔離測試使用；日常頁面不需連接此資料。</p>${input('gate', 'confirmation', '輸入「合成測試」')}${button('connect', '連接隔離驗收資料')}</section>`)}</div>`;
    }
    if (state.data && view === 'budget') initializeBudgetDraft();
    if (state.data) orderedAccounts(state.data.accounts);
    const titles = { ledger: '記帳設定', budget: '每月預算', preferences: '記帳偏好', defaults: '分類預設帳戶' };
    const title = titles[view] || '記帳設定';
    const gate = `<div class="finance-safety-note"><strong>正式帳戶與提醒尚未開放</strong><p>目前可操作的內容只使用獨立測試資料；正式資料不會變更。</p><p>${esc(FINANCE_GATE_REASON)}</p></div>`;
    if (!state.data) {
      if (mode === 'official') return `<div data-finance-workspace><div class="page-heading"><div><h1>${title}</h1><p>${developmentPreviewActive ? '目前使用此瀏覽器設定檔的 V4 開發預覽。' : 'V5 正式記帳資料載入中。'}</p></div></div>${!officialModeAvailable ? gate : ''}<p class="finance-result" role="status" aria-live="polite">${esc(state.busy ? processingMessage() : state.notice || (officialModeAvailable ? '尚未載入正式記帳資料。' : FINANCE_GATE_REASON))}</p>${categoryWarning()}</div>`;
      return `<div data-finance-workspace><div class="page-heading"><div><h1>${title}</h1><p>目前尚未啟用此瀏覽器設定檔的 V4 開發版。</p><a class="primary-button finance-v4-entry-link" href="#ledger-settings/backup" data-page="ledger-settings" data-settings-subview="backup">V4 開發版：備份與啟用</a></div></div>${gate}${section('隔離驗收資料（選用）', `<p>日常使用及試用 V4 不必連接隔離驗收資料。請前往 V4 開發版頁面，先核對 V3 備份並明確確認升級。</p><div class="finance-fields">${input('gate', 'confirmation', '輸入「合成測試」以開始')}${button('connect', '連接隔離驗收資料')}</div>`)}<p role="status" aria-live="polite">${esc(state.operationStatus || state.notice)}</p>${acceptanceTools()}</div>`;
    }
    const dataManagement = view === 'ledger' ? dataManagementSection() : '';
    return `${categoryWarning()}${renderFinanceSettingsScreen(helpers(), view, { dataManagement })}`;
  }
  async function run(action, { preserveScroll = false, focusBudgetEditor = false, focusRestoreDialog = false, focusResetDialog = false, focusImportPreview = false } = {}) {
    if (state.busy) return;
    state.operationStatus = ''; state.busy = true; onChange(preserveScroll ? { preserveScroll: true } : {});
    try { await action(); }
    catch (error) { state.notice = `未完成：${error.message} 輸入已保留；請重新讀取確認後再操作。`; }
    finally { state.busy = false; state.operationStatus = ''; preserveScroll ? repaint(false, false, { preserveScroll: true, focusBudgetDeleteCancel: Boolean(state.deleteBudget), focusBudgetEditor: focusBudgetEditor && !state.deleteBudget, focusImportPreview }) : focusRestoreDialog ? repaint(false, false, { focusRestoreDialog: true }) : focusResetDialog ? repaint(false, false, { focusResetDialog: true }) : repaint(true, true); }
  }
  async function execute(command, form) {
    const result = await repository.execute(command, { today: today(), expectedGeneration: state.data.financePreferences[0].generation });
    publishData(result.data, 'command');
    const warnings = result.warnings.join(' ');
    state.notice = result.status === 'duplicate'
      ? `已處理過，沒有新增交易或再次變動餘額。${warnings ? ` ${warnings}` : ''}`
      : warnings;
    if (form) reset(form);
    return result;
  }
  async function click(target) {
    const action = target?.dataset?.financeAction;
    if (!action) return false;
    if (state.busy) return true;
    const id = target.dataset.id;
    if (action === 'connect') { await run(async () => { if (value('gate', 'confirmation') !== '合成測試') throw new Error('請先輸入「合成測試」。'); publishData(await repository.initialize(), 'connect'); state.v3Catalog = null; state.v3FixtureReady = false; await refreshPeriods(); state.recoveryPoint = await repository.getRecoveryPoint(); state.notice = '已連接隔離驗收資料；正式資料庫未開啟。'; }); return true; }
    if (action === 'seed-v3-fixture') { await run(async () => { const seeded = await seedAcceptanceV3Fixture({ environment, confirmation: value('v3fixture', 'confirmation') }); state.v3Catalog = seeded.data.categoryCatalog[0]; state.v3FixtureReady = true; state.notice = `${seeded.seeded ? '已建立' : '已核對'}隔離 v3 基準：支出 ${seeded.data.expenses.length} 筆、收入 ${seeded.data.incomes.length} 筆；舊支出金額為 ${seeded.data.expenses[0]?.amountMinor ?? '—'} 分。可先在上方分類工具加入合成分類；之後連接會升級同一資料庫。`; reset('v3fixture'); }); return true; }
    if (action === 'hold-v3-connection') { await run(async () => { if (!state.v3FixtureReady || state.heldLegacyDb) throw new Error('請先建立 v3 基準；同一分頁只保持一條舊連線。'); state.heldLegacyDb = await holdAcceptanceV3Connection({ environment, onVersionChange: () => { state.notice = '另一分頁正在請求升級；此 v3 連線目前阻擋升級。按「釋放」後可在另一分頁重試。'; onChange(); } }); state.notice = '已保持 v3 舊連線。請在另一分頁連接驗收區，確認升級被 blocked；測試後回來釋放。'; }); return true; }
    if (action === 'release-v3-connection') { state.heldLegacyDb?.close(); state.heldLegacyDb = null; state.notice = '已釋放 v3 舊連線；可回到另一分頁重試升級。'; onChange(); return true; }
    const catalogActions = ['create-candidate-category', 'save-catalog', 'add-candidate-subcategory', 'toggle-candidate-category', 'toggle-candidate-subcategory', 'unlink-candidate-subcategory'];
    if (!state.data && !(mode === 'acceptance' && state.v3Catalog && catalogActions.includes(action))) return true;
    if (action === 'create-candidate-category') {
      await run(async () => {
        const name = value('candidate-category', 'name').trim();
        if (!name || name.length > 40) throw new Error('請輸入 1–40 字的大分類名稱。');
        await saveCandidateCatalog((store) => store.addCategory({ name, entryType: value('candidate-category', 'entryType', 'expense'), icon: value('candidate-category', 'icon', 'tag'), color: value('candidate-category', 'color', '#8795A7') }), { resetForm: 'candidate-category' });
        state.notice = state.data ? `已新增候選測試大分類「${name}」；預算、提醒及偏好會讀取這份目錄。` : `已將「${name}」保存至隔離 v3 基準；升級後會保留相同分類 ID。`;
      }); return true;
    }
    if (action === 'add-candidate-subcategory') {
      await run(async () => {
        const categoryId = value('catalog', 'categoryId'); const name = value('catalog', 'subcategoryName').trim();
        if (!name || name.length > 40) throw new Error('請輸入 1–40 字的子分類名稱。');
        await saveCandidateCatalog((store) => store.addIndependentSubcategory(categoryId, name), { clearCatalogFields: ['subcategoryName', 'subcategoryId'] });
        state.notice = state.data ? `已新增子分類「${name}」；同一候選目錄中的選擇器已可使用。` : `已將子分類「${name}」保存至隔離 v3 基準；升級後會保留原始關聯。`;
      }); return true;
    }
    if (action === 'toggle-candidate-category' || action === 'toggle-candidate-subcategory' || action === 'unlink-candidate-subcategory') {
      await run(async () => {
        const categoryId = value('catalog', 'categoryId'); const subcategoryId = value('catalog', 'subcategoryId');
        await saveCandidateCatalog((store) => {
          if (action === 'toggle-candidate-category') {
            const category = activeCatalog()?.categories.find((item) => item.id === categoryId);
            return category && store.setCategoryHidden(categoryId, !category.hidden);
          }
          if (action === 'toggle-candidate-subcategory') {
            const subcategory = activeCatalog()?.subcategories.find((item) => item.id === subcategoryId);
            return subcategory && store.setSubcategoryHidden(subcategoryId, !subcategory.hidden);
          }
          return store.unlinkSubcategory(categoryId, subcategoryId);
        }, { clearCatalogFields: action === 'unlink-candidate-subcategory' ? ['subcategoryId'] : [] });
        state.notice = action === 'unlink-candidate-subcategory'
          ? (state.data ? '已解除候選子分類關聯。' : '已解除隔離 v3 測試子分類關聯。')
          : (state.data ? '候選分類狀態已更新；不會影響正式 v3 分類。' : '隔離 v3 測試分類狀態已更新。');
      }); return true;
    }
    if (action === 'choose-budget-category') {
      initializeBudgetDraft();
      const category = state.data.categoryCatalog[0].categories.find((item) => item.id === target.dataset.categoryId && item.entryType === 'expense' && !item.hidden);
      if (!category) { state.notice = '這個分類已不可使用，請重新選擇。'; onChange(); return true; }
      const draft = values('budget'); const childId = draft.subcategoryId || '';
        draft.categoryId = category.id;
      if (childId && !state.data.categoryCatalog[0].subcategories.some((item) => item.id === childId && !item.hidden && item.entryType === 'expense' && item.categoryIds.includes(category.id))) draft.subcategoryId = '';
      updateCategoryDraftWarning();
      repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'choose-budget-scope') {
      initializeBudgetDraft();
      const categoryId = value('budget', 'categoryId'); const childId = target.dataset.subcategoryId || '';
      if (childId) {
        const child = state.data.categoryCatalog[0].subcategories.find((item) => item.id === childId && !item.hidden && item.entryType === 'expense' && item.categoryIds.includes(categoryId));
        if (!child) { state.notice = '這個子分類與目前大分類不再相連，請重新選擇。'; onChange(); return true; }
      }
      values('budget').subcategoryId = childId; updateCategoryDraftWarning(); repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'choose-account-type') {
      const type = target.dataset.accountType;
      if (!['cash', 'bank'].includes(type)) return true;
      values('account').type = type;
      repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'choose-account-color') {
      values('account').color = target.dataset.accountColor || '';
      repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'choose-account-option') {
      const form = target.dataset.form; const field = target.dataset.field; const accountId = target.dataset.accountId || '';
      if (!['transfer', 'adjustment'].includes(form) || !['fromAccountId', 'toAccountId', 'accountId'].includes(field)) return true;
      if (accountId && !state.data.accounts.some((item) => item.id === accountId && item.active)) { state.notice = '已停用或不存在的帳戶不能使用。'; onChange(); return true; }
      values(form)[field] = accountId;
      if (form === 'transfer' && accountId && field === 'fromAccountId' && accountId === value(form, 'toAccountId')) values(form).toAccountId = '';
      if (form === 'transfer' && accountId && field === 'toAccountId' && accountId === value(form, 'fromAccountId')) values(form).fromAccountId = '';
      updateCategoryDraftWarning(); repaint(false, false); return true;
    }
    if (['choose-reminder-category', 'choose-reminder-subcategory', 'choose-reminder-account'].includes(action)) {
      const form = target.dataset.form;
      if (!['reminder', 'rule-edit', 'occ-edit'].includes(form)) return true;
      state.reminderAutoOpenPicker = null;
      const entryType = state.editingRule?.entryType || state.editingOccurrence?.entryType || value(form, 'entryType', 'expense');
      if (action === 'choose-reminder-category') {
        const category = state.data.categoryCatalog[0].categories.find((item) => item.id === target.dataset.categoryId && item.entryType === entryType && !item.hidden);
        if (!category) { state.notice = '這個大分類已不可使用，請重新選擇。'; onChange(); return true; }
        values(form).categoryId = category.id;
        const childId = value(form, 'subcategoryId', '');
        const child = state.data.categoryCatalog[0].subcategories.find((item) => item.id === childId && !item.hidden && item.entryType === entryType && item.categoryIds.includes(category.id));
        if (!child) values(form).subcategoryId = '';
        const hasAvailableSubcategory = state.data.categoryCatalog[0].subcategories.some((item) => !item.hidden && item.entryType === entryType && item.categoryIds.includes(category.id));
        state.reminderAutoOpenPicker = { form, picker: hasAvailableSubcategory ? 'is-subcategory' : 'is-account' };
      } else if (action === 'choose-reminder-subcategory') {
        const categoryId = value(form, 'categoryId', '');
        const child = state.data.categoryCatalog[0].subcategories.find((item) => item.id === target.dataset.subcategoryId && !item.hidden && item.entryType === entryType && item.categoryIds.includes(categoryId));
        if (!child) { state.notice = '這個子分類不再屬於目前大分類，請重新選擇。'; onChange(); return true; }
        values(form).subcategoryId = child.id;
        state.reminderAutoOpenPicker = { form, picker: 'is-account' };
      } else {
        const accountId = target.dataset.accountId || '';
        if (accountId && !state.data.accounts.some((item) => item.id === accountId && item.active)) { state.notice = '已停用帳戶不能設為記帳預設。'; onChange(); return true; }
        values(form).accountId = accountId;
      }
      updateCategoryDraftWarning(); repaint(false, false); return true;
    }
    if (action === 'choose-preference') {
      const field = target.dataset.choiceField; const choice = target.dataset.choiceValue || '';
      if (field === 'defaultEntryType' && !['expense', 'income'].includes(choice)) return true;
      if (field === 'dateMode' && !['today', 'last-entry'].includes(choice)) return true;
      if (field === 'preferredAccountId' && choice && !state.data.accounts.some((item) => item.id === choice && item.active)) { state.notice = '已停用帳戶不能設為通用預設。'; onChange(); return true; }
      if (field === 'preferredAccountEntryType' && !['expense', 'income'].includes(choice)) return true;
      if (field === 'preferredAccountId') {
        const form = values('preferences'); const type = value('preferences', 'preferredAccountEntryType', 'expense');
        const saved = state.data.financePreferences[0].entryPreferences || {};
        const map = form.preferredAccountIds || structuredClone(saved.preferredAccountIds || { expense: saved.preferredAccountId || '', income: saved.preferredAccountId || '' });
        map[type] = choice; form.preferredAccountIds = map;
      } else if (['defaultEntryType', 'dateMode', 'preferredAccountEntryType'].includes(field)) values('preferences')[field] = choice;
      if (['defaultEntryType', 'dateMode', 'preferredAccountId', 'preferredAccountEntryType'].includes(field)) repaint(false, false, { financeFocus: true });
      return true;
    }
    if (action === 'choose-default-type') {
      const entryType = target.dataset.entryType;
      if (!['expense', 'income'].includes(entryType)) return true;
      const categories = state.data.categoryCatalog[0].categories.filter((item) => item.entryType === entryType && !item.hidden);
      const prior = categories.find((item) => item.id === value('default', 'categoryId')) || categories[0];
      values('default').entryType = entryType; values('default').categoryId = prior?.id || '';
      updateCategoryDraftWarning(); repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'choose-default-category') {
      const category = state.data.categoryCatalog[0].categories.find((item) => item.id === target.dataset.categoryId && item.entryType === value('default', 'entryType', 'expense') && !item.hidden);
      if (!category) { state.notice = '這個分類已不可使用，請重新選擇。'; onChange(); return true; }
      values('default').categoryId = category.id;
      updateCategoryDraftWarning(); repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'choose-default-account') {
      const accountId = target.dataset.accountId || '';
      if (accountId && !state.data.accounts.some((item) => item.id === accountId && item.active)) { state.notice = '已停用帳戶不能設為分類預設。'; onChange(); return true; }
      const categoryId = value('default', 'categoryId', state.data.categoryCatalog[0].categories.find((item) => item.entryType === value('default', 'entryType', 'expense') && !item.hidden)?.id || '');
      const entryType = value('default', 'entryType', 'expense');
      const key = defaultDraftKey(categoryId, entryType);
      if (accountId === savedDefaultAccount(categoryId, entryType)) state.categoryDefaultDrafts.delete(key);
      else state.categoryDefaultDrafts.set(key, { categoryId, entryType, accountId });
      updateCategoryDraftWarning(); repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'delete-budget') {
      const rule = [...(state.data.financePreferences[0].budgetSchedules || []), ...(state.data.financePreferences[0].budgetOverrides || [])].find((item) => item.id === target.dataset.budgetId);
      if (!rule) { state.notice = '預算已更新，請重新讀取。'; onChange(); return true; }
      const catalog = state.data.categoryCatalog[0];
      state.deleteBudget = { id: rule.id, revision: state.data.financePreferences[0].revision, name: `${catalog.categories.find((item) => item.id === rule.categoryId)?.name || '分類'}${rule.subcategoryId ? ` · ${catalog.subcategories.find((item) => item.id === rule.subcategoryId)?.name || '子分類'}` : ''}`, schedule: Boolean(rule.effectiveFromMonth), scope: rule.effectiveFromMonth ? `從 ${rule.effectiveFromMonth} 開始的每月排程` : `${rule.month} 的預算` };
      onChange({ preserveScroll: true, focusBudgetDeleteCancel: true }); return true;
    }
    if (action === 'cancel-delete-budget') { const budgetId = state.deleteBudget?.id; state.deleteBudget = null; onChange({ preserveScroll: true, focusBudgetDeleteId: budgetId }); return true; }
    if (action === 'disconnect') { publishData(null, 'disconnect'); state.values = {}; state.keys = {}; state.posting = null; state.preview = null; state.deleteBudget = null; state.deleteAccount = null; state.editingAccount = null; state.editingRule = null; state.editingOccurrence = null; state.expandedReminderRules.clear(); saveExpandedReminderRules(); state.notice = '已離開，合成資料保留在獨立資料庫。'; onChange(); return true; }
    if (action === 'edit-account') { reset('account'); state.editingAccount = structuredClone(state.data.accounts.find((item) => item.id === id)); state.accountView = 'account'; repaint(false, false, { accountViewFocus: 'account' }); return true; }
    if (action === 'cancel-account-edit') { reset('account'); state.editingAccount = null; state.accountView = ''; onChange(); return true; }
    if (action === 'delete-account') {
      const item = state.data.accounts.find((account) => account.id === id);
      if (!item) { state.notice = '找不到這個帳戶，請重新讀取。'; onChange(); return true; }
      state.deleteAccount = { id: item.id, name: item.name, revision: item.revision, active: item.active, balanceTwd: accountBalances(state.data).get(item.id) || 0n, confirmStep: 1, blockReason: accountDeletionBlockReason(state.data, item.id) };
      repaint(false, false, { financeFocus: true }); return true;
    }
    if (action === 'toggle-inactive-accounts') { state.accountManagementMode = !state.accountManagementMode; onChange({ preserveScroll: true }); return true; }
    if (action === 'cancel-delete-account') { state.deleteAccount = null; onChange(); return true; }
    if (action === 'edit-budget') {
      const month = value('budget', 'month', today().slice(0, 7));
      if (!isValidBudgetMonth(month)) { state.notice = '請先選擇有效月份。'; onChange(); return true; }
      const row = calculateMonthlyBudgets(state.data, month).find((item) => item.id === target.dataset.budgetId);
      const rule = [...(state.data.financePreferences[0].budgetOverrides || []), ...(state.data.financePreferences[0].budgetSchedules || [])].find((item) => item.id === row?.id);
      if (!row || !rule) { state.notice = '這項預算已更新或不存在，請重新讀取後再修改。'; onChange(); return true; }
      state.values.budget = { month, categoryId: row.categoryId, subcategoryId: row.subcategoryId || '', amountTwd: String(rule.amountTwd), applyFuture: 'false' };
      repaint(false, false, { financeFocus: true });
      return true;
    }
    if (action === 'edit-rule' || action === 'edit-occurrence') { const rule = action === 'edit-rule' ? state.data.reminderRules.find((item) => item.id === id) : null; const occurrence = action === 'edit-occurrence' ? state.data.reminderOccurrences.find((item) => item.id === id) : null; if (rule || occurrence) { const sourceRule = occurrence && state.data.reminderRules.find((item) => item.id === occurrence.ruleId); openReminderEditor({ rule: rule ? structuredClone(rule) : null, occurrence: occurrence ? { ...structuredClone(occurrence), entryDefaults: { ...(sourceRule?.entryDefaults || {}), ...(occurrence.entryDefaults || {}) } } : null }); } repaint(false, false, { financeFocus: true }); return true; }
    if (action === 'cancel-reminder-edit') { cacheReminderDraft(); state.editingRule = null; state.editingOccurrence = null; if (state.reminderDrafts.has('new')) state.values.reminder = structuredClone(state.reminderDrafts.get('new')); onChange(); return true; }
    if (action === 'review-occurrence') { cacheReminderDraft(); const occurrence = state.data.reminderOccurrences.find((item) => item.id === id); if (!occurrence || occurrence.status !== 'pending') { state.notice = '這一期已更新或不再待處理，請重新讀取。'; onChange(); return true; } const rule = state.data.reminderRules.find((item) => item.id === occurrence.ruleId); const defaults = { ...(rule?.entryDefaults || {}), ...(occurrence.entryDefaults || {}) }; state.posting = { ...structuredClone(occurrence), entryDefaults: structuredClone(defaults) }; state.postingPath = 'new'; state.editingRule = null; state.editingOccurrence = null; if (state.reminderDrafts.has('new')) state.values.reminder = structuredClone(state.reminderDrafts.get('new')); state.values.entry = { entryType: occurrence.entryType, categoryId: defaults.categoryId || '', subcategoryId: defaults.subcategoryId || '', amountTwd: String(occurrence.amountTwd), date: today(), accountId: defaults.accountId || '', paymentMethod: defaults.paymentMethod || 'direct', note: `${occurrence.name}${occurrence.note ? ` · ${occurrence.note}` : ''}`.slice(0, 160) }; reset('link'); repaint(false, false, { financeFocus: true }); return true; }
    if (action === 'cancel-posting') { state.posting = null; reset('entry'); onChange(); return true; }
    if (action === 'account-view') { if (state.editingAccount) reset('account'); state.accountView = target.dataset.view; state.editingAccount = null; repaint(false, false, { accountViewFocus: state.accountView }); return true; }
    if (action === 'close-operation') { if (state.editingAccount) reset('account'); state.accountView = ''; state.editingAccount = null; onChange(); return true; }
    if (action === 'new-reminder') { openReminderEditor(); repaint(false, false, { financeFocus: true }); return true; }
    if (action === 'toggle-cancelled') { state.showCancelled = !state.showCancelled; onChange(); return true; }
    if (action === 'toggle-reminder-rule') {
  const occurrencesPanel = target.closest?.('.finance-reminder-rule-group')?.querySelector?.('.finance-reminder-rule-occurrences');
  if (state.expandedReminderRules.has(id)) state.expandedReminderRules.delete(id);
  else state.expandedReminderRules.add(id);
  saveExpandedReminderRules();
  onChange({ reminderRuleTransition: {
    ruleId: id,
    expanded: state.expandedReminderRules.has(id),
    fromHeight: occurrencesPanel?.getBoundingClientRect?.().height ?? 0,
  } });
  return true;
}
    if (action === 'request-stop-rule') {
      const rule = state.data.reminderRules.find((row) => row.id === id);
      if (!rule || !rule.active) { state.notice = '這項提醒已更新，請重新讀取後再操作。'; onChange(); return true; }
      state.stopRule = { id: rule.id, name: rule.name, revision: rule.revision };
      state.deleteRule = null;
      state.notice = '';
      repaint(false, false, { financeFocus: true });
      return true;
    }
    if (action === 'cancel-stop-rule') { state.stopRule = null; state.notice = ''; onChange(); return true; }
    if (action === 'confirm-stop-rule') {
      const pending = state.stopRule;
      if (!pending) return true;
      await run(async () => {
        await execute({ kind: 'cancel-reminder', ruleId: pending.id, expectedRevision: pending.revision });
        state.stopRule = null;
        state.notice = '已停止後續提醒；已完成的歷史收支、帳戶異動和交易關聯均保留。';
      });
      return true;
    }
    if (action === 'choose-reminder-type') {
      if (state.editingRule || state.editingOccurrence) return true;
      const nextType = target.dataset.entryType;
      if (!['expense', 'income'].includes(nextType)) return true;
      const form = 'reminder';
      if (value(form, 'entryType', 'expense') !== nextType) {
        values(form).entryType = nextType;
        values(form).categoryId = '';
        values(form).subcategoryId = '';
      }
      state.reminderDrafts.set('new', structuredClone(values(form)));
      onChange({ preserveScroll: true }); return true;
    }
    if (action === 'posting-new' || action === 'posting-existing') { if (state.posting?.status === 'pending') { state.postingPath = action === 'posting-new' ? 'new' : 'existing'; repaint(false, false, { financeFocus: true }); } return true; }
    if (action === 'delete-rule') {
      const item = state.data.reminderRules.find((row) => row.id === id);
      if (item) {
        const occurrences = state.data.reminderOccurrences.filter((row) => row.ruleId === id);
        const records = [...state.data.expenses, ...state.data.incomes];
        const linkedCount = occurrences.filter((row) => row.status === 'completed' || row.entryId || records.some((record) => record.reminderOccurrenceId === row.id)).length;
        state.deleteRule = { ...structuredClone(item), count: occurrences.length, linkedCount };
        repaint(false, false, { financeFocus: true });
      }
      return true;
    }
    if (action === 'cancel-delete-rule') { state.deleteRule = null; onChange(); return true; }
    if (action === 'undo-occurrence') {
      const occurrence = state.data.reminderOccurrences.find((row) => row.id === id && row.status === 'completed');
      if (!occurrence) { state.notice = '這一期已更新，請重新讀取後再操作。'; onChange(); return true; }
      const record = state.data[occurrence.entryType === 'income' ? 'incomes' : 'expenses'].find((row) => row.id === occurrence.entryId);
      if (!record) { state.notice = '找不到此期關聯的收支，無法安全撤銷。'; onChange(); return true; }
      state.undoOccurrence = { occurrence: structuredClone(occurrence), record: structuredClone(record) };
      repaint(false, false, { financeFocus: true });
      return true;
    }
    if (action === 'cancel-undo-occurrence') { state.undoOccurrence = null; onChange(); return true; }
    if (action === 'cancel-restore-final') { state.finalRestoreDialog = false; state.notice = '已取消匯入，資料未變更。'; onChange(); return true; }
    if (action === 'cancel-reset-confirmation') { state.resetDialog = false; state.notice = '已取消恢復初始狀態，資料未變更。'; onChange(); return true; }
    if (action === 'open-recovery-undo') { state.recoveryDialog = Boolean(state.recoveryPoint); reset('recovery'); onChange({ financeFocus: true }); return true; }
    if (action === 'cancel-recovery-undo') { state.recoveryDialog = false; reset('recovery'); onChange(); return true; }
    if (action === 'cancel-restore') { state.finalRestoreDialog = false; state.preview = null; state.token = ''; state.restoreBackupReadyToken = ''; state.selectedBackupName = ''; state.backupValidationStatus = ''; reset('restore'); onChange({ preserveScroll: true }); return true; }
    if (action === 'restore') {
      const importMode = selectedImportMode();
      const phrase = importMode === 'merge' ? (mode === 'acceptance' ? '加入合成資料' : '加入新資料') : mode === 'official' ? '完整還原' : '還原合成資料';
      if (!state.preview || value('restore', 'confirmation') !== phrase) { state.notice = `請先驗證檔案並輸入「${phrase}」。`; onChange(); return true; }
      if (value('restore', 'backupSaved') !== 'true' || state.restoreBackupReadyToken !== state.token) { state.notice = '請先下載目前資料的完整備份，確認已保存後再繼續。'; onChange(); return true; }
      await run(async () => {
        const current = await repository.read();
        if (financeSnapshotToken(current) !== state.token) {
          state.preview = null; state.token = ''; reset('restore');
          throw new Error('預覽後資料已變更，已取消還原；請重新選取備份並檢查摘要。');
        }
        state.finalRestoreDialog = true;
        state.notice = '資料版本及備份摘要仍相符；請在中央確認視窗再次確認。';
      }, { focusRestoreDialog: true });
      return true;
    }
    if (action === 'confirm-delete-account') {
      const pending = state.deleteAccount;
      if (!pending || pending.blockReason) { state.notice = '刪除預覽已失效；請重新檢查帳戶。'; onChange(); return true; }
      if (pending.confirmStep !== 2) { pending.confirmStep = 2; onChange({ financeFocus: true }); return true; }
    }
    await run(async () => {
      if (action === 'confirm-recovery-undo') {
        if (!state.recoveryDialog || value('recovery', 'confirmation') !== '復原上一個操作' || !state.recoveryPoint) throw new Error('復原確認已失效，資料沒有變更。');
        const actionName = { reset: '恢復初始狀態', replace: '覆蓋匯入備份', merge: '加入匯入備份' }[state.recoveryPoint.action] || '上一個資料操作';
        const restored = await repository.undoLastOperation(financeSnapshotToken(state.data), { confirmation: '復原上一個操作' });
        publishData(restored, 'undo-destructive-operation');
        const preferenceNotice = restoreFinanceDisplayPreferences(state.recoveryPoint.displayPreferences);
        state.recoveryPoint = null; state.recoveryDialog = false; reset('recovery');
        state.notice = `已復原「${actionName}」前的資料。${preferenceNotice ? ` ${preferenceNotice}` : ''}`;
      } else if (action === 'confirm-delete-account') {
        const pending = state.deleteAccount;
        if (!pending || pending.blockReason || pending.confirmStep !== 2) throw new Error('刪除預覽已失效；請重新檢查帳戶。');
        try {
          await execute({ kind: 'delete-account', accountId: pending.id, expectedRevision: pending.revision, confirmed: true });
          if (state.editingAccount?.id === pending.id) { reset('account'); state.editingAccount = null; state.accountView = ''; }
          state.deleteAccount = null; state.notice = `已刪除帳戶「${pending.name}」及其起始異動（${money(pending.balanceTwd)}）。`;
        } catch (error) {
          try { publishData(await repository.read(), 'delete-conflict'); } catch { /* Keep the last verified snapshot and require an explicit reload. */ }
          const current = state.data.accounts.find((item) => item.id === pending.id);
          state.deleteAccount = current ? { id: current.id, name: current.name, revision: current.revision, active: current.active, balanceTwd: accountBalances(state.data).get(current.id) || 0n, confirmStep: 1, blockReason: accountDeletionBlockReason(state.data, current.id) || '資料已變更，請重新讀取後確認是否仍可刪除。' } : null;
          throw error;
        }
      } else if (action === 'disable-account-from-delete') {
        const item = state.data.accounts.find((account) => account.id === state.deleteAccount?.id);
        if (!item) throw new Error('帳戶已不存在，請重新讀取。');
        await execute({ kind: 'edit-account', accountId: item.id, expectedRevision: item.revision, name: item.name, active: false });
        state.deleteAccount = null; state.notice = `已停用「${item.name}」；帳戶異動與歷史記錄均保留。`;
      } else if (action === 'reset-acceptance') {
        if (!localRecoveryEnabled) throw new Error('目前資料環境尚未開放恢復初始狀態。');
        if (!state.data || value('reset', 'backupSaved') !== 'true' || value('reset', 'confirmation') !== '恢復初始狀態') throw new Error('請先下載並確認現況備份，再輸入「恢復初始狀態」。');
        const current = await repository.read();
        if (!state.resetExportedToken || financeSnapshotToken(current) !== state.resetExportedToken) throw new Error('備份後資料已變更；請重新下載備份並重新確認。');
        publishData(current, 'reset-preview'); state.resetDialog = true; state.notice = '資料版本與備份仍相符；請在中央視窗再次確認。';
      } else if (action === 'confirm-reset-acceptance') {
        if (!localRecoveryEnabled || !state.resetDialog || value('reset', 'backupSaved') !== 'true' || value('reset', 'confirmation') !== '恢復初始狀態') throw new Error('恢復初始狀態確認已失效；資料未變更。');
        const resetData = await repository.resetAcceptance(state.resetExportedToken, { confirmation: mode === 'acceptance' ? '重設合成資料' : OFFICIAL_FINANCE_ENABLED ? '重設正式記帳資料' : '重設預覽資料', backupSaved: true, displayPreferences: captureFinanceDisplayPreferences() });
        publishData(resetData, 'reset'); state.resetExportedToken = ''; state.resetDialog = false; reset('reset');
        state.recoveryPoint = localRecoveryEnabled ? await repository.getRecoveryPoint() : null;
        const preferenceNotice = clearFinanceDisplayPreferences();
        state.notice = `目前記帳資料已恢復為首次使用狀態；內建分類與設定已重新建立，沒有新增帳戶或交易。${preferenceNotice ? ` ${preferenceNotice}` : '本環境專屬排序偏好已重設；共用的總覽排列與操作提示偏好保留。'}`;
        return;
      }
      if (action === 'reload') { publishData(await repository.read(), 'refresh'); await refreshPeriods(); state.recoveryPoint = localRecoveryEnabled ? await repository.getRecoveryPoint() : null; state.notice = '已從資料庫重新讀取；沒有依賴先前畫面重建資料。'; return; }
      if (action === 'save-account') {
        const edit = state.editingAccount;
        await execute(edit ? { kind: 'edit-account', accountId: edit.id, expectedRevision: edit.revision, name: value('account', 'name', edit.name), active: edit.active, color: value('account', 'color', edit.color || (edit.type === 'bank' ? '#718AA5' : '#C39451')) } : { kind: 'create-account', idempotencyKey: key('account'), name: value('account', 'name'), type: value('account', 'type', 'cash'), color: value('account', 'color', value('account', 'type', 'cash') === 'bank' ? '#718AA5' : '#C39451'), openingTwd: value('account', 'openingTwd', '0'), date: value('account', 'date', today()) }, 'account'); state.editingAccount = null;
      } else if (action === 'toggle-account') {
        const item = state.data.accounts.find((account) => account.id === id);
        await execute({ kind: 'edit-account', accountId: id, expectedRevision: item.revision, name: item.name, active: !item.active });
      } else if (action === 'save-default') {
        const updates = [...state.categoryDefaultDrafts.values()];
        if (!updates.length) throw new Error('目前沒有尚未保存的分類預設變更。');
        await execute({ kind: 'set-defaults', updates, expectedRevision: state.data.financePreferences[0].revision });
        state.categoryDefaultDrafts.clear();
        state.notice = `已一次保存 ${updates.length} 個分類的預設帳戶。`;
      } else if (action === 'save-preferences') {
        const saved = state.data.financePreferences[0].entryPreferences || {};
        const typedDefaults = value('preferences', 'preferredAccountIds', saved.preferredAccountIds || { expense: saved.preferredAccountId || '', income: saved.preferredAccountId || '' });
        await execute({ kind: 'set-entry-preferences', defaultEntryType: value('preferences', 'defaultEntryType', saved.defaultEntryType || 'expense'), dateMode: value('preferences', 'dateMode', saved.dateMode || 'today'), preferredAccountId: '', preferredAccountIds: typedDefaults, expectedRevision: state.data.financePreferences[0].revision }, 'preferences');
      } else if (action === 'save-catalog') {
        if (mode !== 'acceptance') throw new Error('分類驗收操作只允許使用隔離合成資料。');
        const category = activeCatalog()?.categories.find((item) => item.id === value('catalog', 'categoryId'));
        const name = value('catalog', 'name').trim();
        if (!category || !name || name.length > 40) throw new Error('請選擇分類並輸入 1–40 字名稱。');
        await saveCandidateCatalog((store) => store.updateCategory(category.id, { name }));
        state.notice = state.data ? `已更新候選測試分類名稱「${name}」。` : `已更新隔離 v3 測試分類名稱「${name}」。`;
      } else if (action === 'confirm-delete-budget') {
        if (!state.deleteBudget) throw new Error('請先檢查刪除內容。');
        await execute({ kind: 'delete-budget', budgetId: state.deleteBudget.id, expectedRevision: state.deleteBudget.revision, confirmed: true });
        state.deleteBudget = null; state.notice = '預算設定已刪除；正式交易沒有變更。';
      } else if (action === 'save-budget') {
        const amount = value('budget', 'amountTwd');
        const categoryId = value('budget', 'categoryId', state.data.categoryCatalog[0].categories.find((item) => item.entryType === 'expense' && !item.hidden)?.id || '');
        const subcategoryId = value('budget', 'subcategoryId');
        const hasFutureDefault = state.data.financePreferences[0].budgetSchedules?.some((item) => item.categoryId === categoryId && (item.subcategoryId || '') === subcategoryId);
        await execute({ kind: 'set-budget', categoryId, subcategoryId, month: value('budget', 'month', today().slice(0, 7)), amountTwd: amount === '' ? NaN : Number(amount), applyFuture: value('budget', 'applyFuture', hasFutureDefault ? 'false' : 'true') === 'true', expectedRevision: state.data.financePreferences[0].revision });
        delete values('budget').amountTwd;
      } else if (action === 'record') {
        if (state.posting && state.postingPath !== 'new') throw new Error('請先選擇「尚未記帳」。');
        const wasPosting = Boolean(state.posting); const postingType = state.posting?.entryType;
        const entryType = value('entry', 'entryType', state.posting?.entryType || state.data.financePreferences[0].entryPreferences?.defaultEntryType || 'expense');
        const categoryId = value('entry', 'categoryId', state.posting?.entryDefaults?.categoryId || '');
        const subcategoryId = value('entry', 'subcategoryId', state.posting?.entryDefaults?.subcategoryId || '');
        const amountTwd = value('entry', 'amountTwd', state.posting?.amountTwd || '');
        const accountId = value('entry', 'accountId', state.posting?.entryDefaults?.accountId || resolveDefaultAccount(state.data, entryType, categoryId));
        const catalog = state.data.categoryCatalog[0];
        const category = catalog.categories.find((item) => item.id === categoryId && item.entryType === entryType && !item.hidden);
        const subcategory = catalog.subcategories.find((item) => item.id === subcategoryId && item.entryType === entryType && !item.hidden && item.categoryIds.includes(categoryId));
        if (!category) throw new Error('請選擇仍有效的大分類。');
        if (!subcategory) throw new Error('請選擇仍有效且屬於此大分類的子分類。');
        if (!/^\d+$/.test(String(amountTwd)) || Number(amountTwd) <= 0 || !Number.isSafeInteger(Number(amountTwd))) throw new Error('請輸入大於 0 的整數元金額。');
        if (!accountId || !state.data.accounts.some((item) => item.id === accountId && item.active)) throw new Error('請選擇一個使用中的資金帳戶；提醒不會自動替你指定帳戶。');
        const recorded = await execute({ kind: 'record', idempotencyKey: key('entry'), entryType, categoryId, subcategoryId, amountTwd, date: value('entry', 'date', today()), note: value('entry', 'note', state.posting ? `${state.posting.name}${state.posting.note ? ' · ' + state.posting.note : ''}`.slice(0, 160) : ''), accountId, paymentMethod: value('entry', 'paymentMethod', state.posting?.entryDefaults?.paymentMethod || 'direct'), ...(state.posting ? { reminderOccurrenceId: state.posting.id, expectedOccurrenceRevision: state.posting.revision } : {}) }, 'entry'); state.posting = null; state.notice = wasPosting ? `${recorded.status === 'duplicate' ? '提醒先前已處理，這次沒有新增交易' : `已完成提醒：新增了 1 筆${postingType === 'income' ? '收入' : '支出'}及對應帳戶異動`}${mode === 'official' ? '。正式資料已保存。' : '。只寫入隔離測試資料，正式日常資料未變更。'}${recorded.warnings.join(' ')}` : state.notice;
      } else if (action === 'transfer') await execute({ ...values('transfer'), kind: 'transfer', date: value('transfer', 'date', today()), idempotencyKey: key('transfer') }, 'transfer');
      else if (action === 'adjustment') await execute({ ...values('adjustment'), kind: 'adjustment', date: value('adjustment', 'date', today()), idempotencyKey: key('adjustment'), expectedBalanceTwd: String(accountBalances(state.data).get(value('adjustment', 'accountId'))) }, 'adjustment');
      else if (action === 'save-reminder') {
        const edit = state.editingRule; const occurrence = state.editingOccurrence; const form = edit ? 'rule-edit' : occurrence ? 'occ-edit' : 'reminder';
        const common = { name: value(form, 'name', edit?.name || occurrence?.name || ''), amountTwd: value(form, 'amountTwd', edit?.amountTwd || occurrence?.amountTwd || ''), note: value(form, 'note', edit?.note || occurrence?.note || ''), advanceDays: Number(value(form, 'advanceDays', edit?.advanceDays ?? 1)) };
        const entryType = edit?.entryType || occurrence?.entryType || value(form, 'entryType', 'expense');
        const defaults = { categoryId: value(form, 'categoryId', baseReminderDefaults(edit, occurrence).categoryId), subcategoryId: value(form, 'subcategoryId', baseReminderDefaults(edit, occurrence).subcategoryId), accountId: value(form, 'accountId', baseReminderDefaults(edit, occurrence).accountId), paymentMethod: value(form, 'paymentMethod', baseReminderDefaults(edit, occurrence).paymentMethod) };
        const billSchedule = value(form, 'billMonthsBeforeDue', '') === '' && value(form, 'billDay', '') === '' ? null : { monthsBeforeDue: Number(value(form, 'billMonthsBeforeDue', 0)), day: Number(value(form, 'billDay', 1)) };
        const billDate = value(form, 'billDate', edit?.billDate || occurrence?.billDate || '');
        const command = edit
          ? { ...common, kind: 'edit-reminder', ruleId: edit.id, expectedRevision: edit.revision, entryDefaults: defaults, billDate: billDate || undefined, billSchedule: billSchedule || undefined, applyFuture: value(form, 'applyFuture', 'true') === 'true' }
          : occurrence
            ? { ...common, kind: 'edit-occurrence', occurrenceId: occurrence.id, expectedRevision: occurrence.revision, date: value(form, 'date', occurrence.dueDate), entryDefaults: defaults, billDate }
            : { ...common, kind: 'create-reminder', idempotencyKey: key(form), date: value(form, 'date', today()), entryType, repeat: value(form, 'repeat', 'once'), entryDefaults: defaults, ...(value(form, 'repeat', 'once') === 'once' ? { billDate } : { billSchedule }) };
        await execute(command, form); state.reminderDrafts.delete(edit ? `rule:${edit.id}` : occurrence ? `occ:${occurrence.id}` : 'new'); state.editingRule = null; state.editingOccurrence = null;
      } else if (action === 'link-existing') {
        if (!state.posting || state.postingPath !== 'existing') throw new Error('請先選擇「已經自行記帳」。');
        await execute({ kind: 'link-reminder', occurrenceId: state.posting.id, expectedRevision: state.posting.revision, entryId: value('link', 'entryId'), confirmed: true }, 'link');
        state.posting = null; state.notice = '提醒已完成：已關聯既有交易，沒有新增收支，也沒有再次扣款或入帳。';
      } else if (action === 'confirm-delete-rule') {
        if (!state.deleteRule) throw new Error('請先預覽刪除內容。');
        const preservesHistory = state.deleteRule.linkedCount > 0;
        await execute({ kind: 'delete-reminder', ruleId: state.deleteRule.id, expectedRevision: state.deleteRule.revision, expectedOccurrences: state.deleteRule.count, preserveTransactions: preservesHistory, confirmed: true }); state.deleteRule = null; state.notice = preservesHistory ? '提醒已刪除，歷史收支與帳戶異動均保留。' : '提醒與未入帳期次已刪除，既有資料未變更。';
      } else if (action === 'confirm-undo-occurrence') {
        const pending = state.undoOccurrence;
        if (!pending) throw new Error('請先檢查要撤銷的期次。');
        const { occurrence, record } = pending;
        await execute({ kind: 'undo-reminder-payment', occurrenceId: occurrence.id, expectedRevision: occurrence.revision, entryId: record.id, expectedCompletionMode: occurrence.completionMode || 'created', confirmed: true });
        state.undoOccurrence = null;
        state.notice = occurrence.completionMode === 'linked'
          ? '已撤銷本期提醒關聯；原本的歷史收支及帳戶異動都保留。'
          : '已撤銷本期付款，並原子移除由提醒建立的收支及帳戶影響；期次可重新確認。';
      } else if (action === 'cancel-occurrence') {
        const item = state.data.reminderOccurrences.find((row) => row.id === id);
        if (!item) throw new Error('這一期提醒已更新，請重新讀取後再操作。');
        await execute({ kind: 'cancel-occurrence', occurrenceId: id, expectedRevision: item.revision });
      } else if (action === 'refresh-reminders') { await execute({ kind: 'refresh-reminders' }); state.recoveryPoint = localRecoveryEnabled ? await repository.getRecoveryPoint() : null; }
      else if (action === 'export') {
        const data = await repository.read(); const backup = await createFinanceBackup(data);
        const filename = downloadFinanceBackup(backup);
        state.notice = `已開始下載「${filename}」；請確認檔案已保存。這是未加密的本機記帳備份。`;
        if (localRecoveryEnabled) { state.resetExportedToken = financeSnapshotToken(data); reset('reset'); }
      } else if (action === 'export-before-restore') {
        if (!state.preview || !state.token) throw new Error('請先選擇並驗證要匯入的備份檔。');
        const current = await repository.read(); const currentToken = financeSnapshotToken(current);
        if (currentToken !== state.token) {
          state.preview = null; state.token = ''; state.restoreBackupReadyToken = ''; reset('restore');
          throw new Error('備份預覽後資料已變更。為保護最新資料，請重新選擇待匯入備份。');
        }
        const backup = await createFinanceBackup(current); const filename = downloadFinanceBackup(backup);
        state.restoreBackupReadyToken = currentToken;
        state.notice = `已開始下載目前資料備份「${filename}」。請確認檔案已保存，再勾選確認。`;
      } else if (action === 'confirm-restore-final') {
        const importMode = selectedImportMode();
        const phrase = importMode === 'merge' ? (mode === 'acceptance' ? '加入合成資料' : '加入新資料') : mode === 'official' ? '完整還原' : '還原合成資料';
        if (!state.finalRestoreDialog || !state.preview || value('restore', 'confirmation') !== phrase || value('restore', 'backupSaved') !== 'true' || state.restoreBackupReadyToken !== state.token) throw new Error('匯入確認或現況備份已失效；請重新檢查備份摘要並保存目前資料。');
        const previousToken = state.token;
        const restored = mode === 'official'
          ? await repository.restoreOfficial(state.preview.data, state.token, { formatVersion: state.preview.formatVersion, importMode })
          : await repository.restoreAcceptance(state.preview.data, state.token, { formatVersion: state.preview.formatVersion, importMode });
        const importChanged = financeSnapshotToken(restored) !== previousToken;
        publishData(restored, 'restore'); state.preview = null; state.token = ''; state.restoreBackupReadyToken = ''; state.finalRestoreDialog = false; state.selectedBackupName = ''; state.backupValidationStatus = ''; reset('restore'); state.posting = null; state.editingAccount = null; state.editingRule = null; state.editingOccurrence = null; state.values = {}; state.keys = {};
        state.recoveryPoint = localRecoveryEnabled ? await repository.getRecoveryPoint() : null;
        if (importMode === 'merge') {
          if (!importChanged) state.notice = '備份資料都已存在，沒有變更目前資料。';
          else if (localRecoveryEnabled) state.notice = `已加入${mode === 'acceptance' ? '合成' : developmentPreviewActive ? '預覽' : '正式'}備份；相同資料已略過，操作前資料可在本機復原。`;
          else state.notice = '已加入備份資料；原有資料未被覆蓋。若要回到操作前狀態，請使用剛保存的備份完整覆蓋匯入。';
        } else if (mode === 'official') state.notice = `${developmentPreviewActive ? 'V4 開發預覽' : 'V5 正式記帳'}資料已完整還原；請重新檢查帳戶、分類、提醒與收支。`;
        else state.notice = `${mode === 'acceptance' ? '合成驗收區' : '開發預覽'}已完整覆蓋匯入；${localRecoveryEnabled ? '操作前資料可在本機復原。' : '請保留匯入前下載的備份。'}`;
      }
    }, {
      preserveScroll: ['export', 'export-before-restore', 'confirm-delete-budget', 'save-account', 'transfer', 'adjustment'].includes(action),
      focusBudgetEditor: action === 'confirm-delete-budget',
      focusResetDialog: action === 'reset-acceptance',
    });
    return true;
  }
  function handleInput(target) {
    const form = target?.dataset?.financeForm; const field = target?.dataset?.financeField;
    if (!form || !field) return false;
    if (state.busy) return true;
    values(form)[field] = target.type === 'checkbox' ? String(target.checked) : target.value;
    if (['reminder', 'rule-edit', 'occ-edit'].includes(form)) state.reminderDrafts.set(reminderDraftKey(), structuredClone(values(form)));
    updateCategoryDraftWarning();
    const refreshField = () => onChange({ field: { form, field } });
    if (form === 'entry' && field === 'entryType') { values(form).categoryId = ''; values(form).subcategoryId = ''; values(form).accountId = ''; refreshField(); }
    if (form === 'entry' && field === 'categoryId') { values(form).subcategoryId = ''; values(form).accountId = resolveDefaultAccount(state.data, value(form, 'entryType', state.posting?.entryType || 'expense'), target.value); refreshField(); }
    if (form === 'link' && field === 'entryId') refreshField();
    if (form === 'default' && field === 'categoryId') refreshField();
    if (form === 'catalog' && ['categoryId', 'subcategoryId'].includes(field)) refreshField();
    if (form === 'budget' && field === 'categoryId') {
      const catalog = state.data?.categoryCatalog?.[0]; const childId = value(form, 'subcategoryId', '');
      if (childId && !catalog?.subcategories.some((item) => item.id === childId && !item.hidden && item.entryType === 'expense' && item.categoryIds.includes(target.value))) values(form).subcategoryId = '';
      refreshField();
    }
    if (form === 'budget' && ['month', 'categoryId', 'subcategoryId', 'applyFuture'].includes(field)) refreshField();
    if (['restore', 'reset', 'recovery'].includes(form)) refreshField();
    if (['reminder', 'rule-edit', 'occ-edit'].includes(form) && field === 'entryType') { values(form).categoryId = ''; values(form).subcategoryId = ''; refreshField(); }
    if (['reminder', 'rule-edit', 'occ-edit'].includes(form) && field === 'categoryId') {
      const entryType = state.editingRule?.entryType || state.editingOccurrence?.entryType || value(form, 'entryType', 'expense');
      const childId = value(form, 'subcategoryId', '');
      const validChild = state.data?.categoryCatalog?.[0]?.subcategories.find((item) => item.id === childId && !item.hidden && item.entryType === entryType && item.categoryIds.includes(target.value));
      if (!validChild) values(form).subcategoryId = '';
      refreshField();
    }
    if (form === 'reminder' && field === 'repeat') refreshField();
    updateCategoryDraftWarning();
    return true;
  }
  async function file(target) {
    if (!target?.hasAttribute?.('data-finance-file')) return false;
    const chosen = target.files?.[0]; if (!chosen || !state.data) return true;
    state.selectedBackupName = chosen.name || '已選擇備份檔';
    state.backupValidationStatus = '正在驗證';
    state.notice = '';
    await run(async () => {
      state.preview = null; state.token = ''; state.restoreBackupReadyToken = ''; state.finalRestoreDialog = false; reset('restore');
      try {
        if (chosen.size > FINANCE_BACKUP_LIMIT) throw new Error('檔案超過 20 MiB。');
        const preview = await validateFinanceBackup(await chosen.text());
        if (preview.summary.dataset !== mode) throw new Error(mode === 'official' ? '此處只接受 official 標記的正式八集合備份。' : '此處只接受合成驗證備份。');
        const current = await repository.read(); publishData(current, 'backup-import-preview');
        state.recoveryPoint = localRecoveryEnabled ? await repository.getRecoveryPoint() : null;
        state.token = financeSnapshotToken(current); state.preview = preview; state.notice = '';
        state.backupValidationStatus = '格式與資料關聯驗證通過';
      } catch (error) {
        state.notice = '';
        const reason = error?.message || String(error);
        const message = reason.startsWith('JSON ') ? 'JSON 格式無效，請重新選擇有效的 Life Record 備份檔。' : reason;
        state.backupValidationStatus = `驗證失敗：${message}`;
      }
    }, { preserveScroll: true, focusImportPreview: true }); return true;
  }
  async function refreshPeriods() {
    const result = await repository.execute({ kind: 'refresh-reminders' }, { today: today(), expectedGeneration: state.data.financePreferences[0].generation });
    publishData(result.data, 'refresh-periods'); state.refreshedOn = today();
  }
  async function onEnter() {
    if (state.busy) return;
    if (mode === 'acceptance' && !state.data) return;
    if (enterPromise) return enterPromise;
    enterPromise = run(async () => {
      publishData(state.data ? await repository.read() : await repository.initialize(), 'page-entry');
      if (state.refreshedOn !== today()) await refreshPeriods();
      else state.refreshedOn = today();
        state.recoveryPoint = localRecoveryEnabled ? await repository.getRecoveryPoint() : null;
    }).finally(() => { enterPromise = null; });
    return enterPromise;
  }
  async function saveOfficialEntry(draft) {
    if (mode !== 'official' || !state.data) throw new Error('正式帳戶資料尚未載入，沒有保存記帳。');
    return execute({ kind: 'record', idempotencyKey: draft.idempotencyKey, entryType: draft.type, categoryId: draft.categoryId, subcategoryId: draft.subcategoryId, amountTwd: draft.amount, date: draft.date, note: draft.note, accountId: draft.accountId, paymentMethod: draft.paymentMethod || 'direct', ...(draft.reminderOccurrenceId ? { reminderOccurrenceId: draft.reminderOccurrenceId, expectedOccurrenceRevision: draft.expectedOccurrenceRevision } : {}) });
  }
  async function saveOfficialCategoryCatalog(catalog, expectedRevision) {
    if (mode !== 'official' || !state.data) throw new Error('正式分類資料尚未載入，沒有保存分類。');
    const result = await execute({ kind: 'save-category-catalog', catalog, expectedRevision });
    return result.data.categoryCatalog[0];
  }
  async function readLedgerEntries() {
    if (mode !== 'official') throw new Error('目前不是正式資料來源。');
    const data = await refreshOfficialData();
    return [...data.expenses, ...data.incomes].sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt));
  }
  function getLoadedLedgerEntries() {
    if (mode !== 'official' || !state.data) return null;
    return [...state.data.expenses, ...state.data.incomes].sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt));
  }
  function getLoadedReminderData() {
    if (mode !== 'official' || !state.data) return null;
    return { reminderRules: state.data.reminderRules, reminderOccurrences: state.data.reminderOccurrences };
  }
  async function readHistorySnapshot() {
    if (mode === 'acceptance' && !state.data) return null;
    const data = mode === 'official' && !state.data
      ? await repository.initialize()
      : await repository.read();
    return publishData(data, 'history-refresh');
  }
  async function executeHistoryCommand(command, expectedGeneration) {
    if (!state.data || !['official', 'acceptance'].includes(mode)) throw new Error('歷史紀錄目前沒有可操作的 V4 資料來源；正式 V4 仍受安全閘門保護。');
    const result = await repository.execute(command, { today: today(), expectedGeneration: Number.isSafeInteger(expectedGeneration) ? expectedGeneration : state.data.financePreferences[0].generation });
    publishData(result.data, 'history-command');
    return result;
  }
  async function refreshOfficialData() {
    if (mode !== 'official') throw new Error('目前不是正式資料來源。');
    const data = await repository.read();
    publishData(data, 'refresh');
    state.refreshedOn = today();
    return data;
  }
  function getActiveAccounts() { return mode === 'official' ? (state.data?.accounts.filter((item) => item.active) || []) : []; }
  function getDefaultAccount(entryType, categoryId) { return state.data ? resolveDefaultAccount(state.data, entryType, categoryId) : ''; }
  function getEntryPreferences() { return state.data?.financePreferences?.[0]?.entryPreferences || null; }
  function getBudgetRows(month) { return mode === 'official' && state.data ? orderedBudgetRows(calculateMonthlyBudgets(state.data, month), month) : null; }
  function getPendingReminder(id) { return mode === 'official' ? state.data?.reminderOccurrences.find((item) => item.id === id && item.status === 'pending') || null : null; }
  function getPendingReminders(entryType) { return mode === 'official' ? (state.data?.reminderOccurrences.filter((item) => item.status === 'pending' && item.entryType === entryType).sort((a, b) => a.dueDate.localeCompare(b.dueDate)) || []) : []; }
  function getCategoryCatalog() { return mode === 'official' ? state.data?.categoryCatalog?.[0] || null : null; }
  function openAccountView(view) {
    if (!['account', 'transfer', 'adjustment'].includes(view)) return false;
    state.accountView = view;
    state.editingAccount = null;
    return true;
  }
  function resetAccountView() { state.accountView = 'account'; state.editingAccount = null; state.accountEventsExpanded = true; state.accountManagementMode = false; }
  function setAccountEventsExpanded(expanded) { state.accountEventsExpanded = Boolean(expanded); }
  function prepareReminderPage() {
    if (state.editingRule || state.editingOccurrence || state.posting) return;
    if (!Object.keys(values('reminder')).length && state.reminderDrafts.has('new')) state.values.reminder = structuredClone(state.reminderDrafts.get('new'));
  }
  function attachAccountOrdering(root) {
    return bindAccountOrderInteractions(root, { environment, mode, onSaved: (ids) => { state.accountOrder = normalizeAccountOrder(state.data?.accounts || [], ids); state.accountOrderError = ''; } });
  }
  function attachBudgetOrdering(root) {
    return bindBudgetOrderInteractions(root, { environment, mode, onSaved: (month, ids) => { state.budgetOrderByMonth.set(month, normalizeBudgetOrder(state.data ? calculateMonthlyBudgets(state.data, month) : [], ids)); state.budgetOrderErrorsByMonth.set(month, ''); state.budgetOrderError = ''; } });
  }
  return { render, renderSetting, click, input: handleInput, file, onEnter, prepareReminderPage, attachAccountOrdering, attachBudgetOrdering, saveBudgetDisplayOrder, openAccountView, resetAccountView, setAccountEventsExpanded, saveOfficialEntry, saveOfficialCategoryCatalog, readLedgerEntries, getLoadedLedgerEntries, getLoadedReminderData, readHistorySnapshot, executeHistoryCommand, refreshOfficialData, getCategoryCatalog, getActiveAccounts, getDefaultAccount, getEntryPreferences, getBudgetRows, getPendingReminder, getPendingReminders, getMode: () => mode, hasFinanceData: () => Boolean(state.data), hasUnsavedDefaultDrafts: () => state.categoryDefaultDrafts.size > 0, discardDefaultDrafts: () => state.categoryDefaultDrafts.clear() };
}
