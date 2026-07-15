import re
from datetime import datetime
from typing import Any


STATIONS = [
    {"name": "Kochi", "latitude": 10.0428, "longitude": 76.3321},
    {"name": "Kolkata", "latitude": 22.5726, "longitude": 88.3639},
]

MONTH_MAP = {
    "Jan": "01",
    "Feb": "02",
    "Mar": "03",
    "Apr": "04",
    "May": "05",
    "Jun": "06",
    "Jul": "07",
    "Aug": "08",
    "Sep": "09",
    "Oct": "10",
    "Nov": "11",
    "Dec": "12",
}


def parse_observation_timestamp_from_name(file_name):
    match = re.search(
        r"(\d{2})([A-Za-z]{3})(\d{4})_(\d{2})_(\d{2})_(\d{2})",
        str(file_name),
    )
    if not match:
        return "", "", ""

    day, month_text, year, hour, minute, second = match.groups()
    month = MONTH_MAP.get(month_text.title())
    if not month:
        return "", "", ""

    timestamp = f"{year}-{month}-{day}T{hour}:{minute}:{second}"
    return timestamp, timestamp[:10], timestamp[11:19]


def _parse_number(value):
    match = re.search(r"[-+]?\d+(?:\.\d+)?", str(value))
    if not match:
        return None
    return float(match.group(0))


def _parse_lat_lon(value):
    number = _parse_number(value)
    if number is None:
        return None

    upper_value = str(value).upper()
    if "S" in upper_value or "W" in upper_value:
        return -abs(number)

    return number


def _read_uploaded_file_text(uploaded_file: Any) -> str:
    try:
        uploaded_file.seek(0)
    except Exception:
        pass

    raw = uploaded_file.read()

    try:
        uploaded_file.seek(0)
    except Exception:
        pass

    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="ignore")
    return str(raw)


def _clean_numeric_token(value):
    text = str(value).strip().replace("+", "")

    if text in {"", "999", "999.0", "999.00", "9999", "9999.0"}:
        return None

    try:
        return float(text)
    except ValueError:
        return _parse_number(text)


def _clean_wind_component(value):
    """Return a usable profiler component and reject corrupt sentinel values."""
    number = _clean_numeric_token(value)
    if number is None or abs(number) > 200:
        return None
    return number


def _normalise_key(key):
    return re.sub(r"[^a-z0-9]+", "", key.lower())


def _apply_station_fallbacks(text, header_data):
    if header_data.get("latitude") is not None and header_data.get("longitude") is not None:
        return

    lower_text = text.lower()

    if "haringhata" in lower_text or "kolkata" in lower_text or "_sht" in lower_text:
        header_data["latitude"] = 22.5726
        header_data["longitude"] = 88.3639
    elif (
        "kochi" in lower_text
        or "cusat" in lower_text
        or ("exp_dbs_ch4" in lower_text and "beam" in lower_text and ".mmts" in lower_text)
    ):
        header_data["latitude"] = 10.0428
        header_data["longitude"] = 76.3321


def _parse_colon_metadata_line(line, header_data):
    if ":" not in line:
        return

    key, value = [part.strip() for part in line.split(":", 1)]
    key = _normalise_key(key)

    if key in {"latitude", "lat"}:
        header_data["latitude"] = _parse_lat_lon(value)
    elif key in {"longitude", "long", "lon"}:
        header_data["longitude"] = _parse_lat_lon(value)
    elif key in {"elevation", "amsl", "altitude"}:
        header_data["elevation"] = _parse_number(value)
    elif key in {"baudlength", "baud", "pulselength"}:
        header_data["baud_length"] = _parse_number(value)
    elif key in {"resolution", "rangeresolution"}:
        header_data["resolution"] = _parse_number(value)
    elif key == "rain":
        header_data["rain"] = value.lower() in {"1", "true", "yes", "y"}
    elif key == "date":
        header_data["date"] = value
    elif key == "time":
        header_data["time"] = value


def _is_kolkata_header(line):
    lower = line.lower()
    return "ht(m)" in lower and ("u(ms)" in lower or "v(ms)" in lower)


def _find_column_index(header, candidates):
    normal_header = [_normalise_key(col) for col in header]
    normal_candidates = {_normalise_key(col) for col in candidates}

    for index, col in enumerate(normal_header):
        if col in normal_candidates:
            return index

    return None


