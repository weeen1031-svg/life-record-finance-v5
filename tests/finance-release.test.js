import { readFile } from 'node:fs/promises';
import { navigation } from '../scripts/data.js';
import { FINANCE_PAGES_BASE_PATH, isFinanceAppLocation } from '../scripts/finance/app-location.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function runFinanceReleaseTests() {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../scripts/app.js', import.meta.url), 'utf8');
  const ids = navigation.map((item) => item.id);
  assert(ids.join(',') === 'ledger,add-entry,history,analytics,accounts,reminders', '公開版導覽包含非記帳頁面或缺少記帳功能');
  assert(html.includes('<title>記帳 V5</title>') && html.includes('class="finance-only"'), '公開版標題或單一用途樣式缺少');
  assert(!/class="sidebar|data-page="(home|diary|sleep|settings)"|生活首頁|系統設定|睡眠紀錄/.test(html), '公開頁面仍包含生活導覽');
  assert(app.includes("let activePage = 'ledger'") && app.includes("return normalizeRoute('ledger')"), '根網址或未知網址沒有導向記帳工作區');
  assert(!app.match(/(?:LEDGER|FINANCE)_SETTINGS_SUBVIEWS = new Set\([^)]*acceptance/), '公開版仍可直接進入開發驗收頁');
  assert(!app.includes('renderHome') && !app.includes('renderPlaceholder') && !app.includes('renderSettingsLanding'), '生活首頁或佔位頁仍可由應用程式顯示');
  const accepted = { location: { origin: 'https://friend.github.io', pathname: `${FINANCE_PAGES_BASE_PATH}/` } };
  assert(isFinanceAppLocation(accepted), 'GitHub Pages 正式路徑未通過保存網址檢查');
  for (const location of [
    { origin: 'http://127.0.0.1:5510', pathname: '/' },
    { origin: 'https://friend.github.io', pathname: '/other/' },
    { origin: 'https://friend.github.io.attacker.example', pathname: `${FINANCE_PAGES_BASE_PATH}/` },
  ]) assert(!isFinanceAppLocation({ location }), '錯誤網址通過保存網址檢查');
  return { passed: 10, total: 10, results: [] };
}
