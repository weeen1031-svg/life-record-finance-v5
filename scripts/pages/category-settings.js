import { icon } from '../icons.js';
import { escapeHTML } from '../escape-html.js';
import { categoryIconChoices, colorPalette } from '../category-store.js';

export function createCategoryEditorState(store, entryType = 'expense') {
  const type = entryType === 'income' ? 'income' : 'expense';
  const first = store.listCategories({ entryType: type, includeHidden: false })[0];
  return {
    entryType: type,
    selectedCategoryId: first?.id ?? '',
    draftName: first?.name ?? '',
    draftIcon: first?.icon ?? 'tag',
    draftColor: first?.color ?? '#8795A7',
    searchQuery: '',
    newSubcategoryName: '',
    showHiddenCategories: false,
    hiddenEditMode: false,
    hiddenCategoryDrafts: {},
    showHiddenOrphans: false,
    editingSubcategoryId: '',
    draftSubcategoryName: '',
    notice: '',
    noticeTone: 'neutral',
    unlinkConfirmation: null,
    subcategoryDialog: null,
  };
}

export function switchCategoryEditorType(store, state, entryType) {
  if (!['expense', 'income'].includes(entryType) || state.entryType === entryType) return false;
  Object.assign(state, createCategoryEditorState(store, entryType));
  return true;
}

export function selectCategoryForEditing(store, state, categoryId) {
  const category = store.getCategory(categoryId);
  if (!category) return false;
  state.entryType = category.entryType;
  state.selectedCategoryId = category.id;
  state.draftName = category.name;
  state.draftIcon = category.icon;
  state.draftColor = category.color;
  state.searchQuery = '';
  state.newSubcategoryName = '';
  state.editingSubcategoryId = '';
  state.draftSubcategoryName = '';
  state.notice = '';
  state.noticeTone = 'neutral';
  return true;
}

function renderSuggestions(store, state) {
  const query = state.searchQuery.trim();
  if (!query) return `<div class="suggestion-empty">${icon('sparkSmall', 15)}輸入名稱搜尋可共用的既有子分類。</div>`;
  const matches = store.searchSubcategories(query, 8, { entryType: state.entryType });
  if (!matches.length) return `<div class="suggestion-empty">沒有找到符合項目。請明確選擇建立新的獨立子分類。</div>`;
  return `<div class="subcategory-suggestions">${matches.map((item) => {
    const usedBy = store.getUsageNames(item.id);
    const alreadyUsed = item.categoryIds.includes(state.selectedCategoryId);
    return `<article class="subcategory-suggestion"><span class="suggestion-symbol">${icon('tag', 16)}</span><div class="suggestion-copy"><strong>${escapeHTML(item.name)}</strong><small>目前使用於：${usedBy.map(escapeHTML).join('、') || '尚未指派'}</small></div><button class="quiet-button share-subcategory-button" type="button" data-action="share-subcategory" data-subcategory-id="${escapeHTML(item.id)}" ${alreadyUsed ? 'disabled' : ''}>${alreadyUsed ? '已在此分類' : '共用既有子分類'}</button></article>`;
  }).join('')}</div>`;
}

export function updateSubcategorySuggestions(root, store, state) {
  const target = root.querySelector('[data-subcategory-suggestions]');
  if (target) target.innerHTML = renderSuggestions(store, state);
}

