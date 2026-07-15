// Public dashboard JavaScript.
// This file loads station and product JSON through Flask API endpoints and then
// creates all visible dashboard elements dynamically.

const appState = {
  stations: [],
  products: [],
  productTypes: {},
  selectedStation: null,
  map: null,
  markers: new Map(),
  mapLayers: [],
  temporaryMapLayers: [],
  mapLayerObjects: new Map(),
  mapLayerVisibility: new Map(),
  selectedRing: null,
  uvwCharts: {},
  uvwLevels: [],
  windBarbChart: null,
  windBarbPayload: null,
  windBarbHoverPoints: [],
  windBarbHoverPoint: null,
  compareCharts: [],
  basemaps: {},
  activeBasemapName: "Esri World Imagery",
  currentBasemapLayer: null,
  activeView: "dashboard",
  adminPanelInitialized: false,
  compareRenderToken: 0,
  productSelectionSubmitted: false
};

const PREVIEW_TILE = { z: 6, x: 45, y: 28 };

const BASEMAP_THUMB_URLS = {
  "Esri World Imagery": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  "Esri Topographic": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
  "Esri Terrain": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}",
  "Esri Streets": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  "OpenStreetMap": "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
};

const BASEMAP_OPTIONS = [
  { key: "Esri World Imagery", label: "Satellite", preview: "preview-satellite", featured: true },
  { key: "Esri Topographic", label: "Topo", preview: "preview-topo" },
  { key: "Esri Terrain", label: "Terrain", preview: "preview-terrain" },
  { key: "Esri Streets", label: "Streets", preview: "preview-streets" },
  { key: "OpenStreetMap", label: "OSM", preview: "preview-osm" }
];

const FEATURED_BASEMAP = BASEMAP_OPTIONS.find((option) => option.featured);
const DETAIL_BASEMAPS = BASEMAP_OPTIONS.filter((option) => !option.featured);

const MAP_LAYOUT_ANIMATION_MS = 1000;

const PRODUCT_AVAILABILITY = "Availability";
const PRODUCT_UVW = "Derived UVW";
const PRODUCT_UVW_COMPONENTS = "UVW";
const PRODUCT_WIND_BARB = "Wind Barb";
const PRODUCT_DETAILED = "Product Detailed";
const DEFAULT_PRODUCT_TYPES = {
  [PRODUCT_AVAILABILITY]: "availability",
  [PRODUCT_UVW]: "derived_uvw",
  [PRODUCT_UVW_COMPONENTS]: "uvw",
  [PRODUCT_WIND_BARB]: "wind_barb",
  [PRODUCT_DETAILED]: "product_detailed",
};
const THEME_STORAGE_KEY = "windprofiler:theme";
const COMPARE_DATEWISE = "datewise";
const COMPARE_STATIONWISE = "stationwise";

function getIndiaViewBounds() {
  return L.latLngBounds([5.0, 67.0], [37.5, 98.5]);
}

const fieldLabels = {
  current_source: "Current Source",
  file_name: "File Name",
  raw_processed_data: "Raw / Processed Data",
  wind_height: "Height of Wind",
  latitude: "Latitude",
  longitude: "Longitude"
};

function getElement(id) {
  return document.getElementById(id);
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function chartPalette() {
  return {
    bg: cssVar("--chart-bg", "#ffffff"),
    plotBg: cssVar("--chart-plot-bg", "#ffffff"),
    border: cssVar("--chart-border", "#111827"),
    grid: cssVar("--chart-grid", "#b8b8b8"),
    text: cssVar("--chart-text", "#111827"),
    speed: cssVar("--chart-speed", "#111111"),
    direction: cssVar("--chart-direction", "#ff9900"),
    shear: cssVar("--chart-shear", "#ff00e6"),
    hover: cssVar("--chart-hover", "#2563eb"),
    hoverGrid: cssVar("--chart-hover-grid", "rgba(37, 99, 235, .38)"),
    hoverFill: cssVar("--chart-hover-fill", "rgba(37, 99, 235, .16)"),
  };
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    console.error(error);
  }
}

function updateThemeToggleButton() {
  const button = getElement("themeToggleButton");
  if (!button) {
    return;
  }
  const isLight = document.documentElement.dataset.theme === "light";
  const nextTheme = isLight ? "dark" : "light";
  button.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
  button.setAttribute("title", `Switch to ${nextTheme} mode`);
  button.setAttribute("aria-pressed", isLight ? "true" : "false");
}

function refreshThemeSensitiveVisuals() {
  if (appState.uvwLevels.length) {
    renderUvwImages(appState.uvwLevels);
  }
  if (appState.windBarbPayload) {
    renderWindBarbImage(appState.windBarbPayload);
  }
  if (appState.selectedStation) {
    highlightMarker(appState.selectedStation);
  }
  appState.map?.invalidateSize({ animate: false });
}

function applyTheme(theme, refreshVisuals = true) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  saveTheme(nextTheme);
  updateThemeToggleButton();
  if (refreshVisuals) {
    refreshThemeSensitiveVisuals();
  }
}

function initializeTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light", false);
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

