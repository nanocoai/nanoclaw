import * as turf from "@turf/turf";
import SunCalc from "suncalc";
import type { Position } from "geojson";
import type { BuildingFeature, LatLng, ShadowFeature } from "../types";
import { normalizeBearing } from "./geometry";

const RADIANS_TO_DEGREES = 180 / Math.PI;

export function shadowLengthMeters(heightMeters: number, sunAltitudeRadians: number) {
  if (sunAltitudeRadians <= 0) {
    return 0;
  }

  // A taller building or lower sun makes a longer shadow: height / tan(altitude).
  return heightMeters / Math.tan(sunAltitudeRadians);
}

export function sunForDate(date: Date, center: LatLng) {
  const position = SunCalc.getPosition(date, center.lat, center.lng);

  // SunCalc azimuth starts at south and rotates westward. Map bearings start north.
  const sunBearing = normalizeBearing(position.azimuth * RADIANS_TO_DEGREES + 180);

  return {
    altitude: position.altitude,
    altitudeDegrees: position.altitude * RADIANS_TO_DEGREES,
    sunBearing,
    shadowBearing: normalizeBearing(sunBearing + 180),
  };
}

function projectCoordinate(coordinate: Position, lengthMeters: number, bearing: number) {
  return turf.destination(turf.point(coordinate), lengthMeters / 1000, bearing, {
    units: "kilometers",
  }).geometry.coordinates;
}

export function shadowForBuilding(
  building: BuildingFeature,
  sunAltitudeRadians: number,
  shadowBearing: number,
): ShadowFeature | null {
  const length = shadowLengthMeters(building.properties.height, sunAltitudeRadians);

  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }

  const footprint = building.geometry.coordinates[0];
  const shadowPoints = footprint.flatMap((coordinate) => [
    turf.point(coordinate),
    turf.point(projectCoordinate(coordinate, length, shadowBearing)),
  ]);
  const hull = turf.convex(turf.featureCollection(shadowPoints));

  if (!hull || hull.geometry.type !== "Polygon") {
    return null;
  }

  return {
    ...hull,
    properties: {
      ...building.properties,
      shadowLength: length,
    },
  };
}
