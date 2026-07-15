# dashboard/views.py
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from django.contrib.auth import authenticate
from django.db.models import Q
from django.core.files.storage import default_storage
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from .models import MapLayer, Station, UploadedUVWFile, WindReading
from .parser import (
    get_station_name,
    parse_observation_timestamp_from_name,
    parse_uvw_file,
)
from . import data_utils
from .serializers import serialize_map_layer
from .services.utils import (
    ShapeFileUploadError,
    convert_shapefile_upload_to_geojson,
    convert_shapefile_zip_to_geojson,
)
from .data_utils import (
    DATA_LOCK, load_settings, load_stations, load_stations_from_json,
    load_products, load_product_types, save_stations, save_products, find_station_index,
    clean_station_payload, station_is_active, admin_password_matches,
    load_station_uvw_payload, load_station_wind_barb_payload,
    DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, cycle_hour_from_timestamp,
)
from .kochi_processing import build_kochi_profile_payload


# ── Auth helpers ──────────────────────────────────────────────────────────────

def _station_upload_filter(station):
    station_name = str(station.get("station_name", "")).strip()
    query = Q()
    if station_name:
        query |= Q(station_name__iexact=station_name)
        query |= Q(station__station_name__iexact=station_name)
    return query


def _date_token_for_file_name(date_value):
    try:
        return datetime.strptime(date_value, "%Y-%m-%d").strftime("%d%b%Y")
    except (TypeError, ValueError):
        return ""


def _uploaded_file_time_parts(uvw_file):
    timestamp, date, time = parse_observation_timestamp_from_name(uvw_file.file.name)
    if timestamp:
        return timestamp, date, time
    return (
        uvw_file.uploaded_at.isoformat(),
        uvw_file.uploaded_at.date().isoformat(),
        uvw_file.uploaded_at.time().replace(microsecond=0).isoformat(),
    )


def _uploaded_file_time_of_day(uvw_file):
    timestamp, _, _ = parse_observation_timestamp_from_name(uvw_file.file.name)
    if len(timestamp) >= 13:
        try:
            hour = int(timestamp[11:13])
        except ValueError:
            hour = 12
        return "morning" if abs(hour - 11) <= abs(hour - 17) else "evening"
    return uvw_file.time_of_day


def _serialize_uploaded_file(uvw_file):
    readings = uvw_file.wind_readings.all()
    timestamp, date, time = _uploaded_file_time_parts(uvw_file)
    return {
        "timestamp": timestamp,
        "date": date,
        "time": time,
        "file_name": uvw_file.file.name,
        "levels": [
            {
                "height_km": reading.height_km,
                "height_m": round(reading.height_km * 1000, 1),
                "u": reading.u,
                "v": reading.v,
                "w": reading.w,
            }
            for reading in readings
        ],
    }


def _uploaded_files_for_station(station, date_value=""):
    query = _station_upload_filter(station)
    if not query:
        return UploadedUVWFile.objects.none()

    files = UploadedUVWFile.objects.filter(query).prefetch_related("wind_readings")
    if date_value:
        date_query = Q(uploaded_at__date=date_value)
        date_token = _date_token_for_file_name(date_value)
        if date_token:
            date_query |= Q(file__icontains=date_token)
        files = files.filter(date_query)
    return files.order_by("-uploaded_at")


def _load_uploaded_uvw_payload(station, date_value=""):
    uploaded_file = _uploaded_files_for_station(station, date_value).first()
    if not uploaded_file:
        return None

    cycle = _serialize_uploaded_file(uploaded_file)
    cycles = []
    for item in _uploaded_files_for_station(station, date_value)[:24]:
        item_timestamp, item_date, item_time = _uploaded_file_time_parts(item)
        cycles.append({
            "timestamp": item_timestamp,
            "date": item_date,
            "time": item_time,
            "file_name": item.file.name,
            "level_count": item.wind_readings.count(),
        })
    return {
        "station_id": station.get("station_id"),
        "station_name": station.get("station_name"),
        "available": True,
        "source_folder": "uploaded database",
        "file_name": cycle["file_name"],
        "selected_cycle_index": 0,
        "total_cycles": len(cycles),
        "timestamp": cycle["timestamp"],
        "date": cycle["date"],
        "time": cycle["time"],
        "levels": cycle["levels"],
        "cycles": cycles,
    }


