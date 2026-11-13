import { navigation } from './data.js';
import { icon } from './icons.js';
import { categoryStore, createCategoryStore } from './category-store.js';
import { applyEntryPreferencesToDraft, applyResolvedAccountToDraft, createEntryDraft, getLocalDateInputValue, reconcileEntryDraftSelection, renderAddEntryPage, selectEntryAccount, selectEntryCategory, switchEntryDraftType, validateEntryDraft } from './pages/add-entry.js';
import { createIdempotencyKey, createExpenseRecord, createIncomeRecord, listLedgerEntries, loadOrInitializeCategoryCatalog, readCategoryCatalog, saveCategoryCatalog, saveExpense, saveIncome, readOfficialSnapshot, restoreOfficialSnapshot, officialSnapshotToken, validateOfficialSnapshot } from './storage/expense-db.js';
import { createLedgerBackup, validateLedgerBackup, MAX_BACKUP_BYTES } from './storage/ledger-backup.js';
import { createBackupPageState, renderLedgerBackupPage } from './pages/ledger-backup.js';
import { renderFinancePanel } from './pages/finance-panels.js';
import { createHistoryState, renderHistoryPage, renderHistoryContents, setHistoryToCurrentMonth, shiftHistoryMonth } from './pages/history.js';
import { createCategoryEditorState, renderCategorySettingsPage, selectCategoryForEditing, switchCategoryEditorType, updateSubcategorySuggestions } from './pages/category-settings.js';
import { createWorkbenchState, getWorkbenchColumnBounds, renderFullWorkbenchPanel, renderWorkbench, resolveWorkbenchDrag, resolveWorkbenchKeyboard } from './pages/workbench.js';
import { captureSortPositions, animateSortPositions, resolveSortDropIndex } from './ui/sort-animation.js';
import { attachCategoryPointerSort } from './ui/category-pointer-sort.js';
import { createFinanceController } from './finance/controller.js';
import { createFinanceRepository, OFFICIAL_FINANCE_ENABLED } from './finance/repository.js';
import { activateFinancePreview, clearFinancePreviewState, FINANCE_PREVIEW_DATABASE_NAME, FINANCE_PREVIEW_STORAGE_KEY, isFinancePreviewEnabled, isFinancePreviewLocation, matchesFinancePreviewBackup } from './finance/development-preview.js';
import { createMinimumFinanceCatalog, FINANCE_STORES } from './finance/model.js';
import { stableJson } from './storage/json-data.js';
import { loadOverviewPreferences, saveOverviewPreferences } from './ui/overview-preferences.js';
import { attachOverviewInteractions } from './ui/overview-interactions.js';
import { getEntryDraftCategoryIssue, syncOfficialCategoryCache } from './finance/category-cache.js';

const root = document.querySelector('#view-root');
const currentCrumb = document.querySelector('#breadcrumb-current');
const FINANCE_V4_PREVIEW_ENABLED = isFinancePreviewEnabled(window);
const FINANCE_V4_ACTIVE = OFFICIAL_FINANCE_ENABLED || FINANCE_V4_PREVIEW_ENABLED;
const previewBadge = document.querySelector('[data-finance-v4-preview]');
if (previewBadge) {
  previewBadge.hidden = !OFFICIAL_FINANCE_ENABLED && !FINANCE_V4_PREVIEW_ENABLED;
  previewBadge.setAttribute('aria-label', '記帳版本狀態');
  previewBadge.textContent = OFFICIAL_FINANCE_ENABLED
    ? 'V5 正式版'
    : FINANCE_V4_PREVIEW_ENABLED ? 'V4 已啟用 · 開發預覽' : '';
}
const mobileQuery = window.matchMedia('(max-width: 650px)');
const workbenchStackedQuery = window.matchMedia('(max-width: 760px)');
let activePage = 'ledger';
let ledgerSettingsSubview = 'home';
const LEDGER_SETTINGS_SUBVIEWS = new Set(['home', 'ledger', 'categories', 'budget', 'preferences', 'defaults', 'backup']);
const FINANCE_SETTINGS_SUBVIEWS = new Set(['ledger', 'categories', 'budget', 'preferences', 'defaults', 'backup']);
let entryDraft = createEntryDraft();
let entryDraftBeforeReminder = null;
let categoryEditorState = null;
const financeWorkspace = createFinanceController((options = {}) => {
  const officialBackupPage = FINANCE_V4_ACTIVE && activePage === 'ledger-settings' && ledgerSettingsSubview === 'backup';
  const financeSettingPage = activePage === 'ledger-settings' && ['home', 'ledger', 'budget', 'preferences', 'defaults'].includes(ledgerSettingsSubview);
  if (!['accounts', 'reminders', 'ledger', 'add-entry'].includes(activePage) && !officialBackupPage && !financeSettingPage) return;
  if (['ledger', 'analytics'].includes(activePage)) workbenchState.subscriptionData = financeWorkspace.getLoadedReminderData();
  const scrollY = options.preserveScroll ? window.scrollY : null;
  render(activePage);
  if (scrollY !== null) window.scrollTo(0, scrollY);
  if (options.field) {
    const field = [...(root.querySelectorAll?.('[data-finance-field]') || [])].find((item) => item.dataset.financeForm === options.field.form && item.dataset.financeField === options.field.field);
    field?.focus?.({ preventScroll: true });
  }
  if (options.focus) {
    const target = (options.result ? root.querySelector('.finance-result') : root.querySelector('[data-finance-focus]')) || root.querySelector('.finance-result');
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }
  if (options.accountViewFocus) {
    const button = [...(root.querySelectorAll?.('[data-finance-action="account-view"]') || [])]
      .find((item) => item.dataset.view === options.accountViewFocus);
    (button || root.querySelector('.finance-operation-panel'))?.focus?.({ preventScroll: true });
  }
  if (options.financeFocus) (root.querySelector('.finance-posting-dialog') || root.querySelector('[data-finance-focus]'))?.focus?.({ preventScroll: true });
  if (options.focusBudgetDeleteCancel) root.querySelector('[data-budget-delete-cancel]')?.focus?.({ preventScroll: true });
  if (options.focusBudgetEditor) root.querySelector('.finance-budget-editor')?.focus?.({ preventScroll: true });
  if (options.focusBudgetDeleteId) {
    [...(root.querySelectorAll?.('[data-finance-action="delete-budget"]') || [])]
      .find((item) => item.dataset.budgetId === options.focusBudgetDeleteId)?.focus?.({ preventScroll: true });
  }
  if (options.focusRestoreDialog) root.querySelector('[data-finance-action="confirm-restore-final"]')?.focus?.({ preventScroll: true });
  if (options.focusResetDialog) root.querySelector('[data-finance-action="cancel-reset-confirmation"]')?.focus?.({ preventScroll: true });
  if (options.focusImportPreview) root.querySelector('[data-finance-import-preview-dialog] #finance-import-preview-title')?.focus?.({ preventScroll: true });
}, { mode: FINANCE_V4_ACTIVE ? 'official' : 'acceptance', allowDevelopmentPreview: FINANCE_V4_PREVIEW_ENABLED, onData: syncOfficialFinanceData });
root.addEventListener('toggle', (event) => {
  if (event.target.matches?.('.finance-account-event-history')) financeWorkspace.setAccountEventsExpanded(event.target.open);
}, true);
financeWorkspace.attachAccountOrdering(root);
financeWorkspace.attachBudgetOrdering(root);
const workbenchState = createWorkbenchState();
const initialOverviewPreferences = loadOverviewPreferences();
workbenchState.overviewPreferences = initialOverviewPreferences.value;
workbenchState.overviewPreferenceError = initialOverviewPreferences.error;
workbenchState.budgetRows = null;

function saveOverviewConfig(config, { collapseTransition = null } = {}) {
  const optionsOpen = root.querySelector('.budget-summary-options')?.open;
  const focusKey = document.activeElement?.dataset?.overviewFocus;
  const focusFilterToggle = document.activeElement?.dataset?.overviewFocusFilter !== undefined;
  const focusVisibleCount = document.activeElement?.dataset?.overviewFocusVisibleCount;
  const next = structuredClone(workbenchState.overviewPreferences);
  next[workbenchState.source === 'preview' ? 'preview' : 'personal'] = config;
  try { saveOverviewPreferences(next); workbenchState.overviewPreferences = next; workbenchState.overviewPreferenceError = ''; }
  catch (error) { workbenchState.overviewPreferenceError = `顯示設定未保存：${error.message}`; }
  const host = root.querySelector('[data-finance-host]');
  if (host) host.innerHTML = renderFinancePanel(categoryStore, workbenchState, activePage === 'analytics');
  if (collapseTransition && !root.ownerDocument?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    const { block, fromHeight } = collapseTransition;
    const content = block === 'subscriptions'
      ? host?.querySelector('.workbench-subscription-card .overview-collapsible-content')
      : host?.querySelector(`.overview-block[data-overview-item="${block}"] .overview-collapsible-content`);
    const expanded = content?.classList.contains('is-expanded');
    if (content?.animate && typeof fromHeight === 'number' && expanded !== undefined) {
      const toHeight = expanded ? content.scrollHeight : 0;
      if (Math.abs(fromHeight - toHeight) > 1) {
        const animation = content.animate([
          { height: `${fromHeight}px`, opacity: expanded ? 0 : 1, transform: `translateY(${expanded ? '-8px' : '0px'})` },
          { height: `${toHeight}px`, opacity: expanded ? 1 : 0, transform: `translateY(${expanded ? '0px' : '-8px'})` },
        ], { duration: 240, easing: 'cubic-bezier(.22,.72,.25,1)', fill: 'both' });
        animation.onfinish = () => animation.cancel();
      }
    }
  }
  if (optionsOpen && root.querySelector('.budget-summary-options')) root.querySelector('.budget-summary-options').open = true;
  if (focusKey) [...(root.querySelectorAll?.('[data-overview-focus]') || [])].find((field) => field.dataset.overviewFocus === focusKey)?.focus?.({ preventScroll: true });
  if (focusFilterToggle) root.querySelector('[data-overview-focus-filter]')?.focus?.({ preventScroll: true });
  if (focusVisibleCount) [...(root.querySelectorAll?.('[data-overview-focus-visible-count]') || [])].find((field) => field.dataset.overviewFocusVisibleCount === focusVisibleCount)?.focus?.({ preventScroll: true });
}
const backupState = createBackupPageState();
let financeReadSequence = 0;
let officialFinanceLoadPromise = null;
let cancelCategoryDrag = null;
const appPageHistory = [];
const historyState = createHistoryState();
let renderRevision = 0;
let categoryAuditPending = false;
let categoryAuditRecords = null;
let categoryLoadPromise = null;
let workbenchResizeObserver = null;
let sidebarExpandedWidth = 258;

function syncOfficialFinanceData(data, { mode, reason } = {}) {
  if (!FINANCE_V4_ACTIVE || mode !== 'official') return;
  const catalog = data?.categoryCatalog?.[0];
  const result = syncOfficialCategoryCache(categoryStore, catalog);
  categoryAuditRecords = null;
  if (!result.ok) {
    if (entryDraft.categoryId || entryDraft.subcategoryId) {
      entryDraft.feedback = `${result.error} 草稿內容已保留；請重新載入分類後確認。`;
      entryDraft.feedbackTone = 'error';
    }
  } else {
    const issue = getEntryDraftCategoryIssue(catalog, entryDraft);
    if (issue) { entryDraft.feedback = issue; entryDraft.feedbackTone = 'error'; }
    else if (entryDraft.feedback?.startsWith('原選取的')) { entryDraft.feedback = ''; entryDraft.feedbackTone = 'neutral'; }
  }
  if (reason === 'restore') {
    historyState.records = null;
    financeReadSequence += 1;
    workbenchState.records = null;
    workbenchState.budgetRows = null;
    workbenchState.subscriptionData = null;
    workbenchState.loading = false;
  }
}

async function ensureOfficialFinanceData() {
  if (!FINANCE_V4_ACTIVE) return false;
  if (!officialFinanceLoadPromise) {
    officialFinanceLoadPromise = financeWorkspace.refreshOfficialData().finally(() => { officialFinanceLoadPromise = null; });
  }
  await officialFinanceLoadPromise;
  return Boolean(financeWorkspace.getCategoryCatalog());
}

function refreshFinanceForCurrentRoute() {
  if (pageNeedsCategoryCatalog(activePage, ledgerSettingsSubview)) {
    void ensureCategoryCatalog();
    return;
  }
  const financeSettings = activePage === 'ledger-settings' && ['budget', 'preferences', 'defaults'].includes(ledgerSettingsSubview);
  if (['accounts', 'reminders'].includes(activePage)
    || (FINANCE_V4_ACTIVE && (['add-entry', 'ledger', 'analytics'].includes(activePage) || financeSettings))) {
    void financeWorkspace.onEnter();
  }
}

function applyFinanceEntryDefaults() {
  if (!FINANCE_V4_ACTIVE) return;
  applyEntryPreferencesToDraft(entryDraft, financeWorkspace.getEntryPreferences(), financeWorkspace.getActiveAccounts(), { today: getLocalDateInputValue() });
}

document.querySelectorAll('[data-nav-icon]').forEach((node) => {
  node.innerHTML = icon(node.dataset.navIcon, 20);
});
document.querySelectorAll('[data-icon]').forEach((node) => {
  node.innerHTML = icon(node.dataset.icon, 18);
});

function formatToday() {
  return new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}

function setSidebarMode(mode, width = sidebarExpandedWidth) {
  const body = document.body;
  const targetWidth = mode === 'hidden' ? 0 : mode === 'icons' ? 76 : Math.max(200, Math.min(360, width));
  body.classList.toggle('sidebar-collapsed', mode === 'icons');
  body.classList.toggle('sidebar-hidden', mode === 'hidden');
  body.style.setProperty('--sidebar-width', `${targetWidth}px`);
  if (mode === 'expanded') sidebarExpandedWidth = targetWidth;
  const button = document.querySelector('[data-action="toggle-sidebar"]');
  if (button) {
    const label = mode === 'expanded' ? '收合側邊選單為圖示列' : '展開側邊選單';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(mode === 'expanded'));
    button.title = label;
  }
  const hideButton = document.querySelector('[data-action="hide-sidebar"]');
  if (hideButton) hideButton.hidden = mode !== 'expanded';
  const restore = document.querySelector('[data-action="restore-sidebar"]');
  if (restore) restore.hidden = mode !== 'hidden';
  const handle = document.querySelector('[data-sidebar-resize]');
  if (handle) {
    handle.setAttribute('aria-valuenow', String(targetWidth));
    handle.setAttribute('aria-valuetext', mode === 'hidden' ? '側邊選單已收合' : mode === 'icons' ? '側邊選單為圖示列' : `側邊選單寬度 ${targetWidth} 像素`);
  }
  syncWorkbenchSplitter();
}