function renderSubcategoryRow(store, state, item, categoryId = '') {
  const usage = store.getUsageNames(item.id);
  const colorCategory = store.getCategory(categoryId || item.categoryIds[0]);
  const editing = state.editingSubcategoryId === item.id;
  const id = escapeHTML(item.id);
  const hiddenTag = item.hidden ? '<span class="category-status-tag is-hidden">已隱藏</span>' : '';
  const usageText = usage.length ? `使用於：${usage.map(escapeHTML).join('、')}` : '目前未指派，可重新共用或刪除';

  return `<div class="assigned-subcategory ${item.hidden ? 'is-hidden' : ''}" data-subcategory-id="${id}" ${categoryId ? `data-sort-item data-sort-kind="subcategory" data-sort-id="${id}" data-sort-parent="${escapeHTML(categoryId)}"` : ''}>
    ${categoryId ? `<button class="category-drag-handle" type="button" draggable="false" data-sort-handle aria-label="拖曳排序${escapeHTML(item.name)}；也可使用上下方向鍵" title="拖曳排序；上下方向鍵移動">${icon('menu', 15)}</button>` : ''}
    <span class="assigned-subcategory-dot" style="--category-color:${escapeHTML(colorCategory?.color ?? '#8795A7')}" aria-hidden="true"></span>
    ${editing
      ? `<label class="subcategory-inline-edit"><span class="visually-hidden">修改子分類名稱</span><input type="text" maxlength="32" value="${escapeHTML(state.draftSubcategoryName)}" data-field="subcategory-edit-name" data-subcategory-id="${id}" /></label><div class="subcategory-row-actions"><button class="mini-action" type="button" data-action="save-subcategory-name" data-subcategory-id="${id}" aria-label="儲存子分類名稱">${icon('check', 14)}</button><button class="mini-action" type="button" data-action="cancel-subcategory-edit" aria-label="取消修改">${icon('close', 14)}</button></div>`
      : `<strong>${escapeHTML(item.name)} ${hiddenTag}</strong><small>${usageText}</small><div class="subcategory-row-actions">
        <button class="mini-action" type="button" data-action="edit-subcategory-name" data-subcategory-id="${id}" aria-label="編輯子分類名稱：${escapeHTML(item.name)}" title="編輯名稱">${icon('pencil', 13)}</button>
        <button class="mini-action" type="button" data-action="toggle-subcategory-hidden" data-subcategory-id="${id}" aria-label="${item.hidden ? '恢復' : '隱藏'}子分類：${escapeHTML(item.name)}" title="${item.hidden ? '恢復使用' : '隱藏'}">${icon(item.hidden ? 'eye' : 'eyeOff', 13)}</button>
        ${categoryId ? `<button class="mini-action" type="button" data-action="unlink-subcategory" data-category-id="${escapeHTML(categoryId)}" data-subcategory-id="${id}" aria-label="從目前大分類移出${escapeHTML(item.name)}" title="從此分類移出">${icon('unlink', 13)}</button>` : ''}
        <button class="mini-action danger-quiet-button" type="button" data-action="delete-subcategory" data-subcategory-id="${id}" aria-label="永久刪除子分類定義：${escapeHTML(item.name)}" title="永久刪除子分類（先檢查全部分類關聯及已保存紀錄）">${icon('trash', 13)}</button>
      </div>`}
  </div>`;
}

