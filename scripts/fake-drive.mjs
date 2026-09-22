/* A fake Google Drive for the smoke: enough of the files API for a sync. */
export function fakeDrive(page) {
  const files = new Map();
  let seq = 0;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = { deny401: false, calls: [] };
  page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    state.calls.push(`${method} ${url.pathname}`);
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (state.deny401) return json(route, { error: 'unauthorised' }, 401);
    const m = url.pathname.match(/\/files\/([^/]+)$/);
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const list = [...files.values()].filter((f) => (q.includes('folder') ? f.mimeType === 'application/vnd.google-apps.folder' : f.mimeType !== 'application/vnd.google-apps.folder'));
      return json(route, { files: list.map((f) => ({ id: f.id, name: f.name, appProperties: f.appProperties })) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(req.postData());
      const id = `f${++seq}`;
      files.set(id, { id, ...meta });
      return json(route, { id });
    }
    if (url.pathname.startsWith('/upload/drive/v3/files')) {
      const body = req.postData();
      const boundary = body.slice(2, body.indexOf('\r\n'));
      const parts = body.split(`--${boundary}`).filter((p) => p.includes('\r\n\r\n'));
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim());
      const content = parts[1].split('\r\n\r\n')[1].trim();
      const up = url.pathname.match(/\/files\/([^/]+)$/);
      const id = up ? up[1] : `f${++seq}`;
      files.set(id, { ...(files.get(id) ?? {}), id, mimeType: 'application/json', ...meta, content });
      return json(route, { id });
    }
    if (m && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const f = files.get(m[1]);
      return f ? route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: f.content }) : json(route, {}, 404);
    }
    if (m && method === 'DELETE') {
      files.delete(m[1]);
      return route.fulfill({ status: 204, headers: cors });
    }
    return json(route, { error: 'unexpected' }, 400);
  });
  return { files, state, seed: (drawing, savedAt) => { const id = `f${++seq}`; files.set(id, { id, name: 'seed', mimeType: 'application/json', appProperties: { isoId: drawing.id, savedAt: String(savedAt) }, content: JSON.stringify(drawing) }); return id; } };
}