function setSidebarLiveWidth(width) {
  const requestedWidth = Math.max(0, Math.min(360, width));
  const isIconRail = requestedWidth < 200;
  const targetWidth = isIconRail ? 76 : requestedWidth;
  document.body.classList.toggle('sidebar-collapsed', isIconRail);
  document.body.classList.remove('sidebar-hidden');
  document.body.style.setProperty('--sidebar-width', `${targetWidth}px`);
  const handle = document.querySelector('[data-sidebar-resize]');
  if (handle) {
    handle.setAttribute('aria-valuenow', String(Math.round(targetWidth)));
    handle.setAttribute('aria-valuetext', isIconRail ? '側邊選單為完整圖示列' : `側邊選單寬度 ${Math.round(targetWidth)} 像素`);
  }
  const toggleButton = document.querySelector('[data-action="toggle-sidebar"]');
  if (toggleButton) {
    const label = isIconRail ? '展開側邊選單' : '收合側邊選單為圖示列';
    toggleButton.setAttribute('aria-label', label);
    toggleButton.setAttribute('aria-expanded', String(!isIconRail));
    toggleButton.title = label;
  }
  const hideButton = document.querySelector('[data-action="hide-sidebar"]');
  if (hideButton) hideButton.hidden = isIconRail;
  syncWorkbenchSplitter();
}

function attachSidebarResize() {
  const handle = document.querySelector('[data-sidebar-resize]');
  if (!handle) return;
  let pointerId = null;
  handle.addEventListener('pointerdown', (event) => {
    if (mobileQuery.matches) return;
    event.preventDefault();
    pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('is-sidebar-resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) setSidebarLiveWidth(event.clientX);
  });
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    const width = Number.parseFloat(document.body.style.getPropertyValue('--sidebar-width')) || 258;
    if (width <= 76) setSidebarMode('icons');
    else setSidebarMode('expanded', width);
    document.body.classList.remove('is-sidebar-resizing');
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('keydown', (event) => {
    if (mobileQuery.matches) return;
    const current = Number.parseFloat(document.body.style.getPropertyValue('--sidebar-width')) || (document.body.classList.contains('sidebar-collapsed') ? 76 : sidebarExpandedWidth);
    if (event.key === 'Home') setSidebarMode('icons');
    else if (event.key === 'End') setSidebarMode('expanded', 360);
    else if (event.key === 'ArrowLeft') {
      const next = current - (event.shiftKey ? 32 : 12);
      if (next < 200) setSidebarMode('icons');
      else setSidebarMode('expanded', next);
    } else if (event.key === 'ArrowRight') {
      const next = current <= 140 ? sidebarExpandedWidth : current + (event.shiftKey ? 32 : 12);
      setSidebarMode('expanded', next);
    }
    else return;
    event.preventDefault();
  });
}

function captureCurrentRoute() {
  return {
    pageId: activePage,
    ledgerSettingsSubview: activePage === 'ledger-settings' ? ledgerSettingsSubview : 'home',
    workbenchState: Object.fromEntries(['panel', 'source', 'leftRatio', 'layout', 'mobilePane'].map((key) => [key, workbenchState[key]])),
  };
}

function routeKey(route) {
  return `${route.pageId}:${['settings', 'ledger-settings'].includes(route.pageId) ? route.ledgerSettingsSubview : ''}`;
}

function normalizeRoute(pageId, subview = 'home') {
  if (pageId === 'settings' && FINANCE_SETTINGS_SUBVIEWS.has(subview)) return { pageId: 'ledger-settings', ledgerSettingsSubview: subview };
  if (pageId === 'ledger-settings') return { pageId, ledgerSettingsSubview: LEDGER_SETTINGS_SUBVIEWS.has(subview) ? subview : 'home' };
  if (!navigation.some((item) => item.id === pageId)) return { pageId: 'ledger', ledgerSettingsSubview: 'home' };
  return { pageId, ledgerSettingsSubview: 'home' };
}

function syncRouteHash(route) {
  const hash = route.pageId === 'ledger-settings'
    ? `#ledger-settings${route.ledgerSettingsSubview && route.ledgerSettingsSubview !== 'home' ? `/${route.ledgerSettingsSubview}` : ''}`
    : route.pageId === 'settings' ? '#settings' : `#${route.pageId}`;
  if (window.location?.hash === hash || !window.history?.replaceState) return;
  try { window.history.replaceState(window.history.state, '', hash); } catch { /* Routing remains usable in restricted embedded views. */ }
}

function routeFromLocation() {
  const hash = String(window.location?.hash || '').replace(/^#/, '');
  const [name, subview = 'home'] = hash.split('/');
  if (name === 'ledger-settings') return normalizeRoute('ledger-settings', subview);
  if (name === 'settings' && FINANCE_SETTINGS_SUBVIEWS.has(subview)) return normalizeRoute('ledger-settings', subview);
  if (name === 'settings') return normalizeRoute('settings');
  if (navigation.some((item) => item.id === name)) return normalizeRoute(name);
  return normalizeRoute('ledger');
}

function navigateTo(pageId, { subview = 'home', resetWorkbenchView = pageId === 'ledger', focus = true, recordHistory = true } = {}) {
  const currentRoute = captureCurrentRoute();
  const targetRoute = normalizeRoute(pageId, subview);
  if (recordHistory && routeKey(currentRoute) !== routeKey(targetRoute)) appPageHistory.push(currentRoute);

  if (targetRoute.pageId === 'ledger-settings') ledgerSettingsSubview = targetRoute.ledgerSettingsSubview;
  if (targetRoute.pageId === 'reminders') financeWorkspace.prepareReminderPage();
  if (['ledger', 'analytics'].includes(targetRoute.pageId)) { financeReadSequence += 1; workbenchState.records = null; workbenchState.subscriptionData = null; workbenchState.loading = false; }
  if (pageId === 'ledger' && resetWorkbenchView) workbenchState.mobilePane = 'entry';
  syncRouteHash(targetRoute);
  render(targetRoute.pageId, { focus });
  refreshFinanceForCurrentRoute();
}

function navigateBack() {
  const previousRoute = appPageHistory.pop();
  if (!previousRoute) return false;
  if (previousRoute.pageId === 'ledger-settings') ledgerSettingsSubview = previousRoute.ledgerSettingsSubview;
  Object.assign(workbenchState, previousRoute.workbenchState);
  if (['ledger', 'analytics'].includes(previousRoute.pageId)) { financeReadSequence += 1; workbenchState.records = null; workbenchState.subscriptionData = null; workbenchState.loading = false; }
  syncRouteHash(previousRoute);
  render(previousRoute.pageId, { focus: true });
  refreshFinanceForCurrentRoute();
  return true;
}

function addBackControlToHeading() {
  const heading = root.querySelector('.page-heading');
  if (!heading) return;

  const historyToolbar = heading.classList.contains('history-heading') ? heading.querySelector('.history-toolbar') : null;
  if (historyToolbar) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet-button app-back-control';
    button.dataset.action = 'app-back';
    button.setAttribute('aria-label', '返回上一頁');
    button.innerHTML = `${icon('chevron', 15)}返回上一頁`;
    historyToolbar.append(button);
    return;
  }

  let actionGroup = heading.querySelector(':scope > .page-heading-actions');
  if (!actionGroup) {
    actionGroup = document.createElement('div');
    actionGroup.className = 'page-heading-actions';
    const titleBlock = heading.firstElementChild;
    Array.from(heading.children).forEach((child) => {
      if (child !== titleBlock) actionGroup.append(child);
    });
    heading.append(actionGroup);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet-button app-back-control';
  button.dataset.action = 'app-back';
  button.setAttribute('aria-label', '返回上一頁');
  button.innerHTML = `${icon('chevron', 15)}返回上一頁`;
  actionGroup.append(button);
}

async function refreshHistory(revision) {
  const list = root.querySelector('[data-history-list]');
  if (!list || activePage !== 'history' || revision !== renderRevision) return;
  historyState.loading = true;
  historyState.error = '';
  renderHistoryContents(root, historyState);
  try {
    if (FINANCE_V4_ACTIVE && !await ensureOfficialFinanceData()) throw new Error('正式收支資料尚未載入。');
    const financeData = (FINANCE_V4_ACTIVE || financeWorkspace.hasFinanceData())
      ? await financeWorkspace.readHistorySnapshot()
      : null;
    const records = financeData
      ? [...financeData.expenses, ...financeData.incomes].sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt))
      : await listLedgerEntries();
    if (activePage !== 'history' || revision !== renderRevision || !list.isConnected) return;
    historyState.records = records;
    historyState.financeData = financeData;
    historyState.financeSource = financeData ? (financeWorkspace.getMode() === 'acceptance' ? 'acceptance-v4' : 'official-v4') : 'official-v3';
    historyState.canEditRecords = Boolean(financeData);
    historyState.loading = false;
    renderHistoryContents(root, historyState);
  } catch (error) {
    if (activePage !== 'history' || revision !== renderRevision || !list.isConnected) return;
    historyState.loading = false;
    historyState.error = error.message || '目前無法讀取歷史紀錄。';
    renderHistoryContents(root, historyState);
  }
}

function historyEntryById(id) {
  return [...(historyState.financeData?.expenses || []), ...(historyState.financeData?.incomes || [])].find((item) => item.id === id) || null;
}

function historyMinorInput(minor) {
  const value = BigInt(minor); const whole = value / 100n; const fraction = value % 100n;
  return fraction ? `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}` : String(whole);
}

function beginHistoryEdit(id) {
  const record = historyEntryById(id);
  if (!record || !historyState.canEditRecords) return false;
  if (historyState.recordEditor?.recordId === id) return false;
  if (historyState.recordEditor?.dirty && historyState.recordEditor.recordId !== id
    && !window.confirm('目前的修改尚未保存。要捨棄這些草稿並改編輯另一筆紀錄嗎？')) return false;
  const event = record.financeEventId ? historyState.financeData.accountEvents.find((item) => item.id === record.financeEventId) : null;
  const occurrence = record.reminderOccurrenceId ? historyState.financeData.reminderOccurrences.find((item) => item.id === record.reminderOccurrenceId) : null;
  historyState.recordEditor = {
    recordId: record.id,
    expectedEditRevision: Number.isSafeInteger(record.editRevision) ? record.editRevision : 0,
    expectedOccurrenceRevision: occurrence?.revision,
    expectedGeneration: historyState.financeData.financePreferences[0].generation,
    dirty: false,
    splitMode: false,
    draft: {
      date: record.occurredOn,
      amountTwd: historyMinorInput(record.amountMinor),
      categoryId: record.categoryId,
      subcategoryId: record.subcategoryId || '',
      accountId: record.accountId || '',
      paymentMethod: event?.paymentMethod || 'direct',
      note: record.note || '',
    },
  };
  historyState.historyNotice = '';
  return true;
}

function historyAmountToMinor(value, originalMinor) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized) || normalized.length > 18) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const numeric = Number(minor);
  if (numeric !== originalMinor && numeric % 100 !== 0) return null;
  return numeric;
}

function blankHistorySplit(source) {
  return { date: source.occurredOn, amountTwd: '', categoryId: '', subcategoryId: '', accountId: source.accountId || '', paymentMethod: 'direct', note: '' };
}

function historySelectionStore() {
  const catalog = historyState.financeData?.categoryCatalog?.[0];
  return catalog ? createCategoryStore({ catalog, ready: true }) : categoryStore;
}

function updateHistoryEditorField(target) {
  const editor = historyState.recordEditor;
  if (!editor || !target) return false;
  const editField = target.dataset?.historyEditField;
  const splitField = target.dataset?.historySplitField;
  if (!editField && !splitField) return false;
  const field = editField || splitField;
  let draft = editor.draft;
  if (splitField) {
    const index = Number(target.dataset.historySplitIndex);
    if (!Number.isInteger(index) || !editor.splits?.[index]) return true;
    draft = editor.splits[index];
  }
  draft[field] = target.value;
  if (field === 'categoryId') {
    const store = historySelectionStore();
    if (!store.isSubcategorySelectable(draft.categoryId, draft.subcategoryId)) draft.subcategoryId = '';
  }
  editor.dirty = true;
  historyState.historyNotice = '';
  return true;
}

function renderHistoryEditorKeepingFocus(target) {
  const editField = target.dataset?.historyEditField;
  const splitField = target.dataset?.historySplitField;
  const splitIndex = target.dataset?.historySplitIndex;
  renderHistoryContents(root, historyState);
  const field = [...(root.querySelectorAll?.('[data-history-edit-field], [data-history-split-field]') || [])].find((item) =>
    editField ? item.dataset.historyEditField === editField : item.dataset.historySplitField === splitField && item.dataset.historySplitIndex === splitIndex);
  field?.focus?.({ preventScroll: true });
}

async function saveHistoryEdit(split = false) {
  const editor = historyState.recordEditor;
  const source = editor && historyEntryById(editor.recordId);
  if (!editor || !source || !historyState.canEditRecords || editor.saving) return;
  historyState.historyNotice = '';
  editor.saving = true;
  renderHistoryContents(root, historyState);
  try {
    let command;
    if (split) {
      if (!Array.isArray(editor.splits) || editor.splits.length < 2) throw new Error('拆分至少需要兩筆。');
      const splits = editor.splits.map((line, index) => {
        const amount = String(line.amountTwd || '').trim();
        if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error(`拆分項目 ${index + 1} 的金額必須是正整數元。`);
        return { ...line, amountTwd: amount, ...(index ? { idempotencyKey: createIdempotencyKey() } : {}) };
      });
      command = { kind: 'split-entry', entryType: source.recordType, entryId: source.id, expectedEditRevision: editor.expectedEditRevision, splits };
    } else {
      const amountMinor = historyAmountToMinor(editor.draft.amountTwd, source.amountMinor);
      if (amountMinor === null) throw new Error('金額格式無效。新金額請輸入正整數元，舊紀錄原有分金額可保留。');
      command = { kind: 'edit-entry', entryType: source.recordType, entryId: source.id, expectedEditRevision: editor.expectedEditRevision, expectedOccurrenceRevision: editor.expectedOccurrenceRevision, amountMinor, ...editor.draft };
    }
    const result = await financeWorkspace.executeHistoryCommand(command, editor.expectedGeneration);
    const changed = [...result.data.expenses, ...result.data.incomes];
    historyState.financeData = result.data;
    historyState.records = changed.sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt));
    historyState.recordEditor = null;
    historyState.historyNotice = split ? `已拆分為 ${command.splits.length} 筆獨立紀錄。` : '修改已保存；帳戶餘額與預算已同步更新。';
    historyState.historyNoticeTone = 'success';
    renderHistoryContents(root, historyState);
  } catch (error) {
    if (historyState.recordEditor) historyState.recordEditor.saving = false;
    historyState.historyNotice = `未保存：${error.message}；草稿仍保留。`;
    historyState.historyNoticeTone = 'error';
    renderHistoryContents(root, historyState);
  }
}

