// 車牌比對：標準化、完全比對、容錯比對

// 容易混淆的字元，同一組內互換只算小差異
const CONFUSABLE_GROUPS = ['0ODQ', '1I7', '8B', '5S', '2Z', '6G'];
const CONFUSABLE_COST = 0.3;
const MAX_DISTANCE = 1.5;
const MAX_CANDIDATES = 3;
const MIN_PARTIAL_DIGITS = 3;

const groupOf = new Map();
CONFUSABLE_GROUPS.forEach((g, i) => [...g].forEach((ch) => groupOf.set(ch, i)));

/** 轉半形、轉大寫、只留英數字：「ａｂｃ-1234」→「ABC1234」 */
export function normalizePlate(s) {
  return String(s ?? '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function substitutionCost(a, b) {
  if (a === b) return 0;
  const ga = groupOf.get(a);
  return ga !== undefined && ga === groupOf.get(b) ? CONFUSABLE_COST : 1;
}

/** 加權編輯距離：混淆字元互換 0.3，其他替換、插入、刪除各 1 */
export function plateDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(up + 1, prev[j - 1] + 1, diag + substitutionCost(a[i - 1], b[j - 1]));
      diag = up;
    }
  }
  return prev[b.length];
}

export class PlateIndex {
  constructor(records) {
    this.records = records;
    this.byKey = new Map();
    for (const r of records) {
      const key = normalizePlate(r.plate);
      if (!key) continue;
      if (!this.byKey.has(key)) this.byKey.set(key, []);
      this.byKey.get(key).push(r);
    }
  }

  /**
   * 查詢車牌，回傳：
   *   { kind: 'exact', records }             完全相符
   *   { kind: 'digits', records }            只輸入數字，數字部分完全相同的車牌
   *   { kind: 'partial', records }           只輸入數字，數字部分包含輸入內容的車牌
   *   { kind: 'fuzzy', candidates: [...] }   相近候選（依相似度排序）
   *   { kind: 'none' }                       查無資料
   */
  search(query) {
    const key = normalizePlate(query);
    if (!key) return { kind: 'none' };

    const exact = this.byKey.get(key);
    if (exact) return { kind: 'exact', records: exact };

    if (/^\d+$/.test(key)) return this.searchDigits(key);

    const candidates = [];
    for (const [k, recs] of this.byKey) {
      if (Math.abs(k.length - key.length) > 1) continue;
      const d = plateDistance(key, k);
      if (d <= MAX_DISTANCE) recs.forEach((r) => candidates.push({ record: r, distance: d }));
    }
    if (!candidates.length) return { kind: 'none' };
    candidates.sort((a, b) => a.distance - b.distance || a.record.plate.localeCompare(b.record.plate));
    return { kind: 'fuzzy', candidates: candidates.slice(0, MAX_CANDIDATES) };
  }

  /**
   * 只輸入數字時：先找數字部分完全相同的車牌（1234 → ABC-1234、1234-AB）；
   * 找不到且輸入至少 3 碼時，再找數字部分包含輸入內容的車牌（234 → ABC-1234）。
   */
  searchDigits(digits) {
    const equal = [];
    const partial = [];
    for (const [k, recs] of this.byKey) {
      const plateDigits = k.replace(/[A-Z]/g, '');
      if (plateDigits === digits) equal.push(...recs);
      else if (digits.length >= MIN_PARTIAL_DIGITS && plateDigits.includes(digits)) partial.push(...recs);
    }
    const byPlate = (a, b) => a.plate.localeCompare(b.plate);
    if (equal.length) return { kind: 'digits', records: equal.sort(byPlate) };
    if (partial.length) return { kind: 'partial', records: partial.sort(byPlate) };
    return { kind: 'none' };
  }

  /** 同一位車主（姓名＋電話相同）名下的其他車牌 */
  otherVehicles(record) {
    return this.records.filter(
      (r) => r !== record && r.name === record.name && r.phone === record.phone
    );
  }
}
