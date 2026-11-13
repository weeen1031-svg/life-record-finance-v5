import { icon } from '../icons.js';
import { escapeHTML as esc } from '../escape-html.js';
import { summarizeBudgetRows } from '../finance/budget.js';
import { budgetScopeKey, defaultOverviewConfig, focusedBudgetRows } from '../ui/overview-preferences.js';
import { budgetOrderKey } from '../finance/budget-order.js';

const money = (minor) => {
  const n = BigInt(minor); const a = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}$${(a / 100n).toLocaleString('zh-TW')}${a % 100n ? `.${String(a % 100n).padStart(2, '0')}` : ''}`;
};
const progress = (used, budget) => budget > 0n ? Math.min(100, Number(used * 100n / budget)) : used > 0n ? 100 : 0;
const previewCategoryColors = new Map([['preview-meal', '#D78373'], ['preview-shopping', '#D99A5E']]);
const previewFallbackColors = ['#8298C4', '#9B86B8', '#6FA597', '#C38178'];
export function renderBudgetSummary(rows, config = defaultOverviewConfig(), preview = false, categoryStore = null) {
  const collapsed = config.budgetCollapsed;
  const collapseToggle = `<button type="button" class="mini-action budget-summary-toggle ${collapsed ? 'is-collapsed' : 'is-expanded'}" data-action="toggle-budget-summary" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展開' : '收合'}本月預算摘要" title="${collapsed ? '展開預算摘要' : '收合預算摘要'}">${icon('chevron', 14)}</button>`;
  const heading = (settingsControl = '') => `<div class="finance-panel-card-heading"><h3>本月預算摘要</h3><div class="overview-card-actions">${settingsControl}<a class="budget-summary-all-link" href="#ledger-settings/budget" data-page="ledger-settings" data-settings-subview="budget">全部預算</a>${collapseToggle}</div></div>`;
  if (rows === null) return `${heading()}<div class="overview-collapsible-content ${collapsed ? 'is-collapsed' : 'is-expanded'}" aria-hidden="${collapsed}" ${collapsed ? 'inert' : ''}><p class="finance-empty">正式預算尚未啟用。可從「全部預算」開始設定；正式收支不受影響。</p></div>`;
  const focusKeys = new Set(focusedBudgetRows(rows, config.focus).map(budgetScopeKey));
  const focusVisibleCount = [1, 2, 3].includes(config.focusVisibleCount) ? config.focusVisibleCount : 3;
  // The monthly budget page supplies rows in the shared per-month order; preserve
  // it for the complete list and for an optional filtered subset.
  const selected = rows.filter((row) => focusKeys.has(budgetScopeKey(row)));
  const displayed = config.focusFilterEnabled ? selected : rows;
  const totals = summarizeBudgetRows(rows);
  const label = (row) => `${row.categoryName}${row.subcategoryName ? ` · ${row.subcategoryName}` : ''}`;
  const colorFor = (row, index) => preview ? previewCategoryColors.get(row.categoryId) || previewFallbackColors[index % previewFallbackColors.length] : categoryStore?.getCategory(row.categoryId)?.color || '#9298A3';
  const settings = `<details class="budget-summary-options">
    <summary class="budget-summary-focus-summary" aria-label="設定重點分類" title="設定重點分類"><span>設定重點分類</span><small aria-label="${config.focusFilterEnabled ? `篩選顯示 ${selected.length} 項，共 ${rows.length} 項` : `全部顯示 ${rows.length} 項`}">${config.focusFilterEnabled ? `篩選 ${selected.length} / ${rows.length}` : `全部 ${rows.length} 項`}</small></summary>
    <div class="budget-summary-focus-settings"><p class="budget-summary-focus-help" data-operation-hint>預設顯示全部預算；勾選「只顯示已選項目」才會篩選下方清單。上方總額仍計入全部預算，順序沿用每月預算設定。</p><div class="budget-summary-focus-controls"><label class="budget-summary-focus-filter"><input type="checkbox" data-overview-focus-filter ${config.focusFilterEnabled ? 'checked' : ''}><span>只顯示已勾選項目</span></label><fieldset class="budget-summary-visible-count"><legend>顯示列數</legend><div>${[1, 2, 3].map((count) => `<label><input type="radio" name="budget-focus-visible-count-${preview ? 'preview' : 'personal'}" data-overview-focus-visible-count="${count}" value="${count}" ${focusVisibleCount === count ? 'checked' : ''}><span>${count} 列</span></label>`).join('')}</div></fieldset></div><div class="budget-summary-focus-grid">
      ${rows.map((row, index) => {
        const key = budgetScopeKey(row);
        const checked = focusKeys.has(key);
        return `<label class="budget-summary-focus-option ${checked ? 'is-selected' : ''}" style="--budget-focus-color:${esc(colorFor(row, index))}"><span class="budget-summary-focus-marker" aria-hidden="true"></span><span class="budget-summary-focus-copy"><strong>${esc(row.categoryName)}</strong><small>${row.subcategoryName ? esc(row.subcategoryName) : '大分類預算'}</small></span><input type="checkbox" data-overview-focus="${esc(key)}" ${checked ? 'checked' : ''} aria-label="選取${esc(label(row))}預算"></label>`;
      }).join('')}
    </div></div>
  </details>`;
  const overallProgress = progress(totals.actualMinor, totals.budgetMinor);
  const overBudget = totals.actualMinor > totals.budgetMinor;
  const totalsSummary = `<div class="budget-summary-totals"><div><span>本月總預算</span><strong>${money(totals.budgetMinor)}</strong></div><div><span>已使用</span><strong>${money(totals.actualMinor)}</strong></div><div><span>${totals.remainingMinor < 0n ? '超支' : '剩餘'}</span><strong class="${totals.remainingMinor < 0n ? 'expense' : ''}">${money(totals.remainingMinor < 0n ? -totals.remainingMinor : totals.remainingMinor)}</strong></div></div>`;
  const overallSummary = `<div class="budget-summary-overall ${overBudget ? 'is-exceeded' : ''}">${totalsSummary}<progress class="budget-summary-overall-progress ${overBudget ? 'is-exceeded' : ''}" max="100" value="${overallProgress}" aria-label="整體預算使用進度" aria-valuetext="${overallProgress}%"></progress><p class="budget-summary-note" data-operation-hint>僅計已設定範圍；大分類已涵蓋的子分類不重複加總。</p></div>`;
  const focusRows = displayed.map((row, index) => `<div class="budget-focus-row ${row.exceeded ? 'is-exceeded' : ''}" tabindex="0" data-overview-focus-sort aria-label="排序${esc(label(row))}；可使用上下方向鍵；按住卡片外框拖曳；使用上下方向鍵也可排序" title="${esc(label(row))}" style="--budget-category-color:${esc(colorFor(row, index))}" data-overview-item="${esc(budgetOrderKey(row))}" data-overview-kind="focus"><div><div class="budget-focus-label"><strong><span class="budget-category-color-mark" aria-hidden="true"></span><span class="budget-focus-name">${esc(label(row))}</span></strong><span>${money(row.actualMinor)} / ${money(row.budgetMinor)}</span></div><progress class="${row.exceeded ? 'is-exceeded' : ''}" style="--budget-category-color:${esc(colorFor(row, index))}" max="100" value="${progress(row.actualMinor, row.budgetMinor)}" aria-label="${esc(label(row))}使用進度"></progress><small class="${row.exceeded ? 'expense' : ''}">${row.exceeded ? '超支' : '剩餘'} ${money(row.remainingMinor < 0n ? -row.remainingMinor : row.remainingMinor)}</small></div></div>`).join('') || `<p class="finance-empty">${config.focusFilterEnabled ? '目前沒有勾選的分類；關閉「只顯示已勾選項目」即可查看全部預算。' : '尚未選擇重點分類。'}</p>`;
  const body = rows.length ? `${overallSummary}<div class="budget-summary-focus-list" data-visible-rows="${focusVisibleCount}" data-overview-budget-month="${esc(rows[0]?.month || '')}" tabindex="0" role="region" aria-label="本月預算清單，可捲動查看全部預算">${focusRows}</div>` : '<p class="finance-empty">本月尚未設定預算。從「全部預算」開始設定。</p>';
  return `${heading(rows.length ? settings : '')}${preview ? '<span class="budget-preview-label">範例預算 · 不會保存為正式資料</span>' : ''}<div class="overview-collapsible-content ${collapsed ? 'is-collapsed' : 'is-expanded'}" aria-hidden="${collapsed}" ${collapsed ? 'inert' : ''}>${body}</div>`;
}
