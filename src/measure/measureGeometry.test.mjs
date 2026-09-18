// Unit tests for the drawing-tool maths.
//
// These numbers get read out to someone measuring a real place, so most of what
// follows checks them against values that can be LOOKED UP — a degree of
// latitude, the area of a one-degree square, the distance from Jakarta to
// Surabaya — rather than against the formulas' own output. A self-consistent
// wrong answer is the failure mode worth guarding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EARTH_RADIUS_KM,
  boxRing,
  circleAreaKm2,
  crossesAntimeridian,
  formatArea,
  formatDistance,
  haversineKm,
  measureShape,
  normalizePoint,
  pathLengthKm,
  pointInCircle,
  pointInPolygon,
  polygonAreaKm2,
  polygonPerimeterKm,
  shapeContains,
  ringSelfIntersects,
} from './measureGeometry.js';

const P = (lat, lon) => ({ lat, lon });
const toRad = (deg) => (deg * Math.PI) / 180;
/** Within `pct` percent of `expected`. */
const near = (actual, expected, pct, what) => assert.ok(
  Math.abs(actual - expected) / expected <= pct / 100,
  `${what}: got ${actual}, expected ~${expected} (±${pct}%)`,
);

// ── Distances against known values ─────────────────────────────────────────

test('one degree of latitude is 111.2 km, anywhere', () => {
  // 2*pi*R/360. True at the equator and at the pole on a sphere, which is a
  // property worth pinning: latitude spacing must not vary with longitude.
  near(haversineKm(P(0, 0), P(1, 0)), 111.195, 0.1, 'equator');
  near(haversineKm(P(60, 30), P(61, 30)), 111.195, 0.1, '60N');
  near(haversineKm(P(-7, 110), P(-6, 110)), 111.195, 0.1, 'Java');
});

test('a degree of longitude shrinks with latitude, as it must', () => {
  near(haversineKm(P(0, 0), P(0, 1)), 111.195, 0.1, 'at the equator');
  // cos(60) = 0.5 exactly.
  near(haversineKm(P(60, 0), P(60, 1)), 55.597, 0.2, 'at 60N');
});

test('Jakarta to Surabaya is about 665 km', () => {
  const km = haversineKm(P(-6.2, 106.8), P(-7.25, 112.75));
  near(km, 665, 2, 'Jakarta-Surabaya');
});

test('the equator is 40,030 km around ON THIS SPHERE', () => {
  // 2*pi*R for the IUGG MEAN radius. The familiar 40,075 km is the ellipsoid's
  // EQUATORIAL circumference, which uses a different (larger) radius — quoting
  // it here would have been comparing two different figures and calling the
  // difference an error. Summed as 36 ten-degree hops, which also exercises
  // the accumulation.
  const points = Array.from({ length: 37 }, (_, i) => P(0, -180 + i * 10));
  near(pathLengthKm(points), 2 * Math.PI * EARTH_RADIUS_KM, 0.01, 'equatorial circumference');
});

// ── Areas against known values ─────────────────────────────────────────────

test('a one-degree square at the equator is about 12,300 km²', () => {
  const area = polygonAreaKm2(boxRing(P(0, 0), P(1, 1)));
  near(area, 12308, 1, 'one-degree square');
});

test('the same square at 60N is about half the area — this is what planar maths gets wrong', () => {
  const equator = polygonAreaKm2(boxRing(P(0, 0), P(1, 1)));
  const north = polygonAreaKm2(boxRing(P(60, 0), P(61, 1)));
  // Shoelace on raw lon/lat would call these identical, and a box over Norway
  // would come out roughly twice its real size.
  near(north / equator, 0.5, 5, 'ratio at 60N');
});

test('winding direction does not change the area', () => {
  const ring = [P(0, 0), P(0, 1), P(1, 1), P(1, 0)];
  const reversed = [...ring].reverse();
  assert.equal(polygonAreaKm2(ring).toFixed(6), polygonAreaKm2(reversed).toFixed(6));
});

