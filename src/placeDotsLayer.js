// src/placeDotsLayer.js
/**
 * The globe side of search-result dots: draw them, and hear a click on one.
 *
 * All the decisions - which rows become dots, what a click means - are in
 * placeDots.js where they can be tested. This file only puts entities in the
 * scene and turns a pick back into a row index.
 *
 * COST. At most PLACE_DOT_LIMIT points with labels, static, no per-frame work.
 * The scene is asked for ONE render when they change, and nothing else. There is
 * deliberately no hover cursor: that would mean a scene.pick() - an extra render
 * pass - on every mouse move, on a machine that already struggles with the globe.
 *
 * CLICKS. Registered in the shared pick registry, so the flights, CCTV and
 * vessel layers leave a click on a dot alone. And it defers the same way:
 * while the drawing tools are armed they claim every click, and a dot under a
 * measurement vertex must not open a place card.
 *
 * @module placeDotsLayer
 */
import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './data/pickRegistry.js';
import { governorRequestRender } from './renderGovernor.js';
import { PLACE_DOT_ID_PREFIX, placeDotId, placeDotSpecs, placeIndexFromId } from './placeDots.js';

const PICK_OWNER_ID = 'search-places';

/** Google-maps red with a white ring: reads on the light street basemap and on satellite. */
const DOT_COLOR = Cesium.Color.fromCssColorString('#ea4335');
const RING_COLOR = Cesium.Color.WHITE;
const LABEL_FILL = Cesium.Color.fromCssColorString('#202124');

/**
 * Labels only when close enough to read them.
 *
 * Thirty names at city zoom is a smear, not a list. Past this range the dots
 * alone say "there are cafes here", and zooming in brings the names.
 */
const LABEL_MAX_RANGE_M = 9000;

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} options
 * @param {(index:number) => void} options.onPick Called with the row index of a clicked dot.
 * @returns {{show:(rows:Array)=>number, clear:()=>void, count:()=>number, destroy:()=>void}}
 */
export function createPlaceDots(viewer, { onPick }) {
  if (!viewer?.scene) {
    return { show: () => 0, clear() {}, count: () => 0, destroy() {} };
  }

  const source = new Cesium.CustomDataSource(PICK_OWNER_ID);
  viewer.dataSources.add(source);
  registerPickOwner(PICK_OWNER_ID, (pickedId) => String(pickedId).startsWith(PLACE_DOT_ID_PREFIX));

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    // Nothing to hit: do not pay for a pick pass.
    if (!source.entities.values.length) return;
    const pickedId = resolvePickId(viewer.scene.pick(click.position));
    const index = placeIndexFromId(pickedId);
    if (index === null) return;
    // The drawing tools claim every click while armed.
    if (isOwnedByOtherLayer(PICK_OWNER_ID, pickedId)) return;
    onPick?.(index);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const clear = () => {
    if (!source.entities.values.length) return;
    source.entities.removeAll();
    governorRequestRender('search-places');
  };

  return {
    /**
     * Replace the dots with these rows. Returns how many were drawn.
     * An empty answer clears: dots from the last query describe somewhere else.
     */
    show(rows) {
      const specs = placeDotSpecs(rows);
      source.entities.suspendEvents();
      source.entities.removeAll();
      for (const spec of specs) {
        source.entities.add({
          id: placeDotId(spec.index),
          position: Cesium.Cartesian3.fromDegrees(spec.lon, spec.lat),
          point: {
            pixelSize: 12,
            color: DOT_COLOR,
            outlineColor: RING_COLOR,
            outlineWidth: 2,
            // On top of 3D buildings and terrain: a dot you cannot see cannot
            // be clicked.
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: spec.label,
            font: '600 12px Inter, "Segoe UI", sans-serif',
            fillColor: LABEL_FILL,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, LABEL_MAX_RANGE_M),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
      source.entities.resumeEvents();
      governorRequestRender('search-places');
      return specs.length;
    },
    clear,
    count: () => source.entities.values.length,
    destroy() {
      handler.destroy();
      unregisterPickOwner(PICK_OWNER_ID);
      if (!viewer.isDestroyed?.()) viewer.dataSources.remove(source, true);
    },
  };
}
