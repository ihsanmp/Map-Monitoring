import { createRoot, type Root } from 'react-dom/client';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import {
  Building2,
  Coffee,
  Fuel,
  Landmark,
  MapPin,
  Mountain,
  Plane,
  ShoppingBag,
  ShoppingCart,
  Train,
  Trees,
  UtensilsCrossed
} from 'lucide-react';
import { AppleSpotlight } from '@/components/ui/apple-spotlight';
import { lookupIdentifier, type LookupResult } from '@/lib/idLookup';
import { summarizeWeather } from '@/weatherWords.js';
import { placeRouteSummary } from '@/routeSummaryPlacement.js';
import { applyPickedPlace } from '@/placeDots.js';
import { createPlaceDots } from '@/placeDotsLayer.js';
import '@/tailwind.css';

/**
 * Bridge between the vanilla app and the React spotlight.
 *
 * The spotlight IS the search bar - it replaced the old LOCATION tray rather
 * than opening over it, so it renders permanently. The component's own markup
 * is a centred full-screen overlay; CSS in tailwind.css moves it to the top and
 * makes its backdrop click-through, so the globe underneath stays draggable.
 *
 * The results are live places from /api/geocode, biased to the viewport. The
 * four shortcut buttons keep the component's own defaults.
 */

interface GeocodeRow {
  lat: number;
  lon: number;
  label: string;
  osmType?: string;
}

/**
 * The four buttons under the bar: the things you look for while moving.
 *
 * Each is a word the geocoder already understands as a CATEGORY rather than a
 * name - /api/geocode routes those to Overpass and ranks the answers by
 * distance from the centre of the map on screen, because "kafe" is a question
 * about what is around you, not a place called Kafe.
 *
 * "tempat makan" is deliberately the broad one: it resolves to restaurant,
 * fast_food AND food_court, which is what covers everything from a warung to a
 * proper restaurant. Asking for "restoran" alone would resolve to
 * amenity=restaurant and quietly drop the simpler places.
 */
const CATEGORY_SHORTCUTS = [
  { label: 'Tempat makan', query: 'tempat makan', icon: <UtensilsCrossed /> },
  { label: 'SPBU', query: 'spbu', icon: <Fuel /> },
  { label: 'Kafe', query: 'kafe', icon: <Coffee /> },
  { label: 'Supermarket', query: 'supermarket', icon: <ShoppingCart /> }
];

/** Category icon from the OSM type, defaulting to a map pin. */
function iconFor(osmType: string | undefined) {
  const type = String(osmType || '').toLowerCase();
  if (/station|halt|railway/.test(type)) return <Train />;
  if (/aerodrome|airport/.test(type)) return <Plane />;
  if (/mall|shop|supermarket|retail|marketplace/.test(type)) return <ShoppingBag />;
  if (/restaurant|cafe|fast_food|food/.test(type)) return <UtensilsCrossed />;
  if (/peak|volcano|ridge|mountain/.test(type)) return <Mountain />;
  if (/park|forest|nature/.test(type)) return <Trees />;
  if (/museum|monument|memorial|historic|attraction/.test(type)) return <Landmark />;
  if (/city|town|village|municipality|suburb|county|state/.test(type)) return <Building2 />;
  return <MapPin />;
}

/** The viewport box the geocoder ranks against, in the app's own bias format. */
function viewportBias(viewer: any): string | null {
  try {
    const rect = viewer?.camera?.computeViewRectangle?.();
    if (!rect) return null;
    const parts = [
      Cesium.Math.toDegrees(rect.south).toFixed(4),
      Cesium.Math.toDegrees(rect.west).toFixed(4),
      Cesium.Math.toDegrees(rect.north).toFixed(4),
      Cesium.Math.toDegrees(rect.east).toFixed(4)
    ];
    if (parts.some((value) => value === 'NaN')) return null;
    /*
     * A rectangle that covers the planet is not a bias.
     *
     * From high enough up - and the console now opens at 4,200 km -
     * computeViewRectangle returns the whole globe, -90,-180 to 90,180. Sending
     * that tells the server a viewport exists when none usefully does. Better
     * to send nothing and let it answer as an unbiased search.
     */
    const span = Math.abs(rect.east - rect.west) + Math.abs(rect.north - rect.south);
    if (span > Cesium.Math.toRadians(300)) return null;
    return `${parts[0]},${parts[1]}|${parts[2]},${parts[3]}`;
  } catch {
    return null;
  }
}

