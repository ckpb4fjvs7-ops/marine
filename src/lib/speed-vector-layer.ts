import type * as L from "leaflet";
import { destinationPoint } from "./survey";
import { SPEED_VECTOR_MINUTES, type SpeedVector } from "./speed-vector";

export type SpeedVectorLayer = {
  group: L.LayerGroup;
  line: L.Polyline;
  marks: L.Polyline;
  arrow: L.Polyline;
  label: L.Marker;
};

const COLOR = "#22c979";

export function renderSpeedVector(Leaflet: typeof L, map: L.Map, vector: SpeedVector, current: SpeedVectorLayer | null): SpeedVectorLayer {
  const point = (value: { lat: number; lng: number }): L.LatLngTuple => [value.lat, value.lng];
  const end = map.latLngToContainerPoint(point(vector.tip));
  const start = map.latLngToContainerPoint(point(vector.origin));
  const lengthPx = start.distanceTo(end);
  // Keep symbols readable without changing the geographic length of the vector.
  const metresPerPixel = map.distance(map.containerPointToLatLng(end), map.containerPointToLatLng(end.add([1, 0])));
  const marks: L.LatLngTuple[][] = [];
  for (const tick of vector.ticks) {
    if (lengthPx / SPEED_VECTOR_MINUTES < 10 && tick.minute !== 5) continue;
    if (lengthPx < 24) continue;
    const halfKm = metresPerPixel * (tick.minute === 5 ? 5 : 3) / 1000;
    marks.push([
      point(destinationPoint(tick.lat, tick.lng, vector.cogDeg - 90, halfKm)),
      point(destinationPoint(tick.lat, tick.lng, vector.cogDeg + 90, halfKm)),
    ]);
  }
  const arrowKm = metresPerPixel * Math.min(10, lengthPx * 0.3) / 1000;
  const arrow = [
    point(destinationPoint(vector.tip.lat, vector.tip.lng, vector.cogDeg + 155, arrowKm)),
    point(vector.tip),
    point(destinationPoint(vector.tip.lat, vector.tip.lng, vector.cogDeg - 155, arrowKm)),
  ];
  const line = [point(vector.origin), ...vector.ticks.map(point), point(vector.tip)];
  if (!current) {
    const group = Leaflet.layerGroup().addTo(map);
    const style = { color: COLOR, weight: 3, opacity: 1, interactive: false, lineCap: "round" as const };
    current = {
      group,
      line: Leaflet.polyline(line, { ...style, className: "speed-vector-line" }).addTo(group),
      marks: Leaflet.polyline(marks, { ...style, weight: 2, className: "speed-vector-ticks" }).addTo(group),
      arrow: Leaflet.polyline(arrow, { ...style, className: "speed-vector-arrow" }).addTo(group),
      label: Leaflet.marker(point(vector.tip), {
        icon: Leaflet.divIcon({ className: "speed-vector-tip", html: "", iconSize: [0, 0] }),
        interactive: false, keyboard: false, zIndexOffset: 700,
      }).addTo(group).bindTooltip("", { permanent: true, direction: "right", className: "speed-vector-label", opacity: 1 }),
    };
  } else {
    current.line.setLatLngs(line);
    current.marks.setLatLngs(marks);
    current.arrow.setLatLngs(arrow);
    current.label.setLatLng(point(vector.tip));
  }
  const tooltip = current.label.getTooltip();
  if (tooltip) tooltip.options.direction = end.x + 125 > map.getSize().x ? "left" : "right";
  current.label.setTooltipContent(`${SPEED_VECTOR_MINUTES} min · ${vector.distanceNm.toFixed(2)} NM`);
  return current;
}