def _upload_folder_for_station(station):
    station_name = str(station.get("station_name", "")).strip().lower()
    if "kolkata" in station_name or "haringhata" in station_name:
        folder_name = "kolkata"
    elif "kochi" in station_name or "cusat" in station_name:
        folder_name = "kochi"
    else:
        return None

    folder = data_utils.BASE_DIR / "uploads" / folder_name
    if folder.exists() and folder.is_dir():
        return folder
    return None


def _load_uploaded_folder_uvw_payload(station, date_value="", hour_value="", minute_value=""):
    folder = _upload_folder_for_station(station)
    if folder is None:
        return None

    files = data_utils.list_uvw_files(folder)
    if not files:
        return None

    cycles = []
    for file_path in files:
        cycles.extend(data_utils.parse_uvw_file(file_path))

    if date_value:
        cycles = data_utils.cycles_for_date(cycles, date_value)
        if not cycles:
            return None

    cycles.sort(key=lambda cycle: str(cycle.get("timestamp", "")), reverse=True)
    cycles = [cycle for cycle in cycles if cycle.get("levels")]
    if not cycles:
        return None

    selected_index = data_utils.select_uvw_cycle(cycles, date_value, hour_value, minute_value)
    selected_cycle = cycles[selected_index]
    return {
        "station_id": station.get("station_id"),
        "station_name": station.get("station_name"),
        "available": True,
        "source_folder": f"uploads/{folder.name}",
        "file_name": selected_cycle.get("file_name", files[0].name),
        "selected_cycle_index": selected_index,
        "total_cycles": len(cycles),
        "timestamp": selected_cycle.get("timestamp", ""),
        "date": selected_cycle.get("date", ""),
        "time": selected_cycle.get("time", ""),
        "levels": selected_cycle.get("levels", []),
        "cycles": [
            {
                "timestamp": cycle.get("timestamp", ""),
                "date": cycle.get("date", ""),
                "time": cycle.get("time", ""),
                "file_name": cycle.get("file_name", ""),
                "level_count": len(cycle.get("levels", [])),
            }
            for cycle in cycles[:24]
        ],
    }


def _load_uploaded_wind_barb_payload(station, date_value=""):
    files = list(_uploaded_files_for_station(station, date_value))
    if not files:
        return None

    morning_file = next(
        (uvw_file for uvw_file in files if _uploaded_file_time_of_day(uvw_file) == "morning"),
        None,
    )
    evening_file = next(
        (uvw_file for uvw_file in files if _uploaded_file_time_of_day(uvw_file) == "evening"),
        None,
    )

    if morning_file is None and evening_file is None:
        morning_file = files[0]

    morning = _serialize_uploaded_file(morning_file) if morning_file else None
    evening = _serialize_uploaded_file(evening_file) if evening_file else None
    date_label = date_value or (morning or evening or {}).get("date", "Latest")
    station_name = str(station.get("station_name", "Station"))
    return {
        "station_id": station.get("station_id"),
        "station_name": station_name,
        "available": True,
        "title": f"Windbarb_{date_label}_{station_name}",
        "date_label": date_label,
        "morning": {
            "label": "Morning",
            "timestamp": morning.get("timestamp", "") if morning else "",
            "time": morning.get("time", "") if morning else "",
            "file_name": morning.get("file_name", "") if morning else "",
            "levels": morning.get("levels", []) if morning else [],
        },
        "evening": {
            "label": "Evening",
            "timestamp": evening.get("timestamp", "") if evening else "",
            "time": evening.get("time", "") if evening else "",
            "file_name": evening.get("file_name", "") if evening else "",
            "levels": evening.get("levels", []) if evening else [],
        },
    }


