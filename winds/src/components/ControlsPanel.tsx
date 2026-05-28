import type { FormEvent } from "react";
import { useState } from "react";
import type { LatLng, LayerRenderStats, LayerToggles, OSMData, WeatherData } from "../types";

type ControlsPanelProps = {
  center: LatLng;
  dateTime: string;
  locationLabel: string;
  layers: LayerToggles;
  loadingOSM: boolean;
  loadingWeather: boolean;
  osmData: OSMData;
  renderStats: LayerRenderStats;
  weather: WeatherData | null;
  sunMessage: string;
  dataMessage?: string;
  weatherMessage?: string;
  onDateTimeChange: (value: string) => void;
  onSearch: (query: string) => Promise<void>;
  onUseLocation: () => void;
  onToggle: (layer: keyof LayerToggles) => void;
};

export default function ControlsPanel({
  center,
  dateTime,
  locationLabel,
  layers,
  loadingOSM,
  loadingWeather,
  osmData,
  renderStats,
  weather,
  sunMessage,
  dataMessage,
  weatherMessage,
  onDateTimeChange,
  onSearch,
  onUseLocation,
  onToggle,
}: ControlsPanelProps) {
  const [query, setQuery] = useState("Nevsky Prospect, Saint Petersburg");
  const [searchState, setSearchState] = useState<"idle" | "searching">("idle");
  const [searchError, setSearchError] = useState<string>();
  const noRenderedOsmData =
    !loadingOSM &&
    osmData.counts.buildingsRendered === 0 &&
    osmData.counts.roadsRendered === 0;
  const noWindModel = !loadingOSM && !loadingWeather && renderStats.windSegments === 0;

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!query.trim()) {
      return;
    }

    setSearchState("searching");
    setSearchError(undefined);

    try {
      await onSearch(query.trim());
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Location search failed.");
    } finally {
      setSearchState("idle");
    }
  }

  return (
    <aside className="controls-panel">
      <header className="panel-header">
        <p className="eyebrow">Street model</p>
        <h1>Wind & Shadow Map</h1>
        <p className="location-label">{locationLabel}</p>
      </header>

      <form className="search-form" onSubmit={submitSearch}>
        <label htmlFor="location-search">Location</label>
        <div className="input-row">
          <input
            id="location-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Place or lat, lng"
          />
          <button disabled={searchState === "searching"} type="submit">
            {searchState === "searching" ? "..." : "Go"}
          </button>
        </div>
        <button className="secondary-button" onClick={onUseLocation} type="button">
          Use my location
        </button>
        <p className="coordinates">
          {center.lat.toFixed(5)}, {center.lng.toFixed(5)}
        </p>
        {searchError ? <p className="inline-error">{searchError}</p> : null}
      </form>

      <section className="panel-section">
        <label htmlFor="shadow-time">Date and time</label>
        <input
          id="shadow-time"
          type="datetime-local"
          value={dateTime}
          onChange={(event) => onDateTimeChange(event.target.value)}
        />
        <p className="sun-readout">{sunMessage}</p>
      </section>

      <section className="panel-section layer-controls">
        {noRenderedOsmData ? (
          <p className="status-warning">
            OSM data did not load for this area. Wind and shadows need live building and road
            geometry.
          </p>
        ) : null}
        {noWindModel && !noRenderedOsmData ? (
          <p className="status-warning">
            Wind model has no road segments yet. Check weather and OSM counts below.
          </p>
        ) : null}
        {(
          [
            ["buildings", "Buildings"],
            ["shadows", "Shadows"],
            ["windArrows", "Wind arrows"],
            ["roadWind", "Road wind heatmap"],
          ] as const
        ).map(([layer, label]) => (
          <label className="toggle-row" key={layer}>
            <span>{label}</span>
            <input
              checked={layers[layer]}
              onChange={() => onToggle(layer)}
              type="checkbox"
            />
          </label>
        ))}
      </section>

      <section className="panel-section weather-panel">
        <div className="section-heading">
          <h2>Wind feed</h2>
          {loadingWeather ? <span>Loading</span> : null}
        </div>
        {weather ? (
          <dl>
            <div>
              <dt>Speed</dt>
              <dd>{weather.windSpeed.toFixed(1)} m/s</dd>
            </div>
            <div>
              <dt>Direction</dt>
              <dd>{Math.round(weather.windDirection)} deg</dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd>{weather.observedAt.replace("T", " ")}</dd>
            </div>
          </dl>
        ) : (
          <p>No wind reading yet.</p>
        )}
        {weather?.fallback ? <p className="fallback-chip">Development fallback wind</p> : null}
      </section>

      <section className="panel-section notices">
        <div className="section-heading">
          <h2>Data</h2>
          {loadingOSM ? <span>Loading</span> : null}
        </div>
        <dl className="data-stats">
          <div>
            <dt>Source</dt>
            <dd>{osmData.source}</dd>
          </div>
          <div>
            <dt>Buildings returned</dt>
            <dd>{osmData.counts.buildingsReturned}</dd>
          </div>
          <div>
            <dt>Roads returned</dt>
            <dd>{osmData.counts.roadsReturned}</dd>
          </div>
          <div>
            <dt>Buildings rendered</dt>
            <dd>{osmData.counts.buildingsRendered}</dd>
          </div>
          <div>
            <dt>Roads rendered</dt>
            <dd>{osmData.counts.roadsRendered}</dd>
          </div>
          <div>
            <dt>Shadow polygons</dt>
            <dd>{renderStats.shadowPolygons}</dd>
          </div>
          <div>
            <dt>Wind heat segments</dt>
            <dd>{renderStats.windSegments}</dd>
          </div>
          <div>
            <dt>Wind arrows</dt>
            <dd>{renderStats.windArrows}</dd>
          </div>
        </dl>
        {osmData.endpoint ? <p className="data-endpoint">{new URL(osmData.endpoint).hostname}</p> : null}
        {dataMessage ? <p className="inline-error">{dataMessage}</p> : null}
        {weatherMessage ? <p className="inline-error">{weatherMessage}</p> : null}
        <p>
          Shadows use OSM footprints and tagged or estimated heights. Street wind is a fast
          urban-canyon approximation from weather wind, road alignment, and nearby buildings,
          not CFD.
        </p>
      </section>
    </aside>
  );
}
