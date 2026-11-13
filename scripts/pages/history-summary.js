// Calendar arithmetic uses UTC only to prevent date-only records shifting by timezone.
const DAY = 86400000;
function utcDate(year, monthIndex, day) {
  const date = new Date(0); date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, monthIndex, day); return date;
}
function key(date) {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function calendarMonthWeeks(monthKey) {
  if (typeof monthKey !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey) || Number(monthKey.slice(0, 4)) < 1) throw new Error('月份格式無效。');
  const [year, month] = monthKey.split('-').map(Number);
  const first = utcDate(year, month - 1, 1);
  const last = utcDate(year, month, 0);
  const offset = (first.getUTCDay() + 6) % 7;
  const weeks = [];
  for (let start = first.getTime() - offset * DAY; start <= last.getTime(); start += 7 * DAY) {
    const end = start + 6 * DAY;
    weeks.push({
      calendarStart: key(new Date(start)), calendarEnd: key(new Date(end)),
      startDate: key(new Date(Math.max(start, first.getTime()))),
      endDate: key(new Date(Math.min(end, last.getTime()))),
    });
  }
  return weeks;
}

export function summarizeHistoryMonth(records, monthKey) {
  const weeks = calendarMonthWeeks(monthKey).map((week) => ({ ...week, expense: 0n }));
  const categories = new Map(); let income = 0n; let expense = 0n; let count = 0;
  for (const record of records) {
    if (record.occurredOn.slice(0, 7) !== monthKey) continue;
    count += 1;
    if (record.recordType === 'income') { income += BigInt(record.amountMinor); continue; }
    if (record.recordType !== 'expense') continue;
    const amount = BigInt(record.amountMinor); expense += amount;
    const category = categories.get(record.categoryId) || { id: record.categoryId, name: record.categoryNameSnapshot, amount: 0n };
    category.amount += amount; categories.set(category.id, category);
    const week = weeks.find((item) => record.occurredOn >= item.startDate && record.occurredOn <= item.endDate);
    if (week) week.expense += amount;
  }
  return { monthKey, count, income, expense, net: income - expense, weeks,
    categories: [...categories.values()].sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.id.localeCompare(b.id)) };
}