/** Read a route panel control, which is the one implementation of routing. */
function panelEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * Put a value AND its picked coordinates onto one of the panel's fields.
 *
 * Deliberately silent - no `input` event. The panel listens for that to mean a
 * person is typing, and its handler both DELETES the picked coordinates (the
 * text no longer describes them) and opens its own suggestion dropdown. Firing
 * it here would throw away the exact point this bar just resolved, quietly
 * downgrading a precise destination back to a name lookup, and pop a stray
 * list open in a panel nobody is looking at.
 */
function fillPanelField(id: string, text: string, point?: { lat: number; lon: number } | null) {
  const input = panelEl<HTMLInputElement>(id);
  if (!input) return;
  input.value = text;
  if (point) {
    input.dataset.pickedLat = String(point.lat);
    input.dataset.pickedLon = String(point.lon);
  } else {
    delete input.dataset.pickedLat;
    delete input.dataset.pickedLon;
  }
}

/**
 * The weather where the pin is.
 *
 * The Route panel has answered this for a DESTINATION for a while; the same
 * reading is useful the moment a place is picked, before anyone decides to go
 * there. Same endpoint, same words — describeWeatherCode lives in
 * weatherWords.js precisely so these two cannot drift into saying "Hujan" and
 * "Rain" about the same sky.
 *
 * It renders nothing at all until there is a real reading. A card that says
 * "memuat…" and then "tidak tersedia" is worse than one that never appeared:
 * this sits beside the place name, and an empty row there reads as a fault in
 * the search rather than a quiet forecast service.
 */
function PlaceWeather({ lat, lon }: { lat: number; lon: number }) {
  const [summary, setSummary] = useState<{ headline: string; detail: string } | null>(null);

  useEffect(() => {
    // A new place must never be labelled with the last one's weather, so the
    // reading is dropped the instant the coordinates change.
    setSummary(null);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
    const abort = new AbortController();
    (async () => {
      try {
        const response = await fetch(
          `/api/weather-effects?latitude=${lat}&longitude=${lon}`,
          { signal: abort.signal }
        );
        if (!response.ok) return;
        const payload = await response.json();
        if (abort.signal.aborted) return;
        setSummary(summarizeWeather(payload?.weather));
      } catch {
        // Offline, rate-limited, or superseded: the row simply stays away.
      }
    })();
    return () => abort.abort();
  }, [lat, lon]);

  if (!summary) return null;
  return (
    <span className="mm-chosen-weather">
      <span className="mm-chosen-weather-now">{summary.headline}</span>
      {summary.detail ? <span className="mm-chosen-weather-detail">{summary.detail}</span> : null}
    </span>
  );
}

/**
 * What a container is actually COVERING, not what it has reserved.
 *
 * The right context rail keeps a 330 px column whether or not anything in it is
 * open. Measuring the container would therefore charge the route report for a
 * CCTV panel that is a collapsed chip against the right edge. So the bounds are
 * taken from the children that are actually drawn: collapsed chips give a
 * narrow box hugging the edge, an open panel gives a wide one.
 *
 * Returns null for an empty or absent container - nothing there to avoid.
 */
function occupiedBounds(container: HTMLElement | null) {
  if (!container) return null;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  for (const child of Array.from(container.children)) {
    const box = child.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    top = Math.min(top, box.top);
  }
  return Number.isFinite(left) ? { left, right, top } : null;
}

interface RouteBarProps {
  destination: GeocodeRow | null;
  onClose: () => void;
  /**
   * Where the host sends a place the operator clicked on the map while this is
   * open. The bar installs its handler here and takes it away on close, so a
   * click with no route being planned goes back to meaning "show me this place".
   */
  pickRef: React.MutableRefObject<((row: GeocodeRow) => void) | null>;
  /** Search dots are on the map, so clicking one is worth suggesting. */
  hasDots: boolean;
}

