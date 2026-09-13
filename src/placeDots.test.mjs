// Unit tests for search-result dots and click-to-fill routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACE_DOT_ID_PREFIX,
  PLACE_DOT_LABEL_MAX,
  PLACE_DOT_LIMIT,
  applyPickedPlace,
  placeDotId,
  placeDotSpecs,
  placeIndexFromId,
} from './placeDots.js';

const ROW = (lat, lon, label) => ({ lat, lon, label });

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

test('a dot id round-trips to the row it was drawn from', () => {
  for (const index of [0, 1, 7, 29, 1234]) {
    assert.equal(placeIndexFromId(placeDotId(index)), index);
  }
});

test("an id that is not one of ours is not a dot", () => {
  // A loose parse would turn a stray id into a row and choose a place nobody
  // pointed at.
  for (const id of [
    null, undefined, '', 'mm-place-', 'mm-place-3x', 'mm-place--1', 'mm-place-1.5',
    'cctv-id-jogja-besi-plane', 'place-3', ` ${PLACE_DOT_ID_PREFIX}3`, {}, 3,
  ]) {
    assert.equal(placeIndexFromId(id), null, String(id));
  }
});

// ---------------------------------------------------------------------------
// which rows become dots
// ---------------------------------------------------------------------------

test('each dot remembers its ORIGINAL row, even after rows are skipped', () => {
  // A click resolves through this index. If skipping a bad row shifted it,
  // clicking the second cafe would choose the third.
  const specs = placeDotSpecs([
    ROW(null, 110.37, 'no latitude'),
    ROW(-7.78, 110.37, 'Kopi A, Jl. Kaliurang'),
    ROW(-7.79, 110.38, 'Kopi B'),
  ]);
  assert.deepEqual(specs.map((s) => [s.index, s.label]), [[1, 'Kopi A'], [2, 'Kopi B']]);
});

test('a coordinate that is not a number is not a place', () => {
  // Number(null) is 0: accepting it would stack every broken row at 0,0.
  const specs = placeDotSpecs([
    ROW(null, 110), ROW(-7, null), ROW('-7.7', 110), ROW(NaN, 110), ROW(-7, Infinity),
    ROW(91, 110), ROW(-7, 181), ROW(0, 0, 'Null Island'), {}, null,
  ]);
  assert.deepEqual(specs, []);
});

test('the same place listed twice is one dot', () => {
  // Two dots on the same spot: the top one wins every click, the other can
  // never be chosen.
  const specs = placeDotSpecs([
    ROW(-7.78001, 110.37001, 'Pakuwon Mall'),
    ROW(-7.780012, 110.370009, 'pakuwon mall, Sleman'),
    ROW(-7.78001, 110.37001, 'Toko Lain'),
  ]);
  assert.deepEqual(specs.map((s) => s.label), ['Pakuwon Mall', 'Toko Lain']);
});

test('the count is capped, and the cap is what callers asked for', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ROW(-7.7 - i * 0.001, 110.3, `Tempat ${i}`));
  assert.equal(placeDotSpecs(rows).length, PLACE_DOT_LIMIT);
  assert.equal(placeDotSpecs(rows, { limit: 5 }).length, 5);
  assert.equal(placeDotSpecs(rows, { limit: 0 }).length, PLACE_DOT_LIMIT, 'a nonsense cap falls back');
});

test('a label is the place name, cut short when it would sprawl', () => {
  const [short] = placeDotSpecs([ROW(-7.7, 110.3, 'Gudeg Yu Djum, Jl. Kaliurang, Sleman')]);
  assert.equal(short.label, 'Gudeg Yu Djum');
  const [long] = placeDotSpecs([ROW(-7.7, 110.3, 'Rumah Makan Dengan Nama Yang Sangat Panjang Sekali')]);
  assert.ok(long.label.length <= PLACE_DOT_LABEL_MAX, long.label);
  assert.ok(long.label.endsWith('…'));
  const [none] = placeDotSpecs([ROW(-7.7, 110.3, '')]);
  assert.equal(none.label, 'Tempat');
});