export function renderCategorySettingsPage(store, state) {
  const catalogReady = store.isReady?.() ?? true;
  const mutationPending = store.isMutationPending?.() ?? false;
  const busy = !catalogReady || mutationPending;
  const loadError = store.getLoadError?.() || '';
  const persistenceStatus = mutationPending
    ? `<div class="category-persistence-status is-saving" role="status" aria-live="polite">正在保存分類變更…</div>`
    : !catalogReady
      ? `<div class="category-persistence-status ${loadError ? 'is-error' : ''}" role="status" aria-live="polite">${loadError ? `分類設定載入失敗：${escapeHTML(loadError)}` : '正在載入已保存的分類設定…'}${loadError ? '<button class="quiet-button" type="button" data-action="retry-category-load">重試讀取</button>' : ''}</div>`
      : loadError
        ? `<div class="category-persistence-status is-error" role="status" aria-live="polite">分類設定載入失敗：${escapeHTML(loadError)}</div>`
        : '';
  const categories = catalogReady ? store.listCategories({ includeHidden: Boolean(state.hiddenEditMode), entryType: state.entryType }) : [];
  let selected = categories.find((item) => item.id === state.selectedCategoryId) || null;
  if (!selected && categories[0]) {
    selected = categories[0];
    state.selectedCategoryId = selected.id;
    state.draftName = selected.name;
    state.draftIcon = selected.icon;
    state.draftColor = selected.color;
  }
  const subcategories = selected ? store.listSubcategories(selected.id) : [];
  const orphans = store.listOrphanSubcategories({ includeHidden: state.showHiddenOrphans, entryType: state.entryType });
  const iconOptions = categoryIconChoices.map((choice) => `<button class="icon-choice ${state.draftIcon === choice.id ? 'is-selected' : ''}" type="button" data-action="select-category-icon" data-icon-choice="${choice.id}" aria-label="使用${choice.label}圖示" aria-pressed="${state.draftIcon === choice.id}" title="${choice.label}">${icon(choice.id, 19)}</button>`).join('');
  const colors = colorPalette.map((color) => `<button class="color-swatch ${state.draftColor === color.value ? 'is-selected' : ''}" type="button" style="--swatch:${color.value}" data-action="select-category-color" data-color="${color.value}" aria-label="選擇${color.name}" aria-pressed="${state.draftColor === color.value}" title="${color.name}"></button>`).join('');

  return `
    <div class="page-heading inner-page-heading category-page-heading">
      <div><div class="eyebrow"><span class="eyebrow-spark">${icon('sparkSmall', 15)}</span> SETTINGS / LEDGER <span class="eyebrow-line"></span> 本機保存</div><h1>記帳分類</h1><p class="page-subtitle">管理收入及支出的兩層分類。</p></div>
      <button class="quiet-button app-back-control back-settings-button" type="button" data-action="app-back" aria-label="返回上一頁">${icon('chevron', 15)} 返回上一頁</button>
    </div>
    ${persistenceStatus}
    <fieldset class="category-controls" ${busy ? 'disabled' : ''}>

    <div class="entry-type-switch category-type-switch" role="group" aria-label="選擇要管理的收支分類">
      <button class="entry-type-button ${state.entryType === 'expense' ? 'is-selected expense' : ''}" type="button" data-action="category-set-type" data-entry-type="expense" aria-pressed="${state.entryType === 'expense'}">${icon('arrowUp', 16)}支出分類</button>
      <button class="entry-type-button ${state.entryType === 'income' ? 'is-selected income' : ''}" type="button" data-action="category-set-type" data-entry-type="income" aria-pressed="${state.entryType === 'income'}">${icon('arrowDown', 16)}收入分類</button>
    </div>

    <section class="category-manager" aria-label="記帳分類管理">
      <div class="category-section-heading"><div><h2>大分類</h2><p>${state.hiddenEditMode ? '一次調整多個分類的顯示狀態，儲存後才會套用。' : '選取分類後可修改名稱、圖示與顏色。'}</p></div><div class="category-heading-actions">${state.hiddenEditMode ? `<button class="quiet-button" type="button" data-action="cancel-hidden-categories">取消</button><button class="primary-button" type="button" data-action="save-hidden-categories">儲存並完成</button>` : `<button class="quiet-button compact-toggle-button" type="button" data-action="edit-hidden-categories">${icon('eyeOff', 14)}編輯隱藏</button><button class="primary-button add-category-button" type="button" data-action="add-category">${icon('plus', 16)} 新增大分類</button>`}</div></div>
      <div class="category-card-grid">${categories.length ? categories.map((category) => {
        const draftHidden = state.hiddenEditMode ? (state.hiddenCategoryDrafts?.[category.id] ?? category.hidden) : category.hidden;
        const sortAttrs = state.hiddenEditMode ? '' : `data-sort-item data-sort-kind="category" data-sort-id="${escapeHTML(category.id)}" data-sort-parent="${state.entryType}"`;
        const dragHandle = state.hiddenEditMode ? '' : `<button class="category-drag-handle" type="button" draggable="false" data-sort-handle aria-label="拖曳排序${escapeHTML(category.name)}；也可使用上下方向鍵" title="拖曳排序；上下方向鍵移動">${icon('menu', 15)}</button>`;
        const visibilityControl = state.hiddenEditMode
          ? `<button class="category-visibility-draft ${draftHidden ? 'is-hidden' : 'is-visible'}" type="button" data-action="draft-category-hidden" data-category-id="${escapeHTML(category.id)}" aria-pressed="${!draftHidden}" aria-label="${draftHidden ? '目前隱藏，按此改為顯示' : '目前顯示，按此改為隱藏'}：${escapeHTML(category.name)}"><span class="category-visibility-indicator" aria-hidden="true"></span><span>${draftHidden ? '隱藏' : '顯示'}</span></button>`
          : `<button class="mini-action danger-quiet-button" type="button" data-action="delete-category" data-category-id="${escapeHTML(category.id)}" aria-label="刪除大分類：${escapeHTML(category.name)}" title="刪除分類">${icon('trash', 14)}</button>`;
        return `<article class="managed-category-card ${selected?.id === category.id ? 'is-selected' : ''} ${draftHidden ? 'is-hidden' : ''} ${state.hiddenEditMode ? 'is-hidden-editing' : ''}" style="--category-color:${escapeHTML(category.color)}" ${sortAttrs}>
        ${dragHandle}
        <button class="managed-category-select" type="button" data-action="select-category" data-category-id="${escapeHTML(category.id)}" aria-label="編輯大分類：${escapeHTML(category.name)}" title="編輯此大分類" aria-pressed="${selected?.id === category.id}"><span class="managed-category-icon">${icon(category.icon, 19)}</span><span class="managed-category-copy"><strong>${escapeHTML(category.name)}</strong><small>${store.listSubcategories(category.id).length} 個子分類 · 點選編輯${category.hidden ? ' · 已隱藏' : ''}</small></span></button>
        <div class="category-card-actions">${visibilityControl}</div>
      </article>`;
      }).join('') : '<div class="assigned-empty category-list-empty">目前沒有顯示中的大分類。可使用「編輯隱藏」恢復分類或新增大分類。</div>'}</div>

      ${selected ? `<div class="category-editor-grid">
        <section class="category-editor-card" aria-labelledby="category-editor-title">
          <div class="editor-card-heading"><span class="editor-heading-icon" style="--category-color:${escapeHTML(state.draftColor)}">${icon(state.draftIcon, 20)}</span><div><h3 id="category-editor-title">編輯大分類</h3><p>所選分類：${escapeHTML(selected?.name ?? '')}</p></div><span class="editor-demo-tag">本機分類</span></div>
          <div class="category-name-field"><label for="category-name-input">大分類名稱</label><div class="category-name-input-wrap"><input id="category-name-input" type="text" maxlength="24" value="${escapeHTML(state.draftName)}" placeholder="輸入分類名稱" data-field="category-name" />${state.draftName ? `<button class="category-name-clear" type="button" data-action="clear-category-name" aria-label="清除大分類名稱" title="清除名稱">${icon('close', 16)}</button>` : ''}</div></div>
          <div class="editor-field"><div class="editor-label-row"><span>選擇圖示</span><small>${categoryIconChoices.length} 種預設圖示</small></div><div class="icon-choice-grid">${iconOptions}</div></div>
          <div class="editor-field"><div class="editor-label-row"><span>識別顏色</span><small>24 種預設顏色</small></div><div class="color-swatch-grid">${colors}</div></div>
          <div class="category-save-row"><span class="category-save-hint" data-operation-hint>變更會同步到新增記帳頁，既有分類 ID 不變。</span><button class="primary-button" type="button" data-action="save-category">${icon('check', 16)} 套用變更</button></div>
        </section>

        <section class="subcategory-editor-card" aria-labelledby="subcategory-editor-title">
          <div class="editor-card-heading"><span class="editor-heading-icon category-child-heading" style="--category-color:${escapeHTML(selected.color)}">${icon(selected.icon, 19)}</span><div><h3 id="subcategory-editor-title">${escapeHTML(selected?.name ?? '')} · 子分類</h3><p>拖曳或使用方向鍵排序；共用項目只調整此大分類內的順序。</p></div></div>
          <div class="subcategory-add-area">
            <div class="subcategory-existing-block"><div class="subcat-area-heading"><span class="subcat-step">A</span><div><strong>搜尋並共用既有子分類</strong><small>搜尋名稱後選擇要共用的項目。</small></div></div>
              <label class="subcategory-search-field"><span class="visually-hidden">搜尋同類型既有子分類</span><span class="search-icon">${icon('chart', 16)}</span><input type="search" value="${escapeHTML(state.searchQuery)}" placeholder="${state.entryType === 'income' ? '例如：薪資、獎金' : '例如：布丁、電子、Steam'}" autocomplete="off" data-field="subcategory-search" /></label>
              <div class="subcategory-suggestion-host" data-subcategory-suggestions>${renderSuggestions(store, state)}</div></div>
            <div class="independent-subcategory-block"><div class="subcat-area-heading"><span class="subcat-step new">B</span><div><strong>建立新的獨立子分類</strong><small>名稱相同也會建立新的 ID，不會自動合併。</small></div></div><div class="independent-create-row"><input type="text" maxlength="32" value="${escapeHTML(state.newSubcategoryName)}" placeholder="輸入新的子分類名稱" data-field="new-subcategory-name" aria-label="新的獨立子分類名稱" /><button class="quiet-button" type="button" data-action="create-independent-subcategory">建立獨立項目</button></div></div>
          </div>
          <div class="assigned-subcategory-list">${subcategories.length ? subcategories.map((item) => renderSubcategoryRow(store, state, item, selected.id)).join('') : '<div class="assigned-empty">此大分類尚無子分類。</div>'}</div>
        </section>
      </div>` : '<div class="category-no-selection">目前沒有可編輯的大分類，請先新增或恢復分類。</div>'}

      <section class="orphan-subcategory-manager" aria-labelledby="orphan-subcategory-title">
        <div class="category-section-heading orphan-heading"><div><h2 id="orphan-subcategory-title">未指派的子分類</h2><p>解除所有大分類關聯後，子分類會保留在這裡，不會被連帶刪除。</p></div><button class="quiet-button compact-toggle-button" type="button" data-action="toggle-hidden-orphans" aria-pressed="${state.showHiddenOrphans}">${icon(state.showHiddenOrphans ? 'eye' : 'eyeOff', 14)}${state.showHiddenOrphans ? '隱藏已隱藏項目' : '顯示已隱藏項目'}</button></div>
        <div class="orphan-subcategory-list">${orphans.length ? orphans.map((item) => renderSubcategoryRow(store, state, item)).join('') : '<div class="assigned-empty">目前沒有未指派的子分類。</div>'}</div>
      </section>
      <div class="category-page-feedback ${state.noticeTone}" data-category-notice role="status" aria-live="polite">${escapeHTML(state.notice || '刪除前讀取已保存的收支引用；無法確認或仍有引用就阻擋。解除關聯不會刪除子分類。')}</div>
    </section>
    </fieldset>${state.deleteConfirmation ? `<div class="category-delete-backdrop" data-category-delete-dialog><section class="category-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="category-delete-title" aria-describedby="category-delete-description"><h2 id="category-delete-title">確定要刪除「${escapeHTML(state.deleteConfirmation.category.name)}」嗎？</h2><p id="category-delete-description">刪除只會移除此大分類及其關聯，不會刪除子分類或已保存交易。保存時仍會再次檢查收支及提醒引用。</p><div class="category-delete-actions"><button class="quiet-button" type="button" data-action="cancel-delete-category" autofocus>取消</button><button class="danger-quiet-button" type="button" data-action="confirm-delete-category" data-category-id="${escapeHTML(state.deleteConfirmation.category.id)}">確認刪除</button></div></section></div>` : ''}${state.unlinkConfirmation ? `<div class="category-delete-backdrop" data-category-unlink-dialog><section class="category-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="category-unlink-title" aria-describedby="category-unlink-description"><h2 id="category-unlink-title">從「${escapeHTML(state.unlinkConfirmation.categoryName)}」移除「${escapeHTML(state.unlinkConfirmation.itemName)}」？</h2><p id="category-unlink-description">只解除這一組大分類與子分類的關聯；子分類本身、其他大分類的共用關聯及其歷史紀錄都會保留。保存時會再次檢查這一組關聯是否仍被使用。</p><div class="category-delete-actions"><button class="quiet-button" type="button" data-action="cancel-unlink-subcategory" autofocus>取消</button><button class="primary-button" type="button" data-action="confirm-unlink-subcategory" data-category-id="${escapeHTML(state.unlinkConfirmation.categoryId)}" data-subcategory-id="${escapeHTML(state.unlinkConfirmation.subcategoryId)}">確認移除</button></div></section></div>` : ''}${state.subcategoryDialog ? `<div class="category-delete-backdrop" data-subcategory-dialog data-dialog-kind="${escapeHTML(state.subcategoryDialog.kind)}"><section class="category-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="subcategory-dialog-title" aria-describedby="subcategory-dialog-description"><h2 id="subcategory-dialog-title">${state.subcategoryDialog.kind === 'delete-confirmation' ? `確定刪除「${escapeHTML(state.subcategoryDialog.itemName)}」嗎？` : escapeHTML(state.subcategoryDialog.title)}</h2><p id="subcategory-dialog-description">${escapeHTML(state.subcategoryDialog.message)}</p><div class="category-delete-actions ${state.subcategoryDialog.kind === 'delete-confirmation' ? '' : 'is-single-action'}">${state.subcategoryDialog.kind === 'delete-confirmation' ? `<button class="quiet-button" type="button" data-action="cancel-delete-subcategory" autofocus>取消</button><button class="quiet-button danger-quiet-button" type="button" data-action="confirm-delete-subcategory" data-subcategory-id="${escapeHTML(state.subcategoryDialog.subcategoryId)}">刪除</button>` : `<button class="primary-button" type="button" data-action="close-subcategory-dialog" autofocus>我知道了</button>`}</div></section></div>` : ''}`;
}
