/**
 * The 3D view: the line as a solid model, turned with the pen or a finger,
 * zoomed with a pinch, moved with two fingers; set views (the sheet's
 * isometric, from above, from the south, from the east); the weld numbers
 * on it; and the picture put on the sheet as it is seen (his ask,
 * 2026-09-27).
 */
import type { Host } from './types';
import { buildModel, fitCamera, isoAngles, Scene3D, toScreen, type Camera, type Model3D } from '../render/view3d';

const VIEWS: Record<string, (rotation: number) => { az: number; el: number }> = {
  iso: (r) => isoAngles(r),
  plan: (r) => ({ az: -90 + 90 * r, el: 89.5 }),
  south: (r) => ({ az: -90 + 90 * r, el: 0 }),
  east: (r) => ({ az: 0 + 90 * r, el: 0 }),
};

export function open3dView(host: Host): void {
  const drawing = host.state.drawing;
  const rotation = drawing.options.northRotation ?? 0;
  const onSheet = () => host.state.drawing.view3d;
  const backdrop = document.createElement('div');
  backdrop.className = 'v3d-backdrop';
  backdrop.innerHTML = `<div class="v3d" role="dialog" aria-label="3D view">
  <div class="v3d-bar">
    <strong class="v3d-title">3D view</strong>
    <div class="v3d-views">
      <button class="btn" data-view="iso" title="As the sheet: the isometric">Iso</button>
      <button class="btn" data-view="plan" title="From above">Plan</button>
      <button class="btn" data-view="south" title="From the south, looking north">From S</button>
      <button class="btn" data-view="east" title="From the east, looking west">From E</button>
      <button class="btn" data-view="fit" title="Fit the whole line in">Fit</button>
    </div>
    <label class="check"><input type="checkbox" data-f="v3d-welds" checked /><span>Weld nos</span></label>
    <span class="v3d-grow"></span>
    <label class="v3d-size" title="How big the picture is on the sheet">On sheet
      <select data-f="v3d-size"><option value="S">Small</option><option value="M">Medium</option><option value="L">Large</option></select>
    </label>
    <button class="btn primary" data-a="v3d-sheet"></button>
    <button class="btn" data-a="v3d-off">Take off sheet</button>
    <button class="btn" data-a="v3d-close">Close</button>
  </div>
  <div class="v3d-stage">
    <canvas class="v3d-canvas"></canvas>
    <div class="v3d-labels"></div>
    <div class="v3d-hint">Drag to turn · pinch or wheel to zoom · two fingers (or right button) to move</div>
  </div>
</div>`;
  document.body.appendChild(backdrop);

  const stage = backdrop.querySelector<HTMLElement>('.v3d-stage')!;
  const canvas = backdrop.querySelector<HTMLCanvasElement>('.v3d-canvas')!;
  const labelsEl = backdrop.querySelector<HTMLElement>('.v3d-labels')!;
  const weldsBox = backdrop.querySelector<HTMLInputElement>('[data-f="v3d-welds"]')!;
  const sizeSel = backdrop.querySelector<HTMLSelectElement>('[data-f="v3d-size"]')!;
  const sheetBtn = backdrop.querySelector<HTMLButtonElement>('[data-a="v3d-sheet"]')!;
  const offBtn = backdrop.querySelector<HTMLButtonElement>('[data-a="v3d-off"]')!;

  const scene = Scene3D.create(canvas);
  if (!scene) {
    stage.innerHTML = '<p class="v3d-none">This browser cannot draw in 3D (WebGL is off).</p>';
  }
  const model: Model3D = buildModel(drawing, host.state.analysis);
  scene?.setModel(model);

  const saved = onSheet();
  weldsBox.checked = saved?.welds ?? true;
  sizeSel.value = saved?.size ?? 'M';
  let cam: Camera = { ...(saved ? { az: saved.az, el: saved.el } : isoAngles(rotation)), zoom: 1, panX: 0, panY: 0 };
  let cssW = 1;
  let cssH = 1;

  const syncButtons = () => {
    sheetBtn.textContent = onSheet() ? 'Update on sheet' : 'Put on sheet';
    offBtn.style.display = onSheet() ? '' : 'none';
  };
  syncButtons();

  let queued = false;
  const draw = () => {
    queued = false;
    if (!scene) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    scene.draw({ ...cam, zoom: cam.zoom * dpr, panX: cam.panX * dpr, panY: cam.panY * dpr }, w, h);
    // The weld numbers, each in its box on a leader, over the model.
    let html = '';
    if (weldsBox.checked) {
      for (const label of model.labels) {
        const s = toScreen(model, cam, label.pos, cssW, cssH);
        if (s.x < -40 || s.y < -40 || s.x > cssW + 40 || s.y > cssH + 40) continue;
        const text = label.text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        html +=
          label.kind === 'weld'
            ? `<div class="v3d-tag" data-key="${(label.key ?? '').replace(/"/g, '')}" style="left:${s.x.toFixed(1)}px;top:${s.y.toFixed(1)}px"><span>${text}</span></div>`
            : `<div class="v3d-name" style="left:${s.x.toFixed(1)}px;top:${s.y.toFixed(1)}px">${text}</div>`;
      }
    }
    labelsEl.innerHTML = html;
  };
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };
  const measure = () => {
    const box = stage.getBoundingClientRect();
    cssW = Math.max(1, box.width);
    cssH = Math.max(1, box.height);
  };
  const fit = () => {
    measure();
    cam = fitCamera(model, cam, cssW, cssH, 0.08);
    redraw();
  };
  const setView = (name: string) => {
    const angles = VIEWS[name]?.(rotation);
    if (angles) cam = { ...cam, ...angles };
    fit();
  };
  fit();
  const onResize = () => {
    measure();
    redraw();
  };
  window.addEventListener('resize', onResize);

  // Turning, zooming and moving: one pointer turns (the right button moves),
  // two pinch and move.
  const pointers = new Map<number, { x: number; y: number; pan: boolean }>();
  let pinch: { dist: number; mx: number; my: number } | null = null;
  const local = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const zoomAt = (ratio: number, mx: number, my: number) => {
    const zoom = Math.max(1e-4, Math.min(50, cam.zoom * ratio));
    const k = zoom / cam.zoom;
    cam = {
      ...cam,
      zoom,
      panX: mx - cssW / 2 - (mx - cssW / 2 - cam.panX) * k,
      panY: cssH / 2 - my - (cssH / 2 - my - cam.panY) * k,
    };
  };
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    const p = local(event);
    pointers.set(event.pointerId, { ...p, pan: event.button === 2 || event.button === 1 || event.shiftKey });
    pinch = pointers.size === 2 ? pinchState() : null;
  });
  canvas.addEventListener('pointermove', (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const p = local(event);
    if (pointers.size >= 2) {
      pointers.set(event.pointerId, { ...p, pan: prev.pan });
      const now = pinchState();
      if (pinch) {
        cam = { ...cam, panX: cam.panX + (now.mx - pinch.mx), panY: cam.panY - (now.my - pinch.my) };
        zoomAt(now.dist / pinch.dist, now.mx, now.my);
      }
      pinch = now;
    } else if (prev.pan) {
      cam = { ...cam, panX: cam.panX + (p.x - prev.x), panY: cam.panY - (p.y - prev.y) };
      pointers.set(event.pointerId, { ...p, pan: true });
    } else {
      cam = { ...cam, az: cam.az - (p.x - prev.x) * 0.45, el: Math.max(-89.5, Math.min(89.5, cam.el + (p.y - prev.y) * 0.45)) };
      pointers.set(event.pointerId, { ...p, pan: false });
    }
    redraw();
  });
  const lift = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinch = pointers.size === 2 ? pinchState() : null;
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('lostpointercapture', lift);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const p = { x: event.offsetX, y: event.offsetY };
      zoomAt(Math.exp(-event.deltaY * 0.0015), p.x, p.y);
      redraw();
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', () => fit());

  const close = () => {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  backdrop.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) =>
    button.addEventListener('click', () => (button.dataset.view === 'fit' ? fit() : setView(button.dataset.view!))),
  );
  weldsBox.addEventListener('change', () => {
    redraw();
    if (onSheet()) putOnSheet(false);
  });
  sizeSel.addEventListener('change', () => {
    if (onSheet()) putOnSheet(false);
  });
  const putOnSheet = (say: boolean) => {
    const az = Math.round(cam.az * 10) / 10;
    const el = Math.round(cam.el * 10) / 10;
    const welds = weldsBox.checked;
    const size = sizeSel.value as 'S' | 'M' | 'L';
    const had = !!onSheet();
    host.edit(had ? 'Update the 3D picture' : '3D picture on the sheet', (d) => {
      d.view3d = { az, el, welds, size };
    });
    syncButtons();
    if (say) host.notify(had ? 'The 3D picture on the sheet is seen from here now.' : 'The 3D picture is on the sheet, seen from here (Print → Preview shows it).');
  };
  sheetBtn.addEventListener('click', () => putOnSheet(true));
  offBtn.addEventListener('click', () => {
    host.edit('3D picture off the sheet', (d) => {
      delete d.view3d;
    });
    syncButtons();
    host.notify('The 3D picture is off the sheet.');
  });
  backdrop.querySelector('[data-a="v3d-close"]')!.addEventListener('click', close);
}
