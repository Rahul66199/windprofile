# dashboard/data_utils.py
from __future__ import annotations

import json
import re
import secrets
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from .parser import parse_kolkata_uvw_cycles

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
STATIONS_FILE = DATA_DIR / "stations.json"
PRODUCTS_FILE = DATA_DIR / "products.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

EXTERNAL_FOLDER_CONFIG = {
    "intern_2026_cusat_kochi": {"station_id": "KOC01", "feed_label": "Kochi wind profiler"},
    "intern_cu_windprofiler":  {"station_id": "KOL01", "feed_label": "Kolkata wind profiler"},
}

DATA_LOCK = threading.Lock()
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "admin123"


# ── JSON I/O ──────────────────────────────────────────────────────────────────

def load_json(path: Path, default_value: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default_value
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2)


# ── Settings ──────────────────────────────────────────────────────────────────

def load_settings() -> dict[str, Any]:
    dashboard_settings = load_json(
        SETTINGS_FILE,
        {
            "map_center": [22.5937, 78.9629],
            "map_zoom": 5,
        },
    )
    from django.conf import settings

    dashboard_settings["admin_username"] = settings.ADMIN_USERNAME
    dashboard_settings["admin_password"] = settings.ADMIN_PASSWORD
    return dashboard_settings


# ── Stations ──────────────────────────────────────────────────────────────────

def load_stations_from_json() -> list[dict[str, Any]]:
    data = load_json(STATIONS_FILE, {"stations": []})
    return data.get("stations", [])


def load_stations() -> list[dict[str, Any]]:
    return merge_external_folder_stations(load_stations_from_json())


def save_stations(stations: list[dict[str, Any]]) -> None:
    save_json(STATIONS_FILE, {"stations": stations})


def find_station_index(stations: list[dict[str, Any]], station_id: str) -> int | None:
    for index, station in enumerate(stations):
        if str(station.get("station_id")) == station_id:
            return index
    return None


def station_is_active(station: dict[str, Any]) -> bool:
    return str(station.get("status", "")).strip().lower() == "active"


def clean_station_payload(payload: dict[str, Any]) -> dict[str, Any]:
    station = {}
    for key, value in payload.items():
        clean_key = str(key).strip()
        if not clean_key:
            continue
        station[clean_key] = value

    station["station_name"] = str(station.get("station_name", "")).strip()
    station["station_id"]   = str(station.get("station_id", "")).strip().upper()
    station["status"]       = str(station.get("status", "Active")).strip().title()

    if not station["station_id"] and station["station_name"]:
        station["station_id"] = (
            station["station_name"][:3].upper() + datetime.now().strftime("%H%M%S")
        )

    for numeric_key in ("latitude", "longitude", "elevation", "wind_height"):
        if numeric_key in station and station[numeric_key] not in ("", None):
            try:
                station[numeric_key] = float(station[numeric_key])
            except (TypeError, ValueError):
                pass

    station.setdefault("last_update_time", datetime.now().strftime("%Y-%m-%d %H:%M IST"))
    return station


# ── Products ──────────────────────────────────────────────────────────────────

def load_products() -> list[str]:
    data = load_json(PRODUCTS_FILE, {"products": []})
    return data.get("products", [])


DEFAULT_PRODUCT_TYPES = {
    "Availability": "availability",
    "Derived UVW": "derived_uvw",
    "UVW": "uvw",
    "Wind Barb": "wind_barb",
}


def load_product_types() -> dict[str, str]:
    data = load_json(PRODUCTS_FILE, {"products": [], "types": {}})
    saved_types = data.get("types", {})
    return {
        product: str(saved_types.get(product) or DEFAULT_PRODUCT_TYPES.get(product) or "custom")
        for product in data.get("products", [])
    }


def save_products(products: list[str], product_types: dict[str, str] | None = None) -> None:
    types = product_types or load_product_types()
    save_json(PRODUCTS_FILE, {
        "products": products,
        "types": {product: types.get(product, "custom") for product in products},
    })


# ── Auth ──────────────────────────────────────────────────────────────────────

def admin_password_matches(submitted_password: str, configured_password: str) -> bool:
    return secrets.compare_digest(submitted_password, configured_password)


# ── Geo / file parsing helpers ────────────────────────────────────────────────

def parse_number(token: str) -> float | None:
    match = re.search(r"[-+]?\d+(?:\.\d+)?", token)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def parse_signed_number(token: str) -> float | None:
    cleaned = token.strip().replace("+", "")
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return parse_number(cleaned)


