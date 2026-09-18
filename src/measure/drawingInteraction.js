// src/measure/drawingInteraction.js
/**
 * How drawing FEELS: the live preview, the keys, the action bar, the shape list.
 *
 * drawingSession.js decides what a shape IS after each click. This decides what
 * the operator sees between clicks - which is most of the time spent drawing,
 * and was where the tools fell short:
 *
 *   - Nothing moved until the second click. A radius was invisible until it was
 *     already finished, so its size was a guess you only saw the result of.
 *     previewShape() includes the point under the cursor, so the circle grows
 *     as the mouse moves and the box stretches with it.
 *
 *   - The only instructions were in a side panel, away from where the eyes are.
 *     actionBarModel() is a bar over the map: what to click next, the live
 *     measurement, and Undo / Finish / Cancel within reach.
 *
 *   - There was no way out. A tool stayed armed after a shape was finished, and
 *     an armed tool claims every click on the map - CCTV, aircraft, search dots
 *     all stopped responding until the page was reloaded. Finishing now returns
 *     to STEP 1, and Esc or Cancel leaves at any time.
 *
 * Pure: no Cesium, no DOM.
 *
 * @module measure/drawingInteraction
 */

import { createSession, modeFor, toShape } from './drawingSession.js';
import { EARTH_RADIUS_KM, formatArea, formatDistance, measureShape, normalizePoint } from './measureGeometry.js';

/**
 * One colour per kind, so a list entry and the shape on the map are matched by
 * eye rather than by reading. A box is red and a radius cyan, as in the Osiris
 * reference this was built to match.
 */
export const SHAPE_COLORS = Object.freeze({
  box: '#ff4d6d',
  circle: '#22d3ee',
  polygon: '#a78bfa',
  path: '#22d3ee',
});

/** The name a finished shape is listed under. */
const KIND_NAMES = Object.freeze({ box: 'Box', circle: 'Radius', polygon: 'Area', path: 'Path' });

/**
 * The shape as it would be if the operator clicked where the cursor is now.
 *
 * Returns null when the cursor adds nothing drawable - before the first click,
 * or with the cursor off the globe. Never mutates the session: a preview is a
 * question, not a click.
 *
 * @param {object} state A drawing session.
 * @param {{lat:number, lon:number}|null} cursor
 * @returns {object|null} A shape in `measureShape` form.
 */
export function previewShape(state, cursor) {
  const mode = modeFor(state?.mode);
  if (!mode || state.complete) return toShape(state);
  const point = normalizePoint(cursor);
  const points = state.points || [];
  if (!point || !points.length) return toShape(state);
  // With every click a box or a radius needs already made, the cursor has no
  // say: the next click would start nothing, so there is nothing to preview.
  if (mode.exactPoints !== null && points.length >= mode.exactPoints) return toShape(state);
  return toShape({ ...state, points: [...points, point] });
}

/**
 * The line to draw under the cursor, as points on the sphere.
 *
 * Separate from previewShape because an outline exists before a shape does:
 * an area with one corner and the cursor is a line, not yet a polygon, and
 * showing nothing there would leave the first leg of every area invisible.
 *
 * Rings are closed (last point repeats the first) so a polyline draws the
 * whole outline. A path stays open.
 *
 * @param {object} state
 * @param {{lat:number, lon:number}|null} cursor
 * @returns {Array<{lat:number, lon:number}>} Empty when there is nothing to draw.
 */
export function previewOutline(state, cursor) {
  const mode = modeFor(state?.mode);
  if (!mode || state.complete) return [];
  const shape = previewShape(state, cursor);
  if (shape?.kind === 'circle') return circleRing(shape.center, shape.radiusKm);
  if (shape?.kind === 'box' || shape?.kind === 'polygon') {
    return [...shape.points, { ...shape.points[0] }];
  }
  if (shape?.kind === 'path') return [...shape.points];
  // Not a shape yet: the clicks so far plus the cursor, as a line.
  const point = normalizePoint(cursor);
  const points = [...(state.points || []), ...(point ? [point] : [])];
  return points.length >= 2 ? points : [];
}

