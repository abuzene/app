import type { Drawing } from './types';
import { loadLibrary, removedIds, upsertDrawing } from './library';
import { fileName } from './drive';

/**
 * Keeping the library in a folder on this computer as well (his ask,
 * 2026-09-26: "connect a local folder too, besides Google Drive"): one
 * `.iso.json` file per sheet, named as in Drive, which Open reads too. The
 * browser lets the app into a folder it is shown once; the folder is
 * remembered, and after a restart the browser may ask to allow it again.
 * Edge and Chrome can; Safari (so the iPad) cannot.
 *
 * A sync compares each sheet with its file: what changed since the last
 * sync goes the other way; changed on both sides, the newer wins. A sheet
 * removed here has its file taken out of the folder too.
 */

interface FileLike {
  name: string;
  lastModified: number;
  text(): Promise<string>;
}
interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<FileLike>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface DirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FileHandle | DirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

export interface FolderStatus {
  /** This browser can open a folder at all. */
  supported: boolean;
  /** The folder's name, once one has been chosen. */
  name: string;
  /** Chosen and allowed: the app may read and write it now. */
  connected: boolean;
  last: { at: number; up: number; down: number; removed: number } | null;
}

export interface FolderSyncResult {
  up: number;
  down: number;
  removed: number;
  /** The ids of sheets taken from the folder. */
  downloaded: string[];
}

const KEY_NAME = 'iso-draw.folder.name';
const KEY_SYNCED = 'iso-draw.folder.synced';
const KEY_LAST = 'iso-draw.folder.last';
const DB = 'iso-draw';
const STORE = 'handles';

let dir: DirHandle | null = null;
let allowed = false;

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
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: nothing to be done.
  }
}

export function folderSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export function folderStatus(): FolderStatus {
  return { supported: folderSupported(), name: read<string>(KEY_NAME) ?? '', connected: !!dir && allowed, last: read(KEY_LAST) };
}

/** The folder's handle is kept in IndexedDB, the one place a browser keeps one. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function keepHandle(handle: DirHandle | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (handle) tx.objectStore(STORE).put(handle, 'folder');
      else tx.objectStore(STORE).delete('folder');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Not kept: the folder is chosen again next time.
  }
}

async function keptHandle(): Promise<DirHandle | null> {
  try {
    const db = await openDb();
    return await new Promise<DirHandle | null>((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get('folder');
      req.onsuccess = () => resolve((req.result as DirHandle | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Asks for a folder (the browser's own picker) and connects it. */
export async function chooseFolder(): Promise<string> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  const handle = await picker({ mode: 'readwrite', id: 'iso-piping' });
  dir = handle;
  allowed = true;
  write(KEY_NAME, handle.name);
  // A different folder: nothing in it has been synced yet.
  write(KEY_SYNCED, null);
  await keepHandle(handle);
  return handle.name;
}

/** On start: the folder kept from before, and whether it is still allowed. */
export async function restoreFolder(): Promise<'granted' | 'prompt' | 'none'> {
  if (!folderSupported()) return 'none';
  if (!dir) dir = await keptHandle();
  if (!dir) return 'none';
  const state = (await dir.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
  allowed = state === 'granted';
  return allowed ? 'granted' : 'prompt';
}

/** Asks the browser to allow the kept folder again (needs a tap). */
export async function allowFolder(): Promise<boolean> {
  if (!dir) dir = await keptHandle();
  if (!dir) return false;
  const state = (await dir.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
  allowed = state === 'granted';
  return allowed;
}

export async function forgetFolder(): Promise<void> {
  dir = null;
  allowed = false;
  write(KEY_NAME, null);
  write(KEY_SYNCED, null);
  write(KEY_LAST, null);
  await keepHandle(null);
}

async function putFile(name: string, content: string): Promise<number> {
  const handle = await dir!.getFileHandle(name, { create: true });
  const out = await handle.createWritable();
  await out.write(content);
  await out.close();
  return (await handle.getFile()).lastModified;
}

/** Brings this device's sheets and the folder's files to the same set. */
export async function syncFolder(): Promise<FolderSyncResult> {
  if (!dir || !allowed) throw new Error('No folder connected.');
  const synced = read<Record<string, { savedAt: number; fileTime: number }>>(KEY_SYNCED) ?? {};
  const result: FolderSyncResult = { up: 0, down: 0, removed: 0, downloaded: [] };

  // Every sheet file in the folder, the newest copy of each sheet.
  const files = new Map<string, { name: string; time: number; drawing: Drawing; text: string }>();
  for await (const handle of dir.values()) {
    if (handle.kind !== 'file' || !handle.name.endsWith('.iso.json')) continue;
    const file = await handle.getFile();
    const text = await file.text();
    let drawing: Drawing;
    try {
      drawing = JSON.parse(text) as Drawing;
    } catch {
      continue;
    }
    if (!drawing?.id || !Array.isArray(drawing.nodes) || !Array.isArray(drawing.runs)) continue;
    const before = files.get(drawing.id);
    if (!before || file.lastModified > before.time) files.set(drawing.id, { name: handle.name, time: file.lastModified, drawing, text });
  }

  // Removed here is removed from the folder as well.
  const removed = removedIds();
  for (const [id, file] of files) {
    if (!removed.has(id)) continue;
    await dir.removeEntry(file.name);
    files.delete(id);
    delete synced[id];
    result.removed += 1;
  }

  const local = new Map(loadLibrary().map((e) => [e.id, e]));
  for (const [id, entry] of local) {
    const file = files.get(id);
    const name = fileName(entry.drawing);
    const json = JSON.stringify(entry.drawing);
    if (!file) {
      synced[id] = { savedAt: entry.savedAt, fileTime: await putFile(name, json) };
      result.up += 1;
      continue;
    }
    const seen = synced[id];
    const same = file.text === json;
    const libChanged = !seen || entry.savedAt !== seen.savedAt;
    const fileChanged = !seen || file.time > seen.fileTime;
    if (same) {
      // The file only needs its name brought up to date.
      if (file.name !== name) {
        synced[id] = { savedAt: entry.savedAt, fileTime: await putFile(name, json) };
        await dir.removeEntry(file.name);
      } else {
        synced[id] = { savedAt: entry.savedAt, fileTime: file.time };
      }
    } else if (fileChanged && (!libChanged || file.time > entry.savedAt)) {
      upsertDrawing(file.drawing, file.time);
      const now = loadLibrary().find((e) => e.id === id);
      synced[id] = { savedAt: now?.savedAt ?? file.time, fileTime: file.time };
      result.down += 1;
      result.downloaded.push(id);
    } else if (libChanged || file.name !== name) {
      synced[id] = { savedAt: entry.savedAt, fileTime: await putFile(name, json) };
      if (file.name !== name) await dir.removeEntry(file.name);
      result.up += 1;
    }
  }
  // A sheet only the folder has comes in (a file put there, or from before).
  for (const [id, file] of files) {
    if (local.has(id)) continue;
    upsertDrawing(file.drawing, file.time);
    const now = loadLibrary().find((e) => e.id === id);
    if (!now) continue;
    synced[id] = { savedAt: now.savedAt, fileTime: file.time };
    result.down += 1;
    result.downloaded.push(id);
  }
  write(KEY_SYNCED, synced);
  write(KEY_LAST, { at: Date.now(), up: result.up, down: result.down, removed: result.removed });
  return result;
}
