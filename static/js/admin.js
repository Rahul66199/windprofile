// Admin page JavaScript.
// Scientists use this page to edit stations, create custom attributes, and add
// products. The saved JSON immediately drives the public dashboard.

const adminState = {
  stations: [],
  products: [],
  mapLayers: [],
  editingStationId: null,
  editingMapLayerId: null
};

const baseStationFields = ["station_id", "station_name", "latitude", "longitude", "status"];
const defaultStationAttributes = [
  "beam_width",
  "current_source",
  "data_availability",
  "elevation",
  "file_name",
  "last_update_time",
  "radar_frequency",
  "raw_processed_data",
  "total_files",
  "wind_height"
];

function byId(id) {
  return document.getElementById(id);
}

function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) {
    return parts.pop().split(";").shift();
  }
  return null;
}

function getCsrfToken() {
  return getCookie("csrftoken");
}

async function adminApi(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET") {
    const token = getCsrfToken();
    if (token) {
      headers["X-CSRFToken"] = token;
    }
  }

  const response = await fetch(path, {
    headers,
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function adminUpload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);

    const token = getCsrfToken();
    if (token) {
      request.setRequestHeader("X-CSRFToken", token);
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    request.addEventListener("load", () => {
      let data = {};
      try {
        data = JSON.parse(request.responseText || "{}");
      } catch (error) {
        reject(new Error("Server returned an invalid response."));
        return;
      }

      if (request.status < 200 || request.status >= 300) {
        reject(new Error(data.error || "Upload failed"));
        return;
      }
      resolve(data);
    });

    request.addEventListener("error", () => {
      reject(new Error("Upload failed. Check your network connection."));
    });

    request.send(formData);
  });
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

function showMessage(id, message) {
  byId(id).textContent = message;
  window.setTimeout(() => {
    byId(id).textContent = "";
  }, 3000);
}

function showAdminPanel(loggedIn) {
  byId("loginPanel")?.classList.toggle("hidden", loggedIn);
  byId("adminPanel")?.classList.toggle("hidden", !loggedIn);
  byId("logoutButton")?.classList.toggle("hidden", !loggedIn);
}

function renderStationList() {
  byId("stationAdminList").innerHTML = adminState.stations.map((station) => `
    <button class="admin-row" type="button" data-station="${escapeHtml(station.station_id)}">
      <span>
        <strong>${escapeHtml(station.station_name)}</strong>
        <small>${escapeHtml(station.station_id)} - ${escapeHtml(station.status)}</small>
      </span>
      <b>${escapeHtml(station.latitude)}, ${escapeHtml(station.longitude)}</b>
    </button>
  `).join("");

  document.querySelectorAll("[data-station]").forEach((button) => {
    button.addEventListener("click", () => editStation(button.dataset.station));
  });
}

function renderProductList() {
  byId("productAdminList").innerHTML = adminState.products.map((product, index) => `
    <div class="admin-row compact-row">
      <span>${escapeHtml(product)}</span>
      <span class="admin-product-actions">
        <button type="button" data-product-move="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""} title="Move up" aria-label="Move ${escapeHtml(product)} up">&#8593;</button>
        <button type="button" data-product-move="${index}" data-direction="1" ${index === adminState.products.length - 1 ? "disabled" : ""} title="Move down" aria-label="Move ${escapeHtml(product)} down">&#8595;</button>
        <button type="button" data-product-rename="${escapeHtml(product)}">Rename</button>
        <button type="button" data-product-delete="${escapeHtml(product)}">Delete</button>
      </span>
    </div>
  `).join("");

  document.querySelectorAll("[data-product-move]").forEach((button) => {
    button.addEventListener("click", () => {
      moveProduct(Number(button.dataset.productMove), Number(button.dataset.direction));
    });
  });
  document.querySelectorAll("[data-product-rename]").forEach((button) => {
    button.addEventListener("click", () => renameProduct(button.dataset.productRename));
  });
  document.querySelectorAll("[data-product-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteProduct(button.dataset.productDelete));
  });
}

