// src/measure/measureGeometry.js
/**
 * The maths behind the drawing tools: area, perimeter, and what falls inside.
 *
 * Kept entirely free of Cesium and of the DOM, because these are the numbers
 * the panel reads out loud and they need to be checkable against values a
 * person can look up. A shape drawn over Java should report Java's area, not
 * an answer that is merely self-consistent.
 *
 * EVERYTHING IS SPHERICAL. Planar shoelace on raw lon/lat is the obvious
 * shortcut and it is wrong in a way that grows with latitude: a degree of
 * longitude is 111 km at the equator and 56 km at 60°N, so a box drawn over
 * Norway would come out roughly twice its real size. The formulas below use
 * spherical excess and haversine throughout, on a sphere of the earth's mean
 * radius. That leaves a residual error against the true ellipsoid of about
 * 0.5% — far below the precision anyone measures a region to by clicking, and
 * stated here so nobody mistakes these numbers for survey-grade.
 *
 * TWO LIMITS ARE REAL AND DOCUMENTED.
 *
 * Shapes that cross the antimeridian are REFUSED rather than mis-measured —
 * see `crossesAntimeridian`.
 *
 * And `polygonAreaKm2` interpolates each edge along lat/lon rather than along a
 * great circle. For a box bounded by parallels and meridians — the shape these
 * tools actually draw — it reproduces the closed-form integral to the last
 * digit, verified in the tests against a 55-million-km² box. For a polygon
 * whose edges are true great circles it is an approximation, and it degenerates
 * where a vertex sits on a pole: the spherical octant (equator to pole across
 * 90° of longitude) comes back as half its real area. Click-drawn shapes are
 * small, never touch a pole, and are usually boxes, so this is pinned as a
 * known quantity rather than fixed.
 *
 * @module measure/measureGeometry
 */

/** IUGG mean radius. */
export const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * A real number, or null — rejecting what `Number()` turns into 0.
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious guard
 * accepts a missing coordinate and places the point off the coast of Ghana.
 */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalize one `{lat, lon}`-ish point, or null if it is not one.
 * Accepts `lon`/`lng`/`longitude` because callers come from three different
 * corners of this app.
 *
 * @param {unknown} point
 * @returns {{lat: number, lon: number}|null}
 */
