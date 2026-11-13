import { createCategoryStore } from '../scripts/category-store.js';
import { createEntryDraft } from '../scripts/pages/add-entry.js';
import { createWorkbenchState, renderFullWorkbenchPanel, renderWorkbench } from '../scripts/pages/workbench.js';
import { aggregateLedger, renderFinancePanel, summarizeMonthlySubscriptions } from '../scripts/pages/finance-panels.js';
import { getLocalDateInputValue } from '../scripts/pages/add-entry.js';
import { renderBudgetSummary } from '../scripts/pages/budget-summary.js';
import { summarizeBudgetRows } from '../scripts/finance/budget.js';
import { OVERVIEW_PREFERENCES_KEY, defaultOverviewConfig, defaultOverviewPreferences, focusedBudgetRows, loadOverviewPreferences, saveOverviewPreferences } from '../scripts/ui/overview-preferences.js';
import { attachOverviewInteractions } from '../scripts/ui/overview-interactions.js';
import { attachCategoryPointerSort } from '../scripts/ui/category-pointer-sort.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const classes = () => { const values = new Set(); return { add: (...ids) => ids.forEach((id) => values.add(id)), remove: (...ids) => ids.forEach((id) => values.delete(id)), contains: (id) => values.has(id) }; };
function storageFixture() {
  const values = new Map(); const accessed = [];
  return { values, accessed, environment: { location: { origin: 'https://friend.github.io', pathname: '/life-record-finance-v5/' }, localStorage: { getItem(key) { accessed.push(key); return values.get(key) ?? null; }, setItem(key, value) { accessed.push(key); values.set(key, value); } } } };
}
const row = (categoryId, child, budget, spent) => ({ categoryId, subcategoryId: child, categoryName: categoryId, subcategoryName: child || '', budgetMinor: BigInt(budget), actualMinor: BigInt(spent), remainingMinor: BigInt(budget) - BigInt(spent), exceeded: spent > budget });

function pointerFixture(reduced = false, sortKind = 'subcategory') {
  const handlers = new Map(); const frames = new Map(); let frameId = 0; let rows = []; let ghost = null; let drops = 0; let animations = 0;
  const parent = { appendChild(item) { rows.splice(rows.indexOf(item), 1); rows.push(item); }, insertBefore(item, reference) { rows.splice(rows.indexOf(item), 1); const i = reference ? rows.indexOf(reference) : rows.length; rows.splice(i, 0, item); } };
  const root = { querySelectorAll: () => rows, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  const make = (id) => {
    const item = { dataset: { sortKind, sortParent: 'cat-a', sortId: id }, parentElement: parent, classList: classes(),
      get nextSibling() { return rows[rows.indexOf(item) + 1] || null; },
      getBoundingClientRect() { const top = rows.indexOf(item) * 60; return { left: 0, top, bottom: top + 60, width: 240, height: 60 }; },
      closest: (selector) => selector === '[data-sort-item]' ? item : null,
      animate() { animations += 1; return { finished: Promise.resolve() }; },
      cloneNode() { return { style: {}, classList: classes(), setAttribute() {}, removeAttribute() {}, matches: () => false, querySelectorAll: () => [], remove() { ghost = null; }, animate() { animations += 1; return { finished: Promise.resolve() }; } }; },
    };
    item.handle = { closest: (selector) => selector === '[data-sort-handle]' ? item.handle : selector === '[data-sort-item]' ? item : null, focus() {} };
    return item;
  };
  const a = make('a'); const b = make('b'); const c = make('c'); rows = [a, b, c];
  const document = { body: { classList: classes(), append(item) { ghost = item; } }, elementsFromPoint: () => [b], addEventListener(name, action) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(action); } };
  const environment = { matchMedia: () => ({ matches: reduced }), requestAnimationFrame(action) { frames.set(++frameId, action); return frameId; }, cancelAnimationFrame: (id) => frames.delete(id), innerHeight: 900, setTimeout: (action) => action(), addEventListener() {} };
  attachCategoryPointerSort(root, { document, environment, isBusy: () => false, onDrop: () => { drops += 1; } });
  const dispatch = async (name, extra = {}) => { for (const action of handlers.get(name) || []) await action({ target: a.handle, pointerId: 1, button: 0, clientX: 20, clientY: 15, preventDefault() {}, ...extra }); };
  return { dispatch, frame() { const entry = frames.entries().next().value; if (entry) { frames.delete(entry[0]); entry[1](); } }, order: () => rows.map((item) => item.dataset.sortId).join(','), ghost: () => ghost, drops: () => drops, animations: () => animations };
}

