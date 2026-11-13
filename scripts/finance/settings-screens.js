import { escapeHTML as esc } from '../escape-html.js';
import { calculateMonthlyBudgets, isValidBudgetMonth } from './budget.js';
import { icon } from '../icons.js';
import { getAccountColor, getPreferredAccountId } from './model.js';
import { budgetOrderKey } from './budget-order.js';

const minorMoney = (minor) => {
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  const major = (absolute / 100n).toLocaleString('zh-TW');
  const cents = String(absolute % 100n).padStart(2, '0');
  return `${value < 0n ? '−' : ''}NT$${major}.${cents}`;
};
const wholeTwd = (amountTwd) => `NT$${Number(amountTwd).toLocaleString('zh-TW')}`;
const budgetMoney = (minor) => {
  const value = BigInt(minor);
  if (value % 100n !== 0n) return minorMoney(value);
  const sign = value < 0n ? '−' : '';
  const amount = value < 0n ? -value : value;
  return `${sign}NT$${(amount / 100n).toLocaleString('zh-TW')}`;
};

function renderBudget(h) {
  const { state, today, value, button, input, select } = h;
  const data = state.data;
  const month = value('budget', 'month', today().slice(0, 7));
  const categories = data.categoryCatalog[0].categories.filter((item) => item.entryType === 'expense' && !item.hidden);
  const selectedCategory = value('budget', 'categoryId', categories[0]?.id || '');
  const categoryId = categories.some((item) => item.id === selectedCategory) ? selectedCategory : (categories[0]?.id || '');
  const children = data.categoryCatalog[0].subcategories.filter((item) => item.entryType === 'expense' && !item.hidden && item.categoryIds.includes(categoryId));
  const selectedChild = value('budget', 'subcategoryId', '');
  const subcategoryId = children.some((item) => item.id === selectedChild) ? selectedChild : '';
  const selectedCategoryRecord = categories.find((item) => item.id === categoryId);
  const budgetCategoryOptions = categories.map((item) => button('choose-budget-category', `<span class="finance-choice-category-icon" style="--category-color:${esc(item.color)}">${icon(item.icon, 18)}</span><span>${esc(item.name)}</span>`, `data-category-id="${esc(item.id)}" data-choice-card="category" aria-pressed="${item.id === categoryId}" data-choice-search="${esc(item.name.toLocaleLowerCase('zh-TW'))}" style="--category-color:${esc(item.color)}"`)).join('');
  const budgetScopeOptions = [
    button('choose-budget-scope', '全部', `data-subcategory-id="" data-choice-card="chip" aria-pressed="${!subcategoryId}" style="--category-color:${esc(selectedCategoryRecord?.color || '#8795A7')}"`),
    ...children.map((item) => button('choose-budget-scope', esc(item.name), `data-subcategory-id="${esc(item.id)}" data-choice-card="chip" aria-pressed="${item.id === subcategoryId}" style="--category-color:${esc(selectedCategoryRecord?.color || '#8795A7')}"`)),
  ].join('');
  const settings = data.financePreferences[0];
  const budgets = isValidBudgetMonth(month) ? calculateMonthlyBudgets(data, month) : [];
  const orderedBudgets = h.orderBudgetRows ? h.orderBudgetRows(budgets, month) : budgets;
  const rows = orderedBudgets.map((item) => {
    const category = data.categoryCatalog[0].categories.find((row) => row.id === item.categoryId);
    const categoryColor = category?.color || '#8795A7';
    const ratio = item.budgetMinor > 0n ? Number((item.actualMinor * 10000n) / item.budgetMinor) / 100 : (item.actualMinor > 0n ? 100 : 0);
    const progress = Math.min(100, Math.max(0, ratio));
    const source = [...(settings.budgetOverrides || []), ...(settings.budgetSchedules || [])].find((rule) => rule.id === item.id);
    const spentLabel = item.exceeded ? `超支 ${budgetMoney(-item.remainingMinor)}` : `剩餘 ${budgetMoney(item.remainingMinor)}`;
    return `<article class="finance-budget-card ${item.exceeded ? 'is-exceeded' : ''}" data-budget-id="${esc(item.id)}" data-budget-sort-item="${esc(budgetOrderKey(item))}" tabindex="0" aria-keyshortcuts="ArrowUp ArrowDown" aria-describedby="finance-budget-order-help" aria-label="${esc(item.categoryName)}${item.subcategoryName ? `，${esc(item.subcategoryName)}` : ''}預算；可拖曳或使用上下方向鍵調整順序" style="--budget-category-color:${esc(categoryColor)}">
      <div class="finance-budget-card-heading"><div class="finance-budget-title"><span class="finance-budget-category-icon" style="--budget-category-color:${esc(categoryColor)}">${icon(category?.icon || 'tag', 18)}</span><div><h3>${esc(item.categoryName)}${item.subcategoryName ? ` <span>· ${esc(item.subcategoryName)}</span>` : ''}</h3><small>${item.subcategoryName ? '子分類預算' : '大分類預算'} · ${item.isMonthOverride ? '本月調整' : '每月沿用'}</small></div></div>${source ? `<div class="budget-card-actions">${button('edit-budget', icon('pencil', 14), `data-budget-id="${esc(item.id)}" aria-label="編輯${esc(item.categoryName)}預算" title="編輯預算"`)}${button('delete-budget', icon('trash', 14), `data-budget-id="${esc(item.id)}" aria-label="刪除${esc(item.categoryName)}預算" title="刪除預算設定" data-danger="true"`)}</div>` : ''}</div>
      <div class="finance-budget-numbers"><div><span>每月預算</span><strong>${wholeTwd(item.budgetTwd)}</strong></div><div><span>已花費</span><strong>${budgetMoney(item.actualMinor)}</strong></div><div><span>${item.exceeded ? '超出' : '剩餘'}</span><strong class="${item.exceeded ? 'finance-negative' : 'finance-positive'}">${spentLabel}</strong></div></div>
      <progress class="finance-budget-progress ${item.exceeded ? 'is-exceeded' : ''}" max="100" value="${progress}" aria-label="${esc(item.categoryName)}預算使用 ${progress}%"></progress>
    </article>`;
  }).join('');
  const hasFutureDefault = settings.budgetSchedules?.some((item) => item.categoryId === categoryId && (item.subcategoryId || '') === subcategoryId);
  return `<div class="finance-budget-screen">
    ${state.deleteBudget ? `<div class="finance-dialog-backdrop" data-budget-delete-dialog><section class="finance-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="budget-delete-title"><h2 id="budget-delete-title">確定要刪除「${esc(state.deleteBudget.name)}」的每月預算嗎？</h2><p>只刪除預算設定，不影響已記錄的交易。${esc(state.deleteBudget.scope)}</p><div class="finance-form-footer">${button('cancel-delete-budget', '取消', 'data-budget-delete-cancel autofocus')}${button('confirm-delete-budget', '確認刪除', 'data-budget-delete-confirm data-danger="true"')}</div></section></div>` : ''}

    <section class="finance-section finance-budget-editor" data-finance-focus tabindex="-1">
      <div class="finance-panel-heading"><h2>設定每月預算</h2></div>
      <p data-operation-hint>預算每月各自計算、不會結轉。支出超過預算時會提醒，但仍可記帳；收入、轉帳、校正及未確認提醒不會計入。</p>
      <div class="finance-fields finance-budget-fields">${input('budget', 'month', '月份', month, 'month')}<div class="finance-choice-field finance-budget-category-field"><span class="finance-choice-label">支出大分類</span><details class="finance-category-picker"><summary data-choice-summary="budget-category"><span class="finance-choice-category-icon" style="--category-color:${esc(selectedCategoryRecord?.color || '#8795A7')}">${icon(selectedCategoryRecord?.icon || 'tag', 18)}</span><span>${esc(selectedCategoryRecord?.name || '選擇大分類')}</span><span class="finance-choice-summary-hint">更改</span></summary><div class="finance-category-picker-popover"><label class="finance-category-search">搜尋分類<input type="search" data-budget-category-search placeholder="輸入分類名稱" autocomplete="off"></label><div class="finance-category-choice-grid">${budgetCategoryOptions || '<span class="finance-empty">目前沒有可用的大分類。</span>'}</div></div></details></div><div class="finance-choice-field finance-budget-scope-field"><span class="finance-choice-label">預算範圍</span><div class="finance-choice-chips" role="group" aria-label="選擇預算範圍">${budgetScopeOptions}</div></div>${input('budget', 'amountTwd', '每月預算（整數元）', '', 'number', 'min="0" step="1" inputmode="numeric"')}</div>
      <label class="finance-budget-future"><input type="checkbox" data-finance-form="budget" data-finance-field="applyFuture" ${value('budget', 'applyFuture', hasFutureDefault ? 'false' : 'true') === 'true' ? 'checked' : ''}> 從本月起沿用到未來月份（取消勾選只改目前月份）</label>
      <div class="finance-form-footer">${button('save-budget', '保存預算')}</div>
    </section>
    <section class="finance-budget-overview" aria-label="${esc(month)}預算進度"><div class="finance-panel-heading"><div><h2>${esc(month)} 預算進度</h2><p>依實際支出日期計算，舊紀錄金額精度保持不變。</p></div><span class="finance-budget-count">${budgets.length} 項</span></div>
      <p id="finance-budget-order-help" class="visually-hidden">可拖曳預算卡片調整順序；聚焦卡片後按上方向鍵或下方向鍵移動一格。每個月份分開保存顯示順序。</p>${state.budgetOrderError ? `<p class="finance-budget-order-status" data-budget-order-status role="status" aria-live="polite">${esc(state.budgetOrderError)}</p>` : ''}
      <div class="finance-budget-card-list" data-budget-sortable data-budget-month="${esc(month)}">${rows || '<div class="finance-budget-empty"><strong>這個月尚未設定預算</strong><p>選擇大分類並輸入金額，即可建立預算。</p></div>'}</div>
    </section>
  </div>`;
}

function renderPreferences(h) {
  const { state, value, button } = h;
  const data = state.data;
  const orderedAccounts = h.accountRecords?.() || data.accounts;
  const saved = data.financePreferences[0].entryPreferences || { defaultEntryType: 'expense', dateMode: 'today', preferredAccountId: '', lastEntryDate: '' };
  const preferences = { ...saved, defaultEntryType: value('preferences', 'defaultEntryType', saved.defaultEntryType), dateMode: value('preferences', 'dateMode', saved.dateMode) };
  const preferredAccountType = value('preferences', 'preferredAccountEntryType', 'expense');
  const savedByType = saved.preferredAccountIds || { expense: saved.preferredAccountId || '', income: saved.preferredAccountId || '' };
  const draftByType = value('preferences', 'preferredAccountIds', savedByType);
  const preferredAccountId = Object.hasOwn(draftByType, preferredAccountType) ? draftByType[preferredAccountType] : getPreferredAccountId(saved, preferredAccountType);
  const preferredAccount = data.accounts.find((item) => item.id === preferredAccountId && item.active)?.id || '';
  const accountCards = [button('choose-preference', `<span class="finance-choice-account-icon">${icon('wallet', 18)}</span><span><strong>不指定</strong><small>每次記帳時自行選擇</small></span>`, `data-choice-field="preferredAccountId" data-choice-value="" data-choice-card="account" aria-pressed="${preferredAccount === ''}"`), ...orderedAccounts.filter((item) => item.active).map((item) => { const color = getAccountColor(item); return button('choose-preference', `<span class="finance-choice-account-icon" style="--account-color:${esc(color)}">${icon(item.type === 'bank' ? 'bank' : 'wallet', 18)}</span><span><strong>${esc(item.name)}</strong><small>${item.type === 'bank' ? '銀行帳戶' : '現金帳戶'}</small></span>`, `data-choice-field="preferredAccountId" data-choice-value="${esc(item.id)}" data-choice-card="account" aria-pressed="${preferredAccount === item.id}" style="--account-color:${esc(color)}"`); })].join('');
  return `<section class="finance-section finance-setting-form" data-finance-focus tabindex="-1"><div class="finance-panel-heading"><h2>記帳偏好</h2></div>
    <div class="finance-preference-choice-groups">
      <fieldset class="finance-choice-group"><legend>新增記帳時先顯示</legend><div class="finance-choice-chips" role="group" aria-label="預設收支類型">${[['expense', '支出'], ['income', '收入']].map(([valueId, label]) => button('choose-preference', label, `data-choice-field="defaultEntryType" data-choice-value="${valueId}" data-choice-card="chip" aria-pressed="${preferences.defaultEntryType === valueId}" data-choice-tone="${valueId}"`)).join('')}</div></fieldset>
      <fieldset class="finance-choice-group"><legend>新增記帳時的日期</legend><div class="finance-choice-chips" role="group" aria-label="預設日期">${[['today', '今天'], ['last-entry', '上次使用日期']].map(([valueId, label]) => button('choose-preference', label, `data-choice-field="dateMode" data-choice-value="${valueId}" data-choice-card="chip" aria-pressed="${preferences.dateMode === valueId}"`)).join('')}</div></fieldset>
      <fieldset class="finance-choice-group"><legend>通用預設帳戶</legend><p class="finance-choice-help">沒有分類專屬帳戶時，先使用這個收支類型的帳戶。</p><div class="finance-choice-chips" role="group" aria-label="設定哪一種收支的通用帳戶">${[['expense', '支出'], ['income', '收入']].map(([valueId, label]) => button('choose-preference', label, `data-choice-field="preferredAccountEntryType" data-choice-value="${valueId}" data-choice-card="chip" aria-pressed="${preferredAccountType === valueId}" data-choice-tone="${valueId}"`)).join('')}</div><div class="finance-choice-card-grid">${accountCards}</div></fieldset>
    </div>
    <div class="finance-form-footer">${button('save-preferences', '保存記帳偏好')}</div>
  </section>`;
}

function renderCategoryDefaults(h) {
  const { state, value, button, accounts } = h;
  const data = state.data;
  const orderedAccounts = h.accountRecords?.() || data.accounts;
  const allCategories = data.categoryCatalog[0].categories.filter((item) => !item.hidden);
  const selectedId = value('default', 'categoryId', '');
  const selectedExisting = allCategories.find((item) => item.id === selectedId);
  const entryType = value('default', 'entryType', selectedExisting?.entryType || 'expense');
  const categories = allCategories.filter((item) => item.entryType === entryType);
  const category = categories.find((item) => item.id === selectedId) || categories[0];
  const current = data.financePreferences[0].defaults.find((item) => item.categoryId === category?.id && item.entryType === category?.entryType);
  const draftKey = category ? `${category.entryType}:${category.id}` : '';
  const hasDraft = Boolean(category && state.categoryDefaultDrafts?.has(draftKey));
  const selectedAccountRaw = hasDraft ? state.categoryDefaultDrafts.get(draftKey).accountId : (current?.accountId || '');
  const selectedAccount = data.accounts.some((item) => item.id === selectedAccountRaw && item.active) ? selectedAccountRaw : '';
  const generalAccountId = getPreferredAccountId(data.financePreferences[0].entryPreferences, entryType);
  const generalAccount = data.accounts.find((item) => item.id === generalAccountId && item.active);
  const effectiveSelectedAccountId = selectedAccount || generalAccount?.id || '';
  const categoryAccountStatus = selectedAccount
    ? `此分類專屬設定：${data.accounts.find((item) => item.id === selectedAccount)?.name || ''}`
    : selectedAccountRaw
      ? `此分類專屬帳戶目前無法使用；將沿用通用預設${generalAccount ? `「${generalAccount.name}」` : '；目前沒有可使用的預設帳戶'}`
      : `此分類沒有專屬預設；${generalAccount ? `記帳時沿用${entryType === 'income' ? '收入' : '支出'}通用預設「${generalAccount.name}」` : '目前沒有可使用的預設帳戶，記帳時請自行選擇'}`;
  const dirtyNames = [...(state.categoryDefaultDrafts?.values() || [])].map((draft) => data.categoryCatalog[0].categories.find((item) => item.id === draft.categoryId)?.name || '已不存在的分類');
  const categoryCards = categories.map((item) => button('choose-default-category', `<span class="finance-choice-category-icon" style="--category-color:${esc(item.color)}">${icon(item.icon, 20)}</span><span>${esc(item.name)}</span>`, `data-category-id="${esc(item.id)}" data-choice-card="category" aria-pressed="${item.id === category?.id}" data-choice-search="${esc(item.name.toLocaleLowerCase('zh-TW'))}" style="--category-color:${esc(item.color)}"`)).join('');
  const accountCards = [button('choose-default-account', `<span class="finance-choice-account-icon">${icon('wallet', 18)}</span><span><strong>不設定</strong><small>記帳時沿用通用預設；沒有時自行選擇</small></span>`, `data-account-id="" data-choice-card="account" aria-pressed="${effectiveSelectedAccountId === ''}"`), ...orderedAccounts.filter((item) => item.active).map((item) => { const color = getAccountColor(item); return button('choose-default-account', `<span class="finance-choice-account-icon" style="--account-color:${esc(color)}">${icon(item.type === 'bank' ? 'bank' : 'wallet', 18)}</span><span><strong>${esc(item.name)}</strong><small>${item.type === 'bank' ? '銀行帳戶' : '現金帳戶'}</small></span>`, `data-account-id="${esc(item.id)}" data-choice-card="account" aria-pressed="${effectiveSelectedAccountId === item.id}" style="--account-color:${esc(color)}"`); })].join('');
  return `<section class="finance-section finance-setting-form" data-finance-focus tabindex="-1"><div class="finance-panel-heading"><h2>分類預設帳戶</h2></div>
    <div class="finance-preference-choice-groups">
      <fieldset class="finance-choice-group"><legend>先選擇收支類型</legend><div class="finance-choice-chips" role="group" aria-label="分類預設帳戶收支類型">${[['expense', '支出'], ['income', '收入']].map(([valueId, label]) => button('choose-default-type', label, `data-entry-type="${valueId}" data-choice-card="chip" aria-pressed="${entryType === valueId}" data-choice-tone="${valueId}"`)).join('')}</div></fieldset>
      <fieldset class="finance-choice-group"><legend>選擇大分類</legend><div class="finance-choice-card-grid finance-default-category-grid">${categoryCards || '<span class="finance-empty">此類型尚無可用分類。</span>'}</div></fieldset>
       <fieldset class="finance-choice-group"><legend>選擇分類預設帳戶</legend><p class="finance-choice-help">使用順序：分類專屬預設 → 通用預設 → 自行選擇；不會自動指定現金。</p><p class="finance-category-account-status" role="status">${esc(categoryAccountStatus)}</p><div class="finance-choice-card-grid">${accountCards}</div></fieldset>
    </div>
    ${dirtyNames.length ? `<p class="finance-unsaved-defaults" role="status" aria-live="polite">尚未儲存：${dirtyNames.map(esc).join('、')}</p>` : '<p class="finance-saved-defaults" role="status">目前沒有未儲存的變更。</p>'}
    <div class="finance-form-footer">${button('save-default', `儲存設定${dirtyNames.length ? `（${dirtyNames.length}）` : ''}`, state.categoryDefaultDrafts?.size ? '' : 'disabled')}</div>
  </section>`;
}

export function renderFinanceSettingsScreen(h, view, { dataManagement = '' } = {}) {
  const { state, button } = h;
  const screens = {
    ledger: ['記帳設定', '管理新增記帳的預設方式與分類專屬帳戶。', (helpers) => `<div class="ledger-preference-groups">${renderPreferences(helpers)}${renderCategoryDefaults(helpers)}</div>${dataManagement}`],
    budget: ['每月預算', '設定各月份的大分類及子分類支出預算。', renderBudget],
    preferences: ['記帳偏好', '設定新增記帳時使用的預設方式。', renderPreferences],
    defaults: ['分類預設帳戶', '為常用分類指定預設收款或付款帳戶。', renderCategoryDefaults],
  };
  const screen = screens[view];
  if (!screen) return '<div class="finance-empty">找不到這項記帳設定。</div>';
  const [title, subtitle, renderBody] = screen;
  const status = state.busy ? '正在保存…' : state.notice;
  const headerIcon = view === 'budget' ? 'chart-no-axes-column-increasing' : 'settings-2';
  const headerLabel = view === 'budget' ? 'MONTHLY BUDGET' : 'LEDGER SETTINGS';
  return `<div class="finance-setting-page" data-finance-workspace aria-busy="${state.busy}">
    <div class="page-heading inner-page-heading finance-setting-heading finance-page-heading"><div><div class="eyebrow finance-page-eyebrow"><span class="eyebrow-spark">${icon(headerIcon, 15)}</span> ${headerLabel}</div><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div><div class="page-heading-actions finance-setting-actions">${view === "ledger" ? `<button type="button" class="quiet-button app-back-control" data-action="app-back" aria-label="返回上一頁">${icon("chevron", 15)}返回上一頁</button>` : button("reload", "重新讀取") + (state.mode === "acceptance" ? button("disconnect", "離開測試資料") : "")}</div></div>
    ${state.mode === 'acceptance' ? '<div class="finance-synthetic-badge">目前使用獨立測試資料；不影響日常正式資料。啟用此瀏覽器設定檔的 V4 開發版，請前往上方「V4 開發版與備份」。</div>' : ''}
    ${status ? `<p class="finance-result" tabindex="-1" role="status" aria-live="polite">${esc(status)}</p>` : ''}
    ${renderBody(h)}
  </div>`;
}
