import json
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from django.conf import settings
from django.utils.text import slugify


REQUIRED_SHAPEFILE_EXTENSIONS = {".shp", ".shx", ".dbf", ".prj"}
SUPPORTED_GEOMETRIES = {
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
}
MAX_SHAPEFILE_ZIP_SIZE = 50 * 1024 * 1024


class ShapeFileUploadError(ValueError):
    pass


def _safe_member_path(base_dir, member_name):
    target = (base_dir / member_name).resolve()
    if base_dir.resolve() not in target.parents and target != base_dir.resolve():
        raise ShapeFileUploadError("ZIP file contains an unsafe file path.")
    return target


def _validate_zip_file(uploaded_file):
    filename = str(getattr(uploaded_file, "name", ""))
    if not filename.lower().endswith(".zip"):
        raise ShapeFileUploadError("Upload a ZIP file containing .shp, .shx, .dbf, and .prj files.")

    file_size = int(getattr(uploaded_file, "size", 0) or 0)
    if file_size <= 0:
        raise ShapeFileUploadError("The uploaded ZIP file is empty.")
    if file_size > MAX_SHAPEFILE_ZIP_SIZE:
        raise ShapeFileUploadError("ZIP file is too large. Maximum allowed size is 50 MB.")


def _read_zip(uploaded_file):
    try:
        uploaded_file.seek(0)
    except Exception:
        pass

    try:
        archive = zipfile.ZipFile(uploaded_file)
    except zipfile.BadZipFile as exc:
        raise ShapeFileUploadError("The uploaded file is not a valid ZIP archive.") from exc

    bad_member = archive.testzip()
    if bad_member:
        archive.close()
        raise ShapeFileUploadError(f"ZIP file is corrupted near {bad_member}.")
    return archive


def _find_primary_shapefile(members):
    shape_groups = {}
    shapefile_members = {}
    allowed_extra_extensions = {
        ".cpg",
        ".qix",
        ".sbn",
        ".sbx",
        ".xml",
        ".fix",
    }

    for member in members:
        path = Path(member)
        suffix = path.suffix.lower()
        if not suffix:
            continue
        if suffix not in REQUIRED_SHAPEFILE_EXTENSIONS and suffix not in allowed_extra_extensions:
            raise ShapeFileUploadError(
                "ZIP contains unsupported files. Only shapefile components are allowed."
            )

        key = str(path.with_suffix("")).lower()
        shape_groups.setdefault(key, set()).add(suffix)
        if suffix == ".shp":
            shapefile_members[key] = member

    complete_groups = [
        key for key, extensions in shape_groups.items()
        if REQUIRED_SHAPEFILE_EXTENSIONS.issubset(extensions)
    ]
    if not complete_groups:
        raise ShapeFileUploadError("ZIP must include matching .shp, .shx, .dbf, and .prj files.")
    if len(complete_groups) > 1:
        raise ShapeFileUploadError("Upload one shapefile layer per ZIP file.")

    return shapefile_members[complete_groups[0]]


def _extract_zip_safely(archive, temp_dir):
    members = []
    for info in archive.infolist():
        if info.is_dir():
            continue
        member_name = info.filename.replace("\\", "/")
        if member_name.startswith("__MACOSX/") or Path(member_name).name.startswith("."):
            continue
        _safe_member_path(temp_dir, member_name)
        members.append(member_name)

    if not members:
        raise ShapeFileUploadError("ZIP file does not contain shapefile components.")

    primary_shapefile = _find_primary_shapefile(members)

    for member in members:
        target = _safe_member_path(temp_dir, member)
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(member) as source, target.open("wb") as destination:
            shutil.copyfileobj(source, destination)

    shapefile_path = temp_dir / primary_shapefile
    if not shapefile_path.exists():
        matches = list(temp_dir.rglob(Path(primary_shapefile).name))
        if matches:
            return matches[0]
    return shapefile_path


def _load_geopandas():
    try:
        import geopandas as gpd
    except ImportError as exc:
        raise ShapeFileUploadError(
            "GeoPandas is required for shapefile uploads. Install the geospatial requirements first."
        ) from exc
    return gpd


def _detect_geometry_type(geo_dataframe):
    geometries = set(geo_dataframe.geometry.geom_type.dropna().unique())
    unsupported = geometries - SUPPORTED_GEOMETRIES
    if unsupported:
        names = ", ".join(sorted(unsupported))
        raise ShapeFileUploadError(f"Unsupported geometry type: {names}.")
    if not geometries:
        raise ShapeFileUploadError("Shapefile does not contain valid geometry.")
    if len(geometries) == 1:
        return next(iter(geometries))
    return "Mixed"


