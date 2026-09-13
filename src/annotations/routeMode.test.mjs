// Unit tests for travel-mode resolution.
//
// The property under test is the DEFAULT. A pedestrian profile ignores one-way
// restrictions, so a route that quietly fell back to walking would be drawn
// going the wrong way up streets that only run one direction — measured in
// Yogyakarta at 4-5x shorter than the legal driving route, which is exactly how
// far a wrong-way line cuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE_MODE_BIKE,
  ROUTE_MODE_CAR,
  ROUTE_MODE_FOOT,
  normalizeRouteMode,
} from './routeMode.js';

test('an unstated mode is driving, so one-way streets are obeyed', () => {
  // THE REGRESSION. This returned 'foot', and the voice tool's own schema told
  // the model to leave the field unset for the ordinary case.
  assert.equal(normalizeRouteMode(undefined), ROUTE_MODE_CAR);
  assert.equal(normalizeRouteMode(null), ROUTE_MODE_CAR);
  assert.equal(normalizeRouteMode(''), ROUTE_MODE_CAR);
  assert.equal(normalizeRouteMode('   '), ROUTE_MODE_CAR);
});

test('a mode nobody recognises is driving too, not walking', () => {
  // Falling back to the only profile that ignores one-way is the wrong way to
  // handle a value you do not understand.
  for (const mode of ['lorry', 'scooter', 'ojek', 'FOOT?', 42, {}, []]) {
    assert.equal(normalizeRouteMode(mode), ROUTE_MODE_CAR, JSON.stringify(mode));
  }
});

test('driving can still be asked for by name', () => {
  for (const mode of ['car', 'drive', 'driving', 'CAR', ' Driving ']) {
    assert.equal(normalizeRouteMode(mode), ROUTE_MODE_CAR, mode);
  }
});

test('walking is still available — it just has to be asked for', () => {
  for (const mode of ['foot', 'walk', 'walking', 'pedestrian', 'FOOT', ' Walk ']) {
    assert.equal(normalizeRouteMode(mode), ROUTE_MODE_FOOT, mode);
  }
});

test('cycling is unchanged', () => {
  for (const mode of ['bike', 'cycle', 'cycling', 'bicycle', 'BIKE']) {
    assert.equal(normalizeRouteMode(mode), ROUTE_MODE_BIKE, mode);
  }
});

test('every answer is a profile the routing proxy accepts', () => {
  // The server rejects anything outside this set, and a rejected profile is a
  // failed route rather than a wrong one — but it is still a failure.
  const accepted = new Set([ROUTE_MODE_CAR, ROUTE_MODE_BIKE, ROUTE_MODE_FOOT]);
  for (const mode of [undefined, '', 'car', 'foot', 'bike', 'nonsense', 7]) {
    assert.ok(accepted.has(normalizeRouteMode(mode)), String(mode));
  }
});

test("the voice tool's three advertised values map as its schema promises", () => {
  // The tool schema offers exactly these and tells the model driving is the
  // default. If one of them stopped resolving, the model would keep sending it
  // and the app would quietly route some other way.
  assert.equal(normalizeRouteMode('driving'), ROUTE_MODE_CAR);
  assert.equal(normalizeRouteMode('walking'), ROUTE_MODE_FOOT);
  assert.equal(normalizeRouteMode('cycling'), ROUTE_MODE_BIKE);
});