async function confirmHistoryDelete() {
  const record = historyState.deleteRecord;
  if (!record || !historyState.canEditRecords || historyState.deletingRecord) return;
  const expectedGeneration = historyState.deleteGeneration;
  if (!Number.isSafeInteger(expectedGeneration)) {
    historyState.historyNotice = '資料版本已變更，請關閉視窗並重新載入紀錄後再刪除。';
    historyState.historyNoticeTone = 'error';
    renderHistoryContents(root, historyState);
    return;
  }
  historyState.historyNotice = '';
  historyState.deletingRecord = true;
  renderHistoryContents(root, historyState);
  try {
    const result = await financeWorkspace.executeHistoryCommand({
      kind: 'delete-entry', entryType: record.recordType, entryId: record.id,
      expectedEditRevision: Number.isSafeInteger(record.editRevision) ? record.editRevision : 0,
      confirmed: true,
    }, expectedGeneration);
    const changed = [...result.data.expenses, ...result.data.incomes];
    historyState.financeData = result.data;
    historyState.records = changed.sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.createdAt.localeCompare(left.createdAt));
    historyState.deleteRecord = null;
    historyState.deleteGeneration = null;
    historyState.historyNotice = '紀錄已刪除；帳戶餘額、歷史總額與預算已同步更新。';
    historyState.historyNoticeTone = 'success';
  } catch (error) {
    historyState.historyNotice = `未刪除：${error.message}`;
    historyState.historyNoticeTone = 'error';
  } finally {
    historyState.deletingRecord = false;
    renderHistoryContents(root, historyState);
  }
}

async function refreshFinance() {
  const sequence = ++financeReadSequence;
  workbenchState.loading = true;
  workbenchState.error = '';
  const update = () => {
    const host = root.querySelector('[data-finance-host]');
    if (host && ['ledger', 'analytics'].includes(activePage)) host.innerHTML = renderFinancePanel(categoryStore, { ...workbenchState, panel: activePage === 'analytics' ? 'analytics' : workbenchState.panel }, activePage === 'analytics');
  };
  update();
  try {
    let records;
    if (FINANCE_V4_ACTIVE) {
      if (!await ensureOfficialFinanceData()) throw new Error('正式收支資料尚未載入。');
      records = financeWorkspace.getLoadedLedgerEntries();
      if (!Array.isArray(records)) throw new Error('正式收支紀錄尚未完成載入。');
    } else records = await listLedgerEntries();
    if (sequence !== financeReadSequence) return;
    workbenchState.records = records;
    workbenchState.budgetRows = FINANCE_V4_ACTIVE ? financeWorkspace.getBudgetRows(getLocalDateInputValue().slice(0, 7)) : null;
    workbenchState.subscriptionData = FINANCE_V4_ACTIVE ? financeWorkspace.getLoadedReminderData() : null;
  } catch (error) {
    if (sequence !== financeReadSequence) return;
    workbenchState.error = error.message || '無法讀取收支統計，請稍後重新讀取。';
  } finally {
    if (sequence === financeReadSequence) {
      workbenchState.loading = false;
      update();
    }
  }
}

async function reorderCategoryItem(kind, id, parent, toIndex, livePreview = false) {
  if (backupState.busy || categoryStore.isMutationPending()) return;
  const positions = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? new Map() : captureSortPositions(root, kind, parent);
  const scrollTop = root.querySelector('.assigned-subcategory-list')?.scrollTop || 0;
  const result = await persistCategoryMutation((candidate) => kind === 'category' ? candidate.moveCategory(id, toIndex) : candidate.moveSubcategory(parent, id, toIndex), { preserveCategoryScroll: true, renderPending: !livePreview });
  setCategoryNotice(result.ok ? '排列順序已保存；新增記帳會使用相同順序。' : result.error.message, result.ok ? 'success' : 'error');
  if (activePage !== 'ledger-settings' || ledgerSettingsSubview !== 'categories') return;
  render('ledger-settings');
  const list = root.querySelector('.assigned-subcategory-list');
  if (list) list.scrollTop = scrollTop;
  const handle = Array.from(root.querySelectorAll?.('[data-sort-item]') || []).find((item) => item.dataset.sortId === id)?.querySelector('[data-sort-handle]');
  handle?.focus();
  if (result.ok) animateSortPositions(root, positions, window);
}

async function exportLedgerBackup() {
  if (backupState.busy) return;
  const renderBackupStatus = () => {
    if (activePage !== 'ledger-settings' || ledgerSettingsSubview !== 'backup') return;
    const scrollY = window.scrollY;
    render('ledger-settings');
    window.scrollTo(0, scrollY);
  };
  backupState.busy = true; backupState.notice = ''; renderBackupStatus();
  try {
    if (!await ensureCategoryCatalog()) throw new Error('分類設定未載入，無法確認完整備份。');
    const data = await readOfficialSnapshot();
    const backup = await createLedgerBackup(data);
    await validateLedgerBackup(backup.text);
    const url = URL.createObjectURL(new Blob([backup.text], { type: 'application/json;charset=utf-8' }));
    try {
      const link = document.createElement('a'); link.href = url;
      link.download = `Life-Record_ledger_${backup.exportedAt.replace(/[:.]/g, '-')}.json`;
      document.body.append(link); link.click(); link.remove();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    backupState.notice = `已驗證並啟動 JSON 下載：支出 ${backup.summary.expenses} 筆、收入 ${backup.summary.incomes} 筆。請確認檔案已下載保存。`;
    backupState.tone = 'success';
  } catch (error) { backupState.notice = `備份未完成：${error.message}`; backupState.tone = 'error'; }
  backupState.busy = false;
  renderBackupStatus();
}

async function previewLedgerRestore(file) {
  if (backupState.busy || !file) return;
  const renderBackupStatus = () => {
    if (activePage !== 'ledger-settings' || ledgerSettingsSubview !== 'backup') return;
    const scrollY = window.scrollY;
    render('ledger-settings');
    window.scrollTo(0, scrollY);
  };
  backupState.preview = null; backupState.expectedToken = ''; backupState.confirmation = ''; backupState.previewMatchesCurrent = false;
  backupState.backupSavedOutsideProfile = false; backupState.previewConfirmation = ''; backupState.selectedBackupName = file.name || '已選擇備份檔'; backupState.fileValidationStatus = '正在驗證'; backupState.busy = true; renderBackupStatus();
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('檔案超過 20 MiB 上限。');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    const preview = await validateLedgerBackup(text);
    if (!categoryStore.isReady()) throw new Error('分類設定尚未載入完成，請先完成載入後重新選檔。');
    const current = await readOfficialSnapshot();
    const currentToken = officialSnapshotToken(current);
    backupState.expectedToken = currentToken;
    backupState.previewMatchesCurrent = matchesFinancePreviewBackup(preview, current, officialSnapshotToken);
    backupState.preview = { ...preview, currentSummary: validateOfficialSnapshot(current), backupToken: officialSnapshotToken(preview.data) };
    backupState.notice = backupState.previewMatchesCurrent
      ? '備份已驗證，且與目前 V3 資料完全相符；可用於 V4 開發預覽確認。資料尚未變更。'
      : '備份本身有效，但與目前 V3 資料不同；可檢視或還原，但不能用來啟用 V4 預覽。';
    backupState.tone = backupState.previewMatchesCurrent ? 'success' : 'error';
    backupState.fileValidationStatus = backupState.previewMatchesCurrent ? '格式驗證及目前資料比對通過' : '檔案有效，但與目前資料不同';
  } catch (error) { backupState.notice = `未還原：${error.message}`; backupState.tone = 'error'; backupState.fileValidationStatus = '驗證失敗'; }
  backupState.busy = false;
  renderBackupStatus();
}

function setPreviewActivationButtonState() {
  const button = root.querySelector('[data-action="enable-v4-preview"]');
  if (button) button.disabled = backupState.busy || !backupState.previewMatchesCurrent
    || !backupState.backupSavedOutsideProfile || backupState.previewConfirmation !== '啟用 V4 開發預覽';
}

function rememberFinancePreviewNotice(message, tone = 'success') {
  try { window.sessionStorage.setItem('LifeRecord_FinanceV4PreviewNotice_v1', JSON.stringify({ message, tone })); }
  catch { /* The persistent preview marker still protects routing if session storage is unavailable. */ }
}

async function enableFinanceV4Preview() {
  if (backupState.busy || !backupState.preview || !backupState.previewMatchesCurrent
    || !backupState.backupSavedOutsideProfile || backupState.previewConfirmation !== '啟用 V4 開發預覽') return;
  if (!isFinancePreviewLocation(window)) { backupState.notice = '僅能在 http://127.0.0.1:5510/ 主頁啟用。'; backupState.tone = 'error'; render('ledger-settings'); return; }
  if (entryDraft.isSaving || categoryStore.isMutationPending()) { backupState.notice = '仍有記帳或分類資料正在保存；請完成後重新核對備份。'; backupState.tone = 'error'; render('ledger-settings'); return; }
  if (!window.confirm(`最後確認：將在目前瀏覽器設定檔，把 ${FINANCE_PREVIEW_DATABASE_NAME} 由 v3 升級至 v4。這個資料庫版本不能直接降回 v3。\n\n本次備份已通過驗證並與目前 V3 資料相同。其他瀏覽器設定檔不會被切換。確定繼續？`)) return;
  backupState.busy = true; backupState.notice = '正在檢查目前 V3 資料並執行同庫升級…'; backupState.tone = 'neutral'; render('ledger-settings');
  let previewStateWritten = false;
  try {
    const latestV3 = await readOfficialSnapshot();
    const latestToken = officialSnapshotToken(latestV3);
    if (latestToken !== backupState.expectedToken || latestToken !== backupState.preview.backupToken) {
      backupState.previewMatchesCurrent = false;
      throw new Error('預覽後的 V3 資料已變動，升級已取消。請重新匯出、選取並核對最新備份。');
    }
    if (!matchesFinancePreviewBackup(backupState.preview, latestV3, officialSnapshotToken)) throw new Error('選取的檔案不是與目前內容相同的已驗證 V3 備份。');
    activateFinancePreview(window, { backupSha256: backupState.preview.sha256 });
    previewStateWritten = true;
    const repository = createFinanceRepository({
      mode: 'official', environment: window, allowDevelopmentPreview: true,
      onOpenStatus(status) {
        if (!['blocked', 'blocked-settled', 'blocked-resolved'].includes(status?.state)) return;
        backupState.notice = status.message; backupState.tone = 'error'; render('ledger-settings');
      },
    });
    const upgraded = await repository.initialize();
    if (!Array.isArray(upgraded.expenses) || !Array.isArray(upgraded.incomes)
      || !Array.isArray(upgraded.categoryCatalog) || !upgraded.financePreferences?.[0]
      || FINANCE_STORES.length !== 8 || !FINANCE_STORES.every((name) => Array.isArray(upgraded[name]))) {
      const error = new Error('V4 集合驗證未通過；保留已升級資料庫，不會回寫或刪除任何資料。'); error.databaseVersion = 4; throw error;
    }
    if (upgraded.financePreferences[0].dataset !== 'official'
      || stableJson(upgraded.expenses) !== stableJson(latestV3.expenses)
      || stableJson(upgraded.incomes) !== stableJson(latestV3.incomes)
      || stableJson(upgraded.categoryCatalog) !== stableJson(latestV3.categoryCatalog)) {
      const error = new Error('升級後的 V3 收支或分類與原始內容不一致；保留資料庫並停止進一步操作。'); error.databaseVersion = 4; throw error;
    }
    backupState.busy = false;
    rememberFinancePreviewNotice('V4 開發預覽已啟用。原有 V3 收入、支出與分類已逐筆核對保留；重新整理後，一般記帳、歷史、帳戶、預算、提醒及設定會使用同一份 V4 資料。', 'success');
    window.location.reload();
  } catch (error) {
    const actualVersion = error?.databaseVersion;
    if (previewStateWritten && actualVersion === 3) {
      const cleared = clearFinancePreviewState(window);
      if (!cleared) {
        backupState.busy = false;
        rememberFinancePreviewNotice('升級未完成，但本機預覽標記無法安全撤銷；重新載入後會改以 V4 安全模式檢查，不會再從 V3 寫入。', 'error');
        window.location.reload();
        return;
      }
      backupState.busy = false;
      backupState.notice = `升級沒有完成，資料庫仍為 v3；原資料保留。${error.message || ''}`;
      backupState.tone = 'error';
      render('ledger-settings');
      return;
    }
    if (previewStateWritten) {
      backupState.busy = false;
      rememberFinancePreviewNotice(`V4 開發預覽已記錄，但升級結果需重新讀取確認：${error.message || '未知錯誤'}。沒有刪除或重建資料庫。`, 'error');
      window.location.reload();
      return;
    }
    backupState.busy = false; backupState.notice = `沒有啟用預覽：${error.message || '安全檢查失敗。'}`; backupState.tone = 'error'; render('ledger-settings');
  }
}

async function confirmLedgerRestore() {
  if (backupState.busy || !categoryStore.isReady() || !backupState.preview || backupState.confirmation !== '完整還原') return;
  if (entryDraft.isSaving || categoryStore.isMutationPending()) { backupState.notice = '仍有資料正在保存，請完成後重新預覽。'; render('ledger-settings'); return; }
  if (!window.confirm('確定以此備份完整取代目前的收入、支出與分類設定？\n\n備份中沒有的目前記帳紀錄也會被取代。請先確認已下載目前資料的備份。')) return;
  backupState.busy = true; render('ledger-settings');
  try {
    await restoreOfficialSnapshot(backupState.preview.data, backupState.expectedToken);
  } catch (error) {
    backupState.busy = false; backupState.confirmation = ''; backupState.notice = `還原沒有完成：${error.message}`; backupState.tone = 'error';
    if (error.code === 'RESTORE_CONFLICT') { backupState.preview = null; backupState.expectedToken = ''; }
    if (activePage === 'ledger-settings' && ledgerSettingsSubview === 'backup') render('ledger-settings');
    return;
  }
  backupState.preview = null; backupState.expectedToken = ''; backupState.confirmation = '';
  categoryAuditRecords = null; categoryEditorState = null; historyState.records = null;
  financeReadSequence += 1; workbenchState.records = null; workbenchState.loading = false; workbenchState.error = '';
  backupState.notice = '完整還原已完成；收入、支出與分類已在同一交易取代。分類 revision 會前進，保護其他分頁的舊修改。'; backupState.tone = 'success';
  try { const catalog = await readCategoryCatalog(); if (!categoryStore.replaceCatalog(catalog)) throw new Error('分類目錄無法載入'); clearUnavailableEntrySelection(); }
  catch { categoryStore.setLoadState({ ready: false, error: '還原已完成，但分類畫面尚未刷新，請重新整理。' }); backupState.notice += ' 請重新整理以載入已還原的分類。'; }
  backupState.busy = false;
  if (activePage === 'ledger-settings' && ledgerSettingsSubview === 'backup') render('ledger-settings');
}

function updateEntryField(field, value) {
  if (entryDraft[field] === value) return false;
  entryDraft[field] = value;
  entryDraft.userEdited = true;
  entryDraft.idempotencyKey = createIdempotencyKey();
  entryDraft.submissionBlocked = false;
  entryDraft.feedback = '';
  entryDraft.feedbackTone = 'neutral';
  const feedback = root.querySelector('[data-entry-feedback]');
  if (feedback) {
    feedback.textContent = '資料已變更，確認後會保存至本機資料庫。';
    feedback.classList.remove('success', 'error');
  }
  const submit = root.querySelector('[data-action="confirm-entry"]');
  if (submit && !entryDraft.isSaving) submit.disabled = false;
  return true;
}

function switchEntryType(nextType) {
  switchEntryDraftType(entryDraft, nextType);
}

