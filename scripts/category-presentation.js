import { categoryIconChoices } from './category-store.js';

const icons = new Set(categoryIconChoices.map((item) => item.id));
const validColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

// Presentation only: never repairs or rewrites a historical record.
export function getRecordCategoryPresentation(record, store) {
  const category = store.getCategory(record.categoryId);
  if (category && category.entryType === record.recordType && icons.has(category.icon) && validColor(category.color)) {
    return { iconName: category.icon, color: category.color };
  }
  return {
    iconName: icons.has(record.categoryIconSnapshot) ? record.categoryIconSnapshot : 'receipt',
    color: validColor(record.categoryColorSnapshot) ? record.categoryColorSnapshot : '#8795A7',
  };
}
