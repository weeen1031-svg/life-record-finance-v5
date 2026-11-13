import { EXPENSE_DATABASE_VERSION, isValidDateOnly, validateOfficialSnapshot } from './expense-db.js';
import { parseStrictJson, stableJson } from './json-data.js';

export const BACKUP_FORMAT = 'LifeRecord.LedgerBackup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

async function digest(data, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error('目前無法使用 SHA-256，備份驗證未完成。');
  const bytes = new TextEncoder().encode(stableJson(data));
  const hash = await cryptoProvider.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createLedgerBackup(input, { now = new Date(), cryptoProvider = globalThis.crypto } = {}) {
  const data = structuredClone(input);
  const summary = validateOfficialSnapshot(data);
  const document = {
    format: BACKUP_FORMAT, formatVersion: BACKUP_VERSION, databaseVersion: EXPENSE_DATABASE_VERSION,
    appVersion: 'Life Record V1.0', exportedAt: now.toISOString(),
    scope: ['expenses', 'incomes', 'categoryCatalog'],
    counts: { expenses: summary.expenses, incomes: summary.incomes, categoryCatalog: 1 },
    data, sha256: await digest(data, cryptoProvider),
  };
  const text = JSON.stringify(document, null, 2);
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('備份超過目前支援的 20 MiB 上限，沒有產生下載。');
  return { text, summary, exportedAt: document.exportedAt };
}

export async function validateLedgerBackup(text, { cryptoProvider = globalThis.crypto } = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('備份過大，目前上限為 20 MiB。');
  const document = parseStrictJson(text);
  if (!document || document.format !== BACKUP_FORMAT || document.formatVersion !== BACKUP_VERSION
    || Object.keys(document).sort().join(',') !== 'appVersion,counts,data,databaseVersion,exportedAt,format,formatVersion,scope,sha256'
    || typeof document.appVersion !== 'string' || document.appVersion.length > 100
    || document.databaseVersion !== EXPENSE_DATABASE_VERSION
    || stableJson(document.scope) !== stableJson(['expenses', 'incomes', 'categoryCatalog'])) throw new Error('備份格式、版本或保存範圍不支援；沒有還原資料。');
  if (typeof document.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(document.exportedAt)
    || !isValidDateOnly(document.exportedAt.slice(0, 10))
    || !Number.isFinite(Date.parse(document.exportedAt)) || new Date(document.exportedAt).toISOString() !== document.exportedAt) throw new Error('備份時間格式無效。');
  const summary = validateOfficialSnapshot(document.data);
  if (stableJson(document.counts) !== stableJson({ expenses: summary.expenses, incomes: summary.incomes, categoryCatalog: 1 })) throw new Error('備份的資料筆數不符。');
  if (typeof document.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(document.sha256) || await digest(document.data, cryptoProvider) !== document.sha256) throw new Error('SHA-256 不符，備份內容可能已損壞或變動。');
  return { data: document.data, summary, exportedAt: document.exportedAt, databaseVersion: document.databaseVersion, sha256: document.sha256 };
}
