from django.urls import path

from . import views

urlpatterns = [
    path("", views.dashboard_page, name="dashboard"),
    path("admin/", views.admin_page, name="admin_panel"),
    path("healthz", views.health_check, name="health_check"),
    path("api/settings", views.api_settings),
    path("api/summary", views.api_summary),
    path("api/map-layers", views.api_map_layers),
    path("api/map-layers/<int:layer_id>", views.api_map_layer_detail),
    path("api/map-layers/<int:layer_id>/style", views.api_map_layer_style),
    path("api/map-layers/<int:layer_id>/visibility", views.api_map_layer_visibility),
    path("api/map-layers/<int:layer_id>/geojson", views.api_map_layer_geojson),
    path("api/user-shapefile", views.api_user_shapefile),
    path("api/stations", views.api_stations),
    path("api/stations/<str:station_id>", views.api_station_detail),
    path("api/stations/<str:station_id>/uvw", views.api_station_uvw),
    path("api/stations/<str:station_id>/wind-barb", views.api_station_wind_barb),
    path("api/products", views.api_products),
    path("api/products/<path:product_name>", views.api_delete_product),
    path("api/admin/status", views.api_admin_status),
    path("api/admin/login", views.api_admin_login),
    path("api/admin/logout", views.api_admin_logout),
    path("upload/", views.upload_uvw, name="upload_uvw"),
    path("api/kochi/profile", views.api_kochi_profile),
]