/**
 * Whether a shape the operator controls the length of can be finished now.
 *
 * Enough corners is not enough: a ring whose edges cross, or whose corners lie
 * on one line, measures as nonsense. Finishing one used to either save it with
 * a wrong area or throw it away without a word - so finishing is refused while
 * that is true, and problemFor() says why.
 */
export function canFinish(state) {
  const mode = modeFor(state?.mode);
  if (!mode || state.complete || mode.exactPoints !== null) return false;
  if ((state.points?.length || 0) < mode.minPoints) return false;
  return measureShape(toShape(state)).measurable;
}

/**
 * Why this shape cannot be measured, in words for the operator - or '' when it
 * can, or when it is simply not finished yet (that is what the prompt is for).
 *
 * @param {object|null} shape
 * @returns {string}
 */
export function problemFor(shape) {
  if (!shape) return '';
  const measured = measureShape(shape);
  if (measured.measurable || /^needs /.test(measured.reason)) return '';
  return `Cannot measure: ${measured.reason}`;
}

/** Leave the tool entirely: nothing chosen, nothing half-drawn, clicks handed back. */
export function cancel() {
  return createSession();
}

/** Keys that mean something while drawing, and nothing otherwise. */
export function keyAction(key, state) {
  const mode = modeFor(state?.mode);
  if (!mode) return null;
  if (key === 'Escape') return 'cancel';
  if (key === 'Enter') return canFinish(state) ? 'finish' : null;
  if (key === 'Backspace' || key === 'Delete') return state.points?.length ? 'undo' : null;
  return null;
}

/**
 * Whether a key event came from somewhere a person is typing.
 *
 * Backspace in the search bar deletes a letter. It must not also delete the
 * last corner of a shape on the map.
 */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The panel's step line. */
export function stepLabel(state) {
  return modeFor(state?.mode) ? 'STEP 2 — NOW CLICK THE MAP' : 'STEP 1 — CHOOSE A SHAPE';
}

/** What to click next, in the words the action bar shows. */
function nextClick(mode, count) {
  if (mode.id === 'box') return count === 0 ? 'Click one corner' : 'Now click the opposite corner';
  if (mode.id === 'radius') return count === 0 ? 'Click the centre' : 'Now click to set the radius';
  if (mode.id === 'path') {
    if (count === 0) return 'Click the start of the path';
    if (count === 1) return 'Click the next waypoint';
    return 'Click more waypoints, or finish the path';
  }
  if (count === 0) return 'Click the first corner';
  if (count < mode.minPoints) return 'Click the next corner';
  return 'Click more corners, or finish the area';
}

/** The live number for a shape: length for a path, area for anything that encloses. */
function measurementFor(shape) {
  if (!shape) return '';
  const measured = measureShape(shape);
  if (!measured?.measurable) return '';
  return shape.kind === 'path' ? formatDistance(measured.perimeterKm) : formatArea(measured.areaKm2);
}

/**
 * Everything the floating action bar shows. `visible: false` when no tool is armed.
 *
 * @param {object} state
 * @param {{lat:number, lon:number}|null} [cursor]
 */
export function actionBarModel(state, cursor = null) {
  const mode = modeFor(state?.mode);
  if (!mode) return { visible: false };
  const count = state.points?.length || 0;
  const finishable = mode.exactPoints === null;
  const points = `${count} ${count === 1 ? 'point' : 'points'}`;
  return {
    visible: true,
    modeLabel: mode.label,
    prompt: nextClick(mode, count),
    measurement: measurementFor(previewShape(state, cursor)),
    /*
     * Shown in place of the measurement. Two different situations:
     *   - the shape AS CLICKED cannot be measured -> "Cannot measure: ..."
     *   - it can, but a click where the cursor is would break it -> "Not here: ..."
     * The second is said before the click, so the corner can go elsewhere, and
     * does not claim that the shape so far is wrong.
     */
    problem: problemFor(toShape(state))
      || problemFor(previewShape(state, cursor)).replace(/^Cannot measure: /, 'Not here: '),
    canUndo: count > 0,
    // Only shapes the operator decides the length of have a Finish button; a box
    // and a radius finish themselves on the second click.
    showFinish: finishable,
    canFinish: canFinish(state),
    finishLabel: mode.id === 'path' ? 'Finish path' : 'Finish area',
    pointsLabel: finishable && canFinish(state)
      ? `${points} · or double-click the map to finish`
      : points,
    keyHint: finishable
      ? 'Double-click or Enter to end · Backspace undoes · Esc cancels'
      : 'Backspace undoes · Esc cancels',
  };
}

