import { isFinanceAppLocation } from '../finance/app-location.js';

export const OPERATION_HINTS_KEY = 'LifeRecord_UI_OperationHints_v1';

function storage(environment) {
  if (!isFinanceAppLocation(environment)) throw new Error('操作提示偏好只能在記帳版 GitHub Pages 網址保存。');
  if (!environment.localStorage) throw new Error('目前瀏覽器無法保存操作提示偏好。');
  return environment.localStorage;
}

export function loadOperationHints(environment = globalThis) {
  try {
    const text = storage(environment).getItem(OPERATION_HINTS_KEY);
    if (text === null) return { show: true, error: '' };
    if (text.length > 200) throw new Error('偏好格式無效');
    const value = JSON.parse(text);
    if (!value || value.version !== 1 || typeof value.show !== 'boolean' || Object.keys(value).sort().join(',') !== 'show,version') throw new Error('偏好格式無效');
    return { show: value.show, error: '' };
  } catch {
    return { show: true, error: '無法讀取操作提示偏好，目前先顯示提示。你仍可正常記帳。' };
  }
}

export function saveOperationHints(show, environment = globalThis) {
  if (typeof show !== 'boolean') throw new Error('操作提示設定無效。');
  const target = storage(environment);
  const text = JSON.stringify({ version: 1, show });
  target.setItem(OPERATION_HINTS_KEY, text);
  if (target.getItem(OPERATION_HINTS_KEY) !== text) throw new Error('無法確認操作提示偏好已保存。');
}