function getWorkbenchSplitterLabel(layout) {
  if (layout === 'entry') return '右側面板已收合。按 Enter 或拖曳此處向左，恢復雙欄工作區。';
  if (layout === 'side') return '新增記帳區已收合。按 Enter 或拖曳此處向右，恢復雙欄工作區。';
  return '拖曳或使用方向鍵調整欄寬；Shift 加 Home 或 End 可收合其中一側。';
}

function syncWorkbenchSplitter() {
  const grid = root.querySelector('#workbench-grid');
  const splitter = root.querySelector('[data-workbench-splitter]');
  if (!grid || !splitter) return;
  const width = grid.getBoundingClientRect().width;
  const bounds = getWorkbenchColumnBounds(width);
  const stacked = workbenchStackedQuery.matches || !bounds;
  grid.classList.toggle('is-stacked', stacked);
  root.querySelector('.workbench-shell')?.classList.toggle('is-stacked', stacked);
  const narrowSwitch = root.querySelector('.workbench-narrow-switch');
  if (narrowSwitch) narrowSwitch.hidden = !stacked;
  grid.classList.toggle('is-entry-only', workbenchState.layout === 'entry');
  grid.classList.toggle('is-side-only', workbenchState.layout === 'side');
  grid.dataset.workbenchLayout = workbenchState.layout;
  if (stacked) {
    grid.style.gridTemplateColumns = '';
    return;
  }

  const appliedRatio = Math.max(bounds.minimum, Math.min(bounds.maximum, workbenchState.leftRatio));
  workbenchState.leftRatio = appliedRatio;
  const roundedRatio = Math.round(appliedRatio);
  if (workbenchState.layout === 'entry') grid.style.gridTemplateColumns = 'minmax(0, 1fr) 14px 0px';
  else if (workbenchState.layout === 'side') grid.style.gridTemplateColumns = '0px 14px minmax(0, 1fr)';
  else grid.style.gridTemplateColumns = `minmax(0, ${appliedRatio}fr) 14px minmax(0, ${100 - appliedRatio}fr)`;
  splitter.classList.toggle('is-edge-handle', workbenchState.layout !== 'split');
  splitter.classList.toggle('is-side-handle', workbenchState.layout === 'side');
  splitter.setAttribute('aria-valuemin', String(Math.round(bounds.minimum)));
  splitter.setAttribute('aria-valuemax', String(Math.round(bounds.maximum)));
  splitter.setAttribute('aria-valuenow', String(workbenchState.layout === 'entry' ? 100 : workbenchState.layout === 'side' ? 0 : roundedRatio));
  const label = getWorkbenchSplitterLabel(workbenchState.layout);
  splitter.setAttribute('aria-label', label);
  splitter.setAttribute('aria-valuetext', workbenchState.layout === 'split' ? `新增記帳 ${roundedRatio}%，右側面板 ${100 - roundedRatio}%` : label);
  splitter.title = label;
}

function attachWorkbenchSplitter() {
  const grid = root.querySelector('#workbench-grid');
  const splitter = root.querySelector('[data-workbench-splitter]');
  if (!grid || !splitter) return;

  let pointerId = null;
  const updateFromPointer = (event) => {
    const rect = grid.getBoundingClientRect();
    const result = resolveWorkbenchDrag(workbenchState.layout, event.clientX - rect.left, rect.width);
    workbenchState.layout = result.layout;
    if (result.leftRatio !== null) workbenchState.leftRatio = result.leftRatio;
    syncWorkbenchSplitter();
  };

  splitter.addEventListener('pointerdown', (event) => {
    if (grid.classList.contains?.('is-stacked')) return;
    event.preventDefault();
    pointerId = event.pointerId;
    splitter.setPointerCapture(pointerId);
    splitter.classList.add('is-dragging');
    document.body.classList.add('is-workbench-resizing');
    updateFromPointer(event);
  });
  splitter.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    updateFromPointer(event);
  });
  const finishDrag = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    splitter.classList.remove('is-dragging');
    document.body.classList.remove('is-workbench-resizing');
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  };
  splitter.addEventListener('pointerup', finishDrag);
  splitter.addEventListener('pointercancel', finishDrag);
  splitter.addEventListener('lostpointercapture', finishDrag);
  splitter.addEventListener('keydown', (event) => {
    if (grid.classList.contains?.('is-stacked')) return;
    const rect = grid.getBoundingClientRect();
    const next = resolveWorkbenchKeyboard(workbenchState.layout, workbenchState.leftRatio, event.key, event.shiftKey, rect.width);
    if (!next.handled) return;
    workbenchState.layout = next.layout;
    workbenchState.leftRatio = next.leftRatio;
    event.preventDefault();
    syncWorkbenchSplitter();
  });
  syncWorkbenchSplitter();
  if (typeof ResizeObserver === 'function') {
    workbenchResizeObserver = new ResizeObserver(syncWorkbenchSplitter);
    workbenchResizeObserver.observe(grid);
  }
}

function clearUnavailableEntrySelection() {
  if (FINANCE_V4_ACTIVE) {
    const issue = getEntryDraftCategoryIssue(categoryStore.exportCatalog(), entryDraft);
    if (issue) { entryDraft.feedback = issue; entryDraft.feedbackTone = 'error'; }
    else if (entryDraft.feedback?.startsWith('原選取的')) { entryDraft.feedback = ''; entryDraft.feedbackTone = 'neutral'; }
    return false;
  }
  reconcileEntryDraftSelection(categoryStore, entryDraft);
}

function setCategoryNotice(message, tone = 'neutral') {
  if (!categoryEditorState) return;
  categoryEditorState.notice = message;
  categoryEditorState.noticeTone = tone;
}

function showSubcategoryInfoDialog(title, message) {
  categoryEditorState ||= createCategoryEditorState(categoryStore, entryDraft.type);
  categoryEditorState.unlinkConfirmation = null;
  categoryEditorState.subcategoryDialog = { kind: 'info', title, message };
  render('ledger-settings');
  root.querySelector('[data-action="close-subcategory-dialog"]')?.focus({ preventScroll: true });
}

async function auditCategoryReferences() {
  if (categoryAuditPending) return false;
  categoryAuditPending = true;
  categoryStore.setTransactionReferences(null);
  categoryAuditRecords = null;
  try {
    if (FINANCE_V4_ACTIVE && !await ensureOfficialFinanceData()) throw new Error('正式收支資料尚未載入。');
    const records = FINANCE_V4_ACTIVE ? await financeWorkspace.readLedgerEntries() : await listLedgerEntries();
    if (!categoryStore.setTransactionReferences(records)) throw new Error('無法確認已保存紀錄的分類引用。');
    categoryAuditRecords = records;
    return activePage === 'ledger-settings' && ledgerSettingsSubview === 'categories';
  } catch (error) {
    setCategoryNotice(`未刪除分類：${error.message || '無法讀取已保存的收支紀錄。'}`, 'error');
    if (activePage === 'ledger-settings' && ledgerSettingsSubview === 'categories') render('ledger-settings');
    return false;
  } finally {
    categoryAuditPending = false;
  }
}

function pageNeedsCategoryCatalog(pageId = activePage, subview = ledgerSettingsSubview) {
  return ['ledger', 'add-entry', 'history', 'analytics'].includes(pageId)
    || (pageId === 'ledger-settings' && ['home', 'ledger', 'categories', 'backup'].includes(subview));
}

function ensureCategoryCatalog() {
  if (categoryLoadPromise) return categoryLoadPromise;
  if (!FINANCE_V4_ACTIVE && categoryStore.isReady()) return Promise.resolve(true);
  if (!FINANCE_V4_ACTIVE && categoryStore.getLoadError()) return Promise.resolve(false);

  const wasReady = categoryStore.isReady();
  const previousRevision = categoryStore.getRevision?.() ?? null;
  if (!wasReady) categoryStore.setLoadState({ ready: false, error: '' });
  categoryLoadPromise = (async () => {
    try {
      if (FINANCE_V4_ACTIVE) {
        await ensureOfficialFinanceData();
        const catalog = financeWorkspace.getCategoryCatalog();
        if (!catalog || !categoryStore.isReady()) throw new Error('正式 v4 分類目錄尚未載入。');
        // refreshOfficialData publishes the repository snapshot into categoryStore.
        // Do not return here: the first render may still contain the loading state.
        clearUnavailableEntrySelection();
      } else {
        const { catalog } = await loadOrInitializeCategoryCatalog(createMinimumFinanceCatalog());
        if (!categoryStore.replaceCatalog(catalog)) throw new Error('已保存的分類目錄格式無法使用。');
        categoryAuditRecords = null;
        if (categoryEditorState) categoryEditorState = createCategoryEditorState(categoryStore, categoryEditorState.entryType);
        clearUnavailableEntrySelection();
      }

      const revisionChanged = previousRevision !== null && previousRevision !== (categoryStore.getRevision?.() ?? null);
      if (pageNeedsCategoryCatalog() && (!wasReady || revisionChanged)) render(activePage);
      return true;
    } catch (error) {
      categoryStore.setLoadState({ ready: false, error: error.message || '無法讀取分類設定。' });
      if (pageNeedsCategoryCatalog()) render(activePage);
      return false;
    }
  })().finally(() => { categoryLoadPromise = null; });
  return categoryLoadPromise;
}

async function refreshCategoryCatalogAfterConflict(entryType, selectedCategoryId) {
  try {
    const catalog = FINANCE_V4_ACTIVE
      ? (await financeWorkspace.refreshOfficialData()).categoryCatalog[0]
      : (await loadOrInitializeCategoryCatalog(createMinimumFinanceCatalog())).catalog;
    if (!categoryStore.replaceCatalog(catalog)) throw new Error('最新分類目錄格式無法使用。');
    categoryAuditRecords = null;
    clearUnavailableEntrySelection();
    if (!categoryStore.getCategory(selectedCategoryId)) categoryEditorState = createCategoryEditorState(categoryStore, entryType);
    else {
      categoryEditorState.entryType = entryType;
      categoryEditorState.selectedCategoryId = selectedCategoryId;
    }
  } catch (error) {
    categoryStore.setLoadState({ ready: false, error: error.message || '無法重新讀取分類設定。' });
  }
}

async function persistCategoryMutation(mutator, { preserveCategoryScroll = false, renderPending = true } = {}) {
  if (!categoryStore.isReady()) return { ok: false, error: new Error('分類設定尚未載入。') };
  if (categoryStore.isMutationPending()) return { ok: false, error: new Error('分類變更正在保存，請稍候。') };
  const expectedRevision = categoryStore.getRevision();
  const candidate = createCategoryStore({ catalog: categoryStore.exportCatalog(), ready: true });
  if (Array.isArray(categoryAuditRecords)) candidate.setTransactionReferences(categoryAuditRecords);
  let result;
  try { result = mutator(candidate); }
  catch (error) { return { ok: false, error }; }
  if (!result || result.ok === false) return { ok: false, result, error: new Error(result?.reason || '分類操作未完成，沒有變更資料。') };
  const nextCatalog = candidate.exportCatalog();
  nextCatalog.revision = expectedRevision + 1;
  const previousEntryType = categoryEditorState?.entryType || entryDraft.type;
  const previousSelection = categoryEditorState?.selectedCategoryId || '';
  const categoryScroll = preserveCategoryScroll ? root.querySelector('.assigned-subcategory-list')?.scrollTop || 0 : 0;
  categoryStore.setMutationPending(true);
  if (renderPending && activePage === 'ledger-settings' && ledgerSettingsSubview === 'categories') {
    render('ledger-settings');
    const list = root.querySelector('.assigned-subcategory-list');
    if (list && preserveCategoryScroll) list.scrollTop = categoryScroll;
  }
  try {
    const savedCatalog = FINANCE_V4_ACTIVE
      ? await financeWorkspace.saveOfficialCategoryCatalog(nextCatalog, expectedRevision)
      : await saveCategoryCatalog(nextCatalog, expectedRevision);
    if (!categoryStore.replaceCatalog(savedCatalog)) throw new Error('保存完成但目錄格式無法載入，請重新載入頁面。');
    categoryAuditRecords = null;
    categoryStore.setMutationPending(false);
    return { ok: true, result };
  } catch (error) {
    categoryStore.setMutationPending(false);
    if (['CATEGORY_REVISION_CONFLICT', 'FINANCE_CONFLICT'].includes(error.code)) {
      await refreshCategoryCatalogAfterConflict(previousEntryType, previousSelection);
      setCategoryNotice('另一個分頁已更新分類。已載入最新版；請檢查後重新套用尚未保存的變更。', 'error');
    } else {
      setCategoryNotice(`分類沒有保存：${error.message || '資料庫交易失敗。'}`, 'error');
    }
    return { ok: false, error };
  }
}

function selectNextManageableCategory() {
  const next = categoryStore.listCategories({ includeHidden: Boolean(categoryEditorState.hiddenEditMode), entryType: categoryEditorState.entryType }).find((item) => !item.hidden);
  if (next) selectCategoryForEditing(categoryStore, categoryEditorState, next.id);
  else {
    categoryEditorState.selectedCategoryId = '';
    categoryEditorState.draftName = '';
    categoryEditorState.draftIcon = 'tag';
    categoryEditorState.draftColor = '#8795A7';
    categoryEditorState.searchQuery = '';
    categoryEditorState.newSubcategoryName = '';
    categoryEditorState.editingSubcategoryId = '';
    categoryEditorState.draftSubcategoryName = '';
  }
}