async function apiGet(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Unable to load ${path}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function labelFromKey(key) {
  return fieldLabels[key] || key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatValue(value) {
  if (value === null) {
    return "null";
  }
  if (value === undefined || value === "") {
    return "-";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function isActive(station) {
  return String(station.status || "").toLowerCase() === "active";
}

function stationName(station) {
  return station.station_name || station.name || "Unnamed Station";
}

function stationId(station) {
  return station.station_id || station.id || stationName(station);
}

function stationCoordinates(station) {
  const latitude = Number(station.latitude);
  const longitude = Number(station.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return [latitude, longitude];
}

function renderHeaderStats(summary) {
  getElement("totalStations").textContent = summary.total;
  getElement("activeStations").textContent = summary.active;
  getElement("inactiveStations").textContent = summary.inactive;
  getElement("activeStationNames").innerHTML = summary.active_names.map(escapeHtml).join("<br>");
  getElement("inactiveStationNames").innerHTML = summary.inactive_names.map(escapeHtml).join("<br>");
}

function dateOffsetIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(dateValue) {
  if (!dateValue) {
    return null;
  }
  const [year, month, day] = String(dateValue).split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function populateTimeSelectors() {
  const today = dateOffsetIso();
  const datePicker = getElement("datePicker");
  if (datePicker) datePicker.value = today;
  const compareStartDate = getElement("compareStartDate");
  if (compareStartDate) compareStartDate.value = dateOffsetIso(-5);
  const compareEndDate = getElement("compareEndDate");
  if (compareEndDate) compareEndDate.value = today;
}

function syncCompareEndDateFromStart() {
  const start = parseIsoDate(getElement("compareStartDate")?.value);
  const endInput = getElement("compareEndDate");
  if (!start || !endInput) {
    return;
  }
  const inclusiveSixDayEnd = new Date(start);
  inclusiveSixDayEnd.setDate(inclusiveSixDayEnd.getDate() + 5);
  endInput.value = formatIsoDate(inclusiveSixDayEnd);
}

function populateStationControls() {
  getElement("stationOptions").innerHTML = appState.stations.map((station) => {
    return `<option value="${escapeHtml(stationName(station))}"></option>`;
  }).join("");
  renderCompareStationControls();
}

function renderCompareStationControls() {
  const container = getElement("compareStationList");
  if (!container) {
    return;
  }

  const checkedIds = new Set(
    Array.from(container.querySelectorAll("input[type='checkbox']:checked"))
      .map((input) => input.value)
  );
  const hasExistingSelection = checkedIds.size > 0;

  container.innerHTML = appState.stations.map((station) => {
    const id = stationId(station);
    const checked = hasExistingSelection ? checkedIds.has(id) : true;
    return `
      <label class="checkbox-item">
        <input type="checkbox" value="${escapeHtml(id)}" ${checked ? "checked" : ""}>
        <span>${escapeHtml(stationName(station))}</span>
      </label>
    `;
  }).join("");
}

function renderProducts() {
  getElement("productList").innerHTML = appState.products.map((product, index) => {
    const id = `product-${index}`;
    return `
      <label class="checkbox-item">
        <input type="checkbox" value="${escapeHtml(product)}">
        <span>${escapeHtml(product)}</span>
      </label>
    `;
  }).join("");
}

function isProductChecked(productName) {
  const expectedType = DEFAULT_PRODUCT_TYPES[productName];
  return Array.from(document.querySelectorAll("#productList input[type='checkbox']:checked"))
    .some((checkbox) => {
      return checkbox.value === productName
        || (expectedType && productType(checkbox.value) === expectedType);
    });
}

function productType(productName) {
  return appState.productTypes[productName]
    || DEFAULT_PRODUCT_TYPES[productName]
    || "custom";
}

function isDashboardProduct(productName) {
  return productType(productName) !== "custom";
}

function getActiveProductView() {
  if (!appState.productSelectionSubmitted) {
    return null;
  }
  if (isProductChecked(PRODUCT_WIND_BARB)) {
    return "windBarb";
  }
  if (isProductChecked(PRODUCT_UVW_COMPONENTS)) {
    return "uvw";
  }
  if (isProductChecked(PRODUCT_UVW)) {
    return "uvw";
  }
  if (isProductChecked(PRODUCT_AVAILABILITY)) {
    return "availability";
  }
  if (isProductChecked(PRODUCT_DETAILED)) {
    return "productDetailed";
  }
  return null;
}

function getActiveProductNameFromSelection() {
  if (isProductChecked(PRODUCT_WIND_BARB)) {
    return checkedProductNameForType("wind_barb", PRODUCT_WIND_BARB);
  }
  if (isProductChecked(PRODUCT_UVW_COMPONENTS)) {
    return checkedProductNameForType("uvw", PRODUCT_UVW_COMPONENTS);
  }
  if (isProductChecked(PRODUCT_UVW)) {
    return checkedProductNameForType("derived_uvw", PRODUCT_UVW);
  }
  if (isProductChecked(PRODUCT_AVAILABILITY)) {
    return checkedProductNameForType("availability", PRODUCT_AVAILABILITY);
  }
  if (isProductChecked(PRODUCT_DETAILED)) {
    return PRODUCT_DETAILED;
  }
  return "";
}

function checkedProductNameForType(expectedType, fallback) {
  const input = Array.from(document.querySelectorAll("#productList input[type='checkbox']:checked"))
    .find((checkbox) => productType(checkbox.value) === expectedType);
  return input?.value || fallback;
}

function getActiveProductName() {
  if (!appState.productSelectionSubmitted) {
    return "";
  }
  return getActiveProductNameFromSelection();
}

function isCompareModeEnabled() {
  return Boolean(getElement("compareModeToggle")?.checked);
}

function getCompareAxis() {
  return document.querySelector("input[name='compareAxis']:checked")?.value || COMPARE_DATEWISE;
}

function getCompareDates() {
  const start = parseIsoDate(getElement("compareStartDate")?.value);
  const end = parseIsoDate(getElement("compareEndDate")?.value);
  if (!start || !end) {
    return [];
  }

  const rangeStart = start <= end ? start : end;
  const rangeEnd = start <= end ? end : start;
  const dates = [];
  const cursor = new Date(rangeStart);

  while (cursor <= rangeEnd && dates.length < 31) {
    dates.push(formatIsoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function getCompareStations() {
  const checkedIds = new Set(
    Array.from(document.querySelectorAll("#compareStationList input[type='checkbox']:checked"))
      .map((input) => input.value)
  );
  return appState.stations.filter((station) => checkedIds.has(stationId(station)));
}

function syncCompareControls() {
  const compareEnabled = isCompareModeEnabled();
  const axis = getCompareAxis();
  getElement("compareAxisFields")?.classList.toggle("hidden", !compareEnabled);
  getElement("compareDateFields")?.classList.toggle("hidden", !compareEnabled || axis !== COMPARE_DATEWISE);
  getElement("compareStationFields")?.classList.toggle("hidden", !compareEnabled || axis !== COMPARE_STATIONWISE);
}

function resetSubmittedProductSelection() {
  appState.productSelectionSubmitted = false;
  updateWorkspacePanelVisibility(true);
}

function submitProductSelection() {
  appState.productSelectionSubmitted = Boolean(getActiveProductNameFromSelection());
  updateWorkspacePanelVisibility(true);
}

function updateWorkspacePanelVisibility(animate = false) {
  const activeView = getActiveProductView();
  const compareMode = isCompareModeEnabled() && Boolean(activeView);
  const showPanel = Boolean(activeView);
  getElement("workspaceContainer")?.classList.toggle("show-availability", showPanel && !compareMode);
  getElement("workspaceContainer")?.classList.toggle("compare-mode", compareMode);
  getElement("comparisonView")?.classList.toggle("hidden", !compareMode);
  updateAttributePanelView();
  if (animate && !compareMode) {
    animateMapLayoutForIndiaView();
  }
}

function updateAvailabilityPanelVisibility(animate = false) {
  updateWorkspacePanelVisibility(animate);
}

function updateAttributePanelView() {
  const activeView = getActiveProductView();
  const compareMode = isCompareModeEnabled() && Boolean(activeView);

  getElement("availabilityView")?.classList.toggle("hidden", compareMode || activeView !== "availability");
  getElement("uvwView")?.classList.toggle("hidden", compareMode || activeView !== "uvw");
  getElement("windBarbView")?.classList.toggle("hidden", compareMode || activeView !== "windBarb");
  getElement("productDetailedView")?.classList.toggle("hidden", compareMode || activeView !== "productDetailed");

  const title = getElement("attributePanelTitle");
  if (title) {
    if (compareMode) {
      title.textContent = "Product Comparison";
    } else if (activeView === "windBarb") {
      title.textContent = "Wind Barb Profile";
    } else if (activeView === "uvw") {
      title.textContent = isProductChecked(PRODUCT_UVW_COMPONENTS)
        ? "Zonal / Meridional / Vertical Wind"
        : "Wind Speed / Direction / Shear";
    } else if (activeView === "productDetailed") {
      title.textContent = "Current Data Information";
    } else {
      title.textContent = "Station Availability & Attribute Data";
    }
  }

  if (compareMode) {
    renderComparisonView();
  } else if (activeView === "windBarb") {
    loadWindBarbProductCard();
  } else if (activeView === "uvw") {
    loadUvwProductCard();
  } else if (activeView === "availability") {
    renderAttributeTable(appState.selectedStation);
  } else if (activeView === "productDetailed") {
    renderProductDetailedView(appState.selectedStation);
  }
}

function refreshActiveProductCard() {
  updateAttributePanelView();
}

function animateMapLayoutForIndiaView() {
  if (!appState.map) {
    return;
  }

  const indiaBounds = getIndiaViewBounds();
  const refreshSteps = [0, 200, 400, 600, 800, MAP_LAYOUT_ANIMATION_MS];

  refreshSteps.forEach((delay) => {
    window.setTimeout(() => {
      appState.map.invalidateSize({ animate: false });
    }, delay);
  });

  window.setTimeout(() => {
    appState.map.invalidateSize({ animate: false });
    appState.map.flyToBounds(indiaBounds, {
      padding: [20, 20],
      duration: MAP_LAYOUT_ANIMATION_MS / 1000,
      easeLinearity: 0.25
    });
  }, 60);
}

function renderCurrentDataInformation(station) {
  const container = getElement("currentDataInformation");

  if (!container) {
    return;
  }

  const keys = [
    "current_source",
    "file_name",
    "raw_processed_data",
    "wind_height",
    "latitude",
    "longitude"
  ];

  container.innerHTML = keys.map((key) => `
        <dt>${escapeHtml(labelFromKey(key))}</dt>
        <dd>${escapeHtml(formatValue(station ? station[key] : ""))}</dd>
    `).join("");
}

function renderProductDetailedView(station) {
  const detailValues = {
    detailSource: station?.current_source || "Radar wind profiler feed",
    detailFileName: station?.file_name || "NOT GIVEN",
    detailDataType: station?.raw_processed_data || "Processed Data",
    detailHeight: station?.wind_height || "-",
    detailLatitude: station?.latitude || "-",
    detailLongitude: station?.longitude || "-",
  };

  Object.entries(detailValues).forEach(([id, value]) => {
    const element = getElement(id);
    if (element) {
      element.textContent = formatValue(value);
    }
  });
}

function renderAttributeTable(station) {
  if (!station) {
    getElement("selectedStationBadge").textContent = "No station selected";
    getElement("attributeTableBody").innerHTML = `
      <tr>
        <td colspan="2">Select a station to view attributes.</td>
      </tr>
    `;
    return;
  }

  getElement("selectedStationBadge").textContent = `${stationName(station)} (${stationId(station)})`;

  // Dynamic station attributes: every key in the station JSON becomes a row.
  getElement("attributeTableBody").innerHTML = Object.entries(station).map(([key, value]) => `
    <tr>
      <td>${escapeHtml(labelFromKey(key))}</td>
      <td>${escapeHtml(formatValue(value))}</td>
    </tr>
  `).join("");
}

function getSelectedTimeFilters(overrides = {}) {
  return {
    date: overrides.date ?? getElement("datePicker")?.value ?? ""
  };
}

async function fetchStationUvwPayload(station, filters = getSelectedTimeFilters()) {
  const { date } = filters;
  const query = new URLSearchParams({ date }).toString();
  return apiGet(`/api/stations/${encodeURIComponent(stationId(station))}/uvw?${query}`);
}

function normalizeWindLevels(levels) {
  return (levels || [])
    .map((level) => {
      const heightKm = Number(level.height_km ?? Number(level.height_m) / 1000);
      const u = Number(level.u);
      const v = Number(level.v);
      const w = Number(level.w);
      if (
        !Number.isFinite(heightKm)
        || !Number.isFinite(u)
        || !Number.isFinite(v)
        || Math.abs(u) > 200
        || Math.abs(v) > 200
        || (Number.isFinite(w) && Math.abs(w) > 200)
      ) {
        return null;
      }
      const speed = Math.hypot(u, v);
      const direction = (Math.atan2(u, v) * 180 / Math.PI + 180 + 360) % 360;
      return { heightKm, u, v, w: Number.isFinite(w) ? w : null, speed, direction };
    })
    .filter(Boolean)
    .sort((a, b) => a.heightKm - b.heightKm);
}

function addWindShear(profile) {
  return profile.map((point, index) => {
    const previous = profile[Math.max(0, index - 1)];
    const next = profile[Math.min(profile.length - 1, index + 1)];
    const dzMeters = (next.heightKm - previous.heightKm) * 1000;
    const shear = dzMeters ? (next.speed - previous.speed) / dzMeters : 0;
    return { ...point, shear };
  });
}

function niceBounds(values, includeZero = false, paddingRatio = 0.08) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) {
    return [-1, 1];
  }
  let minValue = Math.min(...finite);
  let maxValue = Math.max(...finite);
  if (includeZero) {
    minValue = Math.min(minValue, 0);
    maxValue = Math.max(maxValue, 0);
  }
  if (minValue === maxValue) {
    const pad = Math.max(Math.abs(minValue) * 0.2, 1);
    return [minValue - pad, maxValue + pad];
  }
  const pad = (maxValue - minValue) * paddingRatio;
  return [minValue - pad, maxValue + pad];
}

function buildProfileChartImage(points, valueKey, title, xLabel, color, options = {}) {
  const palette = chartPalette();
  const width = 320;
  const height = 500;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || !points.length) {
    return "";
  }

  const padding = { top: 44, right: 18, bottom: 58, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const heights = points.map((point) => point.heightKm);
  const values = points.map((point) => Number(point[valueKey]));
  const minHeight = options.yMin ?? Math.min(0, Math.min(...heights));
  const maxHeight = options.yMax ?? Math.max(20, Math.max(...heights));
  const [autoMin, autoMax] = niceBounds(values, options.includeZero ?? false);
  const xMin = options.xMin ?? autoMin;
  const xMax = options.xMax ?? autoMax;

  const toX = (value) => padding.left + ((value - xMin) / (xMax - xMin || 1)) * plotWidth;
  const toY = (value) => padding.top + plotHeight - ((value - minHeight) / (maxHeight - minHeight || 1)) * plotHeight;

  context.fillStyle = palette.bg;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = palette.grid;
  context.lineWidth = 1;
  for (let tick = Math.ceil(minHeight / 2.5) * 2.5; tick <= maxHeight; tick += 2.5) {
    const y = toY(tick);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
  const xTicks = options.xTicks || Array.from({ length: 5 }, (_, index) => {
    return xMin + ((xMax - xMin) / 4) * index;
  });
  xTicks.forEach((tick) => {
    const x = toX(tick);
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, height - padding.bottom);
    context.stroke();
  });

  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => {
    const x = toX(values[index]);
    const y = toY(point.heightKm);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.strokeRect(padding.left, padding.top, plotWidth, plotHeight);

  context.fillStyle = palette.text;
  context.font = "16px Arial, sans-serif";
  context.textAlign = "center";
  context.fillText(title, width / 2, 24);

  context.font = "12px Arial, sans-serif";
  context.fillText(xLabel, padding.left + plotWidth / 2, height - 16);

  context.save();
  context.translate(16, padding.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("Height (km)", 0, 0);
  context.restore();

  context.font = "11px Arial, sans-serif";
  context.textAlign = "right";
  for (let tick = Math.ceil(minHeight / 2.5) * 2.5; tick <= maxHeight; tick += 2.5) {
    context.fillText(tick.toFixed(1), padding.left - 8, toY(tick) + 4);
  }
  context.textAlign = "center";
  xTicks.forEach((tick) => {
    const label = options.formatX ? options.formatX(tick) : tick.toFixed(1);
    context.fillText(label, toX(tick), height - padding.bottom + 18);
  });

  return "";
}

function renderUvwImages(levels) {
  const profile = addWindShear(normalizeWindLevels(levels));
  const imageMap = {
    uvwImageU: buildProfileChartImage(
      profile,
      "speed",
      "Wind Speed",
      "Wind Speed (m/s)",
      "#111111",
      { xMin: 0, xTicks: [0, 10, 20, 30], yMin: 0, yMax: 20 }
    ),
    uvwImageV: buildProfileChartImage(
      profile,
      "direction",
      "Wind Direction",
      "Wind Direction",
      "#ff9900",
      {
        xMin: 0,
        xMax: 360,
        xTicks: [0, 90, 180, 270, 360],
        yMin: 0,
        yMax: 20,
        formatX: (value) => `${Math.round(value)}°`
      }
    ),
    uvwImageW: buildProfileChartImage(
      profile,
      "shear",
      "Wind Shear",
      "dV/dz (s⁻¹)",
      "#ff00e6",
      { xMin: -0.1, xMax: 0.1, xTicks: [-0.1, -0.05, 0, 0.05, 0.1], yMin: 0, yMax: 20 }
    )
  };

  Object.entries(imageMap).forEach(([elementId, imageUrl]) => {
    const image = getElement(elementId);
    if (!image) {
      return;
    }
    if (imageUrl) {
      image.src = imageUrl;
      image.classList.remove("hidden");
    } else {
      image.removeAttribute("src");
      image.classList.add("hidden");
    }
  });

  getElement("uvwImageGrid")?.classList.toggle("hidden", !profile.length);
}

function destroyUvwCharts() {
  Object.values(appState.uvwCharts).forEach((chart) => chart?.destroy());
  appState.uvwCharts = {};
}

function createProfileChart(canvasId, points, valueKey, label, color, options = {}) {
  const canvas = getElement(canvasId);
  if (!canvas || typeof Chart === "undefined") {
    return null;
  }
  const palette = chartPalette();

  const values = points.map((point) => Number(point[valueKey]));
  const [autoMin, autoMax] = niceBounds(values, options.includeZero ?? false);
  const xMin = options.xMin ?? autoMin;
  const xMax = options.xMax ?? autoMax;

  return new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [{
        label,
        data: points.map((point) => ({
          x: Number(point[valueKey]),
          y: point.heightKm,
        })),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 12,
        showLine: true,
        tension: 0.15,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        intersect: false,
        mode: "nearest",
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: label,
          color: palette.text,
          font: { size: 16, weight: "normal" },
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const xValue = options.tooltipX
                ? options.tooltipX(context.parsed.x)
                : context.parsed.x.toFixed(3);
              return `${options.xLabel}: ${xValue}, Height: ${context.parsed.y.toFixed(2)} km`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: xMin,
          max: xMax,
          title: {
            display: true,
            text: options.xLabel,
            color: palette.text,
          },
          ticks: {
            color: palette.text,
            stepSize: options.stepSize,
            callback: options.tickLabel,
          },
          grid: {
            color: palette.grid,
          },
        },
        y: {
          type: "linear",
          min: options.yMin ?? 0,
          max: options.yMax ?? 20,
          title: {
            display: true,
            text: "Height (km)",
            color: palette.text,
          },
          ticks: {
            color: palette.text,
            stepSize: 2.5,
          },
          grid: {
            color: palette.grid,
          },
        },
      },
    },
  });
}

function drawFallbackProfileChart(canvasId, points, valueKey, label, color, options = {}) {
  const canvas = getElement(canvasId);
  if (!canvas || !points.length) {
    return;
  }
  drawProfileChartCanvas(canvas, points, valueKey, label, color, options);
}

function drawProfileChartCanvas(canvas, points, valueKey, label, color, options = {}) {
  if (!canvas || !points.length) {
    return;
  }
  const palette = chartPalette();

  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(280, Math.round(rect.width || 320));
  const height = Math.max(380, Math.round(rect.height || 420));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const values = points.map((point) => Number(point[valueKey]));
  const [autoMin, autoMax] = niceBounds(values, options.includeZero ?? false);
  const xMin = options.xMin ?? autoMin;
  const xMax = options.xMax ?? autoMax;
  const yMin = options.yMin ?? 0;
  const yMax = options.yMax ?? 20;
  const padding = { top: 42, right: 18, bottom: 54, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const toX = (value) => padding.left + ((value - xMin) / (xMax - xMin || 1)) * plotWidth;
  const toY = (value) => padding.top + plotHeight - ((value - yMin) / (yMax - yMin || 1)) * plotHeight;

  context.fillStyle = palette.bg;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = palette.grid;
  context.lineWidth = 1;
  for (let tick = yMin; tick <= yMax; tick += 2.5) {
    const y = toY(tick);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
  for (let tick = xMin; tick <= xMax + 1e-9; tick += options.stepSize || ((xMax - xMin) / 4)) {
    const x = toX(tick);
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, height - padding.bottom);
    context.stroke();
  }

  context.strokeStyle = palette.border;
  context.strokeRect(padding.left, padding.top, plotWidth, plotHeight);

  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => {
    const x = toX(Number(point[valueKey]));
    const y = toY(point.heightKm);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.stroke();

  context.fillStyle = palette.text;
  context.font = "16px Arial, sans-serif";
  context.textAlign = "center";
  context.fillText(label, width / 2, 24);
  context.font = "12px Arial, sans-serif";
  context.fillText(options.xLabel || "", padding.left + plotWidth / 2, height - 14);

  context.save();
  context.translate(16, padding.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("Height (km)", 0, 0);
  context.restore();

  context.font = "11px Arial, sans-serif";
  context.textAlign = "right";
  for (let tick = yMin; tick <= yMax; tick += 2.5) {
    context.fillText(tick.toFixed(1), padding.left - 8, toY(tick) + 4);
  }

  context.textAlign = "center";
  for (let tick = xMin; tick <= xMax + 1e-9; tick += options.stepSize || ((xMax - xMin) / 4)) {
    const labelText = options.tickLabel ? options.tickLabel(tick) : Number(tick).toFixed(2);
    context.fillText(labelText, toX(tick), height - padding.bottom + 18);
  }
}

function renderUvwImages(levels) {
  const profile = addWindShear(normalizeWindLevels(levels));
  const palette = chartPalette();
  appState.uvwLevels = levels || [];
  destroyUvwCharts();

  if (!profile.length) {
    getElement("uvwImageGrid")?.classList.toggle("hidden", true);
    return;
  }

  getElement("uvwImageGrid")?.classList.toggle("hidden", false);

  const showComponents = isProductChecked(PRODUCT_UVW_COMPONENTS);
  const componentLimit = (key, minimum, interval) => {
    const values = profile.map((point) => Math.abs(Number(point[key]))).filter(Number.isFinite);
    return Math.max(minimum, Math.ceil(Math.max(0, ...values) / interval) * interval);
  };
  const chartSpecs = showComponents
    ? [
        {
          canvasId: "uvwChartSpeed",
          stateKey: "u",
          valueKey: "u",
          label: "East-West (Zonal U)",
          color: "#2563eb",
          options: {
            xMin: -componentLimit("u", 20, 5),
            xMax: componentLimit("u", 20, 5),
            xLabel: "Zonal Wind U (m/s)",
            stepSize: 10,
            yMin: 0,
            yMax: 20,
            tooltipX: (value) => `${value.toFixed(2)} m/s`,
          },
        },
        {
          canvasId: "uvwChartDirection",
          stateKey: "v",
          valueKey: "v",
          label: "North-South (Meridional V)",
          color: "#7e22ce",
          options: {
            xMin: -componentLimit("v", 20, 5),
            xMax: componentLimit("v", 20, 5),
            xLabel: "Meridional Wind V (m/s)",
            stepSize: 10,
            yMin: 0,
            yMax: 20,
            tooltipX: (value) => `${value.toFixed(2)} m/s`,
          },
        },
        {
          canvasId: "uvwChartShear",
          stateKey: "w",
          valueKey: "w",
          label: "Vertical W",
          color: "#16a34a",
          options: {
            xMin: -componentLimit("w", 8, 2),
            xMax: componentLimit("w", 8, 2),
            xLabel: "Vertical Wind W (m/s)",
            stepSize: 4,
            yMin: 0,
            yMax: 20,
            tooltipX: (value) => `${value.toFixed(3)} m/s`,
          },
        },
      ]
    : [
        {
          canvasId: "uvwChartSpeed",
          stateKey: "speed",
          valueKey: "speed",
          label: "Wind Speed",
          color: palette.speed,
          options: {
            xMin: 0,
            xMax: Math.max(30, Math.ceil(Math.max(...profile.map((point) => point.speed)) / 10) * 10),
            xLabel: "Wind Speed (m/s)",
            stepSize: 10,
            yMin: 0,
            yMax: 20,
            tooltipX: (value) => `${value.toFixed(2)} m/s`,
          },
        },
        {
          canvasId: "uvwChartDirection",
          stateKey: "direction",
          valueKey: "direction",
          label: "Wind Direction",
          color: palette.direction,
          options: {
            xMin: 0,
            xMax: 360,
            xLabel: "Wind Direction",
            stepSize: 90,
            yMin: 0,
            yMax: 20,
            tickLabel: (value) => `${Math.round(value)} deg`,
            tooltipX: (value) => `${value.toFixed(0)} deg`,
          },
        },
        {
          canvasId: "uvwChartShear",
          stateKey: "shear",
          valueKey: "shear",
          label: "Wind Shear",
          color: palette.shear,
          options: {
            xMin: -0.1,
            xMax: 0.1,
            xLabel: "dV/dz (s^-1)",
            stepSize: 0.05,
            yMin: 0,
            yMax: 20,
            tooltipX: (value) => `${value.toFixed(4)} s^-1`,
          },
        },
      ];

  ["uvwChartSpeedLabel", "uvwChartDirectionLabel", "uvwChartShearLabel"].forEach((id, index) => {
    const element = getElement(id);
    if (element) {
      element.textContent = chartSpecs[index].label;
    }
    getElement(chartSpecs[index].canvasId)?.setAttribute("aria-label", `${chartSpecs[index].label} profile`);
  });

  if (typeof Chart === "undefined") {
    chartSpecs.forEach((spec) => {
      drawFallbackProfileChart(spec.canvasId, profile, spec.valueKey, spec.label, spec.color, spec.options);
    });
    return;
  }

  chartSpecs.forEach((spec) => {
    appState.uvwCharts[spec.stateKey] = createProfileChart(
      spec.canvasId,
      profile,
      spec.valueKey,
      spec.label,
      spec.color,
      spec.options
    );
  });

  requestAnimationFrame(() => {
    Object.values(appState.uvwCharts).forEach((chart) => {
      chart?.resize();
      chart?.update("none");
    });
  });
}

function setUvwCardMessage(message, showGrid = false) {
  const emptyMessage = getElement("uvwEmptyMessage");
  if (emptyMessage) {
    emptyMessage.textContent = message;
    emptyMessage.classList.toggle("hidden", !message);
  }
  if (!showGrid) {
    appState.uvwLevels = [];
  }
  getElement("uvwImageGrid")?.classList.toggle("hidden", !showGrid);
}

async function loadUvwProductCard() {
  const station = appState.selectedStation;
  const title = getElement("uvwCardTitle");
  const meta = getElement("uvwCardMeta");
  const badge = getElement("uvwCycleBadge");
  const showComponents = isProductChecked(PRODUCT_UVW_COMPONENTS);
  const profileTitle = showComponents ? "Zonal / Meridional / Vertical Profiles" : "Derived UVW Profiles";

  if (!station) {
    if (title) {
      title.textContent = profileTitle;
    }
    if (meta) {
      meta.textContent = "Select a station from the map or station list.";
    }
    if (badge) {
      badge.textContent = "--";
    }
    setUvwCardMessage(`Please select a station to view ${showComponents ? "UVW component" : "derived"} profile charts.`);
    renderUvwImages([]);
    return;
  }

  if (title) {
    title.textContent = `${stationName(station)} - ${profileTitle}`;
  }
  if (meta) {
    meta.textContent = "Loading wind profiler data...";
  }
  setUvwCardMessage("");

  try {
    const payload = await fetchStationUvwPayload(station);
    if (!payload.available) {
      if (meta) {
        meta.textContent = payload.message || "No profiler data available for this station.";
      }
      if (badge) {
        badge.textContent = "N/A";
      }
      setUvwCardMessage(payload.message || "No U/V/W data found for the selected date.");
      renderUvwImages([]);
      return;
    }

    const timestamp = payload.timestamp || `${payload.date || ""} ${payload.time || ""}`.trim();
    if (meta) {
      meta.textContent = `${payload.file_name || "Profiler file"} · ${timestamp || "Latest cycle"}`;
    }
    if (badge) {
      badge.textContent = `${payload.levels?.length || 0} levels`;
    }

    renderUvwImages(payload.levels || []);
    setUvwCardMessage("", true);
  } catch (error) {
    if (meta) {
      meta.textContent = `Unable to load ${showComponents ? "UVW component" : "derived"} data.`;
    }
    if (badge) {
      badge.textContent = "Error";
    }
    setUvwCardMessage(`${showComponents ? "UVW component" : "Derived wind"} data could not be loaded. Try another station or date.`);
    renderUvwImages([]);
  }
}

async function fetchStationWindBarbPayload(station, filters = getSelectedTimeFilters()) {
  const { date } = filters;
  const query = new URLSearchParams({ date }).toString();
  return apiGet(`/api/stations/${encodeURIComponent(stationId(station))}/wind-barb?${query}`);
}

function setComparisonMessage(message) {
  const element = getElement("comparisonMessage");
  if (element) {
    element.textContent = message || "";
    element.classList.toggle("hidden", !message);
  }
}

function comparisonTableHtml(rows) {
  return `
    <div class="compare-table-wrap">
      <table>
        <tbody>
          ${rows.map(([label, value]) => `
            <tr>
              <th>${escapeHtml(label)}</th>
              <td>${escapeHtml(formatValue(value))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function destroyCompareCharts() {
  appState.compareCharts.forEach((chart) => {
    if (chart?.destroy) {
      chart.destroy();
      return;
    }
    if (chart?.plotlyElement && typeof Plotly !== "undefined") {
      Plotly.purge(chart.plotlyElement);
    }
  });
  appState.compareCharts = [];
}

function summarizeUvwPayload(payload) {
  const profile = addWindShear(normalizeWindLevels(payload?.levels || []));
  if (!payload?.available || !profile.length) {
    return null;
  }
  return { levels: profile.length };
}

function windBarbLevels(payload) {
  return [
    ...(payload?.morning?.levels || []),
    ...(payload?.evening?.levels || []),
  ];
}

function summarizeWindBarbPayload(payload) {
  const profile = normalizeWindLevels(windBarbLevels(payload));
  if (!payload?.available || !profile.length) {
    return null;
  }

  return {
    levels: profile.length,
  };
}

function compareAxisLabel(axis = getCompareAxis()) {
  return axis === COMPARE_STATIONWISE ? "Stations" : "Dates";
}

function getComparisonItems(axis = getCompareAxis()) {
  if (axis === COMPARE_STATIONWISE) {
    const date = getElement("datePicker")?.value || dateOffsetIso();
    return getCompareStations().map((station) => ({
      label: stationName(station),
      station,
      date,
    }));
  }

  return getCompareDates().map((date) => ({
    label: date,
    station: appState.selectedStation,
    date,
  }));
}

function compareGraphCardHtml(productName, axis) {
  return `
    <article class="compare-card compare-graph-card">
      <div class="compare-card-head">
        <div>
          <p class="uvw-kicker">${escapeHtml(productName || "Product")}</p>
          <h3>${escapeHtml(axis === COMPARE_STATIONWISE ? "Station-wise Comparison" : stationName(appState.selectedStation))}</h3>
        </div>
        <span class="compare-date">${escapeHtml(compareAxisLabel(axis))}</span>
      </div>
      <div data-compare-summary>
        <p class="compare-empty">Loading ${escapeHtml(productName || "product")}...</p>
      </div>
    </article>
  `;
}

function comparisonChartHtml(specs) {
  return `
    <div class="compare-chart-stack compare-summary-stack">
      ${specs.map((spec) => `
        <div class="compare-chart compare-summary-chart">
          <div class="compare-summary-plot" data-compare-summary-chart="${spec.key}" aria-label="${escapeHtml(spec.label)}"></div>
          <span>${escapeHtml(spec.label)}</span>
        </div>
      `).join("")}
    </div>
    <button type="button" class="compare-export-button" data-compare-export>Export Data</button>
  `;
}

function drawFallbackComparisonChart(element, labels, values, spec, xLabel) {
  if (!element) {
    return;
  }
  element.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.className = "compare-summary-fallback";
  element.appendChild(canvas);

  const palette = chartPalette();
  const rect = element.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(300, Math.round(rect.width || 420));
  const height = Math.max(210, Math.round(rect.height || 240));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const finiteValues = values.filter(Number.isFinite);
  const [autoMin, autoMax] = niceBounds(finiteValues, spec.beginAtZero ?? true);
  const maxValue = spec.yMax ?? autoMax;
  const minValue = spec.yMin ?? autoMin;
  const padding = { top: 36, right: 16, bottom: 58, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const slotWidth = plotWidth / Math.max(labels.length, 1);
  const barWidth = Math.max(12, slotWidth * 0.58);
  const toX = (index) => padding.left + slotWidth * index + slotWidth / 2;
  const toY = (value) => padding.top + plotHeight - ((value - minValue) / (maxValue - minValue || 1)) * plotHeight;

  context.fillStyle = palette.bg;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = palette.grid;
  context.lineWidth = 1;
  for (let index = 0; index < 5; index += 1) {
    const y = padding.top + (plotHeight / 4) * index;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + plotWidth, y);
    context.stroke();
  }
  context.strokeStyle = palette.border;
  context.strokeRect(padding.left, padding.top, plotWidth, plotHeight);

  context.fillStyle = spec.color;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      return;
    }
    const x = toX(index) - barWidth / 2;
    const y = toY(value);
    context.fillRect(x, y, barWidth, padding.top + plotHeight - y);
  });

  context.fillStyle = palette.text;
  context.font = "12px Arial, sans-serif";
  context.textAlign = "center";
  context.fillText(spec.label, width / 2, 22);
  context.fillText(xLabel, padding.left + plotWidth / 2, height - 10);
  context.save();
  context.translate(16, padding.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(spec.yLabel, 0, 0);
  context.restore();

  context.font = "10px Arial, sans-serif";
  labels.forEach((label, index) => {
    const x = toX(index);
    context.fillText(String(label).slice(0, 12), x, height - padding.bottom + 20);
  });
}

function plotlyYAxisOptions(spec, palette) {
  const axis = {
    title: { text: spec.yLabel, font: { color: palette.text } },
    tickfont: { color: palette.text },
    gridcolor: palette.grid,
    zerolinecolor: palette.grid,
  };
  if (Number.isFinite(spec.stepSize)) {
    axis.dtick = spec.stepSize;
  }
  if (Number.isFinite(spec.yMin) && Number.isFinite(spec.yMax)) {
    axis.range = [spec.yMin, spec.yMax];
  }
  return axis;
}

function renderComparisonCategoryChart(element, labels, values, spec, xLabel) {
  if (!element) {
    return;
  }

  if (typeof Plotly === "undefined") {
    drawFallbackComparisonChart(element, labels, values, spec, xLabel);
    return;
  }

  const palette = chartPalette();
  const plottedValues = values.map((value) => Number.isFinite(value) ? value : null);
  const hoverValues = plottedValues.map((value) => {
    if (!Number.isFinite(value)) {
      return "No data";
    }
    return spec.format ? spec.format(value) : value.toFixed(2);
  });

  Plotly.newPlot(
    element,
    [{
      type: "bar",
      name: spec.label,
      x: labels,
      y: plottedValues,
      customdata: hoverValues,
      marker: { color: spec.color },
      hovertemplate: `${xLabel}: %{x}<br>${spec.label}: %{customdata}<extra></extra>`,
    }],
    {
      responsive: true,
      autosize: true,
      height: 320,
      paper_bgcolor: palette.bg,
      plot_bgcolor: palette.plotBg,
      margin: { l: 64, r: 24, t: 24, b: 74 },
      dragmode: "pan",
      showlegend: false,
      font: { color: palette.text, family: "Arial, sans-serif" },
      xaxis: {
        type: "category",
        title: { text: xLabel, font: { color: palette.text } },
        tickfont: { color: palette.text },
        tickangle: labels.length > 3 ? -35 : 0,
        gridcolor: palette.grid,
        zerolinecolor: palette.grid,
        automargin: true,
      },
      yaxis: plotlyYAxisOptions(spec, palette),
    },
    {
      responsive: true,
      scrollZoom: true,
      displaylogo: false,
      toImageButtonOptions: {
        format: "png",
        filename: `${spec.key}-comparison`,
        height: 640,
        width: 960,
        scale: 2,
      },
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    }
  );
  appState.compareCharts.push({ plotlyElement: element });
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function comparisonExportFileName(productName, axis) {
  const productSlug = String(productName || "comparison").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const axisSlug = axis === COMPARE_STATIONWISE ? "station-wise" : "date-wise";
  return `${productSlug || "comparison"}-${axisSlug}-comparison.csv`;
}

function buildComparisonCsv(results, specs, axis) {
  const axisLabel = compareAxisLabel(axis);
  const headers = [axisLabel, "Station", "Date", ...specs.map((spec) => spec.label)];
  const rows = results.map((result) => {
    return [
      result.label,
      result.station ? stationName(result.station) : "",
      result.date || "",
      ...specs.map((spec) => {
        const value = result.summary ? result.summary[spec.key] : null;
        return Number.isFinite(value) ? value : "";
      }),
    ];
  });
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function wireComparisonExportButton(container, results, specs, axis, productName) {
  const button = container.querySelector("[data-compare-export]");
  if (!button) {
    return;
  }
  button.addEventListener("click", () => {
    const csv = buildComparisonCsv(results, specs, axis);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = comparisonExportFileName(productName, axis);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}

function comparisonProfileForResult(result) {
  return addWindShear(normalizeWindLevels(result?.payload?.levels || []));
}

function uvwComparisonSpecs(results = [], productName = PRODUCT_UVW) {
  const palette = chartPalette();
  const profiles = results.map((result) => comparisonProfileForResult(result));
  if (productType(productName) === "uvw") {
    const componentLimit = (key, minimum, interval) => {
      const values = profiles
        .flatMap((profile) => profile.map((point) => Math.abs(Number(point[key]))))
        .filter(Number.isFinite);
      return Math.max(minimum, Math.ceil(Math.max(0, ...values) / interval) * interval);
    };
    const uLimit = componentLimit("u", 20, 5);
    const vLimit = componentLimit("v", 20, 5);
    const wLimit = componentLimit("w", 8, 2);
    return [
      {
        key: "u",
        label: "East-West (Zonal U)",
        color: "#2563eb",
        options: { xMin: -uLimit, xMax: uLimit, xLabel: "Zonal Wind U (m/s)", stepSize: 10, yMin: 0, yMax: 20 },
        format: (value) => `${value.toFixed(2)} m/s`,
      },
      {
        key: "v",
        label: "North-South (Meridional V)",
        color: "#7e22ce",
        options: { xMin: -vLimit, xMax: vLimit, xLabel: "Meridional Wind V (m/s)", stepSize: 10, yMin: 0, yMax: 20 },
        format: (value) => `${value.toFixed(2)} m/s`,
      },
      {
        key: "w",
        label: "Vertical W",
        color: "#16a34a",
        options: { xMin: -wLimit, xMax: wLimit, xLabel: "Vertical Wind W (m/s)", stepSize: 4, yMin: 0, yMax: 20 },
        format: (value) => `${value.toFixed(3)} m/s`,
      },
    ];
  }
  const maxSpeed = Math.max(
    30,
    Math.ceil(Math.max(0, ...profiles.flatMap((profile) => profile.map((point) => point.speed))) / 10) * 10,
  );
  return [
    {
      key: "speed",
      label: "Wind Speed",
      color: palette.speed,
      options: { xMin: 0, xMax: maxSpeed, xLabel: "Wind Speed (m/s)", stepSize: 10, yMin: 0, yMax: 20 },
      format: (value) => `${value.toFixed(2)} m/s`,
    },
    {
      key: "direction",
      label: "Wind Direction",
      color: palette.direction,
      options: {
        xMin: 0,
        xMax: 360,
        xLabel: "Wind Direction",
        stepSize: 90,
        yMin: 0,
        yMax: 20,
        tickLabel: (value) => `${Math.round(value)} deg`,
      },
      tickLabel: (value) => `${Math.round(value)} deg`,
      format: (value) => `${value.toFixed(0)} deg`,
    },
    {
      key: "shear",
      label: "Wind Shear",
      color: palette.shear,
      options: { xMin: -0.1, xMax: 0.1, xLabel: "dV/dz (s^-1)", stepSize: 0.05, yMin: 0, yMax: 20 },
      format: (value) => `${value.toFixed(4)} s^-1`,
    },
  ];
}

function buildUvwProfileComparisonCsv(results, specs, axis) {
  const axisLabel = compareAxisLabel(axis);
  const headers = [axisLabel, "Station", "Date", "Height (km)", ...specs.map((spec) => spec.label)];
  const rows = [];

  results.forEach((result) => {
    comparisonProfileForResult(result).forEach((point) => {
      rows.push([
        result.label,
        result.station ? stationName(result.station) : "",
        result.date || "",
        point.heightKm,
        ...specs.map((spec) => {
          const value = Number(point[spec.key]);
          return Number.isFinite(value) ? value : "";
        }),
      ]);
    });
  });

  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function wireUvwProfileExportButton(container, results, specs, axis, productName) {
  const button = container.querySelector("[data-compare-export]");
  if (!button) {
    return;
  }
  button.addEventListener("click", () => {
    const csv = buildUvwProfileComparisonCsv(results, specs, axis);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = comparisonExportFileName(productName, axis);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}

function drawFallbackComparisonProfileChart(element, results, spec, axis) {
  if (!element) {
    return;
  }
  element.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.className = "compare-summary-fallback";
  element.appendChild(canvas);

  const palette = chartPalette();
  const pointsByResult = results.map((result) => comparisonProfileForResult(result));
  const xMin = spec.options.xMin;
  const xMax = spec.options.xMax;
  const yMin = spec.options.yMin ?? 0;
  const yMax = spec.options.yMax ?? 20;

  const rect = element.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.round(rect.width || 760));
  const height = Math.max(260, Math.round(rect.height || 320));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const padding = { top: 34, right: 24, bottom: 68, left: 64 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const toX = (value) => padding.left + ((value - xMin) / (xMax - xMin || 1)) * plotWidth;
  const toY = (value) => padding.top + plotHeight - ((value - yMin) / (yMax - yMin || 1)) * plotHeight;

  context.fillStyle = palette.bg;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = palette.grid;
  for (let tick = yMin; tick <= yMax; tick += 2.5) {
    const y = toY(tick);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
  context.strokeStyle = palette.border;
  context.strokeRect(padding.left, padding.top, plotWidth, plotHeight);

  for (let tick = xMin; tick <= xMax + 1e-9; tick += spec.options.stepSize || ((xMax - xMin) / 4)) {
    const x = toX(tick);
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, height - padding.bottom);
    context.stroke();
  }

  pointsByResult.forEach((profile, resultIndex) => {
    context.strokeStyle = comparisonLineColor(resultIndex);
    context.lineWidth = 2;
    context.beginPath();
    let hasPoint = false;
    profile.forEach((point) => {
      const value = Number(point[spec.key]);
      if (!Number.isFinite(value)) {
        return;
      }
      const x = toX(value);
      const y = toY(point.heightKm);
      if (!hasPoint) {
        context.moveTo(x, y);
        hasPoint = true;
      } else {
        context.lineTo(x, y);
      }
    });
    if (hasPoint) {
      context.stroke();
    }
  });

  context.fillStyle = palette.text;
  context.font = "12px Arial, sans-serif";
  context.textAlign = "center";
  context.fillText(spec.options.xLabel, padding.left + plotWidth / 2, height - 12);
  context.save();
  context.translate(18, padding.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("Height (km)", 0, 0);
  context.restore();
}

function comparisonLineColor(index) {
  const colors = [
    "#111827",
    "#2563eb",
    "#dc2626",
    "#16a34a",
    "#9333ea",
    "#ea580c",
    "#0891b2",
    "#be123c",
  ];
  return colors[index % colors.length];
}

function renderComparisonProfileChart(element, results, spec, axis, options = {}) {
  if (!element) {
    return;
  }

  if (typeof Plotly === "undefined") {
    drawFallbackComparisonProfileChart(element, results, spec, axis);
    return;
  }

  const palette = chartPalette();
  const showYAxis = options.showYAxis !== false;
  const componentLabel = options.componentLabel || "";
  const traces = results
    .map((result, index) => {
      const profile = comparisonProfileForResult(result);
      return {
        type: "scatter",
        mode: "lines",
        name: result.label,
        x: profile.map((point) => Number(point[spec.key])),
        y: profile.map((point) => point.heightKm),
        customdata: profile.map((point) => [
          result.station ? stationName(result.station) : "",
          result.date || "",
          point.heightKm,
          spec.format ? spec.format(Number(point[spec.key])) : Number(point[spec.key]).toFixed(3),
        ]),
        line: {
          color: results.length === 1 ? spec.color : comparisonLineColor(index),
          width: 2.4,
          shape: "linear",
        },
        hovertemplate: `${compareAxisLabel(axis)}: ${escapeHtml(result.label)}<br>Station: %{customdata[0]}<br>Date: %{customdata[1]}<br>Height: %{customdata[2]:.2f} km<br>${spec.label}: %{customdata[3]}<extra></extra>`,
      };
    })
    .filter((trace) => trace.x.length && trace.y.length);

  const xaxis = {
    title: {
      text: componentLabel || spec.options.xLabel,
      font: { color: palette.text, size: componentLabel ? 12 : 11 },
    },
    range: [spec.options.xMin, spec.options.xMax],
    dtick: spec.options.stepSize,
    tickfont: { color: palette.text },
    gridcolor: palette.grid,
    zerolinecolor: palette.grid,
  };
  if (spec.key === "direction") {
    xaxis.tickvals = [0, 90, 180, 270, 360];
    xaxis.ticktext = ["0 deg", "90 deg", "180 deg", "270 deg", "360 deg"];
  }

  Plotly.newPlot(
    element,
    traces,
    {
      responsive: true,
      autosize: true,
      height: 310,
      paper_bgcolor: palette.bg,
      plot_bgcolor: palette.plotBg,
      margin: { l: showYAxis ? 62 : 2, r: 2, t: 34, b: 56 },
      dragmode: "pan",
      showlegend: results.length > 1,
      legend: {
        orientation: "h",
        x: 0,
        y: -0.24,
        font: { color: palette.text },
      },
      font: { color: palette.text, family: "Arial, sans-serif" },
      title: {
        text: spec.label,
        font: { color: palette.text, size: 13 },
        x: 0.5,
        xanchor: "center",
      },
      xaxis,
      yaxis: {
        title: { text: showYAxis ? "Height (km)" : "", font: { color: palette.text } },
        range: [spec.options.yMin ?? 0, spec.options.yMax ?? 20],
        dtick: 2.5,
        showticklabels: showYAxis,
        ticks: showYAxis ? "outside" : "",
        tickfont: { color: palette.text },
        gridcolor: palette.grid,
        zerolinecolor: palette.grid,
      },
    },
    {
      responsive: true,
      scrollZoom: true,
      displaylogo: false,
      toImageButtonOptions: {
        format: "png",
        filename: `${spec.key}-comparison`,
        height: 720,
        width: 1040,
        scale: 2,
      },
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    }
  );
  appState.compareCharts.push({ plotlyElement: element });
}

function comparisonProfileMatrixHtml(results, specs) {
  const columnCount = Math.max(results.length, 1);
  return `
    <div class="compare-grouped-profile-stack">
      ${specs.map((spec) => `
        <div class="compare-grouped-profile-scroll">
          <div
            class="compare-grouped-profile-plot"
            style="--compare-min-width: ${columnCount * 180}px"
            data-compare-grouped-spec="${escapeHtml(spec.key)}"
            aria-label="${escapeHtml(spec.label)} grouped by comparison ${escapeHtml(compareAxisLabel())}"
          ></div>
        </div>
      `).join("")}
    </div>
    <button type="button" class="compare-export-button" data-compare-export>Export Data</button>
  `;
}

function groupedXAxisKey(index) {
  return index === 0 ? "xaxis" : `xaxis${index + 1}`;
}

function groupedXAxisReference(index) {
  return index === 0 ? "x" : `x${index + 1}`;
}

function groupedXAxisDomain(index, count) {
  const gutter = count > 1 ? Math.min(0.012, 0.06 / count) : 0;
  return [
    index / count + (index > 0 ? gutter / 2 : 0),
    (index + 1) / count - (index < count - 1 ? gutter / 2 : 0),
  ];
}

function paddedComparisonRange(minimum, maximum, ratio = 0.035) {
  const span = maximum - minimum;
  const padding = Math.abs(span) * ratio;
  return [minimum - padding, maximum + padding];
}

function renderGroupedComparisonProfileChart(element, results, spec, axis) {
  if (!element) {
    return;
  }
  if (typeof Plotly === "undefined") {
    drawFallbackComparisonProfileChart(element, results, spec, axis);
    return;
  }

  const palette = chartPalette();
  const resultCount = Math.max(results.length, 1);
  const traces = results.map((result, index) => {
    const profile = comparisonProfileForResult(result);
    return {
      type: "scatter",
      mode: "lines",
      name: result.label,
      xaxis: groupedXAxisReference(index),
      yaxis: "y",
      x: profile.map((point) => Number(point[spec.key])),
      y: profile.map((point) => point.heightKm),
      customdata: profile.map((point) => [
        result.station ? stationName(result.station) : "",
        result.date || "",
        spec.format ? spec.format(Number(point[spec.key])) : Number(point[spec.key]).toFixed(3),
      ]),
      line: { color: spec.color, width: 2.3 },
      hovertemplate: `${compareAxisLabel(axis)}: ${escapeHtml(result.label)}<br>Station: %{customdata[0]}<br>Date: %{customdata[1]}<br>Height: %{y:.2f} km<br>${spec.label}: %{customdata[2]}<extra></extra>`,
      showlegend: false,
    };
  }).filter((trace) => trace.x.length && trace.y.length);

  const layout = {
    responsive: true,
    autosize: true,
    height: 340,
    paper_bgcolor: palette.bg,
    plot_bgcolor: palette.plotBg,
    margin: { l: 64, r: 4, t: 42, b: 68, pad: 0 },
    dragmode: "pan",
    showlegend: false,
    font: { color: palette.text, family: "Arial, sans-serif" },
    title: { text: spec.label, font: { color: palette.text, size: 14 }, x: 0.5 },
    yaxis: {
      title: { text: "Height (km)", font: { color: palette.text } },
      range: [spec.options.yMin ?? 0, spec.options.yMax ?? 20],
      dtick: 2.5,
      tickfont: { color: palette.text },
      gridcolor: palette.grid,
      zerolinecolor: palette.grid,
      domain: [0, 1],
    },
  };

  results.forEach((result, index) => {
    const xaxis = {
      domain: groupedXAxisDomain(index, resultCount),
      anchor: "y",
      title: { text: result.label, font: { color: palette.text, size: 11 } },
      range: paddedComparisonRange(spec.options.xMin, spec.options.xMax),
      dtick: spec.options.stepSize,
      tickfont: { color: palette.text, size: 9 },
      gridcolor: palette.grid,
      zerolinecolor: palette.grid,
      showline: true,
      linecolor: palette.border,
      mirror: true,
    };
    if (spec.key === "direction") {
      xaxis.tickvals = [0, 90, 180, 270, 360];
      xaxis.ticktext = ["0", "90", "180", "270", "360"];
    }
    layout[groupedXAxisKey(index)] = xaxis;
  });

  Plotly.newPlot(element, traces, layout, {
    responsive: true,
    scrollZoom: true,
    displaylogo: false,
    toImageButtonOptions: {
      format: "png",
      filename: `${spec.key}-${axis}-comparison`,
      height: 680,
      width: Math.max(1000, resultCount * 360),
      scale: 2,
    },
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
  appState.compareCharts.push({ plotlyElement: element });
}

function renderUvwComparisonCharts(container, results, axis, productName) {
  const specs = uvwComparisonSpecs(results, productName);

  container.innerHTML = comparisonProfileMatrixHtml(results, specs);
  wireUvwProfileExportButton(container, results, specs, axis, productName);
  requestAnimationFrame(() => {
    specs.forEach((spec) => {
      const chartElement = container.querySelector(`[data-compare-grouped-spec="${spec.key}"]`);
      renderGroupedComparisonProfileChart(chartElement, results, spec, axis);
    });
  });
}

function windBarbIstTimeLabel(profile, fallback = "Time unavailable") {
  const rawTime = String(profile?.time || profile?.timestamp || "").trim();
  const match = rawTime.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (!match) {
    return fallback;
  }
  const parts = match[1].split(":");
  parts[0] = parts[0].padStart(2, "0");
  return `${parts.join(":")} IST`;
}

function windBarbProfilesForResult(result) {
  const profiles = [];
  [
    [windBarbIstTimeLabel(result?.payload?.morning, "Morning"), result?.payload?.morning?.levels || []],
    [windBarbIstTimeLabel(result?.payload?.evening, "Evening"), result?.payload?.evening?.levels || []],
  ].forEach(([label, levels]) => {
    const profile = normalizeWindLevels(levels);
    if (profile.length) {
      profiles.push({ label, profile });
    }
  });
  return profiles;
}

function renderGroupedWindBarbProfileChart(element, results, axis) {
  if (!element) {
    return;
  }
  if (typeof Plotly === "undefined") {
    element.innerHTML = `<p class="compare-empty">Plotly is required to display the grouped profiles.</p>`;
    return;
  }

  const palette = chartPalette();
  const resultCount = Math.max(results.length, 1);
  const allProfiles = results.flatMap((result) => windBarbProfilesForResult(result));
  const maxSpeed = Math.max(
    30,
    Math.ceil(Math.max(0, ...allProfiles.flatMap((entry) => entry.profile.map((point) => point.speed))) / 10) * 10,
  );
  const traces = results.flatMap((result, resultIndex) => {
    return windBarbProfilesForResult(result).map((entry, profileIndex) => ({
      type: "scatter",
      mode: "lines+markers",
      name: entry.label,
      legendgroup: entry.label,
      showlegend: resultIndex === 0,
      xaxis: groupedXAxisReference(resultIndex),
      yaxis: "y",
      x: entry.profile.map((point) => point.speed),
      y: entry.profile.map((point) => point.heightKm),
      customdata: entry.profile.map((point) => [point.direction, point.u, point.v, point.w]),
      line: { color: profileIndex === 0 ? palette.speed : palette.direction, width: 2.2 },
      marker: { size: 4 },
      hovertemplate: `${escapeHtml(result.label)}<br>${entry.label}<br>Height: %{y:.2f} km<br>Speed: %{x:.2f} m/s<br>Direction: %{customdata[0]:.0f} deg<br>U: %{customdata[1]:.2f}<br>V: %{customdata[2]:.2f}<br>W: %{customdata[3]:.2f}<extra></extra>`,
    }));
  });

  const layout = {
    responsive: true,
    autosize: true,
    height: 350,
    paper_bgcolor: palette.bg,
    plot_bgcolor: palette.plotBg,
    margin: { l: 64, r: 4, t: 54, b: 68, pad: 0 },
    dragmode: "pan",
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.12, font: { color: palette.text, size: 9 } },
    font: { color: palette.text, family: "Arial, sans-serif" },
    title: { text: "Wind profiles", font: { color: palette.text, size: 14 }, x: 0.5 },
    yaxis: {
      title: { text: "Height (km)", font: { color: palette.text } },
      range: [0, 20],
      dtick: 2.5,
      tickfont: { color: palette.text },
      gridcolor: palette.grid,
      zerolinecolor: palette.grid,
      domain: [0, 1],
    },
  };
  results.forEach((result, index) => {
    layout[groupedXAxisKey(index)] = {
      domain: groupedXAxisDomain(index, resultCount),
      anchor: "y",
      title: { text: result.label, font: { color: palette.text, size: 11 } },
      range: [0, maxSpeed],
      dtick: 10,
      tickfont: { color: palette.text, size: 9 },
      gridcolor: palette.grid,
      zerolinecolor: palette.grid,
      showline: true,
      linecolor: palette.border,
      mirror: true,
    };
  });

  Plotly.newPlot(element, traces, layout, {
    responsive: true,
    scrollZoom: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
  appState.compareCharts.push({ plotlyElement: element });
}

function renderWindBarbComparisonChart(container, results, axis, productName) {
  container.innerHTML = `
    <div class="compare-grouped-profile-scroll">
      <div class="compare-grouped-windbarb-wrap" style="--compare-min-width: ${Math.max(results.length, 1) * 240}px">
        <canvas data-compare-grouped-wind aria-label="Wind barbs grouped by ${escapeHtml(compareAxisLabel(axis))}"></canvas>
      </div>
    </div>
  `;
  requestAnimationFrame(() => {
    const chart = createGroupedWindBarbComparisonChart(
      container.querySelector("[data-compare-grouped-wind]"),
      results,
      axis,
    );
    if (chart) {
      appState.compareCharts.push(chart);
    }
  });
}

function groupedWindBarbComparisonPoints(results) {
  return results.flatMap((result, resultIndex) => {
    const cycles = [
      [windBarbIstTimeLabel(result?.payload?.morning, "Morning"), result?.payload?.morning?.levels || [], 0.25],
      [windBarbIstTimeLabel(result?.payload?.evening, "Evening"), result?.payload?.evening?.levels || [], 0.75],
    ];
    return cycles.flatMap(([cycleLabel, levels, offset]) => {
      return levels.map((level) => {
        const heightKm = Number(level.height_km ?? Number(level.height_m) / 1000);
        const u = Number(level.u);
        const v = Number(level.v);
        if (!Number.isFinite(heightKm) || !Number.isFinite(u) || !Number.isFinite(v)) {
          return null;
        }
        const speed = Math.hypot(u, v);
        return {
          x: resultIndex + offset,
          y: heightKm,
          label: result.label,
          cycleLabel,
          heightKm,
          u,
          v,
          speed,
          speedKnots: metersPerSecondToKnots(speed),
        };
      }).filter(Boolean);
    });
  });
}

function createGroupedWindBarbComparisonChart(canvas, results, axis) {
  if (!canvas || typeof Chart === "undefined") {
    return null;
  }
  const points = groupedWindBarbComparisonPoints(results);
  if (!points.length) {
    return null;
  }
  const palette = chartPalette();

  return new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [{
        label: "Wind Barb",
        data: points,
        showLine: false,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHitRadius: 12,
        pointBackgroundColor: palette.hoverFill,
        pointBorderColor: palette.hover,
      }],
    },
    plugins: [windBarbChartPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 28, right: 58, bottom: 28, left: 0 } },
      interaction: { intersect: false, mode: "nearest" },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Wind Barb Comparison by ${compareAxisLabel(axis)}`,
          color: palette.text,
          padding: { top: 0, bottom: 8 },
          font: { size: 13, weight: "bold" },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const point = items[0]?.raw;
              return point ? `${point.label} - ${point.cycleLabel}` : "";
            },
            label: (context) => {
              const point = context.raw;
              return [
                `Height: ${point.heightKm.toFixed(2)} km`,
                `U: ${point.u.toFixed(2)} m/s`,
                `V: ${point.v.toFixed(2)} m/s`,
                `Speed: ${point.speed.toFixed(2)} m/s (${point.speedKnots.toFixed(1)} kt)`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: Math.max(results.length, 1),
          title: {
            display: true,
            text: axis === COMPARE_STATIONWISE
              ? "Station / Observation Time (IST)"
              : "Date / Observation Time (IST)",
            color: palette.text,
            font: { size: 11, weight: "bold" },
          },
          ticks: {
            stepSize: 0.25,
            autoSkip: false,
            color: palette.text,
            font: { size: 9, weight: "bold" },
            maxRotation: 0,
            minRotation: 0,
            callback: (value) => {
              const numericValue = Number(value);
              const resultIndex = Math.floor(numericValue);
              const offset = numericValue - resultIndex;
              if (Math.abs(offset - 0.25) < 0.01) {
                return [windBarbIstTimeLabel(results[resultIndex]?.payload?.morning, "Morning"), ""];
              }
              if (Math.abs(offset - 0.5) < 0.01) {
                return ["", results[resultIndex]?.label || ""];
              }
              if (Math.abs(offset - 0.75) < 0.01) {
                return [windBarbIstTimeLabel(results[resultIndex]?.payload?.evening, "Evening"), ""];
              }
              return "";
            },
          },
          grid: {
            color: (context) => Number.isInteger(Number(context.tick?.value))
              ? palette.border
              : "rgba(0, 0, 0, 0)",
            lineWidth: (context) => Number.isInteger(Number(context.tick?.value)) ? 1.4 : 0,
          },
        },
        y: {
          type: "linear",
          min: 0,
          max: 20,
          title: {
            display: true,
            text: "Height (km)",
            color: palette.text,
            font: { size: 11, weight: "bold" },
          },
          ticks: { color: palette.text, font: { size: 10, weight: "bold" }, stepSize: 2.5 },
          grid: { color: palette.grid, borderDash: [3, 3] },
        },
      },
    },
  });
}

async function renderComparisonGraph(productName, axis, token) {
  const grid = getElement("comparisonGrid");
  const badge = getElement("comparisonBadge");
  if (!grid) {
    return;
  }

  grid.innerHTML = compareGraphCardHtml(productName, axis);
  const container = grid.querySelector("[data-compare-summary]");
  const items = getComparisonItems(axis);
  const results = await Promise.all(items.map(async (item) => {
    try {
      const payload = productType(productName) === "wind_barb"
        ? await fetchStationWindBarbPayload(item.station, { date: item.date })
        : await fetchStationUvwPayload(item.station, getSelectedTimeFilters({ date: item.date }));
      const summary = productType(productName) === "wind_barb"
        ? summarizeWindBarbPayload(payload)
        : summarizeUvwPayload(payload);
      return { ...item, payload, summary };
    } catch (error) {
      return { ...item, error, summary: null };
    }
  }));

  if (token !== appState.compareRenderToken || !container) {
    return;
  }

  const displayResults = axis === COMPARE_DATEWISE
    ? results.filter((result) => result.summary)
    : results;

  if (axis === COMPARE_DATEWISE && badge) {
    badge.textContent = displayResults.length ? `${displayResults.length} day(s)` : "--";
  }

  if (!displayResults.some((result) => result.summary)) {
    container.innerHTML = `<p class="compare-empty">No comparison data available for the selected ${axis === COMPARE_STATIONWISE ? "stations" : "dates"}.</p>`;
    return;
  }

  if (productType(productName) === "wind_barb") {
    renderWindBarbComparisonChart(container, displayResults, axis, productName);
  } else {
    renderUvwComparisonCharts(container, displayResults, axis, productName);
  }
}

function compareTableCardHtml(title, badge, rows) {
  return `
    <article class="compare-card">
      <div class="compare-card-head">
        <div>
          <p class="uvw-kicker">Availability</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <span class="compare-date">${escapeHtml(badge)}</span>
      </div>
      ${comparisonTableHtml(rows)}
    </article>
  `;
}

function stationComparisonRows(station, date) {
  return [
    ["Date", date],
    ...Object.entries(station || {}).map(([key, value]) => [labelFromKey(key), value]),
  ];
}

function productDetailComparisonRows(station, payload, date) {
  const timestamp = payload?.timestamp || `${payload?.date || ""} ${payload?.time || ""}`.trim();
  return [
    ["Date", date],
    ["Station", stationName(station)],
    ["Current Source", payload?.source_folder || station?.current_source || "Radar wind profiler feed"],
    ["File Name", payload?.file_name || station?.file_name || "NOT GIVEN"],
    ["Raw / Processed Data", station?.raw_processed_data || "Processed Data"],
    ["Timestamp", timestamp || "-"],
    ["Levels", payload?.levels?.length || 0],
    ["Total Cycles", payload?.total_cycles || "-"],
    ["Height of Wind", station?.wind_height || "-"],
    ["Latitude", station?.latitude || "-"],
    ["Longitude", station?.longitude || "-"],
  ];
}

function compareCardHtml(date, index, productName) {
  return `
    <article class="compare-card">
      <div class="compare-card-head">
        <div>
          <p class="uvw-kicker">${escapeHtml(productName || "Product")}</p>
          <h3>${escapeHtml(stationName(appState.selectedStation))}</h3>
        </div>
        <span class="compare-date">${escapeHtml(date)}</span>
      </div>
      <div data-compare-body="${index}">
        <p class="compare-empty">Loading ${escapeHtml(productName || "product")}...</p>
      </div>
    </article>
  `;
}

function compareProfileCardHtml(item, index, productName, axis) {
  const title = axis === COMPARE_STATIONWISE
    ? stationName(item.station)
    : stationName(item.station || appState.selectedStation);
  const badge = axis === COMPARE_STATIONWISE
    ? item.date
    : item.label;

  return `
    <article class="compare-card">
      <div class="compare-card-head">
        <div>
          <p class="uvw-kicker">${escapeHtml(productName || "Product")}</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <span class="compare-date">${escapeHtml(badge)}</span>
      </div>
      <div data-compare-profile-body="${index}">
        <p class="compare-empty">Loading ${escapeHtml(productName || "product")}...</p>
      </div>
    </article>
  `;
}

function renderPlotlyCompareProfileChart(element, profile, spec) {
  if (!element || !profile.length) {
    return;
  }

  if (typeof Plotly === "undefined") {
    element.innerHTML = "";
    const canvas = document.createElement("canvas");
    element.appendChild(canvas);
    drawProfileChartCanvas(canvas, profile, spec.key, spec.label, spec.color, spec.options);
    return;
  }

  const palette = chartPalette();
  const xValues = profile.map((point) => Number(point[spec.key]));
  const yValues = profile.map((point) => point.heightKm);
  const xAxis = {
    title: { text: spec.options.xLabel, font: { color: palette.text } },
    range: [spec.options.xMin, spec.options.xMax],
    dtick: spec.options.stepSize,
    tickfont: { color: palette.text },
    gridcolor: palette.grid,
    zerolinecolor: palette.grid,
  };

  if (spec.key === "direction") {
    xAxis.tickvals = [0, 90, 180, 270, 360];
    xAxis.ticktext = ["0 deg", "90 deg", "180 deg", "270 deg", "360 deg"];
  }

  Plotly.newPlot(
    element,
    [{
      type: "scatter",
      mode: "lines",
      name: spec.label,
      x: xValues,
      y: yValues,
      line: {
        color: spec.color,
        width: 2.5,
        shape: "linear",
      },
      hovertemplate: `${spec.options.xLabel}: %{x:.3f}<br>Height: %{y:.2f} km<extra></extra>`,
    }],
    {
      responsive: true,
      autosize: true,
      height: 288,
      paper_bgcolor: palette.bg,
      plot_bgcolor: palette.plotBg,
      margin: { l: 62, r: 18, t: 38, b: 54 },
      dragmode: "pan",
      showlegend: false,
      font: { color: palette.text, family: "Arial, sans-serif" },
      title: {
        text: spec.label,
        font: { color: palette.text, size: 16 },
        x: 0.5,
        xanchor: "center",
      },
      xaxis: xAxis,
      yaxis: {
        title: { text: "Height (km)", font: { color: palette.text } },
        range: [spec.options.yMin ?? 0, spec.options.yMax ?? 20],
        dtick: 2.5,
        tickfont: { color: palette.text },
        gridcolor: palette.grid,
        zerolinecolor: palette.grid,
      },
    },
    {
      responsive: true,
      scrollZoom: true,
      displaylogo: false,
      toImageButtonOptions: {
        format: "png",
        filename: `${spec.key}-profile`,
        height: 576,
        width: 760,
        scale: 2,
      },
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    }
  );
  appState.compareCharts.push({ plotlyElement: element });
}

function renderCompareUvwPayload(container, payload, productName) {
  const profile = addWindShear(normalizeWindLevels(payload?.levels || []));
  if (!profile.length) {
    container.innerHTML = `<p class="compare-empty">${escapeHtml(payload?.message || "No U/V/W data found for this date.")}</p>`;
    return;
  }

  const palette = chartPalette();
  const maxSpeed = Math.max(30, Math.ceil(Math.max(...profile.map((point) => point.speed)) / 10) * 10);
  const chartSpecs = [
    {
      key: "speed",
      label: "Wind Speed",
      color: palette.speed,
      options: { xMin: 0, xMax: maxSpeed, xLabel: "Wind Speed (m/s)", stepSize: 10, yMin: 0, yMax: 20 },
    },
    {
      key: "direction",
      label: "Wind Direction",
      color: palette.direction,
      options: {
        xMin: 0,
        xMax: 360,
        xLabel: "Wind Direction",
        stepSize: 90,
        yMin: 0,
        yMax: 20,
        tickLabel: (value) => `${Math.round(value)} deg`,
      },
    },
    {
      key: "shear",
      label: "Wind Shear",
      color: palette.shear,
      options: { xMin: -0.1, xMax: 0.1, xLabel: "dV/dz (s^-1)", stepSize: 0.05, yMin: 0, yMax: 20 },
    },
  ];

  const timestamp = payload.timestamp || `${payload.date || ""} ${payload.time || ""}`.trim();
  container.innerHTML = `
    <p class="uvw-meta">${escapeHtml(payload.file_name || "Profiler file")} · ${escapeHtml(timestamp || "Selected day")}</p>
    <div class="compare-chart-stack compare-profile-stack">
      ${chartSpecs.map((spec) => `
        <div class="compare-chart compare-profile-chart">
          <div class="compare-profile-plot" data-compare-chart="${spec.key}" aria-label="${escapeHtml(productName)} ${escapeHtml(spec.label)}"></div>
          <span>${escapeHtml(spec.label)}</span>
        </div>
      `).join("")}
    </div>
  `;

  requestAnimationFrame(() => {
    chartSpecs.forEach((spec) => {
      const chartElement = container.querySelector(`[data-compare-chart="${spec.key}"]`);
      renderPlotlyCompareProfileChart(chartElement, profile, spec);
    });
  });
}

async function renderComparisonProfileCard(item, index, productName, token) {
  const container = document.querySelector(`[data-compare-profile-body="${index}"]`);
  if (!container || token !== appState.compareRenderToken) {
    return;
  }

  try {
    const payload = await fetchStationUvwPayload(item.station, { date: item.date });
    if (token !== appState.compareRenderToken) {
      return;
    }
    if (!payload.available) {
      container.innerHTML = `<p class="compare-empty">${escapeHtml(payload.message || "No U/V/W data found for this selection.")}</p>`;
      return;
    }
    renderCompareUvwPayload(container, payload, productName);
  } catch (error) {
    if (token === appState.compareRenderToken) {
      container.innerHTML = `<p class="compare-empty">${escapeHtml(error.message || "Comparison data could not be loaded.")}</p>`;
    }
  }
}

function renderCompareWindBarbPayload(container, payload) {
  const levelCount = (payload?.morning?.levels?.length || 0) + (payload?.evening?.levels?.length || 0);
  if (!levelCount) {
    container.innerHTML = `<p class="compare-empty">${escapeHtml(payload?.message || "No wind barb data found for this date.")}</p>`;
    return;
  }

  container.innerHTML = `
    <p class="uvw-meta">${escapeHtml(payload.date_label || "Selected day")} · ${levelCount} levels</p>
    <div class="compare-chart compare-windbarb">
      <canvas aria-label="Wind barb comparison chart"></canvas>
      <span>Wind Barb</span>
    </div>
  `;

  requestAnimationFrame(() => {
    const canvas = container.querySelector("canvas");
    const rendered = drawWindBarbProfileChart(canvas, payload);
    if (!rendered) {
      container.innerHTML = `<p class="compare-empty">Wind barb chart could not be rendered for this date.</p>`;
    }
  });
}

async function renderComparisonCard(date, index, productName, token, prefetchedPayload = null) {
  const container = document.querySelector(`[data-compare-body="${index}"]`);
  if (!container || token !== appState.compareRenderToken) {
    return;
  }

  try {
    if (productType(productName) === "availability") {
      container.innerHTML = comparisonTableHtml(stationComparisonRows(appState.selectedStation, date));
      return;
    }

    if (productType(productName) === "wind_barb") {
      const payload = prefetchedPayload || await fetchStationWindBarbPayload(appState.selectedStation, { date });
      if (token !== appState.compareRenderToken) {
        return;
      }
      if (!payload.available) {
        container.innerHTML = `<p class="compare-empty">${escapeHtml(payload.message || "No wind barb data found for this date.")}</p>`;
        return;
      }
      renderCompareWindBarbPayload(container, payload);
      return;
    }

    const payload = prefetchedPayload || await fetchStationUvwPayload(appState.selectedStation, getSelectedTimeFilters({ date }));
    if (token !== appState.compareRenderToken) {
      return;
    }

    if (productType(productName) === "product_detailed") {
      if (!payload.available) {
        container.innerHTML = `<p class="compare-empty">${escapeHtml(payload.message || "No product data found for this date.")}</p>`;
        return;
      }
      container.innerHTML = comparisonTableHtml(productDetailComparisonRows(appState.selectedStation, payload, date));
      return;
    }

    if (!payload.available) {
      container.innerHTML = `<p class="compare-empty">${escapeHtml(payload.message || "No product data found for this date.")}</p>`;
      return;
    }
    renderCompareUvwPayload(container, payload, productName);
  } catch (error) {
    if (token === appState.compareRenderToken) {
      container.innerHTML = `<p class="compare-empty">${escapeHtml(error.message || "Comparison data could not be loaded.")}</p>`;
    }
  }
}

async function renderDatewiseComparisonCards(productName, dates, token) {
  const grid = getElement("comparisonGrid");
  const badge = getElement("comparisonBadge");
  if (!grid) {
    return;
  }

  grid.innerHTML = `<p class="compare-empty">Loading ${escapeHtml(productName || "product")} comparison...</p>`;

  const results = await Promise.all(dates.map(async (date) => {
    try {
      const payload = productType(productName) === "wind_barb"
        ? await fetchStationWindBarbPayload(appState.selectedStation, { date })
        : await fetchStationUvwPayload(appState.selectedStation, getSelectedTimeFilters({ date }));
      return { date, payload, available: Boolean(payload?.available) };
    } catch (error) {
      return { date, error, available: false };
    }
  }));

  if (token !== appState.compareRenderToken) {
    return;
  }

  const availableResults = results.filter((result) => result.available);
  if (badge) {
    badge.textContent = availableResults.length ? `${availableResults.length} day(s)` : "--";
  }

  if (!availableResults.length) {
    grid.innerHTML = `<p class="compare-empty">No comparison data available for the selected dates.</p>`;
    return;
  }

  grid.innerHTML = availableResults
    .map((result, index) => compareCardHtml(result.date, index, productName))
    .join("");
  availableResults.forEach((result, index) => {
    renderComparisonCard(result.date, index, productName, token, result.payload);
  });
}

function renderComparisonView() {
  const grid = getElement("comparisonGrid");
  const title = getElement("comparisonTitle");
  const badge = getElement("comparisonBadge");
  const productName = getActiveProductName();
  const axis = getCompareAxis();
  const dates = getCompareDates();
  const stations = getCompareStations();
  const token = ++appState.compareRenderToken;
  destroyCompareCharts();

  if (title) {
    title.textContent = `${productName || "Product"} Comparison`;
  }
  if (badge) {
    badge.textContent = axis === COMPARE_STATIONWISE
      ? (stations.length ? `${stations.length} station(s)` : "--")
      : (dates.length ? `${dates.length} day(s)` : "--");
  }
  if (!grid) {
    return;
  }

  grid.innerHTML = "";

  if (!productName) {
    setComparisonMessage("Select a product to compare.");
    return;
  }
  if (axis === COMPARE_DATEWISE && !appState.selectedStation) {
    setComparisonMessage("Select a station first, then enable Date-wise comparison.");
    return;
  }
  if (axis === COMPARE_DATEWISE && dates.length < 1) {
    setComparisonMessage("Select a date for date-wise comparison.");
    return;
  }
  if (axis === COMPARE_STATIONWISE && stations.length < 2) {
    setComparisonMessage("Select at least two stations for station-wise comparison.");
    return;
  }

  setComparisonMessage("");

  if (["derived_uvw", "uvw", "wind_barb"].includes(productType(productName))) {
    renderComparisonGraph(productName, axis, token).catch((error) => {
      if (token === appState.compareRenderToken) {
        grid.innerHTML = `<p class="compare-empty">${escapeHtml(error.message || "Comparison graph could not be loaded.")}</p>`;
      }
    });
    return;
  }

  if (productType(productName) === "availability") {
    if (axis === COMPARE_STATIONWISE) {
      const date = getElement("datePicker")?.value || dateOffsetIso();
      grid.innerHTML = stations.map((station) => {
        return compareTableCardHtml(stationName(station), date, stationComparisonRows(station, date));
      }).join("");
      return;
    }

    grid.innerHTML = dates.map((date) => {
      return compareTableCardHtml(stationName(appState.selectedStation), date, stationComparisonRows(appState.selectedStation, date));
    }).join("");
    return;
  }

  renderDatewiseComparisonCards(productName, dates, token).catch((error) => {
    if (token === appState.compareRenderToken) {
      grid.innerHTML = `<p class="compare-empty">${escapeHtml(error.message || "Comparison data could not be loaded.")}</p>`;
    }
  });
}

function metersPerSecondToKnots(speed) {
  return speed * 1.94384;
}

function jetWindColor(knots) {
  const t = Math.max(0, Math.min(1, knots / 50));
  const red = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
  const green = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
  const blue = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
  return `rgb(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)})`;
}

function drawBarbFeathers(context, tipX, tipY, baseX, baseY, speedKnots) {
  const stemDx = baseX - tipX;
  const stemDy = baseY - tipY;
  const stemLength = Math.hypot(stemDx, stemDy) || 1;
  const stemUx = stemDx / stemLength;
  const stemUy = stemDy / stemLength;
  const featherDx = -stemUy;
  const featherDy = stemUx;
  let remaining = Math.max(0, Math.round(speedKnots / 5) * 5);
  let offset = 3.5;

  const drawFeather = (length, isPennant) => {
    const anchorX = tipX + stemUx * offset;
    const anchorY = tipY + stemUy * offset;
    const endX = anchorX + featherDx * length;
    const endY = anchorY + featherDy * length;

    if (isPennant) {
      context.beginPath();
      context.moveTo(anchorX, anchorY);
      context.lineTo(endX, endY);
      context.lineTo(anchorX + stemUx * 5, anchorY + stemUy * 5);
      context.closePath();
      context.fill();
      offset += 7;
      return;
    }

    context.beginPath();
    context.moveTo(anchorX, anchorY);
    context.lineTo(endX, endY);
    context.stroke();
    offset += 5;
  };

  while (remaining >= 50) {
    drawFeather(10, true);
    remaining -= 50;
  }
  while (remaining >= 10) {
    drawFeather(10, false);
    remaining -= 10;
  }
  while (remaining >= 5) {
    drawFeather(6, false);
    remaining -= 5;
  }
}

function drawWindBarb(context, x, y, speedMs, u, v) {
  const speedKnots = metersPerSecondToKnots(speedMs);
  const color = jetWindColor(speedKnots);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2.1;

  if (speedKnots < 2.5) {
    context.beginPath();
    context.arc(x, y, 3.6, 0, Math.PI * 2);
    context.lineWidth = 1.6;
    context.stroke();
    return;
  }

  // U/V describe where the air is moving toward. A meteorological wind barb
  // points toward the direction the wind is coming from, which is 180 degrees
  // opposite the motion vector.
  const directionFrom = Math.atan2(-u, -v);
  const barbLength = 20;
  const tipX = x;
  const tipY = y;
  const baseX = x + Math.sin(directionFrom) * barbLength;
  const baseY = y - Math.cos(directionFrom) * barbLength;

  context.beginPath();
  context.moveTo(tipX, tipY);
  context.lineTo(baseX, baseY);
  context.stroke();
  // Flags and feathers belong at the outer (wind-source) end of the staff.
  drawBarbFeathers(context, baseX, baseY, tipX, tipY, speedKnots);
}

function drawWindBarbColorbar(context, x, y, width, height) {
  const palette = chartPalette();
  const steps = 80;
  for (let step = 0; step < steps; step += 1) {
    const t = step / (steps - 1);
    // The labels place 50 kt at the top and 0 kt at the bottom.
    context.fillStyle = jetWindColor((1 - t) * 50);
    context.fillRect(x, y + (height / steps) * step, width, height / steps + 1);
  }

  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.strokeRect(x, y, width, height);

  context.fillStyle = palette.text;
  context.font = "bold 9px Arial, sans-serif";
  context.textAlign = "left";
  [0, 10, 20, 30, 40, 50].forEach((tick) => {
    const tickY = y + height - (tick / 50) * height;
    context.beginPath();
    context.moveTo(x + width, tickY);
    context.lineTo(x + width + 4, tickY);
    context.stroke();
    context.fillText(String(tick), x + width + 7, tickY + 3);
  });

  context.save();
  context.translate(x + width + 28, y + height / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = "center";
  context.font = "bold 10px Arial, sans-serif";
  context.fillText("Wind Speed (knots)", 0, 0);
  context.restore();
}

function drawWindBarbColumn(context, levels, centerX, yMin, yMax, plotTop, plotHeight, label = "") {
  const toY = (heightKm) => plotTop + plotHeight - ((heightKm - yMin) / (yMax - yMin || 1)) * plotHeight;
  levels.forEach((level, index) => {
    const heightKm = Number(level.height_km ?? level.height_m / 1000);
    if (heightKm < yMin || heightKm > yMax) {
      return;
    }
    const u = Number(level.u);
    const v = Number(level.v);
    const speed = Math.hypot(u, v);
    const y = toY(heightKm);
    drawWindBarb(context, centerX, y, speed, u, v);
    appState.windBarbHoverPoints.push({
      id: `${label}-${index}-${heightKm.toFixed(3)}`,
      x: centerX,
      y,
      label,
      heightKm,
      u,
      v,
      speed,
      speedKnots: metersPerSecondToKnots(speed),
    });
  });
}

function drawWindBarbHoverMarker(context, point, plotLeft, plotRight, plotTop, plotBottom) {
  if (!point) {
    return;
  }
  const palette = chartPalette();

  context.save();
  context.strokeStyle = palette.hoverGrid;
  context.lineWidth = 1.4;
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(plotLeft, point.y);
  context.lineTo(plotRight, point.y);
  context.moveTo(point.x, plotTop);
  context.lineTo(point.x, plotBottom);
  context.stroke();
  context.setLineDash([]);

  context.beginPath();
  context.arc(point.x, point.y, 9, 0, Math.PI * 2);
  context.fillStyle = palette.hoverFill;
  context.fill();
  context.lineWidth = 2.2;
  context.strokeStyle = palette.hover;
  context.stroke();

  context.beginPath();
  context.arc(point.x, point.y, 3.8, 0, Math.PI * 2);
  context.fillStyle = palette.hover;
  context.fill();
  context.restore();
}

function drawWindBarbProfileChart(canvas, payload, highlightPoint = null) {
  const morningLevels = payload?.morning?.levels || [];
  const eveningLevels = payload?.evening?.levels || [];
  if (!morningLevels.length && !eveningLevels.length) {
    return false;
  }
  const palette = chartPalette();

  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(760, Math.round(rect.width || 760));
  const height = Math.max(660, Math.round(rect.height || 660));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  if (!context) {
    return false;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  appState.windBarbHoverPoints = [];

  const padding = { top: 38, right: 116, bottom: 96, left: 84 };
  const plotLeft = padding.left;
  const plotRight = width - padding.right;
  const plotTop = padding.top;
  const plotBottom = height - padding.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const yMin = 0;
  const yMax = 20;
  const morningX = plotLeft + plotWidth * 0.33;
  const eveningX = plotLeft + plotWidth * 0.67;
  const toY = (heightKm) => plotTop + plotHeight - ((heightKm - yMin) / (yMax - yMin)) * plotHeight;

  context.fillStyle = palette.bg;
  context.fillRect(0, 0, width, height);

  context.fillStyle = palette.plotBg;
  context.fillRect(plotLeft, plotTop, plotWidth, plotHeight);

  context.strokeStyle = palette.grid;
  context.lineWidth = 1.2;
  context.setLineDash([3, 3]);
  for (let tick = yMin; tick <= yMax; tick += 2.5) {
    const y = toY(tick);
    context.beginPath();
    context.moveTo(plotLeft, y);
    context.lineTo(plotRight, y);
    context.stroke();
  }
  context.setLineDash([]);

  [morningX, eveningX].forEach((x) => {
    context.strokeStyle = palette.grid;
    context.lineWidth = 1.2;
    context.beginPath();
    context.moveTo(x, plotTop);
    context.lineTo(x, plotBottom);
    context.stroke();

    context.fillStyle = palette.hoverFill;
    context.beginPath();
    context.arc(x, plotTop - 18, 5, 0, Math.PI * 2);
    context.fill();
  });

  context.strokeStyle = palette.border;
  context.lineWidth = 1.6;
  context.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);

  context.fillStyle = palette.text;
  context.font = "13px Arial, sans-serif";
  context.textAlign = "right";
  for (let tick = yMin; tick <= yMax; tick += 2.5) {
    const y = toY(tick);
    context.fillText(tick.toFixed(1), plotLeft - 8, y + 4);
  }

  context.textAlign = "center";
  const morningTimeLabel = windBarbIstTimeLabel(payload.morning, "Morning");
  const eveningTimeLabel = windBarbIstTimeLabel(payload.evening, "Evening");
  context.fillText(morningTimeLabel, morningX, plotBottom + 32);
  context.fillText(eveningTimeLabel, eveningX, plotBottom + 32);
  context.fillText("Observation Time (IST)", width / 2, height - 22);

  context.save();
  context.translate(18, plotTop + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = "center";
  context.fillText("Height (km)", 0, 0);
  context.restore();

  drawWindBarbColumn(context, morningLevels, morningX, yMin, yMax, plotTop, plotHeight, morningTimeLabel);
  drawWindBarbColumn(context, eveningLevels, eveningX, yMin, yMax, plotTop, plotHeight, eveningTimeLabel);
  drawWindBarbHoverMarker(context, highlightPoint, plotLeft, plotRight, plotTop, plotBottom);
  drawWindBarbColorbar(context, plotRight + 20, plotTop, 18, plotHeight);

  return true;
}

function destroyWindBarbChart() {
  appState.windBarbChart?.destroy();
  appState.windBarbChart = null;
}

function windBarbChartPoints(payload) {
  const groups = [
    { x: 0, label: windBarbIstTimeLabel(payload?.morning, "Morning"), levels: payload?.morning?.levels || [] },
    { x: 1, label: windBarbIstTimeLabel(payload?.evening, "Evening"), levels: payload?.evening?.levels || [] },
  ];

  return groups.flatMap((group) => {
    return group.levels
      .map((level) => {
        const heightKm = Number(level.height_km ?? Number(level.height_m) / 1000);
        const u = Number(level.u);
        const v = Number(level.v);
        if (!Number.isFinite(heightKm) || !Number.isFinite(u) || !Number.isFinite(v)) {
          return null;
        }
        const speed = Math.hypot(u, v);
        return {
          x: group.x,
          y: heightKm,
          label: group.label,
          heightKm,
          u,
          v,
          speed,
          speedKnots: metersPerSecondToKnots(speed),
        };
      })
      .filter(Boolean);
  });
}

function drawChartWindBarbHover(context, chart, point) {
  if (!point) {
    return;
  }
  const palette = chartPalette();

  const { chartArea, scales } = chart;
  const x = scales.x.getPixelForValue(point.x);
  const y = scales.y.getPixelForValue(point.y);

  context.save();
  context.strokeStyle = palette.hoverGrid;
  context.lineWidth = 1.4;
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(chartArea.left, y);
  context.lineTo(chartArea.right, y);
  context.moveTo(x, chartArea.top);
  context.lineTo(x, chartArea.bottom);
  context.stroke();
  context.setLineDash([]);

  context.beginPath();
  context.arc(x, y, 9, 0, Math.PI * 2);
  context.fillStyle = palette.hoverFill;
  context.fill();
  context.lineWidth = 2.2;
  context.strokeStyle = palette.hover;
  context.stroke();

  context.beginPath();
  context.arc(x, y, 3.8, 0, Math.PI * 2);
  context.fillStyle = palette.hover;
  context.fill();
  context.restore();
}

const windBarbChartPlugin = {
  id: "windBarbChartPlugin",
  beforeDraw(chart) {
    const { ctx, chartArea } = chart;
    if (!chartArea) {
      return;
    }

    ctx.save();
    ctx.fillStyle = chartPalette().plotBg;
    ctx.fillRect(
      chartArea.left,
      chartArea.top,
      chartArea.right - chartArea.left,
      chartArea.bottom - chartArea.top
    );
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const { ctx, data, scales } = chart;
    const activePoint = chart.tooltip?.dataPoints?.[0]?.raw || null;

    ctx.save();
    data.datasets.forEach((dataset) => {
      dataset.data.forEach((point) => {
        drawWindBarb(
          ctx,
          scales.x.getPixelForValue(point.x),
          scales.y.getPixelForValue(point.y),
          point.speed,
          point.u,
          point.v
        );
      });
    });
    drawChartWindBarbHover(ctx, chart, activePoint);
    ctx.restore();
  },
  afterDraw(chart) {
    const { ctx, chartArea } = chart;
    if (!chartArea) {
      return;
    }

    ctx.save();
    drawWindBarbColorbar(
      ctx,
      chartArea.right + 24,
      chartArea.top,
      16,
      chartArea.bottom - chartArea.top
    );
    ctx.restore();
  },
};

function createWindBarbChart(payload) {
  const canvas = getElement("windBarbChart");
  if (!canvas || typeof Chart === "undefined") {
    return null;
  }
  const palette = chartPalette();

  const points = windBarbChartPoints(payload);
  if (!points.length) {
    return null;
  }

  return new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [{
        label: "Wind Barb",
        data: points,
        showLine: false,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHitRadius: 14,
        pointBackgroundColor: palette.hoverFill,
        pointBorderColor: palette.hover,
      }],
    },
    plugins: [windBarbChartPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: {
        padding: { top: 28, right: 58, bottom: 28, left: 0 },
      },
      interaction: {
        intersect: false,
        mode: "nearest",
      },
      plugins: {
        legend: { display: false },
        title: {
          display: false,
        },
        tooltip: {
          callbacks: {
            title: (items) => items[0]?.raw?.label || "",
            label: (context) => {
              const point = context.raw;
              return [
                `Height: ${point.heightKm.toFixed(2)} km`,
                `U: ${point.u.toFixed(2)} m/s`,
                `V: ${point.v.toFixed(2)} m/s`,
                `Speed: ${point.speed.toFixed(2)} m/s (${point.speedKnots.toFixed(1)} kt)`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: -0.5,
          max: 1.5,
          title: {
            display: true,
            text: "Observation Time (IST)",
            color: palette.text,
            font: { size: 11, weight: "bold" },
            padding: { top: 14 },
          },
          ticks: {
            color: palette.text,
            font: { size: 10, weight: "bold" },
            padding: 10,
            // Include the actual profile positions (0 and 1) in the generated
            // ticks so the Morning and Evening labels are always rendered.
            stepSize: 0.5,
            callback: (value) => {
              if (Number(value) === 0) {
                return windBarbIstTimeLabel(payload?.morning, "Morning");
              }
              if (Number(value) === 1) {
                return windBarbIstTimeLabel(payload?.evening, "Evening");
              }
              return "";
            },
          },
          grid: {
            color: palette.grid,
          },
        },
        y: {
          type: "linear",
          min: 0,
          max: 20,
          title: {
            display: true,
            text: "Height (km)",
            color: palette.text,
            font: { size: 11, weight: "bold" },
          },
          ticks: {
            color: palette.text,
            font: { size: 10, weight: "bold" },
            stepSize: 2.5,
          },
          grid: {
            color: palette.grid,
            borderDash: [3, 3],
          },
        },
      },
    },
  });
}

function setWindBarbCardMessage(message, showImage = false) {
  const emptyMessage = getElement("windBarbEmptyMessage");
  if (emptyMessage) {
    emptyMessage.textContent = message;
    emptyMessage.classList.toggle("hidden", !message);
  }
  getElement("windBarbImageWrap")?.classList.toggle("hidden", !showImage);
}

function getWindBarbTooltip() {
  let tooltip = getElement("windBarbTooltip");
  const wrapper = getElement("windBarbImageWrap");
  if (!tooltip && wrapper) {
    tooltip = document.createElement("div");
    tooltip.id = "windBarbTooltip";
    tooltip.className = "wind-barb-tooltip hidden";
    wrapper.appendChild(tooltip);
  }
  return tooltip;
}

function formatWindBarbTooltip(point) {
  return `
    <strong>${escapeHtml(point.label)}</strong>
    <span>Height: ${point.heightKm.toFixed(2)} km</span>
    <span>U: ${point.u.toFixed(2)} m/s</span>
    <span>V: ${point.v.toFixed(2)} m/s</span>
    <span>Speed: ${point.speed.toFixed(2)} m/s (${point.speedKnots.toFixed(1)} kt)</span>
  `;
}

function hideWindBarbTooltip() {
  getWindBarbTooltip()?.classList.add("hidden");
}

function redrawWindBarbHoverState(canvas, point = null) {
  if (!appState.windBarbPayload) {
    return;
  }
  drawWindBarbProfileChart(canvas, appState.windBarbPayload, point);
}

function bindWindBarbHover() {
  const canvas = getElement("windBarbChart");
  const wrapper = getElement("windBarbImageWrap");
  if (!canvas || !wrapper || canvas.dataset.hoverBound === "true") {
    return;
  }

  canvas.dataset.hoverBound = "true";
  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let bestPoint = null;
    let bestDistance = Infinity;

    appState.windBarbHoverPoints.forEach((point) => {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < bestDistance) {
        bestPoint = point;
        bestDistance = distance;
      }
    });

    const tooltip = getWindBarbTooltip();
    if (!tooltip || !bestPoint || bestDistance > 22) {
      if (appState.windBarbHoverPoint) {
        appState.windBarbHoverPoint = null;
        redrawWindBarbHoverState(canvas);
      }
      hideWindBarbTooltip();
      canvas.style.cursor = "default";
      return;
    }

    if (appState.windBarbHoverPoint?.id !== bestPoint.id) {
      appState.windBarbHoverPoint = bestPoint;
      redrawWindBarbHoverState(canvas, bestPoint);
    }

    tooltip.innerHTML = formatWindBarbTooltip(bestPoint);
    tooltip.style.left = `${Math.max(8, Math.min(x + 14, rect.width - 190))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(y - 84, rect.height - 118))}px`;
    tooltip.classList.remove("hidden");
    canvas.style.cursor = "crosshair";
  });

  canvas.addEventListener("mouseleave", () => {
    if (appState.windBarbHoverPoint) {
      appState.windBarbHoverPoint = null;
      redrawWindBarbHoverState(canvas);
    }
    hideWindBarbTooltip();
    canvas.style.cursor = "default";
  });
}

function renderWindBarbImage(payload) {
  const canvas = getElement("windBarbChart");
  const wrapper = getElement("windBarbImageWrap");
  if (!canvas) {
    return;
  }

  appState.windBarbPayload = payload;
  appState.windBarbHoverPoint = null;
  wrapper?.classList.toggle("hidden", !payload);
  destroyWindBarbChart();

  if (!payload) {
    appState.windBarbHoverPoints = [];
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.classList.add("hidden");
    return;
  }

  canvas.classList.remove("hidden");

  if (typeof Chart !== "undefined") {
    appState.windBarbChart = createWindBarbChart(payload);
    canvas.classList.toggle("hidden", !appState.windBarbChart);
    return;
  }

  requestAnimationFrame(() => {
    const rendered = drawWindBarbProfileChart(canvas, payload);
    canvas.classList.toggle("hidden", !rendered);
    if (rendered) {
      bindWindBarbHover();
    }
  });
}

function clearWindBarbChart() {
  const canvas = getElement("windBarbChart");
  if (!canvas) {
    return;
  }
  destroyWindBarbChart();
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.classList.add("hidden");
}

async function loadWindBarbProductCard() {
  const station = appState.selectedStation;
  const title = getElement("windBarbCardTitle");
  const meta = getElement("windBarbCardMeta");
  const badge = getElement("windBarbCycleBadge");

  if (!station) {
    if (title) {
      title.textContent = "Wind Barb";
    }
    if (meta) {
      meta.textContent = "Select a station from the map or station list.";
    }
    if (badge) {
      badge.textContent = "--";
    }
    setWindBarbCardMessage("Please select a station to view the wind barb profile image.");
    renderWindBarbImage(null);
    return;
  }

  if (title) {
    title.textContent = "Wind Barb";
  }
  if (meta) {
    meta.textContent = "Loading wind profiler data...";
  }
  setWindBarbCardMessage("");

  try {
    const payload = await fetchStationWindBarbPayload(station);
    if (!payload.available) {
      if (meta) {
        meta.textContent = payload.message || "No profiler data available for this station.";
      }
      if (badge) {
        badge.textContent = "N/A";
      }
      setWindBarbCardMessage(payload.message || "No wind barb data found for the selected date.");
      renderWindBarbImage(null);
      return;
    }

    if (meta) {
      meta.textContent = `${payload.date_label || ""} · ${windBarbIstTimeLabel(payload.morning, "Morning")} · ${windBarbIstTimeLabel(payload.evening, "Evening")}`;
    }
    if (badge) {
      const levelCount = (payload.morning?.levels?.length || 0) + (payload.evening?.levels?.length || 0);
      badge.textContent = `${levelCount} levels`;
    }

    renderWindBarbImage(payload);
    setWindBarbCardMessage("", true);
  } catch (error) {
    if (meta) {
      meta.textContent = "Unable to load wind barb data.";
    }
    if (badge) {
      badge.textContent = "Error";
    }
    setWindBarbCardMessage("Wind barb data could not be loaded. Try another station or date.");
    renderWindBarbImage(null);
  }
}

function createStationIcon(station, selected = false) {
  const className = [
    "station-marker",
    isActive(station) ? "marker-active" : "marker-inactive",
    selected ? "marker-selected" : ""
  ].join(" ");

  return L.divIcon({
    className,
    html: `<span></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12]
  });
}

function createPopupHtml(station) {
  // Marker popup uses station JSON fields, so new attributes appear automatically.
  const rows = Object.entries(station).map(([key, value]) => `
    <tr>
      <td>${escapeHtml(labelFromKey(key))}</td>
      <td>${escapeHtml(formatValue(value))}</td>
    </tr>
  `).join("");

  return `
    <div class="popup-card">
      <h3>${escapeHtml(stationName(station))}</h3>
      <table>${rows}</table>
    </div>
  `;
}

function createBasemaps() {
  // Add Esri basemaps using free ArcGIS Online tile services.
  const esriAttribution = "Tiles &copy; Esri";
  return {
    "Esri World Imagery": L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: esriAttribution, maxZoom: 19 }
    ),
    "Esri Topographic": L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      { attribution: esriAttribution, maxZoom: 19 }
    ),
    "Esri Terrain": L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}",
      { attribution: esriAttribution, maxZoom: 13 }
    ),
    "Esri Streets": L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      { attribution: esriAttribution, maxZoom: 19 }
    ),
    "OpenStreetMap": L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }
    )
  };
}

function addFullscreenControl() {
  const FullscreenControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const button = L.DomUtil.create("button", "leaflet-control custom-map-button");
      button.type = "button";
      button.title = "Fullscreen";
      button.textContent = "[]";
      L.DomEvent.disableClickPropagation(button);
      L.DomEvent.on(button, "click", () => {
        const mapContainer = getElement("map");
        if (!document.fullscreenElement) {
          mapContainer.requestFullscreen?.();
        } else {
          document.exitFullscreen?.();
        }
      });
      return button;
    }
  });
  appState.map.addControl(new FullscreenControl());
}

function addMapRefreshControl() {
  const RefreshControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd: function () {
      const button = L.DomUtil.create("button", "leaflet-control custom-map-button map-refresh-control");
      button.type = "button";
      button.title = "Reset map to India";
      button.setAttribute("aria-label", "Reset map to India");
      button.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.34 5.66" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      L.DomEvent.disableClickPropagation(button);
      L.DomEvent.on(button, "click", (event) => {
        L.DomEvent.stopPropagation(event);
        refreshMapToDefaultView();
      });
      return button;
    }
  });

  appState.map.addControl(new RefreshControl());
}