function layerSearchTerm() {
  return String(byId("mapLayerSearch")?.value || "").trim().toLowerCase();
}

function renderMapLayerList() {
  const list = byId("mapLayerAdminList");
  if (!list) {
    return;
  }

  const term = layerSearchTerm();
  const layers = adminState.mapLayers.filter((layer) => {
    const haystack = `${layer.layer_name} ${layer.geometry_type}`.toLowerCase();
    return !term || haystack.includes(term);
  });

  const status = byId("mapLayerStatus");
  if (status) {
    const visibleCount = adminState.mapLayers.filter((layer) => layer.is_visible).length;
    status.textContent = `${adminState.mapLayers.length} layers, ${visibleCount} visible`;
  }

  if (!layers.length) {
    list.innerHTML = `<p class="form-message">No map layers found.</p>`;
    return;
  }

  list.innerHTML = layers.map((layer) => `
    <div class="map-layer-row" data-map-layer-row="${layer.id}">
      <div class="map-layer-row-main">
        <div class="map-layer-row-title">
          <strong>${escapeHtml(layer.layer_name)}</strong>
          <span class="map-layer-swatches" aria-hidden="true">
            <i class="map-layer-swatch" style="background:${escapeHtml(layer.fill_color)}"></i>
            <i class="map-layer-swatch" style="background:${escapeHtml(layer.border_color)}"></i>
            <i class="map-layer-swatch" style="background:${escapeHtml(layer.marker_color)}"></i>
          </span>
        </div>
        <span class="map-layer-row-meta">${escapeHtml(layer.geometry_type)} - ${escapeHtml(layer.geojson_file)}</span>
      </div>
      <div class="map-layer-row-actions">
        <label class="map-layer-toggle">
          <input type="checkbox" data-map-layer-toggle="${layer.id}" ${layer.is_visible ? "checked" : ""}>
          <span>Visible</span>
        </label>
        <button type="button" data-map-layer-edit="${layer.id}">Edit Style</button>
        <button type="button" class="danger" data-map-layer-delete="${layer.id}">Delete</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll("[data-map-layer-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      toggleMapLayerVisibility(input.dataset.mapLayerToggle, input.checked);
    });
  });

  document.querySelectorAll("[data-map-layer-edit]").forEach((button) => {
    button.addEventListener("click", () => editMapLayer(button.dataset.mapLayerEdit));
  });

  document.querySelectorAll("[data-map-layer-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteMapLayer(button.dataset.mapLayerDelete));
  });
}

function attributeRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "attribute-row";
  row.innerHTML = `
    <input class="attribute-key" placeholder="Attribute Name" value="${escapeHtml(key)}">
    <input class="attribute-value" placeholder="Attribute Value" value="${escapeHtml(value)}">
    <button type="button">Remove</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  return row;
}

function addAttribute(key = "", value = "") {
  byId("attributeEditor").appendChild(attributeRow(key, value));
}

function addDefaultStationAttributes() {
  defaultStationAttributes.forEach((key) => addAttribute(key, ""));
}

function resetStationForm() {
  adminState.editingStationId = null;
  byId("stationFormTitle").textContent = "Add New Station";
  byId("stationForm").reset();
  byId("stationIdInput").value = "";
  byId("attributeEditor").innerHTML = "";
  addDefaultStationAttributes();
  byId("deleteStationButton").classList.add("hidden");
}

function editStation(stationId) {
  const station = adminState.stations.find((item) => item.station_id === stationId);
  if (!station) {
    return;
  }

  adminState.editingStationId = stationId;
  byId("stationFormTitle").textContent = `Edit ${station.station_name}`;
  byId("stationIdInput").value = station.station_id;

  const form = byId("stationForm");
  form.elements.station_name.value = station.station_name || "";
  form.elements.latitude.value = station.latitude || "";
  form.elements.longitude.value = station.longitude || "";
  form.elements.status.value = station.status || "Active";

  byId("attributeEditor").innerHTML = "";
  Object.entries(station).forEach(([key, value]) => {
    if (!baseStationFields.includes(key)) {
      addAttribute(key, value);
    }
  });

  byId("deleteStationButton").classList.remove("hidden");
}

function collectStationPayload() {
  const form = byId("stationForm");
  const payload = {
    station_id: byId("stationIdInput").value,
    station_name: form.elements.station_name.value,
    latitude: form.elements.latitude.value,
    longitude: form.elements.longitude.value,
    status: form.elements.status.value
  };

  document.querySelectorAll(".attribute-row").forEach((row) => {
    const key = row.querySelector(".attribute-key").value.trim().toLowerCase().replaceAll(" ", "_");
    const value = row.querySelector(".attribute-value").value.trim();
    if (key) {
      payload[key] = value === "" ? null : value;
    }
  });

  return payload;
}

async function loadAdminData() {
  const [stations, products, mapLayers] = await Promise.all([
    adminApi("/api/stations"),
    adminApi("/api/products"),
    adminApi("/api/map-layers")
  ]);
  adminState.stations = stations;
  adminState.products = products;
  adminState.mapLayers = mapLayers;
  renderStationList();
  renderProductList();
  renderMapLayerList();
}

async function saveStation(event) {
  event.preventDefault();
  const payload = collectStationPayload();
  const isEditing = Boolean(adminState.editingStationId);
  const path = isEditing ? `/api/stations/${adminState.editingStationId}` : "/api/stations";
  const method = isEditing ? "PUT" : "POST";

  try {
    const savedStation = await adminApi(path, { method, body: JSON.stringify(payload) });
    resetStationForm();
    await loadAdminData();
    notifyDashboardStationUpdate(savedStation);
    showMessage(
      "stationFormMessage",
      `Station saved. ${savedStation.station_name} is now visible on the dashboard map.`
    );
  } catch (error) {
    showMessage("stationFormMessage", error.message);
  }
}

function notifyDashboardStationUpdate(station) {
  const message = {
    type: "station-saved",
    station,
    ts: Date.now()
  };

  localStorage.setItem("dashboard:last-station-update", JSON.stringify(message));

  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(message, window.location.origin);
  }

  if (typeof window.handleDashboardStationSaved === "function") {
    window.handleDashboardStationSaved(station);
  }
}

