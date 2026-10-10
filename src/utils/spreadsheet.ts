import ExcelJS from 'exceljs';

export type Cell = string | number | Date | null | undefined;
export interface Sheet {
  headers: string[];
  rows: Cell[][];
}

const BOM = String.fromCharCode(0xfeff);
const text = (v: Cell) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v));

/** CSV with a BOM (Excel opens UTF-8 correctly) and formula injection neutralised. */
export function toCsv(sheet: Sheet): Buffer {
  const cell = (v: Cell) => {
    const s = text(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return Buffer.from(`${BOM}${[sheet.headers, ...sheet.rows].map((r) => r.map(cell).join(',')).join('\r\n')}`, 'utf8');
}

export async function toXlsx(sheet: Sheet, name: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.addRow(sheet.headers).font = { bold: true };
  // Strings that look like formulas are written as text, never evaluated.
  for (const r of sheet.rows) ws.addRow(r.map((v) => (typeof v === 'string' && /^[=+\-@]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : (v ?? null))));
  ws.columns.forEach((c) => (c.width = 18));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const CONTENT_TYPES = { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const;