function addMapSearchControl() {
  const SearchControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const wrapper = L.DomUtil.create("div", "leaflet-control map-search-control");
      wrapper.innerHTML = `
        <input id="mapStationSearch" list="stationOptions" placeholder="Station Search">
        <button id="mapFitAllButton" type="button">Fit All</button>
      `;
      L.DomEvent.disableClickPropagation(wrapper);
      return wrapper;
    }
  });

  appState.map.addControl(new SearchControl());
  getElement("mapStationSearch").addEventListener("change", (event) => {
    selectStationByNameOrId(event.target.value);
  });
  getElement("mapFitAllButton").addEventListener("click", fitAllStations);
}

function switchBasemap(name) {
  const nextLayer = appState.basemaps[name];
  if (!nextLayer || appState.activeBasemapName === name) {
    return;
  }

  appState.map.removeLayer(appState.currentBasemapLayer);
  appState.currentBasemapLayer = nextLayer;
  appState.currentBasemapLayer.addTo(appState.map);
  appState.activeBasemapName = name;
  updateGoogleLayersControlUI();
}

function getBasemapPreviewClass(name) {
  return BASEMAP_OPTIONS.find((option) => option.key === name)?.preview || "preview-satellite";
}

function getBasemapThumbUrl(name) {
  const template = BASEMAP_THUMB_URLS[name];
  if (!template) {
    return "";
  }

  return template
    .replace("{z}", String(PREVIEW_TILE.z))
    .replace("{x}", String(PREVIEW_TILE.x))
    .replace("{y}", String(PREVIEW_TILE.y));
}

