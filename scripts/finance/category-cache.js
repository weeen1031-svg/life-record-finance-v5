export function syncOfficialCategoryCache(store, catalog) {
  if (!catalog || !store?.replaceCatalog) {
    store?.setLoadState?.({ ready: false, error: '正式財務資料沒有有效的分類目錄；暫停使用舊分類快取。' });
    return { ok: false, error: '正式財務資料沒有有效的分類目錄。' };
  }
  const previousRevision = store.getRevision?.();
  if (!store.replaceCatalog(catalog)) {
    store.setLoadState?.({ ready: false, error: '正式分類目錄格式無效；暫停使用舊分類快取。' });
    return { ok: false, error: '正式分類目錄格式無效。' };
  }
  return { ok: true, changed: previousRevision !== catalog.revision, revision: catalog.revision };
}

export function getEntryDraftCategoryIssue(catalog, draft) {
  if (!draft || (!draft.categoryId && !draft.subcategoryId)) return '';
  const category = catalog?.categories?.find((item) => item.id === draft.categoryId
    && item.entryType === draft.type && !item.hidden);
  if (!category) return '原選取的大分類已變更、隱藏或不再可用；草稿內容已保留，請重新選擇。';
  if (draft.subcategoryId && !catalog.subcategories.some((item) => item.id === draft.subcategoryId
    && item.entryType === draft.type && !item.hidden && item.categoryIds.includes(category.id))) {
    return '原選取的子分類已變更、隱藏或解除關聯；草稿內容已保留，請重新選擇。';
  }
  return '';
}
