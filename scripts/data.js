export const incomeCategories = [
  { id: 'income-pocket-money', name: '零用錢', icon: 'wallet', color: '#42B982' },
  { id: 'income-part-time', name: '打工', icon: 'clock', color: '#65C66D' },
  { id: 'income-prize', name: '中獎', icon: 'ticket', color: '#A5C94D' },
  { id: 'income-other', name: '其他收入', icon: 'gift', color: '#39BFA7' },
];

export const incomeSubcategories = [
  { id: 'sub-income-allowance', name: '日常零用錢', categoryIds: ['income-pocket-money'] },
  { id: 'sub-income-wage', name: '薪資', categoryIds: ['income-part-time'] },
  { id: 'sub-income-prize', name: '獎金', categoryIds: ['income-prize'] },
  { id: 'sub-income-other', name: '其他', categoryIds: ['income-other'] },
];

export const navigation = [
  { id: 'ledger', label: '記帳總覽', icon: 'wallet', title: '記帳總覽', subtitle: '掌握日常收支，慢慢看見自己的消費節奏。' },
  { id: 'add-entry', label: '新增記帳', icon: 'plus', title: '新增記帳', subtitle: '快速記下一筆生活中的收支。' },
  { id: 'history', label: '歷史紀錄', icon: 'history', title: '歷史紀錄', subtitle: '回看每一段日常留下的足跡。' },
  { id: 'analytics', label: '統計分析', icon: 'chart', title: '統計分析', subtitle: '從累積的紀錄中發現生活趨勢。' },
  { id: 'accounts', label: '資金帳戶', icon: 'bank', title: '資金帳戶', subtitle: '整理不同帳戶與資金配置。' },
  { id: 'reminders', label: '訂閱', icon: 'bell', title: '訂閱', subtitle: '管理固定收支，並在實際付款或收款時確認記帳。' },
];