test('a repeated closing vertex is harmless', () => {
  const open = [P(0, 0), P(0, 1), P(1, 1), P(1, 0)];
  const closed = [...open, P(0, 0)];
  near(polygonAreaKm2(closed), polygonAreaKm2(open), 0.001, 'closed ring');
});

test('a lat/lon box matches the analytic integral EXACTLY', () => {
  // R^2 * dLon * (sin lat2 - sin lat1) is the closed form for a box bounded by
  // parallels and meridians, and the trapezoid sum reproduces it to the last
  // digit. This is the shape the tools actually draw, so exactness here is the
  // property that matters — a huge box, to make any error obvious.
  const box = polygonAreaKm2([P(0, 0), P(0, 90), P(60, 90), P(60, 0)]);
  const analytic = EARTH_RADIUS_KM ** 2 * (Math.PI / 2) * Math.sin(toRad(60));
  near(box, analytic, 0.0001, 'box against its closed form');
});

test('a great-circle polygon is approximate, and the limit is documented', () => {
  // The trapezoid formula interpolates edges along lat/lon, not along great
  // circles, and degenerates where a vertex sits on a pole. The spherical
  // octant — equator to pole across 90 degrees of longitude — is genuinely an
  // eighth of the sphere, and this formula returns half of that.
  //
  // This is pinned rather than fixed because click-drawn shapes are small,
  // never reach a pole, and are usually boxes, where the formula is exact. The
  // test exists so the limitation is a known quantity instead of a surprise.
  const octant = polygonAreaKm2([P(0, 0), P(0, 90), P(90, 0)]);
  const trueOctant = (4 * Math.PI * EARTH_RADIUS_KM ** 2) / 8;
  near(octant, trueOctant / 2, 0.5, 'the known half-answer at a pole vertex');
});

test('a circle is a spherical cap, not a flat disc', () => {
  // Small circles agree with pi*r^2...
  near(circleAreaKm2(10), Math.PI * 100, 0.01, '10 km circle');
  // ...large ones must not, and the gap grows: measured 1.8% at 3,000 km,
  // 7.2% at 6,000 km, 15.6% at 9,000 km.
  assert.ok(circleAreaKm2(3000) < Math.PI * 3000 ** 2 * 0.99, '3,000 km is ~1.8% under flat');
  assert.ok(circleAreaKm2(6000) < Math.PI * 6000 ** 2 * 0.94, '6,000 km is ~7.2% under flat');
  // A quarter-circumference radius is exactly a hemisphere.
  near(circleAreaKm2((Math.PI * EARTH_RADIUS_KM) / 2), 2 * Math.PI * EARTH_RADIUS_KM ** 2, 0.01, 'hemisphere');
});

test('perimeter of a one-degree equatorial square is about 445 km', () => {
  near(polygonPerimeterKm(boxRing(P(0, 0), P(1, 1))), 444.7, 0.5, 'perimeter');
});

// ── Containment ────────────────────────────────────────────────────────────

test('point-in-polygon answers for a box over Java', () => {
  const ring = boxRing(P(-8, 105), P(-6, 115));
  assert.equal(pointInPolygon(P(-7.8, 110.4), ring), true, 'Yogyakarta is inside');
  assert.equal(pointInPolygon(P(-6.2, 106.8), ring), true, 'Jakarta is inside');
  assert.equal(pointInPolygon(P(1.35, 103.8), ring), false, 'Singapore is not');
  assert.equal(pointInPolygon(P(-7.25, 130), ring), false, 'far east is not');
});

test('a concave shape does not swallow the notch', () => {
  // An L. The corner cut out of it must read as outside — the property a
  // bounding-box test would get wrong.
  const ell = [P(0, 0), P(0, 4), P(2, 4), P(2, 2), P(4, 2), P(4, 0)];
  assert.equal(pointInPolygon(P(1, 1), ell), true, 'inside the L');
  assert.equal(pointInPolygon(P(3, 3), ell), false, 'in the notch');
});

test('point-in-circle uses real distance', () => {
  const centre = P(-7.8, 110.4);
  assert.equal(pointInCircle(P(-7.81, 110.41), centre, 5), true);
  assert.equal(pointInCircle(P(-7.25, 112.75), centre, 5), false, 'Surabaya is 260 km away');
  assert.equal(pointInCircle(P(-7.25, 112.75), centre, 300), true);
  assert.equal(pointInCircle(centre, centre, 0), false, 'a zero radius contains nothing');
});