async function deleteStation() {
  if (!adminState.editingStationId) {
    return;
  }
  const stationId = adminState.editingStationId;
  await adminApi(`/api/stations/${stationId}`, { method: "DELETE" });
  resetStationForm();
  await loadAdminData();
  notifyDashboardStationUpdate({ station_id: stationId, deleted: true });
  showMessage("stationFormMessage", "Station deleted from dashboard.");
}

async function addProduct(event) {
  event.preventDefault();
  const productName = byId("productNameInput").value.trim();
  if (!productName) {
    return;
  }
  await adminApi("/api/products", {
    method: "POST",
    body: JSON.stringify({ product_name: productName })
  });
  byId("productNameInput").value = "";
  await loadAdminData();
}

async function deleteProduct(productName) {
  await adminApi(`/api/products/${encodeURIComponent(productName)}`, { method: "DELETE" });
  await loadAdminData();
}

async function renameProduct(productName) {
  const newName = window.prompt("Enter the new product name", productName)?.trim();
  if (!newName || newName === productName) {
    return;
  }
  try {
    await adminApi(`/api/products/${encodeURIComponent(productName)}`, {
      method: "PATCH",
      body: JSON.stringify({ product_name: newName })
    });
    await loadAdminData();
  } catch (error) {
    window.alert(error.message || "Product could not be renamed.");
  }
}

