import { demoWeatherData } from "../data/offlineDemo";
import type { LatLng, WeatherData } from "../types";

type WeatherResponse = {
  current?: {
    time?: string;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
};

export async function fetchWeather(center: LatLng): Promise<WeatherData> {
  const parameters = new URLSearchParams({
    latitude: center.lat.toString(),
    longitude: center.lng.toString(),
    current: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "auto",
  });

  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${parameters}`);

    if (!response.ok) {
      throw new Error(`Open-Meteo returned ${response.status}.`);
    }

    const payload = (await response.json()) as WeatherResponse;
    const windSpeed = payload.current?.wind_speed_10m;
    const windDirection = payload.current?.wind_direction_10m;

    if (typeof windSpeed !== "number" || typeof windDirection !== "number") {
      throw new Error("Open-Meteo did not include current wind values.");
    }

    return {
      windSpeed,
      windDirection,
      observedAt: payload.current?.time ?? new Date().toISOString(),
      fallback: false,
    };
  } catch (error) {
    if (import.meta.env.DEV) {
      throw Object.assign(new Error("Live Open-Meteo wind fetch failed."), {
        cause: error,
        fallback: demoWeatherData,
      });
    }

    throw error;
  }
}