function renderBasemapThumb(option, className) {
  const thumbUrl = getBasemapThumbUrl(option.key);
  return `
    <span class="${className} ${option.preview}">
      <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(option.label)} map preview" loading="lazy">
    </span>
  `;
}

function updateGoogleLayersControlUI() {
  const control = document.querySelector(".gmap-layers-control");
  if (!control) {
    return;
  }

  const preview = control.querySelector(".gmap-layers-preview");
  const previewClass = getBasemapPreviewClass(appState.activeBasemapName);
  const previewImg = control.querySelector(".gmap-layers-preview img");
  if (preview) {
    preview.className = `gmap-layers-preview ${previewClass}`;
  }
  if (previewImg) {
    previewImg.src = getBasemapThumbUrl(appState.activeBasemapName);
    previewImg.alt = `${appState.activeBasemapName} map preview`;
  }

  const featureCard = control.querySelector(".gmap-feature-card");
  if (featureCard) {
    featureCard.classList.toggle(
      "is-active",
      appState.activeBasemapName === FEATURED_BASEMAP.key
    );
  }

  control.querySelectorAll(".gmap-detail-option").forEach((button) => {
    const isActive = button.dataset.layer === appState.activeBasemapName;
    button.classList.toggle("is-active", isActive);
  });

  updateAvailableShapefileControl();
}

