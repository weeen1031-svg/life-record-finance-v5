import { icon } from '../icons.js';
import { escapeHTML } from '../escape-html.js';
import { createIdempotencyKey, isValidDateOnly, parseTwdAmountToMinor } from '../storage/expense-db.js';

const demoAccounts = [
  { id: 'demo-wallet', label: '示範現金錢包' },
  { id: 'demo-bank', label: '示範銀行帳戶' },
  { id: 'demo-card', label: '示範簽帳卡' },
];

export function getLocalDateInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function createEntryDraft() {
  return {
    type: 'expense',
    categoryId: '',
    subcategoryId: '',
    expenseCategoryId: '',
    expenseSubcategoryId: '',
    incomeCategoryId: '',
    incomeSubcategoryId: '',
    amount: '',
    note: '',
    date: getLocalDateInputValue(),
    accountId: demoAccounts[0].id,
    accountUserSelected: false,
    accountSelectionsByType: { expense: { accountId: demoAccounts[0].id, userSelected: false }, income: { accountId: '', userSelected: false } },
    userEdited: false,
    idempotencyKey: createIdempotencyKey(),
    feedback: '',
    feedbackTone: 'neutral',
    isSaving: false,
    submissionBlocked: false,
  };
}

export function switchEntryDraftType(draft, nextType) {
  if (!['expense', 'income'].includes(nextType) || draft.type === nextType || draft.isSaving) return false;
  draft[`${draft.type}CategoryId`] = draft.categoryId;
  draft[`${draft.type}SubcategoryId`] = draft.subcategoryId;
  draft.accountSelectionsByType ||= {};
  draft.accountSelectionsByType[draft.type] = { accountId: draft.accountId || '', userSelected: draft.accountUserSelected === true };
  draft.type = nextType;
  draft.userEdited = true;
  draft.categoryId = draft[`${nextType}CategoryId`] || '';
  draft.subcategoryId = draft[`${nextType}SubcategoryId`] || '';
  const accountSelection = draft.accountSelectionsByType[nextType] || { accountId: '', userSelected: false };
  draft.accountId = accountSelection.accountId || '';
  draft.accountUserSelected = accountSelection.userSelected === true;
  draft.idempotencyKey = createIdempotencyKey();
  draft.submissionBlocked = false;
  draft.feedback = '';
  draft.feedbackTone = 'neutral';
  return true;
}

export function reconcileEntryDraftSelection(store, draft) {
  const categoryAvailable = store.isCategorySelectable(draft.categoryId)
    && store.getCategory(draft.categoryId)?.entryType === draft.type;
  if (!categoryAvailable) {
    const hadSelection = Boolean(draft.categoryId || draft.subcategoryId);
    draft.categoryId = '';
    draft.subcategoryId = '';
    draft[`${draft.type}CategoryId`] = '';
    draft[`${draft.type}SubcategoryId`] = '';
    if (!hadSelection) return false;
    draft.feedback = '原選取的分類已隱藏或無法使用，請重新選擇。';
  } else {
    if (!draft.subcategoryId || store.isSubcategorySelectable(draft.categoryId, draft.subcategoryId)) return false;
    draft.subcategoryId = '';
    draft[`${draft.type}SubcategoryId`] = '';
    draft.feedback = '原選取的子分類已隱藏或移出，請重新選擇。';
  }
  draft.idempotencyKey = createIdempotencyKey();
  draft.submissionBlocked = false;
  draft.feedbackTone = 'error';
  return true;
}

export function selectEntryCategory(store, draft, categoryId) {
  const category = store.getCategory(categoryId);
  if (!category || category.entryType !== draft.type || !store.isCategorySelectable(category.id)) return false;

  const previousCategoryId = draft.categoryId;
  const previousSubcategoryId = draft.subcategoryId;
  draft.categoryId = category.id;
  draft[`${draft.type}CategoryId`] = category.id;
  if (!store.isSubcategorySelectable(category.id, draft.subcategoryId)) {
    draft.subcategoryId = '';
    draft[`${draft.type}SubcategoryId`] = '';
  }
  if (previousCategoryId !== draft.categoryId || previousSubcategoryId !== draft.subcategoryId) {
    draft.userEdited = true;
    draft.idempotencyKey = createIdempotencyKey();
    draft.submissionBlocked = false;
    draft.feedback = '';
    draft.feedbackTone = 'neutral';
  }
  return true;
}

