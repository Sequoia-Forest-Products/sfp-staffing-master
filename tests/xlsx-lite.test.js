// Run with: npm test
//
// Every case builds a real .xlsx in memory and reads it back, so the ZIP and
// XML paths are both genuinely exercised.
//
// There are TWO generators, and the behavioural suite runs against both:
//
//   tests/helpers/make-xlsx.js       Excel/openpyxl dialect — default xmlns,
//                                    bare <sheet>/<row>/<c>, sheet1.xml, no BOM
//   tests/helpers/make-xlsx-bbsi.js  the payroll vendor's dialect — prefixed
//                                    <x:sheet>/<x:row>/<x:c>, singular
//                                    sheet.xml, a BOM on every part, absolute
//                                    rels targets, s= on every cell
//
// The second one exists because the first one shares the parser's assumptions,
// and a fixture that shares an assumption cannot falsify it: twenty green tests
// against make-xlsx.js still met "This .xlsx contains no worksheets" on the
// first real vendor attachment. Anything asserted below is asserted in both
// dialects unless a comment says why it is dialect-specific.

const test = require('node:test');
const assert = require('node:assert');

const { readSheet, readWorkbook, unzip, decodeXml, columnIndex, columnLetter } =
  require('../netlify/functions/xlsx-lite');
const excel = require('./helpers/make-xlsx');
const bbsi = require('./helpers/make-xlsx-bbsi');
const { buildXlsx, buildPayrollXlsx, PAYROLL_HEADERS, zip } = excel;

// The vendor's prefix happens to be "x", but a namespace prefix is the writer's
// arbitrary choice. Running the same assertions at "x", at "ss" and at no
// prefix at all is what proves the parser keys on the LOCAL NAME rather than on
// a hardcoded "x:".
const bbsiDialect = (label, opts) => ({
  label,
  firstSheetPart: bbsi.FIRST_SHEET_PART,
  headers: bbsi.PAYROLL_HEADERS,
  buildXlsx: o => bbsi.buildXlsx({ ...opts, ...o }),
  buildPayrollXlsx: (rows, o) => bbsi.buildPayrollXlsx(rows, { ...opts, ...o })
});

const DIALECTS = [
  {
    label: 'excel',
    firstSheetPart: 'xl/worksheets/sheet1.xml',
    headers: excel.PAYROLL_HEADERS,
    buildXlsx: excel.buildXlsx,
    buildPayrollXlsx: excel.buildPayrollXlsx
  },
  bbsiDialect('bbsi x: prefix', { prefix: 'x' }),
  bbsiDialect('bbsi ss: prefix', { prefix: 'ss' }),
  bbsiDialect('bbsi no prefix', { prefix: '' })
];

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
// The behavioural suite, run against every dialect
// ============================================================

