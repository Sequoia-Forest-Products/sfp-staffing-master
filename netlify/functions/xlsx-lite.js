// A minimal, dependency-free .xlsx reader.
//
// The only spreadsheet this app ever ingests is the payroll vendor's export:
// one sheet, one header row, ~60 data rows, text and numbers only. A full
// spreadsheet library is a lot of surface area to take on for that, especially
// for code that parses attachments arriving in a shared mailbox — so this reads
// the two things an .xlsx actually is: a ZIP container, and some XML inside it.
//
// What is deliberately NOT supported, because the vendor file never uses it:
// dates as serial numbers (there is no date column — see the ingestion docs),
// formulas beyond their cached value, styles, merged cells, and ZIP64.
// Anything unsupported raises rather than guessing.

const zlib = require('zlib');

// ============================================================
// ZIP CONTAINER
// ============================================================

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

// The end-of-central-directory record sits at the very end of the file, after a
// comment field of up to 64 KB. Scan backwards for its signature.
function findEndOfCentralDirectory(buf) {
  const earliest = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

// Returns { [entryName]: Buffer }. Directory entries are skipped.
function unzip(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('unzip expects a Buffer');
  if (buf.length < 22) throw new Error('File is too small to be a .xlsx (ZIP) file');

  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) {
    throw new Error('Not a .xlsx file: no ZIP end-of-central-directory record found');
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const files = {};

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt .xlsx: bad central directory entry at byte ${offset}`);
    }

    const method         = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength     = buf.readUInt16LE(offset + 28);
    const extraLength    = buf.readUInt16LE(offset + 30);
    const commentLength  = buf.readUInt16LE(offset + 32);
    const localOffset    = buf.readUInt32LE(offset + 42);
    const name           = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // directory marker

    // The local header repeats the name and extra fields, and its extra field
    // length routinely differs from the central one — always read it here
    // rather than reusing the central directory's value.
    const localNameLength  = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      files[name] = Buffer.from(raw);
    } else if (method === 8) {
      try {
        files[name] = zlib.inflateRawSync(raw);
      } catch (err) {
        throw new Error(`Corrupt .xlsx: could not decompress "${name}" (${err.message})`);
      }
    } else {
      throw new Error(`Unsupported .xlsx compression method ${method} for "${name}"`);
    }
  }

  return files;
}

// ============================================================
// XML
// ============================================================

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"
};

function decodeXml(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? match : named;
  });
}

// Every <tag ...>inner</tag>, plus self-closing <tag ... />, in document order.
// Self-closing tags yield inner === ''.
function* eachElement(xml, tag) {
  const open = new RegExp(`<${tag}(\\s[^>]*?)?(/?)>`, 'g');
  let match;
  while ((match = open.exec(xml)) !== null) {
    const attrs = match[1] || '';
    if (match[2] === '/') {
      yield { attrs, inner: '' };
      continue;
    }
    const close = xml.indexOf(`</${tag}>`, open.lastIndex);
    if (close === -1) {
      yield { attrs, inner: xml.slice(open.lastIndex) };
      return;
    }
    yield { attrs, inner: xml.slice(open.lastIndex, close) };
    open.lastIndex = close + tag.length + 3;
  }
}

function attr(attrs, name) {
  const match = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

// Concatenate every <t> under an element, which is how a shared string with
// rich-text runs (<r><t>Bo</t></r><r><t>lt</t></r>) is spelled.
function textOf(xml) {
  let out = '';
  for (const t of eachElement(xml, 't')) out += decodeXml(t.inner);
  return out;
}

// ============================================================
// SPREADSHEET
// ============================================================

// 'A' -> 0, 'Z' -> 25, 'AA' -> 26. The digits in a cell ref are the row.
function columnIndex(cellRef) {
  let index = 0;
  for (let i = 0; i < cellRef.length; i++) {
    const code = cellRef.charCodeAt(i);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function rowNumber(cellRef) {
  const match = cellRef.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function readSharedStrings(files) {
  const xml = files['xl/sharedStrings.xml'];
  if (!xml) return [];
  const text = xml.toString('utf8');
  const strings = [];
  for (const si of eachElement(text, 'si')) strings.push(textOf(si.inner));
  return strings;
}

function cellValue(attrs, inner, sharedStrings) {
  const type = attr(attrs, 't');

  if (type === 'inlineStr') {
    const text = textOf(inner);
    return text === '' ? null : text;
  }

  let raw = null;
  for (const v of eachElement(inner, 'v')) { raw = decodeXml(v.inner); break; }
  if (raw === null || raw === '') return null;

  if (type === 's') {
    const index = parseInt(raw, 10);
    const value = sharedStrings[index];
    return value === undefined || value === '' ? null : value;
  }
  if (type === 'str') return raw === '' ? null : raw;
  if (type === 'b') return raw === '1';
  if (type === 'e') return null; // #N/A and friends read as empty

  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}

// Sheet name -> part path, resolved through workbook.xml + its rels.
function sheetPaths(files) {
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new Error('Not a .xlsx file: xl/workbook.xml is missing');

  const relsXml = files['xl/_rels/workbook.xml.rels'];
  const targets = {};
  if (relsXml) {
    for (const rel of eachElement(relsXml.toString('utf8'), 'Relationship')) {
      const id = attr(rel.attrs, 'Id');
      let target = attr(rel.attrs, 'Target');
      if (!id || !target) continue;
      target = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
      targets[id] = `xl/${target}`;
    }
  }

  const order = [];
  const byName = {};
  let fallback = 1;

  for (const sheet of eachElement(workbook.toString('utf8'), 'sheet')) {
    const name = attr(sheet.attrs, 'name');
    if (!name) continue;
    const relId = attr(sheet.attrs, 'r:id') || attr(sheet.attrs, 'id');
    const path = (relId && targets[relId]) || `xl/worksheets/sheet${fallback}.xml`;
    fallback++;
    order.push(name);
    byName[name] = path;
  }

  if (!order.length) throw new Error('This .xlsx contains no worksheets');
  return { order, byName };
}

// Read one worksheet part into { headers, rows }.
//
// Row 1 is the header row. Columns are keyed by their header text, trimmed. A
// column with a blank header is exposed under its spreadsheet letter so its
// data is never silently dropped; duplicate headers get a "Name (2)" suffix for
// the same reason.
function readSheetPart(xmlBuffer, sharedStrings) {
  const xml = xmlBuffer.toString('utf8');
  const headersByColumn = [];
  const rows = [];
  let seenHeaderRow = false;

  for (const row of eachElement(xml, 'row')) {
    const cells = [];
    let maxColumn = -1;
    let nextColumn = 0;

    for (const c of eachElement(row.inner, 'c')) {
      const ref = attr(c.attrs, 'r');
      // The ref is optional in the spec; without it, cells are positional.
      const col = ref ? columnIndex(ref) : nextColumn;
      nextColumn = col + 1;
      cells[col] = cellValue(c.attrs, c.inner, sharedStrings);
      if (col > maxColumn) maxColumn = col;
    }

    if (!seenHeaderRow) {
      // Skip blank leading rows so a file with a spacer row still parses.
      if (maxColumn < 0) continue;
      seenHeaderRow = true;
      const used = new Set();
      for (let col = 0; col <= maxColumn; col++) {
        const raw = cells[col];
        let name = raw === null || raw === undefined ? '' : String(raw).trim();
        if (!name) name = columnLetter(col);
        let unique = name;
        let n = 2;
        while (used.has(unique)) unique = `${name} (${n++})`;
        used.add(unique);
        headersByColumn[col] = unique;
      }
      continue;
    }

    if (maxColumn < 0) continue; // wholly empty row

    const record = {};
    let hasValue = false;
    for (let col = 0; col < headersByColumn.length; col++) {
      const value = cells[col] === undefined ? null : cells[col];
      record[headersByColumn[col]] = value;
      if (value !== null && value !== '') hasValue = true;
    }
    if (hasValue) rows.push(record);
  }

  if (!seenHeaderRow) throw new Error('The worksheet is empty — no header row found');

  return { headers: headersByColumn.slice(), rows };
}

function columnLetter(index) {
  let out = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ============================================================
// PUBLIC API
// ============================================================

// Opens the container and resolves the sheet index without parsing any cells.
function openWorkbook(buf) {
  const files = unzip(buf);
  return { files, sharedStrings: readSharedStrings(files), ...sheetPaths(files) };
}

function readWorkbook(buf) {
  const { files, sharedStrings, order, byName } = openWorkbook(buf);

  const sheets = {};
  for (const name of order) {
    const part = files[byName[name]];
    if (!part) continue;
    sheets[name] = readSheetPart(part, sharedStrings);
  }

  return { sheetNames: order.filter(name => sheets[name]), sheets };
}

// readSheet(buf) reads the first sheet; readSheet(buf, name) reads that sheet
// and raises with the available names if it is not there, because a renamed
// sheet is the most likely way the vendor's export changes shape on us.
//
// Only the requested sheet is parsed. Going through readWorkbook would parse
// every sheet in the file, so an unrelated malformed one — a stray empty tab
// the vendor left in the workbook — would fail an import whose actual data
// sheet is perfectly fine.
function readSheet(buf, sheetName) {
  const { files, sharedStrings, order, byName } = openWorkbook(buf);
  const name = sheetName || order[0];
  const part = byName[name] && files[byName[name]];

  if (!part) {
    throw new Error(
      `Sheet "${name}" not found. This file contains: ${order.join(', ') || '(none)'}`
    );
  }

  return { sheetName: name, ...readSheetPart(part, sharedStrings) };
}

module.exports = { readSheet, readWorkbook, unzip, decodeXml, columnIndex, columnLetter, rowNumber };
