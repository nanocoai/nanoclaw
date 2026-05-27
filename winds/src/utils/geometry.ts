import * as turf from "@turf/turf";
import type { Feature, LineString, Point, Polygon, Position } from "geojson";
import type { BuildingFeature, LatLng, RoadFeature } from "../types";

export const OVERPASS_HALF_SPAN = {
  lat: 0.0029,
  lng: 0.0046,
};

export function normalizeBearing(value: number) {
  return ((value % 360) + 360) % 360;
}

export function angleDifference(first: number, second: number) {
  const difference = Math.abs(normalizeBearing(first) - normalizeBearing(second));
  return Math.min(difference, 360 - difference);
}

export function lineBearing(start: Position, end: Position) {
  return normalizeBearing(turf.bearing(turf.point(start), turf.point(end)));
}

export function bboxAround(center: LatLng) {
  return {
    south: center.lat - OVERPASS_HALF_SPAN.lat,
    west: center.lng - OVERPASS_HALF_SPAN.lng,
    north: center.lat + OVERPASS_HALF_SPAN.lat,
    east: center.lng + OVERPASS_HALF_SPAN.lng,
  };
}

export function bboxCacheKey(center: LatLng) {
  return `${center.lat.toFixed(3)}:${center.lng.toFixed(3)}`;
}

export function midpointOnLine(line: Feature<LineString>) {
  const length = turf.length(line, { units: "kilometers" });
  return turf.along(line, length / 2, { units: "kilometers" });
}

export function roadSegments(roads: RoadFeature[]) {
  return roads.flatMap((road) =>
    road.geometry.coordinates.slice(0, -1).flatMap((start, index) => {
      const end = road.geometry.coordinates[index + 1];

      if (!end || turf.distance(turf.point(start), turf.point(end), { units: "meters" }) < 5) {
        return [];
      }

      return [
        turf.lineString([start, end], {
          ...road.properties,
          id: `${road.properties.id}:${index}`,
        }),
      ];
    }),
  );
}

export function centroidOfBuilding(building: BuildingFeature) {
  return turf.centroid(building);
}

export function distanceToBuildingMeters(point: Feature<Point>, building: BuildingFeature) {
  if (turf.booleanPointInPolygon(point, building)) {
    return 0;
  }

  const outline = turf.polygonToLine(building) as Feature<LineString>;
  const nearest = turf.nearestPointOnLine(outline, point, { units: "meters" });
  return nearest.properties.dist ?? turf.distance(point, nearest, { units: "meters" });
}

export function sideOfLine(start: Position, end: Position, point: Position) {
  const segmentX = end[0] - start[0];
  const segmentY = end[1] - start[1];
  const pointX = point[0] - start[0];
  const pointY = point[1] - start[1];
  const cross = segmentX * pointY - segmentY * pointX;

  if (Math.abs(cross) < Number.EPSILON) {
    return "center";
  }

  return cross > 0 ? "left" : "right";
}

export function simplifyPolygon(feature: Feature<Polygon>, tolerance: number) {
  return turf.simplify(feature, {
    highQuality: false,
    mutate: false,
    tolerance,
  }) as Feature<Polygon>;
}