def _geojson_output_path(layer_name):
    safe_name = slugify(layer_name) or "map-layer"
    file_name = f"{safe_name}-{uuid.uuid4().hex}.geojson"
    geojson_dir = Path(settings.MEDIA_ROOT) / "geojson"
    geojson_dir.mkdir(parents=True, exist_ok=True)
    return geojson_dir / file_name


def _read_shapefile_with_pyshp(shapefile_path):
    """Fallback: Read shapefile using pure Python pyshp library (no GDAL needed)."""
    try:
        import shapefile
    except ImportError as exc:
        raise ShapeFileUploadError(
            "PyShp is required as a fallback. Install it with: pip install pyshp"
        ) from exc

    try:
        # Try with the .shp file path - shapefile library handles companion files
        sf = shapefile.Reader(str(shapefile_path.with_suffix('')))
        features = []
        
        for shape_record in sf.shapeRecords():
            shape = shape_record.shape
            record = shape_record.record
            
            # Convert shape to GeoJSON
            if shape.shapeType == shapefile.POINT:
                geom = {"type": "Point", "coordinates": [shape.x, shape.y]}
            elif shape.shapeType == shapefile.MULTIPOINT:
                geom = {"type": "MultiPoint", "coordinates": [[p[0], p[1]] for p in shape.points]}
            elif shape.shapeType == shapefile.POLYLINE:
                geom = {"type": "LineString", "coordinates": shape.points}
            elif shape.shapeType == shapefile.POLYGON:
                geom = {"type": "Polygon", "coordinates": [shape.points]}
            else:
                continue
            
            # Build properties from record
            properties = {}
            if sf.fields:
                for i, field_name in enumerate([f[0] for f in sf.fields[1:]]):
                    if i < len(record):
                        properties[field_name] = record[i]
            
            features.append({
                "type": "Feature",
                "properties": properties,
                "geometry": geom
            })
        
        if not features:
            raise ShapeFileUploadError("Shapefile has no valid features.")
        
        return {
            "type": "FeatureCollection",
            "features": features
        }, len(features)
    except Exception as exc:
        if isinstance(exc, ShapeFileUploadError):
            raise
        raise ShapeFileUploadError(f"Failed to read shapefile: {str(exc)}") from exc


