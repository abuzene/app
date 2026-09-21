import type { Analysis } from '../model/drawing';
import type { CommandState } from '../model/commands';
import type { Drawing } from '../model/types';
import type { Preview, Selection, ViewBox } from '../render/renderer';

export type TabId = 'route' | 'command' | 'items' | 'welds' | 'title';

export interface AppState {
  drawing: Drawing;
  analysis: Analysis;
  selection: Selection;
  preview: Preview | null;
  commandState: CommandState;
  commandText: string;
  commandErrors: { line: number; text: string; message: string }[];
  tab: TabId;
  currentDn: string;
  currentSchedule: string;
  view: ViewBox;
}

/** The surface the tool rail and side panels use to talk back to the app. */
export interface Host {
  state: AppState;
  /**
   * Applies an edit, recording it for undo and recomputing the analysis.
   *
   * Text fields pass `keepPanel` so that committing one field does not rebuild
   * the panel underneath the field the user has just moved to.
   */
  edit(label: string, mutator: (drawing: Drawing) => void, options?: { keepPanel?: boolean }): void;
  /** Changes view-only state without touching the undo history. */
  touch(): void;
  select(selection: Selection): void;
  setTab(tab: TabId): void;
  applyCommands(text: string): void;
  download(filename: string, content: string, mime: string): void;
  /** Puts text on the clipboard, falling back to showing it for manual copying. */
  copy(label: string, content: string): void;
  notify(message: string): void;
  /** Asks for an image file and stores it in the title block. */
  pickLogo(): void;
  /** Leaves the route ready to carry on from this point. */
  continueFrom(nodeId: string): void;
  /** Opens a dimension on the drawing for typing: the run and which piece of it. */
  editDimension(runId: string, index: number): void;
}
