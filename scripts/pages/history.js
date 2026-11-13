import { icon } from '../icons.js';
import { categoryStore, createCategoryStore } from '../category-store.js';
import { escapeHTML } from '../escape-html.js';
import { getRecordCategoryPresentation } from '../category-presentation.js';
import { summarizeHistoryMonth } from './history-summary.js';
import { formatMoney } from './finance-panels.js';

const monthFormatter = new Intl.NumberFormat('zh-TW', { minimumIntegerDigits: 2, useGrouping: false });
const moneyFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function getLocalMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${monthFormatter.format(date.getMonth() + 1)}`;
}

function formatMonthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return `${year} 年 ${month} 月`;
}

function historyCategoryPickerOptions(filters, store = categoryStore) {
  const selectedId = filters.categoryId || '';
  const selected = store.getCategory(selectedId);
  const categories = store.listCategories({ includeHidden: true });
  const options = categories.map((category) => {
    const style = getRecordCategoryPresentation({ categoryId: category.id, recordType: category.entryType }, store);
    return `<button type="button" class="history-category-option ${category.id === selectedId ? 'is-selected' : ''}" role="option" aria-selected="${category.id === selectedId}" data-action="history-filter-category" data-category-id="${escapeHTML(category.id)}" data-category-type="${category.entryType}" data-category-search="${escapeHTML(`${category.name} ${category.entryType === 'income' ? '收入' : '支出'} ${category.hidden ? '已隱藏' : ''}`.toLocaleLowerCase('zh-TW'))}"><span class="history-category-option-icon" style="--history-category-color:${escapeHTML(style.color)}">${icon(style.iconName, 18)}</span><span>${escapeHTML(category.name)}</span><small>${category.entryType === 'income' ? '收入' : '支出'}${category.hidden ? ' · 已隱藏' : ''}</small></button>`;
  }).join('');
  return `<button type="button" class="history-category-option history-category-all ${selected ? '' : 'is-selected'}" role="option" aria-selected="${!selected}" data-action="history-filter-category" data-category-id="" data-category-search="全部分類">${icon('tag', 18)}<span>全部分類</span></button>${options}`;
}

function historyCategoryPicker(filters, store = categoryStore) {
  const selected = store.getCategory(filters.categoryId || '');
  const presentation = selected ? getRecordCategoryPresentation({ categoryId: selected.id, recordType: selected.entryType }, store) : null;
  return `<details class="history-category-filter" data-history-category-picker ${selected ? 'open' : ''}><summary class="history-category-summary" aria-label="依大分類篩選"><span class="history-category-summary-icon" data-history-category-icon ${presentation ? `style="--history-category-color:${escapeHTML(presentation.color)}"` : ''}>${presentation ? icon(presentation.iconName, 16) : icon('tag', 16)}</span><span data-history-category-label>${escapeHTML(selected?.name || '全部分類')}</span><span class="history-category-chevron">${icon('chevron', 14)}</span></summary><div class="history-category-popover"><label class="history-category-search">搜尋分類<input type="search" data-history-category-search placeholder="輸入分類名稱" autocomplete="off"></label><div class="history-category-options" role="listbox" aria-label="選擇大分類">${historyCategoryPickerOptions(filters, store)}</div></div></details>`;
}

function dateParts(dateKey) {
  return dateKey.split('-').map(Number);
}

function weekdayForDate(dateKey) {
  const [year, month, day] = dateParts(dateKey);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return weekdays[date.getUTCDay()];
}

export function updateHistoryTypeSelection(buttons, recordType = '') {
  for (const button of buttons || []) {
    const selected = button.dataset.recordType === recordType;
    button.classList.toggle('is-selected', selected);
    for (const tone of ['all', 'expense', 'income']) {
      button.classList.toggle(tone, selected && (button.dataset.recordType || '') === (tone === 'all' ? '' : tone));
    }
    button.setAttribute('aria-pressed', String(selected));
  }
}

export function formatHistoryDayLabel(dateKey) {
  const [, month, day] = dateParts(dateKey);
  return `${month} 月 ${day} 日・${weekdayForDate(dateKey)}`;
}

function formatTwdMinor(minorValue) {
  const amount = BigInt(minorValue);
  const whole = amount / 100n;
  const fraction = amount % 100n;
  const fractionText = fraction === 0n ? '' : `.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
  return `${moneyFormatter.format(whole)}${fractionText}`;
}