for (const d of DIALECTS) {
  const suffix = ` [${d.label}]`;

  // -------- ZIP container --------

  test('deflated and stored entries both round-trip' + suffix, () => {
    for (const deflate of [true, false]) {
      const buf = d.buildPayrollXlsx([['0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245]],
        { deflate });
      const sheet = readSheet(buf, 'Work Summary Payroll');
      assert.strictEqual(sheet.rows.length, 1, `deflate=${deflate}`);
      assert.strictEqual(sheet.rows[0]['Last Name'], 'Acosta Ruiz');
    }
  });

  test('a truncated zip fails rather than returning half a sheet' + suffix, () => {
    const buf = d.buildPayrollXlsx([['0063', 'Smith', 'Ana', 'No', 20, 10, 2, 12, 260]]);
    assert.throws(() => readSheet(buf.subarray(0, buf.length - 40)));
  });

  test('unzip exposes the parts an .xlsx is made of' + suffix, () => {
    const files = unzip(d.buildPayrollXlsx([]));
    assert.ok(files['xl/workbook.xml']);
    assert.ok(files['xl/sharedStrings.xml']);
    // The worksheet part name is exactly where the dialects differ: Excel
    // numbers it, the vendor writes a singular sheet.xml.
    assert.ok(files[d.firstSheetPart], `expected ${d.firstSheetPart}`);
  });

  test('an unsupported compression method is refused, not silently skipped' + suffix, () => {
    const buf = d.buildPayrollXlsx([['0319', 'A', 'B', 'No', 10, 10, 0, 10, 100]]);
    // Rewrite the first central-directory method field to something exotic.
    const eocd = buf.length - 22;
    const centralStart = buf.readUInt32LE(eocd + 16);
    buf.writeUInt16LE(99, centralStart + 10);
    assert.throws(() => readSheet(buf), /compression method 99/);
  });

  // -------- Sheet reading --------

  test('the payroll export parses to header-keyed rows with numbers as numbers' + suffix, () => {
    const buf = d.buildPayrollXlsx([
      ['0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 2.5, 12.5, 336.88],
      ['9290', 'Smith', 'Dale', 'Yes', 0, 0, 0, 0, 0]
    ]);

    const sheet = readSheet(buf, 'Work Summary Payroll');

    assert.strictEqual(sheet.sheetName, 'Work Summary Payroll');
    assert.deepStrictEqual(sheet.headers, d.headers);
    assert.strictEqual(sheet.rows.length, 2);

    const first = sheet.rows[0];
    assert.strictEqual(first['Emp #'], '0319');           // TEXT, padding intact
    assert.strictEqual(typeof first['Pay Rate'], 'number');
    assert.strictEqual(first['Pay Rate'], 24.5);
    assert.strictEqual(first['Total Earnings'], 336.88);
    assert.strictEqual(sheet.rows[1]['Is Salary'], 'Yes');
  });

  test('reading without a sheet name takes the first sheet' + suffix, () => {
    const sheet = readSheet(d.buildPayrollXlsx([['0001', 'A', 'B', 'No', 10, 10, 0, 10, 100]]));
    assert.strictEqual(sheet.sheetName, 'Work Summary Payroll');
  });

  test('asking for a sheet that is not there names the ones that are' + suffix, () => {
    const buf = d.buildPayrollXlsx([]);
    assert.throws(
      () => readSheet(buf, 'Hours Analysis Report'),
      /Hours Analysis Report[\s\S]*Work Summary Payroll/
    );
  });

  test('a second sheet is reachable by name' + suffix, () => {
    const buf = d.buildXlsx({
      sheetName: 'Work Summary Payroll',
      rows: [['Emp #'], ['0001']],
      extraSheets: [{ name: 'Notes', rows: [['Note'], ['ignore me']] }]
    });
    const workbook = readWorkbook(buf);
    assert.deepStrictEqual(workbook.sheetNames, ['Work Summary Payroll', 'Notes']);
    assert.strictEqual(readSheet(buf, 'Notes').rows[0]['Note'], 'ignore me');
  });

  test('missing cells read as null instead of shifting the row left' + suffix, () => {
    const buf = d.buildXlsx({
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

  test('wholly empty rows are dropped, so trailing spacer rows do not become employees' + suffix, () => {
    const buf = d.buildXlsx({
      sheetName: 'S',
      rows: [['Emp #', 'Regular'], ['0319', 10], [null, null], ['0063', 10]]
    });
    const rows = readSheet(buf).rows;
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map(r => r['Emp #']), ['0319', '0063']);
  });

  test('a blank header keeps its column under the spreadsheet letter' + suffix, () => {
    const buf = d.buildXlsx({ sheetName: 'S', rows: [['Emp #', null, 'OT'], ['0319', 'kept', 2]] });
    const sheet = readSheet(buf);
    assert.deepStrictEqual(sheet.headers, ['Emp #', 'B', 'OT']);
    assert.strictEqual(sheet.rows[0]['B'], 'kept');
  });

  test('duplicate headers are suffixed rather than overwriting each other' + suffix, () => {
    const buf = d.buildXlsx({ sheetName: 'S', rows: [['OT', 'OT'], [1, 2]] });
    const sheet = readSheet(buf);
    assert.deepStrictEqual(sheet.headers, ['OT', 'OT (2)']);
    assert.strictEqual(sheet.rows[0]['OT'], 1);
    assert.strictEqual(sheet.rows[0]['OT (2)'], 2);
  });

  test('an ampersand in a name survives the shared string table' + suffix, () => {
    const buf = d.buildPayrollXlsx([['0100', 'Salazar & De Leon', 'José', 'No', 22, 10, 0, 10, 220]]);
    const row = readSheet(buf, 'Work Summary Payroll').rows[0];
    assert.strictEqual(row['Last Name'], 'Salazar & De Leon');
    assert.strictEqual(row['First Name'], 'José');
  });

  test('a header-only sheet parses to zero rows, not an error' + suffix, () => {
    const sheet = readSheet(d.buildPayrollXlsx([]), 'Work Summary Payroll');
    assert.deepStrictEqual(sheet.rows, []);
    assert.deepStrictEqual(sheet.headers, d.headers);
  });

  test('a sheet with no rows at all is an error, since that means a broken export' + suffix, () => {
    const buf = d.buildXlsx({ sheetName: 'S', rows: [] });
    assert.throws(() => readSheet(buf), /empty/i);
  });

  test('a malformed unrelated sheet does not fail the sheet we asked for' + suffix, () => {
    // The vendor's workbook could gain a stray empty tab at any time. Parsing
    // every sheet to read one of them would turn that into a failed import.
    const buf = d.buildXlsx({
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

  test('a sheet listed in the workbook but missing its part names the alternatives' + suffix, () => {
    const buf = d.buildPayrollXlsx([['0319', 'A', 'B', 'No', 10, 10, 0, 10, 100]]);
    assert.throws(() => readSheet(buf, 'Nope'), /Nope[\s\S]*Work Summary Payroll/);
  });
}

// ============================================================
// A file that is not a spreadsheet at all — dialect-free
// ============================================================

test('a file that is not a zip fails with a readable message', () => {
  assert.throws(() => readSheet(Buffer.from('This is a PDF, actually')), /ZIP|too small/i);
});

// ============================================================
// The four ways the vendor's OOXML differs, one at a time
//
// Each case below turns on exactly ONE of the vendor's four traits and leaves
// the other three in the Excel spelling, so a failure names the trait that
// broke rather than "the vendor file".
// ============================================================

const ONLY = {
  prefix: '', bom: false, absoluteTargets: false, styles: false, singularSheetPart: false
};

const ROW = ['0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 2.5, 12.5, 336.88];

const expectPayrollRow = buf => {
  const sheet = readSheet(buf, 'Work Summary Payroll');
  assert.deepStrictEqual(sheet.headers, bbsi.PAYROLL_HEADERS);
  assert.strictEqual(sheet.rows.length, 1);
  assert.strictEqual(sheet.rows[0]['Emp #'], '0319');
  assert.strictEqual(sheet.rows[0]['Last Name'], 'Acosta Ruiz');
  assert.strictEqual(sheet.rows[0]['Pay Rate'], 24.5);
  return sheet;
};

// Difference 1. This is the one that produced the reported failure: sheetPaths
// looked for "<sheet " and a prefixed file has none, so the sheet list came
// back empty.
test('difference 1: namespace-prefixed elements throughout still parse', () => {
  for (const prefix of ['x', 'ss', 'spreadsheet']) {
    const buf = bbsi.buildPayrollXlsx([ROW], { ...ONLY, prefix });
    let sheet;
    try {
      sheet = readSheet(buf, 'Work Summary Payroll');
    } catch (err) {
      // The exact string the vendor's first attachment produced.
      assert.fail(`prefix "${prefix}:" failed: ${err.message}`);
    }
    assert.strictEqual(sheet.rows[0]['Last Name'], 'Acosta Ruiz', `prefix ${prefix}`);
  }
});

test('difference 1: the "contains no worksheets" error is gone for a prefixed file', () => {
  const buf = bbsi.buildPayrollXlsx([ROW], { ...ONLY, prefix: 'x' });
  let message = '';
  try { readSheet(buf, 'Work Summary Payroll'); } catch (err) { message = err.message; }
  assert.doesNotMatch(message, /contains no worksheets/);
  assert.strictEqual(message, '');
});

test('difference 1: a prefixed close tag is matched (</x:si> ends <x:si>)', () => {
  // If the close tag were searched for literally, shared strings would run
  // together into one giant string and the headers would collapse to one column.
  const buf = bbsi.buildXlsx({
    ...ONLY, prefix: 'x',
    sheetName: 'S',
    rows: [['Emp #', 'Last Name'], ['0319', 'Acosta Ruiz']]
  });
  const sheet = readSheet(buf, 'S');
  assert.deepStrictEqual(sheet.headers, ['Emp #', 'Last Name']);
  assert.strictEqual(sheet.rows[0]['Last Name'], 'Acosta Ruiz');
});

// Difference 2, via the rels — the authoritative route.
test('difference 2: a singular xl/worksheets/sheet.xml is found through the rels', () => {
  const buf = bbsi.buildPayrollXlsx([ROW], { ...ONLY, singularSheetPart: true });
  assert.ok(unzip(buf)['xl/worksheets/sheet.xml']);
  assert.strictEqual(unzip(buf)['xl/worksheets/sheet1.xml'], undefined);
  expectPayrollRow(buf);
});

// Difference 2, without any rels at all: nothing but the part name to go on, so
// the numbered guess has to give way to the singular one.
test('difference 2: a singular sheet part is found even with no rels to point at it', () => {
  const buf = zip([
    { name: 'xl/workbook.xml',
      data: `<workbook xmlns="${bbsi.MAIN_NS}"><sheets><sheet name="S" sheetId="1"/></sheets></workbook>` },
    { name: 'xl/worksheets/sheet.xml',
      data: `<worksheet xmlns="${bbsi.MAIN_NS}"><sheetData>` +
        `<row r="1"><c r="A1" t="inlineStr"><is><t>Regular</t></is></c></row>` +
        `<row r="2"><c r="A2"><v>10</v></c></row>` +
        `</sheetData></worksheet>` }
  ]);
  assert.strictEqual(readSheet(buf, 'S').rows[0]['Regular'], 10);
});

// Difference 3. Isolated like this, a BOM does NOT defeat the pre-fix parser:
// it scans with regexes rather than parsing strictly, so three stray bytes in
// front of <?xml never stop it finding <sheet or <row. The test still earns its
// place — it pins that the BOM is removed rather than smuggled into the first
// header or value, which a mis-implemented strip would do.
test('difference 3: a UTF-8 BOM on every part is stripped, not treated as markup', () => {
  const buf = bbsi.buildPayrollXlsx([ROW], { ...ONLY, bom: true });

  // Confirm the fixture really does carry the BOM on all seven parts, or the
  // assertion below would be vacuous.
  const files = unzip(buf);
  const names = Object.keys(files);
  assert.strictEqual(names.length, 6); // no styles.xml in this variant
  for (const name of names) {
    assert.deepStrictEqual(files[name].subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), name);
  }

  const sheet = expectPayrollRow(buf);
  // And nothing leaked a U+FEFF into a header or a value.
  const text = JSON.stringify(sheet);
  assert.doesNotMatch(text, /﻿/);
});

// Difference 4. Also not a pre-fix failure on its own: the old code stripped a
// leading "/xl/" prefix and happened to cover the vendor's exact spelling. The
// case below it is the one that generalises, since a package path without the
// leading slash was not covered.
test('difference 4: an absolute rels target with a leading slash resolves', () => {
  const buf = bbsi.buildPayrollXlsx([ROW], { ...ONLY, absoluteTargets: true });
  expectPayrollRow(buf);
});

test('difference 4: relative, ./-prefixed and absolute rels targets all resolve', () => {
  for (const target of [
    'worksheets/sheet.xml',
    './worksheets/sheet.xml',
    '/xl/worksheets/sheet.xml',
    'xl/worksheets/sheet.xml'   // no leading slash, but a package path anyway
  ]) {
    const buf = zip([
      { name: 'xl/workbook.xml',
        data: `<workbook xmlns:r="${'http://x'}"><sheets>` +
          `<sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships><Relationship Id="rId1" Target="${target}"/></Relationships>` },
      { name: 'xl/worksheets/sheet.xml',
        data: `<worksheet><sheetData>` +
          `<row r="1"><c r="A1" t="inlineStr"><is><t>OT</t></is></c></row>` +
          `<row r="2"><c r="A2"><v>2.5</v></c></row></sheetData></worksheet>` }
    ]);
    assert.strictEqual(readSheet(buf, 'S').rows[0]['OT'], 2.5, `target ${target}`);
  }
});

// The style index on every cell.
test('a cell carrying s="10" is read for its value, the style index ignored', () => {
  const buf = bbsi.buildPayrollXlsx([ROW], { ...ONLY, styles: true, cellStyle: () => 10 });
  // ONLY leaves the part numbered, so styles are the single difference here.
  const sheetXml = unzip(buf)['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.match(sheetXml, /<c r="A1" s="10" t="s">/);   // the fixture really is styled
  expectPayrollRow(buf);
});

// All four at once, plus the style attributes: the real-world case.
test('the vendor file as it actually arrives — prefixes, BOM, sheet.xml, absolute targets, styles', () => {
  const buf = bbsi.buildPayrollXlsx([
    ROW,
    ['9290', 'Smith', 'Dale', 'Yes', 0, 0, 0, 0, 0]
  ]);

  assert.deepStrictEqual(Object.keys(unzip(buf)), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/sharedStrings.xml',
    'xl/styles.xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet.xml'
  ]);

  const sheet = readSheet(buf, 'Work Summary Payroll');
  assert.deepStrictEqual(sheet.headers, bbsi.PAYROLL_HEADERS);
  assert.strictEqual(sheet.rows.length, 2);
  assert.strictEqual(sheet.rows[0]['Emp #'], '0319');
  assert.strictEqual(sheet.rows[0]['Total Earnings'], 336.88);
  assert.strictEqual(sheet.rows[1]['Is Salary'], 'Yes');
});

// ============================================================
// Styles are read by nobody, and must stay that way
// ============================================================

test('a date-formatted numeric cell stays a number and is not read as a date serial', () => {
  // numFmtId 14 is Excel's built-in m/d/yy. The vendor's export has a styles
  // part but no date column, so a styled number must come back as a number. If
  // anyone ever teaches this reader about styles, this is the line that should
  // stop them doing it silently.
  const buf = bbsi.buildXlsx({
    sheetName: 'S',
    rows: [['Total Hours', 'Pay Rate'], [45658, 24.5]],  // 45658 = 2025-01-01 as a serial
    styles: true,
    cellStyle: (value, r) => (r === 0 ? 1 : bbsi.DATE_STYLE_INDEX)
  });

  const sheetXml = unzip(buf)['xl/worksheets/sheet.xml'].toString('utf8');
  assert.match(sheetXml, /s="14"/);           // the cell really is date-formatted

  const row = readSheet(buf, 'S').rows[0];
  assert.strictEqual(typeof row['Total Hours'], 'number');
  assert.strictEqual(row['Total Hours'], 45658);
  assert.strictEqual(row['Pay Rate'], 24.5);
  assert.ok(!(row['Total Hours'] instanceof Date));
});

// ============================================================
// Namespace-prefixed attributes
// ============================================================

test('the relationship id is found whatever prefix the relationships namespace has', () => {
  // Excel writes r:id. The prefix is the writer's choice, so ss:id or q:id name
  // the same attribute. Paired with the singular sheet.xml there is no numbered
  // fallback to accidentally rescue a missed relationship id.
  for (const relPrefix of ['r', 'q', 'rel']) {
    const buf = bbsi.buildPayrollXlsx([ROW], { relPrefix });
    assert.strictEqual(
      readSheet(buf, 'Work Summary Payroll').rows[0]['Last Name'], 'Acosta Ruiz',
      `relPrefix ${relPrefix}`);
  }
});

test('a bare id= does not get mistaken for the relationship id', () => {
  // Loose attribute matching would let attr(attrs, 'id') answer with r:id, or
  // worse, pick whichever of the two came first. r:id is the relationship; a
  // bare id= is a different attribute that happens to end in the same letters.
  const buf = zip([
    { name: 'xl/workbook.xml',
      data: `<workbook xmlns:r="http://x"><sheets>` +
        `<sheet name="S" sheetId="1" id="rIdWrong" r:id="rIdRight"/>` +
        `</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships>` +
        `<Relationship Id="rIdRight" Target="worksheets/right.xml"/>` +
        `<Relationship Id="rIdWrong" Target="worksheets/wrong.xml"/>` +
        `</Relationships>` },
    { name: 'xl/worksheets/right.xml',
      data: `<worksheet><sheetData>` +
        `<row r="1"><c r="A1" t="inlineStr"><is><t>Which</t></is></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>right</t></is></c></row>` +
        `</sheetData></worksheet>` },
    { name: 'xl/worksheets/wrong.xml',
      data: `<worksheet><sheetData>` +
        `<row r="1"><c r="A1" t="inlineStr"><is><t>Which</t></is></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>wrong</t></is></c></row>` +
        `</sheetData></worksheet>` }
  ]);
  assert.strictEqual(readSheet(buf, 'S').rows[0]['Which'], 'right');
});

test('an element whose local name merely starts the same is not matched', () => {
  // <row> must not be matched by <rowBreaks>, and <c> must not be matched by
  // <cols> — in either dialect.
  for (const prefix of ['', 'x:']) {
    const buf = zip([
      { name: 'xl/workbook.xml',
        data: `<${prefix}workbook xmlns:r="http://x"><${prefix}sheets>` +
          `<${prefix}sheetPr/><${prefix}sheet name="S" sheetId="1" r:id="rId1"/>` +
          `</${prefix}sheets></${prefix}workbook>` },
      { name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: 'xl/worksheets/sheet1.xml',
        data: `<${prefix}worksheet><${prefix}cols><${prefix}col min="1" max="1"/></${prefix}cols>` +
          `<${prefix}sheetData>` +
          `<${prefix}row r="1"><${prefix}c r="A1" t="inlineStr">` +
          `<${prefix}is><${prefix}t>Regular</${prefix}t></${prefix}is></${prefix}c></${prefix}row>` +
          `<${prefix}row r="2"><${prefix}c r="A2"><${prefix}v>10</${prefix}v></${prefix}c></${prefix}row>` +
          `</${prefix}sheetData>` +
          `<${prefix}rowBreaks count="0"/></${prefix}worksheet>` }
    ]);
    const sheet = readSheet(buf, 'S');
    assert.deepStrictEqual(sheet.headers, ['Regular'], `prefix "${prefix}"`);
    assert.strictEqual(sheet.rows.length, 1, `prefix "${prefix}"`);
    assert.strictEqual(sheet.rows[0]['Regular'], 10, `prefix "${prefix}"`);
  }
});

// ============================================================
// Cell type coverage the vendor file does not use but Excel emits
//
// These are hand-written XML rather than generator output, because the point is
// a cell type neither generator emits. Each one is written in both dialects.
// ============================================================

for (const prefix of ['', 'x:']) {
  const p = name => `${prefix}${name}`;
  const label = prefix ? ' [x: prefix]' : ' [bare]';

  test('inline strings, cached formula strings and booleans all read' + label, () => {
    const xml = `<?xml version="1.0"?><${p('worksheet')} xmlns:x="${bbsi.MAIN_NS}"><${p('sheetData')}>` +
      `<${p('row')} r="1"><${p('c')} r="A1" t="inlineStr"><${p('is')}><${p('t')}>Emp #</${p('t')}></${p('is')}></${p('c')}>` +
      `<${p('c')} r="B1" t="inlineStr"><${p('is')}><${p('t')}>Flag</${p('t')}></${p('is')}></${p('c')}>` +
      `<${p('c')} r="C1" t="inlineStr"><${p('is')}><${p('t')}>Calc</${p('t')}></${p('is')}></${p('c')}></${p('row')}>` +
      `<${p('row')} r="2"><${p('c')} r="A2" t="inlineStr"><${p('is')}><${p('t')}>0319</${p('t')}></${p('is')}></${p('c')}>` +
      `<${p('c')} r="B2" t="b"><${p('v')}>1</${p('v')}></${p('c')}>` +
      `<${p('c')} r="C2" t="str"><${p('v')}>OK</${p('v')}></${p('c')}></${p('row')}>` +
      `<${p('row')} r="3"><${p('c')} r="A3" t="inlineStr"><${p('is')}><${p('t')}>0063</${p('t')}></${p('is')}></${p('c')}>` +
      `<${p('c')} r="B3" t="b"><${p('v')}>0</${p('v')}></${p('c')}>` +
      `<${p('c')} r="C3" t="e"><${p('v')}>#N/A</${p('v')}></${p('c')}></${p('row')}>` +
      `</${p('sheetData')}></${p('worksheet')}>`;

    const buf = zip([
      { name: 'xl/workbook.xml',
        data: `<${p('workbook')} xmlns:r="x"><${p('sheets')}>` +
          `<${p('sheet')} name="S" sheetId="1" r:id="rId1"/></${p('sheets')}></${p('workbook')}>` },
      { name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: 'xl/worksheets/sheet1.xml', data: xml }
    ]);

    const rows = readSheet(buf, 'S').rows;
    assert.strictEqual(rows[0]['Emp #'], '0319');
    assert.strictEqual(rows[0]['Flag'], true);
    assert.strictEqual(rows[0]['Calc'], 'OK');
    assert.strictEqual(rows[1]['Flag'], false);
    assert.strictEqual(rows[1]['Calc'], null);   // #N/A reads as empty, not the literal
  });

  test('rich-text runs concatenate into one string' + label, () => {
    const shared = `<${p('sst')} xmlns:x="${bbsi.MAIN_NS}">` +
      `<${p('si')}><${p('r')}><${p('t')}>Work </${p('t')}></${p('r')}>` +
      `<${p('r')}><${p('t')}>Summary</${p('t')}></${p('r')}></${p('si')}></${p('sst')}>`;
    const sheet = `<${p('worksheet')}><${p('sheetData')}>` +
      `<${p('row')} r="1"><${p('c')} r="A1" t="s"><${p('v')}>0</${p('v')}></${p('c')}></${p('row')}>` +
      `<${p('row')} r="2"><${p('c')} r="A2"><${p('v')}>7</${p('v')}></${p('c')}></${p('row')}>` +
      `</${p('sheetData')}></${p('worksheet')}>`;
    const buf = zip([
      { name: 'xl/workbook.xml',
        data: `<${p('workbook')} xmlns:r="x"><${p('sheets')}>` +
          `<${p('sheet')} name="S" sheetId="1" r:id="rId1"/></${p('sheets')}></${p('workbook')}>` },
      { name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: 'xl/sharedStrings.xml', data: shared },
      { name: 'xl/worksheets/sheet1.xml', data: sheet }
    ]);
    assert.strictEqual(readSheet(buf, 'S').rows[0]['Work Summary'], 7);
  });
}
