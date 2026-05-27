import { windColor } from "../utils/wind";

const strengthBands = [
  ["Weak", "< 0.8", 0.4],
  ["Light", "0.8-2", 1.2],
  ["Moderate", "2-4", 3],
  ["Strong", "4-6", 5],
  ["Very strong", "> 6", 7],
] as const;

type LegendProps = {
  sunBelowHorizon: boolean;
};

export default function Legend({ sunBelowHorizon }: LegendProps) {
  return (
    <div className="map-legends" aria-label="Map legends">
      <section className="legend-block">
        <h2>Wind strength along road</h2>
        {strengthBands.map(([label, range, value]) => (
          <div className="legend-row" key={label}>
            <span className="legend-swatch wind" style={{ background: windColor(value) }} />
            <span>{label}</span>
            <strong>{range} m/s</strong>
          </div>
        ))}
      </section>
      <section className="legend-block compact">
        <h2>Shadow layer</h2>
        <div className="legend-row">
          <span className="legend-swatch shadow" />
          <span>{sunBelowHorizon ? "No direct sun" : "Projected shadow"}</span>
        </div>
      </section>
    </div>
  );
}