def extract_geo_from_file(
    path: Path,
) -> tuple[float | None, float | None, float | None]:
    latitude = longitude = elevation = None
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as file:
            for line in file:
                line_lower = line.lower()
                if "longitude=" in line_lower and "latitude=" in line_lower:
                    parts = [part.strip() for part in line.split(",")]
                    for part in parts:
                        key_val = part.split("=", 1)
                        if len(key_val) != 2:
                            continue
                        key = key_val[0].strip().lower()
                        value = key_val[1].strip()
                        parsed = parse_number(value)
                        if parsed is None:
                            continue
                        if key == "latitude":
                            latitude = parsed
                        elif key == "longitude":
                            longitude = parsed
                        elif key == "elevation":
                            elevation = parsed
                    if latitude is not None and longitude is not None:
                        return latitude, longitude, elevation

                if line_lower.startswith("latitude:") and latitude is None:
                    latitude = parse_number(line)
                elif line_lower.startswith("longitude:") and longitude is None:
                    longitude = parse_number(line)
                elif line_lower.startswith("amsl:") and elevation is None:
                    elevation = parse_number(line)
    except OSError:
        return None, None, None
    return latitude, longitude, elevation


# ── File discovery ────────────────────────────────────────────────────────────

def latest_file_in_folder(folder: Path) -> tuple[Path | None, int]:
    if not folder.exists() or not folder.is_dir():
        return None, 0
    files = [entry for entry in folder.rglob("*") if entry.is_file()]
    if not files:
        return None, 0
    latest = max(files, key=lambda item: item.stat().st_mtime)
    return latest, len(files)


def list_uvw_files(folder: Path) -> list[Path]:
    files = [
        entry
        for entry in folder.rglob("*")
        if entry.is_file() and re.fullmatch(r"\.uvw\d*", entry.suffix, re.IGNORECASE)
    ]
    return sorted(files, key=lambda item: item.stat().st_mtime, reverse=True)


def station_folder_path(station: dict[str, Any]) -> Path | None:
    folder_names: list[str] = []
    legacy_folder = str(station.get("source_folder", "")).strip()
    if legacy_folder:
        folder_names.append(legacy_folder)

    station_id = str(station.get("station_id", "")).strip()
    for name, config in EXTERNAL_FOLDER_CONFIG.items():
        if str(config.get("station_id", "")).strip() == station_id:
            folder_names.append(name)

    folder_names = list(dict.fromkeys(folder_names))
    if not folder_names:
        return None

    best_folder = None
    best_count = 0
    for folder_name in folder_names:
        for candidate in (BASE_DIR / folder_name, DATA_DIR / folder_name):
            if not candidate.exists() or not candidate.is_dir():
                continue
            file_count = len(list_uvw_files(candidate))
            if file_count > best_count:
                best_folder = candidate
                best_count = file_count
    return best_folder


# ── External folder merging ───────────────────────────────────────────────────

def build_external_station(
    folder_name: str, config: dict[str, Any]
) -> dict[str, Any] | None:
    candidates = [BASE_DIR / folder_name, DATA_DIR / folder_name]
    latest_path = None
    total_files = 0
    for candidate in candidates:
        latest, count = latest_file_in_folder(candidate)
        if count > total_files:
            latest_path = latest
            total_files = count

    if latest_path is None:
        return None

    station_id = str(config.get("station_id", "")).strip()
    if not station_id:
        return None

    latest_mtime = latest_path.stat().st_mtime
    updated_time = datetime.fromtimestamp(latest_mtime).strftime("%Y-%m-%d %H:%M IST")
    return {
        "station_id": station_id,
        "feed_label": str(config.get("feed_label", folder_name)),
        "file_name": latest_path.name,
        "raw_processed_data": "Processed Data",
        "data_availability": "Available",
        "last_update_time": updated_time,
        "latest_mtime": latest_mtime,
        "total_files": total_files,
    }


