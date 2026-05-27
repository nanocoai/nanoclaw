import * as turf from "@turf/turf";
import { useEffect, useMemo, useState } from "react";
import { findLocation } from "./api/geocoding";
import { fetchOSMData } from "./api/overpass";
import { fetchWeather } from "./api/weather";
import ControlsPanel from "./components/ControlsPanel";
import Legend from "./components/Legend";
import MapView from "./components/MapView";
import type {
  LatLng,
  LayerRenderStats,
  LayerToggles,
  OSMData,
  ShadowFeature,
  WeatherData,
} from "./types";
import { shadowForBuilding, sunForDate } from "./utils/shadows";
import { estimateRoadWind, windArrowForSegment } from "./utils/wind";

const DEFAULT_CENTER = {
  lat: 59.93476,
  lng: 30.32649,
};

function initialLocation() {
  const parameters = new URLSearchParams(window.location.search);
  const lat = Number.parseFloat(parameters.get("lat") ?? "");
  const lng = Number.parseFloat(parameters.get("lng") ?? "");

  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return {
      center: { lat, lng },
      label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    };
  }

  return {
    center: DEFAULT_CENTER,
    label: "Nevsky Prospect, Saint Petersburg",
  };
}

const EMPTY_OSM: OSMData = {
  fallback: false,
  source: "error",
  counts: {
    buildingsReturned: 0,
    roadsReturned: 0,
    buildingsRendered: 0,
    roadsRendered: 0,
  },
  buildings: turf.featureCollection([]),
  roads: turf.featureCollection([]),
};

function localDateTimeValue(date: Date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}

function fallbackFrom(error: unknown) {
  if (error && typeof error === "object" && "fallback" in error) {
    return error.fallback;
  }

  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

export default function App() {
  const [center, setCenter] = useState<LatLng>(() => initialLocation().center);
  const [locationLabel, setLocationLabel] = useState(() => initialLocation().label);
  const [dateTime, setDateTime] = useState(() => localDateTimeValue(new Date()));
  const [layers, setLayers] = useState<LayerToggles>({
    buildings: true,
    shadows: true,
    windArrows: true,
    roadWind: true,
  });
  const [osmData, setOSMData] = useState<OSMData>(EMPTY_OSM);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [loadingOSM, setLoadingOSM] = useState(true);
  const [loadingWeather, setLoadingWeather] = useState(true);
  const [dataMessage, setDataMessage] = useState<string>();
  const [weatherMessage, setWeatherMessage] = useState<string>();

  useEffect(() => {
    let active = true;

    setLoadingOSM(true);
    setDataMessage(undefined);

    fetchOSMData(center)
      .then((data) => {
        if (!active) {
          return;
        }

        setOSMData(data);
        setDataMessage(data.warning);
        console.info("[OSM data]", {
          source: data.source,
          endpoint: data.endpoint,
          counts: data.counts,
          warning: data.warning,
          errors: data.errors,
        });
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        const fallback = fallbackFrom(error);

        if (fallback) {
          setOSMData(fallback as OSMData);
        }

        setDataMessage(
          `${errorMessage(error)} ${
            fallback ? "Using the small development fallback." : "No map data loaded."
          }`,
        );
      })
      .finally(() => {
        if (active) {
          setLoadingOSM(false);
        }
      });

    return () => {
      active = false;
    };
  }, [center]);

  useEffect(() => {
    let active = true;

    setLoadingWeather(true);
    setWeatherMessage(undefined);

    fetchWeather(center)
      .then((reading) => {
        if (active) {
          setWeather(reading);
        }
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        const fallback = fallbackFrom(error);

        if (fallback) {
          setWeather(fallback as WeatherData);
        } else {
          setWeather(null);
        }

        setWeatherMessage(
          `${errorMessage(error)} ${
            fallback ? "Using the small development fallback." : "No wind reading loaded."
          }`,
        );
      })
      .finally(() => {
        if (active) {
          setLoadingWeather(false);
        }
      });

    return () => {
      active = false;
    };
  }, [center]);

  const selectedDate = useMemo(() => new Date(dateTime), [dateTime]);
  const sun = useMemo(() => sunForDate(selectedDate, center), [center, selectedDate]);
  const shadows = useMemo(
    () =>
      turf.featureCollection(
        osmData.buildings.features
          .map((building) => shadowForBuilding(building, sun.altitude, sun.shadowBearing))
          .filter((shadow): shadow is ShadowFeature => Boolean(shadow)),
      ),
    [osmData.buildings.features, sun.altitude, sun.shadowBearing],
  );
  const windSegments = useMemo(
    () =>
      turf.featureCollection(
        weather
          ? estimateRoadWind(
              osmData.roads.features,
              osmData.buildings.features,
              weather.windSpeed,
              weather.windDirection,
            )
          : [],
      ),
    [osmData.buildings.features, osmData.roads.features, weather],
  );
  const arrows = useMemo(
    () => {
      const arrowStride = Math.max(1, Math.ceil(windSegments.features.length / 360));

      return turf.featureCollection(
        windSegments.features
          .filter((_, index) => index % arrowStride === 0)
          .map(windArrowForSegment),
      );
    },
    [windSegments.features],
  );
  const renderStats: LayerRenderStats = useMemo(
    () => ({
      shadowPolygons: shadows.features.length,
      windSegments: windSegments.features.length,
      windArrows: arrows.features.length,
    }),
    [arrows.features.length, shadows.features.length, windSegments.features.length],
  );

  async function search(query: string) {
    const location = await findLocation(query);
    setLocationLabel(location.label);
    setCenter(location.center);
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setDataMessage("Geolocation is not available in this browser.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocationLabel("Current location");
        setCenter({ lat: coords.latitude, lng: coords.longitude });
      },
      () => setDataMessage("Current location could not be read."),
      { enableHighAccuracy: false, maximumAge: 120_000, timeout: 10_000 },
    );
  }

  function updateCenterFromMap(nextCenter: LatLng) {
    setCenter((current) =>
      Math.abs(current.lat - nextCenter.lat) > 0.002 ||
      Math.abs(current.lng - nextCenter.lng) > 0.003
        ? nextCenter
        : current,
    );
  }

  return (
    <div className="app-shell">
      <MapView
        arrows={arrows}
        buildings={osmData.buildings}
        center={center}
        layers={layers}
        onAreaChange={updateCenterFromMap}
        shadows={shadows}
        windSegments={windSegments}
      />
      <ControlsPanel
        center={center}
        dataMessage={dataMessage}
        dateTime={dateTime}
        layers={layers}
        loadingOSM={loadingOSM}
        loadingWeather={loadingWeather}
        locationLabel={locationLabel}
        osmData={osmData}
        onDateTimeChange={setDateTime}
        onSearch={search}
        onToggle={(layer) => setLayers((current) => ({ ...current, [layer]: !current[layer] }))}
        onUseLocation={useCurrentLocation}
        renderStats={renderStats}
        sunMessage={
          sun.altitude <= 0
            ? "Sun below horizon - no direct shadows."
            : `Sun altitude ${sun.altitudeDegrees.toFixed(1)} deg, shadow bearing ${Math.round(
                sun.shadowBearing,
              )} deg.`
        }
        weather={weather}
        weatherMessage={weatherMessage}
      />
      <Legend sunBelowHorizon={sun.altitude <= 0} />
    </div>
  );
}
