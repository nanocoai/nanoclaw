export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://api.openstreetmap.fr/oapi/interpreter",
  "https://overpass.osm.vi-di.fr/api/interpreter",
  "https://overpass.osm.rambler.ru/cgi/interpreter",
];

export function endpointName(endpoint: string) {
  return new URL(endpoint).hostname;
}
