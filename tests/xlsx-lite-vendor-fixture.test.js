// Run with: npm test
//
// The one test file in this repo that reads a .xlsx nobody here generated.
//
// tests/xlsx-lite.test.js builds its workbooks in memory, which is the right
// way to test behaviour but a structurally blind way to test compatibility: a
// generated fixture cannot falsify an assumption its own generator shares. That
// is not hypothetical here — twenty green tests still met
// "This .xlsx contains no worksheets" on the first real vendor attachment.
//
// tests/fixtures/bbsi-work-summary-payroll.xlsx is that real attachment with
// its container and XML parts copied byte-for-byte and only the cell values
// rewritten, so it carries the vendor's structure including whatever nobody has
// noticed yet. See tests/fixtures/README.md before touching it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { readSheet, readWorkbook } = require('../netlify/functions/xlsx-lite.js');
const { buildImport, EXPECTED_SHEET, EXPECTED_HEADERS } = require('../netlify/functions/payroll-lib.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'bbsi-work-summary-payroll.xlsx');
const bytes = () => fs.readFileSync(FIXTURE);

// A deliberately independent ZIP reader. xlsx-lite has its own; using it here
// would make these assertions circular — the point is to state what is in the
// container, so a future "simplification" of the real reader has something to
// fail against.
function containerEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const cdExtraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString();
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);

    const localOffset = buf.readUInt32LE(p + 42);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const localExtra = buf.slice(
      localOffset + 30 + localNameLen,
      localOffset + 30 + localNameLen + localExtraLen
    );

    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(dataAt, dataAt + compressedSize);

    out.push({
      name,
      method,
      cdExtraLen,
      localExtraLen,
      localExtraId: localExtraLen ? localExtra.readUInt16LE(0) : null,
      content: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
    });

    p += 46 + nameLen + cdExtraLen + commentLen;
  }
  return out;
}

const PART_NAMES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
  'xl/styles.xml',
  'xl/workbook.xml',
  'xl/worksheets/sheet.xml'
];

// ------------------------------------------------------------------
// The container. Traits 5 and 6 live only here — no generator in this
// repo produces either, which is why they went unnoticed until the real
// bytes were opened.
// ------------------------------------------------------------------

test('vendor fixture: the part list is exactly the vendor\'s seven', () => {
  const names = containerEntries(bytes()).map(e => e.name).sort();
  assert.deepStrictEqual(names, [...PART_NAMES].sort());
});

test('vendor fixture: _rels/.rels is STORED while every other part is DEFLATED', () => {
  // Trait 5. inflateRawSync over every entry throws on this file. A reader
  // must honour the per-entry compression method rather than assuming deflate.
  const entries = containerEntries(bytes());
  const rels = entries.find(e => e.name === '_rels/.rels');
  assert.strictEqual(rels.method, 0, '_rels/.rels should be stored (method 0)');
  for (const e of entries) {
    if (e.name === '_rels/.rels') continue;
    assert.strictEqual(e.method, 8, `${e.name} should be deflated (method 8)`);
  }
});

test('vendor fixture: local headers carry an extra field the central directory does not', () => {
  // Trait 6. Every local header has a 28-byte 0xA220 "Open Packaging Growth
  // Hint"; the central directory reports extra=0 for the same entries. Deriving
  // the data offset from the central directory's extra length lands 28 bytes
  // short of the data and reads garbage.
  for (const e of containerEntries(bytes())) {
    assert.strictEqual(e.cdExtraLen, 0, `${e.name}: central directory extra length`);
    assert.strictEqual(e.localExtraLen, 28, `${e.name}: local header extra length`);
    assert.strictEqual(e.localExtraId, 0xa220, `${e.name}: local extra field id`);
  }
});

test('vendor fixture: every XML part begins with a UTF-8 BOM', () => {
  // Trait 3, asserted on the bytes rather than on parsed output, so it stays
  // true even if the parser starts tolerating a BOM some other way.
  for (const e of containerEntries(bytes())) {
    assert.strictEqual(
      e.content.slice(0, 3).toString('hex'), 'efbbbf',
      `${e.name} should start with EF BB BF`
    );
  }
});

test('vendor fixture: elements are namespace-prefixed and the sheet part is singular', () => {
  // Traits 1 and 2. The prefix is the writer's choice; these assertions pin
  // that this file uses one, not that the parser may hardcode it.
  const entries = containerEntries(bytes());
  const sheet = entries.find(e => e.name === 'xl/worksheets/sheet.xml');
  assert.ok(sheet, 'the worksheet part is sheet.xml, not sheet1.xml');

  const xml = sheet.content.toString('utf8');
  assert.match(xml, /<x:worksheet\b/, 'root element carries the x: prefix');
  assert.match(xml, /<x:row\b/, 'rows carry the prefix');
  assert.match(xml, /<x:c\b/, 'cells carry the prefix');
  assert.match(xml, /t="n"/, 'numeric cells state t="n" explicitly, unlike Excel');

  const wb = entries.find(e => e.name === 'xl/workbook.xml').content.toString('utf8');
  assert.match(wb, /<x:sheet [^>]*xmlns:r=/, 'xmlns:r is declared on the sheet element, not the root');
});

