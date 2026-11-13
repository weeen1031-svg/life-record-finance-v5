import { parseStrictJson, stableJson } from '../storage/json-data.js';
import { isValidDateOnly } from '../storage/expense-db.js';
import { createDefaultEntryPreferences, FINANCE_STORES, validateFinanceSnapshot } from './model.js';

export const FINANCE_BACKUP_LIMIT = 20 * 1024 * 1024;
const bytes = (value) => new TextEncoder().encode(value);
async function hash(value) {
  if (!globalThis.crypto?.subtle) throw new Error('無法使用 SHA-256，備份未完成。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(stableJson(value))))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function createFinanceBackup(input) {
  const data = structuredClone(input);
  const settings = data.financePreferences?.[0];
  if (settings) {
    settings.budgetSchedules ||= [];
    settings.budgetOverrides ||= [];
    settings.entryPreferences ||= createDefaultEntryPreferences();
    settings.entryPreferences.preferredAccountIds ||= {
      expense: settings.entryPreferences.preferredAccountId || '',
      income: settings.entryPreferences.preferredAccountId || '',
    };
  }
  const summary = validateFinanceSnapshot(data);
  const envelope = { format: 'LifeRecord.FinanceBackup', formatVersion: 6, databaseVersion: 4, dataset: summary.dataset, exportedAt: new Date().toISOString(), scope: FINANCE_STORES, counts: Object.fromEntries(FINANCE_STORES.map((name) => [name, data[name].length])), data };
  envelope.sha256 = await hash(envelope);
  const text = JSON.stringify(envelope, null, 2);
  if (bytes(text).length > FINANCE_BACKUP_LIMIT) throw new Error('備份超過 20 MiB，沒有產生下載。');
  return { text, summary };
}
export async function validateFinanceBackup(text) {
  if (typeof text !== 'string' || bytes(text).length > FINANCE_BACKUP_LIMIT) throw new Error('備份超過 20 MiB。');
  const envelope = parseStrictJson(text);
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'counts,data,databaseVersion,dataset,exportedAt,format,formatVersion,scope,sha256'
    || envelope.format !== 'LifeRecord.FinanceBackup' || ![2, 3, 4, 5, 6].includes(envelope.formatVersion) || envelope.databaseVersion !== 4 || stableJson(envelope.scope) !== stableJson(FINANCE_STORES)) throw new Error('不支援此帳戶備份格式或版本。');
  if (envelope.formatVersion >= 3 && (!Array.isArray(envelope.data?.financePreferences?.[0]?.budgetSchedules) || !Array.isArray(envelope.data?.financePreferences?.[0]?.budgetOverrides))) throw new Error('預算備份缺少必要欄位。');
  if (envelope.formatVersion >= 4 && !envelope.data?.financePreferences?.[0]?.entryPreferences) throw new Error('記帳偏好備份缺少必要欄位。');
  if (envelope.formatVersion >= 6 && !envelope.data?.financePreferences?.[0]?.entryPreferences?.preferredAccountIds) throw new Error('收入與支出通用帳戶偏好備份缺少必要欄位。');
  const time = envelope.exportedAt;
  if (typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) || !isValidDateOnly(time.slice(0, 10)) || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time) throw new Error('備份時間無效。');
  const summary = validateFinanceSnapshot(envelope.data);
  if (summary.dataset !== envelope.dataset || stableJson(envelope.counts) !== stableJson(Object.fromEntries(FINANCE_STORES.map((name) => [name, envelope.data[name].length])))) throw new Error('備份來源或筆數不符。');
  const { sha256, ...payload } = envelope;
  if (!/^[a-f0-9]{64}$/.test(sha256) || await hash(payload) !== sha256) throw new Error('備份 SHA-256 不符。');
  return { data: envelope.data, summary, exportedAt: time, formatVersion: envelope.formatVersion };
}
