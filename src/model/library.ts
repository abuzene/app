import type { Drawing } from './types';

/**
 * The library: every drawing this device has worked on, kept in the browser's
 * storage and grouped by project, so a job with more than one isometric can
 * be picked up sheet by sheet. Each drawing carries its own id; saving the
 * one on screen replaces its entry, so the library is always current.
 */
export interface LibraryEntry {
  id: string;
  savedAt: number;
  drawing: Drawing;
}

export interface Project {
  name: string;
  /** Newest first. */
  sheets: LibraryEntry[];
  latest: number;
}

const KEY = 'iso-draw.library.v1';
/**
 * Every sheet removed, for good: never kept again, never taken back from
 * Drive, and handed to the other device through Drive (his complaint,
 * 2026-09-26: "I delete this drawing and it keeps coming back").
 */
const KEY_REMOVED = 'iso-draw.library.removed';
/** Where the removed sheets were noted before, for Drive only. */
const KEY_REMOVED_OLD = 'iso-draw.drive.removed';
const REMOVED_LIMIT = 2000;
/** Enough for a long run of jobs; the oldest go when it is full. */
const LIMIT = 80;

export function loadLibrary(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LibraryEntry[];
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.id && e.drawing) : [];
  } catch {
    return [];
  }
}

function saveLibrary(entries: LibraryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable; the drawing on screen is still saved on its own.
  }
}

/** Whether a drawing is worth keeping: it has a route, or at least a name. */
export function worthKeeping(drawing: Drawing): boolean {
  return drawing.runs.length > 0 || !!drawing.meta.project || !!drawing.meta.lineNumber || !!drawing.meta.drawingNo;
}

/**
 * Puts this drawing in the library, in place of its earlier self. A copy
 * taken from elsewhere keeps the time it was saved there, so the two sides
 * can still be compared.
 */
export function upsertDrawing(drawing: Drawing, savedAt?: number): void {
  if (!drawing.id || isRemoved(drawing.id)) return;
  const all = loadLibrary();
  const json = JSON.stringify(drawing);
  const before = all.find((e) => e.id === drawing.id);
  // Kept again unchanged, it is not newer: the stamp stays, so a copy taken
  // from Drive is not sent straight back as if it had been edited here.
  // An edit is always newer than the copy it was made from, even where that
  // copy came from a device whose clock runs ahead of this one.
  const stamp = savedAt ?? (before && JSON.stringify(before.drawing) === json ? before.savedAt : Math.max(Date.now(), (before?.savedAt ?? 0) + 1));
  const entries = all.filter((e) => e.id !== drawing.id);
  entries.push({ id: drawing.id, savedAt: stamp, drawing: JSON.parse(json) as Drawing });
  entries.sort((a, b) => b.savedAt - a.savedAt);
  saveLibrary(entries.slice(0, LIMIT));
}

/** Takes a sheet out of the library for good: it is not kept again. */
export function removeDrawing(id: string): void {
  markRemoved([id]);
  saveLibrary(loadLibrary().filter((e) => e.id !== id));
}

function readIds(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The ids of every sheet removed, here or on another device. */
export function removedIds(): Set<string> {
  return new Set([...readIds(KEY_REMOVED_OLD), ...readIds(KEY_REMOVED)]);
}

export function isRemoved(id: string): boolean {
  return removedIds().has(id);
}

/** Notes sheets as removed for good (the newest kept when the list is full). */
export function markRemoved(ids: Iterable<string>): void {
  const all = [...readIds(KEY_REMOVED_OLD), ...readIds(KEY_REMOVED)];
  for (const id of ids) if (id && !all.includes(id)) all.push(id);
  try {
    localStorage.setItem(KEY_REMOVED, JSON.stringify(all.slice(-REMOVED_LIMIT)));
    localStorage.removeItem(KEY_REMOVED_OLD);
  } catch {
    // Storage unavailable: nothing to be done.
  }
}

/** Rewrites the sheet count on every sheet of a project: "2 of 3". */
export function renumberProject(name: string, total: number): void {
  const entries = loadLibrary();
  for (const entry of entries) {
    if ((entry.drawing.meta.project || '') !== name) continue;
    entry.drawing.meta.sheet = `${sheetNumber(entry.drawing.meta.sheet)} of ${total}`;
  }
  saveLibrary(entries);
}

/** The k in "k of n"; 1 when the field says something else. */
export function sheetNumber(sheet: string | undefined): number {
  const n = Number((sheet ?? '').match(/\d+/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The library by project, newest project first, sheets in order. */
export function projectsOf(entries: LibraryEntry[]): Project[] {
  const byName = new Map<string, Project>();
  for (const entry of entries) {
    const name = entry.drawing.meta.project || '';
    let project = byName.get(name);
    if (!project) {
      project = { name, sheets: [], latest: 0 };
      byName.set(name, project);
    }
    project.sheets.push(entry);
    project.latest = Math.max(project.latest, entry.savedAt);
  }
  const projects = [...byName.values()];
  for (const project of projects) {
    project.sheets.sort((a, b) => sheetNumber(a.drawing.meta.sheet) - sheetNumber(b.drawing.meta.sheet) || a.savedAt - b.savedAt);
  }
  return projects.sort((a, b) => b.latest - a.latest);
}
