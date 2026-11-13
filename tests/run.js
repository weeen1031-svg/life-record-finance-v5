import { runFinanceReleaseTests } from './finance-release.test.js';
import { runOverviewUiTests } from './overview-ui.test.js';
import { runLedgerIntegrationTests } from './ledger-integration.test.js';
import { runFinanceTests } from './finance.test.js';
import { runHistoryInterfaceTests } from './history-interface.test.js';
import { runLedgerCategoryTests } from './ledger-categories.test.js';

const suites = [
  ['release', runFinanceReleaseTests],
  ['overview', runOverviewUiTests],
  ['ledger integration', runLedgerIntegrationTests],
  ['finance', runFinanceTests],
  ['history', runHistoryInterfaceTests],
  ['categories', runLedgerCategoryTests],
];
let passed = 0; let total = 0; const failures = [];
for (const [name, run] of suites) {
  const result = await run(); passed += result.passed; total += result.total;
  for (const item of result.results || []) if (!item.passed) failures.push({ suite: name, name: item.name, error: item.error });
  process.stdout.write(`${name}: ${result.passed}/${result.total}\n`);
}
process.stdout.write(`total: ${passed}/${total}\n`);
if (failures.length) { process.stdout.write(`${JSON.stringify(failures, null, 2)}\n`); process.exitCode = 1; }
