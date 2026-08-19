// Builds a real .xlsx in memory so the parser tests run against an actual ZIP
// container rather than a hand-stubbed object. Test-only: nothing in
// netlify/functions requires this.

const zlib = require('zlib');

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// entries: [{ name, data: string|Buffer }]. `deflate` exercises method 8;
// otherwise entries are stored (method 0). Both appear in real .xlsx files.
function zip(entries, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const name = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0x21, 12);         // mod date (1996-01-01)
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

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

// rows: array of arrays. Strings go through the shared string table (what Excel
// actually emits); numbers are written as numeric cells; null/undefined are
// omitted so gaps in a row are genuinely missing cells, not empty ones.
function buildXlsx({ sheetName = 'Sheet1', rows = [], deflate = true, extraSheets = [] } = {}) {
  const shared = [];
  const sharedIndex = new Map();

  const sheetXml = (name, data) => {
    const body = data.map((row, r) => {
      const cells = row.map((value, c) => {
        if (value === null || value === undefined) return '';
        const ref = `${columnLetter(c)}${r + 1}`;
        if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
        const text = String(value);
        if (!sharedIndex.has(text)) {
          sharedIndex.set(text, shared.length);
          shared.push(text);
        }
        return `<c r="${ref}" t="s"><v>${sharedIndex.get(text)}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${body}</sheetData></worksheet>`;
  };

  const sheets = [{ name: sheetName, rows }, ...extraSheets];
  const sheetParts = sheets.map((s, i) => ({
    name: s.name,
    path: `xl/worksheets/sheet${i + 1}.xml`,
    relId: `rId${i + 1}`,
    xml: sheetXml(s.name, s.rows)
  }));

  const sharedStrings =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map(s => `<si><t>${escapeXml(s)}</t></si>`).join('') + `</sst>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    sheetParts.map((s, i) =>
      `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="${s.relId}"/>`).join('') +
    `</sheets></workbook>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheetParts.map(s =>
      `<Relationship Id="${s.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.path.split('/').pop()}"/>`).join('') +
    `<Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/></Types>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
    ...sheetParts.map(s => ({ name: s.path, data: s.xml }))
  ], { deflate });
}

// The vendor's export, as a builder: header row plus whatever rows are passed.
const PAYROLL_HEADERS = [
  'Emp #', 'Last Name', 'First Name', 'Is Salary',
  'Pay Rate', 'Regular', 'OT', 'Total Hours', 'Total Earnings'
];

function buildPayrollXlsx(dataRows, opts = {}) {
  return buildXlsx({
    sheetName: 'Work Summary Payroll',
    rows: [PAYROLL_HEADERS, ...dataRows],
    ...opts
  });
}

module.exports = { buildXlsx, buildPayrollXlsx, zip, crc32, PAYROLL_HEADERS };