export function applyEntryPreferencesToDraft(draft, preferences, activeAccounts, { today } = {}) {
  if (!draft || draft.userEdited || !preferences || !['expense', 'income'].includes(preferences.defaultEntryType)) return false;
  const date = preferences.dateMode === 'last-entry' && isValidDateOnly(preferences.lastEntryDate)
    ? preferences.lastEntryDate
    : (isValidDateOnly(today) ? today : getLocalDateInputValue());
  draft.type = preferences.defaultEntryType;
  draft.date = date;
  const accounts = Array.isArray(activeAccounts) ? activeAccounts : [];
  const typedDefaults = preferences.preferredAccountIds;
  const accountId = typedDefaults && Object.hasOwn(typedDefaults, draft.type)
    ? typedDefaults[draft.type]
    : preferences.preferredAccountId;
  draft.accountId = accounts.some((item) => item.id === accountId) ? accountId : '';
  draft.accountUserSelected = false;
  draft.accountSelectionsByType ||= {};
  draft.accountSelectionsByType[draft.type] = { accountId: draft.accountId, userSelected: false };
  return true;
}

export function applyResolvedAccountToDraft(draft, preferredAccountId, activeAccounts) {
  if (!draft) return false;
  const accounts = Array.isArray(activeAccounts) ? activeAccounts : [];
  const currentIsActive = accounts.some((item) => item.id === draft.accountId);
  if (draft.accountUserSelected && currentIsActive) return false;
  if (draft.accountUserSelected && !currentIsActive) draft.accountUserSelected = false;
  const nextId = accounts.some((item) => item.id === preferredAccountId) ? preferredAccountId : '';
  const changed = draft.accountId !== nextId;
  draft.accountId = nextId;
  draft.accountSelectionsByType ||= {};
  draft.accountSelectionsByType[draft.type] = { accountId: nextId, userSelected: false };
  return changed;
}

export function selectEntryAccount(draft, accountId) {
  if (!draft) return false;
  draft.accountId = accountId || '';
  draft.accountUserSelected = true;
  draft.accountSelectionsByType ||= {};
  draft.accountSelectionsByType[draft.type] = { accountId: draft.accountId, userSelected: true };
  draft.userEdited = true;
  return true;
}

export function renderAddEntryPage(store, draft, { accounts = null, pendingReminders = null } = {}) {
  const catalogReady = store.isReady?.() ?? true;
  const persistenceNotice = Array.isArray(accounts)
    ? (accounts.some((account) => account.active) ? '收支與選取帳戶會保存在此瀏覽器。' : '收支會保存在此瀏覽器；目前沒有可用帳戶，請先至資金帳戶建立。')
    : '收支紀錄及分類設定會保存在此瀏覽器；帳戶仍為介面示範且不異動餘額。';
  return `
    <div class="page-heading entry-page-heading">
      <div><div class="eyebrow"><span class="eyebrow-spark">${icon('sparkSmall', 15)}</span> QUICK ENTRY <span class="eyebrow-line"></span> 本機記帳</div><h1>新增記帳</h1><p class="page-subtitle">${draft.type === 'income' ? '選擇收入分類、金額與日期，儲存後可在歷史紀錄查看。' : '選擇支出分類、金額與日期，儲存後可在歷史紀錄查看。'}</p></div>
      <div class="entry-mode-pill">${icon('plus', 15)} 單筆快速記帳</div>
    </div>
    <div class="demo-notice"><span class="notice-icon">${icon('sparkSmall', 16)}</span><span>${escapeHTML(persistenceNotice)}</span><span class="notice-tag">本機保存</span></div>
    ${!catalogReady ? `<div class="history-status ${store.getLoadError?.() ? 'error' : ''}" role="status" aria-live="polite">${store.getLoadError?.() ? `分類設定載入失敗：${escapeHTML(store.getLoadError())}` : '正在載入已保存的分類設定…'}${store.getLoadError?.() ? '<button class="quiet-button" type="button" data-action="retry-category-load">重試載入分類</button>' : ''}</div>` : ''}
    ${renderAddEntryForm(store, draft, { accounts, pendingReminders })}`;
}