def _load_uploaded_folder_wind_barb_payload(station, date_value=""):
    folder = _upload_folder_for_station(station)
    if folder is None:
        return None

    files = data_utils.list_uvw_files(folder)
    if not files:
        return None

    cycles = []
    for file_path in files:
        cycles.extend(data_utils.parse_uvw_file(file_path))

    cycles = [cycle for cycle in cycles if cycle.get("levels")]
    if not cycles:
        return None

    if date_value:
        cycles = data_utils.cycles_for_date(cycles, date_value)
        if not cycles:
            return None

    cycles.sort(key=lambda cycle: str(cycle.get("timestamp", "")), reverse=True)
    morning_cycle, evening_cycle = data_utils.pick_morning_evening_profiles(
        cycles,
        date_value,
    )
    date_label = data_utils.format_wind_barb_date_label(
        date_value,
        morning_cycle or evening_cycle,
    )
    station_name = str(station.get("station_name", "Station"))
    return {
        "station_id": station.get("station_id"),
        "station_name": station_name,
        "available": True,
        "source_folder": f"uploads/{folder.name}",
        "title": f"Windbarb_{date_label}_{station_name}",
        "date_label": date_label,
        "morning": data_utils.serialize_wind_barb_profile(
            morning_cycle,
            "Morning",
        ),
        "evening": data_utils.serialize_wind_barb_profile(
            evening_cycle,
            "Evening",
        ),
    }


def is_admin_logged_in(request):
    return bool(request.session.get("admin_logged_in"))

def require_admin(request):
    if not is_admin_logged_in(request):
        return JsonResponse({"error": "Admin login required"}, status=401)
    return None


COLOR_PATTERN = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
MAP_LAYER_STYLE_FIELDS = {
    "fill_color",
    "border_color",
    "fill_opacity",
    "line_width",
    "marker_color",
    "marker_icon",
}


