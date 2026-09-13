// src/measure/drawingTools.js
/**
 * Draw a shape on the map, measure it, and count what is inside.
 *
 * The maths lives in measureGeometry.js and the state machine in
 * drawingSession.js, both free of Cesium and the DOM. What is left here is the
 * wiring: turning clicks into coordinates, coordinates into geometry, and
 * geometry into a readout.
 *
 * CLICK OWNERSHIP. While a tool is armed this registers itself in the shared
 * pick registry with a predicate that claims EVERYTHING. Five layers already
 * consult that registry and leave picks alone that belong to someone else, so
 * clicking an aircraft to place a polygon corner no longer starts tracking it
 * and flies the camera away mid-draw — and not one of those layers had to
 * change. A click on bare terrain still reaches them, and a layer that is
 * tracking something will drop it; that is the same thing a map click has
 * always meant, so it is left alone.
 *
 * WHAT IS INSIDE comes from the layers' own `getAnalystRecords()` — the seam
 * the voice agent already uses for "how many flights over Texas". It reports
 * only ENABLED layers, and says so, because a count that silently omitted the
 * layers you had switched off would be a wrong answer rather than a partial one.
 *
 * @module measure/drawingTools
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { registerPickOwner, unregisterPickOwner } from '../data/pickRegistry.js';
import {
  DRAWING_MODES,
  addPoint,
  chooseShape,
  createSession,
  finish,
  modeFor,
  promptFor,
  toShape,
  undo,
} from './drawingSession.js';
import {
  SHAPE_COLORS,
  actionBarModel,
  cancel,
  circleRing,
  isTypingTarget,
  keyAction,
  previewOutline,
  previewShape,
  relativeTime,
  shapeName,
  shapesToGeoJSON,
  stepLabel,
} from './drawingInteraction.js';
import {
  formatArea,
  formatDistance,
  measureShape,
  shapeContains,
} from './measureGeometry.js';

/** Registry id used to claim clicks while a tool is armed. */
const PICK_OWNER_ID = 'drawing-tools';
/** Cap on records pulled from any one layer for an inside-count. */
const RECORDS_PER_LAYER = 2000;

/** Cesium colours for each kind, from the one palette the list and the map share. */
const KIND_COLOR = Object.fromEntries(
  Object.entries(SHAPE_COLORS).map(([kind, css]) => [kind, Cesium.Color.fromCssColorString(css)]),
);

/** Small line icons for the shape buttons, drawn inline so nothing is fetched. */
const SHAPE_ICONS = {
  area: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 14.5 6 12 14H4L1.5 6Z"/></svg>',
  box: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/></svg>',
  radius: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>',
  path: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5c3-1 2-5 5.5-6.5S12 5 13.5 2.5"/></svg>',
};

/**
 * The world point under a screen position, or null.
 *
 * Same cascade the rest of the app uses: the depth buffer first (so a click on
 * a building lands on the building), then the ellipsoid. A miss returns null
 * and the session drops the click rather than inventing a coordinate.
 */
function pickGround(viewer, windowPosition) {
  const scene = viewer.scene;
  let cartesian = null;
  if (scene.pickPositionSupported) {
    try { cartesian = scene.pickPosition(windowPosition); } catch { cartesian = null; }
  }
  if (!cartesian || !Number.isFinite(cartesian.x)) {
    try {
      cartesian = viewer.camera.pickEllipsoid(windowPosition, Cesium.Ellipsoid.WGS84);
    } catch { cartesian = null; }
  }
  if (!cartesian || !Number.isFinite(cartesian.x)) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
    // Kept for the live preview, which is drawn at the surface rather than
    // clamped to it - see the preview entities in initDrawingTools.
    height: Number.isFinite(carto.height) ? carto.height : 0,
  };
}

/**
 * Count the records of every ENABLED layer that fall inside ANY of these shapes.
 *
 * Takes a LIST rather than one shape for two reasons. Several AOIs can be on
 * the map at once and the readout is about all of them; and the shape being
 * drawn has to be included, or the count would vanish at the moment the shape
 * was finished and the live session cleared — which is exactly what happened
 * before this took a list.
 *
 * A record inside two overlapping AOIs is counted ONCE. Two circles over the
 * same city must not report twice the aircraft that are there.
 *
 * @param {object} dataManager
 * @param {object|Array<object>} shapes One shape, or several.
 * @returns {{total: number, byLayer: Array<{id: string, name: string, count: number}>,
 *   layersConsidered: number}}
 */