def _metadata_value(metadata, key):
    target = _normalise_key(key)
    for meta_key, value in metadata.items():
        if _normalise_key(meta_key) == target:
            return value
    return ""


def parse_metadata_block(lines23):
    metadata = {}
    for line in lines23:
        if ":" not in line:
            continue
        key, value = [part.strip() for part in line.split(":", 1)]
        metadata[key] = value

    date = _metadata_value(metadata, "Date")
    time = _metadata_value(metadata, "Time")
    metadata["timestamp_str"] = f"{date} {time}".strip()
    return metadata


def _normalise_kolkata_timestamp(metadata):
    date = _metadata_value(metadata, "Date")
    time = _metadata_value(metadata, "Time")
    timestamp_text = f"{date} {time}".strip()

    for fmt in (
        "%d %B %Y %H:%M:%S",
        "%d %b %Y %H:%M:%S",
        "%d-%m-%Y %H:%M:%S",
        "%d/%m/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%d %B %Y %H:%M",
        "%d %b %Y %H:%M",
        "%d-%m-%Y %H:%M",
        "%d/%m/%Y %H:%M",
        "%Y-%m-%d %H:%M",
    ):
        try:
            parsed = datetime.strptime(timestamp_text, fmt)
            return (
                parsed.strftime("%Y-%m-%dT%H:%M:%S"),
                parsed.date().isoformat(),
                parsed.time().replace(microsecond=0).isoformat(),
            )
        except ValueError:
            continue

    return timestamp_text, date, time


def _is_kolkata_stop_line(line):
    if not line:
        return True

    lower = line.lower()
    return (
        lower.startswith("project name")
        or lower.startswith("cycle ended")
        or "cycle ended" in lower
        or line.startswith("-")
    )


def _starts_with_numeric_token(line):
    parts = re.split(r"\s+", line.strip())
    return bool(parts and _clean_numeric_token(parts[0]) is not None)


def parse_kolkata_uvw_cycles(text, file_name=""):
    lines = text.splitlines()
    header_data = {}
    cycles = []

    i = 0
    n = len(lines)

    while i < n:
        while i < n and _is_kolkata_stop_line(lines[i].strip()) and not lines[i].strip().lower().startswith("project name"):
            i += 1

        if i >= n:
            break

        header_index = i
        while header_index < n and not _is_kolkata_header(lines[header_index].strip()):
            header_index += 1

        if header_index >= n:
            break

        metadata_lines = lines[i:header_index]
        metadata = parse_metadata_block(metadata_lines)
        for meta_line in metadata_lines:
            _parse_colon_metadata_line(meta_line.strip(), header_data)

        header = re.split(r"\s+", lines[header_index].strip())
        i = header_index + 1

        ht_idx = _find_column_index(header, {"Ht(m)", "Height(m)", "Height", "Ht"})
        u_idx = _find_column_index(header, {"U(ms)", "U(m/s)", "U"})
        v_idx = _find_column_index(header, {"V(ms)", "V(m/s)", "V"})
        w_idx = _find_column_index(header, {"W(ms)", "W(m/s)", "W"})

        if any(index is None for index in [ht_idx, u_idx, v_idx]):
            while i < n and not lines[i].strip().lower().startswith("project name"):
                i += 1
            continue

        required_indexes = [ht_idx, u_idx, v_idx]
        if w_idx is not None:
            required_indexes.append(w_idx)
        max_idx = max(required_indexes)

        levels = []
        while i < n:
            data_line = lines[i].strip()

            if _is_kolkata_stop_line(data_line):
                break

            parts = re.split(r"\s+", data_line)
            if len(parts) != len(header):
                if not _starts_with_numeric_token(data_line):
                    break
                if len(parts) < len(header):
                    parts.extend([""] * (len(header) - len(parts)))
                else:
                    parts = parts[:len(header)]

            if len(parts) <= max_idx:
                i += 1
                continue

            height_m = _clean_numeric_token(parts[ht_idx])
            u_value = _clean_wind_component(parts[u_idx])
            v_value = _clean_wind_component(parts[v_idx])
            w_value = _clean_wind_component(parts[w_idx]) if w_idx is not None else 0

            if any(value is None for value in [height_m, u_value, v_value, w_value]):
                i += 1
                continue

            levels.append({
                "height_km": round(height_m / 1000.0, 3),
                "u": float(u_value),
                "v": float(v_value),
                "w": float(w_value),
            })
            i += 1

        if levels:
            timestamp, date, time = _normalise_kolkata_timestamp(metadata)
            cycles.append({
                "timestamp": timestamp,
                "date": date,
                "time": time,
                "file_name": file_name,
                "levels": levels,
            })

        while i < n and lines[i].strip() == "":
            i += 1
        while i < n:
            line = lines[i].strip()
            lower = line.lower()
            if lower.startswith("project name"):
                break
            if line.startswith("-") or "cycle ended" in lower:
                i += 1
                continue
            break

    _apply_station_fallbacks(f"{file_name}\n{text}", header_data)
    header_data.setdefault("rain", False)

    return header_data, cycles