def _json_payload(request):
    if not request.body:
        return {}
    try:
        return json.loads(request.body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid JSON payload") from exc


def _request_payload(request):
    content_type = request.META.get("CONTENT_TYPE", "")
    if content_type.startswith("multipart/form-data"):
        return request.POST
    return _json_payload(request)


def _truthy(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "visible", "enabled"}


def _falsey(value):
    if isinstance(value, bool):
        return not value
    return str(value).strip().lower() in {"0", "false", "no", "off", "hidden", "disabled"}


def _coerce_bool(value, field_name):
    if _truthy(value):
        return True
    if _falsey(value):
        return False
    raise ValueError(f"{field_name} must be true or false")


def _coerce_float(value, field_name, minimum=None, maximum=None):
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a number") from exc
    if minimum is not None and number < minimum:
        raise ValueError(f"{field_name} must be at least {minimum}")
    if maximum is not None and number > maximum:
        raise ValueError(f"{field_name} must be at most {maximum}")
    return number


def _coerce_color(value, field_name):
    color = str(value or "").strip()
    if not COLOR_PATTERN.match(color):
        raise ValueError(f"{field_name} must be a valid hex color")
    return color


def _map_layer_values(payload, include_identity=False, include_visibility=False):
    values = {}

    if include_identity and "layer_name" in payload:
        layer_name = str(payload.get("layer_name", "")).strip()
        if not layer_name:
            raise ValueError("Layer name is required")
        values["layer_name"] = layer_name

    if "fill_color" in payload:
        values["fill_color"] = _coerce_color(payload.get("fill_color"), "Fill color")
    if "border_color" in payload:
        values["border_color"] = _coerce_color(payload.get("border_color"), "Border color")
    if "marker_color" in payload:
        values["marker_color"] = _coerce_color(payload.get("marker_color"), "Marker color")
    if "fill_opacity" in payload:
        values["fill_opacity"] = _coerce_float(payload.get("fill_opacity"), "Fill opacity", 0, 1)
    if "line_width" in payload:
        values["line_width"] = _coerce_float(payload.get("line_width"), "Line width", 0, 20)
    if "marker_icon" in payload:
        values["marker_icon"] = str(payload.get("marker_icon", "")).strip()[:80]
    if include_visibility and "is_visible" in payload:
        values["is_visible"] = _coerce_bool(payload.get("is_visible"), "Visibility")

    return values


def _get_map_layer(layer_id):
    try:
        return MapLayer.objects.get(pk=layer_id)
    except MapLayer.DoesNotExist:
        return None


def _request_shapefile_files(request):
    uploaded_files = request.FILES.getlist("shapefile_zip")
    if not uploaded_files:
        uploaded_files = [
            request.FILES.get("shapefile_zip")
            or request.FILES.get("shape_file")
            or request.FILES.get("file")
        ]
    return [uploaded_file for uploaded_file in uploaded_files if uploaded_file]


# ── Page views ────────────────────────────────────────────────────────────────

@ensure_csrf_cookie
def dashboard_page(request):
    return render(request, "index.html", {"initial_view": "dashboard"})

@ensure_csrf_cookie
def admin_page(request):
    return render(request, "index.html", {"initial_view": "admin"})


def health_check(request):
    return JsonResponse({"status": "ok"})


def api_settings(request):
    settings = load_settings()
    return JsonResponse({
        "map_center": settings.get("map_center", [22.5937, 78.9629]),
        "map_zoom": settings.get("map_zoom", 5),
        "organization": settings.get(
            "organization",
            "Indian Meteorological Department"
        ),
        "product_types": load_product_types(),
    })

# ── Upload ────────────────────────────────────────────────────────────────────

def api_summary(request):
    stations = load_stations()
    active = [station for station in stations if station_is_active(station)]
    inactive = [station for station in stations if not station_is_active(station)]
    return JsonResponse({
        "total": len(stations),
        "active": len(active),
        "inactive": len(inactive),
        "active_names": [
            station.get("station_name", "Unnamed") for station in active
        ],
        "inactive_names": [
            station.get("station_name", "Unnamed") for station in inactive
        ],
    })


# ── Map layers ────────────────────────────────────────────────────────────────

def api_map_layers(request):
    if request.method == "GET":
        layers = MapLayer.objects.all()
        visible = request.GET.get("visible")
        if visible is not None:
            try:
                layers = layers.filter(is_visible=_coerce_bool(visible, "visible"))
            except ValueError as exc:
                return JsonResponse({"error": str(exc)}, status=400)
        elif not is_admin_logged_in(request):
            layers = layers.filter(is_visible=True)
        return JsonResponse(
            [serialize_map_layer(layer, request) for layer in layers],
            safe=False,
        )

    if request.method != "POST":
        return JsonResponse({"error": "Method not allowed"}, status=405)

    err = require_admin(request)
    if err:
        return err

    # Handle multiple files (ZIP or individual shapefile components)
    uploaded_files = _request_shapefile_files(request)

    if not uploaded_files:
        return JsonResponse({"error": "Upload a shapefile ZIP file or shapefile components."}, status=400)

    layer_name = str(request.POST.get("layer_name", "")).strip()
    if not layer_name:
        # Use first file's name as fallback
        layer_name = Path(getattr(uploaded_files[0], "name", "map-layer")).stem
    if not layer_name:
        return JsonResponse({"error": "Layer name is required."}, status=400)

    try:
        style_values = _map_layer_values(
            request.POST,
            include_identity=False,
            include_visibility=True,
        )
        if "is_visible" not in style_values:
            style_values["is_visible"] = True

        # If single ZIP file, use it directly; if multiple files, pass them together
        if len(uploaded_files) == 1:
            uploaded_file = uploaded_files[0]
            converted = convert_shapefile_zip_to_geojson(uploaded_file, layer_name)
        else:
            # Multiple files uploaded - combine them
            converted = convert_shapefile_zip_to_geojson(uploaded_files, layer_name)
        
        try:
            layer = MapLayer.objects.create(
                layer_name=layer_name,
                geometry_type=converted["geometry_type"],
                geojson_file=converted["geojson_file"],
                **style_values,
            )
        except Exception:
            if converted.get("geojson_file") and default_storage.exists(converted["geojson_file"]):
                default_storage.delete(converted["geojson_file"])
            raise
    except (ShapeFileUploadError, ValueError) as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({"error": f"Layer upload failed: {exc}"}, status=500)

    payload = serialize_map_layer(layer, request)
    payload["feature_count"] = converted.get("feature_count", 0)
    return JsonResponse({"success": True, "layer": payload}, status=201)


def api_user_shapefile(request):
    if request.method != "POST":
        return JsonResponse({"error": "POST required"}, status=405)

    uploaded_files = _request_shapefile_files(request)
    if not uploaded_files:
        return JsonResponse({"error": "Upload a shapefile ZIP file or shapefile components."}, status=400)

    layer_name = str(request.POST.get("layer_name", "")).strip()
    if not layer_name:
        layer_name = Path(getattr(uploaded_files[0], "name", "user-shapefile")).stem
    layer_name = layer_name or "User Shapefile"

    try:
        shapefile_input = uploaded_files[0] if len(uploaded_files) == 1 else uploaded_files
        converted = convert_shapefile_upload_to_geojson(shapefile_input, layer_name)
    except ShapeFileUploadError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({"error": f"Shapefile upload failed: {exc}"}, status=500)

    return JsonResponse({
        "success": True,
        "layer": {
            "id": f"user-shapefile-{uuid.uuid4().hex}",
            "layer_name": layer_name,
            "geometry_type": converted["geometry_type"],
            "geojson": converted["geojson"],
            "fill_color": "#f97316",
            "border_color": "#7c2d12",
            "fill_opacity": 0.18,
            "line_width": 2,
            "marker_color": "#e11d48",
            "marker_icon": "",
            "is_visible": True,
            "is_temporary": True,
            "feature_count": converted.get("feature_count", 0),
        },
    })


def api_map_layer_detail(request, layer_id):
    layer = _get_map_layer(layer_id)
    if layer is None:
        return JsonResponse({"error": "Map layer not found"}, status=404)

    if request.method == "GET":
        if not layer.is_visible and not is_admin_logged_in(request):
            return JsonResponse({"error": "Map layer not found"}, status=404)
        return JsonResponse(serialize_map_layer(layer, request))

    if request.method in {"PUT", "PATCH"}:
        err = require_admin(request)
        if err:
            return err
        try:
            values = _map_layer_values(
                _request_payload(request),
                include_identity=True,
                include_visibility=True,
            )
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)

        for field, value in values.items():
            setattr(layer, field, value)
        layer.save()
        return JsonResponse({"success": True, "layer": serialize_map_layer(layer, request)})

    if request.method == "DELETE":
        err = require_admin(request)
        if err:
            return err
        deleted_id = layer.id
        layer.delete()
        return JsonResponse({"success": True, "deleted": deleted_id})

    return JsonResponse({"error": "Method not allowed"}, status=405)


