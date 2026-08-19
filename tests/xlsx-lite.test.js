// Run with: npm test
//
// Every case builds a real .xlsx in memory (tests/helpers/make-xlsx.js) and
// reads it back, so the ZIP and XML paths are both genuinely exercised.

const test = require('node:test');
const assert = require('node:assert');

const { readSheet, readWorkbook, unzip, decodeXml, columnIndex, columnLetter } =
  require('../netlify/functions/xlsx-lite');
const { buildXlsx, buildPayrollXlsx, PAYROLL_HEADERS } = require('./helpers/make-xlsx');

// ============================================================
// Column references
// ============================================================

test('column letters convert both ways past the single-letter range', () => {
  assert.strictEqual(columnIndex('A1'), 0);
  assert.strictEqual(columnIndex('Z9'), 25);
  assert.strictEqual(columnIndex('AA12'), 26);
  assert.strictEqual(columnIndex('AB1'), 27);
  assert.strictEqual(columnLetter(0), 'A');
  assert.strictEqual(columnLetter(25), 'Z');
  assert.strictEqual(columnLetter(26), 'AA');
});

// ============================================================
// XML entities
// ============================================================

test('named, decimal and hex entities all decode', () => {
  assert.strictEqual(decodeXml('Salazar &amp; De Leon'), 'Salazar & De Leon');
  assert.strictEqual(decodeXml('&lt;tag&gt;'), '<tag>');
  assert.strictEqual(decodeXml('&#65;&#x42;'), 'AB');
  assert.strictEqual(decodeXml('no entities here'), 'no entities here');
});

// ============================================================
// ZIP container
// ============================================================

