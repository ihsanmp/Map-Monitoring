// src/searchLocality.js
/**
 * Telling the place search WHERE THE OPERATOR IS LOOKING.
 *
 * THE BUG. The search sent a `bias` box taken from the camera's view rectangle,
 * and dropped it when that rectangle covered the globe. The opening view is
 * exactly that case - the console starts 4,200 km up over Indonesia, and from
 * there `computeViewRectangle()` returns -90,-180 to 90,180. So the first search
 * anyone runs is an unplaced one, answered from a worldwide name index by
 * importance alone. Measured: "uii" came back as Aeropuerto de Utila in
 * Honduras. With a box around the camera it comes back as Universitas Islam
 * Indonesia, which is the campus the operator was looking at.
 *
 * TWO DIFFERENT CLAIMS, kept apart on purpose:
 *
 *   `bias` - "this rectangle is on screen". Trustworthy enough to search inside.
 *   `near` - "the camera is over this point". True at any altitude, but it says
 *            nothing about how much is visible.
 *
 * They are separate parameters because the two searches need different things.
 * A NAME search only wants a hint about which half of the world to prefer, and
 * `near` is a good hint. A CATEGORY search ("kafe", "spbu") asks what is around
 * you and is answered by a radius on the ground, so a hint is not enough: at the
 * opening view the camera sits over the Makassar Strait, and a radius there
 * would answer "no cafes nearby" about the open sea. That search keeps refusing
 * until the map is zoomed in, which is the honest answer.
 *
 * Pure: no Cesium, no DOM.
 *
 * @module searchLocality
 */

/**
 * Above this, a view rectangle is not a place.
 *
 * A rectangle this wide tells the search nothing it can use, and sending it
 * would only add noise to the ranking. The server applies its own limit too.
 */
export const GLOBE_SPAN_LIMIT_DEG = 300;

/** A number that is really a number. `Number(null)` is 0, which is a real coordinate. */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * What to tell the search about where the map is.
 *
 * @param {object} [input]
 * @param {{south:number, west:number, north:number, east:number}|null} [input.view]
 *   The camera's view rectangle, in DEGREES.
 * @param {{lat:number, lon:number}|null} [input.camera]
 *   The point on the ground under the camera, in degrees.
 * @returns {{bias:string|null, near:string|null}} `bias` is "s,w|n,e"; `near` is "lat,lon".
 *   At most one is set: a usable view makes the camera point redundant.
 */
export function searchLocality({ view, camera } = {}) {
  const south = finite(view?.south);
  const west = finite(view?.west);
  const north = finite(view?.north);
  const east = finite(view?.east);

  const haveRect = south !== null && west !== null && north !== null && east !== null;
  if (haveRect && north > south && east > west) {
    const span = Math.abs(east - west) + Math.abs(north - south);
    if (span <= GLOBE_SPAN_LIMIT_DEG) {
      return {
        bias: `${south.toFixed(4)},${west.toFixed(4)}|${north.toFixed(4)},${east.toFixed(4)}`,
        near: null,
      };
    }
  }

  // No usable rectangle. The camera still knows which part of the world it is
  // pointed at, and that is better than asking the whole planet.
  const lat = finite(camera?.lat);
  const lon = finite(camera?.lon);
  if (lat === null || lon === null) return { bias: null, near: null };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { bias: null, near: null };
  return { bias: null, near: `${lat.toFixed(4)},${lon.toFixed(4)}` };
}
