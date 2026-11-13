import { escapeHTML as esc } from '../escape-html.js';
import { icon } from '../icons.js';
import { ACCOUNT_COLOR_PALETTE, accountBalances, getAccountColor, reminderStatus } from './model.js';

const repeatLabel = (rule) => rule.repeat === 'yearly' ? `每年 ${Number(rule.firstDueDate.slice(5, 7))} 月 ${rule.anchorDay} 日` : rule.repeat === 'monthly' ? `每月 ${rule.anchorDay} 日` : '單次';
const minorMoney = (minor) => { const n = BigInt(minor); return `$${(n / 100n).toLocaleString('zh-TW')}.${String(n % 100n).padStart(2, '0')}`; };
const panel = (title, content, close) => `<section class="finance-section finance-operation-panel" data-finance-focus tabindex="-1"><div class="finance-panel-heading"><h2>${title}</h2>${close}</div>${content}</section>`;

function accountChoiceField({ state, button, form, field, label, selectedId = '', accounts }) {
  const selected = accounts.find((item) => item.id === selectedId && item.active);
  const selectedLabel = selected ? `已選：${selected.name}` : '尚未選擇';
  const order = Array.isArray(state.accountOrder) ? state.accountOrder : [];
  const orderedAccounts = [...accounts].sort((left, right) => {
    const leftIndex = order.indexOf(left.id); const rightIndex = order.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
      || accounts.indexOf(left) - accounts.indexOf(right);
  });
  const choices = [
    button('choose-account-option', `<span class="finance-choice-account-icon">${icon('wallet', 18)}</span><span><strong>請選擇帳戶</strong><small>目前未選擇</small></span>`, `data-form="${form}" data-field="${field}" data-account-id="" data-choice-card="account" aria-pressed="${!selectedId}"`),
    ...orderedAccounts.filter((item) => item.active).map((item) => {
      const color = getAccountColor(item);
      return button('choose-account-option', `<span class="finance-choice-account-icon" style="--account-color:${color}">${icon(item.type === 'bank' ? 'bank' : 'wallet', 18)}</span><span><strong>${esc(item.name)}</strong><small>${item.type === 'bank' ? '銀行帳戶' : '現金帳戶'}</small></span>`, `data-form="${form}" data-field="${field}" data-account-id="${esc(item.id)}" data-choice-card="account" aria-pressed="${selectedId === item.id}" style="--account-color:${color}"`);
    }),
  ].join('');
  return `<fieldset class="finance-account-choice-field"><legend>${label}<small class="finance-choice-selected" aria-live="polite">${esc(selectedLabel)}</small></legend><div class="finance-choice-card-grid">${choices}</div></fieldset>`;
}