export function createHistoryState() {
  return {
    monthKey: getLocalMonthKey(),
    records: null,
    loading: false,
    error: '',
    filters: { query: '', fromDate: '', toDate: '', recordType: '', categoryId: '', accountId: '' },
    dateDraft: null,
    financeData: null,
    financeSource: 'official-v3',
    canEditRecords: false,
    editDay: '',
    recordEditor: null,
    deleteRecord: null,
    deleteGeneration: null,
    historyNotice: '',
  };
}

export function shiftHistoryMonth(state, offset) {
  if (!Number.isInteger(offset) || offset === 0) return;
  const [year, month] = state.monthKey.split('-').map(Number);
  const monthIndex = year * 12 + month - 1 + offset;
  if (monthIndex < 12 || monthIndex > 119999) return;
  const shiftedYear = Math.floor(monthIndex / 12);
  const shiftedMonth = ((monthIndex % 12) + 12) % 12 + 1;
  state.monthKey = `${shiftedYear}-${monthFormatter.format(shiftedMonth)}`;
}

export function setHistoryToCurrentMonth(state, date = new Date()) {
  state.monthKey = getLocalMonthKey(date);
}

export function filterHistoryRecordsByMonth(records, monthKey) {
  return records.filter((record) => typeof record.occurredOn === 'string' && record.occurredOn.slice(0, 7) === monthKey);
}

export function filterHistoryRecords(records, filters = {}) {
  const query = String(filters.query || '').trim().toLocaleLowerCase('zh-TW');
  return records.filter((record) => {
    if (filters.fromDate && record.occurredOn < filters.fromDate) return false;
    if (filters.toDate && record.occurredOn > filters.toDate) return false;
    if (filters.recordType && record.recordType !== filters.recordType) return false;
    if (filters.categoryId && record.categoryId !== filters.categoryId) return false;
    if (filters.accountId === '__unassigned' && record.accountId) return false;
    if (filters.accountId && filters.accountId !== '__unassigned' && record.accountId !== filters.accountId) return false;
    if (query) {
      const text = [record.note, record.categoryNameSnapshot, record.subcategoryNameSnapshot, record.accountNameSnapshot]
        .filter((value) => typeof value === 'string').join(' ').toLocaleLowerCase('zh-TW');
      if (!text.includes(query)) return false;
    }
    return true;
  });
}

export function groupHistoryRecordsByDate(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.occurredOn)) groups.set(record.occurredOn, []);
    groups.get(record.occurredOn).push(record);
  }
  return [...groups.entries()]
    .sort(([leftDate], [rightDate]) => rightDate.localeCompare(leftDate))
    .map(([date, entries]) => ({
      date,
      records: entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      expenseTotalMinor: entries.filter((record) => record.recordType === 'expense').reduce((total, record) => total + BigInt(record.amountMinor), 0n),
      incomeTotalMinor: entries.filter((record) => record.recordType === 'income').reduce((total, record) => total + BigInt(record.amountMinor), 0n),
    }));
}