function overviewBlockPointerFixture(kind = 'block') {
  const handlers = new Map(); const documentHandlers = new Map(); const frames = new Map(); let rows = []; let ghost = null; let dropTarget = null; let saved = 0; let nextFrame = 0;
  const parent = {
    append(node) { const index = rows.indexOf(node); if (index >= 0) rows.splice(index, 1); rows.push(node); node.parentElement = this; },
    insertBefore(node, reference) { const index = rows.indexOf(node); if (index >= 0) rows.splice(index, 1); const target = reference ? rows.indexOf(reference) : rows.length; rows.splice(target < 0 ? rows.length : target, 0, node); node.parentElement = this; },
  };
  const make = (id) => {
    const item = { dataset: { overviewKind: kind, overviewItem: id }, classList: classes(), parentElement: parent,
      getBoundingClientRect() { const top = rows.indexOf(item) * 100; return { left: 100, top, right: 500, bottom: top + 90, width: 400, height: 90 }; },
      getAnimations: () => [], animate: () => ({ finished: Promise.resolve() }),
      closest(selector) { return selector === '[data-overview-item]' || (kind === 'block' && selector === '.overview-block[data-overview-kind="block"]') || (kind === 'focus' && selector === '[data-overview-focus-sort][data-overview-kind="focus"]') ? item : selector === '[data-overview-budget-month]' && kind === 'focus' ? { dataset: { overviewBudgetMonth: '2026-11' } } : null; },
      querySelector(selector) { return selector === '[data-overview-block-handle]' ? handle : selector === '[data-overview-focus-sort]' && kind === 'focus' ? item : null; },
      cloneNode() { return { style: {}, classList: classes(), setAttribute() {}, removeAttribute() {}, matches: () => false, querySelectorAll: () => [], remove() { ghost = null; }, animate() { return { finished: Promise.resolve() }; } }; },
    };
    const handle = { focus() {}, closest(selector) { return selector === '[data-overview-block-handle]' ? handle : selector === '[data-overview-item]' || (kind === 'block' && selector === '.overview-block[data-overview-kind="block"]') || (kind === 'focus' && selector === '[data-overview-focus-sort][data-overview-kind="focus"]') ? item : null; } };
    return item;
  };
  const ids = kind === 'block' ? ['monthly', 'budget', 'recent', 'subscriptions'] : ['food::', 'transport::', 'phone::'];
  rows = ids.map(make);
  const root = { querySelectorAll(selector) { return selector === '[data-overview-item]' || (kind === 'block' && selector === '.overview-block[data-overview-kind="block"]') ? rows : []; }, addEventListener(name, action) { handlers.set(name, action); }, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  const environment = { matchMedia: () => ({ matches: false }), requestAnimationFrame(action) { frames.set(++nextFrame, action); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); }, setTimeout(action) { action(); return 1; }, clearTimeout() {}, addEventListener() {} };
  const document = { defaultView: environment, body: { classList: classes(), append(node) { ghost = node; } }, elementFromPoint() { return dropTarget; }, addEventListener(name, action) { const list = documentHandlers.get(name) || []; list.push(action); documentHandlers.set(name, list); } };
  const focusOrders = [];
  attachOverviewInteractions(root, { document, getConfig: () => config, saveConfig(next) { config = next; saved += 1; }, onFocusOrder(order, month) { focusOrders.push({ order: [...order], month }); return true; } });
  let config = { ...defaultOverviewConfig(), blocks: kind === 'block' ? ids : defaultOverviewConfig().blocks, focus: kind === 'focus' ? ids : null };
  const handle = rows[2].querySelector('[data-overview-block-handle]');
  const targetFor = (row) => ({ closest(selector) { return selector === '[data-overview-block-handle]' && kind === 'block' ? handle : (selector === '.overview-block[data-overview-kind="block"]' && kind === 'block') || (selector === '[data-overview-focus-sort][data-overview-kind="focus"]' && kind === 'focus') || selector === '[data-overview-item]' ? row : null; } });
  return { rows, root, handlers, targetFor, setDropTarget(row) { dropTarget = row; }, frame() { const frame = frames.entries().next().value; if (frame) { frames.delete(frame[0]); frame[1](); } }, ghost: () => ghost, config: () => config, saved: () => saved, focusOrders };
}

