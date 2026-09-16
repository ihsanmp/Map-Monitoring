// Unit tests for what the search is told about where the map is.
//
// The case that matters is the OPENING VIEW: 4,200 km up, where the camera's
// view rectangle covers the whole globe. That rectangle used to be dropped and
// nothing put in its place, so the first search anyone ran was answered from a
// worldwide name index - "uii" returned an airport in Honduras.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBE_SPAN_LIMIT_DEG, searchLocality } from './searchLocality.js';

/** The rectangle Cesium returns from the console's opening view. */
const WHOLE_GLOBE = { south: -90, west: -180, north: 90, east: 180 };
/** A city-sized view over Yogyakarta. */
const JOGJA_VIEW = { south: -7.85, west: 110.3, north: -7.7, east: 110.45 };
/** Where the camera sits at the opening view: over the Makassar Strait. */
const INDONESIA_CAMERA = { lat: -2.5, lon: 118 };

test('a real view is sent as a box, and the camera point is then redundant', () => {
  const out = searchLocality({ view: JOGJA_VIEW, camera: INDONESIA_CAMERA });
  assert.equal(out.bias, '-7.8500,110.3000|-7.7000,110.4500');
  assert.equal(out.near, null);
});

test('the opening view falls back to the camera point instead of nothing', () => {
  // THE REGRESSION. This used to return no location at all.
  const out = searchLocality({ view: WHOLE_GLOBE, camera: INDONESIA_CAMERA });
  assert.equal(out.bias, null);
  assert.equal(out.near, '-2.5000,118.0000');
});

test('a view just inside the limit is still a view; just outside is not', () => {
  const inside = { south: 0, west: 0, north: 10, east: GLOBE_SPAN_LIMIT_DEG - 10 };
  assert.ok(searchLocality({ view: inside, camera: INDONESIA_CAMERA }).bias);
  const outside = { south: 0, west: 0, north: 10, east: GLOBE_SPAN_LIMIT_DEG - 9 };
  const out = searchLocality({ view: outside, camera: INDONESIA_CAMERA });
  assert.equal(out.bias, null);
  assert.equal(out.near, '-2.5000,118.0000');
});

test('a collapsed or inverted rectangle is not a view', () => {
  // A zero-width box says the camera is looking at a line, which it is not.
  for (const view of [
    { south: -7.8, west: 110.3, north: -7.8, east: 110.45 },
    { south: -7.8, west: 110.3, north: -7.9, east: 110.45 },
    { south: -7.8, west: 110.45, north: -7.7, east: 110.3 },
  ]) {
    const out = searchLocality({ view, camera: INDONESIA_CAMERA });
    assert.equal(out.bias, null, JSON.stringify(view));
    assert.equal(out.near, '-2.5000,118.0000');
  }
});

test('a rectangle with a missing edge is not a view', () => {
  // Number(null) is 0, a real coordinate on the equator and the prime meridian.
  for (const view of [
    { south: null, west: 110.3, north: -7.7, east: 110.45 },
    { south: -7.85, west: 110.3, north: -7.7, east: undefined },
    { south: -7.85, west: 110.3, north: NaN, east: 110.45 },
    { south: '-7.85', west: 110.3, north: -7.7, east: 110.45 },
  ]) {
    assert.equal(searchLocality({ view, camera: INDONESIA_CAMERA }).bias, null, JSON.stringify(view));
  }
});

test('with neither a view nor a camera, the search is told nothing at all', () => {
  // Better an unplaced search than a search placed at Null Island.
  for (const input of [undefined, {}, { view: null, camera: null }, { camera: { lat: null, lon: 118 } }]) {
    assert.deepEqual(searchLocality(input), { bias: null, near: null });
  }
});

test('a camera position off the planet is refused', () => {
  for (const camera of [{ lat: 91, lon: 118 }, { lat: -2.5, lon: 181 }]) {
    assert.equal(searchLocality({ view: WHOLE_GLOBE, camera }).near, null, JSON.stringify(camera));
  }
});

test('Null Island is a real place and is not filtered out', () => {
  // 0,0 is only suspicious as a MISSING value; the guard above is about type,
  // not about the coordinate itself, and a camera really over the Gulf of
  // Guinea must still say so.
  assert.equal(searchLocality({ view: WHOLE_GLOBE, camera: { lat: 0, lon: 0 } }).near, '0.0000,0.0000');
});

test('the two claims are never made at once', () => {
  // `bias` says "this is on screen" and `near` says "the camera is over here".
  // Sending both would let a caller treat a guess as a sighting.
  for (const input of [
    { view: JOGJA_VIEW, camera: INDONESIA_CAMERA },
    { view: WHOLE_GLOBE, camera: INDONESIA_CAMERA },
    { view: null, camera: INDONESIA_CAMERA },
  ]) {
    const out = searchLocality(input);
    assert.ok(!(out.bias && out.near), JSON.stringify(out));
  }
});