/** "Box 2": the kind, and the order it was drawn in across all shapes. */
export function shapeName(kind, ordinal) {
  const n = Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : 1;
  return `${KIND_NAMES[kind] || 'Shape'} ${n}`;
}

/** How long ago, short enough for a list row. */
export function relativeTime(thenMs, nowMs = Date.now()) {
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return '';
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}

/**
 * A circle as a closed ring of points on the sphere.
 *
 * GeoJSON has no circle, so an exported radius is a polygon. The points are
 * spaced by true bearing and distance from the centre, not by adding degrees:
 * a "circle" drawn by adding a fixed number of degrees of longitude is an
 * ellipse everywhere off the equator - at Yogyakarta, 0.8% too wide; in Oslo,
 * nearly twice as wide as it is tall.
 *
 * @param {{lat:number, lon:number}} center
 * @param {number} radiusKm
 * @param {number} [segments]
 * @returns {Array<{lat:number, lon:number}>} Closed: the last point equals the first.
 */
export function circleRing(center, radiusKm, segments = 64) {
  const c = normalizePoint(center);
  if (!c || !Number.isFinite(radiusKm) || radiusKm <= 0) return [];
  const n = Math.max(8, Math.floor(segments));
  const toRad = Math.PI / 180;
  const lat1 = c.lat * toRad;
  const lon1 = c.lon * toRad;
  const angular = radiusKm / EARTH_RADIUS_KM;
  const ring = [];
  for (let i = 0; i < n; i += 1) {
    const bearing = (2 * Math.PI * i) / n;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
    ring.push({ lat: lat2 / toRad, lon: ((((lon2 / toRad) + 540) % 360) - 180) });
  }
  ring.push({ ...ring[0] });
  return ring;
}

/** [lon, lat], rounded to about a centimetre - GeoJSON's order, and no false precision. */
const lonLat = (p) => [Math.round(p.lon * 1e7) / 1e7, Math.round(p.lat * 1e7) / 1e7];

/** A polygon ring in GeoJSON form: closed, counter-clockwise is not required by readers we target. */
function closedRing(points) {
  const ring = points.map(lonLat);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && (first[0] !== last[0] || first[1] !== last[1])) ring.push([...first]);
  return ring;
}

/**
 * The finished shapes as a GeoJSON FeatureCollection.
 *
 * Every feature carries its name, kind and measurement, so a file opened in
 * QGIS or geojson.io says what each shape was without the app that drew it.
 *
 * @param {Array<{shape:object, measured:object, name:string, createdAt?:number}>} committed
 * @returns {object}
 */
export function shapesToGeoJSON(committed) {
  const features = [];
  for (const entry of Array.isArray(committed) ? committed : []) {
    const shape = entry?.shape;
    if (!shape) continue;
    let geometry = null;
    if (shape.kind === 'circle') {
      const ring = circleRing(shape.center, shape.radiusKm);
      if (ring.length) geometry = { type: 'Polygon', coordinates: [closedRing(ring)] };
    } else if (shape.kind === 'path') {
      if (shape.points?.length >= 2) geometry = { type: 'LineString', coordinates: shape.points.map(lonLat) };
    } else if (shape.points?.length >= 3) {
      geometry = { type: 'Polygon', coordinates: [closedRing(shape.points)] };
    }
    if (!geometry) continue;
    const measured = entry.measured || {};
    features.push({
      type: 'Feature',
      geometry,
      properties: {
        name: entry.name || shapeName(shape.kind, features.length + 1),
        kind: shape.kind,
        ...(shape.kind === 'path'
          ? { lengthKm: round3(measured.perimeterKm) }
          : { areaKm2: round3(measured.areaKm2), perimeterKm: round3(measured.perimeterKm) }),
        ...(shape.kind === 'circle' ? { radiusKm: round3(shape.radiusKm), center: lonLat(shape.center) } : {}),
        ...(Number.isFinite(entry.createdAt) ? { createdAt: new Date(entry.createdAt).toISOString() } : {}),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function round3(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}
