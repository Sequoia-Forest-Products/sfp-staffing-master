const { verifySession, getCookies } = require('./session-lib');
const SHARED_DRIVE_ID = process.env.SHARED_DRIVE_ID || '0AKnhIL1gZ8TmUk9PVA';

// THE PARENT OF EVERY EMPLOYEE FOLDER, BY ID.
//
// It used to be found by searching the shared drive's root for a folder NAMED
// 'Employee Files', every time, for every profile opened. That is three things
// that can each go wrong silently — the drive id, the folder's name, and the
// search itself — in front of a link that is the same link every time.
//
// An id cannot be renamed. Renaming the folder in Drive now changes nothing.
//
// NOTE THE LAST CHARACTER OF THE ELEVENTH POSITION. README.md and .env.example
// both recorded this folder as ...jpQO8fTr... with an EIGHT; the real folder is
// ...jpQOBfTr... with a B. One character, transcribed wrong, in the two places
// somebody would go to look it up. DOCS_FOLDER_ID was never read by any code,
// so the typo broke nothing and sat there being wrong instead.
const EMPLOYEE_FILES_FOLDER_ID =
  process.env.EMPLOYEE_FILES_FOLDER_ID ||
  process.env.DOCS_FOLDER_ID ||
  '1TMyTQVjpQOBfTrGppx4KchaHRimwIi9Q';

// Search for a folder by name within a parent, scoped to the shared drive
async function findFolder(accessToken, parentId, name) {
  const q = `name='${name.replace(/'/g,"\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=drive&driveId=${SHARED_DRIVE_ID}&q=${encodeURIComponent(q)}&fields=files(id,webViewLink)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  console.log(`findFolder "${name}" in ${parentId}:`, JSON.stringify(data));
  if (data.files && data.files.length > 0) return data.files[0];
  return null;
}

// Create a folder inside a parent within the shared drive
async function createFolder(accessToken, parentId, name) {
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    }
  );
  const data = await res.json();
  console.log(`createFolder "${name}" in ${parentId}:`, JSON.stringify(data));
  return data;
}

// Get the employee's folder: Employee Files → [Employee Name]
//
// `create` IS NOT DEFAULTED TO TRUE, and that is a behaviour change worth
// stating. A plain GET used to CREATE the folder if it was missing, so merely
// opening somebody's profile made a folder in Drive — while the page said "will
// be created on first upload", which was not what was happening. Reads find;
// the upload creates.
async function getEmployeeFolder(accessToken, employeeName, { create = false } = {}) {
  // Step 1 is gone. The parent is an id now — see EMPLOYEE_FILES_FOLDER_ID.
  // A folder rename in Drive used to break every link on the page.
  const parentId = EMPLOYEE_FILES_FOLDER_ID;

  let empFolder = await findFolder(accessToken, parentId, employeeName);
  if (!empFolder && create) {
    empFolder = await createFolder(accessToken, parentId, employeeName);
  }
  if (!empFolder || !empFolder.id) {
    return {
      id: null, link: null,
      reason: create
        ? `Drive would not create a folder for ${employeeName}.`
        : `No folder named "${employeeName}" inside the Employee Files folder. ` +
          `Drive matches the name EXACTLY — a folder named differently from the ` +
          `roster (a middle initial, a married name, a trailing space) will not be found.`
    };
  }

  return { id: empFolder.id, link: empFolder.webViewLink || null, reason: null };
}

async function listFiles(accessToken, folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,createdTime,description,webViewLink)&orderBy=createdTime desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

async function uploadFile(accessToken, folderId, fileName, mimeType, base64Data, description) {
  const boundary = 'SFP_' + Date.now();
  const metaPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: fileName, parents: [folderId], description: description || '' }) +
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`
  );
  const body = Buffer.concat([metaPart, Buffer.from(base64Data), Buffer.from(`\r\n--${boundary}--`)]);
  console.log(`Uploading "${fileName}" (${body.length} bytes) to folder ${folderId}`);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`
      },
      body
    }
  );
  const result = await res.json();
  console.log('Upload result:', res.status, JSON.stringify(result));
  return result;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const { access_token, email } = session;
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === 'GET' && params.employee) {
      // A read does not create. `reason` travels with the miss so the page can
      // say WHY rather than "No folder found", which reads as "there isn't one"
      // when the truth is usually "it is named something else".
      const folder = await getEmployeeFolder(access_token, params.employee);
      if (!folder.id) {
        return { statusCode: 200, headers, body: JSON.stringify({
          folderId: null, folderLink: null, files: [], reason: folder.reason,
          searchedIn: EMPLOYEE_FILES_FOLDER_ID }) };
      }
      const files = await listFiles(access_token, folder.id);
      return { statusCode: 200, headers, body: JSON.stringify({
        folderId: folder.id, folderLink: folder.link, files: files.files || [] }) };
    }

    if (method === 'POST') {
      const { employeeName, fileName, mimeType, base64Data, docType, notes } = JSON.parse(event.body || '{}');
      if (!employeeName || !fileName || !base64Data)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };

      // The upload is the thing that creates, which is what the page has always
      // said happens.
      const folder = await getEmployeeFolder(access_token, employeeName, { create: true });
      if (!folder.id) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: folder.reason }) };
      }
      const description = [docType, notes, `Uploaded by ${email}`].filter(Boolean).join(' | ');
      const result = await uploadFile(access_token, folder.id, fileName, mimeType || 'application/octet-stream', base64Data, description);

      if (result.id)
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, file: result, folderLink: folder.link }) };
      else
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Upload failed', detail: result }) };
    }

    if (method === 'DELETE' && params.fileId) {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${params.fileId}?supportsAllDrives=true`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${access_token}` } }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ success: res.ok }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
