import { incomeCategories, incomeSubcategories } from './data.js';

export const colorPalette = [
  { name: '珊瑚紅', value: '#F05A67' }, { name: '磚紅', value: '#D94E55' },
  { name: '橘紅', value: '#EF765A' }, { name: '橘色', value: '#F28A4B' },
  { name: '琥珀', value: '#F4B544' }, { name: '亮黃', value: '#E7CE50' },
  { name: '萊姆綠', value: '#A5C94D' }, { name: '草綠', value: '#65C66D' },
  { name: '翡翠綠', value: '#42B982' }, { name: '薄荷綠', value: '#39BFA7' },
  { name: '青綠', value: '#35AEC2' }, { name: '天空藍', value: '#489FE0' },
  { name: '海藍', value: '#4B82E8' }, { name: '靛藍', value: '#6878ED' },
  { name: '紫羅蘭', value: '#866CE8' }, { name: '紫色', value: '#A069DE' },
  { name: '薰衣草', value: '#B27DE4' }, { name: '洋紅', value: '#CF67CA' },
  { name: '莓果粉', value: '#E16DB0' }, { name: '玫瑰粉', value: '#F07393' },
  { name: '石板藍', value: '#7186A1' }, { name: '灰藍', value: '#8795A7' },
  { name: '暖棕', value: '#B98567' }, { name: '銀灰', value: '#A7B1BF' },
];

export const categoryIconChoices = [
  { id: 'utensils', label: '餐飲' }, { id: 'bike', label: '機車' },
  { id: 'phone', label: '手機' }, { id: 'shoppingBag', label: '購物' },
  { id: 'gamepad', label: '娛樂' }, { id: 'store', label: '商店' },
  { id: 'ticket', label: '票券' }, { id: 'tag', label: '一般' },
  { id: 'coffee', label: '飲品' }, { id: 'car', label: '汽車' },
  { id: 'bus', label: '交通' }, { id: 'film', label: '電影' },
  { id: 'music', label: '音樂' }, { id: 'gift', label: '禮物' },
  { id: 'laptop', label: '電子' }, { id: 'heart', label: '健康' },
  { id: 'wallet', label: '錢包' }, { id: 'clock', label: '工作' },
  { id: 'home', label: '居家' }, { id: 'bed', label: '住宿' },
  { id: 'book', label: '書籍' }, { id: 'landmark', label: '金融' },
  { id: 'receipt', label: '帳單' }, { id: 'calendar', label: '活動' },
];

const validColors = new Set(colorPalette.map((item) => item.value));
const validIcons = new Set(categoryIconChoices.map((item) => item.id));

export function isValidCategoryCatalog(catalog) {
  if (!catalog || catalog.id !== 'ledger-categories' || catalog.schemaVersion !== 1
    || !Number.isSafeInteger(catalog.revision) || catalog.revision < 0
    || !Array.isArray(catalog.categories) || !Array.isArray(catalog.subcategories)
    || catalog.categories.length > 500 || catalog.subcategories.length > 5000) return false;
  const categoriesById = new Map();
  const allIds = new Set();
  for (const item of catalog.categories) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(item.id)
      || allIds.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80
      || !['expense', 'income'].includes(item.entryType) || !validIcons.has(item.icon)
      || !validColors.has(item.color) || typeof item.hidden !== 'boolean') return false;
    categoriesById.set(item.id, item);
    allIds.add(item.id);
  }
  const subcategoryIds = new Set();
  const categoryLinks = new Map([...categoriesById.keys()].map((id) => [id, new Set()]));
  for (const item of catalog.subcategories) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(item.id)
      || allIds.has(item.id) || subcategoryIds.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80
      || !['expense', 'income'].includes(item.entryType) || typeof item.hidden !== 'boolean'
      || !Array.isArray(item.categoryIds) || item.categoryIds.length > 500
      || new Set(item.categoryIds).size !== item.categoryIds.length
      || item.categoryIds.some((id) => categoriesById.get(id)?.entryType !== item.entryType)) return false;
    subcategoryIds.add(item.id);
    for (const id of item.categoryIds) categoryLinks.get(id).add(item.id);
    allIds.add(item.id);
  }
  for (const category of catalog.categories) {
    if (category.subcategoryOrder !== undefined && (!Array.isArray(category.subcategoryOrder)
      || category.subcategoryOrder.length > catalog.subcategories.length
      || new Set(category.subcategoryOrder).size !== category.subcategoryOrder.length
      || category.subcategoryOrder.some((id) => !categoryLinks.get(category.id).has(id)))) return false;
  }
  return true;
}