export async function runOverviewUiTests() {
  const tests = []; const test = (name, action) => tests.push({ name, action });
  test('五個快捷入口依順序直達，保留原工具列風格', () => {
    const html = renderWorkbench(createCategoryStore(), createEntryDraft(), createWorkbenchState());
    const links = [...html.matchAll(/data-workbench-link="([^"]+)"/g)].map((match) => match[1]);
    assert(links.join(',') === 'history,accounts,budget,reminders,settings', '快捷入口順序錯誤');
    assert(html.includes('data-settings-subview="budget"'), '預算未直接連到完整頁');
  });
  test('總覽與統計分析頁籤有獨立狀態識別，預算摘要的次要操作維持清楚分組', () => {
    const side = renderWorkbench(createCategoryStore(), createEntryDraft(), createWorkbenchState());
    const overview = renderFullWorkbenchPanel(createCategoryStore(), { ...createWorkbenchState(), panel: 'overview' });
    const analytics = renderFullWorkbenchPanel(createCategoryStore(), { ...createWorkbenchState(), panel: 'analytics' });
    const summary = renderBudgetSummary([row('food', '', 10000, 2500)]);
    assert(side.includes('data-panel="overview" role="tab" aria-selected="true"') && side.includes('data-panel="analytics" role="tab" aria-selected="false"'), '工作區頁籤選取資訊遺失');
    assert(overview.includes('data-panel="overview" role="tab" aria-selected="true"') && analytics.includes('data-panel="analytics" role="tab" aria-selected="true"'), '完整頁面頁籤選取資訊錯誤');
    assert(summary.includes('class="budget-summary-all-link"') && summary.includes('class="budget-summary-focus-summary"'), '預算摘要次要入口未使用穩定樣式掛點');
  });
  test('摘要總預算不重複計算大分類及子分類，保留舊支出精度', () => {
    const rows = [row('food', '', 100000, 1050), row('food', 'lunch', 30000, 1050), row('shop', 'a', 20000, 100), row('shop', 'b', 30000, 200)];
    const result = summarizeBudgetRows([...rows, rows[0]]);
    assert(result.budgetMinor === 150000n && result.actualMinor === 1350n && result.remainingMinor === 148650n, '父子或重複預算被加總兩次');
    const html = renderBudgetSummary(rows); assert(html.includes('$13.50'), '舊支出小數精度遺失');
  });
  test('個人預算摘要沿用分類自訂色，範例摘要固定使用示範色', () => {
    const categoryStore = { getCategory: () => ({ color: '#24B89A' }) };
    const personal = renderBudgetSummary([row('food', '', 10000, 2000)], undefined, false, categoryStore);
    const preview = renderBudgetSummary([row('preview-meal', '', 10000, 2000)], undefined, true, categoryStore);
    assert(personal.includes('--budget-category-color:#24B89A'), '個人摘要沒有沿用自訂分類色');
    assert(preview.includes('--budget-category-color:#D78373') && !preview.includes('--budget-category-color:#24B89A'), '範例色誤用了正式分類資料');
    assert(personal.includes('data-overview-focus-sort') && !personal.includes('data-overview-handle'), '重點分類仍使用舊拖曳把手');
    assert(personal.includes('data-overview-focus="food::" checked'), '摘要重點分類核取狀態沒有正確渲染');
  });
  test('重點分類可選擇顯示一至三列，預設三列並保留其餘項目捲動查看', () => {
    const rows = Array.from({ length: 5 }, (_, index) => row(`cat${index}`, '', 10000, 0));
    const defaults = renderBudgetSummary(rows);
    const one = renderBudgetSummary(rows, { ...defaultOverviewConfig(), focusVisibleCount: 1 });
    const two = renderBudgetSummary(rows, { ...defaultOverviewConfig(), focusVisibleCount: 2 });
    assert(defaults.includes('data-visible-rows="3"') && defaults.includes('data-overview-focus-visible-count="3" value="3" checked'), '預設顯示列數不是三列');
    assert(one.includes('data-visible-rows="1"') && two.includes('data-visible-rows="2"'), '選擇的一列或兩列沒有套用至清單');
    assert([0, 1, 2, 3, 4].every((index) => two.includes(`data-overview-item="cat${index}::"`)), '縮小可視列數時錯誤隱藏可捲動預算');
    assert(two.includes('只顯示已勾選項目') && two.includes('顯示列數'), '列數控制覆蓋或缺少勾選篩選');
  });
  test('未啟用不顯示合成金額，空資料仍顯示摘要入口，範例明確隔離', () => {
    const store = createCategoryStore(); const personal = renderFinancePanel(store, { source: 'personal', records: [], panel: 'overview' });
    assert(personal.includes('正式預算尚未啟用') && !personal.includes('範例預算'), '未啟用被假金額取代');
    assert(personal.includes('class="overview-drag-handle" data-overview-block-handle') && !personal.includes('>↕</button>'), '總覽拖曳入口仍顯示突兀箭頭或不可聚焦');
    const preview = renderFinancePanel(store, { source: 'preview', records: [], panel: 'overview' });
    assert(preview.includes('範例預算 · 不會保存為正式資料') && preview.includes('$2,500'), '範例未使用既有計算來源');
    assert(personal.indexOf('data-overview-item="monthly"') < personal.indexOf('data-overview-item="budget"') && personal.indexOf('data-overview-item="budget"') < personal.indexOf('data-overview-item="recent"') && personal.indexOf('data-overview-item="recent"') < personal.indexOf('data-overview-item="subscriptions"'), '預設區塊順序錯誤');
    assert(personal.includes('data-overview-item="subscriptions"><button type="button" class="overview-drag-handle"'), '本月訂閱沒有可拖曳把手');
  });
  test('本月訂閱預計、已付款與待付款加總正確，只計月付支出且排除取消期次', () => {
    const rules = [
      { id: 'rule-gpt', repeat: 'monthly', entryType: 'expense', entryDefaults: { categoryId: 'phone' } },
      { id: 'rule-bahamut', repeat: 'monthly', entryType: 'expense', entryDefaults: { categoryId: 'fun' } },
      { id: 'rule-yearly', repeat: 'yearly', entryType: 'expense' },
      { id: 'rule-income', repeat: 'monthly', entryType: 'income' },
    ];
    const occurrences = [
      { id: 'gpt', ruleId: 'rule-gpt', name: 'GPT', entryType: 'expense', amountTwd: 690, dueDate: '2026-11-05', status: 'completed' },
      { id: 'bahamut', ruleId: 'rule-bahamut', name: '巴哈動畫瘋', entryType: 'expense', amountTwd: 190, dueDate: '2026-11-12', status: 'pending' },
      { id: 'cancelled', ruleId: 'rule-gpt', name: '取消項目', entryType: 'expense', amountTwd: 300, dueDate: '2026-11-15', status: 'cancelled' },
      { id: 'next-month', ruleId: 'rule-gpt', name: '下月 GPT', entryType: 'expense', amountTwd: 690, dueDate: '2026-12-05', status: 'pending' },
      { id: 'yearly', ruleId: 'rule-yearly', name: '年繳項目', entryType: 'expense', amountTwd: 1200, dueDate: '2026-11-05', status: 'pending' },
      { id: 'income', ruleId: 'rule-income', name: '收入項目', entryType: 'income', amountTwd: 1000, dueDate: '2026-11-05', status: 'pending' },
    ];
    const summary = summarizeMonthlySubscriptions(rules, occurrences, '2026-11');
    assert(summary.totalMinor === 88000n && summary.paidMinor === 69000n && summary.pendingMinor === 19000n, '本月訂閱金額或付款狀態加總錯誤');
    assert(summary.items.map((item) => item.id).join(',') === 'gpt,bahamut', '取消、其他月份、年繳或收入混入訂閱清單');
    const nextMonth = summarizeMonthlySubscriptions(rules, occurrences, '2026-12');
    assert(nextMonth.totalMinor === 69000n && nextMonth.pendingMinor === 69000n && nextMonth.paidMinor === 0n, '跨月後未按新月份統計');
    const allPaid = summarizeMonthlySubscriptions(rules, occurrences.map((item) => item.id === 'bahamut' ? { ...item, status: 'completed' } : item), '2026-11');
    assert(allPaid.totalMinor === 88000n && allPaid.paidMinor === 88000n && allPaid.pendingMinor === 0n, '全部付款後預計、已付與待付金額不一致');
    const empty = summarizeMonthlySubscriptions(rules, [], '2026-11');
    assert(empty.totalMinor === 0n && empty.items.length === 0, '無訂閱時摘要未回傳零值');
  });
  test('總覽最新紀錄只列本月全部紀錄，訂閱卡接在最近紀錄後並保留既有分類', () => {
    const today = getLocalDateInputValue(); const month = today.slice(0, 7);
    const previous = getLocalDateInputValue(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 15));
    const records = Array.from({ length: 4 }, (_, index) => ({ id: `current-${index}`, recordType: 'expense', amountMinor: 10000, occurredOn: `${month}-${String(index + 1).padStart(2, '0')}`, createdAt: `${today}T0${index}:00:00.000Z`, categoryId: 'food', categoryNameSnapshot: '吃', subcategoryNameSnapshot: `本月${index + 1}` }));
    records.push({ id: 'older', recordType: 'expense', amountMinor: 20000, occurredOn: previous, createdAt: `${previous}T12:00:00.000Z`, categoryId: 'food', categoryNameSnapshot: '吃', subcategoryNameSnapshot: '上月紀錄' });
    const summary = aggregateLedger(records, new Date(`${today}T12:00:00`));
    assert(summary.recent.length === 4 && summary.recent.every((item) => item.occurredOn.slice(0, 7) === month), '最近紀錄沒有只取本月，或錯誤限制筆數');
    const rules = [{ id: 'rule-gpt', name: 'GPT', repeat: 'monthly', entryType: 'expense', entryDefaults: { categoryId: 'phone' } }];
    const subscriptionData = { reminderRules: rules, reminderOccurrences: [{ id: 'gpt-current', ruleId: 'rule-gpt', name: 'GPT', entryType: 'expense', amountTwd: 690, dueDate: `${month}-05`, status: 'pending' }] };
    const html = renderFinancePanel(createCategoryStore(), { source: 'personal', panel: 'overview', records, subscriptionData, loading: false, error: '' });
    assert([...html.matchAll(/class="workbench-recent-row"/g)].length === 4 && !html.includes('上月紀錄'), '本月記錄清單沒有顯示本月全部項目或混入舊月份');
    assert(html.indexOf('workbench-recent-card') < html.indexOf('workbench-subscription-card'), '訂閱卡沒有排在最新紀錄之後');
    assert(html.includes('aria-label="本月收支紀錄，可捲動查看"') && html.includes('aria-label="本月訂閱項目，可捲動查看"'), '兩個捲動清單缺少鍵盤可操作區域');
    assert(html.includes('本月預計') && html.includes('NT$ 690') && html.includes('全部訂閱') && html.includes('toggle-subscription-summary'), '訂閱摘要、導覽或收合按鈕缺少');
  });
  test('重點分類預設四項、可全不選、失效 ID 不冒用其他預算', () => {
    const rows = Array.from({ length: 6 }, (_, index) => row(`cat${index}`, '', 10000, 0));
    assert(focusedBudgetRows(rows, null).length === 4 && focusedBudgetRows(rows, []).length === 0, '預設或清空選擇錯誤');
    assert(focusedBudgetRows(rows, ['missing::', 'cat4::', 'cat1::']).map((item) => item.categoryId).join(',') === 'cat4,cat1', '分類順序／穩定 ID 錯誤');
  });
  test('顯示偏好保存往返，只存指定鍵，錯誤來源與損壞資料安全回退', () => {
    const s = storageFixture(); const prefs = defaultOverviewPreferences(); prefs.personal.focus = ['shop::a', 'food::']; prefs.personal.blocks = ['recent', 'subscriptions', 'budget', 'monthly']; prefs.personal.budgetCollapsed = true; prefs.personal.recentCollapsed = true;
    prefs.personal.focusVisibleCount = 2;
    saveOverviewPreferences(prefs, s.environment); assert(JSON.stringify(loadOverviewPreferences(s.environment).value) === JSON.stringify(prefs), '重新讀取偏好不一致');
    const older = defaultOverviewPreferences();
    older.personal.blocks = ['monthly', 'budget', 'recent']; older.preview.blocks = ['monthly', 'budget', 'recent'];
    delete older.personal.subscriptionsCollapsed; delete older.preview.subscriptionsCollapsed;
    delete older.personal.focusVisibleCount; delete older.preview.focusVisibleCount;
    s.values.set(OVERVIEW_PREFERENCES_KEY, JSON.stringify(older));
    const migrated = loadOverviewPreferences(s.environment).value;
    assert(migrated.personal.subscriptionsCollapsed === false && migrated.preview.subscriptionsCollapsed === false && migrated.personal.focusVisibleCount === 3
      && migrated.personal.blocks.join(',') === 'monthly,budget,recent,subscriptions', '舊總覽偏好沒有保留順序並補入訂閱預設值');
    const beforeDrag = defaultOverviewPreferences();
    beforeDrag.personal.blocks = ['recent', 'budget', 'monthly']; beforeDrag.preview.blocks = ['budget', 'recent', 'monthly'];
    beforeDrag.personal.subscriptionsCollapsed = true;
    delete beforeDrag.personal.focusVisibleCount; delete beforeDrag.preview.focusVisibleCount;
    s.values.set(OVERVIEW_PREFERENCES_KEY, JSON.stringify(beforeDrag));
    const migratedCurrent = loadOverviewPreferences(s.environment).value;
    assert(migratedCurrent.personal.subscriptionsCollapsed && migratedCurrent.personal.focusVisibleCount === 3 && migratedCurrent.personal.blocks.join(',') === 'recent,subscriptions,budget,monthly'
      && migratedCurrent.preview.blocks.join(',') === 'budget,recent,subscriptions,monthly', '先前版自訂順序或訂閱收合狀態遺失');
    assert(s.accessed.every((key) => key === OVERVIEW_PREFERENCES_KEY), '存取其他瀏覽器鍵');
    const wrong = { ...s.environment, location: { origin: 'http://localhost:5510', pathname: '/' } }; let refused = false;
    try { saveOverviewPreferences(prefs, wrong); } catch { refused = true; } assert(refused, '錯誤來源仍可保存');
    const invalidCount = defaultOverviewPreferences(); invalidCount.personal.focusVisibleCount = 4; let rejectedCount = false;
    try { saveOverviewPreferences(invalidCount, s.environment); } catch { rejectedCount = true; } assert(rejectedCount, '無效顯示列數被保存');
    s.values.set(OVERVIEW_PREFERENCES_KEY, '{broken'); assert(loadOverviewPreferences(s.environment).error, '損壞偏好被默默採用');
  });
  test('顯示勾選、分類拖曳／鍵盤、區塊排序與收合共用同一保存流程', async () => {
    let config = defaultOverviewConfig(); let saved = 0; const handlers = new Map();
    const keys = ['a::', 'b::', 'c::', 'd::', 'e::'];
    const make = (kind, id) => ({ dataset: { overviewKind: kind, overviewItem: id }, classList: classes(), querySelector: () => ({ focus() {} }), closest(selector) { return selector === '[data-overview-item]' || selector === '[data-overview-focus-sort]' ? this : null; } });
    const root = { querySelectorAll(selector) { return selector === '[data-overview-item]' ? [...config.blocks.map((id) => make('block', id)), ...(config.focus === null ? keys.slice(0, 4) : config.focus).map((id) => make('focus', id))] : []; } };
    const document = { addEventListener(name, action) { handlers.set(name, action); } };
    attachOverviewInteractions(root, { document, getConfig: () => config, saveConfig: (next) => { config = next; saved += 1; } });
    handlers.get('change')({ target: { dataset: { overviewFocusVisibleCount: '1' } } });
    assert(config.focusVisibleCount === 1, '列數控制未經總覽偏好保存流程更新');
    handlers.get('change')({ target: { dataset: { overviewFocusVisibleCount: '4' } } });
    assert(config.focusVisibleCount === 1, '無效列數覆蓋了有效設定');
    handlers.get('change')({ target: { dataset: { overviewFocus: 'a::' }, checked: false } });
    handlers.get('change')({ target: { dataset: { overviewFocus: 'e::' }, checked: true } });
    const target = (kind, key) => { const row = make(kind, key); const handle = { closest: () => row }; return { closest: (selector) => selector === '[data-overview-focus-sort]' && kind === 'focus' ? row : selector === '[data-overview-block-handle]' && kind === 'block' ? handle : selector === '[data-overview-item]' ? row : null }; };
    handlers.get('keydown')({ target: target('focus', 'e::'), key: 'ArrowUp', preventDefault() {} });
    assert(config.focus.join(',') === 'b::,c::,e::,d::', '重點分類鍵盤排序錯誤');
    assert(!target('focus', 'e::').closest('[data-overview-handle]'), '舊三線把手仍存在');
    handlers.get('keydown')({ target: target('block', 'recent'), key: 'ArrowUp', preventDefault() {} });
    handlers.get('keydown')({ target: target('block', 'recent'), key: 'ArrowUp', preventDefault() {} });
    const clickToggle = (action) => {
      const content = { getBoundingClientRect: () => ({ height: 120 }) };
      const block = { querySelector: (selector) => selector === '.overview-collapsible-content' ? content : null };
      const toggle = { dataset: { action }, closest: (selector) => selector === '.overview-block' || selector === '.workbench-subscription-card' ? block : null };
      return { target: { closest: (selector) => selector.includes(action) ? toggle : null } };
    };
    handlers.get('click')(clickToggle('toggle-budget-summary'));
    handlers.get('click')(clickToggle('toggle-recent-records'));
    handlers.get('click')(clickToggle('toggle-subscription-summary'));
    assert(config.blocks.join(',') === 'recent,monthly,budget,subscriptions' && config.budgetCollapsed && config.recentCollapsed && config.subscriptionsCollapsed && saved === 9, '區塊排序或收合未保存');
    const s = storageFixture(); const prefs = defaultOverviewPreferences(); prefs.personal = config; saveOverviewPreferences(prefs, s.environment); assert(loadOverviewPreferences(s.environment).value.personal.focus[0] === 'b::', '互動排序重新讀取遺失');
  });
  test('分類拖曳途中即時讓位，完整卡片跟隨指標，放開只提交一次', async () => {
    const s = pointerFixture(); await s.dispatch('pointerdown'); await s.dispatch('pointermove', { clientY: 110 }); s.frame();
    assert(s.ghost()?.style.transform.includes('110') === false && s.ghost()?.style.transform.includes('95px'), '拖曳卡片未依指標及抓取位置移動');
    assert(s.order() === 'b,a,c', '鄰近項目未在拖曳途中讓位');
    await s.dispatch('pointerup'); assert(s.drops() === 1 && !s.ghost() && s.order() === 'b,a,c', '放開提交或視覺清理錯誤');
  });
  test('取消排序完整回復；減少動畫仍可拖曳且不播放落下動畫', async () => {
    const cancelled = pointerFixture(); await cancelled.dispatch('pointerdown'); await cancelled.dispatch('pointermove', { clientY: 110 }); cancelled.frame(); await cancelled.dispatch('keydown', { key: 'Escape' });
    assert(cancelled.order() === 'a,b,c' && cancelled.drops() === 0 && !cancelled.ghost(), '取消仍保存或未回復位置');
    const reduced = pointerFixture(true); await reduced.dispatch('pointerdown'); await reduced.dispatch('pointermove', { clientY: 110 }); reduced.frame(); await reduced.dispatch('pointerup');
    assert(reduced.order() === 'b,a,c' && reduced.drops() === 1 && reduced.animations() === 0, '減少動畫偏好未遵守');
  });
  test('總覽卡片拖曳時整張卡片跟隨指標、相鄰區塊讓位並只保存一次', async () => {
    const s = overviewBlockPointerFixture(); const source = s.rows[2]; const handle = source.querySelector('[data-overview-block-handle]'); const target = s.rows[0]; s.setDropTarget(target);
    s.handlers.get('pointerdown')({ target: handle, pointerId: 9, pointerType: 'mouse', button: 0, clientX: 120, clientY: 245, preventDefault() {} });
    s.handlers.get('pointermove')({ target: handle, pointerId: 9, pointerType: 'mouse', clientX: 160, clientY: 25, preventDefault() {} }); s.frame();
    assert(s.ghost()?.style.transform.includes('140px,') && s.rows.map((item) => item.dataset.overviewItem).join(',') === 'recent,monthly,budget,subscriptions', '拖曳影像未跟隨指標或相鄰區塊未即時讓位');
    s.handlers.get('pointerup')({ pointerId: 9, clientX: 160, clientY: 25 }); await new Promise((resolve) => setTimeout(resolve, 0));
    assert(s.config().blocks.join(',') === 'recent,monthly,budget,subscriptions' && s.saved() === 1 && !s.ghost(), '放開後排序未持久保存或拖曳影像未清除');
  });
  test('訂閱卡左上拖曳把手可將卡片移到其他區塊並保存排序', async () => {
    const s = overviewBlockPointerFixture(); const source = s.rows[3]; const handle = source.querySelector('[data-overview-block-handle]'); const target = s.rows[1]; s.setDropTarget(target);
    assert(Boolean(handle), '訂閱卡沒有拖曳把手');
    s.handlers.get('pointerdown')({ target: handle, pointerId: 12, pointerType: 'mouse', button: 0, clientX: 120, clientY: 345, preventDefault() {} });
    s.handlers.get('pointermove')({ target: handle, pointerId: 12, pointerType: 'mouse', button: 0, clientX: 140, clientY: 130, preventDefault() {} }); s.frame();
    assert(s.rows.map((item) => item.dataset.overviewItem).join(',') === 'monthly,subscriptions,budget,recent', '拖曳訂閱卡時相鄰區塊沒有讓位');
    s.handlers.get('pointerup')({ pointerId: 12, clientX: 140, clientY: 130 }); await new Promise((resolve) => setTimeout(resolve, 0));
    assert(s.config().blocks.join(',') === 'monthly,subscriptions,budget,recent' && s.saved() === 1 && !s.ghost(), '訂閱卡排序沒有保存');
  });
  test('預算重點分類以整張卡片外框拖曳，途中讓位並持久保存，沒有三線把手', async () => {
    const s = overviewBlockPointerFixture('focus'); const source = s.rows[2]; const target = s.rows[0]; s.setDropTarget(target);
    assert(!source.querySelector('[data-overview-handle]'), '重點分類仍有三線拖曳把手');
    s.handlers.get('pointerdown')({ target: source, pointerId: 10, pointerType: 'mouse', button: 0, clientX: 110, clientY: 245, preventDefault() {} });
    s.handlers.get('pointermove')({ target: source, pointerId: 10, pointerType: 'mouse', button: 0, clientX: 160, clientY: 25, preventDefault() {} }); s.frame();
    assert(s.ghost()?.style.transform.includes('150px,-20px') && s.rows.map((item) => item.dataset.overviewItem).join(',') === 'phone::,food::,transport::', '重點卡片沒有跟隨指標或相鄰項目未讓位');
    s.handlers.get('pointerup')({ pointerId: 10, clientX: 160, clientY: 25 }); await new Promise((resolve) => setTimeout(resolve, 0));
    assert(s.config().focus.join(',') === 'phone::,food::,transport::' && s.saved() === 1 && !s.ghost(), '重點分類拖曳未保存或影像未清除');
    assert(s.focusOrders.length === 1 && s.focusOrders[0].month === '2026-11' && s.focusOrders[0].order.join(',') === 'phone::,food::,transport::', '總覽沒有把本月分類順序送到共用預算排序偏好');
  });
  test('大分類拖曳起始位置使用按下時卡片座標，指標更新不等待動畫影格', async () => {
    const s = pointerFixture(false, 'category');
    await s.dispatch('pointerdown');
    await s.dispatch('pointermove', { clientX: 80, clientY: 110 });
    assert(s.ghost()?.style.transform.includes('translate3d(60px,95px,0)'), '大分類拖曳 ghost 未緊貼原抓取點');
    await s.dispatch('pointerup');
  });
  const results = [];
  for (const { name, action } of tests) { try { await action(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } }
  return { passed: results.filter((item) => item.passed).length, total: results.length, results, scope: 'Synthetic calculations, preference storage and pointer/DOM event simulation; no browser database access' };
}
