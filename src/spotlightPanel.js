// src/spotlightPanel.js
/**
 * Which panel the search bar shows under its field, if any.
 *
 * THE BUG THIS FIXES. Once a place was picked, its card - name, weather, RUTE KE
 * SINI - sat under the field, and a mounted panel hides the results list. So
 * typing a NEW search ran it (the dots on the map even updated) but showed no
 * list at all: the old place's card just stayed there. From the chair that
 * reads as "the search can't find anything", and the only way out was HAPUS
 * PENANDA, which nothing on screen suggested.
 *
 * A picked place's card is the ANSWER to the last search. Typing a new one is a
 * new question, so the list for it takes the space. The card is not forgotten:
 * clear the field and it comes back, and picking a new result replaces it.
 *
 * The route bar and an identifier lookup are not answers to be superseded, so
 * they keep their place:
 *   - a route in progress is a task, and typing while it is open is how a place
 *     is found for one of its ends (the dots on the map fill DARI or KE);
 *   - an identifier lookup IS the result of what is being typed.
 *
 * Pure, so the rule is tested without React.
 *
 * @module spotlightPanel
 */

/**
 * @param {object} state
 * @param {boolean} [state.routeOpen] Directions are open.
 * @param {boolean} [state.hasLookup] The field reads as a phone number or plate.
 * @param {boolean} [state.hasChosen] A place has been picked.
 * @param {string} [state.query] What is in the search field right now.
 * @returns {'route'|'lookup'|'chosen'|null}
 */
export function spotlightPanel({ routeOpen, hasLookup, hasChosen, query } = {}) {
  if (routeOpen) return 'route';
  if (hasLookup) return 'lookup';
  const typing = String(query ?? '').trim().length > 0;
  if (hasChosen && !typing) return 'chosen';
  return null;
}