export function createCategoryStore({ catalog = null, ready = true } = {}) {
  const categories = [
    { id: 'cat-food', name: '吃', icon: 'utensils', color: '#F05A67', hidden: false },
    { id: 'cat-motorcycle', name: '機車', icon: 'bike', color: '#E7CE50', hidden: false },
    { id: 'cat-mobile', name: '手機', icon: 'phone', color: '#489FE0', hidden: false },
    { id: 'cat-shopee', name: '蝦皮', icon: 'shoppingBag', color: '#F28A4B', hidden: false },
    { id: 'cat-entertainment', name: '娛樂', icon: 'gamepad', color: '#866CE8', hidden: false },
    { id: 'cat-grocery', name: '超商／超市', icon: 'store', color: '#42B982', hidden: false },
    { id: 'cat-lottery', name: '彩票', icon: 'ticket', color: '#E16DB0', hidden: false },
    { id: 'cat-other', name: '其他', icon: 'tag', color: '#8795A7', hidden: false },
  ].map((item) => ({ ...item, entryType: 'expense' }));
  categories.push(...incomeCategories.map((item) => ({ ...item, entryType: 'income', hidden: false })));

  const subcategories = [
    { id: 'sub-breakfast', name: '早餐', categoryIds: ['cat-food'], hidden: false },
    { id: 'sub-lunch', name: '午餐', categoryIds: ['cat-food'], hidden: false },
    { id: 'sub-dinner', name: '晚餐', categoryIds: ['cat-food'], hidden: false },
    { id: 'sub-drink', name: '飲料', categoryIds: ['cat-food'], hidden: false },
    { id: 'sub-pudding-dog', name: '布丁狗', categoryIds: ['cat-food', 'cat-grocery'], hidden: false },
    { id: 'sub-fuel', name: '加油', categoryIds: ['cat-motorcycle'], hidden: false },
    { id: 'sub-parking', name: '停車', categoryIds: ['cat-motorcycle'], hidden: false },
    { id: 'sub-service', name: '機車保養', categoryIds: ['cat-motorcycle'], hidden: false },
    { id: 'sub-phone-bill', name: '電話費', categoryIds: ['cat-mobile'], hidden: false },
    { id: 'sub-electronics', name: '電子產品', categoryIds: ['cat-mobile', 'cat-shopee'], hidden: false },
    { id: 'sub-online-shopping', name: '網購', categoryIds: ['cat-shopee'], hidden: false },
    { id: 'sub-household', name: '日用品', categoryIds: ['cat-shopee', 'cat-grocery'], hidden: false },
    { id: 'sub-steam', name: 'Steam', categoryIds: ['cat-entertainment'], hidden: false },
    { id: 'sub-movie', name: '電影', categoryIds: ['cat-entertainment'], hidden: false },
    { id: 'sub-game', name: '遊戲', categoryIds: ['cat-entertainment'], hidden: false },
    { id: 'sub-grocery', name: '生鮮雜貨', categoryIds: ['cat-grocery'], hidden: false },
    { id: 'sub-snacks', name: '零食', categoryIds: ['cat-grocery'], hidden: false },
    { id: 'sub-lottery', name: '大樂透', categoryIds: ['cat-lottery'], hidden: false },
    { id: 'sub-scratch', name: '刮刮樂', categoryIds: ['cat-lottery'], hidden: false },
    { id: 'sub-uncategorized', name: '未分類', categoryIds: ['cat-other'], hidden: false },
  ].map((item) => ({ ...item, entryType: 'expense' }));
  subcategories.push(...incomeSubcategories.map((item) => ({ ...item, categoryIds: [...item.categoryIds], entryType: 'income', hidden: false })));

  let catalogRevision = 0;
  let catalogReady = ready;
  let catalogLoadError = '';
  let mutationPending = false;

  // Formal records now exist. Deletion must obtain an actual reference audit.
  const transactionReferenceIndex = {
    available: false,
    categoryCounts: new Map(),
    subcategoryCounts: new Map(),
    categorySubcategoryCounts: new Map(),
  };
  const categorySubcategoryKey = (categoryId, subcategoryId) => `${categoryId}\u0000${subcategoryId}`;

  function copySubcategory(item) {
    return { id: item.id, name: item.name, categoryIds: [...item.categoryIds], entryType: item.entryType, hidden: item.hidden === true };
  }

  function copyCategory(item) {
    return { ...item, ...(item.subcategoryOrder ? { subcategoryOrder: [...item.subcategoryOrder] } : {}) };
  }

  function newId(prefix) {
    if (typeof globalThis.crypto?.randomUUID === 'function') return `${prefix}_${globalThis.crypto.randomUUID()}`;
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    throw new Error('目前無法產生安全的分類識別碼，請使用 Brave 開啟本機網站。');
  }

  function transactionStatus(type, id) {
    if (!transactionReferenceIndex.available) {
      return { verified: false, count: null, reason: '目前無法確認是否有交易引用，為避免誤刪已阻止操作。' };
    }
    const counts = type === 'category' ? transactionReferenceIndex.categoryCounts : transactionReferenceIndex.subcategoryCounts;
    const count = counts.get(id) ?? 0;
    return count === 0
      ? { verified: true, count, reason: '' }
      : { verified: true, count, reason: `仍有 ${count} 筆已保存收支紀錄引用此項目，已阻止刪除。` };
  }

  const store = {
    isReady() { return catalogReady; },
    isMutationPending() { return mutationPending; },
    setMutationPending(value) { mutationPending = Boolean(value); },
    getRevision() { return catalogRevision; },
    getLoadError() { return catalogLoadError; },
    setLoadState({ ready: isLoaded = false, error = '' } = {}) {
      catalogReady = isLoaded;
      catalogLoadError = error;
    },
    exportCatalog() {
      return {
        id: 'ledger-categories',
        schemaVersion: 1,
        revision: catalogRevision,
        categories: categories.map(copyCategory),
        subcategories: subcategories.map(copySubcategory),
      };
    },
    replaceCatalog(nextCatalog) {
      if (!isValidCategoryCatalog(nextCatalog)) return false;
      categories.splice(0, categories.length, ...nextCatalog.categories.map(copyCategory));
      subcategories.splice(0, subcategories.length, ...nextCatalog.subcategories.map(copySubcategory));
      catalogRevision = nextCatalog.revision;
      catalogReady = true;
      catalogLoadError = '';
      transactionReferenceIndex.available = false;
      transactionReferenceIndex.categoryCounts.clear();
      transactionReferenceIndex.subcategoryCounts.clear();
      transactionReferenceIndex.categorySubcategoryCounts.clear();
      return true;
    },
    setTransactionReferences(records) {
      transactionReferenceIndex.available = false;
      transactionReferenceIndex.categoryCounts.clear();
      transactionReferenceIndex.subcategoryCounts.clear();
      transactionReferenceIndex.categorySubcategoryCounts.clear();
      if (!Array.isArray(records) || records.some((record) => !['expense', 'income'].includes(record?.recordType) || typeof record.categoryId !== 'string')) return false;
      for (const record of records) {
        const categoriesCount = transactionReferenceIndex.categoryCounts;
        const subcategoriesCount = transactionReferenceIndex.subcategoryCounts;
        categoriesCount.set(record.categoryId, (categoriesCount.get(record.categoryId) ?? 0) + 1);
        if (typeof record.subcategoryId === 'string') {
          subcategoriesCount.set(record.subcategoryId, (subcategoriesCount.get(record.subcategoryId) ?? 0) + 1);
          const key = categorySubcategoryKey(record.categoryId, record.subcategoryId);
          transactionReferenceIndex.categorySubcategoryCounts.set(key, (transactionReferenceIndex.categorySubcategoryCounts.get(key) ?? 0) + 1);
        }
      }
      transactionReferenceIndex.available = true;
      return true;
    },

    listCategories({ includeHidden = true, entryType } = {}) {
      return categories.filter((category) => (includeHidden || !category.hidden) && (!entryType || category.entryType === entryType)).map(copyCategory);
    },

    getCategory(categoryId) {
      const category = categories.find((item) => item.id === categoryId);
      return category ? copyCategory(category) : null;
    },

    isCategorySelectable(categoryId) {
      const category = categories.find((item) => item.id === categoryId);
      return Boolean(category && !category.hidden);
    },

    listSubcategories(categoryId, { includeHidden = true } = {}) {
      const order = categories.find((item) => item.id === categoryId)?.subcategoryOrder || [];
      const ranks = new Map(order.map((id, index) => [id, index]));
      return subcategories
        .filter((item) => item.categoryIds.includes(categoryId) && (includeHidden || !item.hidden))
        .sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length))
        .map(copySubcategory);
    },

    moveCategory(categoryId, toIndex) {
      const category = categories.find((item) => item.id === categoryId);
      if (!category || !Number.isInteger(toIndex)) return false;
      const ordered = categories.filter((item) => item.entryType === category.entryType);
      const from = ordered.findIndex((item) => item.id === categoryId);
      ordered.splice(from, 1);
      ordered.splice(Math.max(0, Math.min(ordered.length, toIndex)), 0, category);
      let index = 0;
      for (let slot = 0; slot < categories.length; slot += 1) if (categories[slot].entryType === category.entryType) categories[slot] = ordered[index++];
      return true;
    },

    moveSubcategory(categoryId, subcategoryId, toIndex) {
      const category = categories.find((item) => item.id === categoryId);
      const ordered = this.listSubcategories(categoryId).map((item) => item.id);
      const from = ordered.indexOf(subcategoryId);
      if (!category || from < 0 || !Number.isInteger(toIndex)) return false;
      ordered.splice(from, 1);
      ordered.splice(Math.max(0, Math.min(ordered.length, toIndex)), 0, subcategoryId);
      category.subcategoryOrder = ordered;
      return true;
    },

    listOrphanSubcategories({ includeHidden = true, entryType } = {}) {
      return subcategories.filter((item) => item.categoryIds.length === 0 && (includeHidden || !item.hidden) && (!entryType || item.entryType === entryType)).map(copySubcategory);
    },

    isSubcategorySelectable(categoryId, subcategoryId) {
      const category = categories.find((item) => item.id === categoryId);
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      return Boolean(category && !category.hidden && item && !item.hidden && item.entryType === category.entryType && item.categoryIds.includes(categoryId));
    },

    getSubcategory(subcategoryId) {
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      return item ? copySubcategory(item) : null;
    },

    searchSubcategories(query, limit = 8, { entryType } = {}) {
      const needle = String(query ?? '').trim().toLocaleLowerCase('zh-TW');
      if (!needle) return [];
      return subcategories
        .filter((item) => !item.hidden && (!entryType || item.entryType === entryType) && item.name.toLocaleLowerCase('zh-TW').includes(needle))
        .slice(0, limit)
        .map(copySubcategory);
    },

    getUsageNames(subcategoryId) {
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      if (!item) return [];
      return item.categoryIds
        .map((categoryId) => categories.find((category) => category.id === categoryId)?.name)
        .filter(Boolean);
    },

    addCategory({ name = '新大分類', icon = 'tag', color = '#8795A7', entryType = 'expense' } = {}) {
      if (!['expense', 'income'].includes(entryType)) return null;
      const category = {
        id: newId('category'),
        name: String(name).trim() || '新大分類',
        icon: validIcons.has(icon) ? icon : 'tag',
        color: validColors.has(color) ? color : '#8795A7',
        hidden: false,
        entryType,
      };
      categories.push(category);
      return { ...category };
    },

    setCategoryHidden(categoryId, hidden) {
      const category = categories.find((item) => item.id === categoryId);
      if (!category) return false;
      category.hidden = Boolean(hidden);
      return true;
    },

    getCategoryDeletionInfo(categoryId) {
      const category = categories.find((item) => item.id === categoryId);
      if (!category) return { exists: false, canDelete: false, reason: '找不到這個大分類。' };
      const related = subcategories.filter((item) => item.categoryIds.includes(categoryId));
      const transactions = transactionStatus('category', categoryId);
      return {
        exists: true,
        category: { ...category },
        relatedSubcategoryCount: related.length,
        sharedSubcategoryCount: related.filter((item) => item.categoryIds.length > 1).length,
        exclusiveSubcategoryCount: related.filter((item) => item.categoryIds.length === 1).length,
        transactionCount: transactions.count,
        referenceVerified: transactions.verified,
        canDelete: transactions.verified && transactions.count === 0,
        reason: transactions.reason,
      };
    },

    deleteCategory(categoryId) {
      const info = this.getCategoryDeletionInfo(categoryId);
      if (!info.exists || !info.canDelete) return { ok: false, reason: info.reason || '無法安全刪除這個大分類。' };
      const index = categories.findIndex((item) => item.id === categoryId);
      if (index < 0) return { ok: false, reason: '找不到這個大分類。' };
      categories.splice(index, 1);
      for (const item of subcategories) item.categoryIds = item.categoryIds.filter((id) => id !== categoryId);
      return { ok: true, info, orphanedSubcategoryCount: subcategories.filter((item) => item.categoryIds.length === 0).length };
    },

    updateCategory(categoryId, updates = {}) {
      const category = categories.find((item) => item.id === categoryId);
      if (!category) return false;
      if (typeof updates.name === 'string' && updates.name.trim()) category.name = updates.name.trim();
      if (validIcons.has(updates.icon)) category.icon = updates.icon;
      if (validColors.has(updates.color)) category.color = updates.color;
      return true;
    },

    updateSubcategory(subcategoryId, updates = {}) {
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      if (!item || typeof updates.name !== 'string' || !updates.name.trim()) return false;
      item.name = updates.name.trim();
      return true;
    },

    setSubcategoryHidden(subcategoryId, hidden) {
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      if (!item) return false;
      item.hidden = Boolean(hidden);
      return true;
    },

    unlinkSubcategory(categoryId, subcategoryId) {
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      if (!categories.some((category) => category.id === categoryId) || !item || !item.categoryIds.includes(categoryId)) return false;
      const reference = this.getSubcategoryAssociationUnlinkInfo(categoryId, subcategoryId);
      if (!reference.referenceVerified || !reference.canUnlink) return false;
      item.categoryIds = item.categoryIds.filter((id) => id !== categoryId);
      const category = categories.find((entry) => entry.id === categoryId);
      if (category?.subcategoryOrder) category.subcategoryOrder = category.subcategoryOrder.filter((id) => id !== subcategoryId);
      return true;
    },

    getSubcategoryAssociationUnlinkInfo(categoryId, subcategoryId) {
      const category = categories.find((entry) => entry.id === categoryId);
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      if (!category || !item || !item.categoryIds.includes(categoryId)) return { exists: false, canUnlink: false, transactionCount: null, referenceVerified: transactionReferenceIndex.available, reason: '這個子分類關聯不存在。' };
      if (!transactionReferenceIndex.available) return { exists: true, canUnlink: false, transactionCount: null, referenceVerified: false, reason: '目前無法確認此「大分類＋子分類」組合是否有歷史交易，為避免破壞資料，已阻止移除。' };
      const transactionCount = transactionReferenceIndex.categorySubcategoryCounts.get(categorySubcategoryKey(categoryId, subcategoryId)) ?? 0;
      return {
        exists: true, canUnlink: transactionCount === 0, transactionCount, referenceVerified: true,
        reason: transactionCount ? `「${category.name} → ${item.name}」仍有 ${transactionCount} 筆歷史交易，不能從此分類移除。其他分類的同名共用關聯不會影響這項檢查。` : '',
      };
    },

    getSubcategoryDeletionInfo(subcategoryId, { categoryId = '' } = {}) {
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      if (!item) return { exists: false, canDelete: false, reason: '找不到這個子分類。', usedBy: [] };
      const associations = item.categoryIds.map((linkedCategoryId) => ({
        id: linkedCategoryId,
        name: categories.find((category) => category.id === linkedCategoryId)?.name || '已不存在的大分類',
        transactionCount: transactionReferenceIndex.categorySubcategoryCounts.get(categorySubcategoryKey(linkedCategoryId, subcategoryId)) ?? 0,
      }));
      const usedBy = associations.map((association) => association.name);
      const transactions = transactionStatus('subcategory', subcategoryId);
      const hasCategoryLinks = item.categoryIds.length > 0;
      const canDeleteAfterRemovingSoleAssociation = Boolean(categoryId)
        && item.categoryIds.length === 1
        && item.categoryIds[0] === categoryId
        && transactions.verified
        && transactions.count === 0
        && associations[0]?.transactionCount === 0;
      const historicalUse = associations.filter((association) => association.transactionCount > 0)
        .map((association) => `「${association.name}」${association.transactionCount} 筆`);
      return {
        exists: true,
        item: copySubcategory(item),
        usedBy,
        associations,
        associationCount: item.categoryIds.length,
        transactionCount: transactions.count,
        referenceVerified: transactions.verified,
        canDelete: !hasCategoryLinks && transactions.verified && transactions.count === 0,
        canDeleteAfterRemovingSoleAssociation,
        reason: !transactions.verified
          ? transactions.reason
          : transactions.count > 0
            ? `永久刪除會影響 ${transactions.count} 筆歷史交易${historicalUse.length ? `（${historicalUse.join('、')}）` : ''}；請保留子分類。若目前這組關聯沒有交易，可只從此分類移除。`
            : hasCategoryLinks && !canDeleteAfterRemovingSoleAssociation
              ? `子分類仍關聯「${usedBy.join('、')}」。永久刪除會移除這些分類中的選項；請先確認。若只需移除目前分類，使用「從此分類移出」。`
              : '',
      };
    },

    deleteSubcategory(subcategoryId) {
      const info = this.getSubcategoryDeletionInfo(subcategoryId);
      if (!info.exists || !info.canDelete) return { ok: false, reason: info.reason || '無法安全刪除這個子分類。', info };
      const index = subcategories.findIndex((item) => item.id === subcategoryId);
      if (index < 0) return { ok: false, reason: '找不到這個子分類。', info };
      subcategories.splice(index, 1);
      for (const category of categories) if (category.subcategoryOrder) category.subcategoryOrder = category.subcategoryOrder.filter((id) => id !== subcategoryId);
      return { ok: true, info };
    },

    shareSubcategory(categoryId, subcategoryId) {
      const category = categories.find((item) => item.id === categoryId && !item.hidden);
      const item = subcategories.find((entry) => entry.id === subcategoryId);
      if (!category || !item || item.entryType !== category.entryType || item.hidden || item.categoryIds.includes(categoryId)) return false;
      item.categoryIds.push(categoryId);
      return true;
    },

    addIndependentSubcategory(categoryId, name) {
      const cleanName = String(name ?? '').trim();
      const category = categories.find((item) => item.id === categoryId && !item.hidden);
      if (!category || !cleanName) return null;
      const item = {
        id: newId('subcategory'),
        name: cleanName,
        categoryIds: [categoryId],
        hidden: false,
        entryType: category.entryType,
      };
      subcategories.push(item);
      return copySubcategory(item);
    },
  };

  if (catalog && !store.replaceCatalog(catalog)) throw new Error('分類目錄格式不相容。');
  return store;
}

export function createDefaultCategoryCatalog() {
  return createCategoryStore().exportCatalog();
}

export const categoryStore = createCategoryStore({ ready: false });
