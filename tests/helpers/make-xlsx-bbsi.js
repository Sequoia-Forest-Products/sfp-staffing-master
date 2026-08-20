// A SECOND .xlsx generator, in the payroll vendor's (BBSI's) OOXML dialect.
//
// Why a second one exists: tests/helpers/make-xlsx.js emits exactly the OOXML
// that xlsx-lite was written against — default xmlns, bare element names,
// xl/worksheets/sheet1.xml, no BOM, relative rels targets. A fixture built by
// code that shares the parser's assumptions cannot falsify those assumptions,
// which is how twenty green tests still met "This .xlsx contains no worksheets"
// on the first real vendor attachment.
//
// So the XML below is written from the observed structure of that attachment,
// not derived from the other helper:
//
//   [Content_Types].xml, _rels/.rels, xl/_rels/workbook.xml.rels,
//   xl/sharedStrings.xml, xl/styles.xml, xl/workbook.xml,
//   xl/worksheets/sheet.xml
//
//   * every spreadsheetml element carries a namespace PREFIX — <x:workbook>,
//     <x:sheets>, <x:sheet>, <x:worksheet>, <x:sst>, <x:si>, <x:t>, <x:row>,
//     <x:c>, <x:v> — bound on the root as
//     xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
//   * the worksheet part is SINGULAR: xl/worksheets/sheet.xml, no digit
//   * every part starts with a UTF-8 BOM (ef bb bf) before <?xml
//   * rels Targets are absolute package paths: "/xl/worksheets/sheet.xml"
//   * every cell carries a style index, e.g. <x:c r="A1" s="10" t="s">
//
// The prefix is deliberately a parameter. It is "x" in the real file, but a
// prefix is the writer's arbitrary choice, so the tests run this at "x", at
// something else, and at no prefix at all (default xmlns) to prove the parser
// keys on local names.
//
// The one thing shared with make-xlsx.js is its ZIP writer. That is the
// container, not the XML dialect — the ZIP bytes are not what differs between
// the two writers, and duplicating a CRC table would test nothing.

const { zip } = require('./make-xlsx');

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const escapeXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

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

// The real file's style table, near enough: index 10 is the text format the
// header and string cells use, index 7 a two-decimal number, and index 14 a
// BUILT-IN DATE format (numFmtId 14 is m/d/yy). Index 14 exists so a test can
// hand the parser a date-formatted numeric cell and pin that it comes back as a
// number — we do not read styles, and nothing should start inferring dates.
const CELL_XFS = [
  { numFmtId: 0 },   // 0  general
  { numFmtId: 49 },  // 1  text
  { numFmtId: 0 },   // 2
  { numFmtId: 0 },   // 3
  { numFmtId: 0 },   // 4
  { numFmtId: 0 },   // 5
  { numFmtId: 2 },   // 6  0.00
  { numFmtId: 164 }, // 7  custom 0.00
  { numFmtId: 0 },   // 8
  { numFmtId: 0 },   // 9
  { numFmtId: 49 },  // 10 text
  { numFmtId: 0 },   // 11
  { numFmtId: 0 },   // 12
  { numFmtId: 0 },   // 13
  { numFmtId: 14 },  // 14 m/d/yy — a DATE format
];

// Default styling: header row in the text format, strings text, numbers 0.00.
// Every cell gets an s=, which is what the vendor writes.
const defaultCellStyle = (value, rowIndex) => {
  if (rowIndex === 0) return 1;
  return typeof value === 'number' ? 7 : 10;
};