function dashboardMapLayers() {
  return [...appState.mapLayers, ...appState.temporaryMapLayers];
}

function mapLayerGeojson(layer) {
  if (layer?.geojson && typeof layer.geojson === "object") {
    return Promise.resolve(layer.geojson);
  }
  return apiGet(layer.geojson_api_url || layer.geojson_url);
}

function ensureMapLayerVisibilityState(layer) {
  if (!layer || layer.id === undefined || layer.id === null) {
    return false;
  }
  const key = String(layer.id);
  if (!appState.mapLayerVisibility.has(key)) {
    appState.mapLayerVisibility.set(key, layer.is_visible !== false);
  }
  return appState.mapLayerVisibility.get(key);
}

function isMapLayerVisibleForUser(layerId) {
  const key = String(layerId);
  return appState.mapLayerVisibility.has(key)
    ? appState.mapLayerVisibility.get(key)
    : true;
}

function findMapLayerObject(layerId) {
  for (const [id, leafletLayer] of appState.mapLayerObjects.entries()) {
    if (String(id) === String(layerId)) {
      return leafletLayer;
    }
  }
  return null;
}

function setMapLayerVisibilityForUser(layerId, isVisible) {
  const key = String(layerId);
  appState.mapLayerVisibility.set(key, Boolean(isVisible));

  const leafletLayer = findMapLayerObject(layerId);
  if (!appState.map || !leafletLayer) {
    return;
  }

  if (isVisible && !appState.map.hasLayer(leafletLayer)) {
    leafletLayer.addTo(appState.map);
    focusMapLayerObject(leafletLayer);
  } else if (!isVisible && appState.map.hasLayer(leafletLayer)) {
    appState.map.removeLayer(leafletLayer);
  }
}

