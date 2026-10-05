// A small CSV reader (RFC 4180): fields in double quotes may hold commas, line breaks and ""
// (a quote). A UTF-8 byte-order mark is dropped. The separator is a comma, or a semicolon when
// the first line has more semicolons than commas (Excel in some regions saves CSV that way).
// Returns rows as arrays of strings; empty lines are skipped.
function parseCsv(text) {
  const source = String(text || '').replace(/^﻿/, '');
  const firstLine = source.slice(0, source.search(/\r?\n/) === -1 ? source.length : source.search(/\r?\n/));
  const separator = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((value) => value.trim()));
}

module.exports = { parseCsv };