export function normalizePoint(point) {
  if (!point || typeof point !== 'object') return null;
  const lat = finiteNumber(point.lat ?? point.latitude);
  const lon = finiteNumber(point.lon ?? point.lng ?? point.longitude);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Normalize a list of points, dropping any that are not usable. */
export function normalizeRing(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const point of points) {
    const normalized = normalizePoint(point);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Great-circle distance between two points, in kilometres.
 * @param {object} a
 * @param {object} b
 * @returns {number} 0 when either point is unusable.
 */
export function haversineKm(a, b) {
  const p = normalizePoint(a);
  const q = normalizePoint(b);
  if (!p || !q) return 0;
  const dLat = toRad(q.lat - p.lat);
  const dLon = toRad(q.lon - p.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Does this ring straddle the ±180° line?
 *
 * Every planar operation here — the shoelace sum, the ray cast — treats
 * longitude as a plain number, so a shape from 179°E to 179°W looks like one
 * spanning 358 degrees the wrong way round. Rather than silently return a
 * nonsense area, callers can ask, and the panel refuses to measure instead of
 * reporting something confidently absurd.
 *
 * Detected by the only signal available without more context: a step of more
 * than 180° between consecutive vertices, which no click-drawn edge can be.
 *
 * @param {Array<object>} ring
 * @returns {boolean}
 */
export function crossesAntimeridian(ring) {
  const points = normalizeRing(ring);
  if (points.length < 2) return false;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.abs(b.lon - a.lon) > 180) return true;
  }
  return false;
}

/**
 * Area enclosed by a ring, in square kilometres.
 *
 * Spherical excess, so the answer is right at any latitude. The ring is
 * treated as closed; a repeated final vertex is harmless. Direction does not
 * matter — the sign is dropped, so a clockwise and an anticlockwise trace of
 * the same shape agree.
 *
 * @param {Array<object>} ring
 * @returns {number} 0 for fewer than three usable points.
 */
export function polygonAreaKm2(ring) {
  const points = normalizeRing(ring);
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += toRad(b.lon - a.lon) * (2 + Math.sin(toRad(a.lat)) + Math.sin(toRad(b.lat)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/**
 * Distance around a closed ring, in kilometres.
 * @param {Array<object>} ring
 * @returns {number}
 */
export function polygonPerimeterKm(ring) {
  const points = normalizeRing(ring);
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    total += haversineKm(points[i], points[(i + 1) % points.length]);
  }
  return total;
}

/**
 * Length of an OPEN path — the last point is not joined back to the first.
 * @param {Array<object>} points
 * @returns {number}
 */
export function pathLengthKm(points) {
  const list = normalizeRing(points);
  if (list.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < list.length - 1; i += 1) total += haversineKm(list[i], list[i + 1]);
  return total;
}

/**
 * Area of a spherical cap of the given radius.
 *
 * `πr²` is the flat answer and is close enough for a few kilometres, but a
 * 500 km radius is over 1% out and a continental one is far worse. The cap
 * formula costs one cosine and is right at every size.
 *
 * @param {number} radiusKm
 * @returns {number}
 */
export function circleAreaKm2(radiusKm) {
  const r = finiteNumber(radiusKm);
  if (r === null || r <= 0) return 0;
  const capped = Math.min(r, Math.PI * EARTH_RADIUS_KM); // half the globe
  return 2 * Math.PI * EARTH_RADIUS_KM ** 2 * (1 - Math.cos(capped / EARTH_RADIUS_KM));
}

/** Circumference of a circle of the given radius on the sphere. */
export function circlePerimeterKm(radiusKm) {
  const r = finiteNumber(radiusKm);
  if (r === null || r <= 0) return 0;
  // The radius of the cap's boundary circle as seen in 3D, not the surface
  // distance — a flat 2πr overstates a large circle.
  return 2 * Math.PI * EARTH_RADIUS_KM * Math.sin(Math.min(r, Math.PI * EARTH_RADIUS_KM) / EARTH_RADIUS_KM);
}

/**
 * The four corners of an axis-aligned box, as a ring.
 * @param {object} a One corner.
 * @param {object} b The opposite corner.
 * @returns {Array<{lat:number, lon:number}>} Empty when either corner is unusable.
 */
export function boxRing(a, b) {
  const p = normalizePoint(a);
  const q = normalizePoint(b);
  if (!p || !q) return [];
  const south = Math.min(p.lat, q.lat);
  const north = Math.max(p.lat, q.lat);
  const west = Math.min(p.lon, q.lon);
  const east = Math.max(p.lon, q.lon);
  return [
    { lat: south, lon: west },
    { lat: south, lon: east },
    { lat: north, lon: east },
    { lat: north, lon: west },
  ];
}

/**
 * Is a point inside a ring?
 *
 * Even-odd ray casting in lon/lat. Planar, and therefore subject to the
 * antimeridian limit above; for a click-drawn shape away from ±180° the error
 * against a true spherical test is far below a pixel.
 *
 * A point exactly on an edge is not guaranteed either way, which is the normal
 * property of this algorithm and does not matter for counting aircraft.
 *
 * @param {object} point
 * @param {Array<object>} ring
 * @returns {boolean}
 */
export function pointInPolygon(point, ring) {
  const p = normalizePoint(point);
  const points = normalizeRing(ring);
  if (!p || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    const straddles = (a.lat > p.lat) !== (b.lat > p.lat);
    if (!straddles) continue;
    const crossingLon = ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon;
    if (p.lon < crossingLon) inside = !inside;
  }
  return inside;
}

/** Is a point within `radiusKm` of a centre? */
export function pointInCircle(point, center, radiusKm) {
  const r = finiteNumber(radiusKm);
  if (r === null || r <= 0) return false;
  const p = normalizePoint(point);
  const c = normalizePoint(center);
  if (!p || !c) return false;
  return haversineKm(p, c) <= r;
}

/**
 * Measure a shape.
 *
 * @param {{kind: string, points?: Array<object>, center?: object, radiusKm?: number}} shape
 * @returns {{areaKm2: number, perimeterKm: number, vertices: number,
 *   measurable: boolean, reason: string}} `measurable` is false when the shape
 *   is incomplete or crosses the antimeridian; `areaKm2` is then 0 rather than
 *   a number that would be wrong.
 */
export function measureShape(shape) {
  const kind = String(shape?.kind || '').toLowerCase();
  const none = (reason, vertices = 0) => ({
    areaKm2: 0, perimeterKm: 0, vertices, measurable: false, reason,
  });

  if (kind === 'circle') {
    const center = normalizePoint(shape?.center);
    const radiusKm = finiteNumber(shape?.radiusKm);
    if (!center || radiusKm === null || radiusKm <= 0) return none('needs a centre and a radius');
    return {
      areaKm2: circleAreaKm2(radiusKm),
      perimeterKm: circlePerimeterKm(radiusKm),
      vertices: 1,
      measurable: true,
      reason: '',
    };
  }

  const points = normalizeRing(shape?.points);

  if (kind === 'path') {
    if (points.length < 2) return none('needs at least two points', points.length);
    // A path encloses nothing. Reporting 0 km² is correct, not a failure —
    // hence measurable:true with no area.
    return {
      areaKm2: 0,
      perimeterKm: pathLengthKm(points),
      vertices: points.length,
      measurable: true,
      reason: '',
    };
  }

  if (kind === 'polygon' || kind === 'box') {
    if (points.length < 3) return none('needs at least three points', points.length);
    if (crossesAntimeridian(points)) {
      // Better to say so than to report an area that is wrong by the width of
      // the Pacific.
      return none('crosses the antimeridian', points.length);
    }
    /*
     * A ring whose edges cross is not one shape, and its "area" is not an area.
     *
     * The two lobes of a bow-tie wind in opposite directions, so the signed
     * formula cancels them: measured in the app, a bow-tie visibly about 2 km²
     * across was reported as 223 m². Refused, with the reason, so the operator
     * re-clicks the corners in order instead of trusting the number.
     */
    if (ringSelfIntersects(points)) {
      return none('its edges cross each other', points.length);
    }
    const areaKm2 = polygonAreaKm2(points);
    const perimeterKm = polygonPerimeterKm(points);
    /*
     * Corners in (almost) one line enclose nothing.
     *
     * Three clicks along a street were saved as "Area 2 - 9 m²": a sliver whose
     * area is rounding noise. Judged by shape rather than by size, so a real
     * thin strip - a 10 m wide road a kilometre long - still counts: this is
     * the isoperimetric ratio 4*pi*A/P², 1 for a circle, about 0.03 for that
     * road, and about 0.00003 for the three clicks along a line. See
     * DEGENERATE_RATIO for where the line is drawn.
     */
    if (perimeterKm > 0 && (4 * Math.PI * areaKm2) / (perimeterKm * perimeterKm) < DEGENERATE_RATIO) {
      return none('its corners lie on one line, so it encloses nothing', points.length);
    }
    return {
      areaKm2,
      perimeterKm,
      vertices: points.length,
      measurable: true,
      reason: '',
    };
  }
  return none('unknown shape');
}

/**
 * Below this isoperimetric ratio a polygon is a line, not an area.
 *
 * For a long thin shape the ratio is about pi * width / length, so this refuses
 * anything more than about 1,000 times longer than it is wide - one side under
 * a pixel on any screen it could have been drawn on. Measured: two box corners
 * clicked on the same pixel row made a 3,988 m by 1.43 m sliver (0.0011), which
 * the first threshold of 0.001 let through as "Box 1 - 5,717 m²". A 10 m wide,
 * 1 km long road scores 0.031 and three clicks along one street 0.00003.
 */
export const DEGENERATE_RATIO = 0.003;

/** Signed area of the triangle a-b-c in lon/lat: positive left turn, negative right, 0 in line. */
function orient(a, b, c) {
  return (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
}

/** Do segments p1-p2 and q1-q2 cross at a point interior to both? */
function segmentsCross(p1, p2, q1, q2) {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Does any edge of this ring cross another?
 *
 * Planar in lon/lat, which is exact enough at the scale anyone draws by hand;
 * shapes across the antimeridian are refused before this is asked. Neighbouring
 * edges share a corner and are not compared. A repeated closing vertex is
 * ignored, the same as everywhere else in this module.
 *
 * @param {Array<{lat:number, lon:number}>} points
 * @returns {boolean}
 */
export function ringSelfIntersects(points) {
  const ring = normalizeRing(points);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first.lat === last.lat && first.lon === last.lon) ring.pop();
  const n = ring.length;
  if (n < 4) return false; // a triangle cannot cross itself
  for (let i = 0; i < n; i += 1) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      // Skip the edge itself and its two neighbours, which meet it at a corner.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Is a point inside a shape? Paths enclose nothing, so always false. */
export function shapeContains(shape, point) {
  const kind = String(shape?.kind || '').toLowerCase();
  if (kind === 'circle') return pointInCircle(point, shape?.center, shape?.radiusKm);
  if (kind === 'polygon' || kind === 'box') {
    if (crossesAntimeridian(shape?.points)) return false;
    return pointInPolygon(point, shape?.points);
  }
  return false;
}

/**
 * Area for a readout: m² below a square kilometre, km² above.
 * @param {number} km2
 * @returns {string}
 */
export function formatArea(km2) {
  const value = finiteNumber(km2);
  if (value === null || value <= 0) return '0 km²';
  if (value < 1) return `${Math.round(value * 1e6).toLocaleString('en-US')} m²`;
  if (value < 100) return `${value.toFixed(1)} km²`;
  return `${Math.round(value).toLocaleString('en-US')} km²`;
}

/**
 * Distance for a readout: metres below a kilometre, km above.
 * @param {number} km
 * @returns {string}
 */
export function formatDistance(km) {
  const value = finiteNumber(km);
  if (value === null || value <= 0) return '0 km';
  if (value < 1) return `${Math.round(value * 1000)} m`;
  if (value < 100) return `${value.toFixed(1)} km`;
  return `${Math.round(value).toLocaleString('en-US')} km`;
}