function focusMapLayerObject(leafletLayer) {
  if (!appState.map || !leafletLayer || typeof L === "undefined") {
    return;
  }

  if (typeof leafletLayer.getBounds === "function") {
    const bounds = leafletLayer.getBounds();
    if (bounds?.isValid && bounds.isValid()) {
      appState.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
      return;
    }
  }

  if (typeof leafletLayer.getLatLng === "function") {
    appState.map.setView(leafletLayer.getLatLng(), Math.max(appState.map.getZoom(), 11));
  }
}

function focusMapLayer(layerId) {
  const leafletLayer = findMapLayerObject(layerId);
  if (leafletLayer) {
    focusMapLayerObject(leafletLayer);
  }
}

function removeMapLayerObject(layerId) {
  const leafletLayer = findMapLayerObject(layerId);
  if (leafletLayer) {
    leafletLayer.remove();
  }

  Array.from(appState.mapLayerObjects.keys()).forEach((id) => {
    if (String(id) === String(layerId)) {
      appState.mapLayerObjects.delete(id);
    }
  });
}

function normalizeTemporaryMapLayer(layer) {
  return {
    id: layer.id || `user-shapefile-${Date.now()}`,
    layer_name: layer.layer_name || "User Shapefile",
    geometry_type: layer.geometry_type || "Mixed",
    geojson: layer.geojson,
    fill_color: layer.fill_color || "#f97316",
    border_color: layer.border_color || "#7c2d12",
    fill_opacity: Number(layer.fill_opacity ?? 0.18),
    line_width: Number(layer.line_width ?? 2),
    marker_color: layer.marker_color || "#e11d48",
    marker_icon: layer.marker_icon || "",
    is_visible: true,
    is_temporary: true,
    feature_count: Number(layer.feature_count ?? 0)
  };
}