def merge_external_folder_stations(
    stations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged_stations = [dict(station) for station in stations]
    station_map = {
        str(station.get("station_id", "")): station for station in merged_stations
    }

    for folder_name, config in EXTERNAL_FOLDER_CONFIG.items():
        external_data = build_external_station(folder_name, config)
        if not external_data:
            continue

        station = station_map.get(str(external_data["station_id"]))
        if not station:
            continue

        feed_labels = station.setdefault("_external_feed_labels", [])
        feed_labels.append(str(external_data["feed_label"]))

        station["status"] = "Active"
        station["current_source"] = f"Folder feeds: {', '.join(feed_labels)}"
        station["raw_processed_data"] = external_data["raw_processed_data"]
        station["data_availability"] = external_data["data_availability"]
        station["total_files"] = (
            int(station.get("total_files", 0) or 0)
            + int(external_data["total_files"])
        )

        previous_latest = float(station.get("_external_latest_mtime", 0) or 0)
        if external_data["latest_mtime"] >= previous_latest:
            station["_external_latest_mtime"] = external_data["latest_mtime"]
            station["file_name"] = external_data["file_name"]
            station["last_update_time"] = external_data["last_update_time"]

    for station in merged_stations:
        station.pop("_external_feed_labels", None)
        station.pop("_external_latest_mtime", None)

    return merged_stations


# ── UVW file parsers ──────────────────────────────────────────────────────────

def parse_uvw_csv_profile(path: Path) -> list[dict[str, Any]]:
    cycles: list[dict[str, Any]] = []
    timestamp = path.stem
    date_match = re.search(
        r"(\d{2})([A-Za-z]{3})(\d{4})_(\d{2})_(\d{2})_(\d{2})", path.name
    )
    if date_match:
        day, month_text, year, hour, minute, second = date_match.groups()
        month_map = {
            "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04",
            "May": "05", "Jun": "06", "Jul": "07", "Aug": "08",
            "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
        }
        month = month_map.get(month_text.title(), "01")
        timestamp = f"{year}-{month}-{day}T{hour}:{minute}:{second}"

    levels: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="ignore") as file:
        for line in file:
            line = line.strip()
            if not line or "=" in line or line.lower().startswith("height"):
                continue
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 4:
                continue
            height_km = parse_number(parts[0])
            u_value   = parse_number(parts[1])
            v_value   = parse_number(parts[2])
            w_value   = parse_number(parts[3])
            if any(x is None for x in (height_km, u_value, v_value, w_value)):
                continue
            if height_km <= 0 or height_km > 30:
                continue
            levels.append({
                "height_km": height_km,
                "height_m":  round(height_km * 1000, 1),
                "u": u_value,
                "v": v_value,
                "w": w_value,
            })

    if levels:
        cycles.append({
            "timestamp": timestamp,
            "date":      timestamp[:10],
            "time":      timestamp[11:19] if "T" in timestamp else "",
            "file_name": path.name,
            "levels":    levels,
        })
    return cycles


def parse_uvw1_profile(path: Path) -> list[dict[str, Any]]:
    cycles: list[dict[str, Any]] = []
    current_meta: dict[str, str] = {}
    current_levels: list[dict[str, Any]] = []
    in_data = False

    def flush_cycle() -> None:
        nonlocal current_meta, current_levels, in_data
        if current_levels:
            timestamp = ""
            if current_meta.get("date") and current_meta.get("time"):
                try:
                    parsed = datetime.strptime(
                        f"{current_meta['date']} {current_meta['time']}",
                        "%d %B %Y %H:%M:%S",
                    )
                    timestamp = parsed.strftime("%Y-%m-%dT%H:%M:%S")
                except ValueError:
                    timestamp = (
                        f"{current_meta.get('date', '')} "
                        f"{current_meta.get('time', '')}".strip()
                    )
            cycles.append({
                "timestamp": timestamp,
                "date":      current_meta.get("date", ""),
                "time":      current_meta.get("time", ""),
                "file_name": path.name,
                "levels":    [dict(level) for level in current_levels],
            })
        current_meta.clear()
        current_levels.clear()
        in_data = False

    with path.open("r", encoding="utf-8", errors="ignore") as file:
        for raw_line in file:
            line = raw_line.strip()
            if not line:
                continue
            if "cycle ended" in line.lower():
                flush_cycle()
                continue
            if line.lower().startswith("date :"):
                current_meta["date"] = line.split(":", 1)[1].strip()
                continue
            if line.lower().startswith("time :"):
                current_meta["time"] = line.split(":", 1)[1].strip()
                continue
            if line.lower().startswith("ht(m)") or line.lower().startswith("height"):
                in_data = True
                continue
            if not in_data:
                continue

            parts = re.split(r"\s+", line)
            if len(parts) < 4:
                continue

            height_m = parse_signed_number(parts[0])
            u_value  = parse_signed_number(parts[2] if len(parts) > 6 else parts[1])
            v_value  = parse_signed_number(parts[4] if len(parts) > 6 else parts[2])
            w_value  = parse_signed_number(parts[6] if len(parts) > 6 else parts[3])
            if any(x is None for x in (height_m, u_value, v_value, w_value)):
                continue

            current_levels.append({
                "height_m":  height_m,
                "height_km": round(height_m / 1000, 3),
                "u": u_value,
                "v": v_value,
                "w": w_value,
            })

    flush_cycle()
    return cycles


