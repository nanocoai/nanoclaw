# Street Wind & Shadow Map

Interactive Vite app for exploring projected building shadows and approximate street wind around a city block. The default view starts near Nevsky Prospect in Saint Petersburg.

## Run locally

```bash
npm install
npm run dev
```

Then open the local Vite URL printed in the terminal. Useful checks:

```bash
npm test
npm run build
```

## Data sources

- Basemap tiles, building footprints, road geometries, and most building height tags come from [OpenStreetMap](https://www.openstreetmap.org/).
- Buildings and roads are fetched live from the [Overpass API](https://overpass-api.de/).
- Current 10 m wind speed and wind direction are fetched live from [Open-Meteo](https://open-meteo.com/).
- Place search uses [Nominatim](https://nominatim.org/). Coordinate input also accepts `lat, lng`.

The app keeps fetched OSM responses in memory by nearby area while the tab stays open. It queries a deliberately small bounding box around the selected map center.

## What is modeled

### Shadows

Each OSM building footprint gets a height from:

1. `height` or `building:height`;
2. `building:levels * 3 m`;
3. a 12 m default.

Sun position comes from SunCalc for the selected date, time, and map center. Direct shadow length uses:

```text
shadowLength = buildingHeight / tan(sunAltitude)
```

When the sun is below the horizon the app reports that direct shadows are unavailable.

### Street wind

The wind layer is intentionally approximate. A road is split into small segments. Each segment gets:

- its Turf bearing;
- the current Open-Meteo wind vector projected onto that street alignment;
- a canyon boost when tall nearby buildings appear on both sides;
- a shelter reduction when a tall nearby building sits upwind.

The road tooltip exposes the estimated speed, base weather wind, road bearing, heuristic multiplier, and confidence label. This is not CFD and should not be used for safety decisions.

## Failure behavior

Live APIs are the main path. If Overpass or Open-Meteo fails in development, the UI shows a clear error and temporarily swaps in a tiny local fallback dataset so geometry work remains inspectable offline. Production mode does not silently replace live API data.

## Project layout

- `src/api/overpass.ts` - live OSM building and road fetch, height parsing, cache.
- `src/api/weather.ts` - Open-Meteo current wind fetch.
- `src/api/geocoding.ts` - coordinate parsing and Nominatim search.
- `src/utils/geometry.ts` - bbox, bearing, distance, and segment helpers.
- `src/utils/shadows.ts` - SunCalc conversion and projected shadow polygons.
- `src/utils/wind.ts` - road wind projection and urban-canyon heuristics.
- `src/components/MapView.tsx` - Leaflet layers and tooltips.
- `src/components/ControlsPanel.tsx` - location, time, toggles, and wind readout.
- `src/components/Legend.tsx` - wind and shadow legends.

## Future improvements

- Read OSM multipolygon building relations and richer height formats.
- Use building facade distance and road width tags where available.
- Add wind direction variability, gusts, and terrain or water exposure.
- Move heavy geometry work into a worker for larger areas.
- Replace the convex projected shadow hull with a more exact footprint sweep.