function clearTemporaryUserShapefile(options = {}) {
  const { render = true, message = "" } = options;
  const temporaryIds = appState.temporaryMapLayers.map((layer) => layer.id);
  appState.temporaryMapLayers = [];
  temporaryIds.forEach((id) => {
    appState.mapLayerVisibility.delete(String(id));
    removeMapLayerObject(id);
  });

  const form = getElement("userShapefileForm");
  if (form) {
    form.reset();
  }
  getElement("userShapefileRemoveButton")?.classList.add("hidden");
  const messageElement = getElement("userShapefileMessage");
  if (messageElement) {
    messageElement.textContent = message;
  }

  if (render) {
    renderMapLayers().catch((error) => console.error(error));
  } else {
    updateAvailableShapefileControl();
  }
}

async function addTemporaryUserShapefile(layer) {
  const temporaryLayer = normalizeTemporaryMapLayer(layer);
  clearTemporaryUserShapefile({ render: false });
  appState.temporaryMapLayers = [temporaryLayer];
  appState.mapLayerVisibility.set(String(temporaryLayer.id), true);
  getElement("userShapefileRemoveButton")?.classList.remove("hidden");
  await renderMapLayers();
  focusMapLayer(temporaryLayer.id);
  return temporaryLayer;
}

function updateAvailableShapefileControl() {
  const list = document.querySelector(".gmap-shapefile-list");
  if (!list) {
    return;
  }

  const availableLayers = dashboardMapLayers().filter((layer) => layer.is_visible);
  if (!availableLayers.length) {
    list.innerHTML = '<p class="gmap-shapefile-empty">No shapefiles available</p>';
    return;
  }

  list.innerHTML = availableLayers.map((layer) => `
    <label class="gmap-shapefile-option">
      <input
        type="checkbox"
        data-map-shapefile-id="${escapeHtml(layer.id)}"
        ${ensureMapLayerVisibilityState(layer) ? "checked" : ""}
      >
      <span class="gmap-shapefile-swatch" style="--shape-color:${escapeHtml(layer.border_color || layer.fill_color || "#0f3d66")}"></span>
      <span class="gmap-shapefile-name" title="${escapeHtml(layer.layer_name)}">${escapeHtml(layer.layer_name)}</span>
    </label>
  `).join("");

  list.querySelectorAll("[data-map-shapefile-id]").forEach((checkbox) => {
    L.DomEvent.on(checkbox, "change", (event) => {
      L.DomEvent.stopPropagation(event);
      setMapLayerVisibilityForUser(checkbox.dataset.mapShapefileId, checkbox.checked);
    });
  });
}

function addGoogleStyleLayersControl() {
  const LayersControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: function () {
      const container = L.DomUtil.create("div", "leaflet-control gmap-layers-control");
      const previewClass = getBasemapPreviewClass(appState.activeBasemapName);

      container.innerHTML = `
        <div class="gmap-layers-popup hidden" role="menu" aria-label="Choose map layer">
          <button
            type="button"
            class="gmap-feature-card"
            data-layer="${escapeHtml(FEATURED_BASEMAP.key)}"
            role="menuitem"
          >
            ${renderBasemapThumb(FEATURED_BASEMAP, "gmap-feature-thumb")}
            <span class="gmap-feature-label">${escapeHtml(FEATURED_BASEMAP.label)}</span>
          </button>
          <div class="gmap-details-panel">
            ${DETAIL_BASEMAPS.map((option) => `
              <button
                type="button"
                class="gmap-detail-option"
                data-layer="${escapeHtml(option.key)}"
                role="menuitem"
              >
                ${renderBasemapThumb(option, "gmap-detail-thumb")}
                <span>${escapeHtml(option.label)}</span>
              </button>
            `).join("")}
          </div>
          <section class="gmap-shapefile-panel" aria-label="Available shapefiles">
            <h3>Available Shapefiles</h3>
            <div class="gmap-shapefile-list"></div>
          </section>
        </div>
        <button class="gmap-layers-toggle" type="button" aria-expanded="false" aria-label="Map layers">
          <span class="gmap-layers-preview ${previewClass}">
            <img
              src="${escapeHtml(getBasemapThumbUrl(appState.activeBasemapName))}"
              alt="${escapeHtml(appState.activeBasemapName)} map preview"
              loading="lazy"
            >
          </span>
          <span class="gmap-layers-label">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3L3 8.2l9 5.1 9-5.1L12 3zm0 7.4L3 15.5 12 21l9-5.5-9-5.1z"/>
            </svg>
            Layers
          </span>
        </button>
      `;

      const toggleButton = container.querySelector(".gmap-layers-toggle");
      const panel = container.querySelector(".gmap-layers-popup");

      const closePanel = () => {
        panel.classList.add("hidden");
        toggleButton.setAttribute("aria-expanded", "false");
      };

      const bindLayerButton = (button) => {
        L.DomEvent.on(button, "click", (event) => {
          L.DomEvent.stopPropagation(event);
          switchBasemap(button.dataset.layer);
          closePanel();
        });
      };

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(toggleButton, "click", (event) => {
        L.DomEvent.stopPropagation(event);
        const willOpen = panel.classList.contains("hidden");
        panel.classList.toggle("hidden");
        toggleButton.setAttribute("aria-expanded", willOpen ? "true" : "false");
      });

      container.querySelectorAll(".gmap-feature-card, .gmap-detail-option").forEach(bindLayerButton);

      L.DomEvent.on(document, "click", (event) => {
        if (!container.contains(event.target)) {
          closePanel();
        }
      });

      updateGoogleLayersControlUI();
      return container;
    }
  });

  appState.map.addControl(new LayersControl());
}

function initializeMap(settings) {
  const basemaps = createBasemaps();
  appState.basemaps = basemaps;
  appState.currentBasemapLayer = basemaps["Esri World Imagery"];

  appState.map = L.map("map", {
    center: settings.map_center || [22.5937, 78.9629],
    zoom: settings.map_zoom || 5,
    layers: [appState.currentBasemapLayer]
  });

  L.control.scale({ metric: true, imperial: false }).addTo(appState.map);
  addFullscreenControl();
  addMapRefreshControl();
  addGoogleStyleLayersControl();

  appState.map.on("mousemove", (event) => {
    getElement("coordinateDisplay").textContent =
      `Lat: ${event.latlng.lat.toFixed(5)}, Lon: ${event.latlng.lng.toFixed(5)}`;
  });
}

function renderStationMarkers() {
  if (!appState.map || typeof L === "undefined") {
    return;
  }

  appState.markers.forEach((marker) => marker.remove());
  appState.markers.clear();

  appState.stations.forEach((station) => {
    const coordinates = stationCoordinates(station);
    if (!coordinates) {
      return;
    }

    const marker = L.marker(coordinates, { icon: createStationIcon(station) })
      .bindPopup(createPopupHtml(station))
      .addTo(appState.map);

    marker.on("click", () => {
      selectStation(stationId(station), true);
    });

    appState.markers.set(stationId(station), marker);
  });
}