test('anything that is not a list gives no dots rather than throwing', () => {
  for (const rows of [undefined, null, 'rows', 42, {}]) {
    assert.deepEqual(placeDotSpecs(rows), []);
  }
});

// ---------------------------------------------------------------------------
// clicking a place while planning a route
// ---------------------------------------------------------------------------

const EMPTY = { text: '', point: null };
const UII = { label: 'UII, Jl. Kaliurang', lat: -7.687, lon: 110.411 };
const PAKUWON = { label: 'Pakuwon Mall Jogja', lat: -7.759, lon: 110.399 };

test('with a destination already set, clicking a place fills the start and runs', () => {
  // The common path: RUTE KE SINI set the destination, the operator clicks
  // where they are starting from, and the travel time is the next thing shown.
  const out = applyPickedPlace({
    activeField: 'origin',
    origin: EMPTY,
    destination: { text: 'Pakuwon Mall Jogja', point: { lat: -7.759, lon: 110.399 } },
  }, UII);
  assert.deepEqual(out.origin, { text: 'UII', point: { lat: -7.687, lon: 110.411 } });
  assert.equal(out.run, true);
});

test('click where you are, click where you are going: no clicks in between', () => {
  let state = { activeField: 'origin', origin: EMPTY, destination: EMPTY };
  state = applyPickedPlace(state, UII);
  assert.equal(state.activeField, 'destination', 'the cursor moves on to the empty end');
  assert.equal(state.run, false, 'one end is not a route');
  state = applyPickedPlace(state, PAKUWON);
  assert.equal(state.destination.text, 'Pakuwon Mall Jogja');
  assert.equal(state.run, true);
});

test('once both ends are set, the active field keeps taking clicks', () => {
  // Otherwise a second click on a different start would silently replace the
  // destination instead.
  const state = applyPickedPlace({
    activeField: 'origin',
    origin: { text: 'UII', point: { lat: -7.687, lon: 110.411 } },
    destination: { text: 'Pakuwon', point: { lat: -7.759, lon: 110.399 } },
  }, { label: 'Tugu Jogja', lat: -7.7829, lon: 110.3671 });
  assert.equal(state.origin.text, 'Tugu Jogja');
  assert.equal(state.destination.text, 'Pakuwon', 'the other end is untouched');
  assert.equal(state.activeField, 'origin');
  assert.equal(state.run, true);
});

test('a typed name counts as a filled end, even without a picked point', () => {
  const out = applyPickedPlace({
    activeField: 'destination',
    origin: { text: 'Malioboro', point: null },
    destination: EMPTY,
  }, PAKUWON);
  assert.equal(out.run, true);
});

test('a whitespace-only field is still empty', () => {
  const out = applyPickedPlace({
    activeField: 'destination',
    origin: { text: '   ', point: null },
    destination: EMPTY,
  }, PAKUWON);
  assert.equal(out.run, false);
  assert.equal(out.activeField, 'origin');
});

test('a click that carries no real place changes nothing and runs nothing', () => {
  const before = {
    activeField: 'origin',
    origin: EMPTY,
    destination: { text: 'Pakuwon', point: { lat: -7.759, lon: 110.399 } },
  };
  for (const place of [null, {}, { lat: null, lon: 110 }, { lat: -7, lon: '110' }, { lat: 95, lon: 110 }]) {
    const out = applyPickedPlace(before, place);
    assert.equal(out.run, false, JSON.stringify(place));
    assert.deepEqual(out.origin, EMPTY);
  }
});

test('an unknown active field is treated as the start', () => {
  const out = applyPickedPlace({ activeField: 'sideways', origin: EMPTY, destination: EMPTY }, UII);
  assert.equal(out.origin.text, 'UII');
});
