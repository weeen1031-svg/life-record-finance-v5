import { calendarMonthWeeks, summarizeHistoryMonth } from '../scripts/pages/history-summary.js';
import { createHistoryState, renderHistoryPage, renderHistoryMonthOverview, renderHistoryContents, updateHistoryTypeSelection, shiftHistoryMonth, filterHistoryRecords } from '../scripts/pages/history.js';
import { getRecordCategoryPresentation } from '../scripts/category-presentation.js';
import { createCategoryStore } from '../scripts/category-store.js';
import { createEntryDraft, renderAddEntryForm } from '../scripts/pages/add-entry.js';
import { renderFinancePanel } from '../scripts/pages/finance-panels.js';
import { createBackupPageState, renderLedgerBackupPage } from '../scripts/pages/ledger-backup.js';
import { loadOperationHints, saveOperationHints, OPERATION_HINTS_KEY } from '../scripts/ui/operation-hints.js';
import { captureSortPositions, animateSortPositions, previewSortMove, restoreSortPreview, resolveSortDropIndex } from '../scripts/ui/sort-animation.js';
import { icon } from '../scripts/icons.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
function throws(action) { try { action(); } catch { return; } throw new Error('Expected rejection'); }
const row = (date, amount, type = 'expense') => ({ id: `synthetic-${date}-${type}`, recordType: type, occurredOn: date, amountMinor: amount, createdAt: `${date}T12:00:00.000Z`, categoryId: type === 'expense' ? 'cat-food' : 'income-other', categoryNameSnapshot: type === 'expense' ? '吃' : '其他收入' });