def convert_shapefile_zip_to_geojson(uploaded_file, layer_name, persist=True):
    """Convert shapefile (ZIP or direct) to GeoJSON. Supports both file types with multiple backends."""
    
    # Handle both single file and list of files
    if isinstance(uploaded_file, (list, tuple)):
        uploaded_files = uploaded_file
        is_zip = False
        is_shp = False
        is_multi = True
    else:
        uploaded_files = [uploaded_file]
        filename = str(getattr(uploaded_file, "name", "")).lower()
        is_zip = filename.endswith(".zip")
        is_shp = filename.endswith(".shp")
        is_multi = False
    
    if not (is_zip or is_shp or is_multi):
        raise ShapeFileUploadError("Upload a .zip file (with all shapefile components) or individual shapefile files (.shp, .shx, .dbf, .prj).")
    
    temp_dir = Path(tempfile.mkdtemp(prefix="map-layer-"))

    try:
        # Handle multiple files (individual shapefile components)
        if is_multi:
            file_extensions = set()
            for uploaded_file in uploaded_files:
                file_size = int(getattr(uploaded_file, "size", 0) or 0)
                if file_size <= 0:
                    continue
                if file_size > MAX_SHAPEFILE_ZIP_SIZE:
                    raise ShapeFileUploadError("File is too large. Maximum allowed size is 50 MB.")
                
                filename = str(getattr(uploaded_file, "name", "")).lower()
                file_extensions.add(Path(filename).suffix)
                
                try:
                    uploaded_file.seek(0)
                except Exception:
                    pass
                
                file_path = temp_dir / Path(uploaded_file.name).name
                with open(file_path, "wb") as destination:
                    if hasattr(uploaded_file, 'file'):
                        source = uploaded_file.file
                        source.seek(0)
                        shutil.copyfileobj(source, destination)
                    elif hasattr(uploaded_file, 'read'):
                        uploaded_file.seek(0)
                        shutil.copyfileobj(uploaded_file, destination)
                    else:
                        destination.write(uploaded_file.read())
            
            # Validate that required files are present
            required = {".shp", ".shx", ".dbf"}
            missing = required - file_extensions
            if missing:
                missing_str = ", ".join(sorted(missing))
                raise ShapeFileUploadError(f"Missing required shapefile components: {missing_str}. Please upload .shp, .shx, .dbf, and optionally .prj files together.")
            
            # Find the .shp file
            shp_files = list(temp_dir.glob("*.shp"))
            if not shp_files:
                raise ShapeFileUploadError("No .shp file found in uploaded files.")
            shapefile_path = shp_files[0]
        
        # Handle ZIP file
        elif is_zip:
            _validate_zip_file(uploaded_file)
            with _read_zip(uploaded_file) as archive:
                shapefile_path = _extract_zip_safely(archive, temp_dir)
            if not shapefile_path.exists():
                raise ShapeFileUploadError("The .shp file could not be found after extraction.")
        
        # Handle direct .shp file
        else:
            file_size = int(getattr(uploaded_file, "size", 0) or 0)
            if file_size <= 0:
                raise ShapeFileUploadError("The uploaded .shp file is empty.")
            if file_size > MAX_SHAPEFILE_ZIP_SIZE:
                raise ShapeFileUploadError("File is too large. Maximum allowed size is 50 MB.")
            
            raise ShapeFileUploadError("Uploading a single .shp file is not supported. Please upload a ZIP file containing all shapefile components (.shp, .shx, .dbf, .prj) or select all component files together using Ctrl+Click.")

        # Verify companion files exist
        shp_base = shapefile_path.with_suffix('')
        missing_companions = []
        for ext in ['.shx', '.dbf']:
            if not (shp_base.parent / f"{shp_base.name}{ext}").exists():
                missing_companions.append(ext)
        
        if missing_companions:
            raise ShapeFileUploadError(f"Missing companion files: {', '.join(missing_companions)}. All shapefile components (.shp, .shx, .dbf, .prj) must be uploaded together.")

        # Try GeoPandas first (preferred method)
        geojson_payload = None
        geometry_type = None
        feature_count = 0
        
        try:
            gpd = _load_geopandas()
            geo_dataframe = gpd.read_file(shapefile_path)
            if geo_dataframe.empty:
                raise ShapeFileUploadError("Shapefile has no features.")
            if "geometry" not in geo_dataframe:
                raise ShapeFileUploadError("Shapefile has no geometry column.")

            geo_dataframe = geo_dataframe[~geo_dataframe.geometry.is_empty & geo_dataframe.geometry.notna()]
            if geo_dataframe.empty:
                raise ShapeFileUploadError("Shapefile has no valid geometries.")

            geometry_type = _detect_geometry_type(geo_dataframe)
            if geo_dataframe.crs:
                geo_dataframe = geo_dataframe.to_crs(epsg=4326)

            geojson_payload = json.loads(geo_dataframe.to_json(drop_id=True))
            feature_count = len(geo_dataframe)
        except Exception as e:
            # Fallback to PyShp if GeoPandas fails
            if "pyogrio" in str(e).lower() or "gdal" in str(e).lower():
                geojson_payload, feature_count = _read_shapefile_with_pyshp(shapefile_path)
                geometries = set()
                for feature in geojson_payload.get("features", []):
                    geom_type = feature.get("geometry", {}).get("type")
                    if geom_type:
                        geometries.add(geom_type)
                geometry_type = geometries.pop() if len(geometries) == 1 else "Mixed"
            else:
                raise

        if not geojson_payload or not geojson_payload.get("features"):
            raise ShapeFileUploadError("Shapefile has no valid features to process.")

        if not persist:
            return {
                "geometry_type": geometry_type or "Mixed",
                "geojson": geojson_payload,
                "feature_count": feature_count,
            }

        output_path = _geojson_output_path(layer_name)
        with output_path.open("w", encoding="utf-8") as output_file:
            json.dump(geojson_payload, output_file, ensure_ascii=False)

        relative_path = output_path.relative_to(settings.MEDIA_ROOT).as_posix()
        return {
            "geometry_type": geometry_type or "Mixed",
            "geojson_file": relative_path,
            "feature_count": feature_count,
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def convert_shapefile_upload_to_geojson(uploaded_file, layer_name):
    """Convert a user-uploaded shapefile to an in-memory GeoJSON payload."""
    return convert_shapefile_zip_to_geojson(uploaded_file, layer_name, persist=False)