// ── The antimeridian, refused rather than guessed ──────────────────────────

test('a shape spanning the date line is refused, not mis-measured', () => {
  const ring = [P(-10, 179), P(-10, -179), P(10, -179), P(10, 179)];
  assert.equal(crossesAntimeridian(ring), true);
  const measured = measureShape({ kind: 'polygon', points: ring });
  assert.equal(measured.measurable, false);
  assert.match(measured.reason, /antimeridian/i);
  // 0, not a number that would be wrong by the width of the Pacific.
  assert.equal(measured.areaKm2, 0);
  assert.equal(shapeContains({ kind: 'polygon', points: ring }, P(0, 179.5)), false);
});

test('an ordinary shape is not mistaken for one that crosses it', () => {
  assert.equal(crossesAntimeridian(boxRing(P(-8, 105), P(-6, 115))), false);
  assert.equal(crossesAntimeridian([P(0, -170), P(0, -160), P(10, -165)]), false);
});

// ── measureShape ───────────────────────────────────────────────────────────

test('a path encloses nothing, and says so as a success', () => {
  const path = measureShape({ kind: 'path', points: [P(-6.2, 106.8), P(-7.25, 112.75)] });
  assert.equal(path.measurable, true, 'a measured path is not a failure');
  assert.equal(path.areaKm2, 0);
  near(path.perimeterKm, 665, 2, 'path length');
});

test('an incomplete shape reports why rather than a zero that looks like an answer', () => {
  for (const [shape, reason] of [
    [{ kind: 'polygon', points: [P(0, 0), P(0, 1)] }, /three points/i],
    [{ kind: 'path', points: [P(0, 0)] }, /two points/i],
    [{ kind: 'circle', center: P(0, 0) }, /radius/i],
    [{ kind: 'circle', radiusKm: 10 }, /centre/i],
    [{ kind: 'blob', points: [] }, /unknown/i],
  ]) {
    const measured = measureShape(shape);
    assert.equal(measured.measurable, false, JSON.stringify(shape));
    assert.match(measured.reason, reason);
  }
});

test('measureShape and shapeContains are total for junk', () => {
  for (const shape of [null, undefined, {}, 'box', 42, { kind: 'polygon' }]) {
    assert.doesNotThrow(() => measureShape(shape));
    assert.equal(measureShape(shape).measurable, false);
    assert.equal(shapeContains(shape, P(0, 0)), false);
  }
});

// ── Coordinate hygiene ─────────────────────────────────────────────────────

test('a coordinate Number() would turn into zero is rejected, not placed at 0,0', () => {
  for (const point of [
    { lat: null, lon: null }, { lat: '', lon: '' }, { lat: 0, lon: null },
    { lat: 'abc', lon: 5 }, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, null, 'nope',
  ]) {
    assert.equal(normalizePoint(point), null, JSON.stringify(point));
  }
  // A genuine zero is a real place and must survive.
  assert.deepEqual(normalizePoint({ lat: 0, lon: 0 }), { lat: 0, lon: 0 });
});

test('lng and longitude spellings both work', () => {
  assert.deepEqual(normalizePoint({ lat: 1, lng: 2 }), { lat: 1, lon: 2 });
  assert.deepEqual(normalizePoint({ latitude: 1, longitude: 2 }), { lat: 1, lon: 2 });
});

test('unusable points are dropped rather than poisoning a measurement', () => {
  const ring = [P(0, 0), { lat: null, lon: null }, P(0, 1), P(1, 1), P(1, 0)];
  near(polygonAreaKm2(ring), polygonAreaKm2(boxRing(P(0, 0), P(1, 1))), 0.001, 'ring with a hole in the data');
});

// ── Readouts ───────────────────────────────────────────────────────────────

