import { isFinanceAppLocation } from '../finance/app-location.js';

export const OVERVIEW_PREFERENCES_KEY = 'LifeRecord_UI_Overview_v1';
export const PREVIOUS_OVERVIEW_BLOCKS = ['monthly', 'budget', 'recent'];
export const OVERVIEW_BLOCKS = [...PREVIOUS_OVERVIEW_BLOCKS, 'subscriptions'];
export const OVERVIEW_DEFAULT_FOCUS_COUNT = 4;
export const budgetScopeKey = (row) => `${row.categoryId}::${row.subcategoryId || ''}`;
export function defaultOverviewConfig() { return { blocks: [...OVERVIEW_BLOCKS], focus: null, focusFilterEnabled: false, focusVisibleCount: 3, budgetCollapsed: false, recentCollapsed: false, subscriptionsCollapsed: false }; }
export function defaultOverviewPreferences() { return { version: 1, personal: defaultOverviewConfig(), preview: defaultOverviewConfig() }; }
export function validateOverviewPreferences(value) {
  if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'personal,preview,version') throw new Error('顯示設定格式無效。');
  const legacyConfigKeys = 'blocks,budgetCollapsed,focus';
  const previousConfigKeys = 'blocks,budgetCollapsed,focus,recentCollapsed';
  const previousFilterConfigKeys = 'blocks,budgetCollapsed,focus,focusFilterEnabled,recentCollapsed';
  const previousSubscriptionConfigKeys = 'blocks,budgetCollapsed,focus,focusFilterEnabled,recentCollapsed,subscriptionsCollapsed';
  const currentConfigKeys = 'blocks,budgetCollapsed,focus,focusFilterEnabled,focusVisibleCount,recentCollapsed,subscriptionsCollapsed';
  const normalized = structuredClone(value);
  for (const key of ['personal', 'preview']) {
    const config = normalized[key];
    const configKeys = config ? Object.keys(config).sort().join(',') : '';
    if (!config || ![legacyConfigKeys, previousConfigKeys, previousFilterConfigKeys, previousSubscriptionConfigKeys, currentConfigKeys].includes(configKeys) || typeof config.budgetCollapsed !== 'boolean'
      || (configKeys !== legacyConfigKeys && typeof config.recentCollapsed !== 'boolean')
      || ([previousFilterConfigKeys, previousSubscriptionConfigKeys, currentConfigKeys].includes(configKeys) && typeof config.focusFilterEnabled !== 'boolean')
      || ([previousSubscriptionConfigKeys, currentConfigKeys].includes(configKeys) && typeof config.subscriptionsCollapsed !== 'boolean')
      || (configKeys === currentConfigKeys && ![1, 2, 3].includes(config.focusVisibleCount))
      || !Array.isArray(config.blocks) || new Set(config.blocks).size !== config.blocks.length
      || !((config.blocks.length === OVERVIEW_BLOCKS.length && config.blocks.every((id) => OVERVIEW_BLOCKS.includes(id)))
        || (config.blocks.length === PREVIOUS_OVERVIEW_BLOCKS.length && config.blocks.every((id) => PREVIOUS_OVERVIEW_BLOCKS.includes(id))))
      || (config.focus !== null && (!Array.isArray(config.focus) || config.focus.length > 500 || new Set(config.focus).size !== config.focus.length || config.focus.some((id) => typeof id !== 'string' || id.length > 250)))) throw new Error('顯示設定格式無效。');
    if (config.blocks.length === PREVIOUS_OVERVIEW_BLOCKS.length) config.blocks.splice(config.blocks.indexOf('recent') + 1, 0, 'subscriptions');
    if (configKeys === legacyConfigKeys) config.recentCollapsed = false;
    if (![previousFilterConfigKeys, previousSubscriptionConfigKeys, currentConfigKeys].includes(configKeys)) config.focusFilterEnabled = false;
    if (![previousSubscriptionConfigKeys, currentConfigKeys].includes(configKeys)) config.subscriptionsCollapsed = false;
    if (configKeys !== currentConfigKeys) config.focusVisibleCount = 3;
  }
  return normalized;
}
function storage(environment) {
  if (!isFinanceAppLocation(environment) || !environment.localStorage) throw new Error('目前無法保存總覽顯示設定。');
  return environment.localStorage;
}
export function loadOverviewPreferences(environment = globalThis) {
  try {
    const text = storage(environment).getItem(OVERVIEW_PREFERENCES_KEY);
    if (text === null) return { value: defaultOverviewPreferences(), error: '' };
    if (text.length > 300000) throw new Error('顯示設定過大');
    return { value: validateOverviewPreferences(JSON.parse(text)), error: '' };
  } catch { return { value: defaultOverviewPreferences(), error: '無法讀取總覽顯示偏好，先使用預設排列。' }; }
}
export function saveOverviewPreferences(value, environment = globalThis) {
  const text = JSON.stringify(validateOverviewPreferences(value)); const target = storage(environment);
  target.setItem(OVERVIEW_PREFERENCES_KEY, text);
  if (target.getItem(OVERVIEW_PREFERENCES_KEY) !== text) throw new Error('無法確認總覽顯示設定已保存。');
}
export function focusedBudgetRows(rows, focus) {
  const byKey = new Map(rows.map((row) => [budgetScopeKey(row), row]));
  return (focus === null ? [...byKey.keys()].slice(0, OVERVIEW_DEFAULT_FOCUS_COUNT) : focus).filter((key) => byKey.has(key)).map((key) => byKey.get(key));
}
export function moveOverviewItem(items, id, destination) {
  const result = [...items]; const from = result.indexOf(id); const to = result.indexOf(destination);
  if (from < 0 || to < 0 || from === to) return result;
  result.splice(from, 1); result.splice(to, 0, id); return result;
}
