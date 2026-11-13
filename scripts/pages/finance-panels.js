import { icon } from '../icons.js';
import { escapeHTML } from '../escape-html.js';
import { getLocalDateInputValue } from './add-entry.js';
import { getRecordCategoryPresentation } from '../category-presentation.js';
import { calculateMonthlyBudgets } from '../finance/budget.js';
import { renderBudgetSummary } from './budget-summary.js';
import { defaultOverviewConfig } from '../ui/overview-preferences.js';

export function formatMoney(minor) {
  const value = BigInt(minor); const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '−' : ''}NT$ ${String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${absolute % 100n ? `.${String(absolute % 100n).padStart(2, '0')}` : ''}`;
}
const percent = (value, total) => total > 0n ? Number(value * 100n / total) : 0;

export function aggregateLedger(records, now = new Date()) {
  const month = getLocalDateInputValue(now).slice(0, 7);
  const current = records.filter((row) => row.occurredOn.slice(0, 7) === month);
  const sum = (rows, type) => rows.filter((row) => row.recordType === type).reduce((total, row) => total + BigInt(row.amountMinor), 0n);
  const categories = new Map();
  for (const row of current.filter((item) => item.recordType === 'expense')) {
    const prior = categories.get(row.categoryId) || { id: row.categoryId, name: row.categoryNameSnapshot, amount: 0n };
    prior.amount += BigInt(row.amountMinor); categories.set(row.categoryId, prior);
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = getLocalDateInputValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + index));
    return { date, amount: sum(records.filter((row) => row.occurredOn === date), 'expense') };
  });
  const months = Array.from({ length: 6 }, (_, index) => {
    const key = getLocalDateInputValue(new Date(now.getFullYear(), now.getMonth() - 5 + index, 1)).slice(0, 7);
    const rows = records.filter((row) => row.occurredOn.slice(0, 7) === key);
    return { key, income: sum(rows, 'income'), expense: sum(rows, 'expense') };
  });
  return { month, count: current.length, income: sum(current, 'income'), expense: sum(current, 'expense'), categories: [...categories.values()].sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.id.localeCompare(b.id)), days, months,
    recent: current.sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.createdAt.localeCompare(a.createdAt)) };
}

export function summarizeMonthlySubscriptions(rules, occurrences, month) {
  const monthlyExpenseRules = new Map((Array.isArray(rules) ? rules : [])
    .filter((rule) => rule.repeat === 'monthly' && rule.entryType === 'expense')
    .map((rule) => [rule.id, rule]));
  const items = (Array.isArray(occurrences) ? occurrences : [])
    .filter((item) => monthlyExpenseRules.has(item.ruleId) && item.entryType === 'expense'
      && item.dueDate?.slice(0, 7) === month && ['pending', 'completed'].includes(item.status))
    .map((item) => {
      const rule = monthlyExpenseRules.get(item.ruleId);
      return { ...item, categoryId: item.entryDefaults?.categoryId || rule.entryDefaults?.categoryId || '', amountMinor: BigInt(item.amountTwd) * 100n };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pendingMinor = items.filter((item) => item.status === 'pending').reduce((sum, item) => sum + item.amountMinor, 0n);
  const paidMinor = items.filter((item) => item.status === 'completed').reduce((sum, item) => sum + item.amountMinor, 0n);
  return { month, items, totalMinor: pendingMinor + paidMinor, pendingMinor, paidMinor };
}

export function createPreviewRecords(now = new Date()) {
  const date = getLocalDateInputValue(now);
  return [
    { id: 'preview-income', recordType: 'income', amountMinor: 200000, occurredOn: date, createdAt: `${date}T08:00:00.000Z`, categoryId: 'preview-allowance', categoryNameSnapshot: '範例零用錢', subcategoryNameSnapshot: '每月零用錢', categoryIconSnapshot: 'wallet', categoryColorSnapshot: '#42B982', note: '純觀看範例' },
    { id: 'preview-food', recordType: 'expense', amountMinor: 12000, occurredOn: date, createdAt: `${date}T09:00:00.000Z`, categoryId: 'preview-meal', categoryNameSnapshot: '範例餐飲', subcategoryNameSnapshot: '午餐', categoryIconSnapshot: 'utensils', categoryColorSnapshot: '#F05A67', note: '不會寫入正式紀錄' },
    { id: 'preview-shopping', recordType: 'expense', amountMinor: 18000, occurredOn: date, createdAt: `${date}T10:00:00.000Z`, categoryId: 'preview-shopping', categoryNameSnapshot: '範例購物', subcategoryNameSnapshot: '日用品', categoryIconSnapshot: 'shoppingBag', categoryColorSnapshot: '#F28A4B', note: '不影響真實統計' },
  ];
}

function renderCategoryBars(summary, store) {
  if (!summary.categories.length) return '<p class="finance-empty">本月尚無支出紀錄。</p>';
  return `<div class="finance-bars">${summary.categories.map((item) => {
    const category = store.getCategory(item.id); const color = category?.color || '#D8A36F';
    return `<div class="finance-bar-row"><div class="finance-bar-label"><span class="finance-category-mark" style="--category-color:${escapeHTML(color)}">${icon(category?.icon || 'tag', 16)}</span><strong>${escapeHTML(category?.name || item.name)}</strong><small>${formatMoney(item.amount)} · ${percent(item.amount, summary.expense)}%</small></div><div class="finance-bar-track"><span style="--bar-width:${percent(item.amount, summary.expense)}%;--category-color:${escapeHTML(color)}"></span></div></div>`;
  }).join('')}</div>`;
}

export function renderFinancePanel(store, state, full = false) {
  const preview = state.source === 'preview';
  const sourceControls = `<div class="finance-toolbar"><span class="finance-source-label">${preview ? '範例預覽' : '我的資料'}</span><div class="finance-toolbar-actions">${!preview ? '<button class="finance-refresh-button" type="button" data-action="refresh-finance">重新讀取</button>' : ''}</div></div><p class="finance-source-note ${preview ? 'is-preview' : ''}">${preview ? '範例預覽 · 所有金額均為虛構，不寫入或混入正式資料。' : '依已保存紀錄日期計算；帳戶餘額請到「資金帳戶」查看。'}</p>`;
  if (!preview && state.error) return `${sourceControls}<div class="finance-load-error" role="alert"><p class="history-status error">${escapeHTML(state.error)}</p><button class="quiet-button" type="button" data-action="refresh-finance">重新讀取</button></div>`;
  if (!preview && (state.loading || state.records === null)) return `${sourceControls}<p class="finance-empty" role="status">正在讀取已保存紀錄…</p>`;
  const records = preview ? createPreviewRecords() : state.records || [];
  const summary = aggregateLedger(records);
  const config = state.overviewPreferences?.[preview ? 'preview' : 'personal'] || defaultOverviewConfig();
  const figures = `<div class="summary-figure-grid"><article class="summary-figure income"><span>本月收入</span><strong>${formatMoney(summary.income)}</strong></article><article class="summary-figure expense"><span>本月支出</span><strong>${formatMoney(summary.expense)}</strong></article><article class="summary-figure"><span>本月收支差額</span><strong>${formatMoney(summary.income - summary.expense)}</strong><small>非帳戶餘額</small></article></div>`;
  const category = `<section class="finance-panel-card"><div class="finance-panel-card-heading"><div><h3>本月大分類支出與比例</h3><p>${summary.month} · ${summary.count} 筆收支</p></div></div>${renderCategoryBars(summary, store)}</section>`;
  const recentCollapsed = Boolean(config.recentCollapsed);
  const recentActions = `<div class="overview-card-actions"><a class="budget-summary-all-link" href="#history" data-page="history">全部記錄</a><button type="button" class="mini-action recent-records-toggle ${recentCollapsed ? 'is-collapsed' : 'is-expanded'}" data-action="toggle-recent-records" aria-expanded="${!recentCollapsed}" aria-label="${recentCollapsed ? '展開' : '收合'}最近記帳紀錄" title="${recentCollapsed ? '展開最近記帳紀錄' : '收合最近記帳紀錄'}">${icon('chevron', 14)}</button></div>`;
  const recentContent = summary.recent.length ? `<div class="workbench-recent-list" tabindex="0" role="region" aria-label="本月收支紀錄，可捲動查看">${summary.recent.map((row) => {
    const presentation = getRecordCategoryPresentation(row, store);
    return `<div class="workbench-recent-row"><span class="workbench-recent-icon category-record-icon" style="--record-category-color:${escapeHTML(presentation.color)}">${icon(presentation.iconName, 16)}</span><div><strong>${escapeHTML(row.subcategoryNameSnapshot || row.categoryNameSnapshot)}</strong><small>${escapeHTML(row.occurredOn)} · ${escapeHTML(row.categoryNameSnapshot)}</small></div><b class="${row.recordType}">${row.recordType === 'income' ? '+' : '−'}${formatMoney(row.amountMinor)}</b></div>`;
  }).join('')}</div>` : '<p class="finance-empty">本月尚無已保存的收支紀錄。</p>';
  const recent = `<section class="finance-panel-card workbench-recent-card"><div class="finance-panel-card-heading"><h3>最近記帳紀錄</h3>${recentActions}</div><div class="overview-collapsible-content ${recentCollapsed ? 'is-collapsed' : 'is-expanded'}" aria-hidden="${recentCollapsed}" ${recentCollapsed ? 'inert' : ''}>${recentContent}</div></section>`;
  const subscriptionsCollapsed = Boolean(config.subscriptionsCollapsed);
  const subscriptionData = preview ? null : state.subscriptionData;
  const subscriptionSummary = subscriptionData
    ? summarizeMonthlySubscriptions(subscriptionData.reminderRules, subscriptionData.reminderOccurrences, summary.month)
    : null;
  const subscriptionRows = subscriptionSummary?.items.map((item) => {
    const category = item.categoryId ? store.getCategory(item.categoryId) : null;
    const color = category?.color || '#a697f6';
    const isPaid = item.status === 'completed';
    const dueLabel = item.dueDate.slice(5).replace('-', '/');
    const description = category?.name ? `付款日 ${dueLabel} · ${category.name}` : `付款日 ${dueLabel}`;
    return `<div class="workbench-subscription-row"><span class="workbench-subscription-icon" style="--subscription-color:${escapeHTML(color)}">${icon(category?.icon || 'bell', 15)}</span><div class="workbench-subscription-description"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(description)}</small></div><div class="workbench-subscription-amount"><b>${formatMoney(item.amountMinor)}</b><small class="${isPaid ? 'is-paid' : 'is-pending'}">${isPaid ? '已付款' : '待付款'}</small></div></div>`;
  }).join('') || '';
  const subscriptionBody = preview
    ? '<p class="finance-empty">範例預覽不會讀取或顯示個人訂閱資料。</p>'
    : !subscriptionSummary
      ? '<p class="finance-empty">訂閱資料尚未載入。</p>'
      : `<div class="subscription-summary-stats"><article><span>本月預計</span><strong>${formatMoney(subscriptionSummary.totalMinor)}</strong></article><article><span>已付款</span><strong>${formatMoney(subscriptionSummary.paidMinor)}</strong></article><article><span>待付款</span><strong>${formatMoney(subscriptionSummary.pendingMinor)}</strong></article></div>${subscriptionSummary.items.length ? `<div class="workbench-subscription-list" tabindex="0" role="region" aria-label="本月訂閱項目，可捲動查看">${subscriptionRows}</div>` : '<p class="finance-empty">本月沒有訂閱項目。</p>'}`;
  const subscriptionActions = `<div class="overview-card-actions"><a class="budget-summary-all-link" href="#reminders" data-page="reminders">全部訂閱</a><button type="button" class="mini-action subscription-summary-toggle ${subscriptionsCollapsed ? 'is-collapsed' : 'is-expanded'}" data-action="toggle-subscription-summary" aria-expanded="${!subscriptionsCollapsed}" aria-label="${subscriptionsCollapsed ? '展開' : '收合'}本月訂閱" title="${subscriptionsCollapsed ? '展開本月訂閱' : '收合本月訂閱'}">${icon('chevron', 14)}</button></div>`;
  const subscriptions = `<section class="finance-panel-card workbench-subscription-card"><div class="finance-panel-card-heading"><h3>本月訂閱</h3>${subscriptionActions}</div><div class="overview-collapsible-content ${subscriptionsCollapsed ? 'is-collapsed' : 'is-expanded'}" aria-hidden="${subscriptionsCollapsed}" ${subscriptionsCollapsed ? 'inert' : ''}>${subscriptionBody}</div></section>`;
  const maxDay = summary.days.reduce((max, day) => day.amount > max ? day.amount : max, 0n);
  const trend = `<section class="finance-panel-card weekly-chart-card"><div class="finance-panel-card-heading"><h3>近七日每日支出</h3></div><div class="weekly-chart" role="img" aria-label="近七日支出：${summary.days.map((day) => `${day.date} ${formatMoney(day.amount)}`).join('；')}">${summary.days.map((day) => `<div class="weekly-chart-column" title="${day.date}：${formatMoney(day.amount)}"><div class="weekly-bar-track"><span style="--bar-height:${percent(day.amount, maxDay)}%;${day.amount === 0n ? 'min-height:0;' : ''}"></span></div><small>${day.date.slice(5)}</small></div>`).join('')}</div></section>`;
  const months = `<section class="finance-panel-card"><div class="finance-panel-card-heading"><h3>近六月收支比較</h3></div><div class="finance-month-table"><div class="finance-month-table-head"><span>月份</span><span>收入</span><span>支出</span></div>${summary.months.map((month) => `<div><span>${month.key}</span><span class="income">${formatMoney(month.income)}</span><span class="expense">${formatMoney(month.expense)}</span></div>`).join('')}</div></section>`;
  const previewExtras = preview ? '<div class="finance-preview-extras"><article><strong>範例預算：餐飲每月 NT$ 1,000</strong><p>已用 NT$ 120；此卡僅示範，不寫入正式預算。</p></article><article><strong>範例提醒：預計支出 NT$ 200</strong><p>下週交通費 · 尚未確認入帳；此卡僅示範，不建立正式提醒。</p></article></div>' : '';
  const previewData = { expenses: records.filter((row) => row.recordType === 'expense'), categoryCatalog: [{ categories: records.filter((row) => row.recordType === 'expense').map((row) => ({ id: row.categoryId, name: row.categoryNameSnapshot })), subcategories: [] }], financePreferences: [{ budgetSchedules: [{ id: 'preview-budget-meal', categoryId: 'preview-meal', effectiveFromMonth: summary.month, amountTwd: 1000 }, { id: 'preview-budget-shopping', categoryId: 'preview-shopping', effectiveFromMonth: summary.month, amountTwd: 1500 }] }] };
  const budgetRows = preview ? calculateMonthlyBudgets(previewData, summary.month) : state.budgetRows ?? null;
  const blocks = { monthly: figures, budget: `<section class="finance-panel-card budget-summary-card">${renderBudgetSummary(budgetRows, config, preview, store)}</section>`, recent, subscriptions };
  const names = { monthly: '本月收支', budget: '預算摘要', recent: '最近記帳', subscriptions: '本月訂閱' };
  const overview = config.blocks.map((id) => `<section class="overview-block" data-overview-kind="block" data-overview-item="${id}"><button type="button" class="overview-drag-handle" data-overview-block-handle aria-label="移動${names[id]}區塊；使用上下方向鍵調整順序" title="拖曳把手可調整區塊順序"><svg class="overview-drag-grip" viewBox="0 0 10 14" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1"/><circle cx="7.5" cy="2.5" r="1"/><circle cx="2.5" cy="7" r="1"/><circle cx="7.5" cy="7" r="1"/><circle cx="2.5" cy="11.5" r="1"/><circle cx="7.5" cy="11.5" r="1"/></svg><span class="visually-hidden">使用上下方向鍵調整${names[id]}區塊順序</span></button>${blocks[id]}</section>`).join('');
  return `${sourceControls}${state.overviewPreferenceError ? `<p class="history-status error" role="status">${escapeHTML(state.overviewPreferenceError)}</p>` : ''}<div class="finance-overview-body ${full ? 'is-full' : ''}">${state.panel === 'analytics' ? `${figures}<div class="finance-panel-columns">${trend}${months}${category}</div>` : `<div class="overview-block-list">${overview}</div>`}${preview ? (state.panel === 'analytics' ? previewExtras : previewExtras.replace(/<article><strong>範例預算[\s\S]*?<\/article>/, '')) : ''}</div>`;
}
