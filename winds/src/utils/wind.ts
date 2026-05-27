import * as turf from "@turf/turf";
import type { Feature, LineString } from "geojson";
import type {
  ArrowFeature,
  BuildingFeature,
  Confidence,
  RoadFeature,
  WindSegmentFeature,
} from "../types";
import {
  angleDifference,
  centroidOfBuilding,
  distanceToBuildingMeters,
  lineBearing,
  midpointOnLine,
  normalizeBearing,
  roadSegments,
  sideOfLine,
} from "./geometry";

const CLOSE_BUILDING_METERS = 34;
const UPWIND_SHELTER_METERS = 58;
const TALL_BUILDING_METERS = 18;

export function windComponentAlongRoad(
  baseWindSpeed: number,
  roadBearing: number,
  windFlowBearing: number,
) {
  // Wind parallel to a street keeps its strength; crosswind contributes less.
  const difference = angleDifference(roadBearing, windFlowBearing);
  return baseWindSpeed * Math.abs(Math.cos((difference * Math.PI) / 180));
}

export function windFlowBearing(windDirectionFrom: number) {
  return normalizeBearing(windDirectionFrom + 180);
}

export function localStreetDirection(roadBearing: number, windFlow: number) {
  return angleDifference(roadBearing, windFlow) <= 90
    ? roadBearing
    : normalizeBearing(roadBearing + 180);
}

export function windColor(speed: number) {
  if (speed < 0.8) {
    return "#92a5b3";
  }

  if (speed < 2) {
    return "#52c6b4";
  }

  if (speed < 4) {
    return "#e5ce5b";
  }

  if (speed < 6) {
    return "#ef8e43";
  }

  return "#e65464";
}

function confidenceForSegment(
  nearbyBuildings: BuildingFeature[],
  hasLeftWall: boolean,
  hasRightWall: boolean,
): Confidence {
  const hasMeasuredHeight = nearbyBuildings.some(
    (building) => building.properties.heightSource !== "default",
  );

  if (hasLeftWall && hasRightWall && hasMeasuredHeight) {
    return "high";
  }

  if (nearbyBuildings.length >= 2) {
    return "medium";
  }

  return "low";
}

function multiplierForSegment(
  segment: Feature<LineString>,
  buildings: BuildingFeature[],
  flowBearing: number,
) {
  const midpoint = midpointOnLine(segment);
  const [start, end] = segment.geometry.coordinates;
  const nearby = buildings
    .map((building) => ({
      building,
      centroid: centroidOfBuilding(building),
    }))
    .filter(
      ({ centroid }) =>
        turf.distance(midpoint, centroid, { units: "meters" }) <= UPWIND_SHELTER_METERS + 90,
    )
    .map(({ building, centroid }) => ({
      building,
      centroid,
      distance: distanceToBuildingMeters(midpoint, building),
    }))
    .filter(({ distance }) => distance <= UPWIND_SHELTER_METERS);

  const tallClose = nearby.filter(
    ({ building, distance }) =>
      building.properties.height >= TALL_BUILDING_METERS && distance <= CLOSE_BUILDING_METERS,
  );
  const hasLeftWall = tallClose.some(
    ({ centroid }) => sideOfLine(start, end, centroid.geometry.coordinates) === "left",
  );
  const hasRightWall = tallClose.some(
    ({ centroid }) => sideOfLine(start, end, centroid.geometry.coordinates) === "right",
  );
  const streetBearing = lineBearing(start, end);
  const alignment = Math.abs(Math.cos((angleDifference(streetBearing, flowBearing) * Math.PI) / 180));
  const canyonBoost = hasLeftWall && hasRightWall ? 1.2 + alignment * 0.4 : 1;
  const upwindBearing = normalizeBearing(flowBearing + 180);
  const shelter = nearby
    .filter(({ building, centroid }) => {
      if (building.properties.height < TALL_BUILDING_METERS) {
        return false;
      }

      const bearingToBuilding = lineBearing(midpoint.geometry.coordinates, centroid.geometry.coordinates);
      return angleDifference(bearingToBuilding, upwindBearing) <= 42;
    })
    .reduce((reduction, { distance }) => {
      const distanceFactor = Math.min(distance / UPWIND_SHELTER_METERS, 1);
      return Math.min(reduction, 0.5 + distanceFactor * 0.3);
    }, 1);

  return {
    multiplier: canyonBoost * shelter,
    nearbyBuildings: nearby.map(({ building }) => building),
    confidence: confidenceForSegment(
      nearby.map(({ building }) => building),
      hasLeftWall,
      hasRightWall,
    ),
  };
}

export function estimateRoadWind(
  roads: RoadFeature[],
  buildings: BuildingFeature[],
  baseWindSpeed: number,
  windDirectionFrom: number,
) {
  const flowBearing = windFlowBearing(windDirectionFrom);
  const segments = roadSegments(roads);

  return segments.map((segment) => {
    const [start, end] = segment.geometry.coordinates;
    const bearing = lineBearing(start, end);
    const { multiplier, nearbyBuildings, confidence } = multiplierForSegment(
      segment,
      buildings,
      flowBearing,
    );
    const localDirection = localStreetDirection(bearing, flowBearing);
    const speed = windComponentAlongRoad(baseWindSpeed, bearing, flowBearing) * multiplier;

    return {
      ...segment,
      properties: {
        ...segment.properties,
        bearing,
        localDirection,
        speed,
        baseSpeed: baseWindSpeed,
        baseDirection: windDirectionFrom,
        canyonMultiplier: multiplier,
        confidence,
        nearbyBuildings: nearbyBuildings.length,
      },
    } as WindSegmentFeature;
  });
}

export function windArrowForSegment(segment: WindSegmentFeature): ArrowFeature {
  const midpoint = midpointOnLine(segment);

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: midpoint.geometry.coordinates,
    },
    properties: {
      ...segment.properties,
      midpoint: midpoint.geometry.coordinates,
    },
  };
}
