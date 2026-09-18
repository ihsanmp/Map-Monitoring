// Unit tests for which panel sits under the search field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spotlightPanel } from './spotlightPanel.js';

test('a picked place shows its card while the field is empty', () => {
  assert.equal(spotlightPanel({ hasChosen: true, query: '' }), 'chosen');
});

test('typing a new search gives the space to its results, not the old card', () => {
  // THE REGRESSION. The old card stayed and hid the list, so a second search
  // looked like it had found nothing.
  assert.equal(spotlightPanel({ hasChosen: true, query: 'uii' }), null);
});

test('clearing the field brings the picked place back', () => {
  assert.equal(spotlightPanel({ hasChosen: true, query: '' }), 'chosen');
  assert.equal(spotlightPanel({ hasChosen: true, query: '   ' }), 'chosen', 'whitespace is not a query');
});

test('a route in progress keeps its place while typing', () => {
  // Typing during a route is how a place is found for one of its ends.
  assert.equal(spotlightPanel({ routeOpen: true, hasChosen: true, query: 'uii' }), 'route');
});

test('an identifier lookup is the result of what is typed, so it shows', () => {
  assert.equal(spotlightPanel({ hasLookup: true, query: '081234567890' }), 'lookup');
  assert.equal(spotlightPanel({ hasLookup: true, hasChosen: true, query: 'AB 1234 CD' }), 'lookup');
});

test('with nothing picked there is no panel', () => {
  assert.equal(spotlightPanel({ query: '' }), null);
  assert.equal(spotlightPanel({ query: 'kafe' }), null);
  assert.equal(spotlightPanel(), null);
});