/**
 * Directions, inside the search bar.
 *
 * This does not route anything itself. Routing lives in the Route panel -
 * origin precedence, the GPS fix and its expiry, cancellation by generation,
 * the road-mix report, the destination cards - and a second copy of that would
 * drift from the first within a week. So the bar fills the panel's own fields
 * and presses its own button, exactly as an operator would.
 *
 * The panel's status line and result block are MOVED here while directions are
 * open, rather than copied. A copy would leave the "BUKA KAMERA" button without
 * its listener; moving a node keeps everything attached to it, and the nodes go
 * home when this closes.
 */
function RouteBar({ destination, onClose, pickRef, hasDots }: RouteBarProps) {
  const [origin, setOrigin] = useState('');
  const [dest, setDest] = useState(destination ? destination.label.split(',')[0].trim() : '');
  const originPointRef = useRef<{ lat: number; lon: number } | null>(null);
  const destPointRef = useRef<{ lat: number; lon: number } | null>(
    destination ? { lat: destination.lat, lon: destination.lon } : null
  );
  /*
   * Which end a clicked place fills. Opened from RUTE KE SINI the destination
   * is already known, so the next click is the start; opened empty, it is the
   * destination - the thing a person usually has in mind first.
   */
  const [activeField, setActiveField] = useState<'origin' | 'destination'>(
    destination ? 'origin' : 'destination'
  );
  const hostRef = useRef<HTMLDivElement>(null);

  /* Borrow the panel's live status and result nodes for as long as this is up. */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // If the full panel is already open, it owns these nodes and is showing
    // them. Collapse it before borrowing, so the bar does not strip a visible
    // panel bare - one routing surface at a time, decided at takeover.
    const routePanel = document.getElementById('route-panel');
    if (routePanel && !routePanel.classList.contains('collapsed')) {
      (window as any).__mapMonitoring?.styleManager?.setPanelCollapsed?.('route-panel', true, { explicit: true });
    }

    const moved: Array<{ node: HTMLElement; parent: Node; next: Node | null }> = [];
    const borrow = (id: string, into: HTMLElement) => {
      const node = panelEl<HTMLElement>(id);
      if (!node?.parentNode) return null;
      moved.push({ node, parent: node.parentNode, next: node.nextSibling });
      into.appendChild(node);
      return node;
    };

    /*
     * The status line stays with the form that produced it. It is one short
     * grey sentence - "Rute digambar di peta.", or the hint to fill in a
     * destination - and a hint about a field belongs beside the field.
     */
    borrow('route-status', host);

    /*
     * The REPORT goes onto the map.
     *
     * Distance, traffic, the nearest camera and the destination weather made
     * the pill tall enough to cover the left half of the window, so reading the
     * answer meant covering the route it described. It now sits in the strip of
     * map between the bar and the clock - when the window has one. On a window
     * too narrow for that strip it stays in the bar, because a card squeezed
     * into 90 px is not a smaller report, it is an unreadable one.
     */
    const card = document.createElement('div');
    card.className = 'mm-route-summary';
    card.hidden = true;
    document.body.appendChild(card);
    const result = borrow('route-result', card);

    const pill = host.closest('.mm-spotlight-pill');
    const place = () => {
      // An empty report is not a report. Before a route is found the node is
      // blank, and a blank card floating over the map is just a smudge.
      if (!result || !result.textContent?.trim()) {
        card.hidden = true;
        return;
      }
      const box = placeRouteSummary({
        bar: pill?.getBoundingClientRect(),
        // Everything else that lives in the top band. The rail is the one that
        // usually binds: an open CCTV panel reaches further left than the clock.
        obstacles: [
          document.getElementById('map-clock-root')?.getBoundingClientRect(),
          occupiedBounds(document.getElementById('right-context-rail')),
        ],
        viewport: { width: window.innerWidth },
      });
      if (!box) {
        // No strip: the report goes back under the form, where it used to live.
        card.hidden = true;
        if (result.parentNode !== host) host.appendChild(result);
        return;
      }
      if (result.parentNode !== card) card.appendChild(result);
      card.hidden = false;
      card.style.left = `${box.left}px`;
      card.style.top = `${box.top}px`;
      card.style.width = `${box.width}px`;
    };

    // The report is written by the routing code, not by this component, so the
    // only way to know it has arrived is to watch the node.
    const resultWatch = result
      ? new MutationObserver(place)
      : null;
    resultWatch?.observe(result as Node, { childList: true, subtree: true, characterData: true });

    /*
     * The rail moves under the card. "BUKA KAMERA" in the report itself opens
     * the CCTV panel, which widens the rail from a chip to a full panel - so
     * the one button on this card is the very thing most likely to reach the
     * space the card is standing in.
     */
    const rail = document.getElementById('right-context-rail');
    const railWatch = rail ? new MutationObserver(place) : null;
    railWatch?.observe(rail as Node, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });

    /*
     * The BAR moves under the card too, and this one bites without a resize.
     *
     * Taking the report out makes the pill short; putting it back makes it
     * tall; a lookup card or a chosen place changes it again. Placing only on
     * window resize left the card pinned to wherever the bar happened to be
     * when the route arrived - measured 120 px too low, and nothing would have
     * corrected it until the window itself was dragged.
     */
    const barWatch = pill && typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => place())
      : null;
    if (pill) barWatch?.observe(pill);

    window.addEventListener('resize', place);
    place();

    /*
     * The status and result nodes are ONE set, shared with the full Route
     * panel. If that panel is opened while the bar holds them - from the fluid
     * menu's "Buka panel penuh", the other door to the same routing - the panel
     * would render without a status line or a result, because both are sitting
     * in the bar. Two surfaces cannot show one node.
     *
     * So the bar yields when the panel opens: closing returns the nodes to the
     * panel (the cleanup below), and the panel, which reads them live, fills
     * in. The bar and the full panel are two ways to do the same thing; only
     * one holds the nodes at a time.
     */
    const observer = routePanel
      ? new MutationObserver(() => {
        if (!routePanel.classList.contains('collapsed')) onClose();
      })
      : null;
    observer?.observe(routePanel as Element, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer?.disconnect();
      resultWatch?.disconnect();
      railWatch?.disconnect();
      barWatch?.disconnect();
      window.removeEventListener('resize', place);
      // The nodes go home first, then the card is removed - taking the card out
      // while it still held the report would delete the panel's own node.
      for (const { node, parent, next } of moved) parent.insertBefore(node, next);
      card.remove();
    };
  }, [onClose]);

  const swap = () => {
    const heldOrigin = originPointRef.current;
    originPointRef.current = destPointRef.current;
    destPointRef.current = heldOrigin;
    setOrigin(dest);
    setDest(origin);
    setActiveField((field) => (field === 'origin' ? 'destination' : 'origin'));
  };

  /*
   * Run with explicit values rather than reading state.
   *
   * A clicked place sets the field AND runs in the same moment, and React state
   * set in that moment is not readable until the next render - reading it here
   * would route from the previous start to the previous destination.
   */
  const runWith = (
    originText: string,
    originPoint: { lat: number; lon: number } | null,
    destText: string,
    destPoint: { lat: number; lon: number } | null,
  ) => {
    fillPanelField('route-origin', originText, originPoint);
    fillPanelField('route-dest', destText, destPoint);
    // No mode to forward any more: the panel holds 'car' and nothing changes it.
    panelEl<HTMLButtonElement>('route-search-btn')?.click();
  };
  const run = () => runWith(origin, originPointRef.current, dest, destPointRef.current);

  /* The latest of everything a map click needs, without re-installing the handler per keystroke. */
  const latestRef = useRef({ origin, dest, activeField });
  latestRef.current = { origin, dest, activeField };

  useEffect(() => {
    pickRef.current = (row: GeocodeRow) => {
      const now = latestRef.current;
      const next = applyPickedPlace({
        activeField: now.activeField,
        origin: { text: now.origin, point: originPointRef.current },
        destination: { text: now.dest, point: destPointRef.current },
      }, row);
      originPointRef.current = next.origin.point;
      destPointRef.current = next.destination.point;
      setOrigin(next.origin.text);
      setDest(next.destination.text);
      setActiveField(next.activeField);
      // Both ends known: the travel time is the answer, so go and get it.
      if (next.run) {
        runWith(next.origin.text, next.origin.point, next.destination.text, next.destination.point);
      }
    };
    return () => { pickRef.current = null; };
  }, [pickRef]);

  return (
    <div className="mm-routebar">
      <div className="mm-routebar-row">
        <span className="mm-routebar-tag">DARI</span>
        <input
          value={origin}
          placeholder="Titik awal, atau pakai GPS"
          data-active={activeField === 'origin'}
          onFocus={() => setActiveField('origin')}
          onChange={(event) => { originPointRef.current = null; setOrigin(event.target.value); }}
          onKeyDown={(event) => { if (event.key === 'Enter') run(); }}
        />
        <button
          type="button"
          title="Pakai lokasi saya"
          onClick={() => {
            panelEl<HTMLButtonElement>('route-gps-btn')?.click();
            // The panel writes its own label into its field once the fix lands.
            window.setTimeout(() => {
              const value = panelEl<HTMLInputElement>('route-origin')?.value || '';
              if (value) { originPointRef.current = null; setOrigin(value); }
            }, 1200);
          }}
        >
          GPS
        </button>
        <button type="button" title="Tukar asal dan tujuan" onClick={swap}>&#8645;</button>
      </div>

      <div className="mm-routebar-row">
        <span className="mm-routebar-tag">KE</span>
        <input
          value={dest}
          placeholder="Tujuan"
          data-active={activeField === 'destination'}
          onFocus={() => setActiveField('destination')}
          onChange={(event) => { destPointRef.current = null; setDest(event.target.value); }}
          onKeyDown={(event) => { if (event.key === 'Enter') run(); }}
        />
      </div>

      {/*
        Say what a click on the map will do, and to which box. The highlighted
        field is the same one this names, so the two can never disagree.
      */}
      <div className="mm-routebar-hint">
        {hasDots
          ? `Klik titik merah di peta untuk mengisi ${activeField === 'origin' ? 'DARI' : 'KE'}.`
          : `Cari tempat di kolom Search, lalu klik titiknya di peta untuk mengisi ${activeField === 'origin' ? 'DARI' : 'KE'}.`}
      </div>

      {/*
        MOBIL / SEPEDA / JALAN were here. This console routes for cars and only
        cars, so offering three choices and defaulting to one of them was three
        buttons of noise in a five-button row.
      */}
      <div className="mm-routebar-row mm-routebar-actions">
        <button type="button" className="mm-routebar-go" onClick={run}>CARI RUTE</button>
        <button type="button" onClick={onClose}>TUTUP</button>
      </div>

      <div className="mm-routebar-output" ref={hostRef} />
    </div>
  );
}

