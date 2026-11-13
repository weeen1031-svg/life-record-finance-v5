export const FINANCE_PREVIEW_STORAGE_KEY = 'LifeRecord_Finance_V4_DevelopmentPreview_v1';
export const FINANCE_PREVIEW_DATABASE_NAME = 'LifeRecord_Official_V1';
export const FINANCE_PREVIEW_SOURCE_VERSION = 3;
export const FINANCE_PREVIEW_TARGET_VERSION = 4;

export function matchesFinancePreviewBackup(backup, currentV3, snapshotToken) {
  return backup?.databaseVersion === FINANCE_PREVIEW_SOURCE_VERSION
    && /^[a-f0-9]{64}$/.test(backup.sha256 || '')
    && typeof snapshotToken === 'function'
    && snapshotToken(backup.data) === snapshotToken(currentV3);
}

export function isFinancePreviewLocation(environment = globalThis) {
  return environment.location?.origin === 'http://127.0.0.1:5510'
    && ['/', '/index.html'].includes(environment.location?.pathname);
}

export function readFinancePreviewState(environment = globalThis) {
  if (!isFinancePreviewLocation(environment)) return null;
  try {
    const state = JSON.parse(environment.localStorage?.getItem(FINANCE_PREVIEW_STORAGE_KEY) || 'null');
    if (!state || state.status !== 'active'
      || state.databaseName !== FINANCE_PREVIEW_DATABASE_NAME
      || state.sourceVersion !== FINANCE_PREVIEW_SOURCE_VERSION
      || state.targetVersion !== FINANCE_PREVIEW_TARGET_VERSION
      || typeof state.backupSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.backupSha256)) return null;
    return state;
  } catch { return null; }
}

export function isFinancePreviewEnabled(environment = globalThis) {
  return Boolean(readFinancePreviewState(environment));
}

export function activateFinancePreview(environment = globalThis, { backupSha256, activatedAt = new Date().toISOString() } = {}) {
  if (!isFinancePreviewLocation(environment)) throw new Error('V4 開發預覽僅能從 http://127.0.0.1:5510/ 主頁啟用。');
  if (typeof backupSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(backupSha256)) throw new Error('缺少已驗證的 V3 備份摘要，沒有啟用預覽。');
  if (!environment.localStorage?.setItem || !environment.localStorage?.getItem) throw new Error('此瀏覽器不允許保存目前設定檔的預覽狀態。');
  const state = {
    status: 'active', databaseName: FINANCE_PREVIEW_DATABASE_NAME,
    sourceVersion: FINANCE_PREVIEW_SOURCE_VERSION, targetVersion: FINANCE_PREVIEW_TARGET_VERSION,
    backupSha256, activatedAt,
  };
  try {
    environment.localStorage.setItem(FINANCE_PREVIEW_STORAGE_KEY, JSON.stringify(state));
    if (JSON.stringify(readFinancePreviewState(environment)) !== JSON.stringify(state)) throw new Error('無法確認預覽狀態已保存。');
  } catch (error) {
    throw new Error(`無法安全保存此設定檔的預覽狀態：${error.message || '本機儲存失敗。'}`);
  }
  return state;
}

export function clearFinancePreviewState(environment = globalThis) {
  if (!isFinancePreviewLocation(environment)) return false;
  try {
    environment.localStorage?.removeItem(FINANCE_PREVIEW_STORAGE_KEY);
    return !environment.localStorage?.getItem(FINANCE_PREVIEW_STORAGE_KEY);
  } catch { return false; }
}