function render(pageId, { focus = false } = {}) {
  cancelCategoryDrag?.();
  workbenchResizeObserver?.disconnect();
  workbenchResizeObserver = null;
  const revision = ++renderRevision;
  const page = navigation.find((item) => item.id === pageId)
    || (pageId === 'ledger-settings' ? { id: 'ledger-settings', label: '記帳設定', title: '記帳設定', subtitle: '管理記帳模組與資料。' } : navigation[0]);
  activePage = page.id;
  document.querySelector('#main-content')?.classList.toggle('is-ledger-page', ['ledger', 'add-entry', 'history', 'analytics', 'accounts', 'reminders', 'ledger-settings'].includes(page.id));
  if (['ledger', 'add-entry'].includes(page.id)) clearUnavailableEntrySelection();
  const ledgerSettingsPage = page.id === 'ledger-settings';
  const showingCategories = ledgerSettingsPage && ledgerSettingsSubview === 'categories';
  const showingLedgerSettings = ledgerSettingsPage && ledgerSettingsSubview === 'home';
  const showingFinanceSetting = ledgerSettingsPage && ['ledger', 'budget', 'preferences', 'defaults'].includes(ledgerSettingsSubview);
  const workbenchPage = ['ledger', 'add-entry'].includes(page.id);
  if (workbenchPage) applyFinanceEntryDefaults();
  const financeSettingLabels = { ledger: '記帳設定', budget: '每月預算', preferences: '記帳偏好', defaults: '分類預設帳戶' };
  const pageLabel = ledgerSettingsPage && ledgerSettingsSubview === 'backup' ? '記帳資料與安全管理' : showingCategories ? '記帳分類' : showingLedgerSettings ? '記帳設定' : showingFinanceSetting ? financeSettingLabels[ledgerSettingsSubview] : workbenchPage ? '記帳工作區' : page.label;
  currentCrumb.textContent = ledgerSettingsPage && !showingLedgerSettings ? `記帳設定 / ${pageLabel}` : pageLabel;
  document.title = `${pageLabel}｜記帳 V5`;
  const financePages = new Set(['ledger', 'ledger-settings', 'add-entry', 'history', 'analytics', 'accounts', 'reminders']);
  document.querySelectorAll('.nav-link').forEach((link) => {
    const selected = link.dataset.page === page.id || (link.dataset.page === 'ledger' && financePages.has(page.id));
    link.classList.toggle('is-active', selected);
    if (link.dataset.page === page.id || (link.dataset.page === 'ledger' && page.id === 'ledger-settings')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (page.id === 'ledger') {
    const accounts = FINANCE_V4_ACTIVE ? financeWorkspace.getActiveAccounts() : null;
    if (FINANCE_V4_ACTIVE) applyResolvedAccountToDraft(entryDraft, financeWorkspace.getDefaultAccount(entryDraft.type, entryDraft.categoryId), accounts);
    root.innerHTML = renderWorkbench(categoryStore, entryDraft, workbenchState, { accounts });
  }
  else if (page.id === 'add-entry') {
    const accounts = FINANCE_V4_ACTIVE ? financeWorkspace.getActiveAccounts() : null;
    if (FINANCE_V4_ACTIVE) applyResolvedAccountToDraft(entryDraft, financeWorkspace.getDefaultAccount(entryDraft.type, entryDraft.categoryId), accounts);
    const pendingReminders = FINANCE_V4_ACTIVE ? financeWorkspace.getPendingReminders(entryDraft.type) : null;
    root.innerHTML = renderAddEntryPage(categoryStore, entryDraft, { accounts, pendingReminders });
  }
  else if (page.id === 'history') root.innerHTML = renderHistoryPage(page, historyState);
  else if (page.id === 'analytics') {
    root.innerHTML = renderFullWorkbenchPanel(categoryStore, { ...workbenchState, panel: 'analytics' });
  } else if (ledgerSettingsPage && showingLedgerSettings) root.innerHTML = financeWorkspace.renderSetting('ledger');
  else if (ledgerSettingsPage && showingCategories) {
    categoryEditorState ||= createCategoryEditorState(categoryStore, entryDraft.type);
    root.innerHTML = renderCategorySettingsPage(categoryStore, categoryEditorState);
  } else if (ledgerSettingsPage && ledgerSettingsSubview === 'backup') root.innerHTML = FINANCE_V4_ACTIVE ? financeWorkspace.render('backup') : renderLedgerBackupPage({ ...backupState, catalogReady: categoryStore.isReady(), catalogError: categoryStore.getLoadError(), previewEnvironmentAllowed: isFinancePreviewLocation(window) });
  else if (ledgerSettingsPage && showingFinanceSetting) root.innerHTML = financeWorkspace.renderSetting(ledgerSettingsSubview);
  else if (['accounts', 'reminders'].includes(page.id)) root.innerHTML = financeWorkspace.render(page.id);
  else root.innerHTML = '<p class="finance-empty">找不到記帳頁面。請回到記帳工作區。</p>';
  if (['history', 'analytics', 'accounts', 'reminders', 'ledger-settings'].includes(page.id)) {
    const heading = root.querySelector('.page-heading');
    heading?.classList.add('finance-subpage-heading');
    if (page.id !== 'ledger-settings' || showingFinanceSetting) heading?.classList.add('finance-page-heading');
  }
  const backControl = root.querySelector('[data-action="app-back"]');
  const ledgerSettingsHasHomeFallback = page.id === 'ledger-settings' && ledgerSettingsSubview !== 'home';
  const ledgerSettingsCanReturn = page.id === 'ledger-settings';
  if (backControl) backControl.hidden = appPageHistory.length === 0 && !ledgerSettingsCanReturn;
  const ledgerSettingsProvidesReturn = page.id === 'ledger-settings' && ledgerSettingsSubview === 'home';
  const canInsertBackControl = (appPageHistory.length > 0 || ledgerSettingsHasHomeFallback)
    && !backControl
    && !ledgerSettingsProvidesReturn
    && !['home', 'ledger', 'analytics'].includes(page.id);
  if (canInsertBackControl) addBackControlToHeading();
  if (page.id === 'ledger') attachWorkbenchSplitter();
  if (page.id === 'history') void refreshHistory(revision);
  if (['ledger', 'analytics'].includes(page.id) && workbenchState.source === 'personal' && workbenchState.records === null && !workbenchState.loading) void refreshFinance();
  if (pageNeedsCategoryCatalog(page.id) && !categoryStore.isReady() && !categoryStore.getLoadError()) void ensureCategoryCatalog();
  if (focus) root.focus({ preventScroll: true });
}

document.addEventListener('click', async (event) => {
  const openHistoryDatePicker = root.querySelector('.history-date-range-picker[open]');
  if (openHistoryDatePicker && !openHistoryDatePicker.contains(event.target)) openHistoryDatePicker.open = false;
  const categoryPicker = root.querySelector('.finance-category-picker[open]');
  if (categoryPicker && !categoryPicker.contains(event.target)) categoryPicker.open = false;
  const leavesDefaultSettings = activePage === 'ledger-settings' && ['home', 'ledger', 'defaults'].includes(ledgerSettingsSubview)
    && financeWorkspace.hasUnsavedDefaultDrafts?.()
    && event.target.closest?.('[data-page], [data-action="app-back"], [data-action="open-ledger-settings"], [data-action="open-ledger-backup"], [data-finance-action="disconnect"]');
  const disconnectingFinance = Boolean(event.target.closest?.('[data-finance-action="disconnect"]'));
  const defaultDraftWarning = disconnectingFinance
    ? '分類預設帳戶還有未儲存變更。離開測試資料會捨棄這些草稿，確定繼續？'
    : '分類預設帳戶還有未儲存變更。確定離開？返回此頁時仍會保留這次暫存。';
  if (leavesDefaultSettings && !window.confirm(defaultDraftWarning)) {
    event.preventDefault();
    return;
  }
  if (leavesDefaultSettings && disconnectingFinance) financeWorkspace.discardDefaultDrafts?.();
  const financeAction = event.target.closest?.('[data-finance-action]');
  if (financeAction) { event.preventDefault(); await financeWorkspace.click(financeAction); return; }
  const reminderPostingBackdrop = event.target.closest?.('[data-reminder-posting-dialog]');
  if (reminderPostingBackdrop && event.target === reminderPostingBackdrop) {
    event.preventDefault(); await financeWorkspace.click({ dataset: { financeAction: 'cancel-posting' } }); return;
  }
  const reminderStopBackdrop = event.target.closest?.('[data-reminder-stop-dialog]');
  if (reminderStopBackdrop && event.target === reminderStopBackdrop) {
    event.preventDefault(); await financeWorkspace.click({ dataset: { financeAction: 'cancel-stop-rule' } }); return;
  }
  const financeResetBackdrop = event.target.closest?.('[data-finance-reset-dialog]');
  if (financeResetBackdrop && event.target === financeResetBackdrop) {
    event.preventDefault(); await financeWorkspace.click({ dataset: { financeAction: 'cancel-reset-confirmation' } }); return;
  }
  const navLink = event.target.closest('[data-page]');
  if (navLink) {
    event.preventDefault();
    if (navLink.dataset.settingsSubview) {
      navigateTo(navLink.dataset.page, { subview: navLink.dataset.settingsSubview });
    } else if (navLink.dataset.financeView) financeWorkspace.openAccountView(navLink.dataset.financeView);
    else if (navLink.dataset.page === 'accounts') financeWorkspace.resetAccountView();
    if (!navLink.dataset.settingsSubview) navigateTo(navLink.dataset.page, { subview: 'home', resetWorkbenchView: navLink.dataset.page === 'ledger' });
    if (navLink.dataset.financeView) root.querySelector('.finance-operation-panel')?.focus?.({ preventScroll: true });
    if (mobileQuery.matches) document.body.classList.remove('sidebar-open');
    if (pageNeedsCategoryCatalog()) await ensureCategoryCatalog();
    return;
  }

  const actionTarget = event.target.closest('[data-action]');
  const action = actionTarget?.dataset.action;
  if (backupState.busy && ['confirm-entry', 'save-category', 'add-category', 'toggle-category-hidden', 'edit-hidden-categories', 'draft-category-hidden', 'save-hidden-categories', 'cancel-hidden-categories', 'delete-category', 'confirm-delete-category', 'save-subcategory-name', 'toggle-subcategory-hidden', 'unlink-subcategory', 'confirm-unlink-subcategory', 'cancel-unlink-subcategory', 'delete-subcategory', 'confirm-delete-subcategory', 'cancel-delete-subcategory', 'close-subcategory-dialog', 'share-subcategory', 'create-independent-subcategory'].includes(action)) return;
  if (entryDraft.isSaving && ['entry-set-type', 'entry-select-category', 'entry-select-subcategory', 'confirm-entry'].includes(action)) return;
  if (categoryStore.isMutationPending() && ['add-category', 'save-category', 'toggle-category-hidden', 'edit-hidden-categories', 'draft-category-hidden', 'save-hidden-categories', 'cancel-hidden-categories', 'delete-category', 'confirm-delete-category', 'save-subcategory-name', 'toggle-subcategory-hidden', 'unlink-subcategory', 'confirm-unlink-subcategory', 'cancel-unlink-subcategory', 'delete-subcategory', 'confirm-delete-subcategory', 'cancel-delete-subcategory', 'close-subcategory-dialog', 'share-subcategory', 'create-independent-subcategory'].includes(action)) return;
  if (action === 'toggle-sidebar') {
    setSidebarMode(document.body.classList.contains('sidebar-collapsed') ? 'expanded' : 'icons');
    return;
  }
  if (action === 'hide-sidebar') {
    setSidebarMode('hidden');
    return;
  }
  if (action === 'restore-sidebar') {
    setSidebarMode('expanded');
    return;
  }
  if (action === 'open-menu') {
    if (document.body.classList.contains('sidebar-hidden')) setSidebarMode('expanded');
    document.body.classList.add('sidebar-open');
    return;
  }
  if (action === 'close-menu') { document.body.classList.remove('sidebar-open'); return; }
  if (action === 'open-ledger-settings') {
    navigateTo('ledger-settings', { subview: 'home' });
    await ensureCategoryCatalog();
    return;
  }
  if (action === 'open-ledger-backup') {
    navigateTo('ledger-settings', { subview: 'backup' });
    await ensureCategoryCatalog();
    return;
  }
  if (action === 'export-ledger-backup') { await exportLedgerBackup(); return; }
  if (action === 'confirm-ledger-restore') { await confirmLedgerRestore(); return; }
  if (action === 'enable-v4-preview') { await enableFinanceV4Preview(); return; }
  if (action === 'set-finance-source') {
    workbenchState.source = actionTarget.dataset.source === 'preview' ? 'preview' : 'personal';
    render(activePage === 'analytics' ? 'analytics' : 'ledger');
    return;
  }
  if (action === 'refresh-finance') { await refreshFinance(); return; }
  if (action === 'app-back') {
    if (!navigateBack() && activePage === 'ledger-settings') {
      if (ledgerSettingsSubview !== 'home') navigateTo('ledger-settings', { subview: 'home', recordHistory: false });
      else navigateTo('ledger', { resetWorkbenchView: false, recordHistory: false });
    }
    return;
  }
  if (action === 'history-toggle-day-edit') {
    const date = actionTarget.dataset.historyDay || '';
    if (historyState.recordEditor?.dirty && !window.confirm('目前的修改尚未保存。要捨棄草稿並切換日期操作嗎？')) return;
    historyState.recordEditor = null;
    historyState.historyNotice = '';
    historyState.editDay = historyState.editDay === date ? '' : date;
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-open-edit') {
    if (beginHistoryEdit(actionTarget.dataset.recordId)) renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-open-delete') {
    const record = historyEntryById(actionTarget.dataset.recordId);
    if (!record) return;
    if (historyState.recordEditor?.dirty && !window.confirm('目前的修改尚未保存。要捨棄草稿並繼續刪除另一筆紀錄嗎？')) return;
    historyState.recordEditor = null;
    historyState.deleteRecord = structuredClone(record);
    historyState.deleteGeneration = historyState.financeData.financePreferences[0].generation;
    historyState.historyNotice = '';
    renderHistoryContents(root, historyState);
    root.querySelector('[data-action="history-cancel-delete"]')?.focus?.({ preventScroll: true });
    return;
  }
  if (action === 'history-cancel-delete') {
    historyState.deleteRecord = null;
    historyState.deleteGeneration = null;
    historyState.historyNotice = '';
    historyState.deletingRecord = false;
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-confirm-delete') { await confirmHistoryDelete(); return; }
  if (action === 'history-cancel-edit') {
    historyState.recordEditor = null;
    historyState.historyNotice = '';
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-enter-split') {
    const editor = historyState.recordEditor;
    const source = editor && historyEntryById(editor.recordId);
    if (!editor || !source || source.reminderOccurrenceId) return;
    editor.splitMode = true;
    editor.dirty = true;
    editor.splits = [
      { ...structuredClone(editor.draft) },
      blankHistorySplit(source),
    ];
    historyState.historyNotice = '';
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-add-split-row') {
    const editor = historyState.recordEditor;
    const source = editor && historyEntryById(editor.recordId);
    if (!editor?.splitMode || !source || editor.splits.length >= 20) return;
    editor.splits.push(blankHistorySplit(source));
    editor.dirty = true;
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-remove-split-row') {
    const editor = historyState.recordEditor; const index = Number(actionTarget.dataset.splitIndex);
    if (!editor?.splitMode || !Number.isInteger(index) || index < 2 || index >= editor.splits.length || editor.splits.length <= 2) return;
    editor.splits.splice(index, 1); editor.dirty = true;
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-save-edit') { await saveHistoryEdit(false); return; }
  if (action === 'history-save-split') { await saveHistoryEdit(true); return; }
  if (action === 'history-month-shift') {
    shiftHistoryMonth(historyState, Number(actionTarget.dataset.monthOffset));
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-month-current') {
    setHistoryToCurrentMonth(historyState);
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-filter-date-apply') {
    const draft = historyState.dateDraft || historyState.filters;
    if (draft.fromDate && draft.toDate && draft.fromDate > draft.toDate) {
      const error = root.querySelector('[data-history-date-error]');
      if (error) error.textContent = '開始日期不能晚於結束日期。';
      return;
    }
    historyState.filters.fromDate = draft.fromDate || '';
    historyState.filters.toDate = draft.toDate || '';
    historyState.dateDraft = null;
    const picker = root.querySelector('.history-date-range-picker');
    if (picker) picker.open = false;
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-filter-date-clear') {
    historyState.filters.fromDate = '';
    historyState.filters.toDate = '';
    historyState.dateDraft = null;
    const error = root.querySelector('[data-history-date-error]');
    if (error) error.textContent = '';
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-filter-type') {
    const nextType = ['expense', 'income'].includes(actionTarget.dataset.recordType) ? actionTarget.dataset.recordType : '';
    historyState.filters.recordType = nextType;
    const selectedCategory = categoryStore.getCategory(historyState.filters.categoryId);
    if (selectedCategory && nextType && selectedCategory.entryType !== nextType) historyState.filters.categoryId = '';
    const picker = root.querySelector('[data-history-category-picker]');
    if (picker) picker.open = false;
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'history-filter-category') {
    historyState.filters.categoryId = actionTarget.dataset.categoryId || '';
    renderHistoryContents(root, historyState);
    root.querySelector('[data-history-category-picker]')?.removeAttribute('open');
    return;
  }
  if (action === 'history-filter-clear') {
    historyState.filters = { query: '', fromDate: '', toDate: '', recordType: '', categoryId: '', accountId: '' };
    historyState.dateDraft = null;
    for (const field of root.querySelectorAll?.('[data-history-filter]') || []) field.value = '';
    for (const field of root.querySelectorAll?.('[data-history-date-draft]') || []) field.value = '';
    const categorySearch = root.querySelector('[data-history-category-search]'); if (categorySearch) categorySearch.value = '';
    renderHistoryContents(root, historyState);
    return;
  }
  if (action === 'open-category-settings') {
    categoryEditorState ||= createCategoryEditorState(categoryStore, entryDraft.type);
    if (categoryEditorState.entryType !== entryDraft.type) switchCategoryEditorType(categoryStore, categoryEditorState, entryDraft.type);
    navigateTo('ledger-settings', { subview: 'categories' });
    await ensureCategoryCatalog();
    return;
  }
  if (action === 'retry-category-load') {
    categoryStore.setLoadState({ ready: false, error: '' });
    await ensureCategoryCatalog();
    return;
  }
  if (action === 'category-set-type') {
    if (switchCategoryEditorType(categoryStore, categoryEditorState, actionTarget.dataset.entryType)) render('ledger-settings');
    return;
  }
  if (action === 'select-category') {
    if (selectCategoryForEditing(categoryStore, categoryEditorState, actionTarget.dataset.categoryId)) render('ledger-settings');
    return;
  }
  if (action === 'clear-category-name') {
    if (!categoryEditorState) return;
    categoryEditorState.draftName = '';
    categoryEditorState.notice = '';
    categoryEditorState.noticeTone = 'neutral';
    render('ledger-settings');
    root.querySelector('[data-field="category-name"]')?.focus?.({ preventScroll: true });
    return;
  }
  if (action === 'add-category') {
    const mutation = await persistCategoryMutation((candidate) => candidate.addCategory({ entryType: categoryEditorState.entryType }));
    if (mutation.ok) selectCategoryForEditing(categoryStore, categoryEditorState, mutation.result.id);
    else if (mutation.error.code !== 'CATEGORY_REVISION_CONFLICT') setCategoryNotice(mutation.error.message, 'error');
    render('ledger-settings');
    return;
  }
  if (action === 'select-category-icon') {
    categoryEditorState.draftIcon = actionTarget.dataset.iconChoice;
    render('ledger-settings');
    return;
  }
  if (action === 'select-category-color') {
    categoryEditorState.draftColor = actionTarget.dataset.color;
    render('ledger-settings');
    return;
  }
  if (action === 'save-category') {
    const cleanName = categoryEditorState.draftName.trim();
    if (!cleanName) {
      categoryEditorState.notice = '名稱不能空白，請輸入大分類名稱。';
      categoryEditorState.noticeTone = 'error';
    } else {
      const mutation = await persistCategoryMutation((candidate) => candidate.updateCategory(categoryEditorState.selectedCategoryId, {
        name: cleanName,
        icon: categoryEditorState.draftIcon,
        color: categoryEditorState.draftColor,
      }));
      if (mutation.ok) {
        categoryEditorState.draftName = cleanName;
        categoryEditorState.notice = '分類名稱、圖示與顏色已保存；新增記帳會使用最新設定。';
        categoryEditorState.noticeTone = 'success';
      } else if (mutation.error.code !== 'CATEGORY_REVISION_CONFLICT') {
        categoryEditorState.notice = mutation.error.message;
        categoryEditorState.noticeTone = 'error';
      }
    }
    render('ledger-settings');
    return;
  }
  if (action === 'edit-hidden-categories') {
    categoryEditorState.hiddenEditMode = true;
    categoryEditorState.hiddenCategoryDrafts = Object.fromEntries(categoryStore.listCategories({ includeHidden: true, entryType: categoryEditorState.entryType }).map((item) => [item.id, item.hidden]));
    setCategoryNotice('正在編輯分類顯示狀態；按「儲存並完成」後才會套用。');
    render('ledger-settings');
    return;
  }
  if (action === 'draft-category-hidden') {
    const categoryId = actionTarget.dataset.categoryId;
    const category = categoryStore.getCategory(categoryId);
    if (!category || category.entryType !== categoryEditorState.entryType || !categoryEditorState.hiddenEditMode) return;
    const current = categoryEditorState.hiddenCategoryDrafts[categoryId] ?? category.hidden;
    categoryEditorState.hiddenCategoryDrafts[categoryId] = !current;
    render('ledger-settings');
    return;
  }
  if (action === 'cancel-hidden-categories') {
    categoryEditorState.hiddenEditMode = false;
    categoryEditorState.hiddenCategoryDrafts = {};
    const selectedCategory = categoryStore.getCategory(categoryEditorState.selectedCategoryId);
    if (selectedCategory?.hidden) selectNextManageableCategory();
    setCategoryNotice('已取消隱藏設定；分類沒有變更。');
    render('ledger-settings');
    return;
  }
  if (action === 'save-hidden-categories') {
    if (!categoryEditorState.hiddenEditMode) return;
    const changes = Object.entries(categoryEditorState.hiddenCategoryDrafts).filter(([id, hidden]) => categoryStore.getCategory(id)?.hidden !== hidden);
    if (!changes.length) {
      categoryEditorState.hiddenEditMode = false;
      categoryEditorState.hiddenCategoryDrafts = {};
      setCategoryNotice('沒有需要保存的隱藏設定。');
      render('ledger-settings');
      return;
    }
    const mutation = await persistCategoryMutation((candidate) => {
      for (const [id, hidden] of changes) if (!candidate.setCategoryHidden(id, hidden)) return { ok: false, reason: '有分類已不存在，請重新載入後再調整。' };
      return { ok: true };
    });
    if (!mutation.ok) {
      render('ledger-settings');
      return;
    }
    categoryEditorState.hiddenEditMode = false;
    categoryEditorState.hiddenCategoryDrafts = {};
    const selectedCategory = categoryStore.getCategory(categoryEditorState.selectedCategoryId);
    if (selectedCategory?.hidden) selectNextManageableCategory();
    for (const [id, hidden] of changes) if (hidden && entryDraft.categoryId === id) {
      entryDraft.categoryId = '';
      entryDraft.subcategoryId = '';
      entryDraft.feedback = '此分類已隱藏，請重新選擇有效分類。';
    }
    setCategoryNotice(`已保存 ${changes.length} 個分類的顯示設定；隱藏分類及其歷史資料仍保留。`, 'success');
    render('ledger-settings');
    return;
  }
  if (action === 'toggle-hidden-orphans') {
    categoryEditorState.showHiddenOrphans = !categoryEditorState.showHiddenOrphans;
    render('ledger-settings');
    return;
  }
  if (action === 'toggle-category-hidden') {
    const category = categoryStore.getCategory(actionTarget.dataset.categoryId);
    const willHide = Boolean(category && !category.hidden);
    if (!category) {
      setCategoryNotice('找不到這個大分類，沒有變更資料。', 'error');
      render('ledger-settings');
      return;
    }
    const mutation = await persistCategoryMutation((candidate) => candidate.setCategoryHidden(category.id, willHide));
    if (!mutation.ok) {
      if (mutation.error.code !== 'CATEGORY_REVISION_CONFLICT') setCategoryNotice(mutation.error.message, 'error');
      render('ledger-settings');
      return;
    }
    category.hidden = willHide;
    if (!category.hidden && entryDraft.categoryId === category.id) {
      entryDraft.categoryId = '';
      entryDraft.subcategoryId = '';
      entryDraft.feedback = '';
    }
    if (willHide && categoryEditorState.selectedCategoryId === category.id && !categoryEditorState.hiddenEditMode) selectNextManageableCategory();
    setCategoryNotice(willHide ? `已隱藏「${category.name}」；既有子分類關聯仍保留。` : `已恢復「${category.name}」，可再次用於新增記帳。`, 'success');
    render('ledger-settings');
    return;
  }
  if (action === 'delete-category') {
    if (!await auditCategoryReferences()) return;
    const info = categoryStore.getCategoryDeletionInfo(actionTarget.dataset.categoryId);
    if (!info.exists || !info.canDelete) {
      setCategoryNotice(info.reason || '無法確認交易引用狀態，已阻止刪除。', 'error');
      render('ledger-settings');
      return;
    }
    categoryEditorState.deleteConfirmation = info;
    render('ledger-settings');
    root.querySelector('[data-action="cancel-delete-category"]')?.focus({ preventScroll: true });
    return;
  }
  if (action === 'cancel-delete-category') {
    if (categoryEditorState) categoryEditorState.deleteConfirmation = null;
    render('ledger-settings');
    return;
  }
  if (action === 'confirm-delete-category') {
    const pending = categoryEditorState?.deleteConfirmation;
    if (!pending) return;
    if (!await auditCategoryReferences()) { categoryEditorState.deleteConfirmation = null; render('ledger-settings'); return; }
    const info = categoryStore.getCategoryDeletionInfo(pending.category.id);
    if (!info.exists || !info.canDelete) {
      categoryEditorState.deleteConfirmation = null;
      setCategoryNotice(info.reason || '分類仍有收支引用，或目前無法安全確認；未刪除。', 'error');
      render('ledger-settings');
      return;
    }
    const mutation = await persistCategoryMutation((candidate) => candidate.deleteCategory(info.category.id));
    categoryEditorState.deleteConfirmation = null;
    if (!mutation.ok) {
      setCategoryNotice(mutation.error.message || mutation.result?.reason || '分類沒有刪除。', 'error');
      render('ledger-settings');
      return;
    }
    const result = mutation.result;
    if (entryDraft.categoryId === info.category.id) {
      entryDraft.categoryId = '';
      entryDraft.subcategoryId = '';
      entryDraft.feedback = '';
    }
    if (categoryEditorState.selectedCategoryId === info.category.id) selectNextManageableCategory();
    setCategoryNotice(`已刪除大分類「${info.category.name}」。${info.relatedSubcategoryCount} 個子分類仍保留；其他大分類的共用關聯未受影響。`, 'success');
    render('ledger-settings');
    return;
  }
  if (action === 'edit-subcategory-name') {
    const item = categoryStore.getSubcategory(actionTarget.dataset.subcategoryId);
    if (!item) return;
    categoryEditorState.editingSubcategoryId = item.id;
    categoryEditorState.draftSubcategoryName = item.name;
    render('ledger-settings');
    root.querySelector('[data-field="subcategory-edit-name"]')?.focus();
    return;
  }
  if (action === 'cancel-subcategory-edit') {
    categoryEditorState.editingSubcategoryId = '';
    categoryEditorState.draftSubcategoryName = '';
    render('ledger-settings');
    root.focus({ preventScroll: true });
    return;
  }
  if (action === 'save-subcategory-name') {
    const subcategoryId = actionTarget.dataset.subcategoryId;
    const cleanName = categoryEditorState.draftSubcategoryName.trim();
    if (!cleanName) setCategoryNotice('子分類名稱不能空白。', 'error');
    else {
      const mutation = await persistCategoryMutation((candidate) => candidate.updateSubcategory(subcategoryId, { name: cleanName }));
      if (mutation.ok) {
        setCategoryNotice(`子分類名稱已保存為「${cleanName}」；分類 ID 與共用關聯保持不變。`, 'success');
        categoryEditorState.editingSubcategoryId = '';
        categoryEditorState.draftSubcategoryName = '';
      } else if (mutation.error.code !== 'CATEGORY_REVISION_CONFLICT') setCategoryNotice(mutation.error.message, 'error');
    }
    render('ledger-settings');
    root.focus({ preventScroll: true });
    return;
  }
  if (action === 'toggle-subcategory-hidden') {
    const item = categoryStore.getSubcategory(actionTarget.dataset.subcategoryId);
    const willHide = Boolean(item && !item.hidden);
    if (!item) {
      setCategoryNotice('找不到這個子分類，沒有變更資料。', 'error');
      render('ledger-settings');
      return;
    }
    const mutation = await persistCategoryMutation((candidate) => candidate.setSubcategoryHidden(item.id, willHide));
    if (!mutation.ok) {
      if (mutation.error.code !== 'CATEGORY_REVISION_CONFLICT') setCategoryNotice(mutation.error.message, 'error');
      render('ledger-settings');
      return;
    }
    if (willHide && entryDraft.subcategoryId === item.id) {
      entryDraft.subcategoryId = '';
      entryDraft.feedback = '';
    }
    setCategoryNotice(willHide ? `已隱藏子分類「${item.name}」；所有大分類關聯仍保留。` : `已恢復子分類「${item.name}」，可再次用於新增記帳。`, 'success');
    render('ledger-settings');
    return;
  }
  if (action === 'unlink-subcategory') {
    const categoryId = actionTarget.dataset.categoryId;
    const subcategoryId = actionTarget.dataset.subcategoryId;
    const item = categoryStore.getSubcategory(subcategoryId);
    if (!item) {
      showSubcategoryInfoDialog('無法移除子分類', '找不到這個子分類，沒有變更資料。');
      return;
    }
    if (!await auditCategoryReferences()) {
      showSubcategoryInfoDialog(`無法從目前分類移除「${item.name}」`, categoryEditorState?.notice || '無法讀取最新收支引用，沒有變更關聯。');
      return;
    }
    const reference = categoryStore.getSubcategoryAssociationUnlinkInfo(categoryId, item.id);
    if (!reference.exists || !reference.referenceVerified || !reference.canUnlink) {
      showSubcategoryInfoDialog(`無法從「${categoryStore.getCategory(categoryId)?.name || '目前分類'}」移除「${item.name}」`, reference.reason || '無法確認這組關聯是否仍被使用，已阻止移除。');
      return;
    }
    categoryEditorState.subcategoryDialog = null;
    categoryEditorState.unlinkConfirmation = {
      categoryId,
      subcategoryId: item.id,
      categoryName: categoryStore.getCategory(categoryId)?.name || '目前分類',
      itemName: item.name,
    };
    render('ledger-settings');
    root.querySelector('[data-action="cancel-unlink-subcategory"]')?.focus({ preventScroll: true });
    return;
  }
  if (action === 'cancel-unlink-subcategory') {
    categoryEditorState.unlinkConfirmation = null;
    render('ledger-settings');
    return;
  }
  if (action === 'cancel-delete-subcategory' || action === 'close-subcategory-dialog') {
    categoryEditorState.subcategoryDialog = null;
    render('ledger-settings');
    return;
  }
  if (action === 'confirm-unlink-subcategory') {
    const pending = categoryEditorState.unlinkConfirmation;
    if (!pending) return;
    if (!await auditCategoryReferences()) {
      categoryEditorState.unlinkConfirmation = null;
      showSubcategoryInfoDialog(`無法從「${pending.categoryName}」移除「${pending.itemName}」`, categoryEditorState?.notice || '無法讀取最新收支引用，沒有變更關聯。');
      return;
    }
    const reference = categoryStore.getSubcategoryAssociationUnlinkInfo(pending.categoryId, pending.subcategoryId);
    if (!reference.exists || !reference.referenceVerified || !reference.canUnlink) {
      categoryEditorState.unlinkConfirmation = null;
      showSubcategoryInfoDialog(`無法從「${pending.categoryName}」移除「${pending.itemName}」`, reference.reason || '這組關聯仍被使用或無法確認；沒有移除。');
      return;
    }
    const mutation = await persistCategoryMutation((candidate) => candidate.unlinkSubcategory(pending.categoryId, pending.subcategoryId));
    categoryEditorState.unlinkConfirmation = null;
    if (!mutation.ok) {
      showSubcategoryInfoDialog(`無法從「${pending.categoryName}」移除「${pending.itemName}」`, mutation.error.message || '分類資料已變更，沒有移除關聯。');
      return;
    }
    if (entryDraft.categoryId === pending.categoryId && entryDraft.subcategoryId === pending.subcategoryId) {
      entryDraft.subcategoryId = '';
      entryDraft.feedback = '';
    }
    const remaining = categoryStore.getUsageNames(pending.subcategoryId);
    setCategoryNotice(remaining.length ? `已從「${pending.categoryName}」移除「${pending.itemName}」；仍保留於 ${remaining.join('、')}。` : `已解除「${pending.itemName}」的最後一個大分類關聯，子分類仍保留在未指派清單。`, 'success');
    render('ledger-settings');
    return;
  }
  if (action === 'delete-subcategory') {
    const subcategoryId = actionTarget.dataset.subcategoryId;
    const categoryId = categoryEditorState?.selectedCategoryId || '';
    if (!await auditCategoryReferences()) {
      const item = categoryStore.getSubcategory(subcategoryId);
      showSubcategoryInfoDialog(item ? `無法刪除「${item.name}」` : '無法刪除子分類', categoryEditorState?.notice || '無法讀取最新收支引用；為保護資料，沒有刪除。');
      return;
    }
    const info = categoryStore.getSubcategoryDeletionInfo(subcategoryId, { categoryId });
    const canDelete = info.canDelete || info.canDeleteAfterRemovingSoleAssociation;
    if (!info.exists || !canDelete) {
      const unlinkHint = categoryId && info.item?.categoryIds?.includes(categoryId) && info.referenceVerified
        ? '如只想從目前大分類移除，請使用該列的「從此分類移出」；這不會刪除其他分類關聯。'
        : '';
      showSubcategoryInfoDialog(info.item ? `無法刪除「${info.item.name}」` : '無法刪除子分類', [info.reason || '無法確認歷史交易引用，已阻止永久刪除。', unlinkHint].filter(Boolean).join(' '));
      return;
    }
    categoryEditorState.unlinkConfirmation = null;
    categoryEditorState.subcategoryDialog = {
      kind: 'delete-confirmation',
      categoryId,
      subcategoryId,
      itemName: info.item.name,
      removeSoleAssociation: Boolean(info.canDeleteAfterRemovingSoleAssociation),
      message: info.canDeleteAfterRemovingSoleAssociation
        ? `它目前只關聯「${categoryStore.getCategory(categoryId)?.name || '目前分類'}」，且最新讀取沒有相關歷史交易。確認後會在同一次保存中解除這個唯一關聯並刪除子分類。`
        : '目前沒有大分類關聯或歷史收支引用。只會刪除子分類定義；其他分類及已保存紀錄不會變更。保存時仍會再次檢查引用與版本。',
    };
    render('ledger-settings');
    root.querySelector('[data-action="cancel-delete-subcategory"]')?.focus({ preventScroll: true });
    return;
  }
  if (action === 'confirm-delete-subcategory') {
    const pending = categoryEditorState?.subcategoryDialog;
    if (!pending || pending.kind !== 'delete-confirmation') return;
    if (!await auditCategoryReferences()) {
      showSubcategoryInfoDialog(`無法刪除「${pending.itemName}」`, categoryEditorState?.notice || '無法讀取最新收支引用；為保護資料，沒有刪除。');
      return;
    }
    const latestInfo = categoryStore.getSubcategoryDeletionInfo(pending.subcategoryId, { categoryId: pending.categoryId });
    const canDelete = latestInfo.canDelete || latestInfo.canDeleteAfterRemovingSoleAssociation;
    if (!latestInfo.exists || !canDelete || latestInfo.item.name !== pending.itemName) {
      showSubcategoryInfoDialog(latestInfo.item ? `無法刪除「${latestInfo.item.name}」` : `無法刪除「${pending.itemName}」`, latestInfo.reason || '分類資料在確認期間已改變，沒有刪除。');
      return;
    }
    const mutation = await persistCategoryMutation((candidate) => {
      if (latestInfo.canDeleteAfterRemovingSoleAssociation && !candidate.unlinkSubcategory(pending.categoryId, pending.subcategoryId)) return { ok: false, reason: `「${pending.itemName}」與目前分類的關聯已改變，沒有刪除。` };
      return candidate.deleteSubcategory(pending.subcategoryId);
    });
    if (!mutation.ok) {
      showSubcategoryInfoDialog(`無法刪除「${pending.itemName}」`, mutation.error.message || mutation.result?.reason || '子分類沒有刪除。');
      return;
    }
    categoryEditorState.subcategoryDialog = null;
    if (entryDraft.subcategoryId === pending.subcategoryId) {
      entryDraft.subcategoryId = '';
      entryDraft.feedback = '';
    }
    setCategoryNotice(`已永久刪除未被歷史紀錄使用的子分類「${pending.itemName}」。`, 'success');
    render('ledger-settings');
    return;
  }
  if (action === 'share-subcategory') {
    const mutation = await persistCategoryMutation((candidate) => candidate.shareSubcategory(categoryEditorState.selectedCategoryId, actionTarget.dataset.subcategoryId));
    categoryEditorState.notice = mutation.ok ? '共用關聯已保存到此裝置。' : mutation.error.message;
    categoryEditorState.noticeTone = mutation.ok ? 'success' : 'error';
    if (mutation.ok) categoryEditorState.searchQuery = '';
    render('ledger-settings');
    return;
  }
  if (action === 'create-independent-subcategory') {
    const mutation = await persistCategoryMutation((candidate) => candidate.addIndependentSubcategory(categoryEditorState.selectedCategoryId, categoryEditorState.newSubcategoryName));
    if (!mutation.ok) {
      categoryEditorState.notice = mutation.error.code === 'CATEGORY_REVISION_CONFLICT' ? '另一個分頁已更新分類，已載入最新版；請檢查後重新建立。' : mutation.error.message;
      categoryEditorState.noticeTone = 'error';
    } else {
      const created = mutation.result;
      categoryEditorState.newSubcategoryName = '';
      categoryEditorState.notice = `已建立並保存獨立子分類「${created.name}」，並配置新的 ID。`;
      categoryEditorState.noticeTone = 'success';
    }
    render('ledger-settings');
    return;
  }
  if (action === 'select-workbench-panel') {
    workbenchState.panel = actionTarget.dataset.panel === 'analytics' ? 'analytics' : 'overview';
    render('ledger');
    return;
  }
  if (action === 'back-to-workbench') {
    if (!navigateBack()) navigateTo('ledger', { resetWorkbenchView: false });
    return;
  }
  if (action === 'entry-set-today') {
    if (entryDraft.isSaving) return;
    updateEntryField('date', getLocalDateInputValue());
    render(activePage === 'ledger' ? 'ledger' : 'add-entry');
    return;
  }
  if (action === 'entry-load-reminder') {
    if (!FINANCE_V4_ACTIVE || entryDraft.isSaving || entryDraft.reminderOccurrenceId) return;
    const selectedId = root.querySelector('[data-field="entry-reminder-choice"]')?.value || '';
    const occurrence = financeWorkspace.getPendingReminder(selectedId);
    if (!occurrence || occurrence.entryType !== entryDraft.type) {
      entryDraft.feedback = '這個待處理項目已更新，請重新載入後再選擇。';
      entryDraft.feedbackTone = 'error';
      render('add-entry');
      return;
    }
    entryDraftBeforeReminder = structuredClone(entryDraft);
    const defaults = occurrence.entryDefaults || {};
    const category = categoryStore.getCategory(defaults.categoryId);
    const validCategoryId = category?.entryType === occurrence.entryType && categoryStore.isCategorySelectable(category.id) ? category.id : '';
    const validSubcategoryId = validCategoryId && categoryStore.isSubcategorySelectable(validCategoryId, defaults.subcategoryId) ? defaults.subcategoryId : '';
    const activeAccounts = financeWorkspace.getActiveAccounts();
    const accountId = activeAccounts.some((item) => item.id === defaults.accountId)
      ? defaults.accountId
      : validCategoryId ? financeWorkspace.getDefaultAccount(occurrence.entryType, validCategoryId) : '';
    entryDraft = { ...entryDraft, type: occurrence.entryType, categoryId: validCategoryId, subcategoryId: validSubcategoryId, amount: String(occurrence.amountTwd), date: getLocalDateInputValue(), note: `${occurrence.name}${occurrence.note ? ` · ${occurrence.note}` : ''}`.slice(0, 160), accountId: accountId || '', accountUserSelected: true, accountSelectionsByType: { ...entryDraft.accountSelectionsByType, [occurrence.entryType]: { accountId: accountId || '', userSelected: true } }, paymentMethod: defaults.paymentMethod || 'direct', reminderOccurrenceId: occurrence.id, expectedOccurrenceRevision: occurrence.revision, reminderName: occurrence.name, userEdited: true, submissionBlocked: false, feedback: '已帶入本期內容；請確認分類、帳戶及實際收付日期後再保存。', feedbackTone: 'neutral' };
    entryDraft[`${occurrence.entryType}SubcategoryId`] = validSubcategoryId;
    entryDraft.idempotencyKey = createIdempotencyKey();
    render('add-entry');
    return;
  }
  if (action === 'entry-cancel-reminder') {
    if (entryDraft.isSaving) return;
    if (entryDraftBeforeReminder) entryDraft = entryDraftBeforeReminder;
    else { delete entryDraft.reminderOccurrenceId; delete entryDraft.expectedOccurrenceRevision; delete entryDraft.reminderName; }
    entryDraftBeforeReminder = null;
    render('add-entry');
    return;
  }
  if (action === 'set-workbench-mobile-pane') {
    workbenchState.mobilePane = actionTarget.dataset.pane === 'side' ? 'side' : 'entry';
    render('ledger');
    return;
  }
  if (action === 'entry-set-type') {
    switchEntryType(actionTarget.dataset.entryType === 'income' ? 'income' : 'expense');
    if (FINANCE_V4_ACTIVE) applyResolvedAccountToDraft(entryDraft, financeWorkspace.getDefaultAccount(entryDraft.type, entryDraft.categoryId), financeWorkspace.getActiveAccounts());
    render(activePage === 'ledger' ? 'ledger' : 'add-entry');
    return;
  }
  if (action === 'entry-select-category') {
    const previousCategoryId = entryDraft.categoryId;
    if (!selectEntryCategory(categoryStore, entryDraft, actionTarget.dataset.categoryId)) return;
    if (FINANCE_V4_ACTIVE && previousCategoryId !== entryDraft.categoryId) {
      applyResolvedAccountToDraft(entryDraft, financeWorkspace.getDefaultAccount(entryDraft.type, entryDraft.categoryId), financeWorkspace.getActiveAccounts());
    }
    render(activePage === 'ledger' ? 'ledger' : 'add-entry');
    return;
  }
  if (action === 'entry-select-subcategory') {
    if (!categoryStore.isSubcategorySelectable(entryDraft.categoryId, actionTarget.dataset.subcategoryId)) return;
    updateEntryField('subcategoryId', actionTarget.dataset.subcategoryId);
    entryDraft[`${entryDraft.type}SubcategoryId`] = actionTarget.dataset.subcategoryId;
    render(activePage === 'ledger' ? 'ledger' : 'add-entry');
    return;
  }
  if (action === 'confirm-entry') {
    if (entryDraft.isSaving || entryDraft.submissionBlocked) return;
    const activeAccounts = FINANCE_V4_ACTIVE ? financeWorkspace.getActiveAccounts() : null;
    const problem = validateEntryDraft(categoryStore, entryDraft, { accounts: activeAccounts });
    if (problem) {
      entryDraft.feedback = problem;
      entryDraft.feedbackTone = 'error';
      render(activePage === 'ledger' ? 'ledger' : 'add-entry');
      return;
    }

    const isIncome = entryDraft.type === 'income';
    const category = categoryStore.getCategory(entryDraft.categoryId);
    const subcategory = categoryStore.getSubcategory(entryDraft.subcategoryId);
    let record;
    try {
      if (!FINANCE_V4_ACTIVE) {
        record = isIncome
          ? createIncomeRecord({ draft: entryDraft, category, subcategory })
          : createExpenseRecord({ draft: entryDraft, category, subcategory });
      }
    } catch (error) {
      entryDraft.feedback = error.message || `${isIncome ? '收入' : '支出'}資料無效，沒有保存。`;
      entryDraft.feedbackTone = 'error';
      render(activePage === 'ledger' ? 'ledger' : 'add-entry');
      return;
    }

    entryDraft.isSaving = true;
    entryDraft.feedback = '正在保存至 Life Record 專用資料庫…';
    entryDraft.feedbackTone = 'neutral';
    render(activePage === 'ledger' ? 'ledger' : 'add-entry');
    try {
      const result = FINANCE_V4_ACTIVE
        ? await financeWorkspace.saveOfficialEntry(entryDraft)
        : await (isIncome ? saveIncome(record) : saveExpense(record));
      if (result.status === 'duplicate') {
        entryDraft.isSaving = false;
        entryDraft.submissionBlocked = true;
        entryDraft.feedback = '資料庫已存在相同提交識別碼或紀錄識別碼；已拒絕重複寫入。請確認歷史紀錄後再編輯新的一筆。';
        entryDraft.feedbackTone = 'error';
      } else {
        if (FINANCE_V4_ACTIVE) record = result.data[isIncome ? 'incomes' : 'expenses'].find((item) => entryDraft.reminderOccurrenceId ? item.reminderOccurrenceId === entryDraft.reminderOccurrenceId : item.idempotencyKey === entryDraft.idempotencyKey);
        if (!record) throw new Error('資料庫回報保存完成，但未能讀回剛保存的紀錄。請重新讀取歷史紀錄確認，勿重複提交。');
        if (Number.isSafeInteger(result.catalogRevision) && result.catalogRevision !== categoryStore.getRevision()) {
          try {
            const latestCatalog = FINANCE_V4_ACTIVE
              ? (await financeWorkspace.refreshOfficialData()).categoryCatalog[0]
              : await readCategoryCatalog();
            if (latestCatalog && categoryStore.replaceCatalog(latestCatalog)) clearUnavailableEntrySelection();
          } catch { /* The record transaction already completed; a catalog refresh must not misreport that save. */ }
        }
        entryDraft = createEntryDraft();
        entryDraftBeforeReminder = null;
        entryDraft.type = record.recordType;
        entryDraft.date = record.occurredOn;
        entryDraft.feedback = FINANCE_V4_ACTIVE
          ? `${isIncome ? '收入' : '支出'}與帳戶異動已在同一筆資料庫交易保存。${result.warnings.join(' ')}`
          : `${isIncome ? '收入' : '支出'}已保存至此瀏覽器的 Life Record 專用資料庫；帳戶餘額未變更。`;
        entryDraft.feedbackTone = 'success';
        financeReadSequence += 1; workbenchState.records = null; workbenchState.loading = false;
      }
    } catch (error) {
      entryDraft.isSaving = false;
      if (error.code === 'INVALID_CATEGORY') {
        try {
          const latestCatalog = FINANCE_V4_ACTIVE
            ? (await financeWorkspace.refreshOfficialData()).categoryCatalog[0]
            : await readCategoryCatalog();
          if (latestCatalog && categoryStore.replaceCatalog(latestCatalog)) clearUnavailableEntrySelection();
        } catch {}
      }
      entryDraft.feedback = error.message || '保存失敗，沒有顯示成功。請確認歷史紀錄後再重試。';
      entryDraft.feedbackTone = 'error';
    }
    if (['ledger', 'add-entry'].includes(activePage)) render(activePage);
    return;
  }
});

// SPA 子頁面使用記憶體中的返回堆疊；攔截瀏覽器側鍵，避免返回離開整個單頁應用。
let lastSideBackAt = 0;
function closeTransientBeforeBack() {
  if (root.querySelector('[data-finance-restore-dialog]')) { void financeWorkspace.click({ dataset: { financeAction: 'cancel-restore-final' } }); return true; }
  if (root.querySelector('[data-finance-reset-dialog]')) { void financeWorkspace.click({ dataset: { financeAction: 'cancel-reset-confirmation' } }); return true; }
  if (root.querySelector('[data-category-delete-dialog]')) { root.querySelector('[data-action="cancel-delete-category"]')?.click(); return true; }
  if (root.querySelector('[data-subcategory-dialog]')) {
    const dialog = categoryEditorState?.subcategoryDialog;
    root.querySelector(`[data-action="${dialog?.kind === 'delete-confirmation' ? 'cancel-delete-subcategory' : 'close-subcategory-dialog'}"]`)?.click();
    return true;
  }
  if (root.querySelector('[data-category-unlink-dialog]')) { root.querySelector('[data-action="cancel-unlink-subcategory"]')?.click(); return true; }
  if (root.querySelector('[data-budget-delete-dialog]')) { void financeWorkspace.click({ dataset: { financeAction: 'cancel-delete-budget' } }); return true; }
  if (root.querySelector('[data-reminder-delete-dialog]')) { void financeWorkspace.click({ dataset: { financeAction: 'cancel-delete-rule' } }); return true; }
  if (root.querySelector('[data-reminder-stop-dialog]')) { void financeWorkspace.click({ dataset: { financeAction: 'cancel-stop-rule' } }); return true; }
  const openPopover = [...root.querySelectorAll('details[open]')].at(-1);
  if (openPopover) { openPopover.open = false; openPopover.querySelector('summary')?.focus?.({ preventScroll: true }); return true; }
  return false;
}
function hasTransientBackState() {
  return Boolean(root.querySelector('[data-category-delete-dialog],[data-subcategory-dialog],[data-category-unlink-dialog],[data-budget-delete-dialog],[data-reminder-delete-dialog],[data-reminder-stop-dialog],[data-finance-reset-dialog],details[open]'));
}
function handleAppBackButton(event) {
  if (event.button !== 3 || !root.contains(event.target)) return;
  if (!appPageHistory.length && !hasTransientBackState()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const now = performance.now();
  if (event.type === 'auxclick' && now - lastSideBackAt < 500) return;
  lastSideBackAt = now;
  if (closeTransientBeforeBack()) return;
  navigateBack();
}
document.addEventListener('mousedown', handleAppBackButton, true);
document.addEventListener('auxclick', handleAppBackButton, true);

document.addEventListener('input', (event) => {
  if (financeWorkspace.input(event.target)) return;
  if (updateHistoryEditorField(event.target)) return;
  if (event.target.matches?.('[data-budget-category-search]')) {
    const query = event.target.value.trim().toLocaleLowerCase('zh-TW');
    const options = event.target.closest('.finance-category-picker-popover')?.querySelectorAll('[data-choice-search]') || [];
    for (const option of options) option.hidden = !option.dataset.choiceSearch.includes(query);
    return;
  }
  if (event.target.matches?.('[data-history-category-search]')) {
    const query = event.target.value.trim().toLocaleLowerCase('zh-TW');
    const type = historyState.filters.recordType || '';
    for (const option of root.querySelectorAll('[data-category-search]')) {
      const typeMatches = !type || !option.dataset.categoryType || option.dataset.categoryType === type;
      option.hidden = !typeMatches || !option.dataset.categorySearch.includes(query);
    }
    return;
  }
  const dateDraftField = event.target.dataset?.historyDateDraft;
  if (dateDraftField === 'fromDate' || dateDraftField === 'toDate') {
    historyState.dateDraft ||= { fromDate: historyState.filters.fromDate || '', toDate: historyState.filters.toDate || '' };
    historyState.dateDraft[dateDraftField] = event.target.value;
    const error = root.querySelector('[data-history-date-error]');
    if (error) error.textContent = '';
    return;
  }
  const historyFilter = event.target.dataset?.historyFilter;
  if (historyFilter) {
    historyState.filters[historyFilter] = event.target.value;
    renderHistoryContents(root, historyState);
    return;
  }
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'restore-confirmation') {
    backupState.confirmation = event.target.value;
    const button = root.querySelector('[data-action="confirm-ledger-restore"]');
    if (button) button.disabled = backupState.busy || !categoryStore.isReady() || !backupState.preview || backupState.confirmation !== '完整還原';
    return;
  }
  if (field === 'v4-preview-confirmation') {
    backupState.previewConfirmation = event.target.value;
    setPreviewActivationButtonState();
    return;
  }
  if (entryDraft.isSaving) return;
  if (field === 'entry-amount') updateEntryField('amount', event.target.value);
  if (field === 'entry-note') updateEntryField('note', event.target.value);
  if (field === 'entry-date') updateEntryField('date', event.target.value);
  if (field === 'entry-account') selectEntryAccount(entryDraft, event.target.value);
  if (field === 'entry-payment-method') { entryDraft.userEdited = true; entryDraft.paymentMethod = event.target.value; }
  if (field === 'category-name' && categoryEditorState) categoryEditorState.draftName = event.target.value;
  if (field === 'subcategory-edit-name' && categoryEditorState) categoryEditorState.draftSubcategoryName = event.target.value;
  if (field === 'new-subcategory-name' && categoryEditorState) categoryEditorState.newSubcategoryName = event.target.value;
  if (field === 'subcategory-search' && categoryEditorState) {
    categoryEditorState.searchQuery = event.target.value;
    updateSubcategorySuggestions(root, categoryStore, categoryEditorState);
  }
  if (field === 'entry-note') {
    const counter = root.querySelector('.note-counter');
    if (counter) counter.textContent = `${event.target.value.length}/160`;
  }
});

document.addEventListener('change', (event) => {
  if (event.target.hasAttribute?.('data-finance-file')) { void financeWorkspace.file(event.target); return; }
  if (event.target.dataset?.financeField && event.target.tagName === 'SELECT') {
    if (typeof root.contains !== 'function' || root.contains(event.target)) financeWorkspace.input(event.target);
    return;
  }
  if (event.target.matches?.('[data-history-edit-field], [data-history-split-field]')) {
    updateHistoryEditorField(event.target);
    renderHistoryEditorKeepingFocus(event.target);
    return;
  }
  const historyFilter = event.target.dataset?.historyFilter;
  if (historyFilter) {
    historyState.filters[historyFilter] = event.target.value;
    renderHistoryContents(root, historyState);
    return;
  }
  if (event.target.dataset?.financeField) return;
  if (event.target.matches?.('[data-backup-file], [data-v4-preview-file]')) { void previewLedgerRestore(event.target.files?.[0]); return; }
  const field = event.target.dataset.field;
  if (field === 'v4-backup-saved') {
    backupState.backupSavedOutsideProfile = event.target.checked;
    setPreviewActivationButtonState();
    return;
  }
  if (entryDraft.isSaving) return;
  if (field === 'entry-date') updateEntryField('date', event.target.value);
  if (field === 'entry-account') selectEntryAccount(entryDraft, event.target.value);
  if (field === 'entry-payment-method') entryDraft.paymentMethod = event.target.value;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && root.querySelector('[data-reminder-stop-dialog]')) {
    event.preventDefault();
    void financeWorkspace.click({ dataset: { financeAction: 'cancel-stop-rule' } });
    return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-finance-restore-dialog]')) {
    event.preventDefault();
    void financeWorkspace.click({ dataset: { financeAction: 'cancel-restore-final' } });
    return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-finance-reset-dialog]')) {
    event.preventDefault();
    void financeWorkspace.click({ dataset: { financeAction: 'cancel-reset-confirmation' } });
    return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-category-delete-dialog]')) {
    event.preventDefault();
    root.querySelector('[data-action="cancel-delete-category"]')?.click();
    return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-subcategory-dialog]')) {
    event.preventDefault();
    const dialog = categoryEditorState?.subcategoryDialog;
    root.querySelector(`[data-action="${dialog?.kind === 'delete-confirmation' ? 'cancel-delete-subcategory' : 'close-subcategory-dialog'}"]`)?.click();
    return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-category-unlink-dialog]')) {
    event.preventDefault();
    root.querySelector('[data-action="cancel-unlink-subcategory"]')?.click();
    return;
  }
  if (event.altKey && event.key === 'ArrowLeft' && appPageHistory.length) {
    event.preventDefault();
    if (!closeTransientBeforeBack()) navigateBack();
    return;
  }
  const historyDatePicker = root.querySelector('.history-date-range-picker[open]');
  if (event.key === 'Escape' && historyDatePicker) {
    event.preventDefault();
    historyDatePicker.open = false;
    historyDatePicker.querySelector('summary')?.focus?.({ preventScroll: true });
    return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-budget-delete-dialog]')) {
    event.preventDefault();
    void financeWorkspace.click({ dataset: { financeAction: 'cancel-delete-budget' } });
    return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-reminder-posting-dialog]')) {
    event.preventDefault(); void financeWorkspace.click({ dataset: { financeAction: 'cancel-posting' } }); return;
  }
  if (event.key === 'Escape' && root.querySelector('[data-reminder-undo-dialog]')) {
    event.preventDefault(); void financeWorkspace.click({ dataset: { financeAction: 'cancel-undo-occurrence' } }); return;
  }
  const categoryPicker = root.querySelector('.finance-category-picker[open]');
  if (event.key === 'Escape' && categoryPicker) {
    event.preventDefault(); categoryPicker.open = false;
    categoryPicker.querySelector('summary')?.focus?.({ preventScroll: true });
    return;
  }
  const sortHandle = event.target.closest?.('[data-sort-handle]');
  if (sortHandle && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    const item = sortHandle.closest('[data-sort-item]');
    if (!item || categoryStore.isMutationPending()) return;
    event.preventDefault();
    const { sortKind: kind, sortId: id, sortParent: parent } = item.dataset;
    const rows = kind === 'category' ? categoryStore.listCategories({ entryType: parent }) : categoryStore.listSubcategories(parent);
    const visible = kind === 'category' ? rows.filter((row) => categoryEditorState.hiddenEditMode || !row.hidden) : rows;
    const index = visible.findIndex((row) => row.id === id); const next = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (next >= 0 && next < visible.length) void reorderCategoryItem(kind, id, parent, rows.findIndex((row) => row.id === visible[next].id));
    return;
  }
  const categoryField = event.target.dataset.field;
  if (categoryField === 'new-subcategory-name' && event.key === 'Enter') {
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    root.querySelector('[data-action="create-independent-subcategory"]')?.click();
    return;
  }
  if (categoryField !== 'subcategory-edit-name') return;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.closest('.assigned-subcategory')?.querySelector('[data-action="save-subcategory-name"]')?.click();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.target.closest('.assigned-subcategory')?.querySelector('[data-action="cancel-subcategory-edit"]')?.click();
  }
});

