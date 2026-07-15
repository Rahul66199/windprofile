"""Kochi wind-profiler profile processing for dashboard JSON responses."""

from __future__ import annotations

import math
from typing import Any

from .models import UploadedUVWFile
from .parser import parse_observation_timestamp_from_name


def _file_time_of_day(uvw_file: UploadedUVWFile) -> str:
    timestamp, _, _ = parse_observation_timestamp_from_name(uvw_file.file.name)
    if len(timestamp) >= 13:
        try:
            hour = int(timestamp[11:13])
        except ValueError:
            hour = 12
        return "morning" if abs(hour - 11) <= abs(hour - 17) else "evening"
    return uvw_file.time_of_day


def _readings_as_arrays(uvw_file: UploadedUVWFile) -> dict[str, list[float]]:
    readings = uvw_file.wind_readings.order_by("height_km")
    return {
        "height_km": [r.height_km for r in readings],
        "u": [r.u for r in readings],
        "v": [r.v for r in readings],
        "w": [r.w for r in readings],
    }


def _closest_index(values: list[float], target: float) -> int:
    return min(range(len(values)), key=lambda i: abs(values[i] - target))


def merge_two_resolutions(
    fine: dict[str, list[float]],
    coarse: dict[str, list[float]],
) -> dict[str, list[float]]:
    h_fine, u_fine, v_fine, w_fine = fine["height_km"], fine["u"], fine["v"], fine["w"]
    h_coarse, u_coarse, v_coarse, w_coarse = (
        coarse["height_km"],
        coarse["u"],
        coarse["v"],
        coarse["w"],
    )

    if not h_fine or not h_coarse:
        return fine if h_fine else coarse

    overlap_min = max(min(h_fine), min(h_coarse))
    overlap_max = min(max(h_fine), max(h_coarse))

    h_merged = list(h_fine)
    u_merged = list(u_fine)
    v_merged = list(v_fine)
    w_merged = list(w_fine)

    for i, height in enumerate(h_fine):
        if overlap_min <= height <= overlap_max:
            idx = _closest_index(h_coarse, height)
            u_merged[i] = (u_fine[i] + u_coarse[idx]) / 2
            v_merged[i] = (v_fine[i] + v_coarse[idx]) / 2
            w_merged[i] = (w_fine[i] + w_coarse[idx]) / 2

    fine_max = max(h_fine)
    for i, height in enumerate(h_coarse):
        if height > fine_max:
            h_merged.append(height)
            u_merged.append(u_coarse[i])
            v_merged.append(v_coarse[i])
            w_merged.append(w_coarse[i])

    return {"height_km": h_merged, "u": u_merged, "v": v_merged, "w": w_merged}


def _gradient(values: list[float], x: list[float]) -> list[float]:
    n = len(values)
    if n < 2:
        return [0.0] * n

    grad = [0.0] * n
    for i in range(n):
        if i == 0:
            grad[i] = (values[1] - values[0]) / (x[1] - x[0])
        elif i == n - 1:
            grad[i] = (values[-1] - values[-2]) / (x[-1] - x[-2])
        else:
            grad[i] = (values[i + 1] - values[i - 1]) / (x[i + 1] - x[i - 1])
    return grad


def compute_wind_speed_direction_shear(
    merged: dict[str, list[float]],
) -> dict[str, list[float]]:
    h_km = merged["height_km"]
    u = merged["u"]
    v = merged["v"]

    wind_speed = [math.hypot(uu, vv) for uu, vv in zip(u, v)]
    wind_dir = [(270 - math.degrees(math.atan2(vv, uu))) % 360 for uu, vv in zip(u, v)]
    wind_shear = _gradient(wind_speed, [height * 1000 for height in h_km])

    return {
        "height_km": h_km,
        "wind_speed": wind_speed,
        "wind_dir": wind_dir,
        "wind_shear": wind_shear,
    }


def find_matching_pair(
    station_name: str,
    time_of_day: str,
) -> tuple[UploadedUVWFile | None, UploadedUVWFile | None]:
    candidates = (
        UploadedUVWFile.objects.filter(
            station_name__iexact=station_name,
        )
        .prefetch_related("wind_readings")
        .order_by("-uploaded_at")
    )

    fine_file = None
    coarse_file = None
    for uvw_file in candidates:
        if _file_time_of_day(uvw_file) != time_of_day:
            continue
        if uvw_file.baud_length is None:
            continue
        if fine_file is None and uvw_file.baud_length <= 0.6:
            fine_file = uvw_file
        elif coarse_file is None and uvw_file.baud_length > 0.6:
            coarse_file = uvw_file
        if fine_file and coarse_file:
            break

    return fine_file, coarse_file


def build_kochi_profile_payload(station_name: str, time_of_day: str) -> dict[str, Any]:
    fine_file, coarse_file = find_matching_pair(station_name, time_of_day)

    if not fine_file or not coarse_file:
        return {
            "available": False,
            "message": (
                f"Need both a 0.3us and 1.2us resolution file for "
                f"{station_name} ({time_of_day}) to merge a profile."
            ),
            "have_fine": fine_file is not None,
            "have_coarse": coarse_file is not None,
        }

    fine_data = _readings_as_arrays(fine_file)
    coarse_data = _readings_as_arrays(coarse_file)
    merged = merge_two_resolutions(fine_data, coarse_data)
    derived = compute_wind_speed_direction_shear(merged)

    return {
        "available": True,
        "station_name": station_name,
        "time_of_day": time_of_day,
        "fine_file": fine_file.file.name,
        "coarse_file": coarse_file.file.name,
        "uploaded_at": fine_file.uploaded_at.isoformat(),
        "height_km": merged["height_km"],
        "u": merged["u"],
        "v": merged["v"],
        "w": merged["w"],
        "wind_speed": derived["wind_speed"],
        "wind_dir": derived["wind_dir"],
        "wind_shear": derived["wind_shear"],
    }
