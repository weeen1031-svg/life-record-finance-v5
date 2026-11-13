import { createCategoryStore, isValidCategoryCatalog } from '../category-store.js';
import { createExpenseRecord, createIncomeRecord, isValidDateOnly, validateOfficialSnapshot } from '../storage/expense-db.js';
import { stableJson } from '../storage/json-data.js';
import { calculateMonthlyBudgets, isValidBudgetMonth, setMonthlyBudget } from './budget.js';

export const FINANCE_STORES = ['expenses', 'incomes', 'categoryCatalog', 'accounts', 'accountEvents', 'financePreferences', 'reminderRules', 'reminderOccurrences'];
export const MAX_TWD = Math.floor(Number.MAX_SAFE_INTEGER / 100);
export const ACCOUNT_COLOR_PALETTE = [
  { color: '#8B9AAF', label: '霧藍灰' },
  { color: '#718AA5', label: '深霧藍' },
  { color: '#6F9A8C', label: '鼠尾草綠' },
  { color: '#B18B72', label: '暖棕' },
  { color: '#9B819B', label: '灰紫' },
  { color: '#A98286', label: '灰玫瑰' },
  { color: '#9A9A70', label: '橄欖灰' },
  { color: '#C77B7F', label: '柔和珊瑚' },
  { color: '#B96E75', label: '暗玫瑰' },
  { color: '#C27D61', label: '柔磚紅' },
  { color: '#C39451', label: '蜂蜜棕' },
  { color: '#ADA05A', label: '苔黃' },
  { color: '#8D9F5B', label: '橄欖綠' },
  { color: '#6E9968', label: '森林綠' },
  { color: '#5F967C', label: '青綠' },
  { color: '#5A9B91', label: '湖水綠' },
  { color: '#5B929F', label: '藍綠' },
  { color: '#638FAE', label: '鋼藍' },
  { color: '#727FAE', label: '灰藍紫' },
  { color: '#867DAF', label: '柔紫' },
  { color: '#A081A5', label: '薰衣草灰' },
  { color: '#B378A0', label: '莓紫' },
  { color: '#B47783', label: '灰莓紅' },
  { color: '#8795A7', label: '霧石灰' },
];
const accountColors = new Set(ACCOUNT_COLOR_PALETTE.map((item) => item.color));
export function getAccountColor(account) {
  return accountColors.has(account?.color) ? account.color : account?.type === 'bank' ? '#718AA5' : '#C39451';
}
export function createDefaultEntryPreferences() {
  return { defaultEntryType: 'expense', dateMode: 'today', preferredAccountId: '', preferredAccountIds: { expense: '', income: '' }, lastEntryDate: '' };
}
export function getPreferredAccountId(entryPreferences, entryType) {
  const byType = entryPreferences?.preferredAccountIds;
  if (byType && Object.hasOwn(byType, entryType)) return byType[entryType] || '';
  return entryPreferences?.preferredAccountId || '';
}
export function createMinimumFinanceCatalog(revision = 0) {
  return {
    id: 'ledger-categories', schemaVersion: 1, revision,
    categories: [
      { id: 'cat-other-expense', name: '其他', icon: 'tag', color: '#8795A7', hidden: false, entryType: 'expense' },
      { id: 'cat-other-income', name: '其他', icon: 'gift', color: '#39BFA7', hidden: false, entryType: 'income' },
    ],
    subcategories: [
      { id: 'sub-other-expense', name: '未分類', categoryIds: ['cat-other-expense'], entryType: 'expense', hidden: false },
      { id: 'sub-other-income', name: '未分類', categoryIds: ['cat-other-income'], entryType: 'income', hidden: false },
    ],
  };
}
const fail = (message, code = 'FINANCE_INVALID') => { const error = new Error(message); error.code = code; throw error; };
const requireValue = (value, message, code) => { if (!value) fail(message, code); };
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/;
const keyPattern = /^entry_[A-Za-z0-9-]{16,80}$/;
const reminderPaymentMethods = new Set(['direct', 'cash', 'convenience-store', 'bank-transfer', 'debit-card']);
const reminderOverrideFields = new Set(['name', 'amountTwd', 'dueDate', 'note', 'entryDefaults', 'billDate']);
const text = (value, max = 160) => typeof value === 'string' && value.length <= max;
const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && isValidDateOnly(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function parseWholeTwd(input, signed = false) {
  if (typeof input === 'number') return Number.isSafeInteger(input) && Math.abs(input) <= MAX_TWD && (signed || input > 0) ? input : null;
  const value = String(input ?? '').trim();
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null;
  const amount = BigInt(value);
  if (amount > BigInt(MAX_TWD) || amount < -BigInt(MAX_TWD) || (!signed && amount <= 0n)) return null;
  return Number(amount);
}
export function accountBalances(data) {
  const totals = new Map(data.accounts.map((account) => [account.id, 0n]));
  for (const event of data.accountEvents) for (const line of event.lines) totals.set(line.accountId, (totals.get(line.accountId) || 0n) + BigInt(line.deltaTwd));
  return totals;
}
export function resolveDefaultAccount(data, entryType, categoryId) {
  const categoryIdDefault = data.financePreferences[0]?.defaults.find((item) => item.entryType === entryType && item.categoryId === categoryId)?.accountId || '';
  const preferredId = getPreferredAccountId(data.financePreferences[0]?.entryPreferences, entryType);
  const isActive = (id) => data.accounts.some((item) => item.id === id && item.active);
  if (isActive(categoryIdDefault)) return categoryIdDefault;
  return isActive(preferredId) ? preferredId : '';
}
const monthKey = (date) => date.slice(0, 7);
function dueInMonth(month, anchorDay) {
  const [year, number] = month.split('-').map(Number); const date = new Date(0); date.setUTCFullYear(year, number, 0);
  return `${month}-${String(Math.min(anchorDay, date.getUTCDate())).padStart(2, '0')}`;
}
function advanceMonth(month, offset) {
  const [year, number] = month.split('-').map(Number); const index = year * 12 + number - 1 + offset;
  requireValue(index >= 12 && index <= 119999, '提醒月份超出支援範圍。');
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
}
function addMonthsToMonth(month, offset) {
  const [year, number] = month.split('-').map(Number); const index = year * 12 + number - 1 + offset;
  requireValue(index >= 12 && index <= 119999, '提醒日期超出支援範圍。');
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
}
function reminderBillDate(dueDate, schedule) {
  if (!schedule) return '';
  const month = addMonthsToMonth(monthKey(dueDate), -schedule.monthsBeforeDue);
  const scheduledDate = dueInMonth(month, schedule.day);
  return scheduledDate > dueDate ? dueDate : scheduledDate;
}
function validateReminderDefaults(data, entryType, defaults, { requireActiveAccount = false } = {}) {
  if (defaults === undefined) return;
  requireValue(defaults && typeof defaults === 'object' && !Array.isArray(defaults)
    && typeof defaults.categoryId === 'string' && typeof defaults.subcategoryId === 'string'
    && typeof defaults.accountId === 'string' && reminderPaymentMethods.has(defaults.paymentMethod), '提醒的記帳預設格式無效。');
  const hasCategory = Boolean(defaults.categoryId || defaults.subcategoryId);
  if (hasCategory) {
    const catalog = data.categoryCatalog[0];
    const category = catalog.categories.find((item) => item.id === defaults.categoryId);
    const child = catalog.subcategories.find((item) => item.id === defaults.subcategoryId);
    requireValue(category?.entryType === entryType && child?.entryType === entryType && child.categoryIds.includes(category.id), '提醒的分類與子分類關聯無效。');
  }
  if (defaults.accountId) {
    const account = data.accounts.find((item) => item.id === defaults.accountId);
    requireValue(account && (!requireActiveAccount || account.active), '提醒預設帳戶不存在或已停用。');
    if (['bank-transfer', 'debit-card'].includes(defaults.paymentMethod)) requireValue(account.type === 'bank', '銀行轉帳或簽帳金融卡必須使用銀行帳戶。');
    if (defaults.paymentMethod === 'cash') requireValue(account.type === 'cash', '現金付款方式必須使用現金帳戶。');
  }
}
export function reminderStatus(item, today) {
  if (item.status === 'completed') return '已完成';
  if (item.status === 'cancelled') return '已取消';
  if (item.dueDate < today) return '已逾期';
  if (item.dueDate === today) return '今日到期';
  const delta = (Date.parse(`${item.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
  return delta <= item.advanceDays ? '即將到期' : '尚未到期';
}
function occurrenceIdentity(rule, period) {
  return { id: `occ_${rule.id}_${period.replaceAll('-', '')}`, periodKey: `${rule.id}|${period}`, postingKey: `entry_${rule.id.slice(5)}-${period.replaceAll('-', '')}` };
}
function materialize(data, today, now) {
  const known = new Set(data.reminderOccurrences.map((item) => item.periodKey));
  const dataset = data.financePreferences[0].dataset;
  for (const rule of data.reminderRules.filter((item) => item.active)) {
    const lastMonth = advanceMonth(monthKey(today), 1);
    const periods = rule.repeat === 'once' ? [rule.firstDueDate] : [];
    if (rule.repeat === 'yearly') {
      const lastYear = Math.min(9999, Number(today.slice(0, 4)) + 1);
      for (let year = Number(rule.firstDueDate.slice(0, 4)); year <= lastYear; year += 1) {
        requireValue(periods.length < 1200, '年度提醒期次過多；未略過舊期次。'); periods.push(String(year).padStart(4, '0'));
      }
      if (!periods.length) periods.push(rule.firstDueDate.slice(0, 4));
    }
    if (rule.repeat === 'monthly') {
      for (let month = monthKey(rule.firstDueDate); month <= lastMonth; month = advanceMonth(month, 1)) {
        requireValue(periods.length < 1200, '提醒待建立期次過多，請檢查起始日期；沒有略過舊期次。'); periods.push(month);
      }
      if (!periods.length) periods.push(monthKey(rule.firstDueDate));
    }
    for (const period of periods) {
      const identity = occurrenceIdentity(rule, period);
      if (known.has(identity.periodKey)) continue;
      const dueDate = rule.repeat === 'once' ? rule.firstDueDate : dueInMonth(rule.repeat === 'yearly' ? `${period}-${rule.firstDueDate.slice(5, 7)}` : period, rule.anchorDay);
      if (dueDate < rule.firstDueDate) continue;
      const billDate = rule.repeat === 'once' ? (rule.billDate || '') : reminderBillDate(dueDate, rule.billSchedule);
      data.reminderOccurrences.push({ ...identity, ruleId: rule.id, name: rule.name, entryType: rule.entryType, amountTwd: rule.amountTwd, dueDate, note: rule.note, advanceDays: rule.advanceDays, ...(rule.entryDefaults ? { entryDefaults: structuredClone(rule.entryDefaults) } : {}), ...(billDate ? { billDate } : {}), sourceRuleRevision: rule.revision, overrides: [], status: 'pending', revision: 1, createdAt: now, dataset });
      known.add(identity.periodKey);
    }
  }
}

export function validateFinanceSnapshot(data) {
  requireValue(data && Object.keys(data).sort().join(',') === [...FINANCE_STORES].sort().join(','), '帳戶備份的資料集合不完整。');
  for (const name of FINANCE_STORES) requireValue(Array.isArray(data[name]) && data[name].length <= 50000, '帳戶或提醒資料量超過支援上限。');
  validateOfficialSnapshot({ expenses: data.expenses, incomes: data.incomes, categoryCatalog: data.categoryCatalog });
  requireValue(data.accounts.length <= 500 && data.reminderRules.length <= 1000 && data.financePreferences.length === 1, '帳戶、提醒或設定結構無效。');
  const preferences = data.financePreferences[0];
  requireValue(preferences.id === 'finance-settings' && ['acceptance', 'official'].includes(preferences.dataset) && Number.isSafeInteger(preferences.revision) && preferences.revision >= 0 && Number.isSafeInteger(preferences.generation) && preferences.generation >= 0 && Array.isArray(preferences.defaults), '帳戶偏好格式無效。');
  const entryPreferences = preferences.entryPreferences ?? createDefaultEntryPreferences();
  requireValue(entryPreferences && ['expense', 'income'].includes(entryPreferences.defaultEntryType)
    && ['today', 'last-entry'].includes(entryPreferences.dateMode)
    && typeof entryPreferences.preferredAccountId === 'string'
    && (!entryPreferences.preferredAccountId || idPattern.test(entryPreferences.preferredAccountId))
    && (entryPreferences.lastEntryDate === '' || isValidDateOnly(entryPreferences.lastEntryDate))
    && (!entryPreferences.preferredAccountId || data.accounts.some((item) => item.id === entryPreferences.preferredAccountId)), '記帳偏好格式或帳戶關聯無效。');
  if (entryPreferences.preferredAccountIds !== undefined) {
    const byType = entryPreferences.preferredAccountIds;
    requireValue(byType && Object.keys(byType).sort().join(',') === 'expense,income'
      && ['expense', 'income'].every((type) => typeof byType[type] === 'string'
        && (!byType[type] || idPattern.test(byType[type]))
        && (!byType[type] || data.accounts.some((item) => item.id === byType[type]))), '收入與支出通用預設帳戶格式或關聯無效。');
  }
  const budgetSchedules = preferences.budgetSchedules ?? [];
  const budgetOverrides = preferences.budgetOverrides ?? [];
  requireValue(Array.isArray(budgetSchedules) && Array.isArray(budgetOverrides) && budgetSchedules.length + budgetOverrides.length <= 20000, '每月預算格式或數量無效。');
  const dataset = preferences.dataset;
  const maps = {};
  for (const name of FINANCE_STORES) {
    maps[name] = new Map();
    for (const item of data[name]) { requireValue(item && typeof item.id === 'string' && idPattern.test(item.id) && !maps[name].has(item.id), '資料 ID 無效或重複。'); maps[name].set(item.id, item); }
  }
  for (const account of data.accounts) requireValue(text(account.name, 40) && account.name.trim() && ['cash', 'bank'].includes(account.type) && (account.color === undefined || accountColors.has(account.color)) && typeof account.active === 'boolean' && isValidDateOnly(account.openingDate) && Number.isSafeInteger(account.revision) && account.revision > 0 && timestamp(account.createdAt) && timestamp(account.updatedAt) && account.dataset === dataset, '帳戶格式或識別色無效。');
  const categories = new Map(data.categoryCatalog[0].categories.map((item) => [item.id, item])); const defaults = new Set();
  for (const item of preferences.defaults) {
    const identity = `${item.entryType}:${item.categoryId}`;
    requireValue(categories.get(item.categoryId)?.entryType === item.entryType && maps.accounts.has(item.accountId) && !defaults.has(identity), '分類預設帳戶關聯無效。'); defaults.add(identity);
  }
  const budgetKeys = new Set(); const budgetIds = new Set();
  for (const [rows, monthField] of [[budgetSchedules, 'effectiveFromMonth'], [budgetOverrides, 'month']]) {
    for (const item of rows) {
      const category = categories.get(item.categoryId);
      const child = item.subcategoryId ? data.categoryCatalog[0].subcategories.find((row) => row.id === item.subcategoryId) : null;
      const identity = `${monthField}:${item.categoryId}:${item.subcategoryId || '*'}:${item[monthField]}`;
      requireValue(item && typeof item.id === 'string' && idPattern.test(item.id) && !budgetIds.has(item.id)
        && category?.entryType === 'expense' && isValidBudgetMonth(item[monthField])
        && Number.isSafeInteger(item.amountTwd) && item.amountTwd >= 0 && item.amountTwd <= MAX_TWD
        && (item.subcategoryId === '' || (child?.entryType === 'expense' && child.categoryIds.includes(category.id)))
        && Number.isSafeInteger(item.revision) && item.revision > 0 && !budgetKeys.has(identity), '預算月份、金額或分類關聯無效。');
      budgetKeys.add(identity);
      budgetIds.add(item.id);
    }
  }
  const keys = new Set(); const referencedEntries = new Set(); const openings = new Map();
  const running = new Map(data.accounts.map((item) => [item.id, 0n]));
  for (const [position, event] of [...data.accountEvents].sort((a, b) => a.sequence - b.sequence).entries()) {
    requireValue(event.sequence === position + 1, '帳戶異動順序不完整或重複。');
    requireValue(['opening', 'income', 'expense', 'transfer', 'adjustment'].includes(event.type) && keyPattern.test(event.idempotencyKey) && !keys.has(event.idempotencyKey) && isValidDateOnly(event.occurredOn) && timestamp(event.createdAt) && text(event.note) && event.dataset === dataset && Array.isArray(event.lines) && Array.isArray(event.accountIds), '帳戶異動格式無效。'); keys.add(event.idempotencyKey);
    requireValue(event.lines.length === (event.type === 'transfer' ? 2 : 1) && new Set(event.lines.map((line) => line.accountId)).size === event.lines.length && stableJson(event.accountIds) === stableJson(event.lines.map((line) => line.accountId)), '帳戶異動分配不完整。');
    for (const line of event.lines) requireValue(maps.accounts.has(line.accountId) && Number.isSafeInteger(line.deltaTwd) && Math.abs(line.deltaTwd) <= MAX_TWD && event.occurredOn >= maps.accounts.get(line.accountId).openingDate, '帳戶異動金額或日期無效。');
    const sum = event.lines.reduce((total, line) => total + BigInt(line.deltaTwd), 0n);
    for (const line of event.lines) {
      requireValue(event.type === 'opening' || openings.get(line.accountId) === 1, '異動不能先於帳戶起始資金。');
      running.set(line.accountId, running.get(line.accountId) + BigInt(line.deltaTwd));
    }
    if (event.type === 'transfer') requireValue(sum === 0n && event.lines[0].deltaTwd < 0 && event.lines[1].deltaTwd > 0 && !event.entryId, '轉帳必須平衡且不能算成收支。');
    if (event.type === 'opening') { const id = event.lines[0].accountId; openings.set(id, (openings.get(id) || 0) + 1); requireValue(!event.entryId && event.occurredOn === maps.accounts.get(id).openingDate, '起始資金不得算一般收入。'); }
    if (event.type === 'adjustment') requireValue(!event.entryId && event.note.trim() && parseWholeTwd(event.targetTwd, true) !== null && running.get(event.lines[0].accountId) === BigInt(event.targetTwd), '餘額校正原因或目標不一致，且不能列為收支。');
    if (['income', 'expense'].includes(event.type)) {
      const record = maps[event.type === 'income' ? 'incomes' : 'expenses'].get(event.entryId);
      requireValue(record && !referencedEntries.has(record.id) && record.financeEventId === event.id && record.accountId === event.lines[0].accountId && record.financeDataset === dataset && record.occurredOn === event.occurredOn && record.idempotencyKey === event.idempotencyKey && record.amountMinor % 100 === 0 && sum === BigInt(record.amountMinor / 100) * (event.type === 'income' ? 1n : -1n), '帳戶異動與來源收支不一致。'); referencedEntries.add(record.id);
      requireValue(reminderPaymentMethods.has(event.paymentMethod) && (!['bank-transfer', 'debit-card'].includes(event.paymentMethod) || maps.accounts.get(record.accountId).type === 'bank') && (event.paymentMethod !== 'cash' || maps.accounts.get(record.accountId).type === 'cash'), '付款方式與帳戶類型不相符。');
    }
  }
  for (const account of data.accounts) requireValue(openings.get(account.id) === 1, '帳戶必須恰有一筆起始資金異動。');
  for (const record of [...data.expenses, ...data.incomes]) if (record.accountId !== undefined || record.financeEventId !== undefined) requireValue(referencedEntries.has(record.id), '收支缺少對應帳戶異動。');
  for (const rule of data.reminderRules) {
    requireValue(rule.id.startsWith('rule_') && text(rule.name, 60) && rule.name.trim() && ['income', 'expense'].includes(rule.entryType) && parseWholeTwd(rule.amountTwd) !== null && isValidDateOnly(rule.firstDueDate) && ['once', 'monthly', 'yearly'].includes(rule.repeat) && rule.anchorDay === Number(rule.firstDueDate.slice(8)) && Number.isInteger(rule.advanceDays) && rule.advanceDays >= 0 && rule.advanceDays <= 365 && text(rule.note) && typeof rule.active === 'boolean' && Number.isSafeInteger(rule.revision) && rule.revision > 0 && timestamp(rule.createdAt) && rule.dataset === dataset, '提醒規則格式無效。');
    validateReminderDefaults(data, rule.entryType, rule.entryDefaults);
    if (rule.billDate !== undefined) requireValue(rule.repeat === 'once' && isValidDateOnly(rule.billDate) && rule.billDate <= rule.firstDueDate, '單次帳單日期必須有效且不能晚於付款日。');
    if (rule.billSchedule !== undefined) requireValue(rule.repeat !== 'once' && rule.billSchedule && Number.isInteger(rule.billSchedule.monthsBeforeDue) && rule.billSchedule.monthsBeforeDue >= 0 && rule.billSchedule.monthsBeforeDue <= 12 && Number.isInteger(rule.billSchedule.day) && rule.billSchedule.day >= 1 && rule.billSchedule.day <= 31, '定期帳單日期設定無效。');
  }
  const periods = new Set(); const posted = new Set();
  for (const occurrence of data.reminderOccurrences) {
    const rule = maps.reminderRules.get(occurrence.ruleId);
    requireValue(rule && text(occurrence.name, 60) && occurrence.name.trim() && occurrence.entryType === rule.entryType && parseWholeTwd(occurrence.amountTwd) !== null && isValidDateOnly(occurrence.dueDate) && text(occurrence.note) && Number.isInteger(occurrence.advanceDays) && occurrence.advanceDays >= 0 && occurrence.advanceDays <= 365 && ['pending', 'completed', 'cancelled'].includes(occurrence.status) && Number.isSafeInteger(occurrence.revision) && occurrence.revision > 0 && timestamp(occurrence.createdAt) && occurrence.dataset === dataset && typeof occurrence.periodKey === 'string' && occurrence.periodKey.startsWith(`${rule.id}|`) && !periods.has(occurrence.periodKey) && keyPattern.test(occurrence.postingKey) && !posted.has(occurrence.postingKey), '提醒期次無效或重複。');
    const period = occurrence.periodKey.slice(rule.id.length + 1);
    const expected = occurrenceIdentity(rule, period);
    requireValue((rule.repeat === 'once' ? period === rule.firstDueDate : rule.repeat === 'yearly' ? /^\d{4}$/.test(period) && Number(period) >= Number(rule.firstDueDate.slice(0, 4)) && Number(period) <= 9999 : /^\d{4}-\d\d$/.test(period) && isValidDateOnly(`${period}-01`) && period >= monthKey(rule.firstDueDate)) && occurrence.id === expected.id && occurrence.postingKey === expected.postingKey, '提醒期次識別或入帳鍵不一致。');
    periods.add(occurrence.periodKey); posted.add(occurrence.postingKey);
    if (occurrence.entryDefaults !== undefined) validateReminderDefaults(data, occurrence.entryType, occurrence.entryDefaults);
    if (occurrence.billDate !== undefined) requireValue(isValidDateOnly(occurrence.billDate) && occurrence.billDate <= occurrence.dueDate, '期次帳單日期無效。');
    if (occurrence.sourceRuleRevision !== undefined) requireValue(Number.isSafeInteger(occurrence.sourceRuleRevision) && occurrence.sourceRuleRevision > 0, '期次來源規則版本無效。');
    if (occurrence.overrides !== undefined) requireValue(Array.isArray(occurrence.overrides) && new Set(occurrence.overrides).size === occurrence.overrides.length && occurrence.overrides.every((field) => reminderOverrideFields.has(field)), '期次個別修改標記無效。');
    if (occurrence.status === 'completed') {
      const record = maps[occurrence.entryType === 'income' ? 'incomes' : 'expenses'].get(occurrence.entryId);
      requireValue(record && record.reminderOccurrenceId === occurrence.id && (occurrence.completionMode === 'linked' || record.idempotencyKey === occurrence.postingKey) && ['created', 'linked'].includes(occurrence.completionMode || 'created'), '已完成提醒缺少來源收支。');
    } else requireValue(!occurrence.entryId, '未入帳提醒不可連結正式收支。');
  }
  for (const record of [...data.expenses, ...data.incomes]) if (record.reminderOccurrenceId !== undefined) {
    const linked = maps.reminderOccurrences.get(record.reminderOccurrenceId);
    requireValue(linked?.status === 'completed' && linked.entryId === record.id && (linked.completionMode === 'linked' || linked.postingKey === record.idempotencyKey), '收支的提醒來源不一致。');
  }
  stableJson(data);
  return { ...validateOfficialSnapshot({ expenses: data.expenses, incomes: data.incomes, categoryCatalog: data.categoryCatalog }), accounts: data.accounts.length, accountEvents: data.accountEvents.length, reminderRules: data.reminderRules.length, reminderOccurrences: data.reminderOccurrences.length, budgetSchedules: budgetSchedules.length, budgetOverrides: budgetOverrides.length, dataset };
}

function containsAccountReference(value, accountId) {
  if (Array.isArray(value)) return value.some((item) => containsAccountReference(item, accountId));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([field, item]) => (['accountId', 'preferredAccountId'].includes(field) && item === accountId)
    || (field === 'preferredAccountIds' && item && Object.values(item).includes(accountId))
    || (field === 'accountIds' && Array.isArray(item) && item.includes(accountId))
    || containsAccountReference(item, accountId));
}

export function accountDeletionBlockReason(data, accountId) {
  const account = data.accounts.find((item) => item.id === accountId);
  if (!account) return '找不到這個帳戶，請重新讀取。';
  const events = data.accountEvents.filter((event) => event.lines.some((line) => line.accountId === accountId));
  const opening = events.length === 1 ? events[0] : null;
  if (events.length !== 1 || !opening || opening.type !== 'opening' || opening.lines.length !== 1) return '此帳戶已有轉帳、收支或其他帳戶異動紀錄，不能永久刪除；可以停用帳戶。';
  const otherCollections = FINANCE_STORES.filter((name) => !['accounts', 'accountEvents'].includes(name));
  if (otherCollections.some((name) => data[name].some((item) => containsAccountReference(item, accountId)))) {
    return '此帳戶已被收入、支出、提醒或預設設定引用，不能永久刪除；可以停用帳戶。';
  }
  return '';
}

function entryStoreName(entryType) {
  return entryType === 'income' ? 'incomes' : 'expenses';
}

function findEntry(data, entryType, id) {
  return data[entryStoreName(entryType)].find((item) => item.id === id);
}

function editRevisionOf(record) { return Number.isSafeInteger(record?.editRevision) ? record.editRevision : 0; }

function entryReferences(data, entryId, allowedEventId = '', allowedOccurrenceId = '') {
  const referenceFields = new Set(['entryId', 'recordId', 'sourceEntryId', 'sourceRecordId', 'originalEntryId', 'refundOfEntryId', 'relatedEntryId', 'transactionId', 'sourceTransactionId', 'originalTransactionId', 'refundOfRecordId', 'originalExpenseId', 'originalIncomeId', 'refundOf', 'eventId', 'financeEventId', 'sourceEventId', 'accountEventId', 'sourceAccountEventId', 'movementId', 'sourceMovementId']);
  const targets = new Set([entryId, allowedEventId].filter(Boolean));
  const references = (value) => {
    if (Array.isArray(value)) return value.some(references);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([field, child]) => (referenceFields.has(field) && targets.has(child)) || references(child));
  };
  for (const name of FINANCE_STORES) {
    for (const row of data[name]) {
      if ((name === 'expenses' || name === 'incomes') && row.id === entryId) continue;
      if (name === 'accountEvents' && row.id === allowedEventId) continue;
      if (name === 'reminderOccurrences' && row.id === allowedOccurrenceId) continue;
      if (references(row)) return true;
    }
  }
  return false;
}

function hasUnsupportedEntryBreakdown(record, event) {
  if (event && Array.isArray(event.lines) && event.lines.length > 1) return true;
  return ['items', 'lineItems', 'paymentSplits', 'accountAllocations', 'payments']
    .some((field) => Array.isArray(record?.[field]) && record[field].length > 0);
}

// Account events are ordered by creation, while adjustment events record a
// real-world balance checkpoint. Reflowing preserves each checkpoint after
// an older entry changes or is removed, and keeps every other event intact.
function reflowAccountEvents(data, now) {
  const running = new Map(data.accounts.map((item) => [item.id, 0n]));
  const ordered = [...data.accountEvents].sort((left, right) => left.sequence - right.sequence);
  ordered.forEach((event, index) => {
    event.sequence = index + 1;
    if (event.type === 'adjustment') {
      const accountId = event.lines[0]?.accountId;
      const target = parseWholeTwd(event.targetTwd, true);
      requireValue(target !== null && running.has(accountId), '帳戶校正事件不完整，拒絕修改交易。');
      const delta = BigInt(target) - running.get(accountId);
      requireValue(delta <= BigInt(MAX_TWD) && delta >= -BigInt(MAX_TWD), '交易變更會使後續餘額校正超出範圍；已拒絕保存。');
      if (event.lines[0].deltaTwd !== Number(delta)) {
        event.lines[0].deltaTwd = Number(delta);
        event.modifiedAt = now;
      }
    }
    for (const line of event.lines) {
      requireValue(running.has(line.accountId), '帳戶異動引用不存在的帳戶。');
      running.set(line.accountId, running.get(line.accountId) + BigInt(line.deltaTwd));
    }
  });
  data.accountEvents = ordered;
}

function validateEditableSelection(data, entryType, fields, { allowSameInactiveAccount = false, priorRecord = null } = {}) {
  requireValue(isValidDateOnly(fields.date) && text(fields.note, 160), '請檢查有效日期及 160 字內備註。');
  requireValue(reminderPaymentMethods.has(fields.paymentMethod || 'direct'), '付款／收款方式無效。');
  const amountMinor = fields.amountMinor;
  requireValue(Number.isSafeInteger(amountMinor) && amountMinor > 0, '金額必須大於 0，且保留到分的精度。');
  const catalog = data.categoryCatalog[0];
  const store = createCategoryStore({ catalog });
  const category = store.getCategory(fields.categoryId);
  const subcategory = store.getSubcategory(fields.subcategoryId);
  requireValue(store.isCategorySelectable(fields.categoryId) && category?.entryType === entryType
    && store.isSubcategorySelectable(fields.categoryId, fields.subcategoryId)
    && subcategory?.entryType === entryType, '請選擇仍有效且互相關聯的大分類與子分類。');
  let account = null;
  if (fields.accountId) {
    account = data.accounts.find((item) => item.id === fields.accountId);
    requireValue(account && (account.active || (allowSameInactiveAccount && priorRecord?.accountId === account.id)), '請選擇可使用的帳戶；停用帳戶不能新增為交易帳戶。');
    requireValue(fields.date >= account.openingDate, '交易日期不可早於帳戶起始日。');
    requireValue(amountMinor % 100 === 0, '已有帳戶異動的交易金額須為整數元；舊紀錄原有分金額可保留，但不能轉成帳戶異動。');
    const method = fields.paymentMethod || 'direct';
    requireValue(reminderPaymentMethods.has(method), '付款／收款方式無效。');
    if (['bank-transfer', 'debit-card'].includes(method)) requireValue(account.type === 'bank', '銀行轉帳或簽帳金融卡需使用銀行帳戶。');
    if (method === 'cash') requireValue(account.type === 'cash', '現金方式需使用現金帳戶。');
  }
  return { amountMinor, category, subcategory, account };
}

function setRecordFields(record, fields, selected, now) {
  Object.assign(record, {
    amountMinor: selected.amountMinor,
    occurredOn: fields.date,
    note: String(fields.note || '').trim(),
    categoryId: selected.category.id,
    categoryNameSnapshot: selected.category.name,
    subcategoryId: selected.subcategory.id,
    subcategoryNameSnapshot: selected.subcategory.name,
    editRevision: editRevisionOf(record) + 1,
    modifiedAt: now,
  });
}

function setEntryMovement(data, record, entryType, fields, selected, now, originalEvent = null) {
  if (!selected.account) {
    if (originalEvent) data.accountEvents = data.accountEvents.filter((item) => item.id !== originalEvent.id);
    for (const name of ['accountId', 'financeEventId', 'financeDataset']) delete record[name];
    return;
  }
  const amountTwd = selected.amountMinor / 100;
  const method = fields.paymentMethod || originalEvent?.paymentMethod || (selected.account.type === 'cash' ? 'cash' : 'direct');
  requireValue(reminderPaymentMethods.has(method), '付款／收款方式無效。');
  if (['bank-transfer', 'debit-card'].includes(method)) requireValue(selected.account.type === 'bank', '銀行轉帳或簽帳金融卡需使用銀行帳戶。');
  if (method === 'cash') requireValue(selected.account.type === 'cash', '現金方式需使用現金帳戶。');
  const lines = [{ accountId: selected.account.id, deltaTwd: entryType === 'expense' ? -amountTwd : amountTwd }];
  if (originalEvent) {
    Object.assign(originalEvent, { occurredOn: fields.date, note: String(fields.note || '').trim(), lines, accountIds: [selected.account.id], paymentMethod: method, modifiedAt: now });
    Object.assign(record, { accountId: selected.account.id, financeEventId: originalEvent.id, financeDataset: originalEvent.dataset });
    return;
  }
  const key = record.idempotencyKey;
  requireValue(!data.accountEvents.some((item) => item.idempotencyKey === key || item.id === `evt_${key.slice(6)}`), '此交易識別碼已有帳戶異動，請重新載入後再試。', 'FINANCE_CONFLICT');
  const created = { id: `evt_${key.slice(6)}`, sequence: data.accountEvents.length + 1, idempotencyKey: key, type: entryType, occurredOn: fields.date, createdAt: now, note: String(fields.note || '').trim(), lines, accountIds: [selected.account.id], dataset: data.financePreferences[0].dataset, paymentMethod: method, entryId: record.id };
  data.accountEvents.push(created);
  Object.assign(record, { accountId: selected.account.id, financeEventId: created.id, financeDataset: created.dataset });
}

export function applyFinanceCommand(input, command, { today, now = new Date().toISOString(), dataset = 'acceptance' } = {}) {
  validateFinanceSnapshot(input); requireValue(isValidDateOnly(today) && timestamp(now), '操作日期無效。');
  const data = structuredClone(input); const preferences = data.financePreferences[0];
  requireValue(preferences.dataset === dataset, '不允許混用合成與正式資料。');
  let key = command.idempotencyKey; let occurrence;
  if (command.kind === 'record' && command.reminderOccurrenceId) {
    occurrence = data.reminderOccurrences.find((item) => item.id === command.reminderOccurrenceId);
    requireValue(occurrence, '找不到提醒期次。'); key = occurrence.postingKey;
  }
  const existing = key && data.accountEvents.find((item) => item.idempotencyKey === key);
  if (existing) return { data: input, status: 'duplicate', eventId: existing.id, warnings: [] };
  const account = (id, date) => { const item = data.accounts.find((entry) => entry.id === id); requireValue(item?.active, '請選擇可使用的帳戶。'); if (date) requireValue(isValidDateOnly(date) && date >= item.openingDate, '交易日期不可早於帳戶起始日；舊紀錄保持未指定帳戶。'); return item; };
  const event = (type, lines, extras = {}) => {
    requireValue(keyPattern.test(key), '操作識別碼無效。');
    const item = { id: `evt_${key.slice(6)}`, sequence: data.accountEvents.length + 1, idempotencyKey: key, type, occurredOn: command.date || today, createdAt: now, note: String(command.note || '').trim(), lines, accountIds: lines.map((line) => line.accountId), dataset, ...extras };
    data.accountEvents.push(item); return item;
  };
  let eventId = '';
  if (command.kind === 'save-category-catalog') {
    const current = data.categoryCatalog[0];
    const next = structuredClone(command.catalog);
    requireValue(current && current.revision === command.expectedRevision, '分類已在其他分頁更新，請重新載入後再保存。', 'FINANCE_CONFLICT');
    requireValue(isValidCategoryCatalog(next) && next.id === current.id && next.revision === current.revision + 1, '分類目錄版本或內容無效。');
    const oldCategories = new Set(current.categories.map((item) => item.id));
    const oldSubcategories = new Map(current.subcategories.map((item) => [item.id, item]));
    const nextCategories = new Set(next.categories.map((item) => item.id));
    const nextSubcategories = new Map(next.subcategories.map((item) => [item.id, item]));
    for (const record of [...data.expenses, ...data.incomes]) {
      if (oldCategories.has(record.categoryId)) requireValue(nextCategories.has(record.categoryId), '此大分類已有歷史交易引用，不能移除。');
      const oldChild = oldSubcategories.get(record.subcategoryId);
      if (oldChild?.categoryIds.includes(record.categoryId)) requireValue(nextSubcategories.get(record.subcategoryId)?.categoryIds.includes(record.categoryId), '此子分類關聯已有歷史交易引用，不能移除。');
    }
    for (const item of preferences.defaults) requireValue(nextCategories.has(item.categoryId), '請先移除已刪除分類的預設帳戶關聯。');
    for (const reminder of [...data.reminderRules, ...data.reminderOccurrences]) {
      const defaults = reminder.entryDefaults;
      if (!defaults?.categoryId) continue;
      requireValue(nextCategories.has(defaults.categoryId), '定期收支的預設仍使用此大分類，請先修改定期項目。');
      requireValue(nextSubcategories.get(defaults.subcategoryId)?.categoryIds.includes(defaults.categoryId), '定期收支的預設仍使用此子分類關聯，請先修改定期項目。');
    }
    for (const item of [...(preferences.budgetSchedules || []), ...(preferences.budgetOverrides || [])]) {
      requireValue(nextCategories.has(item.categoryId), '請先處理使用中預算所引用的分類。');
      if (item.subcategoryId) requireValue(nextSubcategories.get(item.subcategoryId)?.categoryIds.includes(item.categoryId), '請先處理預算所引用的子分類關聯。');
    }
    data.categoryCatalog = [next];
    validateFinanceSnapshot(data);
  } else if (command.kind === 'set-entry-preferences') {
    requireValue(preferences.revision === command.expectedRevision, '記帳偏好已在另一個分頁修改，請重新讀取。', 'FINANCE_CONFLICT');
    const next = {
      defaultEntryType: command.defaultEntryType,
      dateMode: command.dateMode,
      preferredAccountId: command.preferredAccountId || '',
      ...(command.preferredAccountIds !== undefined
        ? { preferredAccountIds: { expense: command.preferredAccountIds?.expense || '', income: command.preferredAccountIds?.income || '' }, preferredAccountId: '' }
        : preferences.entryPreferences?.preferredAccountIds && !command.preferredAccountId
          ? { preferredAccountIds: structuredClone(preferences.entryPreferences.preferredAccountIds) }
          : { preferredAccountIds: { expense: command.preferredAccountId || '', income: command.preferredAccountId || '' } }),
      lastEntryDate: preferences.entryPreferences?.lastEntryDate || '',
    };
    requireValue(['expense', 'income'].includes(next.defaultEntryType) && ['today', 'last-entry'].includes(next.dateMode)
      && (!next.preferredAccountId || data.accounts.some((item) => item.id === next.preferredAccountId))
      && (!next.preferredAccountIds || ['expense', 'income'].every((type) => !next.preferredAccountIds[type] || data.accounts.some((item) => item.id === next.preferredAccountIds[type]))), '請選擇有效的預設收支類型、日期方式及帳戶。');
    preferences.entryPreferences = next;
    preferences.revision += 1;
  } else if (command.kind === 'create-account') {
    const opening = parseWholeTwd(command.openingTwd, true);
    const color = command.color || (command.type === 'bank' ? '#718AA5' : '#C39451');
    requireValue(keyPattern.test(key) && opening !== null && text(command.name, 40) && command.name.trim() && ['cash', 'bank'].includes(command.type) && accountColors.has(color) && isValidDateOnly(command.date), '請填寫帳戶名稱、類型、有效識別色、起始日期與整數元餘額。');
    const id = `acct_${key.slice(6)}`;
    requireValue(!data.accounts.some((item) => item.id === id), '帳戶 ID 已存在。');
    data.accounts.push({ id, name: command.name.trim(), type: command.type, color, active: true, openingDate: command.date, revision: 1, createdAt: now, updatedAt: now, dataset });
    eventId = event('opening', [{ accountId: id, deltaTwd: opening }]).id;
  } else if (command.kind === 'edit-account') {
    const item = data.accounts.find((entry) => entry.id === command.accountId);
    requireValue(item && item.revision === command.expectedRevision, '帳戶已被另一個操作修改，請重新讀取。', 'FINANCE_CONFLICT');
    requireValue(text(command.name, 40) && command.name.trim() && typeof command.active === 'boolean' && (command.color === undefined || accountColors.has(command.color)), '帳戶名稱、狀態或識別色無效。');
    // Account type and opening history stay stable; balance changes use adjustment events.
    Object.assign(item, { name: command.name.trim(), active: command.active, ...(command.color === undefined ? {} : { color: command.color }), revision: item.revision + 1, updatedAt: now });
  } else if (command.kind === 'delete-account') {
    const item = data.accounts.find((entry) => entry.id === command.accountId);
    requireValue(item && item.revision === command.expectedRevision && command.confirmed === true, '帳戶狀態已改變或尚未確認，請重新讀取後再操作。', 'FINANCE_CONFLICT');
    const reason = accountDeletionBlockReason(data, item.id);
    requireValue(!reason, reason || '此帳戶目前不能永久刪除。');
    const openingEvent = data.accountEvents.find((entry) => entry.lines.some((line) => line.accountId === item.id));
    data.accounts = data.accounts.filter((entry) => entry.id !== item.id);
    data.accountEvents = data.accountEvents
      .filter((entry) => entry.id !== openingEvent.id)
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry, index) => entry.sequence === index + 1 ? entry : { ...entry, sequence: index + 1 });
  } else if (command.kind === 'set-default') {
    requireValue(preferences.revision === command.expectedRevision, '預設帳戶已被修改，請重新讀取。', 'FINANCE_CONFLICT');
    const category = data.categoryCatalog[0].categories.find((item) => item.id === command.categoryId);
    requireValue(category && category.entryType === command.entryType, '分類不存在。');
    if (command.accountId) account(command.accountId);
    preferences.defaults = preferences.defaults.filter((item) => !(item.categoryId === category.id && item.entryType === category.entryType));
    if (command.accountId) preferences.defaults.push({ categoryId: category.id, entryType: category.entryType, accountId: command.accountId });
    preferences.revision += 1;
  } else if (command.kind === 'set-defaults') {
    requireValue(preferences.revision === command.expectedRevision, '分類預設帳戶已被修改，請重新讀取。', 'FINANCE_CONFLICT');
    requireValue(Array.isArray(command.updates) && command.updates.length > 0, '沒有尚未保存的分類預設變更。');
    const seen = new Set();
    for (const update of command.updates) {
      const key = `${update?.entryType}:${update?.categoryId}`;
      requireValue(update && !seen.has(key), '同一分類不可重複提交。');
      seen.add(key);
      const category = data.categoryCatalog[0].categories.find((item) => item.id === update.categoryId);
      requireValue(category && !category.hidden && category.entryType === update.entryType, '分類已不存在、隱藏或收支類型不符，請重新讀取。');
      if (update.accountId) account(update.accountId);
    }
    for (const update of command.updates) {
      preferences.defaults = preferences.defaults.filter((item) => !(item.categoryId === update.categoryId && item.entryType === update.entryType));
      if (update.accountId) preferences.defaults.push({ categoryId: update.categoryId, entryType: update.entryType, accountId: update.accountId });
    }
    preferences.revision += 1;
  } else if (command.kind === 'set-budget') {
    requireValue(preferences.revision === command.expectedRevision, '預算設定已被修改，請重新讀取。', 'FINANCE_CONFLICT');
    const category = data.categoryCatalog[0].categories.find((item) => item.id === command.categoryId);
    const child = command.subcategoryId ? data.categoryCatalog[0].subcategories.find((item) => item.id === command.subcategoryId) : null;
    requireValue(category?.entryType === 'expense' && !category.hidden
      && (!command.subcategoryId || (child?.entryType === 'expense' && !child.hidden && child.categoryIds.includes(category.id))), '請選擇有效的支出大分類及其子分類。');
    requireValue(parseWholeTwd(command.amountTwd, true) !== null && Number(command.amountTwd) >= 0, '預算金額必須是 0 或正整數元。');
    setMonthlyBudget(preferences, command);
    preferences.revision += 1;
  } else if (command.kind === 'delete-budget') {
    requireValue(preferences.revision === command.expectedRevision, '預算設定已被修改，請重新讀取。', 'FINANCE_CONFLICT');
    requireValue(command.confirmed === true, '刪除預算前必須確認。');
    const schedule = preferences.budgetSchedules || []; const overrides = preferences.budgetOverrides || [];
    requireValue([...schedule, ...overrides].some((item) => item.id === command.budgetId), '這項預算已不存在，請重新讀取。', 'FINANCE_CONFLICT');
    preferences.budgetSchedules = schedule.filter((item) => item.id !== command.budgetId);
    preferences.budgetOverrides = overrides.filter((item) => item.id !== command.budgetId);
    preferences.revision += 1;
  } else if (command.kind === 'record') {
    const amount = parseWholeTwd(command.amountTwd); requireValue(amount !== null && ['expense', 'income'].includes(command.entryType), '帳戶連動僅接受大於 0 的整數元金額。');
    const item = account(command.accountId, command.date); const store = createCategoryStore({ catalog: data.categoryCatalog[0] });
    if (occurrence) {
      requireValue(occurrence.status === 'pending' && occurrence.revision === command.expectedOccurrenceRevision && occurrence.entryType === command.entryType, '提醒期次已完成、取消或更新，請重新讀取。', 'FINANCE_CONFLICT');
    }
    const method = command.paymentMethod || (item.type === 'cash' ? 'cash' : 'direct');
    requireValue(reminderPaymentMethods.has(method), '請選擇有效的付款方式。');
    if (['bank-transfer', 'debit-card'].includes(method)) requireValue(item.type === 'bank', '銀行轉帳或簽帳金融卡請選擇銀行帳戶。');
    if (method === 'cash') requireValue(item.type === 'cash', '現金付款方式請選擇現金帳戶。');
    requireValue(store.isCategorySelectable(command.categoryId) && store.isSubcategorySelectable(command.categoryId, command.subcategoryId), '請重新選擇目前有效的大分類與子分類。');
    const draft = { type: command.entryType, amount: String(amount), date: command.date, note: command.note || '', idempotencyKey: key };
    const builder = command.entryType === 'expense' ? createExpenseRecord : createIncomeRecord;
    const record = builder({ draft, category: store.getCategory(command.categoryId), subcategory: store.getSubcategory(command.subcategoryId), now: new Date(now), cryptoProvider: { randomUUID: () => key.slice(6) } });
    const movement = event(command.entryType, [{ accountId: item.id, deltaTwd: command.entryType === 'expense' ? -amount : amount }], { entryId: record.id, paymentMethod: method });
    Object.assign(record, { accountId: item.id, financeEventId: movement.id, financeDataset: dataset });
    preferences.entryPreferences = { ...(preferences.entryPreferences || createDefaultEntryPreferences()), lastEntryDate: command.date };
    preferences.revision += 1;
    if (occurrence) { record.reminderOccurrenceId = occurrence.id; Object.assign(occurrence, { status: 'completed', completionMode: 'created', entryId: record.id, revision: occurrence.revision + 1 }); }
    data[command.entryType === 'expense' ? 'expenses' : 'incomes'].push(record); eventId = movement.id;
  } else if (command.kind === 'edit-entry') {
    requireValue(['expense', 'income'].includes(command.entryType), '收支類型無效；不可將收入轉成支出或反向轉換。');
    const record = findEntry(data, command.entryType, command.entryId);
    requireValue(record && record.recordType === command.entryType && command.expectedEditRevision === editRevisionOf(record), '這筆紀錄已在其他分頁修改，請重新載入後再編輯。', 'FINANCE_CONFLICT');
    const amountMinor = command.amountMinor;
    requireValue(Number.isSafeInteger(amountMinor) && amountMinor > 0, '金額必須大於 0。');
    if (amountMinor !== record.amountMinor) requireValue(amountMinor % 100 === 0, '修改後的新金額請使用整數元；原有分金額可維持原值。');
    const selected = validateEditableSelection(data, command.entryType, { ...command, amountMinor }, { allowSameInactiveAccount: true, priorRecord: record });
    const sourceEvent = record.financeEventId ? data.accountEvents.find((item) => item.id === record.financeEventId) : null;
    requireValue(!record.financeEventId || (sourceEvent && sourceEvent.entryId === record.id && sourceEvent.type === command.entryType), '原交易帳戶異動不完整；為保護餘額，本次修改已拒絕。');
    requireValue(!hasUnsupportedEntryBreakdown(record, sourceEvent), '這筆紀錄包含多筆付款或商品明細，目前的單筆編輯表單無法安全改動；原紀錄保持不變。');
    let linkedOccurrence = null;
    if (record.reminderOccurrenceId) {
      linkedOccurrence = data.reminderOccurrences.find((item) => item.id === record.reminderOccurrenceId);
      requireValue(linkedOccurrence?.status === 'completed' && linkedOccurrence.entryId === record.id
        && linkedOccurrence.revision === command.expectedOccurrenceRevision, '這筆紀錄已連結提醒且狀態已變更，請重新載入。', 'FINANCE_CONFLICT');
      requireValue(amountMinor % 100 === 0, '已連結提醒的交易必須維持整數元金額。');
    }
    const priorMinor = record.amountMinor;
    setRecordFields(record, command, selected, now);
    setEntryMovement(data, record, command.entryType, command, selected, now, sourceEvent);
    if (linkedOccurrence && priorMinor !== amountMinor) Object.assign(linkedOccurrence, { amountTwd: amountMinor / 100, revision: linkedOccurrence.revision + 1 });
    reflowAccountEvents(data, now);
  } else if (command.kind === 'split-entry') {
    requireValue(['expense', 'income'].includes(command.entryType), '收支類型無效；拆分不能改變收入／支出類型。');
    const storeName = entryStoreName(command.entryType);
    const records = data[storeName];
    const sourceIndex = records.findIndex((item) => item.id === command.entryId);
    const source = records[sourceIndex];
    requireValue(source && source.recordType === command.entryType && command.expectedEditRevision === editRevisionOf(source), '這筆紀錄已在其他分頁修改，請重新載入後再拆分。', 'FINANCE_CONFLICT');
    requireValue(source.amountMinor % 100 === 0, '這筆舊紀錄含有分金額；為避免精度損失，目前不能拆分。原紀錄保持不變。');
    const sourceEvent = source.financeEventId ? data.accountEvents.find((item) => item.id === source.financeEventId) : null;
    requireValue(!source.financeEventId || (sourceEvent && sourceEvent.entryId === source.id && sourceEvent.type === command.entryType), '原交易帳戶異動不完整；為保護餘額，本次拆分已拒絕。');
    requireValue(!hasUnsupportedEntryBreakdown(source, sourceEvent), '這筆紀錄包含多筆付款或商品明細，目前不能用單筆拆分表單處理；原紀錄保持不變。');
    requireValue(!source.reminderOccurrenceId && !entryReferences(data, source.id, sourceEvent?.id || ''), '這筆紀錄已被提醒或其他資料引用，不能安全拆分。');
    requireValue(Array.isArray(command.splits) && command.splits.length >= 2 && command.splits.length <= 20, '拆分至少需要兩筆，最多 20 筆。');
    const usedKeys = new Set([...data.expenses, ...data.incomes].map((item) => item.idempotencyKey));
    for (const eventRow of data.accountEvents) if (eventRow.id !== sourceEvent?.id) usedKeys.add(eventRow.idempotencyKey);
    const catalogStore = createCategoryStore({ catalog: data.categoryCatalog[0] });
    const planned = command.splits.map((line, index) => {
      const splitKey = index === 0 ? source.idempotencyKey : line.idempotencyKey;
      requireValue(keyPattern.test(splitKey) && (!usedKeys.has(splitKey) || (index === 0 && splitKey === source.idempotencyKey)), '拆分紀錄識別碼重複或無效；請重新操作。');
      if (index > 0) usedKeys.add(splitKey);
      const amount = parseWholeTwd(line.amountTwd);
      requireValue(amount !== null, '每筆拆分金額都必須是大於 0 的整數元。');
      const fields = { date: line.date, amountMinor: amount * 100, note: line.note || '', categoryId: line.categoryId, subcategoryId: line.subcategoryId, accountId: line.accountId || '', paymentMethod: line.paymentMethod || 'direct' };
      const selected = validateEditableSelection(data, command.entryType, fields, { allowSameInactiveAccount: index === 0, priorRecord: source });
      const draft = { type: command.entryType, amount: String(amount), date: fields.date, note: fields.note, idempotencyKey: splitKey };
      const builder = command.entryType === 'expense' ? createExpenseRecord : createIncomeRecord;
      const built = builder({ draft, category: selected.category, subcategory: selected.subcategory, now: new Date(now), cryptoProvider: { randomUUID: () => splitKey.slice(6) } });
      const record = index === 0
        ? { ...source, ...built, id: source.id, idempotencyKey: source.idempotencyKey, createdAt: source.createdAt, editRevision: editRevisionOf(source) + 1, modifiedAt: now }
        : { ...built, editRevision: 0 };
      setEntryMovement(data, record, command.entryType, fields, selected, now, index === 0 ? sourceEvent : null);
      return record;
    });
    records.splice(sourceIndex, 1, ...planned);
    reflowAccountEvents(data, now);
  } else if (command.kind === 'delete-entry') {
    requireValue(['expense', 'income'].includes(command.entryType) && command.confirmed === true, '刪除交易前必須明確確認。');
    const storeName = entryStoreName(command.entryType);
    const index = data[storeName].findIndex((item) => item.id === command.entryId);
    const record = data[storeName][index];
    requireValue(record && command.expectedEditRevision === editRevisionOf(record), '這筆紀錄已變更，請重新載入後再刪除。', 'FINANCE_CONFLICT');
    const eventRow = record.financeEventId ? data.accountEvents.find((item) => item.id === record.financeEventId) : null;
    requireValue(!record.financeEventId || (eventRow && eventRow.entryId === record.id && eventRow.type === command.entryType), '原交易帳戶異動不完整；為保護餘額，本次刪除已拒絕。');
    requireValue(!entryReferences(data, record.id, eventRow?.id || ''), '這筆紀錄已被提醒、退款或其他資料引用，不能刪除，以免破壞關聯。');
    data[storeName].splice(index, 1);
    if (eventRow) data.accountEvents = data.accountEvents.filter((item) => item.id !== eventRow.id);
    reflowAccountEvents(data, now);
  } else if (command.kind === 'transfer') {
    const amount = parseWholeTwd(command.amountTwd); requireValue(amount !== null && command.fromAccountId !== command.toAccountId, '轉帳需選不同帳戶及正整數元金額。');
    account(command.fromAccountId, command.date); account(command.toAccountId, command.date);
    eventId = event('transfer', [{ accountId: command.fromAccountId, deltaTwd: -amount }, { accountId: command.toAccountId, deltaTwd: amount }]).id;
  } else if (command.kind === 'adjustment') {
    const item = account(command.accountId, command.date); const target = parseWholeTwd(command.targetTwd, true); const current = accountBalances(data).get(item.id);
    requireValue(target !== null && String(current) === String(command.expectedBalanceTwd), '帳戶餘額已變更或目標金額無效，請重新讀取再校正。', 'FINANCE_CONFLICT');
    const delta = BigInt(target) - current;
    requireValue(delta <= BigInt(MAX_TWD) && delta >= -BigInt(MAX_TWD) && text(command.note) && command.note.trim(), '校正需填原因，且差額不能超出支援範圍。');
    eventId = event('adjustment', [{ accountId: item.id, deltaTwd: Number(delta) }], { targetTwd: target }).id;
  } else if (command.kind === 'create-reminder') {
    requireValue(keyPattern.test(key) && text(command.name, 60) && command.name.trim() && ['expense', 'income'].includes(command.entryType) && parseWholeTwd(command.amountTwd) !== null && isValidDateOnly(command.date) && ['once', 'monthly', 'yearly'].includes(command.repeat) && Number.isInteger(command.advanceDays) && command.advanceDays >= 0 && command.advanceDays <= 365 && text(command.note || ''), '請填寫完整提醒，金額為整數元、提前天數為 0–365。');
    const id = `rule_${key.slice(6)}`;
    requireValue(!data.reminderRules.some((item) => item.id === id), '這項提醒已建立，請勿重複操作。', 'FINANCE_DUPLICATE');
    validateReminderDefaults(data, command.entryType, command.entryDefaults, { requireActiveAccount: true });
    if (command.billDate) requireValue(command.repeat === 'once' && isValidDateOnly(command.billDate) && command.billDate <= command.date, '帳單日期不能晚於付款日。');
    if (command.billSchedule) requireValue(command.repeat !== 'once' && Number.isInteger(command.billSchedule.monthsBeforeDue) && command.billSchedule.monthsBeforeDue >= 0 && command.billSchedule.monthsBeforeDue <= 12 && Number.isInteger(command.billSchedule.day) && command.billSchedule.day >= 1 && command.billSchedule.day <= 31, '帳單日期設定無效。');
    data.reminderRules.push({ id, name: command.name.trim(), entryType: command.entryType, amountTwd: Number(command.amountTwd), firstDueDate: command.date, anchorDay: Number(command.date.slice(8)), repeat: command.repeat, advanceDays: command.advanceDays, note: command.note || '', ...(command.entryDefaults ? { entryDefaults: structuredClone(command.entryDefaults) } : {}), ...(command.repeat === 'once' && command.billDate ? { billDate: command.billDate } : {}), ...(command.repeat !== 'once' && command.billSchedule ? { billSchedule: structuredClone(command.billSchedule) } : {}), active: true, revision: 1, createdAt: now, dataset });
    materialize(data, today, now);
  } else if (command.kind === 'link-reminder') {
    const pending = data.reminderOccurrences.find((item) => item.id === command.occurrenceId);
    requireValue(pending, '找不到提醒期次。');
    if (pending.status === 'completed' && pending.entryId === command.entryId) return { data: input, status: 'duplicate', eventId: '', warnings: [] };
    requireValue(pending.status === 'pending' && pending.revision === command.expectedRevision && command.confirmed === true, '提醒狀態已改變或尚未確認，請重新讀取。', 'FINANCE_CONFLICT');
    const record = data[pending.entryType === 'income' ? 'incomes' : 'expenses'].find((item) => item.id === command.entryId);
    requireValue(record && !record.reminderOccurrenceId && !data.reminderOccurrences.some((item) => item.entryId === record.id), '請選擇同一收支類型、尚未關聯提醒的交易。');
    record.reminderOccurrenceId = pending.id;
    Object.assign(pending, { status: 'completed', completionMode: 'linked', entryId: record.id, revision: pending.revision + 1 });
  } else if (command.kind === 'undo-reminder-payment') {
    const occurrence = data.reminderOccurrences.find((item) => item.id === command.occurrenceId);
    const completionMode = occurrence?.completionMode || 'created';
    requireValue(occurrence?.status === 'completed'
      && occurrence.revision === command.expectedRevision
      && occurrence.entryId === command.entryId
      && completionMode === command.expectedCompletionMode
      && ['created', 'linked'].includes(completionMode)
      && command.confirmed === true,
    '本期期次已變更或尚未確認撤銷；請重新讀取。', 'FINANCE_CONFLICT');
    const storeName = entryStoreName(occurrence.entryType);
    const record = data[storeName].find((item) => item.id === occurrence.entryId);
    requireValue(record?.reminderOccurrenceId === occurrence.id, '提醒與收支的雙向關聯不完整；為保護帳務，已拒絕撤銷。');
    const eventRow = record.financeEventId ? data.accountEvents.find((item) => item.id === record.financeEventId) : null;
    requireValue(completionMode !== 'created' || (eventRow && eventRow.entryId === record.id && eventRow.type === occurrence.entryType && eventRow.idempotencyKey === occurrence.postingKey), '提醒建立的收支缺少正確帳戶異動；為保護餘額，已拒絕撤銷。');
    requireValue(!record.financeEventId || (eventRow && eventRow.entryId === record.id && eventRow.type === occurrence.entryType), '原收支帳戶異動不完整；為保護餘額，已拒絕撤銷。');
    requireValue(!entryReferences(data, record.id, eventRow?.id || '', occurrence.id), '這筆交易另有退款、其他提醒或資料引用，不能安全撤銷。');
    if (completionMode === 'created') {
      requireValue(record.idempotencyKey === occurrence.postingKey, '自動建立的收支入帳鍵不一致；不能安全撤銷。');
      requireValue(!hasUnsupportedEntryBreakdown(record, eventRow), '這筆提醒交易包含多項商品或付款分配，不能安全撤銷。');
      data[storeName] = data[storeName].filter((item) => item.id !== record.id);
      if (eventRow) data.accountEvents = data.accountEvents.filter((item) => item.id !== eventRow.id);
      reflowAccountEvents(data, now);
    } else {
      delete record.reminderOccurrenceId;
    }
    occurrence.status = 'pending';
    occurrence.revision += 1;
    delete occurrence.entryId;
    delete occurrence.completionMode;
  } else if (command.kind === 'delete-reminder') {
    const rule = data.reminderRules.find((item) => item.id === command.ruleId);
    const children = data.reminderOccurrences.filter((item) => item.ruleId === command.ruleId);
    requireValue(rule && rule.revision === command.expectedRevision && command.confirmed === true && children.length === command.expectedOccurrences, '提醒已變更或尚未確認，請重新預覽刪除。', 'FINANCE_CONFLICT');
    const completed = children.filter((item) => item.status === 'completed' || item.entryId);
    if (completed.length) {
      requireValue(command.preserveTransactions === true, '此提醒有歷史交易；若要移除提醒，請明確選擇保留歷史收支。');
      for (const occurrence of completed) {
        requireValue(occurrence.status === 'completed' && occurrence.entryId && ['created', 'linked'].includes(occurrence.completionMode || 'created'), '提醒完成狀態不完整；不能安全移除規則。');
        const record = data[entryStoreName(occurrence.entryType)].find((item) => item.id === occurrence.entryId);
        requireValue(record?.reminderOccurrenceId === occurrence.id, '提醒與歷史收支關聯不完整；不能移除規則。');
        const eventRow = record.financeEventId ? data.accountEvents.find((item) => item.id === record.financeEventId) : null;
        requireValue(!record.financeEventId || (eventRow && eventRow.entryId === record.id && eventRow.type === occurrence.entryType), '歷史收支的帳戶異動不完整；不能移除提醒。');
        if ((occurrence.completionMode || 'created') === 'created') requireValue(record.idempotencyKey === occurrence.postingKey, '提醒建立交易的入帳鍵不一致；不能移除規則。');
        requireValue(!entryReferences(data, record.id, eventRow?.id || '', occurrence.id), '歷史收支另有提醒、退款或其他資料引用；不能安全移除規則。');
        delete record.reminderOccurrenceId;
      }
    } else {
      requireValue(![...data.expenses, ...data.incomes].some((item) => children.some((child) => child.id === item.reminderOccurrenceId)), '已存在收支引用提醒期次；不能安全刪除。');
    }
    data.reminderRules = data.reminderRules.filter((item) => item.id !== rule.id);
    data.reminderOccurrences = data.reminderOccurrences.filter((item) => item.ruleId !== rule.id);
  } else if (command.kind === 'edit-reminder') {
    const item = data.reminderRules.find((rule) => rule.id === command.ruleId);
    requireValue(item && item.revision === command.expectedRevision, '提醒已被修改，請重新讀取。', 'FINANCE_CONFLICT');
    requireValue(text(command.name, 60) && command.name.trim() && parseWholeTwd(command.amountTwd) !== null && Number.isInteger(command.advanceDays) && command.advanceDays >= 0 && command.advanceDays <= 365 && text(command.note || ''), '提醒名稱、金額或提前天數無效。');
    validateReminderDefaults(data, item.entryType, command.entryDefaults, { requireActiveAccount: true });
    if (command.billDate) requireValue(item.repeat === 'once' && isValidDateOnly(command.billDate) && command.billDate <= item.firstDueDate, '單次帳單日期不能晚於付款日。');
    if (command.billSchedule) requireValue(item.repeat !== 'once' && Number.isInteger(command.billSchedule.monthsBeforeDue) && command.billSchedule.monthsBeforeDue >= 0 && command.billSchedule.monthsBeforeDue <= 12 && Number.isInteger(command.billSchedule.day) && command.billSchedule.day >= 1 && command.billSchedule.day <= 31, '帳單日期設定無效。');
    Object.assign(item, { name: command.name.trim(), amountTwd: Number(command.amountTwd), advanceDays: command.advanceDays, note: command.note || '', revision: item.revision + 1 });
    if (Object.hasOwn(command, 'entryDefaults')) { if (command.entryDefaults) item.entryDefaults = structuredClone(command.entryDefaults); else delete item.entryDefaults; }
    if (item.repeat === 'once' && Object.hasOwn(command, 'billDate')) { if (command.billDate) item.billDate = command.billDate; else delete item.billDate; }
    else if (item.repeat !== 'once' && Object.hasOwn(command, 'billSchedule')) { if (command.billSchedule) item.billSchedule = structuredClone(command.billSchedule); else delete item.billSchedule; }
    // Rule changes affect only future, untouched pending periods; due, overdue, completed and cancelled rows stay stable.
    if (command.applyFuture !== false) for (const occurrence of data.reminderOccurrences.filter((entry) => entry.ruleId === item.id && entry.status === 'pending' && entry.dueDate > today)) {
      const overrides = new Set(occurrence.overrides || []);
      for (const field of ['name', 'amountTwd', 'advanceDays', 'note']) if (!overrides.has(field)) occurrence[field] = item[field];
      if (!overrides.has('entryDefaults')) { if (item.entryDefaults) occurrence.entryDefaults = structuredClone(item.entryDefaults); else delete occurrence.entryDefaults; }
      if (!overrides.has('billDate')) {
        const billDate = item.repeat === 'once' ? (item.billDate || '') : reminderBillDate(occurrence.dueDate, item.billSchedule);
        if (billDate) occurrence.billDate = billDate; else delete occurrence.billDate;
      }
      occurrence.sourceRuleRevision = item.revision; occurrence.revision += 1;
    }
  } else if (command.kind === 'edit-occurrence' || command.kind === 'cancel-occurrence') {
    const item = data.reminderOccurrences.find((entry) => entry.id === command.occurrenceId);
    requireValue(item?.status === 'pending' && item.revision === command.expectedRevision, '期次已變更，請重新讀取。', 'FINANCE_CONFLICT');
    if (command.kind === 'cancel-occurrence') item.status = 'cancelled';
    else {
      requireValue(text(command.name, 60) && command.name.trim() && parseWholeTwd(command.amountTwd) !== null && isValidDateOnly(command.date) && text(command.note || ''), '期次內容無效。');
      Object.assign(item, { name: command.name.trim(), amountTwd: Number(command.amountTwd), dueDate: command.date, note: command.note || '' });
      item.overrides = [...new Set([...(item.overrides || []), 'name', 'amountTwd', 'dueDate', 'note'])];
      if (command.entryDefaults !== undefined) { validateReminderDefaults(data, item.entryType, command.entryDefaults, { requireActiveAccount: true }); item.entryDefaults = structuredClone(command.entryDefaults); item.overrides = [...new Set([...item.overrides, 'entryDefaults'])]; }
      if (command.billDate !== undefined) { requireValue(!command.billDate || (isValidDateOnly(command.billDate) && command.billDate <= command.date), '帳單日期不能晚於付款日。'); if (command.billDate) item.billDate = command.billDate; else delete item.billDate; item.overrides = [...new Set([...item.overrides, 'billDate'])]; }
    }
    item.revision += 1;
  } else if (command.kind === 'cancel-reminder') {
    const rule = data.reminderRules.find((item) => item.id === command.ruleId);
    requireValue(rule && rule.revision === command.expectedRevision, '提醒已變更。', 'FINANCE_CONFLICT'); rule.active = false; rule.revision += 1;
    for (const item of data.reminderOccurrences) if (item.ruleId === rule.id && item.status === 'pending' && item.dueDate > today) { item.status = 'cancelled'; item.revision += 1; }
  } else if (command.kind === 'refresh-reminders') materialize(data, today, now);
  else fail('不支援的帳務操作。');
  validateFinanceSnapshot(data);
  const warnings = [...accountBalances(data)].filter(([, balance]) => balance < 0n).map(([id]) => `${data.accounts.find((item) => item.id === id).name} 為負餘額；仍依你的設定允許保存。`);
  if (command.kind === 'record' && command.entryType === 'expense') {
    const month = monthKey(command.date);
    const prior = new Map(calculateMonthlyBudgets(input, month).map((item) => [item.id, item]));
    for (const item of calculateMonthlyBudgets(data, month)) {
      if (item.exceeded && !prior.get(item.id)?.exceeded) warnings.push(`${item.categoryName}${item.subcategoryName ? `・${item.subcategoryName}` : ''}本月已超出預算；記帳仍已保存。`);
    }
  }
  return { data, status: 'saved', eventId, warnings };
}
