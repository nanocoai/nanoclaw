import * as turf from "@turf/turf";
import { demoOSMData } from "../data/offlineDemo";
import { endpointName, OVERPASS_ENDPOINTS } from "./endpoints";
import type {
  BuildingFeature,
  HeightSource,
  LatLng,
  OSMData,
  OSMDataCounts,
  RoadFeature,
} from "../types";
import { bboxAround, bboxCacheKey, simplifyPolygon } from "../utils/geometry";

type OverpassElement = {
  type: "way";
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number } | null>;
};

type OverpassResponse = {
  elements?: OverpassElement[];
};

const pendingOverpassCache = new Map<string, Promise<OSMData>>();
const resolvedOverpassCache = new Map<string, OSMData>();
const MAX_RENDER_BUILDINGS = 650;
const MAX_RENDER_ROADS = 240;
const OVERPASS_TIMEOUT_MS = 14_000;

function parseMetricHeight(raw?: string) {
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseFloat(raw.replace(",", "."));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return raw.includes("'") || raw.toLowerCase().includes("ft") ? parsed * 0.3048 : parsed;
}

export function resolveBuildingHeight(tags: Record<string, string>) {
  const exact = parseMetricHeight(tags.height ?? tags["building:height"]);

  if (exact) {
    return { height: exact, heightSource: "exact" as HeightSource };
  }

  const levels = parseMetricHeight(tags["building:levels"]);

  if (levels) {
    return {
      height: levels * 3,
      heightSource: "levels-estimated" as HeightSource,
    };
  }

  return { height: 12, heightSource: "default" as HeightSource };
}

function positions(element: OverpassElement) {
  return (element.geometry ?? [])
    .filter((point): point is { lat: number; lon: number } => Boolean(point))
    .map(({ lon, lat }) => [lon, lat]);
}

function closeRing(coordinates: number[][]) {
  const first = coordinates[0];
  const last = coordinates.at(-1);

  if (!first || !last || (first[0] === last[0] && first[1] === last[1])) {
    return coordinates;
  }

  return [...coordinates, first];
}

function buildingFromWay(element: OverpassElement): BuildingFeature | null {
  const ring = closeRing(positions(element));

  if (ring.length < 4) {
    return null;
  }

  const { height, heightSource } = resolveBuildingHeight(element.tags ?? {});
  const feature = turf.polygon([ring], {
    id: `building-${element.id}`,
    height,
    heightSource,
    name: element.tags?.name,
  }) as BuildingFeature;

  return ring.length > 70 ? (simplifyPolygon(feature, 0.000004) as BuildingFeature) : feature;
}

function roadFromWay(element: OverpassElement): RoadFeature | null {
  const coordinates = positions(element);

  if (coordinates.length < 2) {
    return null;
  }

  const feature = turf.lineString(coordinates, {
    id: `road-${element.id}`,
    highway: element.tags?.highway ?? "road",
    name: element.tags?.name,
  }) as RoadFeature;

  return coordinates.length > 6
    ? (turf.simplify(feature, {
        highQuality: false,
        mutate: false,
        tolerance: 0.000006,
      }) as RoadFeature)
    : feature;
}

function queryFor(center: LatLng) {
  const { south, west, north, east } = bboxAround(center);
  const bbox = `${south},${west},${north},${east}`;

  return `[out:json][timeout:20];
(
  way["building"](${bbox});
  way["highway"]["area"!="yes"]["highway"!~"footway|path|steps|cycleway|track|corridor|construction|proposed"](${bbox});
);
out tags geom(${bbox});`;
}

