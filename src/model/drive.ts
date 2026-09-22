import type { Drawing } from './types';
import { loadLibrary, upsertDrawing, type LibraryEntry } from './library';

/**
 * Keeping the library in Google Drive, so the iPad and the office PC see
 * the same sheets. The app talks to Drive itself, from the browser, with a
 * token Google hands back after a sign-in page: there is no server of ours
 * in between and nothing but the drawings goes anywhere.
 *
 * One folder, "Isometric Piping", one file per drawing, and every file
 * carries the drawing's own id and when it was last saved. A sync compares
 * that with what this device holds and moves the newer copy each way.
 */

const KEY_CLIENT = 'iso-draw.drive.client';
const KEY_TOKEN = 'iso-draw.drive.token';
const KEY_STATE = 'iso-draw.drive.state';
const KEY_REMOVED = 'iso-draw.drive.removed';
const KEY_LAST = 'iso-draw.drive.last';
const FOLDER = 'Isometric Piping';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveStatus {
  clientId: string;
  /** Signed in, with a token that has not run out. */
  connected: boolean;
  last: { at: number; up: number; down: number; removed: number } | null;
}

export interface SyncResult {
  up: number;
  down: number;
  removed: number;
  /** The ids of drawings this device took from Drive. */
  downloaded: string[];
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: syncing just does not remember.
  }
}

export function driveClientId(): string {
  return read<string>(KEY_CLIENT) ?? '';
}

export function setDriveClientId(id: string): void {
  write(KEY_CLIENT, id.trim() || null);
}

/** The token to talk to Drive with, or null once it has run out. */
export function driveToken(): string | null {
  const t = read<{ token: string; expires: number }>(KEY_TOKEN);
  return t && t.expires > Date.now() + 30_000 ? t.token : null;
}

export function driveStatus(): DriveStatus {
  return { clientId: driveClientId(), connected: driveToken() !== null, last: read(KEY_LAST) };
}

/** Where Google is to send the browser back to: this page, without a file name. */
export function driveRedirectUri(): string {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** Goes to Google's sign-in page; it comes back to the app with a token in the address. */
export function beginDriveSignIn(): void {
  const clientId = driveClientId();
  if (!clientId) return;
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  write(KEY_STATE, state);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', driveRedirectUri());
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  location.assign(url.toString());
}

/**
 * Picks the token out of the address after Google sends the browser back.
 * Returns whether a sign-in just finished; the address is tidied either way.
 */
export function finishDriveSignIn(): boolean {
  const hash = location.hash;
  if (!hash.includes('access_token=')) return false;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('access_token');
  const state = params.get('state');
  const expiresIn = Number(params.get('expires_in') ?? 3600);
  history.replaceState(null, '', location.pathname + location.search);
  const expected = read<string>(KEY_STATE);
  write(KEY_STATE, null);
  if (!token || !state || state !== expected) return false;
  write(KEY_TOKEN, { token, expires: Date.now() + Math.max(60, expiresIn) * 1000 });
  return true;
}

export function driveSignOut(): void {
  write(KEY_TOKEN, null);
}

/** A sheet forgotten here is taken out of Drive at the next sync, not brought back. */
export function noteRemovedFromLibrary(id: string): void {
  const removed = new Set(read<string[]>(KEY_REMOVED) ?? []);
  removed.add(id);
  write(KEY_REMOVED, [...removed]);
}

interface DriveFile {
  id: string;
  name: string;
  appProperties?: { isoId?: string; savedAt?: string };
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    driveSignOut();
    throw new Error('Google Drive asks for a sign-in again.');
  }
  if (!res.ok) throw new Error(`Google Drive answered ${res.status}.`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function folderId(token: string): Promise<string> {
  const q = `name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await call<{ files: DriveFile[] }>(token, `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  if (found.files.length > 0) return found.files[0].id;
  const made = await call<DriveFile>(token, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return made.id;
}

function fileName(drawing: Drawing): string {
  const m = drawing.meta;
  const what = [m.project || 'No project', m.lineNumber || m.drawingNo || '', m.sheet ? `sheet ${m.sheet}` : '']
    .filter(Boolean)
    .join(' - ')
    .replace(/[\\/:*?"<>|]/g, '-');
  return `${what} [${drawing.id}].iso.json`;
}

async function upload(token: string, folder: string, entry: LibraryEntry, existingId: string | null): Promise<void> {
  const meta: Record<string, unknown> = {
    name: fileName(entry.drawing),
    mimeType: 'application/json',
    appProperties: { isoId: entry.id, savedAt: String(entry.savedAt) },
  };
  if (!existingId) meta.parents = [folder];
  const boundary = `iso${Date.now().toString(36)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(entry.drawing)}\r\n--${boundary}--`;
  const url = existingId ? `${UPLOAD}/files/${existingId}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`;
  await call(token, url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

/**
 * Brings this device and Drive to the same set of sheets: the newer copy of
 * each goes to the other side, a sheet only one side has goes over, and a
 * sheet forgotten here goes out of Drive. Returns what moved.
 */
export async function syncDrive(): Promise<SyncResult> {
  const token = driveToken();
  if (!token) throw new Error('Not signed in to Google Drive.');
  const folder = await folderId(token);
  const q = `'${folder}' in parents and trashed=false`;
  const listed = await call<{ files: DriveFile[] }>(
    token,
    `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,appProperties)&pageSize=1000&spaces=drive`,
  );
  const remote = new Map<string, DriveFile>();
  for (const f of listed.files) if (f.appProperties?.isoId) remote.set(f.appProperties.isoId, f);

  const removed = new Set(read<string[]>(KEY_REMOVED) ?? []);
  const local = new Map(loadLibrary().map((e) => [e.id, e]));
  const result: SyncResult = { up: 0, down: 0, removed: 0, downloaded: [] };
  // A stamp is set where the sheet was edited and carried across as it
  // is, so the same stamp on both sides means the same copy; any newer
  // stamp means an edit, however soon after the last sync.
  for (const [id, entry] of local) {
    const file = remote.get(id);
    const remoteAt = Number(file?.appProperties?.savedAt ?? 0);
    if (!file || entry.savedAt > remoteAt) {
      await upload(token, folder, entry, file?.id ?? null);
      result.up += 1;
    } else if (remoteAt > entry.savedAt) {
      const drawing = await call<Drawing>(token, `${API}/files/${file.id}?alt=media`);
      upsertDrawing(drawing, remoteAt);
      result.down += 1;
      result.downloaded.push(id);
    }
    removed.delete(id);
  }
  for (const [id, file] of remote) {
    if (local.has(id)) continue;
    if (removed.has(id)) {
      await call(token, `${API}/files/${file.id}`, { method: 'DELETE' });
      removed.delete(id);
      result.removed += 1;
      continue;
    }
    const drawing = await call<Drawing>(token, `${API}/files/${file.id}?alt=media`);
    if (drawing && drawing.id === id) {
      upsertDrawing(drawing, Number(file.appProperties?.savedAt ?? Date.now()));
      result.down += 1;
      result.downloaded.push(id);
    }
  }
  write(KEY_REMOVED, [...removed]);
  write(KEY_LAST, { at: Date.now(), up: result.up, down: result.down, removed: result.removed });
  return result;
}