export function renderAddEntryForm(store, draft, { accounts = null, pendingReminders = null } = {}) {
  const catalogReady = store.isReady?.() ?? true;
  const disabled = draft.isSaving || !catalogReady ? 'disabled' : '';
  const isIncome = draft.type === 'income';
  const categories = store.listCategories({ includeHidden: false, entryType: draft.type });
  const selectedCategory = categories.find((item) => item.id === draft.categoryId) || null;
  const subcategories = selectedCategory ? store.listSubcategories(selectedCategory.id, { includeHidden: false }) : [];
  const selectedSubcategory = subcategories.find((item) => item.id === draft.subcategoryId);
  const amountReady = Boolean(selectedSubcategory);
  const formalAccounts = Array.isArray(accounts) ? accounts.filter((item) => item.active) : null;
  const selectedAccountId = formalAccounts?.some((item) => item.id === draft.accountId) ? draft.accountId : '';
  const dueReminders = Array.isArray(pendingReminders) ? pendingReminders.filter((item) => item.entryType === draft.type && item.status === 'pending') : [];
  const reminderImport = dueReminders.length ? `<section class="entry-reminder-import" aria-label="從待處理項目帶入"><div><strong>從待處理項目帶入</strong><p>會帶入本期資料；確認保存後才會建立正式收支。</p></div><select data-field="entry-reminder-choice" ${draft.isSaving || draft.reminderOccurrenceId ? 'disabled' : ''}><option value="">選擇${draft.type === 'income' ? '待收款' : '待付款'}項目</option>${dueReminders.map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)} · ${item.dueDate} · NT$${Number(item.amountTwd).toLocaleString('zh-TW')}</option>`).join('')}</select><button type="button" class="quiet-button" data-action="entry-load-reminder" ${draft.isSaving || draft.reminderOccurrenceId ? 'disabled' : ''}>帶入本期</button></section>` : '';

  return `
    <section class="entry-workspace ${isIncome ? 'income-entry-workspace' : ''}" aria-label="新增${isIncome ? '收入' : '支出'}表單" aria-busy="${draft.isSaving || !catalogReady}">
      ${draft.reminderOccurrenceId ? `<div class="entry-reminder-source"><span><strong>來源項目：${escapeHTML(draft.reminderName || '定期收支')}</strong> · 本次確認只處理這一期，不更動未來預設。</span><button type="button" class="quiet-button" data-action="entry-cancel-reminder" ${draft.isSaving ? 'disabled' : ''}>取消帶入並返回原草稿</button></div>` : reminderImport}
      <div class="entry-top-controls">
        <div class="entry-type-switch" role="group" aria-label="收支類型">
          <button type="button" class="entry-type-button ${draft.type === 'expense' ? 'is-selected expense' : ''}" data-action="entry-set-type" data-entry-type="expense" aria-pressed="${draft.type === 'expense'}" ${disabled || draft.reminderOccurrenceId ? 'disabled' : ''}>${icon('arrowUp', 16)}支出</button>
          <button type="button" class="entry-type-button ${draft.type === 'income' ? 'is-selected income' : ''}" data-action="entry-set-type" data-entry-type="income" aria-pressed="${draft.type === 'income'}" ${disabled || draft.reminderOccurrenceId ? 'disabled' : ''}>${icon('arrowDown', 16)}收入</button>
        </div>
        <div class="entry-top-actions">
          <span class="entry-top-hint" data-operation-hint>${icon('check', 14)} 輸入順序：大分類 → 子分類 → 金額 → 備註</span>
          <button class="entry-category-settings-link" type="button" data-action="open-category-settings" aria-label="管理${isIncome ? '收入' : '支出'}分類與顏色" ${disabled}>${icon('tag', 15)}管理分類與顏色</button>
        </div>
      </div>

      <section class="entry-step" aria-labelledby="entry-category-title">
        <div class="entry-step-heading"><span class="step-number">01</span><div><h2 id="entry-category-title">選擇${isIncome ? '收入' : '支出'}大分類</h2><p>${isIncome ? '選擇這筆收入的來源類型' : '先挑選最符合這筆支出的分類'}</p></div><span class="step-required">必選</span></div>
        <div class="entry-category-grid">${categories.length ? categories.map((category) => `
          <button type="button" class="entry-category-card ${draft.categoryId === category.id ? 'is-selected' : ''}" style="--category-color:${escapeHTML(category.color)}" data-action="entry-select-category" data-category-id="${escapeHTML(category.id)}" aria-pressed="${draft.categoryId === category.id}" ${disabled}>
            <span class="entry-category-icon">${icon(category.icon, 20)}</span><span class="entry-category-name">${escapeHTML(category.name)}</span>${draft.categoryId === category.id ? `<span class="entry-category-check">${icon('check', 14)}</span>` : ''}
          </button>`).join('') : '<div class="entry-step-placeholder">目前沒有可選的大分類，請到設定中心恢復隱藏分類或新增分類。</div>'}
        </div>
      </section>

      <section class="entry-step ${selectedCategory ? '' : 'is-pending'}" aria-labelledby="entry-subcategory-title">
        <div class="entry-step-heading"><span class="step-number">02</span><div><h2 id="entry-subcategory-title">選擇子分類</h2><p>${selectedCategory ? `目前大分類：${escapeHTML(selectedCategory.name)}` : '選擇大分類後，顯示對應子分類'}</p></div><span class="step-required">必選</span></div>
        ${selectedCategory ? `<div class="entry-subcategory-grid">${subcategories.map((item) => `
          <button type="button" class="entry-subcategory-chip ${draft.subcategoryId === item.id ? 'is-selected' : ''}" style="--category-color:${escapeHTML(selectedCategory.color)}" data-action="entry-select-subcategory" data-subcategory-id="${escapeHTML(item.id)}" aria-pressed="${draft.subcategoryId === item.id}" ${disabled}>${escapeHTML(item.name)}</button>`).join('')}${subcategories.length ? '' : '<span class="entry-empty-subcategory">此大分類尚無子分類，請先到設定中心建立子分類。</span>'}</div>` : `<div class="entry-step-placeholder">${icon('chevron', 17)} 請先完成上方大分類選擇</div>`}
      </section>

      <section class="entry-step amount-step ${amountReady ? '' : 'is-pending'}" aria-labelledby="entry-amount-title">
        <div class="entry-step-heading"><span class="step-number">03</span><div><h2 id="entry-amount-title">輸入金額</h2><p>請輸入大於 0 的整數新台幣元</p></div><span class="step-required">必填</span></div>
        <label class="amount-field"><span class="currency-prefix">NT$</span><input type="number" min="1" step="1" inputmode="numeric" autocomplete="off" placeholder="0" value="${escapeHTML(draft.amount)}" data-field="entry-amount" aria-label="金額（整數新台幣元）" ${disabled}/><span class="amount-category-preview" ${selectedCategory ? `style="--category-color:${escapeHTML(selectedCategory.color)}"` : ''}>${selectedCategory ? `${icon(selectedCategory.icon, 16)}${escapeHTML(selectedCategory.name)}${selectedSubcategory ? ` · ${escapeHTML(selectedSubcategory.name)}` : ''}` : '選擇分類後顯示'}</span></label>
      </section>

      <section class="entry-step" aria-labelledby="entry-note-title">
        <div class="entry-step-heading"><span class="step-number">04</span><div><h2 id="entry-note-title">備註 <span class="optional-label">選填</span></h2><p data-operation-hint>為這筆${isIncome ? '收入' : '支出'}補充一點說明</p></div></div>
        <label class="note-field"><span class="visually-hidden">備註</span><textarea rows="2" maxlength="160" placeholder="${isIncome ? '例如：本週打工薪資' : '例如：週末和朋友吃飯'}" data-field="entry-note" ${disabled}>${escapeHTML(draft.note)}</textarea><span class="note-counter">${draft.note.length}/160</span></label>
      </section>

      <section class="entry-extra-fields" aria-label="其他記帳欄位">
        <div class="entry-extra-heading"><span>${icon('calendar', 17)}</span><div><strong>${isIncome ? '收入資訊' : '交易資訊'}</strong><small>日期會保存；帳戶仍為介面示範</small></div></div>
        <label class="entry-control entry-date-control"><span>日期</span><span class="entry-date-row"><input type="date" value="${escapeHTML(draft.date)}" data-field="entry-date" ${disabled}/><button type="button" class="entry-today-button" data-action="entry-set-today" ${disabled}>今天</button></span></label>
        ${formalAccounts === null ? `<label class="entry-control"><span>${draft.type === 'expense' ? '付款帳戶（尚未保存）' : '收款帳戶（尚未保存）'}</span><select data-field="entry-account" ${disabled}>${demoAccounts.map((account) => `<option value="${account.id}" ${draft.accountId === account.id ? 'selected' : ''}>${account.label}</option>`).join('')}</select></label>` : `<label class="entry-control"><span>${draft.type === 'expense' ? '付款帳戶' : '收款帳戶'}（必選）</span><select data-field="entry-account" ${disabled}><option value="">請選擇帳戶</option>${formalAccounts.map((account) => `<option value="${escapeHTML(account.id)}" ${selectedAccountId === account.id ? 'selected' : ''}>${escapeHTML(account.name)} · ${account.type === 'bank' ? '銀行' : '現金'}</option>`).join('')}</select></label>${formalAccounts.length ? '' : '<p class="history-status error">尚無可用帳戶，請先建立並啟用資金帳戶。</p>'}`}
      </section>

      <div class="entry-submit-row"><p class="entry-feedback ${draft.feedbackTone}" data-entry-feedback role="status" aria-live="polite">${draft.feedback ? escapeHTML(draft.feedback) : !catalogReady ? '分類設定載入完成後即可記帳。' : '儲存後會寫入此裝置的正式記帳資料庫。'}</p><button class="primary-button entry-confirm-button ${isIncome ? 'income-save-button' : ''}" type="button" data-action="confirm-entry" ${draft.isSaving || draft.submissionBlocked || !catalogReady ? 'disabled' : ''}>${icon(draft.isSaving ? 'clock' : 'check', 17)} ${draft.isSaving ? '儲存中…' : `儲存${isIncome ? '收入' : '支出'}`}</button></div>
    </section>`;
}

export function validateEntryDraft(store, draft, { accounts = null } = {}) {
  if (!['expense', 'income'].includes(draft.type)) return '請選擇支出或收入類型。';
  if (store.getCategory(draft.categoryId)?.entryType !== draft.type || !store.isCategorySelectable(draft.categoryId)) return '請先選擇目前收支類型可使用的大分類。';
  if (!draft.subcategoryId || !store.isSubcategorySelectable(draft.categoryId, draft.subcategoryId)) return '請選擇目前大分類底下可使用的子分類。';
  if (!parseTwdAmountToMinor(draft.amount)) return '請輸入大於 0 的整數新台幣元；舊紀錄會保留原有金額。';
  if (!isValidDateOnly(draft.date)) return '請選擇有效日期。';
  if (Array.isArray(accounts) && !accounts.some((item) => item.active && item.id === draft.accountId)) return '請選擇目前可使用的正式帳戶。';
  return '';
}