test('the readouts switch units where a person would', () => {
  assert.equal(formatArea(0), '0 km²');
  assert.equal(formatArea(0.000123), '123 m²');
  assert.equal(formatArea(12.34), '12.3 km²');
  assert.equal(formatArea(12308), '12,308 km²');

  assert.equal(formatDistance(0), '0 km');
  assert.equal(formatDistance(0.42), '420 m');
  assert.equal(formatDistance(12.34), '12.3 km');
  assert.equal(formatDistance(40075), '40,075 km');
});

test('the readouts never print NaN or a negative', () => {
  for (const value of [NaN, -1, null, undefined, 'x', Infinity]) {
    assert.doesNotMatch(formatArea(value), /NaN|-/, `area ${value}`);
    assert.doesNotMatch(formatDistance(value), /NaN|-/, `distance ${value}`);
  }
});

// ---------------------------------------------------------------------------
// Shapes that cannot be measured as drawn
// ---------------------------------------------------------------------------

test('a bow-tie is refused, not measured as the difference of its two lobes', () => {
  // Measured in the app: a bow-tie visibly about 2 km² came back as 223 m²,
  // because its two lobes wind in opposite directions and cancel.
  const bowtie = [
    { lat: -7.76, lon: 110.36 }, { lat: -7.78, lon: 110.38 },
    { lat: -7.76, lon: 110.38 }, { lat: -7.78, lon: 110.36 },
  ];
  assert.equal(ringSelfIntersects(bowtie), true);
  const measured = measureShape({ kind: 'polygon', points: bowtie });
  assert.equal(measured.measurable, false);
  assert.equal(measured.areaKm2, 0, 'no number that could be read as the answer');
  assert.match(measured.reason, /edges cross/);
});

test('the same four corners in order are an ordinary square', () => {
  const square = [
    { lat: -7.76, lon: 110.36 }, { lat: -7.76, lon: 110.38 },
    { lat: -7.78, lon: 110.38 }, { lat: -7.78, lon: 110.36 },
  ];
  assert.equal(ringSelfIntersects(square), false);
  assert.equal(measureShape({ kind: 'polygon', points: square }).measurable, true);
});

test('a concave shape and a closing corner are not mistaken for a crossing', () => {
  const notch = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 4 }, { lat: 4, lon: 4 },
    { lat: 2, lon: 2 }, { lat: 4, lon: 0 }, { lat: 0, lon: 0 },
  ];
  assert.equal(ringSelfIntersects(notch), false);
  assert.equal(ringSelfIntersects(notch.slice(0, 3)), false, 'a triangle cannot cross itself');
});

test('corners in one line enclose nothing and say so', () => {
  // Three clicks along a street were saved as "Area 2 - 9 m²".
  const line = [
    { lat: -7.77, lon: 110.36 }, { lat: -7.77, lon: 110.37 }, { lat: -7.77000001, lon: 110.38 },
  ];
  const measured = measureShape({ kind: 'polygon', points: line });
  assert.equal(measured.measurable, false);
  assert.match(measured.reason, /one line/);
});

test('a real thin strip is still an area', () => {
  // About 10 m wide and 1 km long: a road, which is a thing people measure.
  const strip = [
    { lat: -7.77, lon: 110.36 }, { lat: -7.77, lon: 110.369 },
    { lat: -7.77009, lon: 110.369 }, { lat: -7.77009, lon: 110.36 },
  ];
  const measured = measureShape({ kind: 'polygon', points: strip });
  assert.equal(measured.measurable, true);
  assert.ok(measured.areaKm2 > 0.005 && measured.areaKm2 < 0.02, String(measured.areaKm2));
});

test('two box corners on one pixel row make a sliver, and a sliver is refused', () => {
  // Measured in the app: 3,988 m by 1.43 m, saved as "Box 1 - 5,717 m²" under
  // the first threshold.
  const sliver = [
    { lat: -7.780963, lon: 110.36 }, { lat: -7.780963, lon: 110.3962 },
    { lat: -7.7809759, lon: 110.3962 }, { lat: -7.7809759, lon: 110.36 },
  ];
  const measured = measureShape({ kind: 'box', points: sliver });
  assert.equal(measured.measurable, false);
  assert.match(measured.reason, /one line/);
});