export async function runHistoryInterfaceTests() {
  const tests = []; const test = (name, action) => tests.push({ name, action });
  test('月份實際跨越 4、5、6 個日曆週，週一至週日且日期不重疊', () => {
    for (const [month, expected, dayCount] of [['2021-02', 4, 28], ['2024-02', 5, 29], ['2026-11', 6, 30]]) {
      const weeks = calendarMonthWeeks(month); assert(weeks.length === expected, `wrong week count: ${month}`);
      let days = 0;
      weeks.forEach((week, index) => {
        assert(new Date(`${week.calendarStart}T00:00:00Z`).getUTCDay() === 1 && new Date(`${week.calendarEnd}T00:00:00Z`).getUTCDay() === 0, 'calendar boundaries are not Monday/Sunday');
        assert(week.startDate.startsWith(month) && week.endDate.startsWith(month), 'counted range crossed month');
        days += (Date.parse(`${week.endDate}T00:00:00Z`) - Date.parse(`${week.startDate}T00:00:00Z`)) / 86400000 + 1;
        if (index) assert(Date.parse(`${week.startDate}T00:00:00Z`) - Date.parse(`${weeks[index - 1].endDate}T00:00:00Z`) === 86400000, 'weeks overlap or omit a day');
      });
      assert(days === dayCount, 'calendar days lost');
    }
    assert(calendarMonthWeeks('1900-02').at(-1).endDate === '1900-02-28', '1900 treated as leap year');
    assert(calendarMonthWeeks('2000-02').at(-1).endDate === '2000-02-29', '2000 leap day missing');
    throws(() => calendarMonthWeeks('2026-13'));
  });
  test('歷史頁使用標題與月份工具同列的明確結構，返回鍵由共用控制加入工具列', () => {
    const html = renderHistoryPage({ title: '歷史紀錄' }, { monthKey: '2026-11', filters: {} });
    const heading = html.slice(html.indexOf('history-heading'), html.indexOf('history-filter-toolbar'));
    assert(heading.includes('<div class="history-title-row"><h1>歷史紀錄</h1>') && heading.includes('history-toolbar'), '標題與月份工具列沒有同屬水平標題列');
    assert(!heading.includes('data-action="app-back"'), '歷史頁不應自行新增第二個返回按鈕；由共用頁首控制放在右側');
    const toolbar = html.slice(html.indexOf('history-toolbar'), html.indexOf('history-filter-toolbar'));
    assert(!toolbar.includes('app-back-control'), '靜態頁面不應自行產生返回按鈕；由共用接線加入並與月份工具同列');
  });
  test('本月按鈕固定存在，當月停用、其他月份可返回，筆數保持獨立欄位', () => {
    const state = createHistoryState();
    const current = renderHistoryPage({ title: '歷史紀錄' }, state);
    assert(current.includes('data-action="history-month-current" aria-disabled="true" disabled>本月</button>'), '目前月份的固定按鈕應保留但停用');
    shiftHistoryMonth(state, -1);
    const other = renderHistoryPage({ title: '歷史紀錄' }, state);
    assert(other.includes('data-action="history-month-current" aria-disabled="false" >本月</button>'), '切換月份後沒有可操作的本月按鈕');
    const toolbar = other.slice(other.indexOf('class="history-toolbar"'), other.indexOf('class="history-filter-toolbar"'));
    assert(toolbar.indexOf('class="history-month-control"') < toolbar.indexOf('data-action="history-month-current"') && toolbar.indexOf('data-action="history-month-current"') < toolbar.indexOf('data-history-count'), '本月按鈕或筆數的位置不穩定');
  });
  test('歷史篩選欄依分類、類型、日期按鈕、文字、更多與清除排列', () => {
    const html = renderHistoryPage({ title: '歷史紀錄' }, { monthKey: '2026-11', filters: {} });
    const order = ['class="history-category-filter-wrap"', 'data-action="history-filter-type"', 'class="history-date-range-picker"', 'data-history-filter="query"', 'class="history-filter-more"', 'data-action="history-filter-clear"'].map((marker) => html.indexOf(marker));
    assert(order.every((position) => position >= 0) && order.every((position, index) => index === 0 || position > order[index - 1]), '歷史篩選欄順序錯誤');
    const typeLabels = [...html.matchAll(/class="history-type-option[^\"]*"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);
    assert(typeLabels.join('|') === '全部|收入|支出' && html.includes('data-history-category-search') && html.includes('data-category-type="expense"') && html.includes('data-category-type="income"'), '類型選項順序或可搜尋圖示分類選擇器未呈現全部收支分類');
    assert(html.includes('data-history-date-draft="fromDate"') && html.includes('data-history-date-draft="toDate"') && html.includes('data-action="history-filter-date-apply"') && html.includes('data-action="history-filter-date-clear"'), '日期範圍沒有浮動面板及套用／清除入口');
    assert(!html.includes('class="history-date-range"'), '日期欄位仍直接佔用篩選列空間');
    assert(html.includes('class="history-type-option is-selected all"') && html.includes('aria-pressed="true"'), '初始全部收支選取狀態不明顯');
    for (const [type, tone] of [['expense', 'expense'], ['income', 'income']]) {
      const typed = renderHistoryPage({ title: '歷史紀錄' }, { monthKey: '2026-11', filters: { recordType: type } });
      assert(typed.includes(`class="history-type-option is-selected ${tone}"`) && typed.includes(`data-record-type="${type}" aria-pressed="true"`), `${type} selected-state class or aria marker missing`);
    }
  });
  test('歷史收支類型切換會同步色彩 class 與 aria 狀態', () => {
    const buttons = ['', 'income', 'expense'].map((recordType) => {
      const classes = new Set();
      return { dataset: { recordType }, classes, classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } }, setAttribute(name, value) { this[name] = value; } };
    });
    for (const [type, tone, index] of [['', 'all', 0], ['income', 'income', 1], ['expense', 'expense', 2]]) {
      updateHistoryTypeSelection(buttons, type);
      assert(buttons[index].classes.has('is-selected') && buttons[index].classes.has(tone) && buttons[index]['aria-pressed'] === 'true', `${tone} selection tone was lost after a filter change`);
      assert(buttons.filter((_, buttonIndex) => buttonIndex !== index).every((button) => !button.classes.has('is-selected') && button['aria-pressed'] === 'false'), 'more than one history type remained selected');
    }
  });
  test('歷史搜尋可依文字、日期、收支類型、分類及帳戶交集篩選，舊資料可選未指定帳戶', () => {
    const rows = [
      { ...row('2026-11-02', 10000), note: '早餐', accountId: 'cash-1' },
      { ...row('2026-11-03', 20000), note: '加油', accountId: 'bank-1' },
      { ...row('2026-11-04', 30000, 'income'), note: '薪資' },
    ];
    const result = filterHistoryRecords(rows, { query: '加油', fromDate: '2026-11-03', toDate: '2026-11-30', recordType: 'expense', categoryId: 'cat-food', accountId: 'bank-1' });
    assert(result.length === 1 && result[0].id === rows[1].id, 'combined history filters did not match');
    assert(filterHistoryRecords(rows, { accountId: '__unassigned' }).length === 1 && filterHistoryRecords(rows, { recordType: 'income' }).length === 1, 'legacy account-less record or income filter failed');
    assert(filterHistoryRecords(rows, { fromDate: '2026-11-05' }).length === 0, 'date lower bound ignored');
  });
  test('首尾週只計本月，收入不混入支出，每週合計等於月支出', () => {
    const records = [row('2026-10-31', 99900), row('2026-11-01', 10000), row('2026-11-30', 20000), row('2026-12-01', 88800), row('2026-11-01', 40000, 'income')];
    const before = JSON.stringify(records); const result = summarizeHistoryMonth(records, '2026-11');
    assert(result.expense === 30000n && result.income === 40000n && result.net === 10000n && result.count === 3, 'monthly totals mixed dates or types');
    assert(result.weeks[0].expense === 10000n && result.weeks.at(-1).expense === 20000n, 'partial weeks wrong');
    assert(result.weeks.reduce((total, week) => total + week.expense, 0n) === result.expense, 'week totals disagree with month');
    assert(JSON.stringify(records) === before, 'summary mutated records');
  });
  test('空月份與超過 Number 安全整數的累計仍正確', () => {
    const empty = summarizeHistoryMonth([], '2026-11'); assert(empty.weeks.length === 6 && empty.income === 0n && empty.expense === 0n, 'empty month wrong');
    const large = summarizeHistoryMonth([row('2026-11-01', Number.MAX_SAFE_INTEGER), row('2026-11-02', Number.MAX_SAFE_INTEGER)], '2026-11');
    assert(large.expense === BigInt(Number.MAX_SAFE_INTEGER) * 2n && large.net === -large.expense, 'total lost integer precision');
    const state = { monthKey: '2026-12' }; shiftHistoryMonth(state, 1); assert(state.monthKey === '2027-01', 'year rollover wrong');
    shiftHistoryMonth(state, -1); assert(state.monthKey === '2026-12', 'previous month wrong');
    state.monthKey = '0001-01'; shiftHistoryMonth(state, -1); assert(state.monthKey === '0001-01', 'month underflow allowed');
  });
  test('候選 V4 歷史紀錄按日期展開操作，編輯面板取代月份總覽且刪除確認置中', () => {
    const originalDocument = globalThis.document;
    const fakeElement = () => {
      const classes = new Set();
      return {
        children: [], dataset: {}, style: { setProperty() {} }, classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
        append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = [...children]; }, setAttribute(name, value) { this[name] = value; },
        textContent: '', innerHTML: '', className: '', title: '', hidden: false,
      };
    };
    const financeRow = { ...row('2026-11-07', 20000), id: 'exp_00000000-0000-4000-8000-000000000007', note: '手機費', subcategoryId: 'sub-lunch', subcategoryNameSnapshot: '午餐', accountId: 'acct-test', createdAt: '2026-11-07T01:00:00.000Z' };
    const financeData = { categoryCatalog: [createCategoryStore().exportCatalog()], expenses: [financeRow], incomes: [], accounts: [{ id: 'acct-test', name: '測試帳戶', type: 'cash', active: true }], accountEvents: [], reminderOccurrences: [], financePreferences: [{ generation: 1 }] };
    const nodes = new Map(['[data-history-list]', '[data-history-status]', '[data-history-month]', '[data-history-count]', '[data-history-summary]', '[data-history-delete-modal-root]'].map((selector) => [selector, fakeElement()]));
    const root = { querySelector(selector) { return nodes.get(selector) || null; }, querySelectorAll() { return []; } };
    globalThis.document = { createElement: fakeElement };
    try {
      const state = { ...createHistoryState(), monthKey: '2026-11', records: [financeRow], financeData, canEditRecords: true, loading: false, error: '', editDay: '' };
      renderHistoryContents(root, state);
      let group = nodes.get('[data-history-list]').children[0];
      assert(group.children[0].children[0].children[1].dataset.action === 'history-toggle-day-edit', 'date edit pencil missing');
      assert(group.children[0].children[0].children[1].innerHTML.includes('m15 5 4 4'), '每日編輯控制未使用 pencil SVG');
      assert(group.children[1].children[0].children.every((child) => child.className !== 'history-record-actions'), 'record actions were visible before the day was enabled');
      state.editDay = '2026-11-07'; renderHistoryContents(root, state);
      group = nodes.get('[data-history-list]').children[0];
      assert(group.children[1].children[0].children[3].className === 'history-record-actions', 'editing a date did not reveal its record actions');
      state.recordEditor = { recordId: financeRow.id, draft: { date: financeRow.occurredOn, amountTwd: '200', categoryId: 'cat-food', subcategoryId: 'sub-lunch', accountId: 'acct-test', note: financeRow.note, paymentMethod: 'cash' }, expectedEditRevision: 0 };
      state.deleteRecord = financeRow;
      renderHistoryContents(root, state);
      assert(nodes.get('[data-history-summary]').innerHTML.includes('儲存修改') && nodes.get('[data-history-summary]').innerHTML.includes('data-history-edit-field="date"'), 'right panel did not show editable fields instead of overview');
      assert(nodes.get('[data-history-delete-modal-root]').innerHTML.includes('role="alertdialog"') && nodes.get('[data-history-delete-modal-root]').innerHTML.includes('2026-11-07') && nodes.get('[data-history-delete-modal-root]').innerHTML.includes('確認刪除'), 'centered delete confirmation did not identify the record');
    } finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; }
  });
  test('候選 V4 分類目錄切換後，歷史分類篩選器同步更新並保留搜尋狀態', () => {
    const originalDocument = globalThis.document;
    const fakeElement = () => ({ children: [], dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = [...items]; }, setAttribute(name, value) { this[name] = value; }, textContent: '', innerHTML: '', value: '', hidden: false, open: true });
    const nodes = new Map(['[data-history-list]', '[data-history-status]', '[data-history-month]', '[data-history-count]', '[data-history-summary]', '[data-history-delete-modal-root]', '[data-history-category-picker]', '.history-category-options', '[data-history-category-search]', '[data-history-category-label]', '[data-history-category-icon]'].map((selector) => [selector, fakeElement()]));
    nodes.get('[data-history-category-search]').value = '保留搜尋';
    const root = { querySelector(selector) { return nodes.get(selector) || null; }, querySelectorAll() { return []; } };
    globalThis.document = { createElement: fakeElement };
    try {
      const catalog = createCategoryStore().exportCatalog();
      catalog.revision += 1;
      catalog.categories.push({ id: 'candidate-new-category', name: '測試一', icon: 'tag', color: '#F4B544', hidden: false, entryType: 'expense' });
      catalog.subcategories.push({ id: 'candidate-new-subcategory', name: '有效子分類', categoryIds: ['candidate-new-category'], entryType: 'expense', hidden: false });
      const state = { ...createHistoryState(), monthKey: '2026-11', records: [], financeData: { categoryCatalog: [catalog], expenses: [], incomes: [], accounts: [], accountEvents: [], reminderOccurrences: [], financePreferences: [{ generation: 1 }] }, canEditRecords: true, loading: false, error: '' };
      renderHistoryContents(root, state);
      assert(nodes.get('.history-category-options').innerHTML.includes('測試一') && nodes.get('.history-category-options').innerHTML.includes('candidate-new-category'), 'candidate catalog category was absent from history filter');
      assert(nodes.get('.history-category-options').innerHTML.includes('--history-category-color:#F4B544'), 'candidate custom color was not used');
      assert(nodes.get('[data-history-category-search]').value === '保留搜尋' && nodes.get('[data-history-category-picker]').open, 'refresh discarded open/search state');
      const nextCatalog = JSON.parse(JSON.stringify(catalog)); nextCatalog.revision += 1; nextCatalog.categories.push({ id: 'candidate-second-category', name: '測試二', icon: 'store', color: '#42B982', hidden: false, entryType: 'expense' });
      state.financeData.categoryCatalog = [nextCatalog];
      renderHistoryContents(root, state);
      assert(nodes.get('.history-category-options').innerHTML.includes('測試二'), 'new catalog revision was not observed');
    } finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; }
  });
  test('月份總覽文字安全、狀態不殘留前一月份金額', () => {
    const records = [{ ...row('2026-11-01', 12345), categoryId: 'legacy-custom', categoryNameSnapshot: '<img src=x onerror=synthetic()>' }];
    const html = renderHistoryMonthOverview(records, '2026-11');
    assert(html.includes('NT$ 123.45') && html.includes('&lt;img') && !html.includes('<img'), 'summary labels unsafe or totals wrong');
    const nodes = new Map(['[data-history-list]', '[data-history-status]', '[data-history-month]', '[data-history-count]', '[data-history-summary]'].map((selector) => [selector, { innerHTML: '舊金額', replaceChildren() {} }]));
    const root = { querySelector: (selector) => nodes.get(selector) || null };
    renderHistoryContents(root, { monthKey: '2026-11', records: null, loading: true, error: '' });
    assert(nodes.get('[data-history-summary]').innerHTML.includes('正在讀取') && !nodes.get('[data-history-summary]').innerHTML.includes('舊金額'), 'loading retained stale total');
    renderHistoryContents(root, { monthKey: '2026-11', records: null, loading: false, error: '合成失敗' });
    assert(nodes.get('[data-history-summary]').innerHTML.includes('無法讀取') && !nodes.get('[data-history-summary]').innerHTML.includes('NT$'), 'error reported a false total');
  });
  test('最近記帳使用有效大分類圖示與顏色，未知舊紀錄僅顯示通用圖示', () => {
    const store = createCategoryStore();
    const food = row('2026-11-01', 10000); const bike = { ...row('2026-11-02', 20000), categoryId: 'cat-motorcycle' };
    assert(getRecordCategoryPresentation(food, store).iconName === 'utensils', 'food icon wrong');
    assert(getRecordCategoryPresentation(bike, store).color === '#E7CE50', 'motorcycle color wrong');
    const historical = { ...food, categoryId: 'missing', categoryIconSnapshot: '<script>', categoryColorSnapshot: 'red;bad' }; const before = JSON.stringify(historical);
    assert(getRecordCategoryPresentation(historical, store).iconName === 'receipt', 'unknown icon did not fall back');
    const savedIcon = { ...historical, categoryIconSnapshot: 'shoppingBag', categoryColorSnapshot: '#E16DB0' };
    assert(getRecordCategoryPresentation(savedIcon, store).iconName === 'shoppingBag', 'valid saved icon ignored');
    const html = renderFinancePanel(store, { source: 'personal', records: [food, bike], panel: 'overview' });
    assert(html.includes(icon('bike', 16)) && html.includes('--record-category-color:#E7CE50'), 'recent record did not render category presentation');
    assert(JSON.stringify(historical) === before, 'historical record was rewritten');
  });
  test('操作提示只保存自己的設定鍵，重新載入仍保留', () => {
    const values = new Map([['unrelated-key', 'untouched']]); const accessed = [];
    const environment = { location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/' }, localStorage: { getItem(key) { accessed.push(key); return values.get(key) ?? null; }, setItem(key, value) { accessed.push(key); values.set(key, value); } } };
    assert(loadOperationHints(environment).show === true, 'default should show helpful hints');
    saveOperationHints(false, environment); assert(loadOperationHints(environment).show === false, 'hidden preference did not survive load');
    saveOperationHints(true, environment); assert(loadOperationHints(environment).show === true, 'show preference did not survive load');
    assert(accessed.every((key) => key === OPERATION_HINTS_KEY) && values.get('unrelated-key') === 'untouched', 'preference touched another key');
  });
  test('偏好保存失敗或錯誤來源不假裝成功、不清除既有值', () => {
    let accessed = 0;
    const environment = { location: { origin: 'http://localhost:5510', pathname: '/' }, localStorage: { getItem() { accessed += 1; }, setItem() { accessed += 1; } } };
    throws(() => saveOperationHints(false, environment)); assert(loadOperationHints(environment).error && accessed === 0, 'wrong origin read/write allowed');
    environment.location = { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/lab/' }; throws(() => saveOperationHints(false, environment)); assert(accessed === 0, 'wrong path wrote preference');
    environment.location.pathname = '/'; environment.localStorage = { getItem() { throw new Error('synthetic block'); }, setItem() { throw new Error('synthetic quota'); } };
    assert(loadOperationHints(environment).show && loadOperationHints(environment).error, 'storage failure did not fall back clearly');
    throws(() => saveOperationHints(false, environment));
    let malformed = '{"version":1,"show":"no"}'; environment.localStorage = { getItem: () => malformed, setItem() { throw new Error('must not repair automatically'); } };
    assert(loadOperationHints(environment).show && malformed.includes('"no"'), 'invalid preference was overwritten');
  });
  test('排序位移動畫限定目前群組、尊重減少動畫且失敗不影響排序', () => {
    const calls = [];
    const makeItem = (id, parent, top) => ({ dataset: { sortKind: 'subcategory', sortId: id, sortParent: parent }, top, getBoundingClientRect() { return { left: 10, top: this.top }; }, animate(frames, options) { calls.push({ id, frames, options }); } });
    const first = makeItem('shared', 'parent-a', 0); const second = makeItem('second', 'parent-a', 70); const other = makeItem('shared', 'parent-b', 0);
    const root = { querySelectorAll: () => [first, second, other] }; const positions = captureSortPositions(root, 'subcategory', 'parent-a');
    first.top = 70; second.top = 0; other.top = 90;
    const environment = { matchMedia: () => ({ matches: false }) };
    assert(animateSortPositions(root, positions, environment) === 2 && calls[0].frames[0].transform.includes('-70px'), 'sort did not animate changed positions');
    assert(calls.every((call) => call.options.duration <= 200), 'sort animation too long');
    const count = calls.length; assert(animateSortPositions(root, positions, { matchMedia: () => ({ matches: true }) }) === 0 && calls.length === count, 'reduced motion ignored');
    first.animate = () => { throw new Error('synthetic animation failure'); }; second.animate = undefined;
    assert(animateSortPositions(root, positions, environment) === 0, 'animation error escaped into committed operation');
  });
  test('拖動途中真正交換 DOM 並觸發相鄰位移；取消恢復且減少動畫仍可排序', () => {
    let rows = []; const calls = [];
    const parent = {
      insertBefore(source, reference) { rows = rows.filter((item) => item !== source); const at = reference ? rows.indexOf(reference) : rows.length; rows.splice(at, 0, source); },
      appendChild(source) { this.insertBefore(source, null); },
    };
    const make = (id) => ({ dataset: { sortKind: 'subcategory', sortParent: 'parent-a', sortId: id }, parentElement: parent,
      get nextSibling() { return rows[rows.indexOf(this) + 1] || null; },
      getBoundingClientRect() { return { left: 0, top: rows.indexOf(this) * 60, width: 200, height: 60 }; },
      animate(frames) { calls.push({ id, frames }); return {}; },
    });
    const a = make('a'); const b = make('b'); const c = make('c'); rows = [a, b, c];
    const root = { querySelectorAll: () => rows }; const environment = { matchMedia: () => ({ matches: false }) };
    const drag = { id: 'a', kind: 'subcategory', parent: 'parent-a', initialIds: ['a', 'b', 'c'] };
    drag.preview = previewSortMove(root, drag, b, { clientX: 20, clientY: 110 }, environment);
    assert(rows.map((item) => item.dataset.sortId).join(',') === 'b,a,c' && calls.some((call) => call.id === 'b'), 'dragover did not displace neighbor');
    assert(previewSortMove(root, drag, b, { clientX: 20, clientY: 110 }, environment) === null, 'stationary pointer caused repeated swapping');
    restoreSortPreview(root, drag, environment); assert(rows[0] === a && rows[1] === b, 'cancel did not restore original DOM');
    const count = calls.length;
    previewSortMove(root, { ...drag, lastPoint: null }, b, { clientX: 20, clientY: 110 }, { matchMedia: () => ({ matches: true }) });
    assert(rows[0] === b && calls.length === count, 'reduced motion stopped sorting or still animated');
    const other = { ...c, dataset: { ...c.dataset, sortParent: 'other' } };
    assert(previewSortMove(root, drag, other, { clientX: 10, clientY: 10 }, environment) === null, 'cross-parent preview allowed');
  });
  test('拖曳落點換算沿用完整分類順序，保留隱藏項目及共用範圍', () => {
    const rows = ['a', 'hidden', 'b', 'c'].map((id) => ({ id }));
    assert(resolveSortDropIndex(rows, { id: 'a', preview: { targetId: 'b', after: true } }, 'a') === 2, 'downward insertion wrong');
    assert(resolveSortDropIndex(rows, { id: 'c', preview: { targetId: 'b', after: false } }, 'c') === 2, 'upward insertion wrong');
    assert(resolveSortDropIndex(rows, { id: 'missing' }, 'b') === null, 'missing source accepted');
  });
  test('提示標記只套用一般說明，必要欄位與還原警告保留', () => {
    const form = renderAddEntryForm(createCategoryStore(), createEntryDraft());
    assert(form.includes('entry-top-hint" data-operation-hint') && form.includes('<p>請輸入大於 0 的整數新台幣元</p>'), 'required amount hint was made optional');
    const backup = renderLedgerBackupPage({ ...createBackupPageState(), catalogReady: true });
    assert(!backup.includes('data-operation-hint') && backup.includes('完整取代目前的記帳資料'), 'restore safety guidance can be hidden');
    const panel = renderFinancePanel(createCategoryStore(), { source: 'personal', panel: 'overview', records: [] });
    assert(panel.includes('<span class="finance-source-label">我的資料</span>') && panel.includes('data-action="refresh-finance"') && !panel.includes('更多選項') && !panel.includes('觀看範例預覽'), 'overview source menu or example entry was not removed');
    const preview = renderFinancePanel(createCategoryStore(), { source: 'preview', panel: 'overview', records: [] });
    assert(preview.includes('所有金額均為虛構') && !preview.includes('is-preview" data-operation-hint'), 'preview warning became optional');
  });

  const results = [];
  for (const { name, action } of tests) {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  return { passed: results.filter((result) => result.passed).length, total: results.length, results, scope: 'Pure calendar/data calculations and simulated storage/animation; no Brave access' };
}