def api_map_layer_style(request, layer_id):
    if request.method not in {"POST", "PUT", "PATCH"}:
        return JsonResponse({"error": "Method not allowed"}, status=405)

    err = require_admin(request)
    if err:
        return err

    layer = _get_map_layer(layer_id)
    if layer is None:
        return JsonResponse({"error": "Map layer not found"}, status=404)

    try:
        values = _map_layer_values(_request_payload(request))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    if not values:
        return JsonResponse({"error": "No style values provided"}, status=400)

    for field, value in values.items():
        setattr(layer, field, value)
    layer.save()
    return JsonResponse({"success": True, "layer": serialize_map_layer(layer, request)})


def api_map_layer_visibility(request, layer_id):
    if request.method not in {"POST", "PUT", "PATCH"}:
        return JsonResponse({"error": "Method not allowed"}, status=405)

    err = require_admin(request)
    if err:
        return err

    layer = _get_map_layer(layer_id)
    if layer is None:
        return JsonResponse({"error": "Map layer not found"}, status=404)

    try:
        payload = _request_payload(request)
        if "is_visible" in payload:
            layer.is_visible = _coerce_bool(payload.get("is_visible"), "Visibility")
        elif "visible" in payload:
            layer.is_visible = _coerce_bool(payload.get("visible"), "Visibility")
        else:
            layer.is_visible = not layer.is_visible
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    layer.save(update_fields=["is_visible", "updated_at"])
    return JsonResponse({"success": True, "layer": serialize_map_layer(layer, request)})


