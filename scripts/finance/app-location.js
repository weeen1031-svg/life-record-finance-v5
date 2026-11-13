export const FINANCE_PAGES_BASE_PATH = '/life-record-finance-v5';

export function isFinanceAppOrigin(origin) {
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin
      && parsed.protocol === 'https:'
      && /^[a-z0-9-]+\.github\.io$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function isFinanceAppPath(pathname) {
  return [FINANCE_PAGES_BASE_PATH, `${FINANCE_PAGES_BASE_PATH}/`, `${FINANCE_PAGES_BASE_PATH}/index.html`].includes(pathname);
}

export function isFinanceAppLocation(environment = globalThis) {
  return isFinanceAppOrigin(environment.location?.origin) && isFinanceAppPath(environment.location?.pathname);
}
