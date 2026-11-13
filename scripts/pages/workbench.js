import { icon } from '../icons.js';
import { escapeHTML } from '../escape-html.js';
import { renderAddEntryForm } from './add-entry.js';
import { renderFinancePanel } from './finance-panels.js';

export function createWorkbenchState() {
  return {
    panel: 'overview',
    source: 'personal',
    records: null,
    subscriptionData: null,
    loading: false,
    error: '',
    leftRatio: 60,
    layout: 'split',
    mobilePane: 'entry',
  };
}

export const WORKBENCH_MIN_ENTRY_WIDTH = 460;
export const WORKBENCH_MIN_SIDE_WIDTH = 300;
export const WORKBENCH_SPLITTER_WIDTH = 14;
export const WORKBENCH_EDGE_SNAP_WIDTH = 48;

export function getWorkbenchColumnBounds(width) {
  const available = Number(width) - WORKBENCH_SPLITTER_WIDTH;
  if (!Number.isFinite(available) || available < WORKBENCH_MIN_ENTRY_WIDTH + WORKBENCH_MIN_SIDE_WIDTH) return null;
  const minimum = Math.min(60, WORKBENCH_MIN_ENTRY_WIDTH / available * 100);
  const maximum = Math.max(minimum, Math.min(80, 100 - WORKBENCH_MIN_SIDE_WIDTH / available * 100));
  return { available, minimum, maximum };
}

export function resolveWorkbenchDrag(layout, pointerX, width) {
  const bounds = getWorkbenchColumnBounds(width);
  if (!bounds || !Number.isFinite(pointerX)) return { layout, leftRatio: null };
  const edge = WORKBENCH_EDGE_SNAP_WIDTH;
  if (layout === 'split') {
    if (pointerX <= edge) return { layout: 'side', leftRatio: null };
    if (width - pointerX <= edge) return { layout: 'entry', leftRatio: null };
  } else if (layout === 'side' && pointerX < WORKBENCH_MIN_ENTRY_WIDTH + edge) {
    return { layout: 'side', leftRatio: null };
  } else if (layout === 'entry' && width - pointerX < WORKBENCH_MIN_SIDE_WIDTH + edge) {
    return { layout: 'entry', leftRatio: null };
  }
  const ratio = ((pointerX - WORKBENCH_SPLITTER_WIDTH / 2) / bounds.available) * 100;
  return {
    layout: 'split',
    leftRatio: Math.max(bounds.minimum, Math.min(bounds.maximum, ratio)),
  };
}

export function resolveWorkbenchKeyboard(layout, leftRatio, key, shiftKey, width) {
  const bounds = getWorkbenchColumnBounds(width);
  if (!bounds) return { handled: false, layout, leftRatio };
  if (key === 'Enter' || key === ' ') {
    return layout === 'split' ? { handled: false, layout, leftRatio } : { handled: true, layout: 'split', leftRatio };
  }
  if (shiftKey && key === 'Home') return { handled: true, layout: 'side', leftRatio };
  if (shiftKey && key === 'End') return { handled: true, layout: 'entry', leftRatio };
  if (key === 'Home') return { handled: true, layout: 'split', leftRatio: bounds.minimum };
  if (key === 'End') return { handled: true, layout: 'split', leftRatio: bounds.maximum };
  const step = shiftKey ? 5 : 2;
  if (key === 'ArrowLeft' || key === 'ArrowDown') {
    return { handled: true, layout: 'split', leftRatio: Math.max(bounds.minimum, Math.min(bounds.maximum, leftRatio - step)) };
  }
  if (key === 'ArrowRight' || key === 'ArrowUp') {
    return { handled: true, layout: 'split', leftRatio: Math.max(bounds.minimum, Math.min(bounds.maximum, leftRatio + step)) };
  }
  return { handled: false, layout, leftRatio };
}

function renderSideContent(mode, store, state) {
  const isOverview = mode === 'overview';
  return `
    <div class="workbench-side-heading"><div><div class="eyebrow"><span class="eyebrow-spark">${icon(isOverview ? 'wallet' : 'chart', 15)}</span> ${isOverview ? 'LEDGER OVERVIEW' : 'LEDGER ANALYTICS'}</div><h2>${isOverview ? '記帳總覽' : '統計分析'}</h2><p>${isOverview ? '本月收支、分類與最近紀錄' : '依已保存日期查看收支趨勢'}</p></div></div>
    <div class="workbench-panel-tabs" role="tablist" aria-label="右側工作區內容">
      <button type="button" class="workbench-panel-tab ${isOverview ? 'is-active' : ''}" data-action="select-workbench-panel" data-panel="overview" role="tab" aria-selected="${isOverview}">${icon('wallet', 15)}總覽</button>
      <button type="button" class="workbench-panel-tab ${!isOverview ? 'is-active' : ''}" data-action="select-workbench-panel" data-panel="analytics" role="tab" aria-selected="${!isOverview}">${icon('chart', 15)}統計分析</button>
    </div>
    <div data-finance-host>${renderFinancePanel(store, state)}</div>`;
}

