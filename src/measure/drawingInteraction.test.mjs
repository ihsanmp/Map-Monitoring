// Unit tests for the drawing interaction layer: preview, keys, action bar, list, export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPoint, chooseShape, createSession, finish } from './drawingSession.js';
import { haversineKm, measureShape } from './measureGeometry.js';
import {
  SHAPE_COLORS,
  actionBarModel,
  canFinish,
  cancel,
  circleRing,
  isTypingTarget,
  keyAction,
  previewOutline,
  previewShape,
  problemFor,
  relativeTime,
  shapeName,
  shapesToGeoJSON,
  stepLabel,
} from './drawingInteraction.js';

const P = (lat, lon) => ({ lat, lon });
const armed = (mode, ...points) => points.reduce((s, p) => addPoint(s, p), chooseShape(createSession(), mode));
const JOGJA = P(-7.7829, 110.3671);
const EAST = P(-7.7829, 110.4071);

// ---------------------------------------------------------------------------
// live preview
// ---------------------------------------------------------------------------

test('a radius grows with the cursor before the second click', () => {
  // THE GAP. The circle used to be invisible until it was already finished.
  const state = armed('radius', JOGJA);
  const near = previewShape(state, P(-7.7829, 110.3771));
  const far = previewShape(state, EAST);
  assert.equal(near.kind, 'circle');
  assert.ok(far.radiusKm > near.radiusKm * 3.5, `${near.radiusKm} -> ${far.radiusKm}`);
  assert.equal(state.points.length, 1, 'a preview is a question, not a click');
});

test('a box stretches from its first corner to the cursor', () => {
  const shape = previewShape(armed('box', JOGJA), P(-7.80, 110.40));
  assert.equal(shape.kind, 'box');
  assert.ok(measureShape(shape).areaKm2 > 5);
});

test('a path previews its next leg, an area its next corner', () => {
  const path = previewShape(armed('path', JOGJA), EAST);
  assert.equal(path.points.length, 2);
  const area = previewShape(armed('area', JOGJA, EAST), P(-7.81, 110.39));
  assert.equal(area.kind, 'polygon');
  assert.equal(area.points.length, 3, 'two clicks and the cursor already enclose something');
});

test('nothing to preview before the first click, or with the cursor off the globe', () => {
  assert.equal(previewShape(armed('radius'), EAST), null);
  assert.equal(previewShape(armed('radius', JOGJA), null), null);
  assert.equal(previewShape(armed('radius', JOGJA), { lat: null, lon: 110 }), null,
    'Number(null) is 0 - a missing latitude must not become the equator');
  assert.equal(previewShape(createSession(), EAST), null);
});

test('an area shows its first leg as a line before it can be a polygon', () => {
  // previewShape has nothing to offer here - two points enclose nothing - and
  // drawing nothing would hide the first leg of every area.
  const state = armed('area', JOGJA);
  assert.equal(previewShape(state, EAST), null);
  assert.deepEqual(previewOutline(state, EAST), [JOGJA, EAST]);
});

test('outlines of enclosing shapes are closed, a path is not', () => {
  const box = previewOutline(armed('box', JOGJA), P(-7.80, 110.40));
  assert.equal(box.length, 5);
  assert.deepEqual(box[0], box[4]);
  const circle = previewOutline(armed('radius', JOGJA), EAST);
  assert.deepEqual(circle[0], circle[circle.length - 1]);
  const path = previewOutline(armed('path', JOGJA, EAST), P(-7.80, 110.42));
  assert.equal(path.length, 3);
  assert.notDeepEqual(path[0], path[2]);
});

test('no outline without a tool, before a click, or once finished', () => {
  assert.deepEqual(previewOutline(createSession(), EAST), []);
  assert.deepEqual(previewOutline(armed('path'), EAST), []);
  assert.deepEqual(previewOutline(finish(armed('path', JOGJA, EAST)), P(-7.9, 110.5)), []);
});

// ---------------------------------------------------------------------------
// finishing, cancelling, keys
// ---------------------------------------------------------------------------

test('only a shape whose length the operator decides can be finished, and only once it is a shape', () => {
  assert.equal(canFinish(armed('path', JOGJA)), false, 'one point is not a path');
  assert.equal(canFinish(armed('path', JOGJA, EAST)), true);
  assert.equal(canFinish(armed('area', JOGJA, EAST)), false, 'two corners enclose nothing');
  assert.equal(canFinish(armed('area', JOGJA, EAST, P(-7.81, 110.39))), true);
  assert.equal(canFinish(armed('box', JOGJA)), false, 'a box finishes itself');
  assert.equal(canFinish(finish(armed('path', JOGJA, EAST))), false, 'already finished');
});

test('cancel hands the map back entirely', () => {
  const out = cancel(armed('area', JOGJA, EAST));
  assert.equal(out.mode, null);
  assert.deepEqual(out.points, []);
});

