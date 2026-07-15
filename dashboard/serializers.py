from django.conf import settings


def serialize_map_layer(layer, request=None):
    geojson_url = ""
    if layer.geojson_file:
        geojson_url = f"{settings.MEDIA_URL}{layer.geojson_file.name}"
        if request is not None:
            geojson_url = request.build_absolute_uri(geojson_url)

    return {
        "id": layer.id,
        "layer_name": layer.layer_name,
        "geometry_type": layer.geometry_type,
        "geojson_file": layer.geojson_file.name if layer.geojson_file else "",
        "geojson_url": geojson_url,
        "geojson_api_url": f"/api/map-layers/{layer.id}/geojson",
        "fill_color": layer.fill_color,
        "border_color": layer.border_color,
        "fill_opacity": layer.fill_opacity,
        "line_width": layer.line_width,
        "marker_color": layer.marker_color,
        "marker_icon": layer.marker_icon,
        "is_visible": layer.is_visible,
        "uploaded_at": layer.uploaded_at.isoformat() if layer.uploaded_at else None,
        "updated_at": layer.updated_at.isoformat() if layer.updated_at else None,
    }