export function countInside(dataManager, shapes) {
  const list = (Array.isArray(shapes) ? shapes : [shapes]).filter(Boolean);
  const byLayer = [];
  let total = 0;
  let layersConsidered = 0;
  if (!list.length || !dataManager?.layers) return { total, byLayer, layersConsidered };

  for (const [id, entry] of dataManager.layers) {
    if (!dataManager.isEnabled?.(id)) continue;
    const module = entry?.module;
    if (typeof module?.getAnalystRecords !== 'function') continue;
    layersConsidered += 1;
    let records = [];
    try {
      records = module.getAnalystRecords(RECORDS_PER_LAYER) || [];
    } catch {
      // One layer throwing must not blank the whole count.
      continue;
    }
    let count = 0;
    const seen = new Set();
    for (const record of records) {
      // Identity within this layer, so overlapping AOIs cannot double-count.
      // An id-less record falls back to its own object identity, which is
      // still stable across the shapes of a single pass.
      const key = record?.id ?? record;
      if (seen.has(key)) continue;
      if (list.some((shape) => shapeContains(shape, record))) {
        seen.add(key);
        count += 1;
      }
    }
    if (count > 0) {
      byLayer.push({ id, name: module.name || id, count });
      total += count;
    }
  }
  byLayer.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, byLayer, layersConsidered };
}

/**
 * Everything the panel needs, derived from a session and the committed shapes.
 * Pure, so the readout can be tested without a scene.
 */
export function readoutFor(session, committed, inside) {
  const shape = toShape(session);
  const live = shape ? measureShape(shape) : null;
  const committedPerimeter = committed.reduce((sum, entry) => sum + entry.measured.perimeterKm, 0);
  const committedArea = committed.reduce((sum, entry) => sum + entry.measured.areaKm2, 0);
  // The live shape counts toward the readout while it is being drawn, so the
  // numbers move as you click rather than appearing only at the end.
  const areaKm2 = committedArea + (live?.measurable ? live.areaKm2 : 0);
  const perimeterKm = committedPerimeter + (live?.measurable ? live.perimeterKm : 0);
  return {
    area: formatArea(areaKm2),
    aois: committed.length,
    perimeter: formatDistance(perimeterKm),
    prompt: live && !live.measurable && live.reason && session.points.length >= 2
      ? `Cannot measure: ${live.reason}.`
      : promptFor(session),
    inside,
  };
}

/**
 * Mount the drawing tools.
 *
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {object} options.dataManager
 * @param {HTMLElement} [options.container] Where to mount; defaults to #drawing-tools.
 * @returns {object} Controller with `destroy()`.
 */