test('Enter finishes, Backspace undoes, Esc cancels - and only when they can', () => {
  const path = armed('path', JOGJA, EAST);
  assert.equal(keyAction('Enter', path), 'finish');
  assert.equal(keyAction('Backspace', path), 'undo');
  assert.equal(keyAction('Escape', path), 'cancel');
  assert.equal(keyAction('Enter', armed('path', JOGJA)), null, 'nothing to finish yet');
  assert.equal(keyAction('Backspace', armed('path')), null, 'nothing to undo');
  assert.equal(keyAction('Escape', armed('box')), 'cancel', 'Esc leaves even with nothing drawn');
  assert.equal(keyAction('a', path), null);
});

test('with no tool armed, no key means anything', () => {
  // Otherwise Escape pressed to close some panel would be swallowed by a tool
  // that is not even in use.
  for (const key of ['Enter', 'Backspace', 'Escape', 'Delete']) {
    assert.equal(keyAction(key, createSession()), null, key);
  }
});

test('typing in a field is never mistaken for a drawing key', () => {
  for (const tagName of ['INPUT', 'textarea', 'SELECT']) assert.equal(isTypingTarget({ tagName }), true, tagName);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'CANVAS' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('the step line follows whether a tool is armed', () => {
  assert.match(stepLabel(createSession()), /STEP 1/);
  assert.match(stepLabel(armed('box')), /STEP 2/);
});

// ---------------------------------------------------------------------------
// the action bar
// ---------------------------------------------------------------------------

test('no tool, no bar', () => {
  assert.deepEqual(actionBarModel(createSession()), { visible: false });
});

test('a box says which corner it is waiting for and measures as the cursor moves', () => {
  const idle = actionBarModel(armed('box'));
  assert.equal(idle.prompt, 'Click one corner');
  assert.equal(idle.canUndo, false);
  const moving = actionBarModel(armed('box', JOGJA), P(-7.80, 110.40));
  assert.equal(moving.prompt, 'Now click the opposite corner');
  assert.match(moving.measurement, /km²$/);
  assert.equal(moving.showFinish, false, 'a box finishes itself');
  assert.equal(moving.pointsLabel, '1 point');
});

test('a path shows its length, a Finish button, and the double-click shortcut once it can finish', () => {
  const one = actionBarModel(armed('path', JOGJA), EAST);
  assert.equal(one.showFinish, true);
  assert.equal(one.canFinish, false);
  assert.equal(one.pointsLabel, '1 point');
  const three = actionBarModel(armed('path', JOGJA, EAST, P(-7.80, 110.42)));
  assert.equal(three.prompt, 'Click more waypoints, or finish the path');
  assert.equal(three.finishLabel, 'Finish path');
  assert.equal(three.canFinish, true);
  assert.equal(three.pointsLabel, '3 points · or double-click the map to finish');
  assert.match(three.measurement, / km$/);
  assert.match(three.keyHint, /Enter to end/);
});

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

test('names read like the reference: kind, then the order drawn', () => {
  assert.equal(shapeName('box', 2), 'Box 2');
  assert.equal(shapeName('circle', 1), 'Radius 1');
  assert.equal(shapeName('polygon', 3), 'Area 3');
  assert.equal(shapeName('path', 4), 'Path 4');
  assert.equal(shapeName('box', 0), 'Box 1', 'a nonsense ordinal is not "Box 0"');
});

test('every kind has a colour, and a box and a radius are told apart by it', () => {
  for (const kind of ['box', 'circle', 'polygon', 'path']) assert.match(SHAPE_COLORS[kind], /^#[0-9a-f]{6}$/i);
  assert.notEqual(SHAPE_COLORS.box, SHAPE_COLORS.circle);
});

test('relative time stays short', () => {
  const now = 1_000_000_000;
  assert.equal(relativeTime(now - 5_000, now), 'just now');
  assert.equal(relativeTime(now - 3 * 60_000, now), '3 min ago');
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2 h ago');
  assert.equal(relativeTime(now + 5_000, now), 'just now', 'a clock skew is not "in the future"');
  assert.equal(relativeTime(NaN, now), '');
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test('a circle ring is a circle, not an ellipse, away from the equator', () => {
  // Adding a fixed number of degrees of longitude would make this nearly twice
  // as wide as tall at Oslo's latitude.
  const oslo = P(59.91, 10.75);
  const ring = circleRing(oslo, 5, 72);
  assert.equal(ring.length, 73);
  assert.deepEqual(ring[0], ring[ring.length - 1], 'closed');
  for (const point of ring) {
    assert.ok(Math.abs(haversineKm(oslo, point) - 5) < 0.001, `${haversineKm(oslo, point)} km`);
  }
});

test('a circle ring refuses what is not a circle', () => {
  assert.deepEqual(circleRing(P(-7, 110), 0), []);
  assert.deepEqual(circleRing(P(-7, 110), -1), []);
  assert.deepEqual(circleRing({ lat: null, lon: 110 }, 2), []);
});

test('GeoJSON: every shape becomes a feature that says what it was', () => {
  const box = { kind: 'box', points: [P(-7.7, 110.3), P(-7.7, 110.4), P(-7.8, 110.4), P(-7.8, 110.3)] };
  const circle = { kind: 'circle', center: JOGJA, radiusKm: 1.5 };
  const path = { kind: 'path', points: [JOGJA, EAST] };
  const committed = [
    { shape: circle, measured: measureShape(circle), name: 'Radius 1', createdAt: Date.UTC(2026, 8, 13) },
    { shape: box, measured: measureShape(box), name: 'Box 2' },
    { shape: path, measured: measureShape(path), name: 'Path 3' },
  ];
  const fc = shapesToGeoJSON(committed);
  assert.equal(fc.type, 'FeatureCollection');
  assert.deepEqual(fc.features.map((f) => [f.properties.name, f.geometry.type]), [
    ['Radius 1', 'Polygon'], ['Box 2', 'Polygon'], ['Path 3', 'LineString'],
  ]);

  const [c, b, p] = fc.features;
  // GeoJSON is [lon, lat]. Swapped, Yogyakarta lands in the Southern Ocean.
  assert.deepEqual(p.geometry.coordinates[0], [110.3671, -7.7829]);
  const ring = b.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'polygon rings are closed');
  assert.equal(c.properties.radiusKm, 1.5);
  assert.ok(c.properties.areaKm2 > 7 && c.properties.areaKm2 < 7.1, String(c.properties.areaKm2));
  assert.equal(c.properties.createdAt, '2026-09-13T00:00:00.000Z');
  assert.ok(p.properties.lengthKm > 4, String(p.properties.lengthKm));
  assert.equal(p.properties.areaKm2, undefined, 'a path encloses nothing, so it claims no area');
});

test('GeoJSON skips what cannot be drawn rather than writing broken geometry', () => {
  const fc = shapesToGeoJSON([
    null,
    { shape: null },
    { shape: { kind: 'path', points: [JOGJA] } },
    { shape: { kind: 'polygon', points: [JOGJA, EAST] } },
    { shape: { kind: 'circle', center: JOGJA, radiusKm: 0 } },
  ]);
  assert.deepEqual(fc.features, []);
  assert.deepEqual(shapesToGeoJSON(undefined), { type: 'FeatureCollection', features: [] });
});

// ---------------------------------------------------------------------------
// Shapes that cannot be measured
// ---------------------------------------------------------------------------

const BOWTIE = [P(-7.76, 110.36), P(-7.78, 110.38), P(-7.76, 110.38), P(-7.78, 110.36)];

test('an area whose edges cross cannot be finished, by button, Enter or double-click', () => {
  // It used to finish and be saved with the lobes cancelled: 223 m² for ~2 km².
  const state = armed('area', ...BOWTIE);
  assert.equal(canFinish(state), false);
  assert.equal(keyAction('Enter', state), null);
  const bar = actionBarModel(state);
  assert.equal(bar.canFinish, false);
  assert.match(bar.problem, /edges cross/);
});

test('the problem is said before the click that would cause it', () => {
  // Three corners of a square, cursor on the far side: clicking there would
  // make the edges cross, and the bar says so while the cursor is still moving.
  const state = armed('area', P(-7.76, 110.36), P(-7.78, 110.38), P(-7.76, 110.38));
  const warning = actionBarModel(state, P(-7.78, 110.36)).problem;
  assert.match(warning, /edges cross/);
  // The triangle so far is fine; only the spot under the cursor is not.
  assert.match(warning, /^Not here: /);
  assert.equal(canFinish(state), true, 'and the triangle can still be finished');
  // North of the triangle: neither new edge reaches the diagonal.
  assert.equal(actionBarModel(state, P(-7.75, 110.37)).problem, '', 'a good corner raises nothing');
});

test('corners in one line cannot be finished as an area', () => {
  const state = armed('area', P(-7.77, 110.36), P(-7.77, 110.37), P(-7.77000001, 110.38));
  assert.equal(canFinish(state), false);
  assert.match(actionBarModel(state).problem, /one line/);
});

test('an unfinished shape is not a problem, only an unfinished one', () => {
  // "needs at least three points" is what the prompt is for, not a warning.
  assert.equal(problemFor(null), '');
  assert.equal(problemFor({ kind: 'polygon', points: [P(-7.7, 110.3), P(-7.8, 110.4)] }), '');
  assert.equal(actionBarModel(armed('area', JOGJA), EAST).problem, '');
});

test('an ordinary area still finishes', () => {
  const square = armed('area', P(-7.76, 110.36), P(-7.76, 110.38), P(-7.78, 110.38), P(-7.78, 110.36));
  assert.equal(canFinish(square), true);
  assert.equal(actionBarModel(square).problem, '');
});
