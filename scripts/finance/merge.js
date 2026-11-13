import { stableJson } from '../storage/json-data.js';
import { validateFinanceSnapshot } from './model.js';

const omit = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
const orderedUnion = (left = [], right = [], label = '項目') => {
  const leftIds = left.map((item) => typeof item === 'string' ? item : item.id);
  const rightIds = right.map((item) => typeof item === 'string' ? item : item.id);
  const sharedLeft = leftIds.filter((id) => rightIds.includes(id));
  const sharedRight = rightIds.filter((id) => leftIds.includes(id));
  if (stableJson(sharedLeft) !== stableJson(sharedRight)) throw new Error(`${label}在兩份資料中的排列不同`);
  const ids = [...leftIds, ...rightIds.filter((id) => !leftIds.includes(id))];
  const byId = new Map([...left, ...right].map((item) => [typeof item === 'string' ? item : item.id, item]));
  return ids.map((id) => byId.get(id));
};

function mergeRows(left, right, label, keyOf = (item) => item.id, ignoredFields = []) {
  const rows = new Map(left.map((item) => [keyOf(item), structuredClone(item)]));
  let added = 0;
  for (const incoming of right) {
    const key = keyOf(incoming);
    const existing = rows.get(key);
    if (!existing) { rows.set(key, structuredClone(incoming)); added += 1; continue; }
    const comparableFields = [...new Set([...ignoredFields, 'revision'])];
    if (stableJson(omit(existing, comparableFields)) !== stableJson(omit(incoming, comparableFields))) throw new Error(`${label}「${key}」在兩份備份中內容不同`);
    if (Number.isSafeInteger(existing.revision) && Number.isSafeInteger(incoming.revision)) existing.revision = Math.max(existing.revision, incoming.revision);
  }
  return { rows: [...rows.values()], added };
}

function mergeCatalog(current, incoming) {
  if (current.id !== incoming.id || current.schemaVersion !== incoming.schemaVersion) throw new Error('分類目錄版本不同');
  const categories = mergeRows(current.categories, incoming.categories, '大分類', (item) => item.id, ['subcategoryOrder']);
  const categoryById = new Map(categories.rows.map((item) => [item.id, item]));
  for (const source of incoming.categories) {
    const target = current.categories.find((item) => item.id === source.id);
    if (!target || !Array.isArray(target.subcategoryOrder) && !Array.isArray(source.subcategoryOrder)) continue;
    try {
      categoryById.get(source.id).subcategoryOrder = orderedUnion(target.subcategoryOrder || [], source.subcategoryOrder || [], `「${source.name}」子分類`);
    } catch (error) { throw new Error(`大分類「${source.name}」的子分類排序衝突：${error.message}`); }
  }
  const subcategories = mergeRows(current.subcategories, incoming.subcategories, '子分類', (item) => item.id);
  const result = {
    ...structuredClone(current),
    categories: orderedUnion(current.categories.map((item) => item.id), incoming.categories.map((item) => item.id), '大分類').map((id) => categoryById.get(id)),
    subcategories: orderedUnion(current.subcategories.map((item) => item.id), incoming.subcategories.map((item) => item.id), '子分類').map((id) => new Map(subcategories.rows.map((item) => [item.id, item])).get(id)),
  };
  return { catalog: result, added: categories.added + subcategories.added };
}

function mergePreferences(current, incoming) {
  if (current.id !== incoming.id || current.dataset !== incoming.dataset) throw new Error('記帳設定來源不同');
  const defaults = mergeRows(current.defaults || [], incoming.defaults || [], '分類預設帳戶', (item) => `${item.entryType}:${item.categoryId}`);
  const schedules = mergeRows(current.budgetSchedules || [], incoming.budgetSchedules || [], '預算排程');
  const overrides = mergeRows(current.budgetOverrides || [], incoming.budgetOverrides || [], '指定月份預算');
  const currentEntry = current.entryPreferences || {};
  const incomingEntry = incoming.entryPreferences || {};
  const entryPreferences = { ...structuredClone(currentEntry) };
  for (const key of new Set([...Object.keys(currentEntry), ...Object.keys(incomingEntry)])) {
    if (key === 'lastEntryDate') { entryPreferences[key] = [currentEntry[key] || '', incomingEntry[key] || ''].sort().at(-1) || ''; continue; }
    if (stableJson(currentEntry[key] ?? null) !== stableJson(incomingEntry[key] ?? null)) throw new Error(`通用記帳偏好「${key}」不同`);
  }
  const preferences = {
      ...structuredClone(current), defaults: defaults.rows, budgetSchedules: schedules.rows, budgetOverrides: overrides.rows, entryPreferences,
      revision: Math.max(current.revision, incoming.revision) + 1,
      generation: Math.max(current.generation, incoming.generation) + 1,
    };
  const changed = stableJson(omit(preferences, ['revision', 'generation'])) !== stableJson(omit(current, ['revision', 'generation']));
  return { preferences, added: defaults.added + schedules.added + overrides.added, changed };
}

export function mergeFinanceSnapshots(currentInput, incomingInput) {
  validateFinanceSnapshot(currentInput); validateFinanceSnapshot(incomingInput);
  const current = structuredClone(currentInput); const incoming = structuredClone(incomingInput);
  if (current.financePreferences[0].dataset !== incoming.financePreferences[0].dataset) throw new Error('只能加入相同資料來源的備份');
  const merged = structuredClone(current); const addedCounts = {}; let settingsChanged = false;
  try {
    const catalog = mergeCatalog(current.categoryCatalog[0], incoming.categoryCatalog[0]);
    merged.categoryCatalog = [catalog.catalog];
    addedCounts.categoryCatalog = catalog.added;
    for (const name of ['expenses', 'incomes', 'accounts', 'accountEvents', 'reminderRules', 'reminderOccurrences']) {
      const result = mergeRows(current[name], incoming[name], name === 'expenses' ? '支出' : name === 'incomes' ? '收入' : name === 'accounts' ? '帳戶' : name === 'accountEvents' ? '帳戶異動' : name === 'reminderRules' ? '定期項目' : '提醒期次', (item) => item.id, name === 'accountEvents' ? ['sequence'] : []);
      merged[name] = result.rows; addedCounts[name] = result.added;
    }
    const preferences = mergePreferences(current.financePreferences[0], incoming.financePreferences[0]);
    merged.financePreferences = [preferences.preferences]; addedCounts.financePreferences = preferences.added;
    settingsChanged = preferences.changed;
    merged.accountEvents.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence || left.id.localeCompare(right.id));
    merged.accountEvents.forEach((item, index) => { item.sequence = index + 1; });
    validateFinanceSnapshot(merged);
  } catch (error) {
    throw new Error(`無法安全加入備份：${error?.message || String(error)}。目前資料沒有變更；可改選覆蓋或取消。`);
  }
  const totalAdded = Object.values(addedCounts).reduce((sum, count) => sum + count, 0);
  const hasChanges = totalAdded > 0 || settingsChanged;
  return { data: hasChanges ? merged : current, addedCounts, totalAdded, changedSettings: settingsChanged, hasChanges, summary: validateFinanceSnapshot(hasChanges ? merged : current) };
}