document.querySelector('#today-date').textContent = formatToday();
window.addEventListener('storage', (event) => {
  if (event.key === FINANCE_PREVIEW_STORAGE_KEY && isFinancePreviewEnabled(window)) window.location.reload();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFinanceForCurrentRoute();
  if (document.visibilityState === 'visible' && ['ledger', 'analytics'].includes(activePage) && workbenchState.source === 'personal' && !workbenchState.loading) void refreshFinance();
});
window.addEventListener('focus', () => refreshFinanceForCurrentRoute());
attachSidebarResize();
cancelCategoryDrag = attachCategoryPointerSort(root, {
  isBusy: () => backupState.busy || categoryStore.isMutationPending(),
  onError: (error) => { setCategoryNotice(`排序未完成：${error.message}，請重新讀取後再試。`, 'error'); if (activePage === 'ledger-settings' && ledgerSettingsSubview === 'categories') render('ledger-settings'); },
  onDrop: async (drag) => {
    if (activePage !== 'ledger-settings' || ledgerSettingsSubview !== 'categories') return;
    const rows = drag.kind === 'category' ? categoryStore.listCategories({ entryType: drag.parent }) : categoryStore.listSubcategories(drag.parent);
    const toIndex = resolveSortDropIndex(rows, drag, drag.preview.targetId);
    if (toIndex !== null && rows.findIndex((item) => item.id === drag.id) !== toIndex) await reorderCategoryItem(drag.kind, drag.id, drag.parent, toIndex, true);
  },
});
attachOverviewInteractions(root, {
  getConfig: () => workbenchState.overviewPreferences[workbenchState.source === 'preview' ? 'preview' : 'personal'],
  saveConfig: saveOverviewConfig,
  onFocusOrder: (order, month) => {
    if (workbenchState.source === 'preview' || !month) return true;
    try {
      financeWorkspace.saveBudgetDisplayOrder(order, month);
      workbenchState.budgetRows = financeWorkspace.getBudgetRows(month);
      return true;
    } catch (error) {
      workbenchState.overviewPreferenceError = `預算排列未保存：${error.message}`;
      workbenchState.budgetRows = financeWorkspace.getBudgetRows(month);
      if (activePage === 'ledger') render('ledger');
      return false;
    }
  },
});
window.addEventListener('resize', syncWorkbenchSplitter);
document.querySelector('#main-content')?.addEventListener('transitionend', (transitionEvent) => {
  if (transitionEvent.propertyName === 'margin-left') syncWorkbenchSplitter();
});
const initialRoute = routeFromLocation();
ledgerSettingsSubview = initialRoute.ledgerSettingsSubview;
syncRouteHash(initialRoute);
render(initialRoute.pageId);
refreshFinanceForCurrentRoute();
try {
  const previewNotice = JSON.parse(window.sessionStorage.getItem('LifeRecord_FinanceV4PreviewNotice_v1') || 'null');
  window.sessionStorage.removeItem('LifeRecord_FinanceV4PreviewNotice_v1');
  if (previewNotice?.message) {
    const notice = document.createElement('p');
    notice.className = `finance-preview-result ${previewNotice.tone === 'error' ? 'is-error' : 'is-success'}`;
    notice.setAttribute('role', 'status'); notice.textContent = previewNotice.message;
    root.prepend(notice);
  }
} catch { /* The persistent preview badge remains the source-profile indicator. */ }
