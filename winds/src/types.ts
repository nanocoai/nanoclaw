import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
  Position,
} from "geojson";

export type LatLng = {
  lat: number;
  lng: number;
};

export type HeightSource = "exact" | "levels-estimated" | "default";

export type BuildingProperties = {
  id: string;
  height: number;
  heightSource: HeightSource;
  name?: string;
};

export type RoadProperties = {
  id: string;
  highway: string;
  name?: string;
};

export type BuildingFeature = Feature<Polygon, BuildingProperties>;
export type RoadFeature = Feature<LineString, RoadProperties>;

export type ShadowProperties = BuildingProperties & {
  shadowLength: number;
};

export type ShadowFeature = Feature<Polygon, ShadowProperties>;

export type Confidence = "low" | "medium" | "high";

export type WindSegmentProperties = RoadProperties & {
  bearing: number;
  localDirection: number;
  speed: number;
  baseSpeed: number;
  baseDirection: number;
  canyonMultiplier: number;
  confidence: Confidence;
  nearbyBuildings: number;
};

export type WindSegmentFeature = Feature<LineString, WindSegmentProperties>;

export type ArrowProperties = WindSegmentProperties & {
  midpoint: Position;
};

export type ArrowFeature = Feature<Point, ArrowProperties>;

export type OSMDataSource = "live" | "cache" | "fallback" | "error";

export type OSMDataCounts = {
  buildingsReturned: number;
  roadsReturned: number;
  buildingsRendered: number;
  roadsRendered: number;
};

export type OSMData = {
  buildings: FeatureCollection<Polygon, BuildingProperties>;
  roads: FeatureCollection<LineString, RoadProperties>;
  warning?: string;
  endpoint?: string;
  errors?: string[];
  fallback: boolean;
  source: OSMDataSource;
  counts: OSMDataCounts;
};

export type LayerRenderStats = {
  shadowPolygons: number;
  windSegments: number;
  windArrows: number;
};

export type WeatherData = {
  windSpeed: number;
  windDirection: number;
  observedAt: string;
  fallback: boolean;
};

export type LayerToggles = {
  buildings: boolean;
  shadows: boolean;
  windArrows: boolean;
  roadWind: boolean;
};