export function renderAccountsScreen(h) {
  const { state, today, value, button, input, select, accounts, section, money } = h;
  const data = state.data; const balances = accountBalances(data); const editing = state.editingAccount;
  const active = data.accounts.filter((item) => item.active).length;
  const orderedIds = Array.isArray(state.accountOrder) ? state.accountOrder : [];
  const orderedAccounts = [...data.accounts].sort((left, right) => {
    const leftIndex = orderedIds.indexOf(left.id); const rightIndex = orderedIds.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
      || data.accounts.indexOf(left) - data.accounts.indexOf(right);
  });
  const activeAccounts = orderedAccounts.filter((item) => item.active);
  const inactiveAccounts = orderedAccounts.filter((item) => !item.active);
  const managementMode = Boolean(state.accountManagementMode);
  const renderAccountCard = (item) => {
    const savedColor = getAccountColor(item);
    const color = editing?.id === item.id && state.accountView === 'account'
      ? (value('account', 'color', savedColor) || savedColor) : savedColor;
    const typeLabel = item.type === 'bank' ? '銀行帳戶' : '現金帳戶';
    const sortAttrs = managementMode ? '' : `data-account-sort-item="${esc(item.id)}" tabindex="0" aria-keyshortcuts="ArrowUp ArrowDown" aria-describedby="finance-account-order-help" aria-label="${esc(item.name)}，${typeLabel}；使用上下方向鍵調整排列"`;
    const managementAttrs = managementMode ? 'data-account-management-item' : '';
    const status = `<span class="finance-account-status ${item.active ? 'is-active' : 'is-inactive'}">${item.active ? '使用中' : '已停用'}</span>`;
    const actions = `${button('edit-account', '編輯', `data-id="${esc(item.id)}"`)}${managementMode ? button('toggle-account', item.active ? '停用' : '恢復', `data-id="${esc(item.id)}"`) : ''}${button('delete-account', `${icon('trash', 14)}刪除`, `data-id="${esc(item.id)}" aria-label="刪除帳戶「${esc(item.name)}」" title="刪除帳戶" data-danger="true"`)}`;
    return `<article class="finance-account-card ${item.active ? '' : 'is-inactive'} ${managementMode ? 'is-management' : ''}" style="--account-color:${color}" ${sortAttrs} ${managementAttrs}><div class="finance-account-heading"><span class="finance-account-icon">${icon(item.type === 'bank' ? 'bank' : 'wallet', 20)}</span><div class="finance-account-identity"><h3>${esc(item.name)}</h3><span class="finance-account-type">${typeLabel}</span>${status}</div></div><strong class="finance-card-balance ${balances.get(item.id) < 0n ? 'finance-negative' : ''}">${money(balances.get(item.id))}</strong><small>起始日 ${esc(item.openingDate)}</small><div class="finance-card-actions">${actions}</div></article>`;
  };
  const visibleAccounts = managementMode ? orderedAccounts : activeAccounts;
  const list = visibleAccounts.map(renderAccountCard).join('');
  const operations = [['account', '新增帳戶'], ['transfer', '帳戶轉帳'], ['adjustment', '餘額校正']];
  const toolbar = `<nav class="finance-actions finance-account-actions" aria-label="帳戶操作">${operations.map(([id, label]) => button('account-view', label, `data-view="${id}" aria-pressed="${state.accountView === id}"`)).join('')}</nav>`;
  let content = '';
  if (state.accountView === 'account') {
    const type = value('account', 'type', editing?.type || 'cash');
    const selectedColor = value('account', 'color', editing?.color || (type === 'bank' ? '#718AA5' : '#C39451'));
    const typeChoices = editing
      ? `<span class="finance-account-type-static" data-account-type="${type}"><span class="finance-choice-account-icon">${icon(type === 'bank' ? 'bank' : 'wallet', 20)}</span><strong>${type === 'bank' ? '銀行' : '現金'}</strong><small>帳戶類型建立後固定</small></span>`
      : [['cash', 'wallet', '現金', '以實體現金管理'], ['bank', 'bank', '銀行', '以銀行存款管理']].map(([id, iconName, label, copy]) => button('choose-account-type', `<span class="finance-choice-account-icon">${icon(iconName, 20)}</span><span><strong>${label}</strong><small>${copy}</small></span>`, `data-account-type="${id}" data-choice-card="account-type" aria-pressed="${type === id}"`)).join('');
    const colorChoices = ACCOUNT_COLOR_PALETTE.map((choice) => button('choose-account-color', `<span class="finance-account-color-swatch" style="--account-color:${choice.color}"></span>`, `data-account-color="${choice.color}" aria-label="選擇${choice.label}" title="${choice.label}" aria-pressed="${selectedColor === choice.color}"`)).join('');
    content = `<div class="finance-fields">${input('account', 'name', '帳戶名稱', editing?.name || '', 'text', 'maxlength="40"')}</div><fieldset class="finance-account-choice-field"><legend>帳戶類型</legend><div class="finance-choice-card-grid finance-account-type-grid">${typeChoices}</div></fieldset><fieldset class="finance-account-choice-field"><legend>帳戶識別色</legend><div class="finance-account-color-grid">${colorChoices}</div><p data-operation-hint>識別色只影響辨認，不改變帳務。</p></fieldset>${editing ? '' : `<div class="finance-fields">${input('account', 'openingTwd', '起始餘額（不算收入）', '0', 'number', 'step="1"')}${input('account', 'date', '從哪一天開始計算', today(), 'date')}</div>`}<p>起始餘額代表開始使用時已擁有的資金；舊收支不會再扣一次。之後的修改使用校正異動保留紀錄。</p><div class="finance-form-footer">${button('save-account', editing ? '保存修改' : '建立帳戶')}</div>`;
  }
  if (state.accountView === 'transfer') content = `<p class="finance-important">帳戶轉帳不計入一般收入或支出。</p><div class="finance-transfer-route">${accountChoiceField({ state, button, form: 'transfer', field: 'fromAccountId', label: '轉出帳戶', selectedId: value('transfer', 'fromAccountId'), accounts: data.accounts })}<span class="finance-transfer-arrow" aria-hidden="true">${icon('arrowLeftRight', 22)}</span>${accountChoiceField({ state, button, form: 'transfer', field: 'toAccountId', label: '轉入帳戶', selectedId: value('transfer', 'toAccountId'), accounts: data.accounts })}</div><div class="finance-fields finance-vertical-fields">${input('transfer', 'date', '轉帳日期', today(), 'date')}${input('transfer', 'amountTwd', '轉帳金額', '', 'number', 'min="1" step="1"')}${input('transfer', 'note', '備註', '', 'text', 'maxlength="160"')}</div><div class="finance-form-footer">${button('transfer', '確認轉帳')}</div>`;
  if (state.accountView === 'adjustment') content = `<p class="finance-important">只用於盤點後修正系統與實際餘額的差額。薪水、一般收入或朋友還錢請記錄為收支，不要使用校正。</p>${accountChoiceField({ state, button, form: 'adjustment', field: 'accountId', label: '要校正的帳戶', selectedId: value('adjustment', 'accountId'), accounts: data.accounts })}<div class="finance-fields finance-vertical-fields">${input('adjustment', 'date', '校正日期', today(), 'date')}${input('adjustment', 'targetTwd', '盤點後實際餘額', '', 'number', 'step="1"')}${input('adjustment', 'note', '差額原因（必填）', '', 'text', 'maxlength="160"')}</div><p>會新增一筆差額異動，不算一般收入、支出或預算。</p><div class="finance-form-footer">${button('adjustment', '確認餘額校正')}</div>`;
  const title = { account: editing ? '編輯帳戶' : '新增帳戶', transfer: '帳戶轉帳', adjustment: '餘額校正' }[state.accountView];
  const operationPanel = content ? panel(title, content, button('close-operation', '關閉')) : `<div class="finance-operation-empty" data-operation-hint>選擇一項操作，表單會固定顯示在這個區域。</div>`;
  const accountList = list || section(managementMode ? '尚無帳戶可管理' : '目前沒有使用中的帳戶', `<p>${managementMode ? '目前沒有帳戶；可先建立現金或銀行帳戶。' : inactiveAccounts.length ? '可開啟「帳戶停用管理」恢復帳戶，或新增帳戶。' : '先建立現金或銀行帳戶，再設定付款預設。'}</p>${button('account-view', '新增帳戶', 'data-view="account"')}`);
  const accountManagerToggle = `<button type="button" class="finance-inactive-account-toggle ${managementMode ? 'is-active' : ''}" data-finance-action="toggle-inactive-accounts" aria-pressed="${managementMode}" aria-label="${managementMode ? '結束帳戶停用管理' : '帳戶停用管理'}" ${state.busy ? 'disabled' : ''}>${icon('home', 22)}<span>帳戶停用管理</span><small>${managementMode ? '管理中 · ' : ''}${inactiveAccounts.length} 個停用</small></button>`;
  const eventRows = [...data.accountEvents].sort((a, b) => b.sequence - a.sequence).map((event) => `<tr><td>${esc(event.occurredOn)}</td><td>${esc({ opening: '起始餘額', expense: '支出', income: '收入', transfer: '轉帳', adjustment: '餘額校正' }[event.type])}</td><td>${event.lines.map((line) => `${esc(data.accounts.find((item) => item.id === line.accountId)?.name || '已封存帳戶')} <strong class="${line.deltaTwd < 0 ? 'finance-negative' : 'finance-positive'}">${money(line.deltaTwd, true)}</strong>`).join('<br>')}</td><td>${esc(event.note || '—')}<details><summary>來源識別碼</summary><small>${esc(event.entryId || event.id)}</small></details></td></tr>`).join('');
  const deleteDialog = state.deleteAccount ? (() => {
    const finalConfirmation = state.deleteAccount.confirmStep === 2;
    const title = state.deleteAccount.blockReason
      ? `無法刪除「${esc(state.deleteAccount.name)}」`
      : `${finalConfirmation ? '最後確認刪除' : '刪除預覽'}「${esc(state.deleteAccount.name)}」`;
    const impact = `<p id="account-delete-impact">將移除這個帳戶及它唯一的起始餘額異動。帳戶目前餘額為 <strong>${money(state.deleteAccount.balanceTwd)}</strong>，刪除後不再計入帳戶總額；其他帳戶的收支內容及異動先後順序會保留。</p><p>只有在沒有收支、轉帳、校正或預設／提醒引用時才能刪除；確認時會再次檢查最新資料。</p>`;
    return `<div class="finance-dialog-backdrop" data-account-delete-dialog><section class="finance-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="account-delete-title" aria-describedby="${state.deleteAccount.blockReason ? 'account-delete-block-reason' : 'account-delete-impact'}"><h2 id="account-delete-title">${title}</h2>${state.deleteAccount.blockReason ? `<p id="account-delete-block-reason" class="finance-important">${esc(state.deleteAccount.blockReason)}</p><p>停用後帳戶及歷史明細仍會保留，也不會再被選作新交易帳戶。</p>` : impact}<div class="finance-form-footer">${button('cancel-delete-account', '取消')}${state.deleteAccount.blockReason ? (state.deleteAccount.active ? button('disable-account-from-delete', '停用帳戶') : '') : button('confirm-delete-account', finalConfirmation ? '再次確認並永久刪除' : '繼續，進行第二次確認', 'data-danger="true"')}</div></section></div>`;
  })() : '';
  return `${deleteDialog}<div class="finance-account-layout"><aside class="finance-account-operations"><div class="finance-account-operation-nav"><h2>帳戶操作</h2>${toolbar}</div><div class="finance-account-panel-slot">${operationPanel}</div></aside><main class="finance-account-main"><section class="finance-total"><div><span>全部帳戶總額</span><strong>${money([...balances.values()].reduce((sum, amount) => sum + amount, 0n))}</strong><small>${data.accounts.length} 個帳戶 · ${active} 個使用中 · 總額包含停用帳戶保留的資金</small></div>${accountManagerToggle}</section>${state.accountOrderError ? `<p class="finance-account-order-status" data-account-order-status role="status" aria-live="polite">${esc(state.accountOrderError)}</p>` : ''}<p id="finance-account-order-help" class="visually-hidden" ${managementMode ? 'hidden' : ''}>鍵盤排序：聚焦帳戶卡片，按上方向鍵或下方向鍵移動一格。滑鼠可按住卡片外框拖曳。</p><div class="finance-account-grid" ${managementMode ? '' : 'data-account-sortable'}>${accountList}</div><details class="finance-account-event-history" ${state.accountEventsExpanded ? 'open' : ''}><summary>帳戶異動明細（${data.accountEvents.length}）</summary><div class="finance-table-scroll"><table><thead><tr><th>日期</th><th>異動</th><th>金額</th><th>備註</th></tr></thead><tbody>${eventRows || '<tr><td colspan="4">尚無異動</td></tr>'}</tbody></table></div></details></main></div>`;
}