async function postToOverpass(endpoint: string, query: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

  try {
    return await fetch(endpoint, {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ data: query }),
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

function emptyErrorData(warning: string, errors: string[]): OSMData {
  return {
    fallback: false,
    source: "error",
    warning,
    errors,
    counts: {
      buildingsReturned: 0,
      roadsReturned: 0,
      buildingsRendered: 0,
      roadsRendered: 0,
    },
    buildings: turf.featureCollection([]),
    roads: turf.featureCollection([]),
  };
}

function cachedData(data: OSMData, warning?: string): OSMData {
  return {
    ...data,
    source: "cache",
    warning: warning ?? data.warning,
  };
}

function parseOverpassPayload(payload: OverpassResponse, endpoint: string, errors: string[]): OSMData {
  const elements = payload.elements ?? [];
  const buildings = elements
    .filter((element) => Boolean(element.tags?.building))
    .map(buildingFromWay)
    .filter((building): building is BuildingFeature => Boolean(building));
  const roads = elements
    .filter((element) => Boolean(element.tags?.highway))
    .map(roadFromWay)
    .filter((road): road is RoadFeature => Boolean(road));
  const trimmedBuildings = buildings.slice(0, MAX_RENDER_BUILDINGS);
  const trimmedRoads = roads.slice(0, MAX_RENDER_ROADS);
  const counts: OSMDataCounts = {
    buildingsReturned: buildings.length,
    roadsReturned: roads.length,
    buildingsRendered: trimmedBuildings.length,
    roadsRendered: trimmedRoads.length,
  };
  const wasTrimmed = trimmedBuildings.length < buildings.length || trimmedRoads.length < roads.length;
  const warning =
    wasTrimmed
      ? `Large area response: ${buildings.length} buildings and ${roads.length} roads. Rendering a nearby subset for responsiveness.`
      : undefined;

  return {
    fallback: false,
    source: "live",
    endpoint,
    warning,
    errors,
    counts,
    buildings: turf.featureCollection(trimmedBuildings),
    roads: turf.featureCollection(trimmedRoads),
  };
}

async function fetchFromOverpass(center: LatLng): Promise<OSMData> {
  const query = queryFor(center);
  const errors: string[] = [];
  const proxiedData = await fetchFromProxy(query, errors);

  if (proxiedData) {
    return proxiedData;
  }

  for (const endpoint of OVERPASS_ENDPOINTS) {
    let response: Response;

    try {
      response = await postToOverpass(endpoint, query);
    } catch (error) {
      errors.push(`${endpointName(endpoint)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const suffix = detail ? ` ${detail.replace(/\s+/g, " ").slice(0, 180)}` : "";
      errors.push(`${endpointName(endpoint)}: HTTP ${response.status}${suffix}`);
      continue;
    }

    const data = parseOverpassPayload((await response.json()) as OverpassResponse, endpoint, errors);

    if (data.counts.buildingsReturned === 0 && data.counts.roadsReturned === 0) {
      errors.push(`${endpointName(endpoint)}: empty OSM response for this bbox`);
      continue;
    }

    return data;
  }

  throw Object.assign(new Error("All Overpass endpoints failed."), { errors });
}

async function fetchFromProxy(query: string, errors: string[]) {
  try {
    const response = await fetch("/api/overpass", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (response.status === 404) {
      return null;
    }

    const data = (await response.json()) as {
      endpoint?: string;
      errors?: string[];
      payload?: OverpassResponse;
    };

    if (data.errors?.length) {
      errors.push(...data.errors.map((error) => `proxy ${error}`));
    }

    if (!response.ok || !data.endpoint || !data.payload) {
      errors.push(`proxy: HTTP ${response.status}`);
      if (import.meta.env.PROD) {
        throw Object.assign(new Error("Overpass proxy failed."), { errors });
      }
      return null;
    }

    const parsed = parseOverpassPayload(data.payload, data.endpoint, errors);

    if (parsed.counts.buildingsReturned === 0 && parsed.counts.roadsReturned === 0) {
      errors.push(`proxy ${endpointName(data.endpoint)}: empty OSM response for this bbox`);
      return null;
    }

    return parsed;
  } catch (error) {
    errors.push(`proxy: ${error instanceof Error ? error.message : String(error)}`);
    if (import.meta.env.PROD) {
      throw Object.assign(new Error("Overpass proxy failed."), { errors });
    }
    return null;
  }
}

export function fetchOSMData(center: LatLng) {
  const cacheKey = bboxCacheKey(center);
  const cached = resolvedOverpassCache.get(cacheKey);

  if (cached) {
    return Promise.resolve(cachedData(cached));
  }

  const pending = pendingOverpassCache.get(cacheKey);

  if (pending) {
    return pending;
  }

  const request = fetchFromOverpass(center)
    .then((data) => {
      resolvedOverpassCache.set(cacheKey, data);
      return data;
    })
    .catch((error) => {
      const errors =
        error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)
          ? error.errors
          : [error instanceof Error ? error.message : String(error)];
      const cachedAfterFailure = resolvedOverpassCache.get(cacheKey);

      if (cachedAfterFailure) {
        return cachedData(
          cachedAfterFailure,
          `Live OpenStreetMap / Overpass fetch failed. Using cached data for this area. ${errors.join(
            " | ",
          )}`,
        );
      }

      if (import.meta.env.DEV) {
        return {
          ...demoOSMData,
          warning: `Live OpenStreetMap / Overpass fetch failed. Using the small development fallback. ${errors.join(
            " | ",
          )}`,
          errors,
        };
      }

      return emptyErrorData(
        `Live OpenStreetMap / Overpass fetch failed. No cached data is available. ${errors.join(
          " | ",
        )}`,
        errors,
      );
    })
    .finally(() => {
      pendingOverpassCache.delete(cacheKey);
    });

  pendingOverpassCache.set(cacheKey, request);
  return request;
}
