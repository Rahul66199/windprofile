from django.conf import settings
from django.core.files.storage import FileSystemStorage
from django.db import models


class UVWUploadStorage(FileSystemStorage):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("location", settings.UPLOAD_ROOT.parent)
        kwargs.setdefault("base_url", "/")
        super().__init__(*args, **kwargs)


uvw_upload_storage = UVWUploadStorage()


def uvw_upload_path(instance, filename):
    station_name = (instance.station_name or "").strip().lower()

    if "kolkata" in station_name or "haringhata" in station_name:
        station_folder = "kolkata"
    elif "kochi" in station_name or "cusat" in station_name:
        station_folder = "kochi"
    else:
        station_folder = "unknown"

    return f"uploads/{station_folder}/{filename}"


class Station(models.Model):
    station_id = models.CharField(max_length=20, unique=True)
    station_name = models.CharField(max_length=100)
    latitude = models.FloatField()
    longitude = models.FloatField()
    status = models.CharField(max_length=20, default="Active")

    def __str__(self):
        return self.station_name


class UploadedUVWFile(models.Model):
    station = models.ForeignKey(Station, on_delete=models.CASCADE, null=True, blank=True)
    station_name = models.CharField(max_length=100, blank=True)
    time_of_day = models.CharField(
        max_length=10,
        choices=[("morning", "Morning"), ("evening", "Evening")],
        blank=True,
    )  # ← new field
    file = models.FileField(storage=uvw_upload_storage, upload_to=uvw_upload_path)
    latitude = models.FloatField()
    longitude = models.FloatField()
    elevation = models.FloatField(null=True, blank=True)
    baud_length = models.FloatField(null=True, blank=True)
    resolution = models.FloatField(null=True, blank=True)
    rain = models.BooleanField(default=False)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        if self.station:
            return f"{self.station.station_name} - {self.uploaded_at}"
        return self.file.name

class WindReading(models.Model):
    uvw_file = models.ForeignKey(
        UploadedUVWFile,
        on_delete=models.CASCADE,
        related_name="wind_readings"
    )
    height_km = models.FloatField()        # Height in km
    u = models.FloatField()                # Zonal (m/s)
    v = models.FloatField()                # Meridional (m/s)
    w = models.FloatField()                # Vertical (m/s)

    class Meta:
        ordering = ["height_km"]

    def __str__(self):
        return f"{self.uvw_file} | {self.height_km} km"


class MapLayer(models.Model):
    GEOMETRY_POINT = "Point"
    GEOMETRY_MULTIPOINT = "MultiPoint"
    GEOMETRY_LINESTRING = "LineString"
    GEOMETRY_MULTILINESTRING = "MultiLineString"
    GEOMETRY_POLYGON = "Polygon"
    GEOMETRY_MULTIPOLYGON = "MultiPolygon"
    GEOMETRY_MIXED = "Mixed"

    GEOMETRY_CHOICES = [
        (GEOMETRY_POINT, "Point"),
        (GEOMETRY_MULTIPOINT, "MultiPoint"),
        (GEOMETRY_LINESTRING, "LineString"),
        (GEOMETRY_MULTILINESTRING, "MultiLineString"),
        (GEOMETRY_POLYGON, "Polygon"),
        (GEOMETRY_MULTIPOLYGON, "MultiPolygon"),
        (GEOMETRY_MIXED, "Mixed"),
    ]

    layer_name = models.CharField(max_length=160)
    geometry_type = models.CharField(
        max_length=40,
        choices=GEOMETRY_CHOICES,
        default=GEOMETRY_MIXED,
    )
    geojson_file = models.FileField(upload_to="geojson/")
    fill_color = models.CharField(max_length=20, default="#2f80ed")
    border_color = models.CharField(max_length=20, default="#0f3d66")
    fill_opacity = models.FloatField(default=0.35)
    line_width = models.FloatField(default=2)
    marker_color = models.CharField(max_length=20, default="#e11d48")
    marker_icon = models.CharField(max_length=80, blank=True, default="")
    is_visible = models.BooleanField(default=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["layer_name"]

    def __str__(self):
        return self.layer_name

    def delete(self, *args, **kwargs):
        storage = self.geojson_file.storage if self.geojson_file else None
        file_name = self.geojson_file.name if self.geojson_file else ""
        super().delete(*args, **kwargs)
        if storage and file_name and storage.exists(file_name):
            storage.delete(file_name)
    
