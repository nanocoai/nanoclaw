import L, { type Layer } from "leaflet";
import { useEffect } from "react";
import {
  GeoJSON,
  MapContainer,
  Marker,
  Pane,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { FeatureCollection, GeoJsonObject, LineString, Point, Polygon } from "geojson";
import type {
  ArrowProperties,
  BuildingProperties,
  LatLng,
  LayerToggles,
  ShadowProperties,
  WindSegmentProperties,
} from "../types";
import { windColor } from "../utils/wind";

type MapViewProps = {
  center: LatLng;
  layers: LayerToggles;
  buildings: FeatureCollection<Polygon, BuildingProperties>;
  shadows: FeatureCollection<Polygon, ShadowProperties>;
  windSegments: FeatureCollection<LineString, WindSegmentProperties>;
  arrows: FeatureCollection<Point, ArrowProperties>;
  onAreaChange: (center: LatLng) => void;
};

function RefreshMapCenter({ center }: { center: LatLng }) {
  const map = useMap();

  useEffect(() => {
    const current = map.getCenter();

    if (Math.abs(current.lat - center.lat) > 0.0002 || Math.abs(current.lng - center.lng) > 0.0002) {
      map.flyTo([center.lat, center.lng], map.getZoom(), {
        duration: 0.65,
      });
    }
  }, [center, map]);

  return null;
}

function ReportMapCenter({ onAreaChange }: { onAreaChange: (center: LatLng) => void }) {
  useMapEvents({
    moveend(event) {
      const center = event.target.getCenter();
      onAreaChange({ lat: center.lat, lng: center.lng });
    },
  });

  return null;
}

function buildingTooltip(properties: BuildingProperties) {
  return `Height: ${properties.height.toFixed(1)} m
Source: ${properties.heightSource}`;
}

function windTooltip(properties: WindSegmentProperties) {
  return `Estimated street wind: ${properties.speed.toFixed(1)} m/s
Base wind: ${properties.baseSpeed.toFixed(1)} m/s at ${Math.round(properties.baseDirection)} deg
Road bearing: ${Math.round(properties.bearing)} deg
Canyon multiplier: ${properties.canyonMultiplier.toFixed(2)}x
Confidence: ${properties.confidence}`;
}

function bindBuildingTooltip(_feature: GeoJSON.Feature, layer: Layer) {
  const properties = _feature.properties as BuildingProperties;
  const details = buildingTooltip(properties);
  layer.bindTooltip(details, {
    className: "map-tooltip",
    direction: "top",
    sticky: true,
  });
  layer.bindPopup(details.replace(/\n/g, "<br />"), {
    className: "map-popup",
  });
}

function bindShadowTooltip(_feature: GeoJSON.Feature, layer: Layer) {
  const properties = _feature.properties as ShadowProperties;
  const details = `Shadow length: ${properties.shadowLength.toFixed(1)} m`;
  layer.bindTooltip(details, {
    className: "map-tooltip",
    direction: "top",
    sticky: true,
  });
  layer.bindPopup(details, {
    className: "map-popup",
  });
}

function bindWindTooltip(_feature: GeoJSON.Feature, layer: Layer) {
  const properties = _feature.properties as WindSegmentProperties;
  const details = windTooltip(properties);
  layer.bindTooltip(details, {
    className: "map-tooltip",
    direction: "top",
    sticky: true,
  });
  layer.bindPopup(details.replace(/\n/g, "<br />"), {
    className: "map-popup",
  });
}

function arrowIcon(properties: ArrowProperties) {
  return L.divIcon({
    className: "wind-arrow-shell",
    html: `<span aria-hidden="true" class="wind-arrow" style="--bearing:${properties.localDirection}deg;--wind-color:${windColor(
      properties.speed,
    )}"></span>`,
    iconAnchor: [14, 14],
    iconSize: [28, 28],
  });
}

export default function MapView({
  center,
  layers,
  buildings,
  shadows,
  windSegments,
  arrows,
  onAreaChange,
}: MapViewProps) {
  return (
    <main className="map-shell">
      <MapContainer center={[center.lat, center.lng]} zoom={16} minZoom={13}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <RefreshMapCenter center={center} />
        <ReportMapCenter onAreaChange={onAreaChange} />
        <Pane name="shadow-pane" style={{ zIndex: 410 }}>
          {layers.shadows ? (
            <GeoJSON
              data={shadows as GeoJsonObject}
              key={`shadows-${shadows.features.length}-${center.lat}-${center.lng}`}
              onEachFeature={bindShadowTooltip}
              pane="shadow-pane"
              style={{
                color: "#12151a",
                fillColor: "#12151a",
                fillOpacity: 0.52,
                opacity: 0.28,
                weight: 1.2,
              }}
            />
          ) : null}
        </Pane>
        <Pane name="building-pane" style={{ zIndex: 430 }}>
          {layers.buildings ? (
            <GeoJSON
              data={buildings as GeoJsonObject}
              key={`buildings-${buildings.features.length}-${center.lat}-${center.lng}`}
              onEachFeature={bindBuildingTooltip}
              pane="building-pane"
              style={{
                color: "#fff7dc",
                fillColor: "#117f86",
                fillOpacity: 0.56,
                opacity: 1,
                weight: 1.8,
              }}
            />
          ) : null}
        </Pane>
        <Pane name="road-wind-pane" style={{ zIndex: 455 }}>
          {layers.roadWind ? (
            <GeoJSON
              data={windSegments as GeoJsonObject}
              key={`wind-${windSegments.features.length}-${center.lat}-${center.lng}`}
              onEachFeature={bindWindTooltip}
              pane="road-wind-pane"
              style={(feature) => {
                const properties = feature?.properties as WindSegmentProperties | undefined;

                return {
                  color: windColor(properties?.speed ?? 0),
                  dashArray: "10 8",
                  lineCap: "butt",
                  opacity: 0.48,
                  weight: 4,
                };
              }}
            />
          ) : null}
        </Pane>
        <Pane name="wind-arrow-pane" style={{ zIndex: 650 }}>
          {layers.windArrows
            ? arrows.features.map((arrow) => (
                <Marker
                  alt=""
                  icon={arrowIcon(arrow.properties)}
                  interactive={false}
                  key={arrow.properties.id}
                  keyboard={false}
                  pane="wind-arrow-pane"
                  position={[arrow.geometry.coordinates[1], arrow.geometry.coordinates[0]]}
                />
              ))
            : null}
        </Pane>
      </MapContainer>
    </main>
  );
}
