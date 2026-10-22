const zlib = require('zlib');

// Excel files (.xlsx) without a library (Phase 4A, D82). An .xlsx is a zip of XML files; Node's
// zlib does the compression and the CRC, and this file does the zip layout and the little XML
// Excel needs.
//   write(sheets) → Buffer: [{ name, rows: [[cell, …], …] }], row 0 the header (bold, frozen,
//     with filters). Cells: strings (always text, never a formula), numbers, booleans, Dates
//     (shown as dates), null/'' (empty).
//   read(buffer) → { rows: [[text, …], …] } of the first sheet, every cell as text like a CSV
//     (dates as YYYY-MM-DD, or YYYY-MM-DD HH:MM with a time).
// Files over 25 MB uncompressed, zip64 and encrypted files are refused.

const MAX_UNPACKED = 25 * 1024 * 1024;

const fail = (message) => Object.assign(new Error(message), { statusCode: 400, code: 'BAD_EXCEL_FILE' });

// --- zip ----------------------------------------------------------------------------------------
function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zip(files) {
  const { time, day } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function unzip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw fail('This is not an Excel (.xlsx) file, or it is damaged.');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  let unpacked = 0;
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw fail('This Excel file is damaged.');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const packedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw fail('This Excel file has a password. Save it without one, then import it.');
    if (packedSize === 0xffffffff || size === 0xffffffff) throw fail('This Excel file is too big.');
    unpacked += size;
    if (unpacked > MAX_UNPACKED) throw fail('This Excel file is too big.');
    files.set(name, () => {
      const start = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
      const raw = buffer.subarray(start, start + packedSize);
      if (method === 0) return raw.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(raw).toString('utf8');
      throw fail('This Excel file is packed in a way the CRM cannot read. Save it again in Excel.');
    });
  }
  return files;
}

// --- XML ----------------------------------------------------------------------------------------
// Characters XML 1.0 does not allow (control characters) are dropped.
const escapeXml = (text) => String(text)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '') // eslint-disable-line no-control-regex
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescapeXml = (text) => String(text)
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (attrs, name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
// The text of every <t> inside (rich text has several).
const textOf = (xml) => [...String(xml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((m) => unescapeXml(m[1] || '')).join('');

const columnName = (index) => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const columnIndex = (ref) => [...String(ref).replace(/\d+$/, '')].reduce((sum, ch) => sum * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

// --- write --------------------------------------------------------------------------------------
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const serialOf = (date) => (date.getTime() + 330 * 60 * 1000 - EXCEL_EPOCH) / 86400000; // India time

function cellXml(value, ref, header) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return `<c r="${ref}" s="2"><v>${serialOf(value)}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${header ? ' s="1"' : ''}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(rows) {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const widths = Array.from({ length: width }, (_, c) => Math.min(60, Math.max(8, ...rows.slice(0, 200).map((row) => String(row[c] instanceof Date ? '2026-01-01 10:00' : row[c] ?? '').length + 2))));
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => cellXml(value, `${columnName(c)}${r + 1}`, r === 0)).join('')}</row>`).join('');
  const last = `${columnName(width - 1)}${Math.max(rows.length, 1)}`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="A1:${last}"/>`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${body}</sheetData>`
    + (rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : '')
    + '</worksheet>';
}

// Sheet names: at most 31 characters, none of []:*?/\ (Excel's rules), and each unique.
const sheetName = (name, index) => (String(name || `Sheet${index + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${index + 1}`);

function write(sheets) {
  const list = (Array.isArray(sheets) ? sheets : [sheets]).map((sheet, i) => ({ name: sheetName(sheet.name, i), rows: sheet.rows || [] }));
  const NS = 'http://schemas.openxmlformats.org';
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets>${list.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${list.length + 1}" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    // Styles: 0 normal, 1 bold (the header), 2 a date (dd-mm-yyyy hh:mm).
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\-mm\\-yyyy\\ hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`],
    ...list.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.rows)]),
  ];
  return zip(files);
}

// --- read ---------------------------------------------------------------------------------------
// Number formats that are dates: Excel's built-in ones, and custom ones with d, m, y or h outside
// quotes and brackets.
const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateFormat = (code) => /[dmyh]/i.test(String(code).replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map([...stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)].map((m) => [Number(attr(m[1], 'numFmtId')), unescapeXml(attr(m[1], 'formatCode') || '')]));
  const xfs = (stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  const dates = new Set();
  [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].forEach((m, index) => {
    const id = Number(attr(m[1], 'numFmtId') || 0);
    if (BUILTIN_DATES.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dates.add(index);
  });
  return dates;
}

function dateText(serial) {
  const ms = Math.round(EXCEL_EPOCH + serial * 86400000);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// A number as Excel saved it ("919876543210", "0.5"), without scientific notation.
const numberText = (raw) => (/e/i.test(raw) ? Number(raw).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 15 }) : raw);

function firstSheetPath(files) {
  const workbook = files.get('xl/workbook.xml')?.() || '';
  const first = workbook.match(/<sheet\b([^>]*)\/?>/);
  const id = first && (attr(first[1], 'r:id') || attr(first[1], 'id'));
  const rels = files.get('xl/_rels/workbook.xml.rels')?.() || '';
  const rel = id && [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].find((m) => attr(m[1], 'Id') === id);
  const target = rel && attr(rel[1], 'Target');
  if (!target) return 'xl/worksheets/sheet1.xml';
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

function read(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw fail('This is not an Excel (.xlsx) file, or it is damaged.');
  const files = unzip(buffer);
  const sheet = files.get(firstSheetPath(files));
  if (!sheet || !files.has('xl/workbook.xml')) throw fail('This is not an Excel (.xlsx) file, or it is damaged.');
  const strings = [...(files.get('xl/sharedStrings.xml')?.() || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const dates = dateStyles(files.get('xl/styles.xml')?.());
  const rows = [];
  for (const rowMatch of sheet().matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rowMatch[1], 'r')) || rows.length + 1;
    const cells = [];
    let next = 0;
    for (const cell of (rowMatch[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cell[1], 'r');
      const index = ref ? columnIndex(ref) : next;
      next = index + 1;
      const type = attr(cell[1], 't') || 'n';
      const inner = cell[2] || '';
      const raw = unescapeXml((inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1] || '');
      let text = '';
      if (type === 's') text = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') text = textOf(inner);
      else if (type === 'b') text = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
      else if (type === 'e') text = '';
      else if (type === 'str') text = raw;
      else if (raw !== '' && dates.has(Number(attr(cell[1], 's') || 0)) && Number.isFinite(Number(raw))) text = dateText(Number(raw));
      else text = numberText(raw);
      cells[index] = text.trim();
    }
    rows[rowNumber - 1] = Array.from({ length: cells.length }, (_, i) => cells[i] ?? '');
  }
  const dense = Array.from({ length: rows.length }, (_, i) => rows[i] || []);
  const width = Math.max(0, ...dense.map((row) => row.length));
  // Rows with nothing in them are left out (Excel keeps formatted empty rows).
  return { rows: dense.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? '')).filter((row) => row.some((cell) => cell !== '')) };
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

module.exports = { write, read, zip, unzip, columnName, XLSX_TYPE };
