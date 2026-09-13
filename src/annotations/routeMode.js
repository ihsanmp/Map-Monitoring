// src/annotations/routeMode.js
/**
 * Which OSRM profile a route request means.
 *
 * THE DEFAULT IS THE WHOLE POINT. An unset mode used to resolve to `foot`, and
 * **the pedestrian profile ignores one-way restrictions entirely** — it will
 * walk you straight up a street whose traffic runs the other way. Drawn on a map
 * as a driving route, that is a route against the flow.
 *
 * Measured against the live FOSSGIS servers, Yogyakarta, travelling north up
 * streets that only run south:
 *
 *   Malioboro          foot   828 m   car  3533 m   (4.3x)
 *   Jl. Mangkubumi     foot   432 m   car  2319 m   (5.4x)
 *
 * The car profile takes the long way round because the short way is illegal.
 * The foot profile does not, because for a pedestrian it is not. Whole districts
 * of the city are one-way, so this is not an edge case there.
 *
 * The console's own route panel always asked for `car`, and the voice tool's
 * schema already told the model that driving was the default and to leave the
 * field unset for the ordinary case — so the code was contradicting its own
 * documented contract, and only for the callers that trusted it.
 *
 * Walking and cycling are still available; they just have to be asked for.
 *
 * @module annotations/routeMode
 */

/** Driving. Honours one-way streets, turn restrictions and access tags. */
export const ROUTE_MODE_CAR = 'car';
/** Cycling. Honours one-way except where cycling is explicitly exempt. */
export const ROUTE_MODE_BIKE = 'bike';
/** Walking. Ignores one-way entirely — correct for a pedestrian, wrong for a vehicle. */
export const ROUTE_MODE_FOOT = 'foot';

/**
 * Resolve a caller's travel mode to a profile this app routes with.
 *
 * Anything unrecognised or absent is a car, because this console is built for
 * driving and because the failure it prevents (a route the wrong way up a
 * one-way street) is worse than the one it risks (a driving route for someone
 * who meant to walk, which is legal, merely longer).
 *
 * @param {string} [mode]
 * @returns {'car'|'bike'|'foot'}
 */
export function normalizeRouteMode(mode) {
  const text = String(mode ?? '').trim().toLowerCase();
  if (text === 'foot' || text === 'walk' || text === 'walking' || text === 'pedestrian') {
    return ROUTE_MODE_FOOT;
  }
  if (text === 'bike' || text === 'cycle' || text === 'cycling' || text === 'bicycle') {
    return ROUTE_MODE_BIKE;
  }
  return ROUTE_MODE_CAR;
}