export function renderHistoryPage(page, state) {
  const currentMonth = state.monthKey === getLocalMonthKey();
  const filters = state.filters || {};
  const dateDraft = state.dateDraft || filters;
  const dateLabel = filters.fromDate || filters.toDate
    ? `${filters.fromDate ? shortHistoryDate(filters.fromDate) : '開始不限'}–${filters.toDate ? shortHistoryDate(filters.toDate) : '結束不限'}`
    : '日期範圍';
  const hasFilters = ['categoryId', 'recordType', 'fromDate', 'toDate', 'query', 'accountId'].some((key) => Boolean(filters[key]));
  return `
    <div class="page-heading inner-page-heading history-heading finance-page-heading">
      <div class="history-heading-content">
        <div class="eyebrow finance-page-eyebrow"><span class="eyebrow-spark">${icon('history', 15)}</span> TRANSACTION HISTORY</div>
        <div class="history-title-row"><h1>${page.title}</h1>
          <div class="history-toolbar" aria-label="歷史紀錄月份篩選">
            <div class="history-month-control" role="group" aria-label="切換月份">
              <button class="history-month-button" type="button" data-action="history-month-shift" data-month-offset="-1" aria-label="上一個月">${icon('chevron', 17)}</button>
              <strong class="history-month-label" data-history-month>${formatMonthLabel(state.monthKey)}</strong>
              <button class="history-month-button is-next" type="button" data-action="history-month-shift" data-month-offset="1" aria-label="下一個月">${icon('chevron', 17)}</button>
            </div>
            <button class="history-current-month-button ${currentMonth ? 'is-current' : ''}" type="button" data-action="history-month-current" aria-disabled="${currentMonth}" ${currentMonth ? 'disabled' : ''}>本月</button>
            <span class="history-count" data-history-count aria-live="polite">讀取中</span>
          </div>
        </div>
        <p class="page-subtitle" data-operation-hint>查看每一天已保存的收入與支出紀錄。</p>
      </div>
    </div>
    <section class="history-filter-toolbar" aria-label="搜尋及篩選歷史紀錄">
      <div class="history-category-filter-wrap"><span class="history-filter-label">大分類</span>${historyCategoryPicker(filters, historyFinanceStore(state))}</div>
      <div class="history-type-filter" role="group" aria-label="收支類型篩選">${[['', '全部'], ['income', '收入'], ['expense', '支出']].map(([type, label]) => `<button type="button" class="history-type-option ${((filters.recordType || '') === type) ? `is-selected ${type || 'all'}` : ''}" data-action="history-filter-type" data-record-type="${type}" aria-pressed="${(filters.recordType || '') === type}">${label}</button>`).join('')}</div>
      <details class="history-date-range-picker"><summary data-history-date-label>${escapeHTML(dateLabel)}</summary><div class="history-date-range-popover"><label>開始日期<input type="date" data-history-date-draft="fromDate" value="${escapeHTML(dateDraft.fromDate || '')}"></label><label>結束日期<input type="date" data-history-date-draft="toDate" value="${escapeHTML(dateDraft.toDate || '')}"></label><p class="history-date-error" data-history-date-error role="alert"></p><div class="history-date-actions"><button type="button" class="quiet-button" data-action="history-filter-date-clear">清除日期</button><button type="button" class="primary-button" data-action="history-filter-date-apply">套用</button></div></div></details>
      <label class="history-query-filter">文字搜尋<input type="search" data-history-filter="query" value="${escapeHTML(filters.query || '')}" placeholder="備註、分類或帳戶"></label>
      <details class="history-filter-more"><summary>更多篩選</summary><label>帳戶<select data-history-filter="accountId"><option value="">全部帳戶</option><option value="__unassigned" ${filters.accountId === '__unassigned' ? 'selected' : ''}>未指定帳戶</option></select></label></details>
      <button class="quiet-button history-filter-clear ${hasFilters ? '' : 'is-idle'}" type="button" data-action="history-filter-clear">清除條件</button>
    </section>
    <div class="history-layout-container"><div class="history-workspace">
      <section class="history-transactions" aria-label="當月交易清單"><p class="history-status" data-history-status role="status" aria-live="polite">正在載入紀錄…</p><div class="history-day-list" data-history-list aria-live="polite"></div></section>
      <aside class="history-month-overview" data-history-summary aria-label="選定月份總覽" aria-live="polite"><p class="finance-empty">正在讀取月份總覽…</p></aside>
    </div></div><div data-history-delete-modal-root></div>`;
}

function shortHistoryDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${Number(match[2])}/${Number(match[3])}` : '';
}

const shortDate = (date) => { const [, month, day] = date.split('-'); return `${Number(month)}/${Number(day)}`; };
const dateRange = (start, end) => start === end ? shortDate(start) : `${shortDate(start)}–${shortDate(end)}`;

export function renderHistoryMonthOverview(records, monthKey, store = categoryStore) {
  const summary = summarizeHistoryMonth(records, monthKey);
  return `<div class="history-overview-heading"><h2>${formatMonthLabel(monthKey)}</h2><span>月份總覽</span></div>
    <dl class="history-month-metrics"><div><dt>收入</dt><dd class="income">${formatMoney(summary.income)}</dd></div><div><dt>支出</dt><dd class="expense">${formatMoney(summary.expense)}</dd></div><div><dt>淨額</dt><dd>${formatMoney(summary.net)}</dd></div></dl><p class="history-overview-note">本月收入減支出，非帳戶餘額。</p>
    <section class="history-category-overview"><h3>主要支出分類</h3>${summary.categories.length ? summary.categories.slice(0, 5).map((item) => {
      const category = store.getCategory(item.id);
      const presentation = getRecordCategoryPresentation({ categoryId: item.id, recordType: 'expense' }, store);
      return `<div class="history-category-total"><span class="history-summary-icon" style="--record-category-color:${escapeHTML(presentation.color)}">${icon(presentation.iconName, 16)}</span><strong>${escapeHTML(category?.entryType === 'expense' ? category.name : item.name)}</strong><span>${formatMoney(item.amount)}</span></div>`;
    }).join('') : '<p class="finance-empty">本月尚無支出。</p>'}</section>
    <section class="history-week-overview"><h3>逐週支出</h3><p class="history-overview-note">週一至週日，首尾週僅計入本月日期。</p>${summary.weeks.map((week) => `<div class="history-week-total"><div><strong>${dateRange(week.calendarStart, week.calendarEnd)}</strong>${week.startDate !== week.calendarStart || week.endDate !== week.calendarEnd ? `<small>本月計入 ${dateRange(week.startDate, week.endDate)}</small>` : ''}</div><span>${formatMoney(week.expense)}</span></div>`).join('')}</section>`;
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

export function getHistoryRecordLabels(record) {
  const hasSubcategory = typeof record.subcategoryNameSnapshot === 'string' && record.subcategoryNameSnapshot.length > 0;
  return {
    title: hasSubcategory ? record.subcategoryNameSnapshot : record.categoryNameSnapshot,
    description: `${hasSubcategory || record.recordType === 'expense' ? record.categoryNameSnapshot : '收入'}・${record.note || '無備註'}`,
  };
}

function renderRecordCard(record, state, store) {
  const article = document.createElement('article');
  article.className = `history-record${state.canEditRecords && state.editDay === record.occurredOn ? ' is-editable' : ''}`;

  const categoryIcon = document.createElement('span');
  categoryIcon.className = 'history-record-icon';
  const presentation = getRecordCategoryPresentation(record, store);
  categoryIcon.style.setProperty('--history-category-color', presentation.color);
  categoryIcon.innerHTML = icon(presentation.iconName, 18);

  const details = document.createElement('div');
  details.className = 'history-record-details';
  const isIncome = record.recordType === 'income';
  const labels = getHistoryRecordLabels(record);
  details.append(createTextElement('strong', 'history-record-subcategory', labels.title));
  details.append(createTextElement('span', 'history-record-description', labels.description));

  const amount = createTextElement('strong', `history-record-amount ${isIncome ? 'income' : 'expense'}`, `${isIncome ? '+' : '−'}NT$${formatTwdMinor(record.amountMinor)}`);
  article.dataset.historyRecordId = record.id;
  article.append(categoryIcon, details, amount);
  if (state.canEditRecords && state.editDay === record.occurredOn) {
    const actions = document.createElement('div');
    actions.className = 'history-record-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'history-record-action'; edit.dataset.action = 'history-open-edit'; edit.dataset.recordId = record.id; edit.setAttribute('aria-label', `編輯${labels.title}`); edit.title = '編輯'; edit.innerHTML = icon('pencil', 14);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'history-record-action is-danger'; remove.dataset.action = 'history-open-delete'; remove.dataset.recordId = record.id; remove.setAttribute('aria-label', `刪除${labels.title}`); remove.title = '刪除'; remove.innerHTML = icon('trash', 14);
    actions.append(edit, remove); article.append(actions);
  }
  return article;
}

function renderDayGroup(group, state, store) {
  const section = document.createElement('section');
  section.className = 'history-day-group';

  const heading = document.createElement('header');
  heading.className = 'history-day-heading';
  const title = document.createElement('div'); title.className = 'history-day-title';
  title.append(createTextElement('h2', '', formatHistoryDayLabel(group.date)));
  if (state.canEditRecords) {
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = `history-day-edit-toggle ${state.editDay === group.date ? 'is-active' : ''}`; toggle.dataset.action = 'history-toggle-day-edit'; toggle.dataset.historyDay = group.date; toggle.setAttribute('aria-pressed', String(state.editDay === group.date)); toggle.setAttribute('aria-label', `${state.editDay === group.date ? '結束' : '編輯'}${formatHistoryDayLabel(group.date)}紀錄`); toggle.title = state.editDay === group.date ? '收起紀錄操作' : '編輯這一天'; toggle.innerHTML = icon('pencil', 14); title.append(toggle);
  }
  heading.append(title);
  const totals = document.createElement('div');
  totals.className = 'history-day-totals';
  if (group.expenseTotalMinor > 0n) totals.append(createTextElement('span', 'expense', `當日支出 NT$${formatTwdMinor(group.expenseTotalMinor)}`));
  if (group.incomeTotalMinor > 0n) totals.append(createTextElement('span', 'income', `當日收入 +NT$${formatTwdMinor(group.incomeTotalMinor)}`));
  heading.append(totals);

  const records = document.createElement('div');
  records.className = 'history-day-records';
  group.records.forEach((record) => records.append(renderRecordCard(record, state, store)));
  section.append(heading, records);
  return section;
}

function historyFinanceStore(state) {
  const catalog = state.financeData?.categoryCatalog?.[0];
  return catalog ? createCategoryStore({ catalog, ready: true }) : categoryStore;
}

function amountMinorInput(value) {
  const amount = BigInt(value);
  const whole = amount / 100n;
  const fraction = amount % 100n;
  if (!fraction) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

function editChoiceFields({ index, draft, entryType, data, store, split = false }) {
  const field = (name) => split ? `data-history-split-field="${name}" data-history-split-index="${index}"` : `data-history-edit-field="${name}"`;
  const categories = store.listCategories({ entryType, includeHidden: false });
  const categoryExists = categories.some((item) => item.id === draft.categoryId);
  const categoryOptions = `${!categoryExists && draft.categoryId ? `<option value="${escapeHTML(draft.categoryId)}" selected>原分類已失效，請重新選擇</option>` : '<option value="">請選擇大分類</option>'}${categories.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === draft.categoryId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}`;
  const children = store.listSubcategories(draft.categoryId, { includeHidden: false });
  const childExists = children.some((item) => item.id === draft.subcategoryId);
  const childOptions = `${!childExists && draft.subcategoryId ? `<option value="${escapeHTML(draft.subcategoryId)}" selected>原子分類已失效，請重新選擇</option>` : '<option value="">請選擇子分類</option>'}${children.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === draft.subcategoryId ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}`;
  const accounts = data.accounts || [];
  const currentAccount = accounts.find((item) => item.id === draft.accountId);
  const activeAccounts = accounts.filter((item) => item.active);
  const accountOptions = `${!currentAccount && draft.accountId ? `<option value="${escapeHTML(draft.accountId)}" selected>原帳戶資料已失效，請重新選擇</option>` : ''}${currentAccount && !currentAccount.active ? `<option value="${escapeHTML(currentAccount.id)}" selected>已停用：${escapeHTML(currentAccount.name)}（保留原值）</option>` : ''}<option value="">未指定帳戶</option>${activeAccounts.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === draft.accountId ? 'selected' : ''}>${escapeHTML(item.name)} · ${item.type === 'cash' ? '現金' : '銀行'}</option>`).join('')}`;
  const methods = [['direct', '直接收付'], ['cash', '現金'], ['convenience-store', '超商繳費'], ['bank-transfer', '銀行轉帳'], ['debit-card', '簽帳金融卡']];
  return `<label>日期<input type="date" ${field('date')} value="${escapeHTML(draft.date || '')}"></label>
    <label>金額（元）<input inputmode="decimal" autocomplete="off" ${field('amountTwd')} value="${escapeHTML(draft.amountTwd || '')}" aria-describedby="${split ? `history-split-amount-${index}` : 'history-edit-amount-help'}"></label>
    <label>大分類<select ${field('categoryId')}>${categoryOptions}</select></label>
    <label>子分類<select ${field('subcategoryId')}>${childOptions}</select></label>
    <label>付款／收款帳戶<select ${field('accountId')}>${accountOptions}</select></label>
    <label>付款／收款方式<select ${field('paymentMethod')}>${methods.map(([value, label]) => `<option value="${value}" ${(draft.paymentMethod || 'direct') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label class="history-editor-note">備註<input type="text" maxlength="160" ${field('note')} value="${escapeHTML(draft.note || '')}"></label>
    ${split ? `<small id="history-split-amount-${index}" class="history-editor-help">每筆須為正整數元；拆分總額可與原紀錄不同。</small>` : ''}`;
}

function renderHistoryEditPanel(state) {
  const editor = state.recordEditor;
  const data = state.financeData;
  const source = editor && [...(data?.expenses || []), ...(data?.incomes || [])].find((item) => item.id === editor.recordId);
  if (!editor || !source) return '<p class="finance-empty">找不到這筆紀錄；請重新載入歷史資料。</p>';
  const typeLabel = source.recordType === 'income' ? '收入' : '支出';
  const labels = getHistoryRecordLabels(source);
  const store = historyFinanceStore(state);
  const occurrence = source.reminderOccurrenceId ? data.reminderOccurrences.find((item) => item.id === source.reminderOccurrenceId) : null;
  const movement = source.financeEventId ? data.accountEvents.find((item) => item.id === source.financeEventId) : null;
  const unsupportedBreakdown = (Array.isArray(movement?.lines) && movement.lines.length > 1)
    || ['items', 'lineItems', 'paymentSplits', 'accountAllocations', 'payments'].some((field) => Array.isArray(source[field]) && source[field].length > 0);
  const breakdownWarning = unsupportedBreakdown ? '<p class="history-editor-warning" role="alert">這筆紀錄包含多筆付款或商品明細。目前的單筆編輯表單無法安全調整，請保留原紀錄；刪除仍會一併撤銷整筆帳戶異動。</p>' : '';
  if (editor.splitMode) {
    const rows = (editor.splits || []).map((draft, index) => `<section class="history-split-row"><div class="history-split-row-heading"><strong>拆分項目 ${index + 1}</strong>${index > 1 ? `<button type="button" class="quiet-button" data-action="history-remove-split-row" data-split-index="${index}">移除此項</button>` : ''}</div><div class="history-editor-fields">${editChoiceFields({ index, draft, entryType: source.recordType, data, store, split: true })}</div></section>`).join('');
    return `<div class="history-editor-heading"><div><span class="history-editor-badge">隔離 V4 驗收資料</span><h2>拆分${typeLabel}紀錄</h2><p>原紀錄 NT$${formatTwdMinor(source.amountMinor)}；拆分後會取代原紀錄，各筆獨立顯示。總額可以不同。</p></div></div>${breakdownWarning}${occurrence ? '<p class="history-editor-warning" role="alert">這筆紀錄已連結提醒期次，為保留提醒與交易關聯，目前不能拆分。</p>' : source.amountMinor % 100 !== 0 ? '<p class="history-editor-warning" role="alert">此舊紀錄含分金額，拆分會改變精度，因此不能拆分。</p>' : ''}${state.historyNotice ? `<p class="history-editor-notice ${state.historyNoticeTone || ''}" role="status">${escapeHTML(state.historyNotice)}</p>` : ''}<div class="history-split-list">${rows}</div><button type="button" class="quiet-button" data-action="history-add-split-row" ${editor.splits.length >= 20 ? 'disabled' : ''}>新增拆分項目</button><div class="history-editor-actions"><button type="button" class="quiet-button" data-action="history-cancel-edit">取消</button><button type="button" class="primary-button" data-action="history-save-split" ${unsupportedBreakdown || occurrence || source.amountMinor % 100 !== 0 || editor.splits.length < 2 || editor.saving ? 'disabled' : ''}>儲存拆分</button></div>`;
  }
  return `<div class="history-editor-heading"><div><span class="history-editor-badge">隔離 V4 驗收資料</span><h2>編輯${typeLabel}</h2><p>${escapeHTML(labels.title)} · 原建立時間保留</p></div></div>${breakdownWarning}${occurrence ? '<p class="history-editor-help">這筆交易與已完成提醒連結；編輯後會保留原交易關聯。</p>' : ''}${state.historyNotice ? `<p class="history-editor-notice ${state.historyNoticeTone || ''}" role="status">${escapeHTML(state.historyNotice)}</p>` : ''}<div class="history-editor-fields">${editChoiceFields({ index: 0, draft: editor.draft, entryType: source.recordType, data, store })}</div><p id="history-edit-amount-help" class="history-editor-help">新金額使用整數元；舊紀錄若含分，未修改金額時會原值保留。</p><div class="history-editor-actions"><button type="button" class="quiet-button" data-action="history-cancel-edit">取消</button><button type="button" class="quiet-button" data-action="history-enter-split" ${unsupportedBreakdown || occurrence || source.amountMinor % 100 !== 0 || editor.saving ? 'disabled title="此紀錄目前不能拆分"' : ''}>拆分紀錄</button><button type="button" class="primary-button" data-action="history-save-edit" ${unsupportedBreakdown || editor.saving ? 'disabled title="此紀錄含目前表單無法安全調整的明細"' : ''}>儲存修改</button></div>`;
}

function renderHistoryDeleteDialog(state) {
  const row = state.deleteRecord;
  if (!row) return '';
  const title = getHistoryRecordLabels(row).title;
  return `<div class="history-delete-backdrop" role="presentation"><section class="history-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="history-delete-title"><h2 id="history-delete-title">刪除這筆紀錄？</h2><p><strong>${escapeHTML(title)}</strong></p><p>${escapeHTML(row.occurredOn)} · ${row.recordType === 'income' ? '收入' : '支出'} NT$${formatTwdMinor(row.amountMinor)}</p><p class="history-editor-help">如已被提醒或其他資料引用，系統會保護關聯並拒絕刪除。</p>${state.historyNotice ? `<p class="history-editor-notice error" role="alert">${escapeHTML(state.historyNotice)}</p>` : ''}<div class="history-editor-actions"><button type="button" class="quiet-button" data-action="history-cancel-delete" ${state.deletingRecord ? 'disabled' : ''}>取消</button><button type="button" class="danger-button" data-action="history-confirm-delete" ${state.deletingRecord ? 'disabled' : ''}>確認刪除</button></div></section></div>`;
}

