import { isValidDateOnly } from '../storage/expense-db.js';

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const scopeKey = (categoryId, subcategoryId = '') => `${categoryId}::${subcategoryId || '*'}`;

// A parent budget covers its children. Child-only scopes remain independent.
export function summarizeBudgetRows(rows) {
  const unique = [...new Map(rows.map((row) => [scopeKey(row.categoryId, row.subcategoryId), row])).values()];
  const parents = new Set(unique.filter((row) => !row.subcategoryId).map((row) => row.categoryId));
  const covered = unique.filter((row) => !row.subcategoryId || !parents.has(row.categoryId));
  const budgetMinor = covered.reduce((sum, row) => sum + BigInt(row.budgetMinor), 0n);
  const actualMinor = covered.reduce((sum, row) => sum + BigInt(row.actualMinor), 0n);
  return { budgetMinor, actualMinor, remainingMinor: budgetMinor - actualMinor };
}

export function isValidBudgetMonth(value) {
  return typeof value === 'string' && monthPattern.test(value) && isValidDateOnly(`${value}-01`);
}

function validBudgetAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function calculateMonthlyBudgets(data, month) {
  if (!isValidBudgetMonth(month)) throw new Error('預算月份格式無效。');
  const preferences = data.financePreferences?.[0] || {};
  const schedules = Array.isArray(preferences.budgetSchedules) ? preferences.budgetSchedules : [];
  const overrides = Array.isArray(preferences.budgetOverrides) ? preferences.budgetOverrides : [];
  const catalog = data.categoryCatalog?.[0];
  const categories = new Map((catalog?.categories || []).map((item) => [item.id, item]));
  const subcategories = new Map((catalog?.subcategories || []).map((item) => [item.id, item]));
  const scopes = new Map();
  for (const rule of schedules) {
    if (rule.effectiveFromMonth <= month) {
      const key = scopeKey(rule.categoryId, rule.subcategoryId);
      const previous = scopes.get(key);
      if (!previous || previous.effectiveFromMonth < rule.effectiveFromMonth) scopes.set(key, rule);
    }
  }
  for (const override of overrides) {
    if (override.month === month) scopes.set(scopeKey(override.categoryId, override.subcategoryId), override);
  }
  const expenses = (data.expenses || []).filter((item) => item.occurredOn?.startsWith(`${month}-`));
  return [...scopes.values()].map((rule) => {
    const actualMinor = expenses.reduce((sum, item) => {
      if (item.categoryId !== rule.categoryId) return sum;
      if (rule.subcategoryId && item.subcategoryId !== rule.subcategoryId) return sum;
      return sum + BigInt(item.amountMinor);
    }, 0n);
    const category = categories.get(rule.categoryId);
    const subcategory = rule.subcategoryId ? subcategories.get(rule.subcategoryId) : null;
    return {
      id: rule.id,
      categoryId: rule.categoryId,
      categoryName: category?.name || '已移除分類',
      subcategoryId: rule.subcategoryId || null,
      subcategoryName: subcategory?.name || '',
      month,
      // Budget input/configuration remains whole TWD; calculation values below are cents.
      budgetTwd: Number(rule.amountTwd),
      budgetMinor: BigInt(rule.amountTwd) * 100n,
      actualMinor,
      remainingMinor: BigInt(rule.amountTwd) * 100n - actualMinor,
      exceeded: actualMinor > BigInt(rule.amountTwd) * 100n,
      isMonthOverride: overrides.some((item) => item.month === month && scopeKey(item.categoryId, item.subcategoryId) === scopeKey(rule.categoryId, rule.subcategoryId)),
    };
  }).sort((left, right) => left.categoryName.localeCompare(right.categoryName, 'zh-TW') || left.subcategoryName.localeCompare(right.subcategoryName, 'zh-TW'));
}

export function setMonthlyBudget(preferences, { categoryId, subcategoryId = '', month, amountTwd, applyFuture = false }) {
  if (!isValidBudgetMonth(month) || !validBudgetAmount(amountTwd) || typeof applyFuture !== 'boolean') {
    throw new Error('預算月份、整數金額或套用範圍無效。');
  }
  const key = scopeKey(categoryId, subcategoryId);
  const id = `${applyFuture ? 'bs' : 'bo'}_${categoryId}_${subcategoryId || 'all'}_${month}`;
  if (!Array.isArray(preferences.budgetSchedules)) preferences.budgetSchedules = [];
  if (!Array.isArray(preferences.budgetOverrides)) preferences.budgetOverrides = [];
  if (applyFuture) {
    preferences.budgetSchedules = preferences.budgetSchedules.filter((item) => !(scopeKey(item.categoryId, item.subcategoryId) === key && item.effectiveFromMonth === month));
    preferences.budgetSchedules.push({ id, categoryId, subcategoryId: subcategoryId || '', effectiveFromMonth: month, amountTwd, revision: 1 });
  } else {
    preferences.budgetOverrides = preferences.budgetOverrides.filter((item) => !(scopeKey(item.categoryId, item.subcategoryId) === key && item.month === month));
    preferences.budgetOverrides.push({ id, categoryId, subcategoryId: subcategoryId || '', month, amountTwd, revision: 1 });
  }
}
