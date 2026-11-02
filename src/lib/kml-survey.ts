import type * as L from "leaflet";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { Survey, SurveySounding } from "./survey";

export const ABDULLAH_SURVEY_NAME = "خور عبد الله 11-13";
export const ABDULLAH_KML_URL = "/surveys/khawr-abdullah-11-13.kml";
export const ABDULLAH_KMZ_URL = "/surveys/khawr-abdullah-11-13.kmz";

type KmlStyle = {
  lineColor?: string;
  lineOpacity?: number;
  weight?: number;
  fillColor?: string;
  fillOpacity?: number;
  fill?: boolean;
  stroke?: boolean;
  labelScale?: number;
};

type KmlProperties = {
  name: string;
  folder: string;
  styleUrl: string;
  style: KmlStyle;
  sounding: boolean;
  altitudeMode: string;
};

export type KmlSurvey = {
  survey: Survey;
  features: FeatureCollection<Geometry, KmlProperties>;
};

function child(element: Element, name: string): Element | undefined {
  return Array.from(element.children).find((node) => node.localName === name);
}

function text(element: Element, name: string): string {
  return child(element, name)?.textContent?.trim() ?? "";
}

function kmlColor(value: string): { color: string; opacity: number } | undefined {
  if (!/^[0-9a-f]{8}$/i.test(value)) return;
  // KML stores colors as alpha, blue, green, red.
  return { color: `#${value.slice(6, 8)}${value.slice(4, 6)}${value.slice(2, 4)}`, opacity: parseInt(value.slice(0, 2), 16) / 255 };
}

function parseStyle(element?: Element): KmlStyle {
  if (!element) return {};
  const style: KmlStyle = {};
  const line = child(element, "LineStyle");
  const poly = child(element, "PolyStyle");
  const label = child(element, "LabelStyle");
  if (line) {
    const color = kmlColor(text(line, "color"));
    if (color) { style.lineColor = color.color; style.lineOpacity = color.opacity; }
    if (text(line, "width")) style.weight = Number(text(line, "width"));
  }
  if (poly) {
    const color = kmlColor(text(poly, "color"));
    if (color) { style.fillColor = color.color; style.fillOpacity = color.opacity; }
    if (text(poly, "fill")) style.fill = text(poly, "fill") !== "0";
    if (text(poly, "outline")) style.stroke = text(poly, "outline") !== "0";
  }
  if (label && text(label, "scale")) style.labelScale = Number(text(label, "scale"));
  return style;
}

