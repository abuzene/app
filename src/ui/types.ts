import type { Analysis } from '../model/drawing';
import type { CommandState } from '../model/commands';
import type { Axis, Drawing, JointType } from '../model/types';
import type { Preview, Selection, ViewBox } from '../render/renderer';
import type { LibraryEntry } from '../model/library';
import type { DriveStatus } from '../model/drive';

export type TabId = 'route' | 'command' | 'items' | 'welds' | 'title' | 'projects';

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
  /** The Projects tab shows the five most recent unless asked for all. */
  showAllProjects?: boolean;
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
  /** Puts the pencil down: nothing is armed to draw from. */
  stopDrawing(): void;
  /** Every drawing kept on this device, newest first. */
  library(): LibraryEntry[];
  /** Brings a kept drawing back on screen. */
  openFromLibrary(id: string): void;
  removeFromLibrary(id: string): void;
  /**
   * Starts the next sheet of the project on screen: same title block, same
   * pipe, the sheet count moved on. Picked on an open end, that end is marked
   * as continuing on the new sheet, and the new sheet starts from it.
   */
  newSheetInProject(): void;
  /** Google Drive: whether the app is signed in, and what the last sync moved. */
  driveStatus(): DriveStatus;
  /** Keeps the OAuth client id and goes to Google's sign-in page. */
  driveConnect(clientId: string): void;
  /** Moves the newer copy of every sheet each way between this device and Drive. */
  driveSync(): void;
  driveSignOut(): void;
  /**
   * Asks how a reducer goes in: its two sizes, which way round, and whether
   * to carry on drawing from its far end. Null when the box is dismissed.
   */
  reducerDialog(ask: ReducerAsk): Promise<ReducerChoice | null>;
  /** Asks which way an olet's branch goes and what size it is. */
  oletDialog(ask: OletAsk): Promise<OletChoice | null>;
  /** Makes this the size the next runs are drawn with. */
  setCurrentSize(dn: string): void;
}

export interface ReducerAsk {
  kind: 'RED_CONC' | 'RED_ECC';
  large: string;
  small: string;
  /** Where it goes: on the end of the line, or along a run. */
  atEnd: boolean;
  /** Whether drawing can carry on from it: an open end, not one wearing a flange. */
  drawOn: boolean;
  /** The end piece it sits against, when the end wears one: "WELD NECK FLANGE". */
  against?: string;
}

export interface OletAsk {
  joint: JointType;
  /** The header's size. */
  header: string;
  /** The header's direction, which the branch cannot share. */
  along: Axis | null;
}

export interface OletChoice {
  dn: string;
  dir: Axis;
}

export interface ReducerChoice {
  large: string;
  small: string;
  /** The large end away from the open end, or towards the run's end. */
  largeOutward: boolean;
  drawOn: boolean;
}