def api_map_layer_geojson(request, layer_id):
    if request.method != "GET":
        return JsonResponse({"error": "Method not allowed"}, status=405)

    layer = _get_map_layer(layer_id)
    if layer is None or (not layer.is_visible and not is_admin_logged_in(request)):
        return JsonResponse({"error": "Map layer not found"}, status=404)
    if not layer.geojson_file or not default_storage.exists(layer.geojson_file.name):
        return JsonResponse({"error": "GeoJSON file not found"}, status=404)

    with default_storage.open(layer.geojson_file.name, "r") as geojson_file:
        return JsonResponse(json.load(geojson_file), safe=False)


def upload_uvw(request):
    if request.method != "POST":
        return JsonResponse({"error": "POST required"}, status=405)

    err = require_admin(request)
    if err:
        return err

    # Accept multiple files under either "radar_file" or "file"
    # `time_of_day` can be optionally provided; otherwise infer from file timestamp
    requested_time = request.POST.get("time_of_day", "").strip().lower()

    # gather files from MultiValueDict; fall back to single-file keys
    files = request.FILES.getlist("radar_file") or request.FILES.getlist("file")
    if not files:
        single = request.FILES.get("radar_file") or request.FILES.get("file")
        files = [single] if single else []

    if not files:
        return JsonResponse({"error": "No file provided"}, status=400)

    if requested_time and requested_time not in ("morning", "evening"):
        return JsonResponse({"error": "Invalid time_of_day value"}, status=400)

    results = []
    errors = []

    for file in files:
        try:
            # This will now parse both Kochi and Kolkata/Haringhata files
            header_data, wind_readings = parse_uvw_file(file)

            if not wind_readings:
                errors.append({"file_name": getattr(file, 'name', ''), "error": "No wind readings found in this UVW file."})
                continue

            station_name = get_station_name(
                header_data.get("latitude"),
                header_data.get("longitude"),
            )

            # Optional: link uploaded file to Station table if matching station exists
            station = Station.objects.filter(station_name__iexact=station_name).first()

            # Determine time_of_day from header timestamp if not explicitly given
            def _infer_time_of_day(hdr):
                # try ISO timestamp first
                ts = str(hdr.get("timestamp", ""))
                hour = cycle_hour_from_timestamp(ts)
                # fallback: extract hour from `time` field if present
                if not hdr.get("timestamp") and hdr.get("time"):
                    m = re.search(r"(\d{1,2}):", str(hdr.get("time", "")))
                    if m:
                        try:
                            hour = int(m.group(1))
                        except Exception:
                            hour = 12
                # choose closer of 11 (morning) and 17 (evening)
                return "morning" if abs(hour - 11) <= abs(hour - 17) else "evening"

            try:
                file.seek(0)
            except Exception:
                pass

            inferred_time_of_day = requested_time or _infer_time_of_day(header_data)

            uvw_file = UploadedUVWFile.objects.create(
                station=station,
                file=file,
                station_name=station_name,
                time_of_day=inferred_time_of_day,
                latitude=header_data.get("latitude") or 0,
                longitude=header_data.get("longitude") or 0,
                elevation=header_data.get("elevation"),
                baud_length=header_data.get("baud_length"),
                resolution=header_data.get("resolution"),
                rain=header_data.get("rain", False),
            )

            WindReading.objects.bulk_create([
                WindReading(
                    uvw_file=uvw_file,
                    height_km=r["height_km"],
                    u=r["u"],
                    v=r["v"],
                    w=r["w"],
                )
                for r in wind_readings
            ])

            results.append({
                "file_id": uvw_file.id,
                "file_name": uvw_file.file.name,
                "station_name": station_name,
                
                "readings_saved": len(wind_readings),
                "metadata": header_data,
            })

        except Exception as e:
            errors.append({"file_name": getattr(file, 'name', ''), "error": str(e)})

    resp = {"success": bool(results), "files": results}
    if errors:
        resp["errors"] = errors

    status = 207 if results and errors else (200 if results else 400)
    return JsonResponse(resp, status=status)
# ── Stations ──────────────────────────────────────────────────────────────────