test('vendor fixture: rels targets are absolute package paths', () => {
  // Trait 4.
  const rels = containerEntries(bytes())
    .find(e => e.name === 'xl/_rels/workbook.xml.rels').content.toString('utf8');
  assert.match(rels, /Target="\/xl\/worksheets\/sheet\.xml"/);
  assert.match(rels, /Target="\/xl\/sharedStrings\.xml"/);
});

// ------------------------------------------------------------------
// The parser, against the real structure.
// ------------------------------------------------------------------

test('vendor fixture: readWorkbook finds the vendor sheet by name', () => {
  // The exact failure that shipped: sheetPaths matched <sheet and found
  // nothing, so this list came back empty and readSheet raised
  // "This .xlsx contains no worksheets".
  const wb = readWorkbook(bytes());
  assert.deepStrictEqual(wb.sheetNames, [EXPECTED_SHEET]);
});

test('vendor fixture: the sheet reads as 61 rows under the nine canonical headers', () => {
  const sheet = readSheet(bytes(), EXPECTED_SHEET);
  assert.deepStrictEqual(sheet.headers, EXPECTED_HEADERS);
  assert.strictEqual(sheet.rows.length, 61);
});

test('vendor fixture: Emp # stays a string, keeping its leading zero', () => {
  // Emp # is a shared string in this file. Coercing it to a number turns
  // "0417" into 417 and it stops matching employees.employee_number.
  const { rows } = readSheet(bytes(), EXPECTED_SHEET);
  for (const row of rows) {
    assert.strictEqual(typeof row['Emp #'], 'string', 'every Emp # is a string');
  }
  const withLeadingZero = rows.filter(r => r['Emp #'].startsWith('0'));
  assert.strictEqual(withLeadingZero.length, 1);
  assert.strictEqual(withLeadingZero[0]['Emp #'], '0417');
});

test('vendor fixture: styled numeric cells stay numbers and are not read as date serials', () => {
  // Every numeric cell in this file carries an s= style index. Reading styles
  // to decide a cell is a date is how "10" becomes 1900-01-09.
  const { rows } = readSheet(bytes(), EXPECTED_SHEET);
  for (const row of rows) {
    for (const col of ['Pay Rate', 'Regular', 'OT', 'Total Hours', 'Total Earnings']) {
      assert.strictEqual(typeof row[col], 'number', `${col} should be a number`);
      assert.ok(!(row[col] instanceof Date), `${col} should not be a Date`);
    }
  }
  assert.strictEqual(rows[0]['Regular'], 10);
});

test('vendor fixture: the vendor reports salaried people as all zeros', () => {
  // Not cosmetic. This is why the BBSI flow skips salaried rows
  // unconditionally instead of reading a pay rate for them: there is no rate
  // in the file to read.
  const { rows } = readSheet(bytes(), EXPECTED_SHEET);
  const salaried = rows.filter(r => r['Is Salary'] === 'Yes');
  assert.strictEqual(salaried.length, 7);
  for (const row of salaried) {
    for (const col of ['Pay Rate', 'Regular', 'OT', 'Total Hours', 'Total Earnings']) {
      assert.strictEqual(row[col], 0, `salaried ${col} should be 0`);
    }
  }
});

test('vendor fixture: an hourly row can carry a pay rate of 0', () => {
  const { rows } = readSheet(bytes(), EXPECTED_SHEET);
  const hourly = rows.filter(r => r['Is Salary'] === 'No');
  assert.strictEqual(hourly.length, 54);
  assert.strictEqual(hourly.filter(r => r['Pay Rate'] === 0).length, 1);
});

// ------------------------------------------------------------------
// The whole ingest path, on the real structure. The parser being right is
// not the same as the import being right.
// ------------------------------------------------------------------

test('vendor fixture: buildImport reads it end to end with no anomalies', () => {
  const result = buildImport({
    fileBuffer: bytes(),
    workDate: '2026-08-19',
    source: 'email'
  });

  assert.strictEqual(result.sheetName, EXPECTED_SHEET);
  assert.deepStrictEqual(result.anomalies, []);
  // 61 rows in, 7 salaried skipped unconditionally, 54 out.
  assert.strictEqual(result.rows.length, 54);
  assert.ok(result.rows.every(r => r.is_salary === false), 'no salaried row is imported');

  assert.strictEqual(result.rows[0].employee_number, '0417');
  assert.strictEqual(result.rows[0].work_date, '2026-08-19');

  // Totals add up over the imported rows rather than matching a magic number,
  // so refreshing the fixture does not require rewriting this assertion.
  const sum = (key) => Math.round(result.rows.reduce((t, r) => t + r[key], 0) * 100) / 100;
  assert.strictEqual(result.totals.regularHours, sum('regular_hours'));
  assert.strictEqual(result.totals.otHours, sum('ot_hours'));
  assert.strictEqual(result.totals.totalEarnings, sum('total_earnings'));
});

test('vendor fixture: the file hash is stable across reads', () => {
  // The ingest ledger is keyed on this, so an unstable hash would re-import
  // the same day forever.
  const a = buildImport({ fileBuffer: bytes(), workDate: '2026-08-19' });
  const b = buildImport({ fileBuffer: bytes(), workDate: '2026-08-19' });
  assert.strictEqual(a.fileHash, b.fileHash);
  assert.match(a.fileHash, /^[0-9a-f]{64}$/);
});
