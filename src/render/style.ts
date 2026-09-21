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
  dark?: boolean;
}

export function contentCss({ k, u, dark = false }: ContentStyleOptions): string {
  const w = (value: number) => ((value * u) / k).toFixed(4);
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
.component.selected .sym-line,
.component.selected .sym-hollow,
.component.selected .sym-fill { stroke: ${accent}; }
.component.selected .sym-solid { fill: ${accent}; stroke: ${accent}; }
.joint-bw { fill: ${ink}; stroke: ${ink}; stroke-width: ${w(0.8)}; }
.fitting-body { fill: none; stroke: ${ink}; stroke-width: ${w(1.8)}; }
/* Every label is painted with the page colour behind its own strokes, so on the
   rare occasion one does fall over a line it still reads cleanly. */
.weld-no, .dim-text, .tag, .note, .node-label {
  paint-order: stroke fill;
  stroke: ${dark ? '#0d1117' : '#ffffff'};
  stroke-width: ${w(2.6)};
  stroke-linejoin: round;
}
.weld-no { fill: ${dim}; font-size: ${w(9)}px; font-family: inherit; }
.weld-leader { stroke: ${dim}; stroke-width: ${w(0.7)}; fill: none; }
.branch-note { fill: ${ink}; font-size: ${w(9.5)}px; pointer-events: none;
  paint-order: stroke fill; stroke: ${dark ? '#0d1117' : '#ffffff'}; stroke-width: ${w(2.6)}; stroke-linejoin: round; }
.balloon { pointer-events: none; }
.balloon-leader { stroke: ${ink}; stroke-width: ${w(0.9)}; fill: none; }
.balloon-ring { fill: ${dark ? '#0d1117' : '#ffffff'}; stroke: ${ink}; stroke-width: ${w(1.2)}; }
.balloon-no { fill: ${ink}; font-size: ${w(11)}px; font-weight: 600; }
.dim-line, .dim-ext, .dim-tick { stroke: ${dim}; stroke-width: ${w(0.9)}; fill: none; }
.dim-ext { stroke-dasharray: ${w(3)} ${w(3)}; }
.dim-text { fill: ${ink}; font-size: ${w(11)}px; text-anchor: middle; }
.tag, .note { fill: ${ink}; font-size: ${w(10)}px; }
.node-label { fill: ${accent}; font-size: ${w(11)}px; font-weight: 600; }
.node-mark { fill: none; stroke: ${accent}; stroke-width: ${w(2)}; }
.node.selected .node-label { fill: ${accent}; }
`;
}
