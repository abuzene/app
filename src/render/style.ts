/**
 * Styling for the drawing content.
 *
 * Both the live canvas and the exported sheet draw the same geometry in "paper
 * units", and both scale it by some factor `k` to reach their output units —
 * screen pixels in one case, millimetres on the sheet in the other. Dividing
 * every line weight and font size by `k` keeps the drawing looking identical at
 * any zoom and on any sheet size.
 */
export interface ContentStyleOptions {
  /** Paper units to output units. */
  k: number;
  /** Size of one output unit: 1 for pixels, about 0.3 for a millimetre sheet. */
  u: number;
  /**
   * Symbol half-size in paper units. Text is sized from it, so lettering
   * belongs to the drawing and zooms with it, the way symbols do; only line
   * weights stay fixed on the screen.
   */
  symbol?: number;
  dark?: boolean;
}

export function contentCss({ k, u, symbol = 4, dark = false }: ContentStyleOptions): string {
  const w = (value: number) => ((value * u) / k).toFixed(4);
  /** A font size as a share of the symbol size, in paper units. */
  const t = (share: number) => (symbol * share).toFixed(3);
  const ink = dark ? '#e8edf4' : '#12161c';
  const faint = dark ? '#2b3440' : '#d8dee8';
  const accent = dark ? '#6fb2ff' : '#0b62d6';
  const dim = dark ? '#8fa3bd' : '#4a5568';

  return `
/* Marks and fitting bodies are drawn over the pipe, so they must not take the
   clicks meant for the point or the run underneath them. */
.grid, .dim, .weld, .olet, .fitting-body, .preview, .preview-text,
.node-label, .tag, .note { pointer-events: none; }
.grid line { stroke: ${faint}; stroke-width: ${w(0.6)}; }
.pipe { stroke: ${ink}; stroke-width: ${w(2.4)}; stroke-linecap: round; fill: none; }
.pipe.selected { stroke: ${accent}; stroke-width: ${w(4)}; }
.pipe.dashed { stroke-dasharray: ${w(9)} ${w(5)}; }
.preview { stroke: ${accent}; stroke-width: ${w(2)}; stroke-dasharray: ${w(8)} ${w(5)}; fill: none; }
.preview-text { fill: ${accent}; font-size: ${w(12)}px; text-anchor: middle; font-weight: 600; }
.hit { stroke: transparent; stroke-width: ${w(16)}; fill: none; cursor: pointer; }
.hit-dot { fill: transparent; cursor: pointer; }
.sym-line { stroke: ${ink}; stroke-width: ${w(1.6)}; fill: none; stroke-linecap: round; }
.sym-heavy { stroke: ${ink}; stroke-width: ${w(3.2)}; fill: none; }
.sym-face { stroke: ${ink}; stroke-width: ${w(2.2)}; fill: none; stroke-linecap: round; }
.sym-fill { fill: ${dark ? '#0d1117' : '#ffffff'}; stroke: ${ink}; stroke-width: ${w(1.6)}; }
.sym-hollow { fill: none; stroke: ${ink}; stroke-width: ${w(1.6)}; }
.sym-solid { fill: ${ink}; stroke: ${ink}; stroke-width: ${w(1)}; }
.sym-thin { stroke: ${ink}; stroke-width: ${w(0.8)}; fill: none; }
.sym-text { fill: ${ink}; font-weight: 600; pointer-events: none; }
.sym-dashed { fill: none; stroke: ${ink}; stroke-width: ${w(1.2)}; stroke-dasharray: ${w(3)} ${w(2.2)}; }
.equip-box { fill: none; stroke: ${ink}; stroke-width: ${w(1.4)}; stroke-dasharray: ${w(4)} ${w(2.5)}; pointer-events: none; }
.equip-text { fill: ${ink}; font-size: ${t(1.0)}px; font-weight: 700; pointer-events: none; }
.equipment.selected .equip-box { stroke: ${accent}; }
.hit-box { fill: transparent; stroke: transparent; stroke-width: ${w(10)}; cursor: pointer; }
.component.selected .sym-line,
.component.selected .sym-dashed,
.component.selected .sym-hollow,
.component.selected .sym-fill { stroke: ${accent}; }
.component.selected .sym-solid { fill: ${accent}; stroke: ${accent}; }
.joint-bw { fill: ${ink}; stroke: ${ink}; stroke-width: ${w(0.8)}; }
.fitting-body { fill: none; stroke: ${ink}; stroke-width: ${w(1.8)}; }
/* Every label is painted with the page colour behind its own strokes, so on the
   rare occasion one does fall over a line it still reads cleanly. */
.dim-text, .tag, .note, .node-label {
  paint-order: stroke fill;
  stroke: ${dark ? '#0d1117' : '#ffffff'};
  stroke-width: ${w(2.6)};
  stroke-linejoin: round;
}
.weld-no { fill: ${ink}; font-size: ${t(1.0)}px; font-family: inherit; font-weight: 600; }
.weld-box { fill: ${dark ? '#0d1117' : '#ffffff'}; stroke: ${dim}; stroke-width: ${w(0.7)}; }
.weld.selected .weld-box { stroke: ${accent}; stroke-width: ${w(1.4)}; }
.weld.selected .weld-no { fill: ${accent}; font-weight: 700; }
.weld.selected .joint-bw { fill: ${accent}; stroke: ${accent}; }
.weld.no-weld .joint-bw { fill: ${dark ? '#0d1117' : '#ffffff'}; }
.weld.no-weld.selected .joint-bw { fill: ${dark ? '#0d1117' : '#ffffff'}; stroke: ${accent}; }
.weld-leader { stroke: ${dim}; stroke-width: ${w(0.7)}; fill: none; }
.branch-note { fill: ${ink}; font-size: ${t(0.75)}px; pointer-events: none;
  paint-order: stroke fill; stroke: ${dark ? '#0d1117' : '#ffffff'}; stroke-width: ${w(2.6)}; stroke-linejoin: round; }
.balloon { pointer-events: none; }
/* Balloons and weld tags are the same family of annotation: one thin line
   weight for both leaders and the ring, lighter than the pipe. */
.balloon-leader { stroke: ${dim}; stroke-width: ${w(0.7)}; fill: none; }
.balloon-ring { fill: ${dark ? '#0d1117' : '#ffffff'}; stroke: ${dim}; stroke-width: ${w(0.7)}; }
.balloon-no { fill: ${ink}; font-size: ${t(0.72)}px; font-weight: 600; }
.pipe-letter { pointer-events: none; }
.pipe-letter-box { fill: ${dark ? '#0d1117' : '#ffffff'}; stroke: ${ink}; stroke-width: ${w(0.8)}; }
.pipe-letter-text { fill: ${ink}; font-size: ${t(1.0)}px; font-weight: 700; }
.dim-line, .dim-ext, .dim-tick { stroke: ${dim}; stroke-width: ${w(0.9)}; fill: none; }
.dim-ext { stroke-dasharray: ${w(3)} ${w(3)}; }
.dim-text { fill: ${ink}; font-size: ${t(1.15)}px; text-anchor: middle; }
.tag, .note { fill: ${ink}; font-size: ${t(0.78)}px; }
.node-label { fill: ${accent}; font-size: ${t(0.85)}px; font-weight: 600; }
.node-mark { fill: none; stroke: ${accent}; stroke-width: ${w(2)}; }
.run-handle { fill: ${dark ? '#0d1117' : '#ffffff'}; stroke: ${accent}; stroke-width: ${w(2)}; pointer-events: none; }
.node.selected .node-label { fill: ${accent}; }
`;
}