def _parse_kolkata_text(text):
    header_data, cycles = parse_kolkata_uvw_cycles(text)
    wind_readings = [
        level
        for cycle in cycles
        for level in cycle.get("levels", [])
    ]

    if cycles:
        header_data.setdefault("timestamp", cycles[0].get("timestamp", ""))
        header_data.setdefault("date", cycles[0].get("date", ""))
        header_data.setdefault("time", cycles[0].get("time", ""))

    return header_data, wind_readings


def _parse_kochi_csv_text(text, file_name=""):
    header_data = {}
    wind_readings = []
    timestamp, date, time = parse_observation_timestamp_from_name(file_name)
    if timestamp:
        header_data["timestamp"] = timestamp
        header_data["date"] = date
        header_data["time"] = time

    data_started = False

    for line in text.splitlines():
        line = line.strip()

        if not line:
            continue

        lower = line.lower()

        if "longitude=" in lower and "latitude=" in lower:
            for part in line.split(","):
                if "=" not in part:
                    continue

                key, value = part.split("=", 1)
                key = key.strip().lower()
                value = value.strip()

                if key == "longitude":
                    header_data["longitude"] = _parse_lat_lon(value)
                elif key == "latitude":
                    header_data["latitude"] = _parse_lat_lon(value)
                elif key == "elevation":
                    header_data["elevation"] = _parse_number(value)
                elif key == "baud-length":
                    header_data["baud_length"] = _parse_number(value)
                elif key == "resolution":
                    header_data["resolution"] = _parse_number(value)
                elif key == "rain":
                    header_data["rain"] = value.lower() in {"1", "true", "yes", "y"}

            continue

        if lower.startswith("height") or "zonal" in lower:
            data_started = True
            continue

        if not data_started:
            continue

        parts = [part.strip() for part in line.split(",")]

        if len(parts) < 4:
            continue

        height_km = _clean_numeric_token(parts[0])
        u_value = _clean_numeric_token(parts[1])
        v_value = _clean_numeric_token(parts[2])
        w_value = _clean_numeric_token(parts[3])

        if any(value is None for value in [height_km, u_value, v_value, w_value]):
            continue

        wind_readings.append({
            "height_km": float(height_km),
            "u": float(u_value),
            "v": float(v_value),
            "w": float(w_value),
        })

    _apply_station_fallbacks(text, header_data)

    return header_data, wind_readings


def parse_uvw_file(file):
    text = _read_uploaded_file_text(file)
    file_name = str(getattr(file, "name", ""))
    source_text = f"{file_name}\n{text}"
    lower = source_text.lower()

    if (
        "ht(m)" in lower
        or "u(ms)" in lower
        or "v(ms)" in lower
        or "ws(ms)" in lower
        or "project name" in lower
        or "cycle ended" in lower
    ):
        header_data, wind_readings = _parse_kolkata_text(text)
        _apply_station_fallbacks(source_text, header_data)
        return header_data, wind_readings

    header_data, wind_readings = _parse_kochi_csv_text(text, file_name)
    _apply_station_fallbacks(source_text, header_data)
    return header_data, wind_readings


def get_station_name(latitude, longitude, threshold=0.5):
    if latitude is None or longitude is None:
        return "Unknown Station"

    for station in STATIONS:
        if (
            abs(station["latitude"] - latitude) <= threshold
            and abs(station["longitude"] - longitude) <= threshold
        ):
            return station["name"]

    return "Unknown Station"