export function renderWorkbench(store, draft, state, { accounts = null } = {}) {
  const ratio = state.leftRatio;
  const gridClasses = [
    'workbench-grid',
    state.layout === 'entry' ? 'is-entry-only' : '',
    state.layout === 'side' ? 'is-side-only' : '',
  ].filter(Boolean).join(' ');
  const splitterLabel = state.layout === 'entry'
    ? '右側面板已收合。按 Enter 或拖曳此處向左，恢復雙欄工作區。'
    : state.layout === 'side'
      ? '新增記帳區已收合。按 Enter 或拖曳此處向右，恢復雙欄工作區。'
      : '拖曳或使用方向鍵調整欄寬；Shift 加 Home 或 End 可收合其中一側。';
  const separatorValue = state.layout === 'entry' ? 100 : state.layout === 'side' ? 0 : Math.round(ratio);

  return `
    <div class="workbench-shell">
      <div class="workbench-heading-row finance-page-heading">
        <div class="workbench-heading-copy"><div class="eyebrow finance-page-eyebrow"><span class="eyebrow-spark">${icon('wallet', 15)}</span> LEDGER V5</div><h1>記帳工作區</h1><p data-operation-hint>新增收支並查看已保存紀錄的總覽與分析。</p></div>
        <div class="workbench-heading-actions">
          <nav class="workbench-quicklinks" aria-label="記帳快捷入口">
            <a href="#history" data-page="history" data-workbench-link="history">${icon('history', 17)}<span>歷史紀錄</span></a>
            <a href="#accounts" data-page="accounts" data-workbench-link="accounts">${icon('bank', 17)}<span>帳戶</span></a>
            <a href="#ledger-settings/budget" data-page="ledger-settings" data-settings-subview="budget" data-workbench-link="budget">${icon('chart', 17)}<span>每月預算</span></a>
            <a href="#reminders" data-page="reminders" data-workbench-link="reminders">${icon('bell', 17)}<span>訂閱</span></a>
            <button type="button" data-action="open-ledger-settings" data-workbench-link="settings">${icon('settings', 17)}<span>記帳設定</span></button>
          </nav>
        </div>
      </div>
      <div class="workbench-controls">
        <div class="workbench-narrow-switch" role="group" aria-label="切換窄螢幕工作區">
          <button type="button" data-action="set-workbench-mobile-pane" data-pane="entry" aria-pressed="${state.mobilePane === 'entry'}">新增記帳</button>
          <button type="button" data-action="set-workbench-mobile-pane" data-pane="side" aria-pressed="${state.mobilePane === 'side'}">${state.panel === 'overview' ? '右側總覽' : '右側分析'}</button>
        </div>
      </div>
      <div class="${gridClasses}" id="workbench-grid" data-mobile-pane="${state.mobilePane}" data-left-ratio="${ratio}" data-workbench-layout="${state.layout}">
        <section class="workbench-entry" aria-labelledby="workbench-entry-title">
          <div class="workbench-pane-title"><span class="pane-title-mark">${icon('plus', 17)}</span><div><h2 id="workbench-entry-title">新增記帳</h2><span data-operation-hint>單筆支出／收入 · 儲存後可於歷史紀錄查看</span></div></div>
      ${renderAddEntryForm(store, draft, { accounts })}
        </section>
        <button class="workbench-splitter ${state.layout === 'split' ? '' : 'is-edge-handle'} ${state.layout === 'side' ? 'is-side-handle' : ''}" type="button" role="separator" aria-orientation="vertical" aria-label="${escapeHTML(splitterLabel)}" aria-controls="workbench-entry-title workbench-side" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${separatorValue}" aria-valuetext="${escapeHTML(splitterLabel)}" title="${escapeHTML(splitterLabel)}" tabindex="0" data-workbench-splitter>
          <span class="splitter-restore-icon" aria-hidden="true">${icon('chevron', 17)}</span>
          <span class="visually-hidden">${escapeHTML(splitterLabel)}</span>
        </button>
        <aside class="workbench-side" id="workbench-side" aria-label="記帳輔助工作區">${renderSideContent(state.panel, store, state)}</aside>
      </div>
      <div class="workbench-footer-note">${icon('sparkSmall', 14)}收支紀錄與分類設定會保存至此裝置；付款／收款帳戶尚未接入；範例預覽獨立於正式紀錄。</div>
    </div>`;
}

export function renderFullWorkbenchPanel(store, state) {
  const mode = state.panel;
  return `
    <div class="workbench-fullpage">
      <div class="page-heading full-panel-heading"><div><div class="eyebrow"><span class="eyebrow-spark">${icon(mode === 'overview' ? 'wallet' : 'chart', 15)}</span> ${mode === 'overview' ? 'LEDGER OVERVIEW' : 'LEDGER ANALYTICS'} <span class="eyebrow-line"></span> 收支分析</div><h1>${mode === 'overview' ? '記帳總覽' : '統計分析'}</h1><p class="page-subtitle">${mode === 'overview' ? '以完整工作區檢視收支摘要。' : '以完整工作區檢視收支統計。'}</p></div><button class="quiet-button" type="button" data-action="back-to-workbench">${icon('chevron', 15)}返回記帳工作區</button></div>
      <div class="full-panel-tabs" role="tablist" aria-label="總覽或統計分析">
        <button type="button" class="${mode === 'overview' ? 'is-active' : ''}" data-action="select-workbench-panel" data-panel="overview" role="tab" aria-selected="${mode === 'overview'}">${icon('wallet', 16)}記帳總覽</button>
        <button type="button" class="${mode === 'analytics' ? 'is-active' : ''}" data-action="select-workbench-panel" data-panel="analytics" role="tab" aria-selected="${mode === 'analytics'}">${icon('chart', 16)}統計分析</button>
      </div>
      <div data-finance-host>${renderFinancePanel(store, state, true)}</div>
    </div>`;
}
