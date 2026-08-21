const { verifySession, getCookies } = require('./session-lib');
const SHARED_DRIVE_ID = process.env.SHARED_DRIVE_ID || '0AKnhIL1gZ8TmUk9PVA';

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

// Get the employee's folder: HR Shared Drive → Employee Files → [Employee Name]
async function getEmployeeFolder(accessToken, employeeName) {
  // Step 1: find Employee Files inside the Shared Drive root
  let empFiles = await findFolder(accessToken, SHARED_DRIVE_ID, 'Employee Files');
  if (!empFiles) {
    empFiles = await createFolder(accessToken, SHARED_DRIVE_ID, 'Employee Files');
  }
  if (!empFiles || !empFiles.id) {
    throw new Error('Could not find or create Employee Files folder in Shared Drive');
  }

  // Step 2: find or create the employee's subfolder
  let empFolder = await findFolder(accessToken, empFiles.id, employeeName);
  if (!empFolder) {
    empFolder = await createFolder(accessToken, empFiles.id, employeeName);
  }
  if (!empFolder || !empFolder.id) {
    throw new Error(`Could not find or create folder for ${employeeName}`);
  }

  return { id: empFolder.id, link: empFolder.webViewLink };
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
      const folder = await getEmployeeFolder(access_token, params.employee);
      const files  = await listFiles(access_token, folder.id);
      return { statusCode: 200, headers, body: JSON.stringify({ folderId: folder.id, folderLink: folder.link, files: files.files || [] }) };
    }

    if (method === 'POST') {
      const { employeeName, fileName, mimeType, base64Data, docType, notes } = JSON.parse(event.body || '{}');
      if (!employeeName || !fileName || !base64Data)
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };

      const folder = await getEmployeeFolder(access_token, employeeName);
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