def api_stations(request):
    if request.method == "GET":
        return JsonResponse(load_stations(), safe=False)

    err = require_admin(request)
    if err: return err

    payload = json.loads(request.body)
    station = clean_station_payload(payload)
    if not station.get("station_name"):
        return JsonResponse({"error": "Station name is required"}, status=400)
    if station.get("latitude") in ("", None) or station.get("longitude") in ("", None):
        return JsonResponse({"error": "Latitude and longitude are required"}, status=400)

    with DATA_LOCK:
        existing = load_stations()
        if find_station_index(existing, station["station_id"]) is not None:
            return JsonResponse({"error": "Station ID already exists"}, status=409)
        stations = load_stations_from_json()
        stations.append(station)
        save_stations(stations)
    return JsonResponse(station, status=201)


def api_station_detail(request, station_id):
    if request.method == "GET":
        stations = load_stations()
        idx = find_station_index(stations, station_id)
        if idx is None:
            return JsonResponse({"error": "Station not found"}, status=404)
        return JsonResponse(stations[idx])

    if request.method == "PUT":
        err = require_admin(request)
        if err: return err
        updated = clean_station_payload(json.loads(request.body))
        updated["station_id"] = station_id
        with DATA_LOCK:
            stations = load_stations_from_json()
            idx = find_station_index(stations, station_id)
            if idx is None:
                return JsonResponse({"error": "Station not found"}, status=404)
            stations[idx] = updated
            save_stations(stations)
        return JsonResponse(updated)

    if request.method == "DELETE":
        err = require_admin(request)
        if err: return err
        with DATA_LOCK:
            stations = load_stations_from_json()
            idx = find_station_index(stations, station_id)
            if idx is None:
                return JsonResponse({"error": "Station not found"}, status=404)
            removed = stations.pop(idx)
            save_stations(stations)
        return JsonResponse({"deleted": removed})


def api_station_uvw(request, station_id):
    stations = load_stations()
    idx = find_station_index(stations, station_id)
    if idx is None:
        return JsonResponse({"error": "Station not found"}, status=404)
    date_value = request.GET.get("date", "").strip()
    hour_value = request.GET.get("hour", "").strip()
    minute_value = request.GET.get("minute", "").strip()
    # Prefer the original profiler files so multi-cycle Kolkata/Haringhata
    # uploads are kept as distinct profiles. Database readings are flattened
    # at upload time and remain a fallback for files no longer on disk.
    payload = _load_uploaded_folder_uvw_payload(
        stations[idx],
        date_value=date_value,
        hour_value=hour_value,
        minute_value=minute_value,
    )
    if payload is None:
        payload = _load_uploaded_uvw_payload(stations[idx], date_value)
    if payload is None:
        payload = load_station_uvw_payload(
            stations[idx],
            date_value=date_value,
            hour_value=hour_value,
            minute_value=minute_value,
        )
    return JsonResponse(payload)


def api_station_wind_barb(request, station_id):
    stations = load_stations()
    idx = find_station_index(stations, station_id)
    if idx is None:
        return JsonResponse({"error": "Station not found"}, status=404)
    date_value = request.GET.get("date", "").strip()
    payload = _load_uploaded_folder_wind_barb_payload(stations[idx], date_value)
    if payload is None:
        payload = _load_uploaded_wind_barb_payload(stations[idx], date_value)
    if payload is None:
        payload = load_station_wind_barb_payload(stations[idx], date_value=date_value)
    return JsonResponse(payload)


# ── Products ──────────────────────────────────────────────────────────────────