export function initDrawingTools({ viewer, dataManager, container = null }) {
  const root = container || document.getElementById('drawing-tools');
  if (!root || !viewer) return { destroy() {} };

  let session = createSession();
  /**
   * Finished shapes, newest last. Each carries the name it is listed under and
   * when it was made, so the list and the export say the same thing.
   */
  let committed = [];
  /** Names count across kinds - "Radius 1", then "Box 2" - and restart on CLEAR. */
  let ordinal = 0;
  let inside = { total: 0, byLayer: [], layersConsidered: 0 };
  /** Where the cursor is on the ground, while a shape is being drawn. */
  let cursor = null;
  /** The surface height under the first click; the live preview is drawn there. */
  let anchorHeight = 0;

  const committedSource = new Cesium.CustomDataSource('drawing-tools');
  const previewSource = new Cesium.CustomDataSource('drawing-tools-preview');
  viewer.dataSources.add(committedSource);
  viewer.dataSources.add(previewSource);

  root.innerHTML = `
    <div class="draw-readouts">
      <div class="draw-readout"><span class="draw-readout-label">TRACKED AREA</span><span class="draw-readout-value" data-draw-area>0 km²</span></div>
      <div class="draw-readout"><span class="draw-readout-label">AOIS / PERIM</span><span class="draw-readout-value" data-draw-perim>0 / 0 km</span></div>
    </div>
    <div class="draw-step" data-draw-step>STEP 1 — CHOOSE A SHAPE</div>
    <div class="draw-shapes">
      ${DRAWING_MODES.map((mode) => `
        <button type="button" class="draw-shape" data-draw-mode="${mode.id}" aria-pressed="false">
          <span class="draw-shape-icon">${SHAPE_ICONS[mode.id] || ''}</span>
          <span class="draw-shape-text">
            <span class="draw-shape-label">${mode.label}</span>
            <span class="draw-shape-hint">${mode.hint}</span>
          </span>
        </button>`).join('')}
    </div>
    <div class="draw-live" data-draw-live hidden>
      <div class="draw-live-head">
        <span class="draw-live-dot" aria-hidden="true"></span>
        <span data-draw-live-points>0 points</span>
        <span class="draw-live-measure" data-draw-live-measure></span>
      </div>
      <div class="draw-live-keys" data-draw-live-keys></div>
    </div>
    <div class="draw-prompt" data-draw-prompt></div>
    <div class="draw-inside" data-draw-inside hidden></div>
    <ul class="draw-list" data-draw-list></ul>
    <div class="draw-actions">
      <button type="button" class="draw-action draw-action-export" data-draw-action="export" disabled>EXPORT GEOJSON</button>
      <button type="button" class="draw-action draw-action-clear" data-draw-action="clear">CLEAR</button>
    </div>
  `;

  const ui = {
    area: root.querySelector('[data-draw-area]'),
    perim: root.querySelector('[data-draw-perim]'),
    step: root.querySelector('[data-draw-step]'),
    live: root.querySelector('[data-draw-live]'),
    livePoints: root.querySelector('[data-draw-live-points]'),
    liveMeasure: root.querySelector('[data-draw-live-measure]'),
    liveKeys: root.querySelector('[data-draw-live-keys]'),
    prompt: root.querySelector('[data-draw-prompt]'),
    inside: root.querySelector('[data-draw-inside]'),
    list: root.querySelector('[data-draw-list]'),
    exportBtn: root.querySelector('[data-draw-action="export"]'),
  };

  /*
   * The action bar floats over the map, where the eyes already are while
   * drawing. It lives on <body> rather than in the panel so a collapsed panel
   * does not take the instructions with it.
   */
  const bar = document.createElement('div');
  bar.className = 'draw-actionbar';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="draw-actionbar-row">
      <span class="draw-actionbar-dot" aria-hidden="true"></span>
      <span class="draw-actionbar-mode" data-bar-mode></span>
      <span class="draw-actionbar-prompt" data-bar-prompt></span>
      <span class="draw-actionbar-measure" data-bar-measure></span>
    </div>
    <div class="draw-actionbar-row">
      <button type="button" data-bar-action="undo">&#8630; Undo point</button>
      <button type="button" class="draw-actionbar-finish" data-bar-action="finish">&#10003; <span data-bar-finish-label>Finish</span></button>
      <button type="button" data-bar-action="cancel">&#10005; Cancel</button>
      <span class="draw-actionbar-points" data-bar-points></span>
    </div>
  `;
  document.body.appendChild(bar);
  const barUi = {
    mode: bar.querySelector('[data-bar-mode]'),
    prompt: bar.querySelector('[data-bar-prompt]'),
    measure: bar.querySelector('[data-bar-measure]'),
    undo: bar.querySelector('[data-bar-action="undo"]'),
    finish: bar.querySelector('[data-bar-action="finish"]'),
    finishLabel: bar.querySelector('[data-bar-finish-label]'),
    points: bar.querySelector('[data-bar-points]'),
  };

  // ── Map: finished shapes ─────────────────────────────────────────────────
  /*
   * Rebuilt only when the list changes - on a finish or a clear - never while
   * the cursor moves. Clamped to the ground, dashed outlines, the kind's colour.
   */
  function renderCommitted() {
    committedSource.entities.suspendEvents();
    committedSource.entities.removeAll();
    committed.forEach((entry, index) => {
      const { shape } = entry;
      const color = KIND_COLOR[shape.kind] || KIND_COLOR.circle;
      const ring = shape.kind === 'circle'
        ? circleRing(shape.center, shape.radiusKm)
        : shape.kind === 'path'
          ? shape.points
          : [...shape.points, shape.points[0]];
      const positions = ring.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
      if (shape.kind !== 'path') {
        committedSource.entities.add({
          id: `draw:aoi-${index}:fill`,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions.slice(0, -1)),
            material: color.withAlpha(0.2),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
      }
      committedSource.entities.add({
        id: `draw:aoi-${index}:line`,
        polyline: {
          positions,
          width: shape.kind === 'path' ? 3 : 2,
          material: new Cesium.PolylineDashMaterialProperty({ color, dashLength: 14 }),
          clampToGround: true,
        },
      });
      // The name on the shape, so the map and the list can be matched without
      // counting colours.
      const labelAt = shape.kind === 'circle' ? shape.center : shape.points[0];
      committedSource.entities.add({
        id: `draw:aoi-${index}:label`,
        position: Cesium.Cartesian3.fromDegrees(labelAt.lon, labelAt.lat),
        label: {
          text: entry.name,
          font: '600 12px "JetBrains Mono", monospace',
          fillColor: color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
    committedSource.entities.resumeEvents();
    governorRequestRender('drawing-tools');
  }

  // ── Map: the shape under the cursor ──────────────────────────────────────
  /*
   * The live preview follows the mouse, so it cannot be rebuilt as entities on
   * every move: a ground-clamped polygon is built asynchronously, and re-adding
   * one per mouse event makes it flicker and lag behind the cursor. These
   * entities are made ONCE and read their geometry through CallbackProperty.
   *
   * They are drawn at the height of the first click rather than clamped. A
   * preview that sinks into a hill for a moment is a fair trade for one that
   * keeps up with the hand; the outline's depth-fail material keeps it visible
   * through terrain regardless, and the FINISHED shape is properly clamped.
   */
  let previewPositions = [];
  let previewFill = null;
  let previewColor = KIND_COLOR.circle;
  const previewLine = previewSource.entities.add({
    id: 'draw:preview:line',
    show: false,
    polyline: {
      positions: new Cesium.CallbackProperty(() => previewPositions, false),
      width: 2,
      material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => previewColor, false)),
      depthFailMaterial: new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => previewColor.withAlpha(0.5), false),
      ),
      arcType: Cesium.ArcType.GEODESIC,
    },
  });
  const previewPolygon = previewSource.entities.add({
    id: 'draw:preview:fill',
    show: false,
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => previewFill, false),
      material: new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => previewColor.withAlpha(0.18), false),
      ),
      height: new Cesium.CallbackProperty(() => anchorHeight + 1.5, false),
      perPositionHeight: false,
    },
  });

  function updatePreview() {
    const outline = previewOutline(session, cursor);
    const shape = previewShape(session, cursor);
    const lift = anchorHeight + 1.5;
    previewPositions = outline.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, lift));
    previewColor = KIND_COLOR[shape?.kind] || KIND_COLOR[modeFor(session.mode)?.shape] || KIND_COLOR.circle;
    const encloses = Boolean(shape && shape.kind !== 'path' && outline.length >= 4);
    previewFill = encloses ? new Cesium.PolygonHierarchy(previewPositions.slice(0, -1)) : null;
    previewLine.show = previewPositions.length >= 2;
    previewPolygon.show = encloses;
  }

  /** Corner markers are few and change only on a click, so they are plain entities. */
  function renderVertices() {
    for (const entity of previewSource.entities.values.slice()) {
      if (String(entity.id).startsWith('draw:vertex-')) previewSource.entities.remove(entity);
    }
    const color = KIND_COLOR[modeFor(session.mode)?.shape] || KIND_COLOR.circle;
    session.points.forEach((point, index) => {
      previewSource.entities.add({
        id: `draw:vertex-${index}`,
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, anchorHeight + 1.5),
        point: {
          pixelSize: 8,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
  }

  // ── Panel and bar ────────────────────────────────────────────────────────
  function renderBar() {
    const model = actionBarModel(session, cursor);
    bar.hidden = !model.visible;
    if (!model.visible) return;
    bar.style.setProperty('--draw-kind', SHAPE_COLORS[modeFor(session.mode)?.shape] || SHAPE_COLORS.circle);
    barUi.mode.textContent = model.modeLabel;
    barUi.prompt.textContent = model.prompt;
    barUi.measure.textContent = model.measurement;
    barUi.measure.hidden = !model.measurement;
    barUi.undo.disabled = !model.canUndo;
    barUi.finish.hidden = !model.showFinish;
    barUi.finish.disabled = !model.canFinish;
    barUi.finishLabel.textContent = model.finishLabel;
    barUi.points.textContent = model.pointsLabel;
    // Below the search bar, which owns the top centre of the screen; its height
    // changes with whatever panel it is showing, so it is measured each time.
    const pill = document.querySelector('#spotlight-root .mm-spotlight-pill');
    const below = pill ? pill.getBoundingClientRect().bottom : 0;
    bar.style.top = `${Math.max(88, Math.round(below) + 12)}px`;
  }

  function renderList() {
    const now = Date.now();
    // Newest first: the shape just drawn is the one being looked for.
    ui.list.innerHTML = committed.slice().reverse().map((entry) => {
      const value = entry.shape.kind === 'path'
        ? formatDistance(entry.measured.perimeterKm)
        : formatArea(entry.measured.areaKm2);
      return `
        <li class="draw-list-item" style="--draw-kind:${SHAPE_COLORS[entry.shape.kind]}">
          <span class="draw-list-name">${entry.name}</span>
          <span class="draw-list-meta">
            <span class="draw-list-value">${value}</span>
            <span class="draw-list-time">${relativeTime(entry.createdAt, now)}</span>
          </span>
        </li>`;
    }).join('');
    ui.exportBtn.disabled = committed.length === 0;
  }

  function render() {
    const readout = readoutFor(session, committed, inside);
    ui.area.textContent = readout.area;
    ui.perim.textContent = `${readout.aois} / ${readout.perimeter}`;
    ui.step.textContent = stepLabel(session);
    ui.prompt.textContent = readout.prompt;
    // The prompt and the live card say the same thing while drawing; show one.
    ui.prompt.hidden = Boolean(session.mode);

    for (const button of root.querySelectorAll('[data-draw-mode]')) {
      button.setAttribute('aria-pressed', button.dataset.drawMode === session.mode ? 'true' : 'false');
    }

    const model = actionBarModel(session, cursor);
    ui.live.hidden = !model.visible;
    if (model.visible) {
      const count = session.points.length;
      ui.livePoints.textContent = `${count} ${count === 1 ? 'point' : 'points'}`;
      ui.liveMeasure.textContent = model.measurement;
      ui.liveKeys.textContent = model.keyHint;
    }

    if (inside.total > 0) {
      ui.inside.hidden = false;
      const parts = inside.byLayer.map((entry) => `${entry.count} ${entry.name}`);
      // Named scope, always — the count covers ENABLED layers only, and a bare
      // number would read as "everything there is".
      ui.inside.textContent = `Inside: ${parts.join(' · ')} (enabled layers only)`;
    } else {
      ui.inside.hidden = true;
      ui.inside.textContent = '';
    }

    renderList();
    renderVertices();
    updatePreview();
    renderBar();
    governorRequestRender('drawing-tools');
  }

  /**
   * Recount against every committed AOI plus whatever is being drawn.
   *
   * Paths are excluded: a line encloses nothing, and asking what is "inside"
   * one would return whatever happened to sit on it.
   */
  function recount() {
    const live = toShape(session);
    const liveMeasured = live ? measureShape(live) : null;
    const shapes = committed
      .map((entry) => entry.shape)
      .filter((shape) => shape.kind !== 'path');
    if (live && live.kind !== 'path' && liveMeasured?.measurable) shapes.push(live);
    inside = shapes.length
      ? countInside(dataManager, shapes)
      : { total: 0, byLayer: [], layersConsidered: 0 };
  }

  /** Arm or disarm, and claim map clicks exactly while armed. */
  function setSession(next) {
    session = next;
    if (session.mode) {
      registerPickOwner(PICK_OWNER_ID, () => true);
    } else {
      unregisterPickOwner(PICK_OWNER_ID);
      cursor = null;
    }
  }

  /*
   * A finished shape goes on the list and the tool DISARMS.
   *
   * It used to stay armed "so the next AOI needs no re-arming". But an armed
   * tool claims every click on the map, and there was no way to un-arm it: after
   * one box, CCTV cameras, aircraft and search dots stopped answering clicks
   * until the page was reloaded. Choosing the shape again is one click; losing
   * the rest of the map was not a fair price for saving it.
   */
  function commitIfComplete() {
    if (!session.complete) return;
    const shape = toShape(session);
    const measured = shape ? measureShape(shape) : null;
    if (shape && measured?.measurable) {
      ordinal += 1;
      committed = [...committed, { shape, measured, name: shapeName(shape.kind, ordinal), createdAt: Date.now() }];
      renderCommitted();
    }
    setSession(createSession());
    recount();
  }

  function doFinish() {
    const finished = finish(session);
    if (finished === session) return; // below the minimum — nothing to finish
    session = finished;
    recount();
    commitIfComplete();
    render();
  }

  function doUndo() {
    session = undo(session);
    recount();
    render();
  }

  function doCancel() {
    setSession(cancel(session));
    recount();
    render();
  }

  function exportGeoJSON() {
    if (!committed.length) return;
    const collection = shapesToGeoJSON(committed);
    const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const link = document.createElement('a');
    link.href = url;
    link.download = `map-monitoring-shapes-${stamp}.geojson`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Long enough for the download to take the URL; after that it is a leak.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ── Map input ────────────────────────────────────────────────────────────
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((event) => {
    if (!session.mode) return;
    const point = pickGround(viewer, event.position);
    const before = session;
    session = addPoint(session, point);
    if (session === before) return; // a miss, or a repeat of the last point
    if (session.points.length === 1) anchorHeight = point.height || 0;
    cursor = point;
    recount();
    commitIfComplete();
    render();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  handler.setInputAction(() => {
    if (!session.mode || session.complete) return;
    doFinish();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  /*
   * The cursor, coalesced to one ground pick per animation frame.
   *
   * A mouse fires far more often than the screen redraws, and each pick reads
   * the depth buffer. Only the newest position is ever used, and nothing is
   * picked at all until a shape has its first point - before that there is no
   * preview for the cursor to drive.
   */
  let pendingMove = null;
  let moveFrame = 0;
  const applyMove = () => {
    moveFrame = 0;
    if (!pendingMove || !session.mode) return;
    const point = pickGround(viewer, pendingMove);
    pendingMove = null;
    if (!point) return;
    cursor = point;
    updatePreview();
    renderBar();
    ui.liveMeasure.textContent = actionBarModel(session, cursor).measurement;
    governorRequestRender('drawing-tools');
  };
  handler.setInputAction((movement) => {
    if (!session.mode || !session.points.length) return;
    pendingMove = movement.endPosition;
    if (!moveFrame) moveFrame = requestAnimationFrame(applyMove);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  const onKey = (event) => {
    if (isTypingTarget(event.target)) return;
    const action = keyAction(event.key, session);
    if (!action) return;
    event.preventDefault();
    if (action === 'finish') doFinish();
    else if (action === 'undo') doUndo();
    else if (action === 'cancel') doCancel();
  };
  document.addEventListener('keydown', onKey);

  // ── Panel and bar clicks ─────────────────────────────────────────────────
  const onPanelClick = (event) => {
    const modeButton = event.target.closest?.('[data-draw-mode]');
    if (modeButton) {
      // Choosing the shape that is already armed leaves it, like a toggle.
      const same = modeButton.dataset.drawMode === session.mode;
      setSession(same ? createSession() : chooseShape(session, modeButton.dataset.drawMode));
      recount();
      render();
      return;
    }
    const action = event.target.closest?.('[data-draw-action]')?.dataset.drawAction;
    if (action === 'export') {
      exportGeoJSON();
    } else if (action === 'clear') {
      committed = [];
      ordinal = 0;
      setSession(createSession());
      renderCommitted();
      recount();
      render();
    }
  };
  const onBarClick = (event) => {
    const action = event.target.closest?.('[data-bar-action]')?.dataset.barAction;
    if (action === 'undo') doUndo();
    else if (action === 'finish') doFinish();
    else if (action === 'cancel') doCancel();
  };
  root.addEventListener('click', onPanelClick);
  bar.addEventListener('click', onBarClick);

  // "just now" becomes "2 min ago" without anyone touching the panel.
  const clock = setInterval(() => { if (committed.length) renderList(); }, 30_000);

  render();

  return {
    /** Test/QA seam: the state the panel is drawn from. */
    getState() {
      return {
        session,
        committed: committed.length,
        names: committed.map((entry) => entry.name),
        inside,
        readout: readoutFor(session, committed, inside),
        bar: actionBarModel(session, cursor),
      };
    },
    /** QA seam: what EXPORT GEOJSON would write. */
    toGeoJSON() {
      return shapesToGeoJSON(committed);
    },
    destroy() {
      clearInterval(clock);
      if (moveFrame) cancelAnimationFrame(moveFrame);
      root.removeEventListener('click', onPanelClick);
      bar.removeEventListener('click', onBarClick);
      document.removeEventListener('keydown', onKey);
      bar.remove();
      handler.destroy();
      unregisterPickOwner(PICK_OWNER_ID);
      viewer.dataSources.remove(committedSource, true);
      viewer.dataSources.remove(previewSource, true);
    },
  };
}

export { DRAWING_MODES, modeFor };
