import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';

export const MAP_STACKS = [
  {
    id: 'photoreal',
    label: 'Google 3D',
    shortLabel: '3D',
    kind: 'photoreal',
    requiresIon: false,
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial',
    shortLabel: 'Aerial',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL,
    requiresIon: true,
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels',
    shortLabel: 'Labels',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    requiresIon: true,
  },
  {
    id: 'osm',
    label: 'OSM',
    shortLabel: 'OSM',
    kind: 'osm',
    requiresIon: false,
  },
  /*
   * A dark street map, beside the others rather than instead of any of them.
   *
   * The map that lets what this console draws on top - CCTV dots, drawn areas,
   * a route line - carry the picture, instead of competing with a bright street
   * map for it.
   *
   * Esri's World Dark Gray canvas: roads light on charcoal, with street names
   * as a separate transparent layer on top. NOT CARTO Dark Matter, which is the
   * obvious choice and was tried first - CARTO now stamps every keyless tile
   * with "API KEY REQUIRED" whatever the referer, which put the words across
   * every street in Yogyakarta.
   */
  {
    id: 'dark',
    label: 'Dark',
    shortLabel: 'DARK',
    kind: 'esri-dark',
    requiresIon: false,
  },
];

const DEFAULT_OSM_CREDIT = '© OpenStreetMap contributors';
const ESRI_DARK_CREDIT = 'Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community';
/** Esri tile services order the path z/y/x, not z/x/y. */
const ESRI_DARK_BASE_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const ESRI_DARK_LABELS_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
/**
 * The deepest zoom with real data.
 *
 * Measured over Yogyakarta: zoom 16 is a real tile; 17, 18 and 19 are one
 * identical grey "Map data not yet available" image. Capping here makes Cesium
 * stretch the zoom-16 tile when the camera is closer, which is a softer street
 * map rather than a grey placard over the city.
 */
const ESRI_DARK_MAX_LEVEL = 16;

// Keyless global ellipsoidal terrain (Re:Earth Terrain / Mapterhorn, CC BY 4.0,
// EGM2008 geoid via NGA) — quantized-mesh 1.0, `ellipsoid` data-type. Fixes
// regime C (keyless globe stacks previously rendered a flat
// EllipsoidTerrainProvider — see the height-datum contract in docs/CURRENT-STATE.md
// §1a). Constructed via `.fromUrl()`, never a hand-built `{z}/{x}/{y}.terrain`
// URL (spec correction, spec §1a).
const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

/**
 * Controls the active globe/map stack. Google Photorealistic 3D Tiles remain
 * the cinematic default, while Cesium ion world imagery and OSM run as globe
 * imagery stacks.
 */
export class MapStackController {
  constructor(viewer, {
    googleTileset = null,
    cesiumToken = '',
    initialStack = 'photoreal',
    onChange = null,
    onError = null,
  } = {}) {
    this.viewer = viewer;
    this.googleTileset = googleTileset;
    this.cesiumToken = String(cesiumToken || '').trim();
    this._onChange = onChange;
    this._onError = onError;
    this._activeId = googleTileset ? initialStack : 'osm';
    this._imageryLayer = null;
    /** A second, transparent layer some stacks draw on top - the dark map's street names. */
    this._overlayLayer = null;
    this._imageryProviders = new Map();
    this._isSwitching = false;
    this._lastError = null;
    // Tracks which terrain PROVIDER is actually installed on the scene, not
    // just an ion-available boolean: 'world' (Cesium World Terrain, ion
    // token), 'keyless' (Re:Earth or its Ellipsoid fallback), or null (never
    // set yet — Cesium's own startup default). Using a tri-state here (rather
    // than the `enabled` boolean `_setWorldTerrainEnabled` receives) matters
    // because both the "never set" and "keyless" states pass `enabled=false`;
    // collapsing them to a boolean would make the first real keyless switch
    // a no-op against the initial `false` default and leave Cesium's built-in
    // provider in place instead of installing Re:Earth terrain.
    this._terrainMode = null;
    // Cache of the constructed keyless Re:Earth CesiumTerrainProvider, so
    // repeat switches into a keyless globe stack don't refetch `layer.json`.
    // Lives independently of `_switchGen` — construction is async and racy
    // switches are guarded where it's awaited (`_setWorldTerrainEnabled`).
    this._reearthTerrainProvider = null;
    // Monotonic switch counter. setStack() awaits network-bound provider
    // creation; a rapid A→B switch where A (e.g. slow Bing) resolves AFTER B
    // (fast OSM) would otherwise revert the user's last choice (M7). Each call
    // captures a generation and aborts its own commit once superseded.
    this._switchGen = 0;

    if (!this.getStack(this._activeId) || !this.isStackAvailable(this._activeId)) {
      this._activeId = googleTileset ? 'photoreal' : 'osm';
    }
  }