/**
 * The card a phone or plate lookup shows in the bar.
 *
 * A flat list of label/value rows with a note stating plainly what is NOT here
 * - the tracking and the owner identity that were asked for and are not
 * lawful to provide. Same slot the route bar uses, so it displaces the place
 * results rather than sitting beside them.
 */
function LookupCard({ result, onClose }: { result: LookupResult; onClose: () => void }) {
  return (
    <div className="mm-lookup">
      <div className="mm-lookup-head">
        <div>
          <div className="mm-lookup-title">{result.title}</div>
          <div className="mm-lookup-subtitle">{result.subtitle}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Tutup">TUTUP</button>
      </div>
      <dl className="mm-lookup-rows">
        {result.rows.map((row) => (
          <div className="mm-lookup-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {result.note ? <div className="mm-lookup-note">{result.note}</div> : null}
    </div>
  );
}

function SpotlightHost() {
  /*
   * Starts as an empty list, never undefined.
   *
   * AppleSpotlight reads `results ?? sampleResults`, so leaving it undefined
   * hands the bar back to the component's own demo rows - Twitter, Safari,
   * Mail. That is what "kafe" showed: not a failed search, a search still in
   * flight, with the demo list standing in for it. A category lookup goes to
   * Overpass and takes tens of seconds, so that window was long enough to look
   * like the answer.
   */
  const [results, setResults] = useState<any[]>([]);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  /** The one search pin currently on the globe, so it can be taken back. */
  const searchMarkRef = useRef<string | null>(null);
  /** The place last chosen from the list - what "route to here" means. */
  const [chosen, setChosen] = useState<GeocodeRow | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);
  /** A phone/plate lookup, shown in place of place results when one matches. */
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const rowsRef = useRef<GeocodeRow[]>([]);
  const debounceRef = useRef<number | undefined>(undefined);
  /** The query the debounce is holding, so Enter can run it without waiting. */
  const pendingQueryRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);

  /*
   * Search results as clickable dots on the map.
   *
   * The dots belong to the last search that ANSWERED, not to whatever is in the
   * field: the bar clears its own text after a pick, and clearing the dots with
   * it would take away every other place at the exact moment someone wants to
   * compare them. A new answer replaces them; HAPUS PENANDA takes them away.
   */
  const dotsRef = useRef<ReturnType<typeof createPlaceDots> | null>(null);
  const dotRowsRef = useRef<GeocodeRow[]>([]);
  const [dotCount, setDotCount] = useState(0);
  /** Installed by the route bar while it is open: a clicked place fills a field instead. */
  const routePickRef = useRef<((row: GeocodeRow) => void) | null>(null);
  /** What a click on a dot does when no route is being planned. Set below, read at click time. */
  const chooseRowRef = useRef<(row: GeocodeRow) => void>(() => {});

  const placeRow = useCallback((row: GeocodeRow | undefined) => {
    if (!row) return;
    if (routePickRef.current) routePickRef.current(row);
    else chooseRowRef.current(row);
  }, []);

  const showDots = useCallback((rows: GeocodeRow[]) => {
    const viewer = (window as any).__mapMonitoring?.viewer;
    if (!dotsRef.current && viewer && rows.length) {
      dotsRef.current = createPlaceDots(viewer, {
        onPick: (index) => placeRow(dotRowsRef.current[index]),
      });
    }
    dotRowsRef.current = rows;
    setDotCount(dotsRef.current ? dotsRef.current.show(rows) : 0);
  }, [placeRow]);

  const search = useCallback(async (text: string) => {
    const viewer = (window as any).__mapMonitoring?.viewer;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const bias = viewportBias(viewer);
    try {
      const response = await fetch(
        `/api/geocode?q=${encodeURIComponent(text)}${bias ? `&bias=${encodeURIComponent(bias)}` : ''}`,
        { signal: abortRef.current.signal }
      );
      if (!response.ok) {
        setResults([]);
        showDots([]);
        setEmptyMessage('Pencarian tidak tersedia.');
        return;
      }
      const data = await response.json();
      const rows: GeocodeRow[] = (data?.results || []).filter(
        (row: GeocodeRow) => Number.isFinite(row.lat) && Number.isFinite(row.lon)
      );
      rowsRef.current = rows;
      showDots(rows);
      setResults(
        rows.slice(0, 8).map((row) => {
          const parts = String(row.label || '').split(',').map((part) => part.trim());
          return {
            icon: iconFor(row.osmType),
            label: parts[0] || text,
            // Enough address to tell same-named places apart, which is the
            // whole reason a list is shown rather than one answer.
            description: parts.slice(1, 4).join(', '),
            link: '#'
          };
        })
      );
      // An honest empty beats a stale list: the geocoder answered, and the
      // answer was nothing. WHY it was nothing is the part worth passing on -
      // "zoom in" and "nothing of that kind nearby" ask for different things
      // from the operator, and "the search is down" asks for neither.
      const REASONS: Record<string, string> = {
        'category-needs-view': 'Perbesar peta dulu - pencarian kategori mencari di sekitar area yang tampil.',
        'category-empty-nearby': 'Tidak ada yang seperti itu di sekitar area ini.',
        'category-search-unavailable': 'Pencarian kategori sedang tidak bisa dijangkau. Coba lagi sebentar lagi.',
      };
      setEmptyMessage(
        rows.length
          ? null
          : (REASONS[String(data?.reason || '')] || 'Tidak ada tempat yang cocok.'),
      );
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      setResults([]);
      showDots([]);
      setEmptyMessage('Pencarian gagal. Periksa koneksi.');
    }
  }, [showDots]);

  const onSearchChange = useCallback(
    (value: string) => {
      const text = value.trim();
      pendingQueryRef.current = text;
      window.clearTimeout(debounceRef.current);

      /*
       * A phone number or a plate is answered from local tables, not the map.
       *
       * Checked before anything is sent anywhere: these are offline lookups, so
       * the moment the text reads as one there is no reason to geocode it, and
       * every reason not to hand "0812..." to a place search that would list
       * streets whose numbers happen to match. The card displaces the results
       * list the same way directions do.
       */
      const identified = lookupIdentifier(text);
      if (identified) {
        abortRef.current?.abort();
        rowsRef.current = [];
        setResults([]);
        setEmptyMessage(null);
        setLookup(identified);
        return;
      }
      setLookup(null);

      if (text.length < 3) {
        abortRef.current?.abort();
        rowsRef.current = [];
        setResults([]);
        setEmptyMessage(text ? 'Ketik minimal 3 huruf.' : null);
        return;
      }
      /*
       * Retire the previous answer the moment the question changes.
       *
       * Rows left on screen under a new query describe somewhere else, and the
       * bar has no way to say so. Clearing them also lets the searching message
       * through: the component only shows it when the list is empty.
       *
       * A category word ("kafe", "spbu", "supermarket", "tempat makan") is
       * answered by Overpass, which was measured at 13-33 s from this network,
       * so this message is on screen long enough to need to say what is
       * happening rather than just spin.
       */
      rowsRef.current = [];
      setResults([]);
      setEmptyMessage('Mencari di sekitar peta...');
      // /api/geocode is fronted by Nominatim, whose usage policy caps this near
      // one call a second, so a request per keystroke would queue behind itself.
      debounceRef.current = window.setTimeout(() => {
        pendingQueryRef.current = '';
        void search(text);
      }, 400);
    },
    [search]
  );

  /**
   * Drop a pin on the chosen place.
   *
   * Flying the camera alone leaves the operator to work out which of the
   * things now on screen was the answer. The mark says which one, and it
   * stays put while the camera is moved around it.
   *
   * Only ever ONE search pin: the previous is taken back first, so a run of
   * searches does not litter the globe with every place that was passed
   * through on the way to the one that mattered.
   */
  const markSearchResult = useCallback(async (row: GeocodeRow) => {
    const api = (window as any).__mapMonitoring?.annotations;
    if (!api?.annotate) return;
    const previous = searchMarkRef.current;
    searchMarkRef.current = null;
    if (previous && api.removeById) api.removeById(previous);
    try {
      const outcome = await api.annotate(
        [{
          type: 'pin',
          label: String(row.label || '').split(',')[0].trim() || 'Hasil pencarian',
          // Red, the colour a map pin is everywhere - and free to use now that
          // the route line has taken blue.
          color: 'red',
          // A point annotation takes its coordinates from the spec itself; the
          // `points` array is for the shapes that have two ends or a path.
          latitude: row.lat,
          longitude: row.lon,
          allowDistant: true
        }],
        { flyTo: false }
      );
      searchMarkRef.current = outcome?.results?.[0]?.id || null;
    } catch {
      // A mark that could not be drawn must not take the camera flight with it.
    }
  }, []);

  /**
   * Make a place the chosen one: pin it and open its card.
   *
   * No camera move. A dot is clicked because it is already on screen, and
   * flying to something the operator is looking at only makes them find it
   * again. Picking from the LIST still flies - that row may be off screen.
   */
  const chooseRow = useCallback((row: GeocodeRow) => {
    void markSearchResult(row);
    setChosen(row);
  }, [markSearchResult]);
  chooseRowRef.current = chooseRow;

  const flyToRow = useCallback((row: GeocodeRow | undefined) => {
    const viewer = (window as any).__mapMonitoring?.viewer;
    if (!row || !viewer) return;
    // Fly to the chosen row's OWN coordinates rather than re-geocoding its
    // text, so the camera lands where the row said it would.
    const wide = /city|town|village|municipality|county|state|region/i.test(row.osmType || '');
    /*
     * Frame the PLACE, not the camera.
     *
     * `flyTo`'s `destination` is where the CAMERA goes, not what it looks at.
     * Putting it at the place's own coordinates and then tilting the camera
     * meant the camera hovered directly ABOVE the place and looked past it:
     * measured at 2,500 m and -60 degrees, the centre of the view landed 1,453
     * metres north of the searched place, which pushed the place itself to the
     * bottom edge of the screen. Searching Plaza Ambarrukmo showed Selokan
     * Mataram, a kilometre and a half up the road, with the pin stranded at the
     * margin — and the pin was never wrong, the aim was.
     *
     * flyToBoundingSphere positions the camera by heading/pitch/RANGE from the
     * target instead, so the place ends up in the middle of the view at any
     * tilt. The range is the old altitude: the eye stays about as far away as
     * it was, it is simply pointed at the right thing now.
     */
    const target = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(target, wide ? 6000 : 250),
      {
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-60),
          wide ? 30000 : 2500
        ),
        duration: 2.4
      }
    );
    chooseRow(row);
  }, [chooseRow]);

  /** Take the pin back and forget the place, leaving the bar as it started. */
  const clearChosen = useCallback(() => {
    const api = (window as any).__mapMonitoring?.annotations;
    const id = searchMarkRef.current;
    searchMarkRef.current = null;
    if (id && api?.removeById) api.removeById(id);
    dotsRef.current?.clear();
    dotRowsRef.current = [];
    setDotCount(0);
    setChosen(null);
    setRouteOpen(false);
  }, []);

  /*
   * Stable, because the route bar's effect depends on it. A fresh arrow per
   * render re-ran that effect on every host render - moving the report out of
   * the panel and back, and rebuilding its card - and a dot click is a host
   * render.
   */
  const closeRoute = useCallback(() => setRouteOpen(false), []);

  const onSelectResult = useCallback(
    (_result: any, index: number) => {
      const row = rowsRef.current[index];
      if (routePickRef.current) routePickRef.current(row);
      else flyToRow(row);
    },
    [flyToRow]
  );

  /**
   * Enter goes to the first result.
   *
   * If the debounce has not fired yet - Enter pressed straight after typing,
   * which is the common case - the search is run immediately rather than
   * dropped, so a fast typist is not silently ignored.
   */
  const onSubmit = useCallback(async () => {
    const pending = pendingQueryRef.current;
    if (pending && pending.length >= 3) {
      window.clearTimeout(debounceRef.current);
      await search(pending);
    }
    const first = rowsRef.current[0];
    // While a route is being planned, Enter fills the active end like a click.
    if (routePickRef.current && first) routePickRef.current(first);
    else flyToRow(first);
  }, [flyToRow, search]);

  useEffect(() => () => {
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    dotsRef.current?.destroy();
    dotsRef.current = null;
  }, []);

  return (
    <AppleSpotlight
      isOpen
      handleClose={() => {}}
      shortcuts={CATEGORY_SHORTCUTS}
      results={results}
      onSearchChange={onSearchChange}
      onSelectResult={onSelectResult}
      onSubmit={() => { void onSubmit(); }}
      emptyMessage={emptyMessage}
      panel={
        routeOpen ? (
          <RouteBar
            destination={chosen}
            onClose={closeRoute}
            pickRef={routePickRef}
            hasDots={dotCount > 0}
          />
        ) : lookup ? (
          <LookupCard result={lookup} onClose={() => setLookup(null)} />
        ) : chosen ? (
          /*
           * What the reference offers once a place is picked: the place, and
           * the way to it. The description panel it also shows is the one part
           * deliberately left out - this console answers different questions
           * about a destination, and it answers them once a route exists.
           */
          <div className="mm-chosen">
            <span className="mm-chosen-name">{chosen.label.split(',')[0].trim()}</span>
            <PlaceWeather lat={chosen.lat} lon={chosen.lon} />
            <button type="button" className="mm-chosen-go" onClick={() => setRouteOpen(true)}>
              RUTE KE SINI
            </button>
            <button type="button" onClick={clearChosen}>HAPUS PENANDA</button>
          </div>
        ) : null
      }
    />
  );
}

let root: Root | null = null;

/**
 * Mount the spotlight into its own container.
 *
 * Its own node, appended to <body>, so React owns a subtree Cesium and the
 * existing UI never touch - the two rendering models stay strictly separated.
 */
export function mountSpotlight(): void {
  if (root) return;
  const container = document.createElement('div');
  container.id = 'spotlight-root';
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <StrictMode>
      <SpotlightHost />
    </StrictMode>
  );
}