export function renderRemindersScreen(h) {
  const { state, today, value, button, input, select, section, entryForm, reminderEntryDefaults, reminderFutureCount, money } = h;
  const editing = state.editingRule; const occurrence = state.editingOccurrence;
  const form = editing ? 'rule-edit' : occurrence ? 'occ-edit' : 'reminder'; const base = editing || occurrence;
  let editor = '';
  {
    const entryType = editing?.entryType || occurrence?.entryType || value(form, 'entryType', 'expense');
    const repeat = editing?.repeat || value(form, 'repeat', 'once');
    const defaults = reminderEntryDefaults(form, base, entryType);
    const billFields = repeat === 'once'
      ? input(form, 'billDate', '帳單產生日（選填）', base?.billDate || '', 'date')
      : `<div class="finance-fields">${input(form, 'billMonthsBeforeDue', '付款日前幾個月產生帳單（0–12）', base?.billSchedule?.monthsBeforeDue ?? '', 'number', 'min="0" max="12" step="1"')}${input(form, 'billDay', '帳單產生日序（1–31）', base?.billSchedule?.day ?? '', 'number', 'min="1" max="31" step="1"')}</div>`;
    const scope = editing ? `<label class="finance-check-field"><input type="checkbox" data-finance-form="${form}" data-finance-field="applyFuture" ${value(form, 'applyFuture', 'true') !== 'false' ? 'checked' : ''}>同步更新 ${reminderFutureCount(editing.id)} 個未來尚未逐筆修改的待辦</label><p data-operation-hint>今天、逾期、已完成、已取消及逐筆改過的內容不會被覆蓋。</p>` : '';
    const dateLabel = occurrence ? '本期預計繳款日' : repeat === 'once' ? '預計繳款日' : repeat === 'monthly' ? '首次預計繳款日（每月）' : '首次預計繳款日（每年）';
    const cycleHint = repeat === 'monthly' ? '之後每月使用相同日序，遇短月改用月底。' : repeat === 'yearly' ? '之後每年使用相同月日；非閏年的 2 月 29 日採 2 月 28 日。' : '此項只提醒一次。';
    const paymentMethod = select(form, 'paymentMethod', '付款／收款方式（選填）', [['direct', '依帳戶處理'], ['cash', '現金'], ['convenience-store', '超商繳費'], ['bank-transfer', '銀行轉帳'], ['debit-card', '簽帳金融卡']], value(form, 'paymentMethod', base?.entryDefaults?.paymentMethod || 'direct'));
    const typeSelector = base
      ? `<div class="finance-reminder-fixed-type"><strong>${entryType === 'income' ? '收入' : '支出'}</strong><small>${esc(repeatLabel(editing || { repeat: 'once', firstDueDate: occurrence.dueDate }))} · 建立後固定</small></div>`
      : `<div class="finance-reminder-type-switch" role="group" aria-label="選擇提醒收支類型"><button type="button" class="finance-reminder-type-button expense ${entryType === 'expense' ? 'is-selected' : ''}" data-finance-action="choose-reminder-type" data-entry-type="expense" aria-pressed="${entryType === 'expense'}" ${state.busy ? 'disabled' : ''}>支出</button><button type="button" class="finance-reminder-type-button income ${entryType === 'income' ? 'is-selected' : ''}" data-finance-action="choose-reminder-type" data-entry-type="income" aria-pressed="${entryType === 'income'}" ${state.busy ? 'disabled' : ''}>收入</button></div>`;
    const coreFields = `<div class="finance-reminder-name-type-row"><div class="finance-reminder-name-field">${input(form, 'name', '名稱', base?.name || '', 'text', 'maxlength="60"')}</div><div class="finance-reminder-type-field">${typeSelector}</div></div><div class="finance-fields finance-reminder-core-fields">${input(form, 'amountTwd', '預計金額（整數元）', base?.amountTwd || '', 'number', 'min="1" step="1"')}${editing ? '' : input(form, 'date', dateLabel, occurrence?.dueDate || today(), 'date')}</div>`;
    const scheduleFields = base ? '' : `<div class="finance-reminder-schedule-grid">${select(form, 'repeat', '週期', [['once', '單次'], ['monthly', '每月'], ['yearly', '每年']], 'once')}${input(form, 'advanceDays', '提前提醒天數', base?.advanceDays ?? 1, 'number', 'min="0" max="365" step="1"')}<p class="finance-reminder-cycle-context" data-operation-hint>${cycleHint}</p></div>`;
    const noteField = `<div class="finance-reminder-note-grid">${input(form, 'note', '備註', base?.note || '', 'text', 'maxlength="160"')}</div>`;
    editor = panel(editing ? '修改定期項目' : occurrence ? '編輯本期項目' : '新增定期項目', `${coreFields}${scheduleFields}${noteField}${defaults}<details class="finance-reminder-advanced"><summary>進階選項</summary><div class="finance-fields">${paymentMethod}${billFields}</div><p data-operation-hint>通常選好資金帳戶即可；付款方式是另外的紀錄，不會由帳戶類型推測。帳單日期是資訊用途，與繳款期限及實際記帳日期分開。</p></details>${scope}<p class="finance-important">提醒不會自動入帳或改變帳戶餘額。正式記帳前會再次檢查分類和帳戶。</p><div class="finance-form-footer">${button('save-reminder', '保存定期項目')}</div>`, '');
  }
  let posting = '';
  if (state.posting) {
    const item = state.posting;
    const heading = item.entryType === 'income' ? '確認收到並記帳' : '確認付款並記帳';
    let body = `<p class="finance-posting-source"><strong>${esc(item.name)}</strong> · 第 ${esc(item.periodKey)} 期<br>預計 ${money(item.amountTwd)} · 預定日期 ${esc(item.dueDate)}${item.billDate ? ` · 帳單日 ${esc(item.billDate)}` : ''}。實際日期預設今天，可在本期調整。</p>`;
    if (state.postingPath === 'new') body += `${entryForm()}<div class="finance-confirm-choices">${button('posting-existing', '已經記過帳？關聯既有交易')}</div>`;
    if (state.postingPath === 'existing') {
      const candidates = state.data[item.entryType === 'income' ? 'incomes' : 'expenses'].filter((record) => !record.reminderOccurrenceId);
      const chosen = candidates.find((record) => record.id === value('link', 'entryId'));
      const differs = chosen && (chosen.amountMinor !== item.amountTwd * 100 || chosen.occurredOn !== item.dueDate);
      body += `<p class="finance-important">只關聯同類型的既有紀錄，不新增收支、不新增帳戶異動，也不會再次扣款或入帳。請核對日期及金額。</p>${select('link', 'entryId', '已經記好的交易', [['', '請選擇交易'], ...candidates.map((record) => [record.id, `${record.occurredOn} · ${minorMoney(record.amountMinor)} · ${record.subcategoryNameSnapshot || record.categoryNameSnapshot} · ${record.note || '無備註'}`])])}${chosen ? `<p>將關聯：${esc(chosen.occurredOn)} · ${esc(chosen.categoryNameSnapshot)}。金額 ${minorMoney(chosen.amountMinor)}。${differs ? '<strong>日期或金額與本期預設不同，請確認這是正確的交易。</strong>' : ''}</p>` : ''}<div class="finance-form-footer">${button('cancel-posting', '取消確認')}${button('link-existing', '確認關聯，完成本期')}</div>`;
    }
    posting = `<div class="finance-dialog-backdrop" data-reminder-posting-dialog><section class="finance-posting-dialog" role="dialog" aria-modal="true" aria-labelledby="reminder-posting-title" tabindex="-1" data-finance-focus><header class="finance-posting-dialog-heading"><h2 id="reminder-posting-title">${heading}</h2><p>${esc(item.periodKey)} · ${esc(item.dueDate)}</p></header><div class="finance-posting-dialog-body">${body}</div></section></div>`;
  }
  let deletion = '';
  if (state.deleteRule?.linkedCount) {
    const stopFuture = state.deleteRule.active ? button('request-stop-rule', '停止後續提醒', `data-id="${esc(state.deleteRule.id)}"`) : '';
    deletion = `<div class="finance-dialog-backdrop" data-reminder-delete-dialog><section class="finance-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reminder-delete-title"><h2 id="reminder-delete-title">刪除「${esc(state.deleteRule.name)}」提醒？</h2><p class="finance-important">這項提醒有 ${state.deleteRule.linkedCount} 期已完成或已連結交易。確認刪除會移除提醒規則與期次，解除其提醒關聯，但保留真正的歷史收支及帳戶異動。</p><p>如果交易還有其他提醒、退款或資料引用，系統會拒絕刪除。選擇「停止後續」則保留所有歷史期次與關聯。</p><div class="finance-form-footer">${button('cancel-delete-rule', '取消')}${stopFuture}${button('confirm-delete-rule', `${icon('trash', 16)}刪除提醒，保留歷史收支`, 'data-danger="true"')}</div></section></div>`;
  } else if (state.deleteRule) deletion = `<div class="finance-dialog-backdrop" data-reminder-delete-dialog><section class="finance-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reminder-delete-title"><h2 id="reminder-delete-title">確定要刪除「${esc(state.deleteRule.name)}」嗎？</h2><p>將移除這項提醒及 ${state.deleteRule.count} 個尚未連結的期次；不會變更既有收支或帳戶異動。</p><p>若只想停止未來提醒，請選擇「取消後續」。</p><div class="finance-form-footer">${button('cancel-delete-rule', '取消')}${button('confirm-delete-rule', `${icon('trash', 16)}確認刪除`, 'data-danger="true"')}</div></section></div>`;
  const stopDialog = state.stopRule ? `<div class="finance-dialog-backdrop" data-reminder-stop-dialog><section class="finance-delete-dialog finance-reminder-stop-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reminder-stop-title" tabindex="-1" data-finance-focus><h2 id="reminder-stop-title">確定停止「${esc(state.stopRule.name)}」的後續提醒嗎？</h2><p>停止後不會再產生新的提醒期次，已完成的歷史收支仍會保留。</p>${state.notice ? `<p class="finance-result" role="status" aria-live="polite">${esc(state.notice)}</p>` : ''}<div class="finance-form-footer">${button('cancel-stop-rule', '取消')}${button('confirm-stop-rule', '確認停止', 'data-primary="true"')}</div></section></div>` : '';
  const visible = state.data.reminderOccurrences.filter((item) => state.showCancelled || item.status !== 'cancelled');
  const groups = state.data.reminderRules.filter((rule) => state.showCancelled || rule.active || visible.some((item) => item.ruleId === rule.id)).map((rule) => {
    const occurrences = visible.filter((item) => item.ruleId === rule.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.periodKey.localeCompare(b.periodKey));
    const pending = occurrences.filter((item) => item.status === 'pending');
    const overdue = pending.filter((item) => item.dueDate < today()).length;
    const nearest = pending[0];
    const expanded = state.expandedReminderRules?.has(rule.id) || false;
    const periodCards = occurrences.map((item) => {
      const posted = item.status === 'completed' ? state.data[item.entryType === 'income' ? 'incomes' : 'expenses'].find((entry) => entry.id === item.entryId) : null;
      const actions = item.status === 'pending'
        ? button('review-occurrence', item.entryType === 'income' ? '確認收到並記帳' : '確認付款並記帳', `data-id="${esc(item.id)}"`) + button('edit-occurrence', '編輯本期', `data-id="${esc(item.id)}"`) + button('cancel-occurrence', '取消本期', `data-id="${esc(item.id)}"`)
        : item.status === 'completed' ? button('undo-occurrence', item.entryType === 'income' ? '撤銷本期收款' : '撤銷本期付款', `data-id="${esc(item.id)}" aria-label="撤銷${esc(item.name)} ${esc(item.periodKey)}期${item.entryType === 'income' ? '收款' : '付款'}"`) : '';
      return `<article class="finance-reminder-card ${item.status}">
      <div class="finance-reminder-card-content"><div class="finance-reminder-heading"><h3>${esc(item.name)}</h3><span class="finance-status-badge">${reminderStatus(item, today())}</span></div>
        <strong class="finance-card-balance ${item.entryType === 'income' ? 'finance-positive' : 'finance-negative'}">${item.entryType === 'income' ? '預計收入' : '預計支出'} ${money(item.amountTwd)}</strong>
        <p>${item.billDate ? `帳單 ${esc(item.billDate)} · ` : ''}付款日 ${esc(item.dueDate)} · ${esc(repeatLabel(rule))} · 提前 ${item.advanceDays} 天</p>${item.note ? `<p>${esc(item.note)}</p>` : ''}
        ${item.status === 'completed' ? `<p>已完成 · ${item.completionMode === 'linked' ? '關聯既有交易，沒有新增收支' : '已新增交易'}${posted ? ` · 實際 ${minorMoney(posted.amountMinor)} · ${esc(posted.occurredOn)} · ${esc(state.data.accounts.find((account) => account.id === posted.accountId)?.name || '未指定帳戶')}` : ''}</p><details><summary>查看來源識別碼</summary><small>${esc(item.entryId)}</small></details>` : ''}</div>
      <aside class="finance-reminder-card-operations" aria-label="${esc(item.name)}的提醒操作">${actions}</aside>
      </article>`;
    }).join('');
    const ruleActions = `${rule.active ? button('edit-rule', '編輯規則', `data-id="${esc(rule.id)}"`) + button('request-stop-rule', '停止後續', `data-id="${esc(rule.id)}"`) : ''}${button('delete-rule', `${icon('trash', 15)}刪除`, `data-id="${esc(rule.id)}" aria-label="刪除提醒「${esc(rule.name)}」" title="永久刪除提醒" data-danger="true"`)}`;
    return `<section class="finance-reminder-rule-group"><div class="finance-reminder-rule-heading"><button type="button" class="finance-reminder-rule-toggle" data-finance-action="toggle-reminder-rule" data-id="${esc(rule.id)}" aria-expanded="${expanded}" aria-controls="reminder-occurrences-${esc(rule.id)}"><span class="finance-reminder-rule-chevron" aria-hidden="true">${icon('chevron', 16)}</span><span class="finance-reminder-rule-title"><strong>${esc(rule.name)}</strong><small>${esc(repeatLabel(rule))} · ${rule.active ? '提醒中' : '已停止後續'}</small></span><span class="finance-reminder-rule-summary"><strong>${money(rule.amountTwd)}</strong><small>${pending.length} 期待處理${overdue ? ` · ${overdue} 期逾期` : ''}</small><small>${nearest ? `最近 ${esc(nearest.dueDate)}` : occurrences.length ? '沒有待處理期次' : '尚無期次'}</small></span></button><aside class="finance-reminder-rule-actions" aria-label="${esc(rule.name)}的規則操作">${ruleActions}</aside></div><div id="reminder-occurrences-${esc(rule.id)}" class="finance-reminder-rule-occurrences" ${expanded ? '' : 'hidden'}>${periodCards || '<p class="finance-empty">目前沒有可顯示的期次。</p>'}</div></section>`;
  }).join('');
  const undoDialog = state.undoOccurrence ? (() => {
    const { occurrence, record } = state.undoOccurrence;
    const created = (occurrence.completionMode || 'created') === 'created';
    return `<div class="finance-dialog-backdrop" data-reminder-undo-dialog><section class="finance-delete-dialog finance-reminder-undo-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reminder-undo-title" tabindex="-1" data-finance-focus><h2 id="reminder-undo-title">撤銷「${esc(occurrence.name)}」${esc(occurrence.periodKey)}期？</h2><p class="finance-important">交易：${esc(record.occurredOn)} · ${minorMoney(record.amountMinor)} · ${esc(record.categoryNameSnapshot || '未分類')}</p><p>${created ? '這筆收支是按提醒時建立的。確認後會在同一筆資料庫交易中撤銷此收支與對應帳戶異動，並將本期期次恢復為待處理。' : '這期只連結到先前已存在的收支。確認後只解除提醒與交易關聯，原收支及帳戶異動完全保留。'}</p><div class="finance-form-footer">${button('cancel-undo-occurrence', '取消')}${button('confirm-undo-occurrence', created ? (occurrence.entryType === 'income' ? '撤銷收款與記帳' : '撤銷付款與記帳') : '只解除提醒關聯', 'data-danger="true"')}</div></section></div>`;
  })() : '';
  const cancelledButton = button('toggle-cancelled', state.showCancelled ? '隱藏已取消' : '查看已取消', `aria-pressed="${Boolean(state.showCancelled)}"`);
  const emptyState = `<section class="finance-section finance-reminder-empty-state"><div class="finance-panel-heading finance-reminder-empty-heading"><h2>目前沒有定期項目</h2>${cancelledButton}</div><p data-operation-hint>新增定期項目後會在這裡顯示。</p><p class="finance-important">提醒未確認前不影響帳戶餘額。</p></section>`;
  const listToolbar = groups ? `<div class="finance-reminder-list-toolbar">${cancelledButton}</div>` : '';
  return `<div class="finance-reminder-layout"><aside class="finance-reminder-operations" aria-label="定期收支新增與修改"><div id="finance-reminder-editor" class="finance-reminder-editor-slot">${editor}</div>${deletion ? `<div class="finance-reminder-transient-slot">${deletion}</div>` : ''}</aside><main class="finance-reminder-main">${listToolbar}<div class="finance-reminder-rule-list ${groups ? '' : 'is-empty'}">${groups || emptyState}</div></main></div>${posting}${undoDialog}${stopDialog}`;
}