async function moveProduct(index, direction) {
  const targetIndex = index + direction;
  if (
    !Number.isInteger(index)
    || !Number.isInteger(targetIndex)
    || index < 0
    || targetIndex < 0
    || index >= adminState.products.length
    || targetIndex >= adminState.products.length
  ) {
    return;
  }

  const reordered = [...adminState.products];
  [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
  try {
    const response = await adminApi("/api/products", {
      method: "PATCH",
      body: JSON.stringify({ products: reordered })
    });
    adminState.products = response.products;
    renderProductList();
  } catch (error) {
    window.alert(error.message || "Product order could not be changed.");
  }
}

function notifyDashboardMapLayerUpdate(layer = {}) {
  const message = {
    type: "map-layer-updated",
    layer,
    ts: Date.now()
  };

  localStorage.setItem("dashboard:last-map-layer-update", JSON.stringify(message));

  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(message, window.location.origin);
  }

  if (typeof window.refreshDashboardMapLayers === "function") {
    const refreshOptions = layer?.id && !layer?.deleted
      ? { focusLayerId: layer.id }
      : {};
    window.refreshDashboardMapLayers(refreshOptions);
  }
}

async function uploadMapLayer(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const message = byId("mapLayerMessage");
  const progress = byId("mapLayerUploadProgress");
  const formData = new FormData(form);
  formData.set("is_visible", byId("mapLayerVisibleInput")?.checked ? "true" : "false");

  if (message) {
    message.textContent = "Uploading map layer...";
  }
  if (progress) {
    progress.value = 0;
    progress.classList.remove("hidden");
  }

  try {
    const data = await adminUpload("/api/map-layers", formData, (value) => {
      if (progress) {
        progress.value = value;
      }
    });
    form.reset();
    byId("mapLayerVisibleInput").checked = true;
    if (progress) {
      progress.value = 100;
    }
    await loadAdminData();
    notifyDashboardMapLayerUpdate(data.layer);
    if (message) {
      message.textContent = `${data.layer.layer_name} added to the map.`;
    }
  } catch (error) {
    if (message) {
      message.textContent = error.message || "Layer upload failed.";
    }
  } finally {
    window.setTimeout(() => {
      progress?.classList.add("hidden");
    }, 900);
  }
}

function editMapLayer(layerId) {
  const layer = adminState.mapLayers.find((item) => String(item.id) === String(layerId));
  const form = byId("mapLayerStyleForm");
  if (!layer || !form) {
    return;
  }

  adminState.editingMapLayerId = layer.id;
  byId("editingMapLayerId").value = layer.id;
  byId("mapLayerStyleTitle").textContent = `Edit ${layer.layer_name}`;
  form.elements.layer_name.value = layer.layer_name || "";
  form.elements.is_visible.checked = Boolean(layer.is_visible);
  form.elements.fill_color.value = layer.fill_color || "#2f80ed";
  form.elements.border_color.value = layer.border_color || "#0f3d66";
  form.elements.marker_color.value = layer.marker_color || "#e11d48";
  form.elements.fill_opacity.value = layer.fill_opacity ?? 0.35;
  form.elements.line_width.value = layer.line_width ?? 2;
  form.elements.marker_icon.value = layer.marker_icon || "";
  form.classList.remove("hidden");
}

function closeMapLayerStyleForm() {
  adminState.editingMapLayerId = null;
  byId("mapLayerStyleForm")?.classList.add("hidden");
  byId("mapLayerStyleForm")?.reset();
}

function collectMapLayerStylePayload() {
  const form = byId("mapLayerStyleForm");
  return {
    layer_name: form.elements.layer_name.value.trim(),
    is_visible: form.elements.is_visible.checked,
    fill_color: form.elements.fill_color.value,
    border_color: form.elements.border_color.value,
    marker_color: form.elements.marker_color.value,
    fill_opacity: form.elements.fill_opacity.value,
    line_width: form.elements.line_width.value,
    marker_icon: form.elements.marker_icon.value.trim()
  };
}

async function saveMapLayerStyle(event) {
  event.preventDefault();
  const layerId = byId("editingMapLayerId")?.value;
  if (!layerId) {
    return;
  }

  try {
    const data = await adminApi(`/api/map-layers/${layerId}`, {
      method: "PATCH",
      body: JSON.stringify(collectMapLayerStylePayload())
    });
    await loadAdminData();
    editMapLayer(data.layer.id);
    notifyDashboardMapLayerUpdate(data.layer);
    showMessage("mapLayerMessage", `${data.layer.layer_name} style saved.`);
  } catch (error) {
    showMessage("mapLayerMessage", error.message);
  }
}

