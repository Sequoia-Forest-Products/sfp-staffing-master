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
//
// Two writers produce the files we see, and they spell the same OOXML
// differently. Excel/openpyxl put the spreadsheet namespace on a default xmlns
// and write bare elements (<sheet>, <row>, <c>) into xl/worksheets/sheet1.xml.
// The payroll vendor's exporter binds that namespace to a prefix and writes
// <x:sheet>/<x:row>/<x:c> into a singular xl/worksheets/sheet.xml, puts a UTF-8
// BOM on every part, and gives absolute rels targets. Both are valid, so this
// reader matches on local names, tolerates a BOM anywhere, and takes part paths
// from the rels instead of guessing at file names.

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

// A UTF-8 BOM is legal at the start of any XML part and some writers emit one on
// every part (the payroll vendor's does). It is not markup, so strip it before
// anything tries to match `<?xml` or a root element.
function partText(buffer) {
  if (!buffer) return '';
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Namespace prefixes are arbitrary. Excel and openpyxl put the spreadsheet
// namespace on a default xmlns and write bare <sheet>/<row>/<c>; other writers
// declare it as a prefix and write <x:sheet>/<x:row>/<x:c> — the same document,
// and the prefix could just as well be <ss:row>. So every element match here
// keys on the LOCAL NAME with an optional "anyprefix:" in front, and never on a
// literal `x:`.
const PREFIX = '(?:[A-Za-z_][A-Za-z0-9_.-]*:)?';

// Every <tag ...>inner</tag>, plus self-closing <tag ... />, in document order.
// Self-closing tags yield inner === ''. `tag` is a local name; any prefix on the
// element (or on its close tag) matches, and the two need not agree.
function* eachElement(xml, tag) {
  const open = new RegExp(`<${PREFIX}${tag}(\\s[^>]*?)?(/?)>`, 'g');
  const close = new RegExp(`</${PREFIX}${tag}\\s*>`, 'g');
  let match;
  while ((match = open.exec(xml)) !== null) {
    const attrs = match[1] || '';
    if (match[2] === '/') {
      yield { attrs, inner: '' };
      continue;
    }
    // First close tag after the open, not a depth-counted match. Safe because
    // none of the elements read here (si, t, v, c, row, sheet, Relationship)
    // may contain another element of the same name in the OOXML schema, so the
    // first close is always the matching one. Anything that could nest inside
    // itself would need real depth tracking here.
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (end === null) {
      yield { attrs, inner: xml.slice(open.lastIndex) };
      return;
    }
    yield { attrs, inner: xml.slice(open.lastIndex, end.index) };
    open.lastIndex = end.index + end[0].length;
  }
}

// Attribute lookup is deliberately EXACT, not namespace-agnostic: unprefixed
// attributes are not in any namespace, and being loose here would make
// attr(attrs, 'id') match r:id on <sheet> — two different attributes that
// happen to end in the same letters. Callers that want a prefixed attribute ask
// for it by local name through attrAnyPrefix().
function attr(attrs, name) {
  const match = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

// A prefixed attribute whose prefix is arbitrary — r:id in Excel's output, but
// the relationships namespace can be bound to any prefix. A prefixed match wins
// over a bare one so that a file carrying BOTH r:id="rId1" and id="..." resolves
// to the relationship id rather than to whichever happened to come first.
function attrAnyPrefix(attrs, name) {
  const prefixed = attrs.match(new RegExp(`\\s[A-Za-z_][A-Za-z0-9_.-]*:${name}="([^"]*)"`));
  if (prefixed) return decodeXml(prefixed[1]);
  return attr(attrs, name);
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
  const text = partText(xml);
  const strings = [];
  for (const si of eachElement(text, 'si')) strings.push(textOf(si.inner));
  return strings;
}

function cellValue(attrs, inner, sharedStrings) {
  // t= is the cell TYPE. s= (a style index into xl/styles.xml) is read by
  // nobody here on purpose: no column in this export is date-formatted, so a
  // number stays a number and is never reinterpreted as a date serial.
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

// A rels Target can be spelled three ways for the same part: relative to the
// rels file's own directory ("worksheets/sheet.xml"), the same with a "./" on
// the front, or as an absolute package path with a leading slash
// ("/xl/worksheets/sheet.xml"). Return the candidate package paths in
// preference order so the caller can pick the one actually in the container.
function relTargetCandidates(target, baseDir) {
  const cleaned = target.replace(/\\/g, '/').replace(/^\.\//, '');
  const absolute = cleaned.startsWith('/');
  const bare = absolute ? cleaned.slice(1) : cleaned;
  const relative = baseDir ? `${baseDir}/${bare}` : bare;
  // An absolute target is already a package path; a relative one hangs off the
  // base directory. Both are offered either way, because a writer that emits
  // "xl/worksheets/sheet.xml" without the leading slash means the package path.
  const ordered = absolute ? [bare, relative] : [relative, bare];
  return ordered.filter((p, i) => p && ordered.indexOf(p) === i);
}

function resolveTarget(files, target, baseDir) {
  const candidates = relTargetCandidates(target, baseDir);
  return candidates.find(p => files[p]) || candidates[0] || null;
}

// Sheet name -> part path, resolved through workbook.xml + its rels.
function sheetPaths(files) {
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new Error('Not a .xlsx file: xl/workbook.xml is missing');

  const relsXml = files['xl/_rels/workbook.xml.rels'];
  const targets = {};
  if (relsXml) {
    for (const rel of eachElement(partText(relsXml), 'Relationship')) {
      const id = attr(rel.attrs, 'Id');
      const target = attr(rel.attrs, 'Target');
      if (!id || !target) continue;
      targets[id] = resolveTarget(files, target, 'xl');
    }
  }

  const order = [];
  const byName = {};
  const guessed = new Set();
  let fallback = 1;

  for (const sheet of eachElement(partText(workbook), 'sheet')) {
    const name = attr(sheet.attrs, 'name');
    if (!name) continue;
    // r:id, but the relationships namespace prefix is the writer's choice.
    const relId = attrAnyPrefix(sheet.attrs, 'id');
    // The rels are authoritative. Only when they are missing or silent does the
    // numbered convention get guessed at — and the singular "sheet.xml" some
    // writers use is just as valid a name as "sheet1.xml". A guessed part is
    // claimed, so two sheets can never be pointed at the same one.
    const guesses = [`xl/worksheets/sheet${fallback}.xml`, 'xl/worksheets/sheet.xml'];
    const path = (relId && targets[relId])
      || guesses.find(p => files[p] && !guessed.has(p))
      || guesses[0];
    guessed.add(path);
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
  const xml = partText(xmlBuffer);
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
