const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function hdrs() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation'
  };
}

async function query(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, { headers: hdrs() });
  if (!res.ok) throw new Error(`GET ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function insert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: hdrs(), body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`INSERT ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function update(table, id, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: hdrs(), body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`UPDATE ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function remove(table, id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE', headers: hdrs()
  });
  if (!res.ok) throw new Error(`DELETE ${table} ${res.status}: ${await res.text()}`);
  return true;
}

async function replaceAll(table, rows) {
  // Delete all then insert fresh batch
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=neq.00000000-0000-0000-0000-000000000000`, {
    method: 'DELETE', headers: hdrs()
  });
  if (!rows.length) return [];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: hdrs(), body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`BATCH INSERT ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = { query, insert, update, remove, replaceAll };