async function toggleMapLayerVisibility(layerId, isVisible) {
  try {
    const data = await adminApi(`/api/map-layers/${layerId}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ is_visible: isVisible })
    });
    await loadAdminData();
    notifyDashboardMapLayerUpdate(data.layer);
  } catch (error) {
    showMessage("mapLayerMessage", error.message);
    await loadAdminData();
  }
}

async function deleteMapLayer(layerId = adminState.editingMapLayerId) {
  if (!layerId) {
    return;
  }
  const layer = adminState.mapLayers.find((item) => String(item.id) === String(layerId));
  const confirmed = window.confirm(`Delete ${layer?.layer_name || "this layer"}?`);
  if (!confirmed) {
    return;
  }

  try {
    await adminApi(`/api/map-layers/${layerId}`, { method: "DELETE" });
    closeMapLayerStyleForm();
    await loadAdminData();
    notifyDashboardMapLayerUpdate({ id: layerId, deleted: true });
    showMessage("mapLayerMessage", "Map layer deleted.");
  } catch (error) {
    showMessage("mapLayerMessage", error.message);
  }
}

function showAdminLoginScreen() {
  const loginPanel = byId("loginPanel");
  if (loginPanel) {
    loginPanel.classList.remove("hidden");
  }
}

async function login(event) {
  event.preventDefault();
  try {
    await adminApi("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: byId("usernameInput").value.trim(),
        password: byId("passwordInput").value
      })
    });
    showAdminPanel(true);
    await loadAdminData();
    byId("loginForm")?.reset();
    const loginMessage = byId("loginMessage");
    if (loginMessage) {
      loginMessage.textContent = "Login successful.";
    }
  } catch (error) {
    byId("loginMessage").textContent = error.message;
  }
}

function showAdminLoginScreen() {
  showAdminPanel(false);
  byId("loginForm")?.reset();
  const loginMessage = byId("loginMessage");
  if (loginMessage) {
    loginMessage.textContent = "";
  }
  byId("usernameInput")?.focus();
}

async function logoutAdminSession() {
  try {
    await adminApi("/api/admin/logout", { method: "POST", body: "{}" });
  } catch (error) {
    console.error(error);
  }
  showAdminLoginScreen();
}

async function logout() {
  await logoutAdminSession();
}

async function restoreAdminSession() {
  try {
    const status = await adminApi("/api/admin/status");
    if (status.logged_in) {
      showAdminPanel(true);
      await loadAdminData();
      return;
    }
  } catch (error) {
    console.error(error);
  }
  showAdminLoginScreen();
}

async function startAdmin() {
  const loginForm = byId("loginForm");
  if (!loginForm) {
    return;
  }

  loginForm.addEventListener("submit", login);
  byId("logoutButton")?.addEventListener("click", logout);
  byId("newStationButton")?.addEventListener("click", resetStationForm);
  byId("addAttributeButton")?.addEventListener("click", () => addAttribute());
  byId("stationForm")?.addEventListener("submit", saveStation);
  byId("deleteStationButton")?.addEventListener("click", deleteStation);
  byId("productForm")?.addEventListener("submit", addProduct);
  byId("mapLayerUploadForm")?.addEventListener("submit", uploadMapLayer);
  byId("mapLayerStyleForm")?.addEventListener("submit", saveMapLayerStyle);
  byId("mapLayerSearch")?.addEventListener("input", renderMapLayerList);
  byId("refreshMapLayersButton")?.addEventListener("click", loadAdminData);
  byId("cancelMapLayerStyleButton")?.addEventListener("click", closeMapLayerStyleForm);
  byId("deleteMapLayerFromEditorButton")?.addEventListener("click", () => deleteMapLayer());
  resetStationForm();
  await restoreAdminSession();
}

window.initAdminPanel = startAdmin;
window.showAdminLoginScreen = showAdminLoginScreen;
window.logoutAdminSession = logoutAdminSession;