function coordinates(element: Element): Position[] {
  return text(element, "coordinates").split(/\s+/).filter(Boolean).map((coordinate) => {
    const position = coordinate.split(",").map(Number);
    if (position.length < 2 || position.some((value) => !Number.isFinite(value))) throw new Error("Invalid KML coordinate");
    if (Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw new Error("KML coordinate outside geographic bounds");
    // Preserve the original longitude, latitude and altitude; no rounding or reprojection.
    return position;
  });
}

function geometry(element: Element): Geometry | null {
  if (element.localName === "Point") return { type: "Point", coordinates: coordinates(element)[0] };
  if (element.localName === "LineString") return { type: "LineString", coordinates: coordinates(element) };
  if (element.localName === "Polygon") {
    const rings = Array.from(element.children)
      .filter((node) => node.localName === "outerBoundaryIs" || node.localName === "innerBoundaryIs")
      .map((boundary) => {
        const ring = child(boundary, "LinearRing");
        if (!ring) throw new Error("KML polygon ring missing");
        return coordinates(ring);
      });
    return { type: "Polygon", coordinates: rings };
  }
  if (element.localName === "MultiGeometry") {
    return { type: "GeometryCollection", geometries: Array.from(element.children).map(geometry).filter((item): item is Geometry => item != null) };
  }
  return null;
}

/** Read all source geometries; only XYZ soundings supply depth measurements. */
export function parseSurveyKml(source: string): KmlSurvey {
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Could not read the depth KML");
  const styles = new Map<string, KmlStyle>();
  for (const element of Array.from(doc.getElementsByTagNameNS("*", "Style"))) {
    if (element.id) styles.set(element.id, parseStyle(element));
  }
  const features: Feature<Geometry, KmlProperties>[] = [];
  const soundings: SurveySounding[] = [];
  const allPositions: Position[] = [];
  const collect = (item: Geometry) => {
    if (item.type === "GeometryCollection") { item.geometries.forEach(collect); return; }
    if (item.type === "Point") allPositions.push(item.coordinates);
    else if (item.type === "LineString") allPositions.push(...item.coordinates);
    else if (item.type === "Polygon") item.coordinates.forEach((ring) => allPositions.push(...ring));
  };
  for (const mark of Array.from(doc.getElementsByTagNameNS("*", "Placemark"))) {
    const element = Array.from(mark.children).find((node) => ["Point", "LineString", "Polygon", "MultiGeometry"].includes(node.localName));
    if (!element) throw new Error("Unsupported KML placemark geometry");
    const shape = geometry(element);
    if (!shape) throw new Error("Unsupported KML geometry");
    let parent = mark.parentElement;
    while (parent && parent.localName !== "Folder") parent = parent.parentElement;
    const folder = parent ? text(parent, "name") : "";
    const name = text(mark, "name");
    const styleUrl = text(mark, "styleUrl");
    // The DXF points at +5.01 are contour labels, not seabed soundings.
    const sounding = shape.type === "Point" && folder.toLowerCase().endsWith(".xyz");
    if (sounding && shape.type === "Point") {
      const [lng, lat, depth] = shape.coordinates;
      if (!Number.isFinite(depth)) throw new Error("KML sounding depth missing");
      soundings.push({ lng, lat, depth, label: name });
    }
    features.push({
      type: "Feature", geometry: shape,
      properties: { name, folder, styleUrl, sounding, altitudeMode: text(element, "altitudeMode"), style: { ...styles.get(styleUrl.replace(/^#/, "")), ...parseStyle(child(mark, "Style")) } },
    });
    collect(shape);
  }
  if (!soundings.length) throw new Error("No XYZ depth soundings in KML");
  const west = Math.min(...allPositions.map((point) => point[0]));
  const east = Math.max(...allPositions.map((point) => point[0]));
  const south = Math.min(...allPositions.map((point) => point[1]));
  const north = Math.max(...allPositions.map((point) => point[1]));
  const lat0 = (south + north) / 2;
  const lon0 = (west + east) / 2;
  const mPerLat = 111320;
  const mPerLon = mPerLat * Math.cos(lat0 * Math.PI / 180);
  return {
    features: { type: "FeatureCollection", features },
    survey: {
      name: ABDULLAH_SURVEY_NAME, west, east, south, north, lat0, lon0, mPerLat, mPerLon,
      x0: (west - lon0) * mPerLon, y0: (south - lat0) * mPerLat,
      // Two corners describe model extents only. No measured points are snapped to this grid.
      nx: 2, ny: 2, dx: (east - west) * mPerLon, dy: (north - south) * mPerLat,
      depths: [null, null, null, null], soundings, pointCount: soundings.length,
      minDepth: Math.min(...soundings.map((point) => point.depth)),
      maxDepth: Math.max(...soundings.map((point) => point.depth)),
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Apply a display preference relative to the source alpha values. */
export function setKmlDepthOpacity(layer: L.GeoJSON, opacity: number): void {
  layer.setStyle((feature) => {
    if (feature?.geometry.type === "Point") return { opacity: 0, fillOpacity: 0 };
    const style = feature?.properties.style as KmlStyle;
    return { opacity: (style.lineOpacity ?? 1) * opacity, fillOpacity: (style.fillOpacity ?? 1) * opacity };
  });
}

/** Display the complete KML with its original polygon holes, colors, lines and labels. */
export function createKmlDepthLayer(Leaflet: typeof L, data: KmlSurvey, map: L.Map): L.GeoJSON {
  const renderer = Leaflet.canvas({ padding: 0.5 });
  const layer = Leaflet.geoJSON(data.features, {
    style: (feature) => {
      if (feature?.geometry.type === "Point") return { stroke: false, opacity: 0, fillOpacity: 0 };
      const style = feature?.properties.style as KmlStyle;
      return {
        color: style.lineColor ?? "#ffffff", opacity: style.lineOpacity ?? 1, weight: style.weight ?? 1,
        fillColor: style.fillColor ?? "#ffffff", fillOpacity: style.fillOpacity ?? 1,
        fill: style.fill ?? true, stroke: style.stroke ?? true, smoothFactor: 0,
        renderer,
      };
    },
    pointToLayer: (feature, latlng) => Leaflet.circleMarker(latlng, {
      // The source points have no icon. Keep an invisible hit target for their readout.
      renderer, radius: 4, stroke: false, opacity: 0, fillOpacity: 0,
    }),
    onEachFeature: (feature, featureLayer) => {
      const props = feature.properties as KmlProperties;
      if (feature.geometry.type === "Point") {
        const [lng, lat, altitude] = feature.geometry.coordinates;
        featureLayer.bindTooltip(escapeHtml(props.name), {
          permanent: true, direction: "center", className: props.sounding ? "kmz-depth-label" : "kmz-contour-label", opacity: 1,
        });
        featureLayer.bindPopup(`<div dir="rtl"><b>خور عبد الله <bdi dir="ltr">11-13</bdi></b><br>${escapeHtml(props.name)}${props.sounding ? ` — ${Math.abs(altitude)} m` : ""}<br><bdi dir="ltr">${lat}, ${lng}</bdi></div>`);
      } else {
        featureLayer.bindTooltip(escapeHtml(props.name), { sticky: true });
      }
    },
  });
  const updateLabels = () => {
    map.getContainer().classList.toggle("kmz-labels-visible", map.getZoom() >= 16);
  };
  layer.on("add", () => {
    map.on("zoomend", updateLabels);
    updateLabels();
  });
  layer.on("remove", () => {
    map.off("zoomend", updateLabels);
    map.getContainer().classList.remove("kmz-labels-visible");
  });
  return layer;
}
