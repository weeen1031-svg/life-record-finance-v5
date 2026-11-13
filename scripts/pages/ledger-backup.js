import { escapeHTML } from '../escape-html.js';
import { icon } from '../icons.js';

export function createBackupPageState() {
  return { busy: false, notice: '', tone: '', preview: null, expectedToken: '', confirmation: '', previewMatchesCurrent: false, backupSavedOutsideProfile: false, previewConfirmation: '', selectedBackupName: '', fileValidationStatus: '尚未選擇檔案' };
}

export function renderLedgerBackupPage(state) {
  const info = state.preview;
  const counts = info?.summary;
  const unavailable = state.busy || state.catalogReady === false;
  const previewEnvironmentBlocked = state.previewEnvironmentAllowed === false;
  const filePicker = (label, attribute, disabled) => `<label class="finance-file-picker${disabled ? ' is-disabled' : ''}"><span class="finance-file-picker-action">${label}</span><span class="finance-file-picker-name">${escapeHTML(state.selectedBackupName || '尚未選擇檔案')}</span><span class="finance-file-picker-status" role="status" aria-live="polite">${escapeHTML(state.fileValidationStatus || '尚未選擇檔案')}</span><input type="file" accept=".json,application/json" ${attribute} aria-label="${label}" ${disabled ? 'disabled' : ''}></label>`;
  return `<div class="page-heading inner-page-heading"><div><div class="eyebrow">LOCAL DATA</div><h1>記帳資料備份與還原</h1><p class="page-subtitle">完整保存目前正式收入、支出與分類設定。</p></div><button class="quiet-button app-back-control" type="button" data-action="app-back">${icon('chevron', 15)}返回上一頁</button></div>
    ${state.catalogReady === false ? `<p class="history-status" role="status">${escapeHTML(state.catalogError || '分類設定載入中，完成後即可備份與預覽還原。')}${state.catalogError ? '<button class="quiet-button" type="button" data-action="retry-category-load">重試載入分類</button>' : ''}</p>` : ''}
    <p class="backup-privacy">JSON 備份是可直接閱讀的明文，可能包含私人備註，請自行妥善保存。本功能只在本機處理，不上傳雲端。SHA-256 驗證內容一致性，不代表加密或來源可信。</p>
    <div class="backup-page-grid"><section class="finance-panel-card"><h2>匯出完整記帳備份</h2><p>包含收入、支出、大分類、子分類、名稱快照、顏色、圖示、排序、隱藏狀態與共用關聯。</p><p>帳戶、預算、提醒、日記與睡眠尚未正式保存，因此不在這一版備份範圍內。頁面草稿及布局偏好也不包含在內。</p><button class="primary-button" type="button" data-action="export-ledger-backup" ${unavailable ? 'disabled' : ''}>${icon('receipt', 17)}下載完整 JSON 備份</button></section>
    <section class="finance-panel-card"><h2>完整還原</h2><p>選檔只會驗證和預覽。確認還原後，備份中的收入、支出及分類會完整取代目前的記帳資料；建議先匯出目前資料。</p>${filePicker('選擇備份檔', 'data-backup-file', unavailable)}<small>版本 1 · 正式資料庫 v3 · 上限 20 MiB／50,000 筆收支。僅支援本功能匯出的 JSON。</small>
    ${info ? `<div class="backup-preview"><h3>驗證通過，尚未還原</h3><p>備份時間：${escapeHTML(info.exportedAt)}</p><p>支出 ${counts.expenses} 筆、收入 ${counts.incomes} 筆、大分類 ${counts.categories} 個、子分類 ${counts.subcategories} 個。</p>${counts.historicalReferences ? `<p>其中 ${counts.historicalReferences} 筆舊紀錄缺少目前分類關聯，將依原 ID 與名稱快照保留，不補造分類。</p>` : ''}<p>目前資料：支出 ${info.currentSummary?.expenses ?? 0} 筆、收入 ${info.currentSummary?.incomes ?? 0} 筆。此操作會完整取代目前記帳資料；其他分頁若在預覽後變更資料，還原將自動取消。</p><label class="entry-control"><span>請輸入「完整還原」確認影響</span><input type="text" data-field="restore-confirmation" autocomplete="off" value="${escapeHTML(state.confirmation)}"></label><button class="quiet-button danger-quiet-button" type="button" data-action="confirm-ledger-restore" ${unavailable || state.confirmation !== '完整還原' ? 'disabled' : ''}>確認取代記帳資料</button></div>` : ''}</section></div>
    <section class="finance-panel-card finance-v4-preview-panel">
      <h2>V4 開發版</h2>
      <p class="finance-preview-state"><strong>目前狀態：尚未啟用</strong></p>
      <p>這會在<strong>目前這個瀏覽器設定檔</strong>，把 <code>LifeRecord_Official_V1</code> 從 v3 升級到 v4。升級後，此設定檔的一般記帳、歷史、帳戶、預算、提醒及設定會共用 V4 資料；IndexedDB 不能直接降回 v3。</p>
      <p class="finance-important">請先下載 V3 備份，將檔案另存到此瀏覽器設定檔以外的位置，再選取該備份。只有內容與目前 V3 資料逐筆相同且通過 SHA-256 驗證時，才可繼續。請確認目前是要升級的測試瀏覽器設定檔；不要在其他含有日常資料的設定檔啟用。</p>
      <p>資料庫：<code>LifeRecord_Official_V1</code>　升級：v3 → v4</p>
      ${previewEnvironmentBlocked ? '<p class="finance-important">開發預覽只允許從 http://127.0.0.1:5510/ 主頁啟用；目前頁面不符合條件。</p>' : ''}
      ${filePicker('選擇已保存的目前 V3 備份', 'data-v4-preview-file', unavailable || previewEnvironmentBlocked)}
      ${info ? `<div class="backup-preview"><h3>${state.previewMatchesCurrent ? '目前 V3 備份已核對' : '備份有效，但與目前資料不完全相同'}</h3><p>V3 支出 ${counts.expenses} 筆、收入 ${counts.incomes} 筆；分類目錄也納入逐筆比對。</p><p>${state.previewMatchesCurrent ? '備份內容與目前資料相同。若先前資料或分類曾變更，請重新匯出再選取。' : '此備份不能用來批准升級。請重新匯出目前 V3 備份，再選取最新檔案。'}</p>
        <label class="entry-control"><input type="checkbox" data-field="v4-backup-saved" ${state.backupSavedOutsideProfile ? 'checked' : ''} ${unavailable ? 'disabled' : ''}><span>我已確認 V3 備份檔已下載，並保存在目前瀏覽器設定檔以外</span></label>
        <label class="entry-control"><span>輸入「啟用 V4 開發預覽」</span><input type="text" data-field="v4-preview-confirmation" autocomplete="off" value="${escapeHTML(state.previewConfirmation)}" ${unavailable ? 'disabled' : ''}></label>
        <button class="primary-button" type="button" data-action="enable-v4-preview" ${unavailable || previewEnvironmentBlocked || !state.previewMatchesCurrent || !state.backupSavedOutsideProfile || state.previewConfirmation !== '啟用 V4 開發預覽' ? 'disabled' : ''}>啟用 V4 開發版</button>
      </div>` : '<p class="finance-result">尚未驗證 V3 備份；升級尚未開始。</p>'}
    </section>
    <p class="history-status ${state.tone}" role="status" aria-live="polite">${escapeHTML(state.busy ? '正在處理，請勿重複操作…' : state.notice || '尚未開始。選擇備份檔案不會更動資料。')}</p>
    <section class="finance-panel-card ledger-reset-panel"><h2>記帳模組全部歸零</h2><p>目前停用：正式 JSON 還原仍待 Brave 實機驗收。開放前必須先提供備份與二次確認，歸零後保留收入、支出各一組有效的「其他 → 未分類」。</p><button type="button" class="quiet-button" disabled>全部歸零尚未開放</button><small>歸零入口目前不會執行任何資料操作；未來也只影響記帳模組。</small></section>`;
}