def parse_kolkata_uvw_profile(path: Path, text: str | None = None) -> list[dict[str, Any]]:
    try:
        source_text = text if text is not None else path.read_text(
            encoding="utf-8",
            errors="ignore",
        )
    except OSError:
        return []

    _, cycles = parse_kolkata_uvw_cycles(source_text, path.name)
    return cycles


def looks_like_kolkata_uvw(path: Path, text: str) -> bool:
    source = f"{path.name}\n{text[:4096]}".lower()
    return any(
        marker in source
        for marker in (
            "_sht",
            "project name",
            "ht(m)",
            "u(ms)",
            "v(ms)",
            "ws(ms)",
            "cycle ended",
        )
    )


def parse_uvw_file(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    if looks_like_kolkata_uvw(path, text):
        cycles = parse_kolkata_uvw_profile(path, text)
        if cycles:
            return cycles

    if path.suffix.lower() == ".uvw1":
        return parse_uvw1_profile(path)
    return parse_uvw_csv_profile(path)


# ── Cycle selection ───────────────────────────────────────────────────────────

def select_uvw_cycle(
    cycles: list[dict[str, Any]],
    date_value: str = "",
    hour_value: str = "",
    minute_value: str = "",
) -> int:
    if not cycles or not date_value:
        return 0

    hour   = hour_value or "00"
    minute = minute_value or "00"
    target_prefix = f"{date_value}T{hour}:{minute}"

    for index, cycle in enumerate(cycles):
        if str(cycle.get("timestamp", "")).startswith(target_prefix):
            return index
    for index, cycle in enumerate(cycles):
        if str(cycle.get("timestamp", "")).startswith(date_value):
            return index
    return 0


def cycles_for_date(
    cycles: list[dict[str, Any]],
    date_value: str = "",
) -> list[dict[str, Any]]:
    if not date_value:
        return cycles
    return [
        cycle for cycle in cycles
        if str(cycle.get("timestamp", "")).startswith(date_value)
        or str(cycle.get("date", "")).startswith(date_value)
    ]


def no_data_for_date_message(date_value: str) -> str:
    if date_value:
        return f"No data available for the selected date ({date_value})."
    return "No data available."


def cycle_hour_from_timestamp(timestamp: str) -> int:
    if len(timestamp) >= 13 and timestamp[10] == "T":
        try:
            return int(timestamp[11:13])
        except ValueError:
            return 12
    return 12


# ── UVW payload builders ──────────────────────────────────────────────────────

def load_station_uvw_payload(
    station: dict[str, Any],
    date_value: str = "",
    hour_value: str = "",
    minute_value: str = "",
) -> dict[str, Any]:
    folder = station_folder_path(station)
    if folder is None:
        return {
            "station_id":   station.get("station_id"),
            "station_name": station.get("station_name"),
            "available":    False,
            "message":      no_data_for_date_message(date_value)
                            if date_value
                            else "No wind profiler folder is linked to this station.",
            "cycles":       [],
        }

    files = list_uvw_files(folder)
    if not files:
        return {
            "station_id":   station.get("station_id"),
            "station_name": station.get("station_name"),
            "available":    False,
            "message":      no_data_for_date_message(date_value)
                            if date_value
                            else "No .uvw* files were found for this station.",
            "cycles":       [],
        }

    cycles: list[dict[str, Any]] = []
    for file_path in files:
        cycles.extend(parse_uvw_file(file_path))

    cycles.sort(key=lambda c: str(c.get("timestamp", "")), reverse=True)
    if not cycles:
        return {
            "station_id":   station.get("station_id"),
            "station_name": station.get("station_name"),
            "available":    False,
            "message":      no_data_for_date_message(date_value)
                            if date_value
                            else "Profiler files were found but no U/V/W levels could be parsed.",
            "cycles":       [],
        }

    if date_value:
        cycles = cycles_for_date(cycles, date_value)
        if not cycles:
            return {
                "station_id":   station.get("station_id"),
                "station_name": station.get("station_name"),
                "available":    False,
                "message":      no_data_for_date_message(date_value),
                "cycles":       [],
            }

    selected_index = select_uvw_cycle(cycles, date_value, hour_value, minute_value)
    selected_cycle = cycles[selected_index]
    return {
        "station_id":           station.get("station_id"),
        "station_name":         station.get("station_name"),
        "available":            True,
        "source_folder":        folder.name,
        "file_name":            selected_cycle.get("file_name", files[0].name),
        "selected_cycle_index": selected_index,
        "total_cycles":         len(cycles),
        "timestamp":            selected_cycle.get("timestamp", ""),
        "date":                 selected_cycle.get("date", ""),
        "time":                 selected_cycle.get("time", ""),
        "levels":               selected_cycle.get("levels", []),
        "cycles": [
            {
                "timestamp":   c.get("timestamp", ""),
                "date":        c.get("date", ""),
                "time":        c.get("time", ""),
                "file_name":   c.get("file_name", ""),
                "level_count": len(c.get("levels", [])),
            }
            for c in cycles[:24]
        ],
    }


# ── Wind barb payload builders ────────────────────────────────────────────────

def format_wind_barb_date_label(
    date_value: str, cycle: dict[str, Any] | None
) -> str:
    candidates: list[str] = []
    if cycle and cycle.get("date"):
        candidates.append(str(cycle["date"]))
    if date_value:
        candidates.append(date_value)
    if cycle and cycle.get("timestamp"):
        candidates.append(str(cycle["timestamp"])[:10])

    for raw in candidates:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            try:
                return datetime.strptime(raw, "%Y-%m-%d").strftime("%d %B %Y")
            except ValueError:
                continue
        if raw:
            return raw
    return "Latest"


def pick_morning_evening_profiles(
    cycles: list[dict[str, Any]],
    date_value: str = "",
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not cycles:
        return None, None

    filtered = cycles
    if date_value:
        filtered = cycles_for_date(cycles, date_value)
        if not filtered:
            return None, None

    morning = min(
        filtered,
        key=lambda c: abs(cycle_hour_from_timestamp(str(c.get("timestamp", ""))) - 11),
    )
    evening = min(
        filtered,
        key=lambda c: abs(cycle_hour_from_timestamp(str(c.get("timestamp", ""))) - 17),
    )

    if morning is evening and len(filtered) > 1:
        sorted_cycles = sorted(
            filtered,
            key=lambda c: cycle_hour_from_timestamp(str(c.get("timestamp", ""))),
        )
        morning = sorted_cycles[0]
        evening = sorted_cycles[-1]

    return morning, evening


def serialize_wind_barb_profile(
    cycle: dict[str, Any] | None, label: str
) -> dict[str, Any]:
    if cycle is None:
        return {"label": label, "timestamp": "", "time": "", "levels": []}
    return {
        "label":     label,
        "timestamp": cycle.get("timestamp", ""),
        "time":      cycle.get("time", ""),
        "file_name": cycle.get("file_name", ""),
        "levels":    cycle.get("levels", []),
    }


def load_station_wind_barb_payload(
    station: dict[str, Any],
    date_value: str = "",
) -> dict[str, Any]:
    folder = station_folder_path(station)
    if folder is None:
        return {
            "station_id":   station.get("station_id"),
            "station_name": station.get("station_name"),
            "available":    False,
            "message":      no_data_for_date_message(date_value)
                            if date_value
                            else "No wind profiler folder is linked to this station.",
        }

    files = list_uvw_files(folder)
    if not files:
        return {
            "station_id":   station.get("station_id"),
            "station_name": station.get("station_name"),
            "available":    False,
            "message":      no_data_for_date_message(date_value)
                            if date_value
                            else "No .uvw* files were found for this station.",
        }

    cycles: list[dict[str, Any]] = []
    for file_path in files:
        cycles.extend(parse_uvw_file(file_path))

    cycles.sort(key=lambda c: str(c.get("timestamp", "")), reverse=True)
    if not cycles:
        return {
            "station_id":   station.get("station_id"),
            "station_name": station.get("station_name"),
            "available":    False,
            "message":      no_data_for_date_message(date_value)
                            if date_value
                            else "Profiler files were found but no wind barb levels could be parsed.",
        }

    if date_value:
        cycles = cycles_for_date(cycles, date_value)
        if not cycles:
            return {
                "station_id":   station.get("station_id"),
                "station_name": station.get("station_name"),
                "available":    False,
                "message":      no_data_for_date_message(date_value),
            }

    morning_cycle, evening_cycle = pick_morning_evening_profiles(cycles, date_value)
    date_label   = format_wind_barb_date_label(date_value, morning_cycle or evening_cycle)
    station_name = str(station.get("station_name", "Station"))
    return {
        "station_id":   station.get("station_id"),
        "station_name": station_name,
        "available":    True,
        "title":        f"Windbarb_{date_label}_{station_name}",
        "date_label":   date_label,
        "morning":      serialize_wind_barb_profile(morning_cycle, "Morning"),
        "evening":      serialize_wind_barb_profile(evening_cycle, "Evening"),
    }