def api_products(request):
    if request.method == "GET":
        return JsonResponse(load_products(), safe=False)

    err = require_admin(request)
    if err: return err

    try:
        payload = _json_payload(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    if request.method == "PATCH":
        requested_order = payload.get("products")
        if not isinstance(requested_order, list):
            return JsonResponse({"error": "Products must be provided as an ordered list"}, status=400)
        requested_names = [str(name).strip() for name in requested_order]
        if not all(requested_names):
            return JsonResponse({"error": "Product names cannot be empty"}, status=400)

        with DATA_LOCK:
            products = load_products()
            existing_by_name = {name.lower(): name for name in products}
            requested_keys = [name.lower() for name in requested_names]
            if len(set(requested_keys)) != len(requested_keys):
                return JsonResponse({"error": "Product order contains duplicate names"}, status=400)
            if set(requested_keys) != set(existing_by_name):
                return JsonResponse({"error": "Product order must contain every existing product exactly once"}, status=400)
            reordered = [existing_by_name[key] for key in requested_keys]
            save_products(reordered, load_product_types())
        return JsonResponse({"products": reordered})

    if request.method != "POST":
        return JsonResponse({"error": "Method not allowed"}, status=405)

    name = str(payload.get("product_name", "")).strip()
    if not name:
        return JsonResponse({"error": "Product name is required"}, status=400)
    with DATA_LOCK:
        products = load_products()
        if name.lower() not in [p.lower() for p in products]:
            products.append(name)
            save_products(products)
    return JsonResponse({"products": load_products()})


def api_delete_product(request, product_name):
    err = require_admin(request)
    if err: return err
    if request.method == "DELETE":
        with DATA_LOCK:
            products = [p for p in load_products() if p.lower() != product_name.lower()]
            save_products(products)
        return JsonResponse({"products": load_products()})

    if request.method in {"PUT", "PATCH"}:
        try:
            payload = _json_payload(request)
        except ValueError as exc:
            return JsonResponse({"error": str(exc)}, status=400)
        new_name = str(payload.get("product_name", "")).strip()
        if not new_name:
            return JsonResponse({"error": "New product name is required"}, status=400)

        with DATA_LOCK:
            products = load_products()
            old_index = next(
                (index for index, name in enumerate(products) if name.lower() == product_name.lower()),
                None,
            )
            if old_index is None:
                return JsonResponse({"error": "Product not found"}, status=404)
            if any(
                index != old_index and name.lower() == new_name.lower()
                for index, name in enumerate(products)
            ):
                return JsonResponse({"error": "A product with this name already exists"}, status=409)

            product_types = load_product_types()
            old_name = products[old_index]
            product_type = product_types.pop(old_name, "custom")
            products[old_index] = new_name
            product_types[new_name] = product_type
            save_products(products, product_types)
        return JsonResponse({"products": products, "renamed": new_name})

    return JsonResponse({"error": "Method not allowed"}, status=405)



def api_kochi_profile(request):
    station_name = request.GET.get("station_name", "Kochi").strip()
    time_of_day = request.GET.get("time_of_day", "").strip().lower()
    if time_of_day not in ("morning", "evening"):
        return JsonResponse({"error": "time_of_day must be 'morning' or 'evening'"}, status=400)
    payload = build_kochi_profile_payload(station_name, time_of_day)
    return JsonResponse(payload)


# ── Admin auth ────────────────────────────────────────────────────────────────

def api_admin_status(request):
    if request.method != "GET":
        return JsonResponse({"error": "Method not allowed"}, status=405)
    return JsonResponse({
        "logged_in": is_admin_logged_in(request),
        "username": request.session.get("admin_username", ""),
    })

def api_admin_login(request):
    if request.method != "POST":
        return JsonResponse({"error": "Method not allowed"}, status=405)
    try:
        payload = _json_payload(request)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    settings = load_settings()
    correct_user = str(settings.get("admin_username", DEFAULT_ADMIN_USERNAME))
    correct_pass = str(settings.get("admin_password", DEFAULT_ADMIN_PASSWORD))

    configured_admin_valid = (
        username == correct_user
        and admin_password_matches(password, correct_pass)
    )
    django_user = authenticate(request, username=username, password=password)
    django_superuser_valid = bool(
        django_user
        and django_user.is_active
        and django_user.is_superuser
    )

    if not configured_admin_valid and not django_superuser_valid:
        return JsonResponse({"error": "Incorrect username or password"}, status=401)
    # Rotate the session identifier after authentication to prevent session fixation.
    request.session.cycle_key()
    request.session["admin_logged_in"] = True
    request.session["admin_username"] = username
    return JsonResponse({"logged_in": True, "username": username})

def api_admin_logout(request):
    if request.method != "POST":
        return JsonResponse({"error": "Method not allowed"}, status=405)
    request.session.flush()
    return JsonResponse({"logged_in": False})