  getStacks() {
    return MAP_STACKS.map((stack) => {
      const available = this.isStackAvailable(stack.id);
      return {
        ...stack,
        available,
        // Why this stack can't be picked, from the ONE place that decides it.
        // A stack can be unavailable for reasons other than a missing ion
        // token (photoreal is unavailable when the Google tileset failed to
        // load), so callers must not infer the reason from `available` alone.
        unavailableReason: available ? null : this._unavailableReason(stack),
      };
    });
  }

  /**
   * Human-readable reason a stack can't be activated. Shared by `getStacks()`
   * and `setStack()` so the tooltip and the toast never drift apart.
   * @param {object} stack - Stack descriptor.
   * @returns {string}
   */
  _unavailableReason(stack) {
    return stack?.requiresIon
      ? 'Cesium ion token required for Bing stacks'
      : `${stack?.label || 'This map stack'} is unavailable`;
  }

  getStack(id) {
    return MAP_STACKS.find((stack) => stack.id === id) || null;
  }

  getActiveId() {
    return this._activeId;
  }

  /**
   * Monotonic id of the most recently STARTED switch.
   *
   * A switch is only superseded by another `setStack()` — nothing else moves
   * this number — so a caller that must know whether the globe it is looking
   * at is still the one IT asked for can compare this across its own await.
   * Unchanged (or advanced by exactly its own call) means no newer switch has
   * claimed the globe.
   * @returns {number}
   */
  getSwitchGeneration() {
    return this._switchGen;
  }

  getActiveStack() {
    return this.getStack(this._activeId);
  }

  isStackAvailable(id) {
    const stack = this.getStack(id);
    if (!stack) return false;
    if (stack.kind === 'photoreal') return !!this.googleTileset;
    if (stack.requiresIon) return !!this.cesiumToken;
    return true;
  }

  async setStack(id, { silent = false } = {}) {
    const stack = this.getStack(id) || this.getStack('photoreal');
    if (!stack) return null;

    if (!this.isStackAvailable(stack.id)) {
      const message = this._unavailableReason(stack);
      this._lastError = message;
      this._onError?.(message, stack);
      return this.getState();
    }

    const gen = ++this._switchGen;
    this._isSwitching = true;
    this._lastError = null;
    if (!silent) this._emitChange('switching');

    try {
      if (stack.kind === 'photoreal') {
        await this._activatePhotoreal(gen);
      } else {
        await this._activateGlobeStack(stack, gen);
      }
      // A newer switch started while we were awaiting the provider — that call
      // owns the final state now, so don't commit ours or emit a stale 'ready'.
      if (gen !== this._switchGen) return this.getState();
      this._activeId = stack.id;
      // Show/hide of tilesets + imagery swaps need a frame in idle mode;
      // subsequent tile loads self-request via Cesium. (perf wave 2)
      governorRequestRender('map-stack');
      if (!silent) this._emitChange('ready');
    } catch (error) {
      if (gen !== this._switchGen) return this.getState();
      const message = error?.message || String(error);
      this._lastError = message;
      this._onError?.(message, stack);
      if (this.googleTileset) {
        await this._activatePhotoreal(gen);
        if (gen !== this._switchGen) return this.getState();
        this._activeId = 'photoreal';
      }
      if (!silent) this._emitChange('error');
    } finally {
      // Only the latest switch clears the switching flag; a superseded call
      // must not stomp a newer switch that is still in progress.
      if (gen === this._switchGen) this._isSwitching = false;
    }

    return this.getState();
  }

  getState(status = this._isSwitching ? 'switching' : 'ready') {
    return {
      activeId: this._activeId,
      activeStack: this.getActiveStack(),
      stacks: this.getStacks(),
      status,
      lastError: this._lastError,
      hasCesiumIonToken: !!this.cesiumToken,
    };
  }

  async _activatePhotoreal(gen) {
    this._removeImageryLayer();
    if (this.googleTileset) this.googleTileset.show = true;
    this.viewer.scene.globe.show = false;
    // Terrain is left UNTOUCHED here. The photoreal globe is hidden
    // (`globe.show = false`), so the terrain provider is inert — it renders and
    // streams nothing. Routing this through `_setWorldTerrainEnabled(false)`
    // would make the DEFAULT startup stack await a keyless Re:Earth `layer.json`
    // fetch it can't use, delaying photoreal boot on a slow/blocked network and
    // (on failure) caching the flat `EllipsoidTerrainProvider` fallback for
    // later OSM switches. The Re:Earth fetch is therefore lazy: it happens on
    // the first switch to an actual globe stack (`_activateGlobeStack`).
    // `_terrainMode` is intentionally not changed — every globe-stack transition
    // re-derives the correct provider from it (null/'world'/'keyless'), so
    // leaving it as-is keeps the next switch correct without a photoreal fetch.
    void gen;
  }