export function renderHistoryContents(root, state) {
  const list = root.querySelector('[data-history-list]');
  const status = root.querySelector('[data-history-status]');
  const monthLabel = root.querySelector('[data-history-month]');
  const count = root.querySelector('[data-history-count]');
  const currentMonthButton = root.querySelector('[data-action="history-month-current"]');
  const clearButton = root.querySelector('[data-action="history-filter-clear"]');
  const dateLabel = root.querySelector('[data-history-date-label]');
  const summary = root.querySelector('[data-history-summary]');
  const deleteModal = root.querySelector('[data-history-delete-modal-root]');
  if (!list || !status || !monthLabel || !count) return;

  const filters = state.filters || {};
  const store = historyFinanceStore(state);
  updateHistoryTypeSelection(root.querySelectorAll?.('[data-action="history-filter-type"]') || [], filters.recordType || '');
  const categoryPicker = root.querySelector('[data-history-category-picker]');
  const categoryOptions = root.querySelector('.history-category-options');
  if (categoryPicker && categoryOptions && typeof store.exportCatalog === 'function') {
    const catalogSnapshot = JSON.stringify(store.exportCatalog());
    if (categoryPicker.dataset.catalogSnapshot !== catalogSnapshot) {
      const wasOpen = categoryPicker.open;
      const searchInput = root.querySelector('[data-history-category-search]');
      const searchValue = searchInput?.value || '';
      categoryOptions.innerHTML = historyCategoryPickerOptions(filters, store);
      categoryPicker.dataset.catalogSnapshot = catalogSnapshot;
      categoryPicker.open = wasOpen;
      if (searchInput) searchInput.value = searchValue;
    }
  }
  const selectedCategory = filters.categoryId ? store.getCategory(filters.categoryId) : null;
  const categoryLabel = root.querySelector('[data-history-category-label]');
  const categoryIcon = root.querySelector('[data-history-category-icon]');
  if (categoryLabel) categoryLabel.textContent = selectedCategory?.name || '全部分類';
  if (categoryIcon) {
    const presentation = selectedCategory ? getRecordCategoryPresentation({ categoryId: selectedCategory.id, recordType: selectedCategory.entryType }, store) : null;
    categoryIcon.style.setProperty('--history-category-color', presentation?.color || '#9297a3');
    categoryIcon.innerHTML = icon(presentation?.iconName || 'tag', 16);
  }
  const categoryQuery = root.querySelector('[data-history-category-search]')?.value.trim().toLocaleLowerCase('zh-TW') || '';
  (root.querySelectorAll?.('[data-action="history-filter-category"]') || []).forEach((button) => {
    const selected = button.dataset.categoryId === (filters.categoryId || '');
    const typeMatches = !filters.recordType || !button.dataset.categoryType || button.dataset.categoryType === filters.recordType;
    const queryMatches = (button.dataset.categorySearch || '').includes(categoryQuery);
    button.hidden = !typeMatches || !queryMatches;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  const hasFilters = ['categoryId', 'recordType', 'fromDate', 'toDate', 'query', 'accountId'].some((key) => Boolean(filters[key]));
  clearButton?.classList.toggle('is-idle', !hasFilters);
  if (dateLabel) dateLabel.textContent = filters.fromDate || filters.toDate
    ? `${filters.fromDate ? shortHistoryDate(filters.fromDate) : '開始不限'}–${filters.toDate ? shortHistoryDate(filters.toDate) : '結束不限'}`
    : '日期範圍';
  const fromDate = root.querySelector('[data-history-date-draft="fromDate"]');
  const toDate = root.querySelector('[data-history-date-draft="toDate"]');
  if (fromDate) fromDate.value = (state.dateDraft || filters).fromDate || '';
  if (toDate) toDate.value = (state.dateDraft || filters).toDate || '';
  const accountSelect = root.querySelector('[data-history-filter="accountId"]');
  if (accountSelect && Array.isArray(state.records)) {
    const selected = filters.accountId;
    const accounts = [...new Map(state.records.filter((item) => item.accountId).map((item) => [item.accountId, item.accountNameSnapshot || `帳戶 ${item.accountId}`])).entries()];
    accountSelect.innerHTML = `<option value="">全部帳戶</option><option value="__unassigned">未指定帳戶</option>${accounts.map(([id, name]) => `<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('')}`;
    accountSelect.value = selected;
  }

  monthLabel.textContent = formatMonthLabel(state.monthKey);
  if (currentMonthButton) {
    const isCurrent = state.monthKey === getLocalMonthKey();
    currentMonthButton.classList.toggle('is-current', isCurrent);
    currentMonthButton.setAttribute('aria-disabled', String(isCurrent));
    currentMonthButton.disabled = isCurrent;
  }
  list.replaceChildren();

  if (state.loading) {
    if (summary) summary.innerHTML = state.recordEditor ? renderHistoryEditPanel(state) : '<p class="finance-empty">正在讀取月份總覽…</p>';
    if (deleteModal) deleteModal.innerHTML = renderHistoryDeleteDialog(state);
    count.textContent = '載入中';
    status.hidden = false;
    status.className = 'history-status';
    status.textContent = '正在載入紀錄…';
    return;
  }
  if (state.error) {
    if (summary) summary.innerHTML = state.recordEditor ? renderHistoryEditPanel(state) : '<p class="finance-empty">月份總覽暫時無法讀取。</p>';
    if (deleteModal) deleteModal.innerHTML = renderHistoryDeleteDialog(state);
    count.textContent = '無法讀取';
    status.hidden = false;
    status.className = 'history-status error';
    status.textContent = state.error;
    return;
  }

  const monthRecords = filterHistoryRecords(filterHistoryRecordsByMonth(state.records || [], state.monthKey), filters);
  if (summary) summary.innerHTML = state.recordEditor ? renderHistoryEditPanel(state) : renderHistoryMonthOverview(monthRecords, state.monthKey, store);
  if (deleteModal) deleteModal.innerHTML = renderHistoryDeleteDialog(state);
  count.textContent = `${monthRecords.length} 筆`;
  status.hidden = monthRecords.length > 0 && !state.historyNotice;
  status.className = `history-status${state.historyNoticeTone ? ` ${state.historyNoticeTone}` : ''}`;
  status.textContent = state.historyNotice || (monthRecords.length ? '' : '本月沒有已保存的紀錄。');
  if (!monthRecords.length) return;

  groupHistoryRecordsByDate(monthRecords).forEach((group) => list.append(renderDayGroup(group, state, store)));
}
