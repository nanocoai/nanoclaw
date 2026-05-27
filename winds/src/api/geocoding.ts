import type { LatLng } from "../types";

type NominatimResult = {
  lat: string;
  lon: string;
  display_name: string;
};

function parseCoordinates(query: string): LatLng | null {
  const parts = query
    .split(/[,\s]+/)
    .map((part) => Number.parseFloat(part.trim()))
    .filter((part) => Number.isFinite(part));

  if (parts.length !== 2) {
    return null;
  }

  const [lat, lng] = parts;

  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  return { lat, lng };
}

export async function findLocation(query: string) {
  const coordinates = parseCoordinates(query);

  if (coordinates) {
    return {
      center: coordinates,
      label: `${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}`,
    };
  }

  const parameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${parameters}`);

  if (!response.ok) {
    throw new Error(`Location search returned ${response.status}.`);
  }

  const [result] = (await response.json()) as NominatimResult[];

  if (!result) {
    throw new Error("No matching location found.");
  }

  return {
    center: {
      lat: Number.parseFloat(result.lat),
      lng: Number.parseFloat(result.lon),
    },
    label: result.display_name,
  };
}
