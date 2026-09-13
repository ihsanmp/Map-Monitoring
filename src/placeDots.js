// src/placeDots.js
/**
 * Search results as dots on the map, and what a click on one means.
 *
 * WHY. A search used to answer in a list only. The map showed a single pin for
 * the row you picked, so "where are the cafes around here" was a column of
 * names you had to read, pick one of, and fly to — and to compare two you had
 * to search again. Every maps app answers that question on the map: the places
 * are dots, and you click the one you mean.
 *
 * Two decisions live here, both pure so they can be tested without a globe:
 *
 *   1. Which rows become dots (placeDotSpecs).
 *   2. While a route is being planned, which end a clicked place fills, and
 *      whether that completes the question (applyPickedPlace).
 *
 * @module placeDots
 */

/**
 * At most this many dots.
 *
 * A category search answers with up to a few dozen places. Past this the labels
 * pile on top of each other at city zoom, and every one is an entity the scene
 * keeps drawing on a machine that already struggles.
 */
export const PLACE_DOT_LIMIT = 30;

/** Every dot's entity id starts with this, which is how a click is recognised as ours. */
export const PLACE_DOT_ID_PREFIX = 'mm-place-';

/** A label longer than this is cut: it is a caption on a dot, not an address. */
export const PLACE_DOT_LABEL_MAX = 32;

/** Entity id for the dot of the row at `index`. */
export function placeDotId(index) {
  return `${PLACE_DOT_ID_PREFIX}${index}`;
}

/**
 * The row index a dot's id stands for, or null when the id is not one of ours.
 *
 * Strict: `mm-place-3x`, `mm-place--1` and `mm-place-` are not dots. A loose
 * parse would turn a stray id into row 3, and a click would choose a place the
 * operator never pointed at.
 */
export function placeIndexFromId(id) {
  const text = String(id ?? '');
  if (!text.startsWith(PLACE_DOT_ID_PREFIX)) return null;
  const tail = text.slice(PLACE_DOT_ID_PREFIX.length);
  if (!/^\d+$/.test(tail)) return null;
  const index = Number(tail);
  return Number.isSafeInteger(index) ? index : null;
}

/** A coordinate that is really a coordinate. `Number(null)` is 0, so null is not accepted. */
function finiteCoordinate(value, limit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.abs(value) <= limit ? value : null;
}

/** The place's own name: the first part of a geocoder label. */
function shortLabel(label) {
  const first = String(label ?? '').split(',')[0].trim();
  if (first.length <= PLACE_DOT_LABEL_MAX) return first;
  return `${first.slice(0, PLACE_DOT_LABEL_MAX - 1).trimEnd()}…`;
}

/**
 * Turn geocoder rows into dots.
 *
 * Each spec keeps the ORIGINAL row index, so a click on a dot resolves to the
 * row it was drawn from even after rows were skipped or de-duplicated.
 *
 * @param {Array<{lat:number, lon:number, label?:string}>} rows
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {Array<{index:number, lat:number, lon:number, label:string}>}
 */
export function placeDotSpecs(rows, { limit = PLACE_DOT_LIMIT } = {}) {
  if (!Array.isArray(rows)) return [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : PLACE_DOT_LIMIT;
  const seen = new Set();
  const specs = [];
  rows.forEach((row, index) => {
    if (specs.length >= cap || !row) return;
    const lat = finiteCoordinate(row.lat, 90);
    const lon = finiteCoordinate(row.lon, 180);
    if (lat === null || lon === null) return;
    // Null Island is where a missing coordinate lands, never where a cafe is.
    if (lat === 0 && lon === 0) return;
    const label = shortLabel(row.label);
    /*
     * The same place listed twice - a node and its building, say - would draw
     * two dots on top of each other, and the one on top would win every click.
     * About a metre apart with the same name is one place.
     */
    const key = `${lat.toFixed(5)},${lon.toFixed(5)},${label.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({ index, lat, lon, label: label || 'Tempat' });
  });
  return specs;
}

/** An end of a route: what is written in the field, and the exact point if one was picked. */
function filled(end) {
  return Boolean(end && (end.point || String(end.text ?? '').trim()));
}

/**
 * A place was clicked while a route is being planned. Fill an end with it.
 *
 * The rule is the one a person would guess: the field you were last in gets the
 * place. After that the cursor moves on to the OTHER end if it is still empty,
 * so "click where I am, click where I am going" needs no clicks in between. The
 * moment both ends hold something the route is run — the travel time is the
 * answer being asked for, and making someone press a button to see it after
 * they have already said both places is a step that adds nothing.
 *
 * @param {object} state
 * @param {'origin'|'destination'} state.activeField
 * @param {{text:string, point:{lat:number, lon:number}|null}} state.origin
 * @param {{text:string, point:{lat:number, lon:number}|null}} state.destination
 * @param {{label?:string, lat:number, lon:number}} place
 * @returns {{origin:object, destination:object, activeField:'origin'|'destination', run:boolean}}
 */
export function applyPickedPlace(state, place) {
  const activeField = state?.activeField === 'destination' ? 'destination' : 'origin';
  const origin = state?.origin || { text: '', point: null };
  const destination = state?.destination || { text: '', point: null };

  const lat = finiteCoordinate(place?.lat, 90);
  const lon = finiteCoordinate(place?.lon, 180);
  if (lat === null || lon === null) {
    // A click that did not carry a real place changes nothing and runs nothing.
    return { origin, destination, activeField, run: false };
  }

  const end = { text: shortLabel(place.label) || 'Titik di peta', point: { lat, lon } };
  const next = activeField === 'origin'
    ? { origin: end, destination }
    : { origin, destination: end };

  const other = activeField === 'origin' ? 'destination' : 'origin';
  return {
    ...next,
    activeField: filled(next[other]) ? activeField : other,
    run: filled(next.origin) && filled(next.destination),
  };
}
