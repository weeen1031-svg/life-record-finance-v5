// JSON-only encoding shared by backup checks and restore concurrency checks.
export function stableJson(value, depth = 0) {
  if (depth > 40) throw new Error('資料巢狀層級過深。');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(',')}]`;
  const prototype = value && Object.getPrototypeOf(value);
  if (!value || Object.prototype.toString.call(value) !== '[object Object]'
    || (prototype !== null && prototype.constructor?.name !== 'Object')) throw new Error('備份只支援一般 JSON 資料。');
  return `{${Object.keys(value).sort().map((key) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('資料包含不允許的欄位。');
    return `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`;
  }).join(',')}}`;
}

// Reject duplicate object keys instead of silently taking their final value.
export function parseStrictJson(text) {
  let index = 0;
  const primitive = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const whitespace = () => { while (/[ \t\r\n]/.test(text[index] || '') && index < text.length) index += 1; };
  function string() {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') { index += 1; continue; }
      if (char === '"') return JSON.parse(text.slice(start, index));
    }
    throw new Error('JSON 字串不完整。');
  }
  function value(depth = 0) {
    if (depth > 40) throw new Error('JSON 巢狀層級過深。');
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === '{') {
      index += 1; whitespace(); const result = {}; const keys = new Set();
      if (text[index] === '}') { index += 1; return result; }
      while (index < text.length) {
        whitespace(); if (text[index] !== '"') throw new Error('JSON 欄位名稱無效。');
        const key = string();
        if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('JSON 包含重複或不允許的欄位。');
        keys.add(key); whitespace(); if (text[index++] !== ':') throw new Error('JSON 欄位缺少冒號。');
        result[key] = value(depth + 1); whitespace();
        const next = text[index++]; if (next === '}') return result;
        if (next !== ',') throw new Error('JSON 物件不完整。');
      }
    } else if (text[index] === '[') {
      index += 1; whitespace(); const result = [];
      if (text[index] === ']') { index += 1; return result; }
      while (index < text.length) {
        result.push(value(depth + 1)); whitespace();
        const next = text[index++]; if (next === ']') return result;
        if (next !== ',') throw new Error('JSON 陣列不完整。');
      }
    } else {
      primitive.lastIndex = index;
      const token = primitive.exec(text);
      if (token) { index = primitive.lastIndex; const parsed = JSON.parse(token[0]); if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('JSON 數值超出範圍。'); return parsed; }
    }
    throw new Error('JSON 格式無效或內容不完整。');
  }
  const result = value(); whitespace();
  if (index !== text.length) throw new Error('JSON 結尾有額外內容。');
  return result;
}
