import { sizeLabel } from '../model/pipe-data';

/**
 * A little picture of a reducer in the line: its two sizes over its ends and
 * what lies each side under them, for choosing which way round it goes with
 * one Flip rather than reading a sentence.
 */
export function reducerPreview(
  kind: 'RED_CONC' | 'RED_ECC',
  large: string,
  small: string,
  largeLeft: boolean,
  leftSide: string,
  rightSide: string,
): string {
  const W = 240;
  const H = 72;
  const cy = 36;
  const x1 = 88;
  const x2 = 152;
  const big = 15;
  const sm = 7;
  const hl = largeLeft ? big : sm;
  const hr = largeLeft ? sm : big;
  // Eccentric: flat on the bottom, so the two lines sit at different heights.
  const ecc = kind === 'RED_ECC';
  const yl = ecc ? cy + big - hl : cy;
  const yr = ecc ? cy + big - hr : cy;
  const body = ecc
    ? `${x1},${cy + big} ${x1},${cy + big - 2 * hl} ${x2},${cy + big - 2 * hr} ${x2},${cy + big}`
    : `${x1},${cy - hl} ${x1},${cy + hl} ${x2},${cy + hr} ${x2},${cy - hr}`;
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<svg class="red-preview" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
  <line x1="12" y1="${yl}" x2="${x1}" y2="${yl}" stroke="currentColor" stroke-width="2.4"/>
  <line x1="${x2}" y1="${yr}" x2="${W - 12}" y2="${yr}" stroke="currentColor" stroke-width="2.4"/>
  <polygon points="${body}" fill="currentColor"/>
  <circle cx="${x1}" cy="${yl}" r="3.2" fill="currentColor"/>
  <circle cx="${x2}" cy="${yr}" r="3.2" fill="currentColor"/>
  <text x="${x1 - 6}" y="11" text-anchor="end" font-size="12" font-weight="700" fill="currentColor">${esc(sizeLabel(largeLeft ? large : small))}</text>
  <text x="${x2 + 6}" y="11" text-anchor="start" font-size="12" font-weight="700" fill="currentColor">${esc(sizeLabel(largeLeft ? small : large))}</text>
  <text x="46" y="${H - 4}" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">${esc(leftSide)}</text>
  <text x="${W - 46}" y="${H - 4}" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">${esc(rightSide)}</text>
</svg>`;
}