  async _activateGlobeStack(stack, gen) {
    const provider = await this._getImageryProvider(stack);
    // A newer switch started while the provider was resolving — don't touch the
    // scene's imagery layers, the winning switch already owns them (M7).
    if (gen != null && gen !== this._switchGen) return;
    this._removeImageryLayer();

    this._imageryLayer = new Cesium.ImageryLayer(provider);
    this.viewer.imageryLayers.add(this._imageryLayer, 0);

    // Directly above the base, so street names sit on the map and below
    // anything a layer drapes over it.
    const overlay = this._getOverlayProvider(stack);
    if (overlay) {
      this._overlayLayer = new Cesium.ImageryLayer(overlay);
      this.viewer.imageryLayers.add(this._overlayLayer, 1);
    }

    if (this.googleTileset) this.googleTileset.show = false;
    this.viewer.scene.globe.show = true;
    await this._setWorldTerrainEnabled(!!this.cesiumToken, gen);
  }

  async _getImageryProvider(stack) {
    if (this._imageryProviders.has(stack.id)) {
      return this._imageryProviders.get(stack.id);
    }

    let provider;
    if (stack.kind === 'ion') {
      provider = await Cesium.createWorldImageryAsync({ style: stack.style });
    } else if (stack.kind === 'osm') {
      provider = new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        credit: DEFAULT_OSM_CREDIT,
      });
    } else if (stack.kind === 'esri-dark') {
      provider = new Cesium.UrlTemplateImageryProvider({
        url: ESRI_DARK_BASE_URL,
        maximumLevel: ESRI_DARK_MAX_LEVEL,
        credit: ESRI_DARK_CREDIT,
      });
    } else {
      throw new Error(`Unsupported map stack: ${stack.id}`);
    }

    this._imageryProviders.set(stack.id, provider);
    return provider;
  }

  /**
   * The transparent layer a stack draws over its base, or null.
   * Cached like the base providers, so switching back and forth refetches nothing.
   * @param {object} stack
   * @returns {Cesium.ImageryProvider|null}
   */
  _getOverlayProvider(stack) {
    if (stack?.kind !== 'esri-dark') return null;
    const key = `${stack.id}:overlay`;
    if (!this._imageryProviders.has(key)) {
      this._imageryProviders.set(key, new Cesium.UrlTemplateImageryProvider({
        url: ESRI_DARK_LABELS_URL,
        maximumLevel: ESRI_DARK_MAX_LEVEL,
        // Same credit as the base; saying it twice in the credit bar is noise.
      }));
    }
    return this._imageryProviders.get(key);
  }

  _removeImageryLayer() {
    // The overlay belongs to whichever stack drew it, so it always goes with the base.
    if (this._overlayLayer) {
      this.viewer.imageryLayers.remove(this._overlayLayer, false);
      this._overlayLayer = null;
    }
    if (!this._imageryLayer) return;
    this.viewer.imageryLayers.remove(this._imageryLayer, false);
    this._imageryLayer = null;
  }

  /**
   * Sets the scene's terrain provider for the current globe stack.
   *
   * `enabled` selects Cesium World Terrain (ion token present — regime B,
   * unchanged). Disabled/keyless (regime C: OSM or any globe stack without an
   * ion token) now tries the keyless Re:Earth ellipsoidal terrain instead of
   * the flat `EllipsoidTerrainProvider`, falling back to the flat provider
   * (today's behavior) if construction fails — no worse than before this fix.
   *
   * `CesiumTerrainProvider.fromUrl()` is async (fetches `layer.json`), so this
   * method is async-safe: `gen` is the caller's switch generation (from
   * `setStack`'s `_switchGen`, threaded through `_activatePhotoreal` /
   * `_activateGlobeStack`, mirroring the M7 pattern in `_activateGlobeStack`
   * for imagery providers). If a newer switch starts while the Re:Earth
   * fetch is in flight, this call's result is discarded instead of
   * clobbering the newer switch's terrain.
   * @param {boolean} enabled
   * @param {number} [gen] — switch generation this call belongs to
   */
  async _setWorldTerrainEnabled(enabled, gen) {
    const targetMode = enabled ? 'world' : 'keyless';
    if (targetMode === this._terrainMode) return;
    if (enabled) {
      this.viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain({
        requestVertexNormals: true,
      }));
    } else {
      const provider = await this._getKeylessTerrainProvider();
      // A newer switch started while the Re:Earth layer.json fetch was in
      // flight — that call owns terrain now; don't stomp it (M7 pattern).
      if (gen != null && gen !== this._switchGen) return;
      this.viewer.terrainProvider = provider;
    }
    this._terrainMode = targetMode;
  }

  /**
   * Resolves (and caches) the keyless terrain provider for globe stacks
   * without an ion token: Re:Earth ellipsoidal quantized-mesh terrain, or
   * `EllipsoidTerrainProvider` (flat — current/prior behavior) if the
   * Re:Earth endpoint can't be constructed. Never throws.
   * @returns {Promise<Cesium.TerrainProvider>}
   */
  async _getKeylessTerrainProvider() {
    if (this._reearthTerrainProvider) return this._reearthTerrainProvider;
    try {
      this._reearthTerrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
    } catch (error) {
      console.warn('[mapStackController] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:', error);
      this._reearthTerrainProvider = new Cesium.EllipsoidTerrainProvider();
    }
    return this._reearthTerrainProvider;
  }

  _emitChange(status) {
    this._onChange?.(this.getState(status));
  }
}