test('deflated and stored entries both round-trip', () => {
  for (const deflate of [true, false]) {
    const buf = buildPayrollXlsx([['0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245]],
      { deflate });
    const sheet = readSheet(buf, 'Work Summary Payroll');
    assert.strictEqual(sheet.rows.length, 1, `deflate=${deflate}`);
    assert.strictEqual(sheet.rows[0]['Last Name'], 'Acosta Ruiz');
  }
});

test('a file that is not a zip fails with a readable message', () => {
  assert.throws(() => readSheet(Buffer.from('This is a PDF, actually')), /ZIP|too small/i);
});

test('a truncated zip fails rather than returning half a sheet', () => {
  const buf = buildPayrollXlsx([['0063', 'Smith', 'Ana', 'No', 20, 10, 2, 12, 260]]);
  assert.throws(() => readSheet(buf.subarray(0, buf.length - 40)));
});

test('unzip exposes the parts an .xlsx is made of', () => {
  const files = unzip(buildPayrollXlsx([]));
  assert.ok(files['xl/workbook.xml']);
  assert.ok(files['xl/sharedStrings.xml']);
  assert.ok(files['xl/worksheets/sheet1.xml']);
});

// ============================================================
// Sheet reading
// ============================================================

test('the payroll export parses to header-keyed rows with numbers as numbers', () => {
  const buf = buildPayrollXlsx([
    ['0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 2.5, 12.5, 336.88],
    ['9290', 'Smith', 'Dale', 'Yes', 0, 0, 0, 0, 0]
  ]);

  const sheet = readSheet(buf, 'Work Summary Payroll');

  assert.strictEqual(sheet.sheetName, 'Work Summary Payroll');
  assert.deepStrictEqual(sheet.headers, PAYROLL_HEADERS);
  assert.strictEqual(sheet.rows.length, 2);

  const first = sheet.rows[0];
  assert.strictEqual(first['Emp #'], '0319');           // TEXT, padding intact
  assert.strictEqual(typeof first['Pay Rate'], 'number');
  assert.strictEqual(first['Pay Rate'], 24.5);
  assert.strictEqual(first['Total Earnings'], 336.88);
  assert.strictEqual(sheet.rows[1]['Is Salary'], 'Yes');
});

test('reading without a sheet name takes the first sheet', () => {
  const sheet = readSheet(buildPayrollXlsx([['0001', 'A', 'B', 'No', 10, 10, 0, 10, 100]]));
  assert.strictEqual(sheet.sheetName, 'Work Summary Payroll');
});

test('asking for a sheet that is not there names the ones that are', () => {
  const buf = buildPayrollXlsx([]);
  assert.throws(
    () => readSheet(buf, 'Hours Analysis Report'),
    /Hours Analysis Report[\s\S]*Work Summary Payroll/
  );
});

test('a second sheet is reachable by name', () => {
  const buf = buildXlsx({
    sheetName: 'Work Summary Payroll',
    rows: [['Emp #'], ['0001']],
    extraSheets: [{ name: 'Notes', rows: [['Note'], ['ignore me']] }]
  });
  const workbook = readWorkbook(buf);
  assert.deepStrictEqual(workbook.sheetNames, ['Work Summary Payroll', 'Notes']);
  assert.strictEqual(readSheet(buf, 'Notes').rows[0]['Note'], 'ignore me');
});

test('missing cells read as null instead of shifting the row left', () => {
  const buf = buildXlsx({
    sheetName: 'S',
    rows: [
      ['Emp #', 'Last Name', 'Pay Rate'],
      ['0319', null, 24.5]
    ]
  });
  const row = readSheet(buf).rows[0];
  assert.strictEqual(row['Emp #'], '0319');
  assert.strictEqual(row['Last Name'], null);
  assert.strictEqual(row['Pay Rate'], 24.5);
});

test('wholly empty rows are dropped, so trailing spacer rows do not become employees', () => {
  const buf = buildXlsx({
    sheetName: 'S',
    rows: [['Emp #', 'Regular'], ['0319', 10], [null, null], ['0063', 10]]
  });
  const rows = readSheet(buf).rows;
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r['Emp #']), ['0319', '0063']);
});

test('a blank header keeps its column under the spreadsheet letter', () => {
  const buf = buildXlsx({ sheetName: 'S', rows: [['Emp #', null, 'OT'], ['0319', 'kept', 2]] });
  const sheet = readSheet(buf);
  assert.deepStrictEqual(sheet.headers, ['Emp #', 'B', 'OT']);
  assert.strictEqual(sheet.rows[0]['B'], 'kept');
});

test('duplicate headers are suffixed rather than overwriting each other', () => {
  const buf = buildXlsx({ sheetName: 'S', rows: [['OT', 'OT'], [1, 2]] });
  const sheet = readSheet(buf);
  assert.deepStrictEqual(sheet.headers, ['OT', 'OT (2)']);
  assert.strictEqual(sheet.rows[0]['OT'], 1);
  assert.strictEqual(sheet.rows[0]['OT (2)'], 2);
});

test('an ampersand in a name survives the shared string table', () => {
  const buf = buildPayrollXlsx([['0100', 'Salazar & De Leon', 'José', 'No', 22, 10, 0, 10, 220]]);
  const row = readSheet(buf, 'Work Summary Payroll').rows[0];
  assert.strictEqual(row['Last Name'], 'Salazar & De Leon');
  assert.strictEqual(row['First Name'], 'José');
});

test('a header-only sheet parses to zero rows, not an error', () => {
  const sheet = readSheet(buildPayrollXlsx([]), 'Work Summary Payroll');
  assert.deepStrictEqual(sheet.rows, []);
  assert.deepStrictEqual(sheet.headers, PAYROLL_HEADERS);
});

test('a sheet with no rows at all is an error, since that means a broken export', () => {
  const buf = buildXlsx({ sheetName: 'S', rows: [] });
  assert.throws(() => readSheet(buf), /empty/i);
});

// ============================================================
// Cell type coverage the vendor file does not use but Excel emits
// ============================================================

test('inline strings, cached formula strings and booleans all read', () => {
  const xml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Emp #</t></is></c><c r="B1" t="inlineStr"><is><t>Flag</t></is></c><c r="C1" t="inlineStr"><is><t>Calc</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>0319</t></is></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="str"><v>OK</v></c></row>` +
    `<row r="3"><c r="A3" t="inlineStr"><is><t>0063</t></is></c><c r="B3" t="b"><v>0</v></c><c r="C3" t="e"><v>#N/A</v></c></row>` +
    `</sheetData></worksheet>`;

  const { zip } = require('./helpers/make-xlsx');
  const buf = zip([
    { name: 'xl/workbook.xml', data: `<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: xml }
  ]);

  const rows = readSheet(buf, 'S').rows;
  assert.strictEqual(rows[0]['Emp #'], '0319');
  assert.strictEqual(rows[0]['Flag'], true);
  assert.strictEqual(rows[0]['Calc'], 'OK');
  assert.strictEqual(rows[1]['Flag'], false);
  assert.strictEqual(rows[1]['Calc'], null);   // #N/A reads as empty, not the literal
});

test('rich-text runs concatenate into one string', () => {
  const shared = `<sst><si><r><t>Work </t></r><r><t>Summary</t></r></si></sst>`;
  const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>7</v></c></row></sheetData></worksheet>`;
  const { zip } = require('./helpers/make-xlsx');
  const buf = zip([
    { name: 'xl/workbook.xml', data: `<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);
  assert.strictEqual(readSheet(buf, 'S').rows[0]['Work Summary'], 7);
});

test('an unsupported compression method is refused, not silently skipped', () => {
  const buf = buildPayrollXlsx([['0319', 'A', 'B', 'No', 10, 10, 0, 10, 100]]);
  // Rewrite the first central-directory method field to something exotic.
  const eocd = buf.length - 22;
  const centralStart = buf.readUInt32LE(eocd + 16);
  buf.writeUInt16LE(99, centralStart + 10);
  assert.throws(() => readSheet(buf), /compression method 99/);
});

test('a malformed unrelated sheet does not fail the sheet we asked for', () => {
  // The vendor's workbook could gain a stray empty tab at any time. Parsing
  // every sheet to read one of them would turn that into a failed import.
  const buf = buildXlsx({
    sheetName: 'Work Summary Payroll',
    rows: [PAYROLL_HEADERS, ['0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245]],
    extraSheets: [{ name: 'Leftover', rows: [] }]
  });

  const sheet = readSheet(buf, 'Work Summary Payroll');
  assert.strictEqual(sheet.rows.length, 1);
  assert.strictEqual(sheet.rows[0]['Emp #'], '0319');

  // The broken sheet is still an error if you actually ask for it.
  assert.throws(() => readSheet(buf, 'Leftover'), /empty/i);
});

test('a sheet listed in the workbook but missing its part names the alternatives', () => {
  const buf = buildPayrollXlsx([['0319', 'A', 'B', 'No', 10, 10, 0, 10, 100]]);
  assert.throws(() => readSheet(buf, 'Nope'), /Nope[\s\S]*Work Summary Payroll/);
});