function mapLayerStyle(layer) {
  return {
    color: layer.border_color || "#0f3d66",
    weight: Number(layer.line_width ?? 2),
    fillColor: layer.fill_color || "#2f80ed",
    fillOpacity: Number(layer.fill_opacity ?? 0.35),
    opacity: 0.95
  };
}

function isImageMarkerIcon(value) {
  const icon = String(value || "").trim();
  return Boolean(
    icon
    && (
      icon.startsWith("/")
      || icon.startsWith("http://")
      || icon.startsWith("https://")
      || icon.startsWith("data:image")
      || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(icon)
    )
  );
}

function createMapLayerPoint(layer, feature, latlng) {
  if (isImageMarkerIcon(layer.marker_icon)) {
    return L.marker(latlng, {
      icon: L.icon({
        iconUrl: layer.marker_icon,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
        popupAnchor: [0, -26]
      })
    });
  }

  return L.circleMarker(latlng, {
    radius: 7,
    color: layer.border_color || "#0f3d66",
    weight: Number(layer.line_width ?? 2),
    fillColor: layer.marker_color || layer.fill_color || "#e11d48",
    fillOpacity: 0.9
  });
}

function createMapLayerPopup(layer, feature) {
  const properties = feature?.properties || {};
  const rows = Object.entries(properties).map(([key, value]) => `
    <tr>
      <td>${escapeHtml(labelFromKey(key))}</td>
      <td>${escapeHtml(formatValue(value))}</td>
    </tr>
  `).join("");

  return `
    <div class="popup-card">
      <h3>${escapeHtml(layer.layer_name)}</h3>
      <table>
        <tr>
          <td>Geometry</td>
          <td>${escapeHtml(layer.geometry_type)}</td>
        </tr>
        ${rows}
      </table>
    </div>
  `;
}

async function renderMapLayers() {
  if (!appState.map || typeof L === "undefined") {
    return;
  }

  appState.mapLayerObjects.forEach((leafletLayer) => {
    leafletLayer.remove();
  });
  appState.mapLayerObjects.clear();

  const visibleLayers = dashboardMapLayers().filter((layer) => layer.is_visible);
  visibleLayers.forEach(ensureMapLayerVisibilityState);
  await Promise.all(visibleLayers.map(async (layer) => {
    try {
      const geojson = await mapLayerGeojson(layer);
      const leafletLayer = L.geoJSON(geojson, {
        style: () => mapLayerStyle(layer),
        pointToLayer: (feature, latlng) => createMapLayerPoint(layer, feature, latlng),
        onEachFeature: (feature, leafletFeature) => {
          leafletFeature.bindPopup(createMapLayerPopup(layer, feature));
        }
      });
      if (isMapLayerVisibleForUser(layer.id)) {
        leafletLayer.addTo(appState.map);
      }
      appState.mapLayerObjects.set(layer.id, leafletLayer);
    } catch (error) {
      console.error(`Unable to load map layer ${layer.layer_name}:`, error);
    }
  }));
  updateAvailableShapefileControl();
}

async function refreshDashboardMapLayers(options = {}) {
  if (!appState.map || typeof L === "undefined") {
    return;
  }
  const focusLayerId = options?.focusLayerId;
  try {
    appState.mapLayers = await apiGet("/api/map-layers?visible=true");
    await renderMapLayers();
    if (focusLayerId && isMapLayerVisibleForUser(focusLayerId)) {
      focusMapLayer(focusLayerId);
    }
  } catch (error) {
    console.error("Map layers could not be loaded:", error);
  }
}

window.refreshDashboardMapLayers = refreshDashboardMapLayers;

function highlightMarker(station) {
  if (!appState.map || typeof L === "undefined") {
    return;
  }

  appState.markers.forEach((marker, id) => {
    const markerStation = appState.stations.find((item) => stationId(item) === id);
    marker.setIcon(createStationIcon(markerStation, id === stationId(station)));
  });

  if (appState.selectedRing) {
    appState.selectedRing.remove();
  }

  const coordinates = stationCoordinates(station);
  if (coordinates) {
    appState.selectedRing = L.circleMarker(coordinates, {
      radius: 18,
      color: "#f8fafc",
      weight: 2,
      fill: false
    }).addTo(appState.map);
  }
}

function selectStation(id, openedFromMap = false) {
  const station = appState.stations.find((item) => stationId(item) === id);
  if (!station) {
    return;
  }

  appState.selectedStation = station;
  getElement("stationSearch").value = stationName(station);
  getElement("selectedStationBadge").textContent = `${stationName(station)} (${stationId(station)})`;

  renderCurrentDataInformation(station);
  refreshActiveProductCard();
  highlightMarker(station);

  const marker = appState.markers.get(stationId(station));
  const coordinates = stationCoordinates(station);
  if (coordinates && appState.map) {
    appState.map.setView(coordinates, 11);
  }
  if (marker && !openedFromMap) {
    marker.openPopup();
  }
}

function selectStationByNameOrId(value) {
  const term = String(value || "").trim().toLowerCase();
  const station = appState.stations.find((item) => {
    return stationName(item).toLowerCase() === term || stationId(item).toLowerCase() === term;
  });
  if (station) {
    selectStation(stationId(station));
  }
}

function fitAllStations() {
  if (!appState.map || typeof L === "undefined") {
    return;
  }

  const coordinates = appState.stations.map(stationCoordinates).filter(Boolean);
  if (!coordinates.length) {
    return;
  }
  appState.map.fitBounds(L.latLngBounds(coordinates), { padding: [40, 40] });
}

function setDefaultIndiaView() {
  if (!appState.map || typeof L === "undefined") {
    return;
  }

  const indiaBounds = getIndiaViewBounds();
  appState.map.fitBounds(indiaBounds, { padding: [20, 20], animate: false });
}

function refreshMapToDefaultView() {
  appState.map?.invalidateSize({ animate: false });
  setDefaultIndiaView();
}

function triggerMapRefreshButton() {
  refreshMapToDefaultView();
}

function refreshMapAfterDashboardShown() {
  triggerMapRefreshButton();
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(triggerMapRefreshButton);
  }
}

function shouldStartInAdminView() {
  return document.body.dataset.initialView === "admin"
    || window.location.pathname === "/admin";
}

async function refreshDashboardData() {
  const [summary, stations, products, settings] = await Promise.all([
    apiGet("/api/summary"),
    apiGet("/api/stations"),
    apiGet("/api/products"),
    apiGet("/api/settings")
  ]);

  appState.stations = stations;
  appState.products = products;
  appState.productTypes = settings.product_types || {};
  renderHeaderStats(summary);
  populateStationControls();
  renderProducts();
  updateWorkspacePanelVisibility();
  renderStationMarkers();
  await refreshDashboardMapLayers();

  if (appState.selectedStation) {
    const refreshedStation = appState.stations.find(
      (station) => stationId(station) === stationId(appState.selectedStation)
    );
    if (refreshedStation) {
      selectStation(stationId(refreshedStation));
    } else {
      appState.selectedStation = null;
      renderCurrentDataInformation(null);
      renderAttributeTable(null);
    }
  }
}

async function ensureAdminPanelReady() {
  if (appState.adminPanelInitialized || typeof window.initAdminPanel !== "function") {
    if (typeof window.showAdminLoginScreen === "function") {
      window.showAdminLoginScreen();
    }
    return;
  }

  await window.initAdminPanel();
  appState.adminPanelInitialized = true;
}

function setAppView(view) {
  const isAdmin = view === "admin";
  const wasDashboardVisible = appState.activeView === "dashboard";
  appState.activeView = view;

  getElement("dashboardView")?.classList.toggle("view-hidden", isAdmin);
  getElement("dashboardView")?.toggleAttribute("hidden", isAdmin);
  getElement("adminView")?.classList.toggle("view-hidden", !isAdmin);
  getElement("adminView")?.toggleAttribute("hidden", !isAdmin);

  const adminButton = getElement("adminToggleButton");
  adminButton?.classList.toggle("is-active", isAdmin);
  adminButton?.setAttribute("aria-pressed", isAdmin ? "true" : "false");

  if (isAdmin) {
    ensureAdminPanelReady().catch((error) => {
      console.error(error);
    });
    return;
  }

  if (!wasDashboardVisible) {
    refreshMapAfterDashboardShown();
  }

  window.setTimeout(() => {
    appState.map?.invalidateSize({ animate: false });
  }, 120);
  refreshDashboardData().catch((error) => {
    console.error(error);
  }).finally(() => {
    if (!wasDashboardVisible) {
      triggerMapRefreshButton();
    }
  });
}

function openAdminView() {
  setAppView("admin");
}

function openDashboardView() {
  setAppView("dashboard");
}

window.openDashboardView = openDashboardView;
window.openAdminView = openAdminView;

async function handleDashboardStationSaved(station) {
  if (station?.deleted) {
    await refreshDashboardData();
    openDashboardView();
    return;
  }

  await refreshDashboardData();
  openDashboardView();

  const stationKey = station?.station_id;
  if (stationKey) {
    selectStation(stationKey);
    const coordinates = stationCoordinates(
      appState.stations.find((item) => stationId(item) === stationKey) || station
    );
    if (coordinates) {
      appState.map?.setView(coordinates, 8);
    }
  }
}

window.handleDashboardStationSaved = handleDashboardStationSaved;

function attachDashboardSyncEvents() {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }
    if (event.data?.type === "station-saved") {
      handleDashboardStationSaved(event.data.station).catch((error) => {
        console.error(error);
      });
    } else if (event.data?.type === "map-layer-updated") {
      refreshDashboardMapLayers({ focusLayerId: event.data.layer?.id }).catch((error) => {
        console.error(error);
      });
    }
  });

  window.addEventListener("storage", (event) => {
    if (
      !["dashboard:last-station-update", "dashboard:last-map-layer-update"].includes(event.key)
      || !event.newValue
    ) {
      return;
    }
    try {
      const payload = JSON.parse(event.newValue);
      if (payload?.type === "station-saved") {
        handleDashboardStationSaved(payload.station).catch((error) => {
          console.error(error);
        });
      } else if (payload?.type === "map-layer-updated") {
        refreshDashboardMapLayers({ focusLayerId: payload.layer?.id }).catch((error) => {
          console.error(error);
        });
      }
    } catch (error) {
      console.error(error);
    }
  });
}

async function uploadUserShapefile(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const message = getElement("userShapefileMessage");
  const input = getElement("userShapefileInput");
  if (!input?.files?.length) {
    if (message) {
      message.textContent = "Select a shapefile first.";
    }
    return;
  }

  if (message) {
    message.textContent = "Uploading shapefile...";
  }

  try {
    const response = await fetch("/api/user-shapefile", {
      method: "POST",
      body: new FormData(form)
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Shapefile upload failed.");
    }

    const layer = await addTemporaryUserShapefile(data.layer);
    if (message) {
      const featureText = layer.feature_count ? ` (${layer.feature_count} features)` : "";
      message.textContent = `${layer.layer_name}${featureText} is visible on the map.`;
    }
  } catch (error) {
    if (message) {
      message.textContent = error.message || "Shapefile upload failed.";
    }
    console.error("User shapefile upload error:", error);
  }
}

function attachEvents() {
  const stationSearchElement = getElement("stationSearch");
  if (stationSearchElement) {
    stationSearchElement.addEventListener("change", (event) => {
      selectStationByNameOrId(event.target.value);
    });
  }

  const fitAllButton = getElement("fitAllButton");
  if (fitAllButton) {
    fitAllButton.addEventListener("click", fitAllStations);
  }

  const zoomSelectedButton = getElement("zoomSelectedButton");
  if (zoomSelectedButton) {
    zoomSelectedButton.addEventListener("click", () => {
      if (appState.selectedStation) {
        selectStation(stationId(appState.selectedStation));
      }
    });
  }

  getElement("userShapefileForm")?.addEventListener("submit", uploadUserShapefile);
  getElement("userShapefileRemoveButton")?.addEventListener("click", () => {
    clearTemporaryUserShapefile({ message: "Temporary shapefile removed." });
  });
  window.addEventListener("pagehide", () => {
    clearTemporaryUserShapefile({ render: false });
  });

  getElement("radarUploadForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = getElement("uploadMessage");
    if (message) {
      message.textContent = "Uploading radar data...";
    }

    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error((data && data.error) || "Upload failed.");
      }

      if (message) {
        if (Array.isArray(data.files) && data.files.length) {
          const first = data.files[0];
          message.textContent = `Saved ${first.readings_saved} readings for ${first.station_name}.`;
        } else {
          message.textContent = `Upload successful.`;
        }
      }
      await refreshDashboardData();
      const uploadedStationName = data.files?.[0]?.station_name || data.station_name;
      const station = appState.stations.find((item) => stationName(item) === uploadedStationName);
      if (station) {
        selectStation(stationId(station));
      }
    } catch (error) {
      if (message) {
        message.textContent = error.message || "Upload failed.";
      }
      console.error("Upload error:", error);
    }
  });

  getElement("adminToggleButton")?.addEventListener("click", () => {
    if (appState.activeView === "admin") {
      openDashboardView();
    } else {
      openAdminView();
    }
  });
  getElement("themeToggleButton")?.addEventListener("click", toggleTheme);
  getElement("backToDashboardButton")?.addEventListener("click", openDashboardView);

  const productListElement = getElement("productList");
  productListElement?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
      return;
    }
    if (target.checked && isDashboardProduct(target.value)) {
      document.querySelectorAll("#productList input[type='checkbox']").forEach((checkbox) => {
        if (checkbox !== target && isDashboardProduct(checkbox.value)) {
          checkbox.checked = false;
        }
      });
    }
    if (isDashboardProduct(target.value)) {
      resetSubmittedProductSelection();
    }
  });

  getElement("productSubmitButton")?.addEventListener("click", submitProductSelection);

  getElement("compareModeToggle")?.addEventListener("change", () => {
    syncCompareControls();
    updateWorkspacePanelVisibility(true);
  });

  document.querySelectorAll("input[name='compareAxis']").forEach((input) => {
    input.addEventListener("change", () => {
      syncCompareControls();
      if (appState.productSelectionSubmitted && isCompareModeEnabled()) {
        renderComparisonView();
      }
    });
  });

  getElement("compareStationList")?.addEventListener("change", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      && target.type === "checkbox"
      && appState.productSelectionSubmitted
      && isCompareModeEnabled()
    ) {
      renderComparisonView();
    }
  });

  ["datePicker"].forEach((id) => {
    getElement(id)?.addEventListener("change", () => {
      if (appState.productSelectionSubmitted && isCompareModeEnabled()) {
        renderComparisonView();
        return;
      }
      if (
        appState.productSelectionSubmitted
        && (isProductChecked(PRODUCT_UVW)
        || isProductChecked(PRODUCT_UVW_COMPONENTS)
        || isProductChecked(PRODUCT_WIND_BARB)
        || isProductChecked(PRODUCT_DETAILED))
      ) {
        refreshActiveProductCard();
      }
    });
  });

  getElement("compareStartDate")?.addEventListener("change", () => {
    syncCompareEndDateFromStart();
    if (appState.productSelectionSubmitted && isCompareModeEnabled()) {
      renderComparisonView();
    }
  });

  ["compareEndDate"].forEach((id) => {
    getElement(id)?.addEventListener("change", () => {
      if (appState.productSelectionSubmitted && isCompareModeEnabled()) {
        renderComparisonView();
      }
    });
  });

  window.addEventListener("resize", () => {
    appState.map?.invalidateSize({ animate: false });
    if (isCompareModeEnabled()) {
      renderComparisonView();
    }
  });
}

async function startDashboard() {
  initializeTheme();
  populateTimeSelectors();
  syncCompareControls();
  attachDashboardSyncEvents();
  attachEvents();

  const startInAdminView = shouldStartInAdminView();
  if (startInAdminView) {
    openAdminView();
  }

  const [summary, stations, products, settings, mapLayers] = await Promise.all([
    apiGet("/api/summary"),
    apiGet("/api/stations"),
    apiGet("/api/products"),
    apiGet("/api/settings"),
    apiGet("/api/map-layers?visible=true")
  ]);

  appState.stations = stations;
  appState.products = products;
  appState.productTypes = settings.product_types || {};
  appState.mapLayers = mapLayers;

  renderHeaderStats(summary);
  populateStationControls();
  renderProducts();
  updateWorkspacePanelVisibility();
  renderCurrentDataInformation(null);
  renderAttributeTable(null);
  setUvwCardMessage("Enable Derived UVW and select a station to view profile charts.");
  setWindBarbCardMessage("Enable Wind Barb and select a station to view the profile chart.");

  if (typeof L === "undefined") {
    console.error("Leaflet could not be loaded. Map features are unavailable.");
    if (!startInAdminView) {
      throw new Error("Map library could not be loaded.");
    }
    return;
  }

  initializeMap(settings);
  renderStationMarkers();
  await renderMapLayers();
  setDefaultIndiaView();
}

const runDashboard = async () => {
  try {
    await startDashboard();
  } catch (error) {
    console.error(error);
    const attributeTableBody = getElement("attributeTableBody");
    if (attributeTableBody) {
      attributeTableBody.innerHTML = `
        <tr><td colspan="2">Dashboard data could not be loaded.</td></tr>
      `;
    }
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", runDashboard);
} else {
  runDashboard();
}