function build({
  sheetName = 'Sheet1',
  rows = [],
  extraSheets = [],
  deflate = true,
  prefix = 'x',            // '' means "no prefix, default xmlns" instead
  relPrefix = 'r',         // the prefix bound to the relationships namespace
  bom = true,              // UTF-8 BOM on every part, as the real file has
  absoluteTargets = true,  // rels Target="/xl/..." rather than "worksheets/..."
  styles = true,           // emit xl/styles.xml and s= on every cell
  cellStyle = defaultCellStyle,
  singularSheetPart = true // xl/worksheets/sheet.xml, no numeric suffix
} = {}) {
  // Element name in this file's dialect.
  const q = name => (prefix ? `${prefix}:${name}` : name);
  // The namespace declaration that makes q() legal on a root element.
  const mainNsDecl = prefix ? `xmlns:${prefix}="${MAIN_NS}"` : `xmlns="${MAIN_NS}"`;
  const relAttr = relPrefix ? `${relPrefix}:id` : 'id';

  const shared = [];
  const sharedIndex = new Map();
  const internString = text => {
    if (!sharedIndex.has(text)) {
      sharedIndex.set(text, shared.length);
      shared.push(text);
    }
    return sharedIndex.get(text);
  };

  const cellXml = (value, rowIndex, colIndex) => {
    if (value === null || value === undefined) return ''; // a genuine gap
    const ref = `${columnLetter(colIndex)}${rowIndex + 1}`;
    const index = styles ? cellStyle(value, rowIndex, colIndex) : null;
    const s = index === null || index === undefined ? '' : ` s="${index}"`;
    if (typeof value === 'number') {
      return `<${q('c')} r="${ref}"${s}><${q('v')}>${value}</${q('v')}></${q('c')}>`;
    }
    const at = internString(String(value));
    return `<${q('c')} r="${ref}"${s} t="s"><${q('v')}>${at}</${q('v')}></${q('c')}>`;
  };

  const worksheetXml = data => {
    const body = data.map((row, r) =>
      `<${q('row')} r="${r + 1}">` +
      row.map((value, c) => cellXml(value, r, c)).join('') +
      `</${q('row')}>`
    ).join('');
    return `<?xml version="1.0" encoding="utf-8"?>` +
      `<${q('worksheet')} ${mainNsDecl}>` +
      `<${q('sheetData')}>${body}</${q('sheetData')}>` +
      `</${q('worksheet')}>`;
  };

  // The first worksheet part is the singular sheet.xml the vendor writes;
  // additional sheets (which the real export does not have) get suffixes so
  // they land on distinct part names.
  const sheetSpecs = [{ name: sheetName, rows }, ...extraSheets].map((s, i) => ({
    name: s.name,
    relId: `rId${i + 1}`,
    part: i === 0 && singularSheetPart
      ? 'xl/worksheets/sheet.xml'
      : `xl/worksheets/sheet${i + 1}.xml`,
    xml: worksheetXml(s.rows || [])
  }));

  const workbookXml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<${q('workbook')} ${mainNsDecl}` +
    (relPrefix ? ` xmlns:${relPrefix}="${REL_NS}"` : '') + `>` +
    `<${q('sheets')}>` +
    sheetSpecs.map((s, i) =>
      `<${q('sheet')} name="${escapeXml(s.name)}" sheetId="${i + 1}" ` +
      `${relAttr}="${s.relId}" />`).join('') +
    `</${q('sheets')}>` +
    `</${q('workbook')}>`;

  // Written after the worksheets, since writing them is what fills the table.
  const sharedStringsXml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<${q('sst')} ${mainNsDecl} count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map(s => `<${q('si')}><${q('t')}>${escapeXml(s)}</${q('t')}></${q('si')}>`).join('') +
    `</${q('sst')}>`;

  const stylesXml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<${q('styleSheet')} ${mainNsDecl}>` +
    `<${q('numFmts')} count="1">` +
    `<${q('numFmt')} numFmtId="164" formatCode="0.00" />` +
    `</${q('numFmts')}>` +
    `<${q('fonts')} count="1"><${q('font')}><${q('sz')} val="11" />` +
    `<${q('name')} val="Calibri" /></${q('font')}></${q('fonts')}>` +
    `<${q('fills')} count="1"><${q('fill')}><${q('patternFill')} patternType="none" />` +
    `</${q('fill')}></${q('fills')}>` +
    `<${q('borders')} count="1"><${q('border')} /></${q('borders')}>` +
    `<${q('cellXfs')} count="${CELL_XFS.length}">` +
    CELL_XFS.map(xf =>
      `<${q('xf')} numFmtId="${xf.numFmtId}" fontId="0" fillId="0" borderId="0" ` +
      `applyNumberFormat="1" />`).join('') +
    `</${q('cellXfs')}>` +
    `</${q('styleSheet')}>`;

  const target = path => (absoluteTargets ? `/${path}` : path.replace(/^xl\//, ''));

  const workbookRels =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    sheetSpecs.map(s =>
      `<Relationship Id="${s.relId}" Type="${REL_NS}/worksheet" ` +
      `Target="${target(s.part)}" />`).join('') +
    `<Relationship Id="rIdSst" Type="${REL_NS}/sharedStrings" ` +
    `Target="${target('xl/sharedStrings.xml')}" />` +
    (styles
      ? `<Relationship Id="rIdStyles" Type="${REL_NS}/styles" ` +
        `Target="${target('xl/styles.xml')}" />`
      : '') +
    `</Relationships>`;

  const packageRels =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" ` +
    `Target="${absoluteTargets ? '/xl/workbook.xml' : 'xl/workbook.xml'}" />` +
    `</Relationships>`;

  const SML = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const contentTypes =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<Types xmlns="${CT_NS}">` +
    `<Default Extension="rels" ` +
    `ContentType="application/vnd.openxmlformats-package.relationships+xml" />` +
    `<Default Extension="xml" ContentType="application/xml" />` +
    `<Override PartName="/xl/workbook.xml" ContentType="${SML}.sheet.main+xml" />` +
    sheetSpecs.map(s =>
      `<Override PartName="/${s.part}" ContentType="${SML}.worksheet+xml" />`).join('') +
    `<Override PartName="/xl/sharedStrings.xml" ` +
    `ContentType="${SML}.sharedStrings+xml" />` +
    (styles
      ? `<Override PartName="/xl/styles.xml" ContentType="${SML}.styles+xml" />`
      : '') +
    `</Types>`;

  // The BOM goes on EVERY part, which is what the real attachment does.
  const part = (name, xml) => ({
    name,
    data: bom ? Buffer.concat([BOM, Buffer.from(xml, 'utf8')]) : Buffer.from(xml, 'utf8')
  });

  const entries = [
    part('[Content_Types].xml', contentTypes),
    part('_rels/.rels', packageRels),
    part('xl/_rels/workbook.xml.rels', workbookRels),
    part('xl/sharedStrings.xml', sharedStringsXml),
    ...(styles ? [part('xl/styles.xml', stylesXml)] : []),
    part('xl/workbook.xml', workbookXml),
    ...sheetSpecs.map(s => part(s.part, s.xml))
  ];

  return zip(entries, { deflate });
}

// Same headers and same call shape as make-xlsx.js's builder, so the whole
// behavioural suite can be run over both generators with the same assertions.
const PAYROLL_HEADERS = [
  'Emp #', 'Last Name', 'First Name', 'Is Salary',
  'Pay Rate', 'Regular', 'OT', 'Total Hours', 'Total Earnings'
];

function buildPayrollXlsx(dataRows = [], opts = {}) {
  return build({
    sheetName: 'Work Summary Payroll',
    rows: [PAYROLL_HEADERS, ...dataRows],
    ...opts
  });
}

module.exports = {
  buildXlsx: build,
  buildPayrollXlsx,
  PAYROLL_HEADERS,
  FIRST_SHEET_PART: 'xl/worksheets/sheet.xml',
  CELL_XFS,
  DATE_STYLE_INDEX: 14,
  MAIN_NS
};
