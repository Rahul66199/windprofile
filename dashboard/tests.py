import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase

from .data_utils import (
    DEFAULT_ADMIN_PASSWORD,
    DEFAULT_ADMIN_USERNAME,
    load_products,
    load_settings,
    list_uvw_files,
)
from .models import MapLayer
from .parser import parse_kolkata_uvw_cycles


class AdminSessionTests(TestCase):
    def setUp(self):
        settings = load_settings()
        self.username = settings.get("admin_username", DEFAULT_ADMIN_USERNAME)
        self.password = settings.get("admin_password", DEFAULT_ADMIN_PASSWORD)

    def login(self):
        return self.client.post(
            "/api/admin/login",
            data=json.dumps({
                "username": self.username,
                "password": self.password,
            }),
            content_type="application/json",
        )

    def test_login_session_survives_page_navigation(self):
        response = self.login()
        self.assertEqual(response.status_code, 200)

        self.client.get("/")
        self.client.get("/admin/")

        status = self.client.get("/api/admin/status")
        self.assertEqual(status.status_code, 200)
        self.assertTrue(status.json()["logged_in"])
        self.assertEqual(status.json()["username"], self.username)

    def test_logout_is_the_action_that_ends_the_session(self):
        self.login()

        response = self.client.post("/api/admin/logout")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.client.get("/api/admin/status").json()["logged_in"])

    def test_admin_upload_requires_login(self):
        response = self.client.post("/upload/")
        self.assertEqual(response.status_code, 401)

    def test_django_superuser_can_login_to_custom_admin_panel(self):
        get_user_model().objects.create_superuser(
            username="siteadmin",
            email="siteadmin@example.com",
            password="SuperSecret123!",
        )

        response = self.client.post(
            "/api/admin/login",
            data=json.dumps({
                "username": "siteadmin",
                "password": "SuperSecret123!",
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["logged_in"])
        self.assertEqual(response.json()["username"], "siteadmin")

    def test_admin_mutation_requires_login_after_logout(self):
        self.login()
        self.client.post("/api/admin/logout")

        response = self.client.post(
            "/api/products",
            data=json.dumps({"product_name": "Restricted product"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 401)


class HealthCheckTests(SimpleTestCase):
    def test_health_check(self):
        response = self.client.get("/healthz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


class DashboardProductTests(TestCase):
    def test_uvw_component_product_is_available(self):
        products = load_products()
        self.assertIn("UVW", products)
        self.assertIn("Derived UVW", products)
        self.assertNotIn("U/V/W Data", products)

    def test_product_rename_preserves_product_type(self):
        session = self.client.session
        session["admin_logged_in"] = True
        session.save()

        with (
            patch("dashboard.views.load_products", return_value=["Derived UVW"]),
            patch("dashboard.views.load_product_types", return_value={"Derived UVW": "derived_uvw"}),
            patch("dashboard.views.save_products") as save_products,
        ):
            response = self.client.patch(
                "/api/products/Derived%20UVW",
                data=json.dumps({"product_name": "Derived Wind Profiles"}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200)
        save_products.assert_called_once_with(
            ["Derived Wind Profiles"],
            {"Derived Wind Profiles": "derived_uvw"},
        )

    def test_product_reorder_preserves_product_types(self):
        session = self.client.session
        session["admin_logged_in"] = True
        session.save()

        product_types = {
            "Derived UVW": "derived_uvw",
            "UVW": "uvw",
            "Wind Barb": "wind_barb",
        }
        reordered = ["Wind Barb", "UVW", "Derived UVW"]
        with (
            patch(
                "dashboard.views.load_products",
                return_value=["Derived UVW", "UVW", "Wind Barb"],
            ),
            patch("dashboard.views.load_product_types", return_value=product_types),
            patch("dashboard.views.save_products") as save_products,
        ):
            response = self.client.patch(
                "/api/products",
                data=json.dumps({"products": reordered}),
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["products"], reordered)
        save_products.assert_called_once_with(reordered, product_types)


class UserShapefileUploadTests(TestCase):
    @patch("dashboard.views.convert_shapefile_upload_to_geojson")
    def test_user_shapefile_upload_returns_temporary_layer_without_database_save(
        self,
        convert_shapefile,
    ):
        convert_shapefile.return_value = {
            "geometry_type": "Polygon",
            "geojson": {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "Sample"},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[
                                [76.0, 10.0],
                                [77.0, 10.0],
                                [77.0, 11.0],
                                [76.0, 10.0],
                            ]],
                        },
                    }
                ],
            },
            "feature_count": 1,
        }

        response = self.client.post(
            "/api/user-shapefile",
            data={
                "shapefile_zip": SimpleUploadedFile(
                    "temporary-layer.zip",
                    b"placeholder",
                    content_type="application/zip",
                ),
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(MapLayer.objects.count(), 0)
        layer = response.json()["layer"]
        self.assertTrue(layer["is_temporary"])
        self.assertEqual(layer["layer_name"], "temporary-layer")
        self.assertEqual(layer["feature_count"], 1)
        self.assertIn("geojson", layer)
        self.assertNotIn("geojson_file", layer)


class KolkataUvwTests(SimpleTestCase):
    def test_discovers_all_numbered_kolkata_uvw_files(self):
        with TemporaryDirectory() as folder_name:
            folder = Path(folder_name)
            for name in ("cycle.uvw", "cycle.uvw1", "cycle.uvw2", "cycle.UVW7"):
                (folder / name).touch()
            (folder / "cycle.txt").touch()
            (folder / "cycle.uvw.bak").touch()

            discovered = {path.name for path in list_uvw_files(folder)}

        self.assertEqual(
            discovered,
            {"cycle.uvw", "cycle.uvw1", "cycle.uvw2", "cycle.UVW7"},
        )

    def test_rejects_corrupt_kolkata_component_values(self):
        text = """Project Name : AMP-WPR-DPSv1.0
Date : 27 January 2026
Time : 15:46:14
Ht(m) Ht(ft) U(ms) U(kt) V(ms) V(kt) W(ms) W(kt)
1650 3207 +01.00 +01.94 +02.00 +03.89 +00.25 +00.49
1800 3499 +00.00 +00.00 -1992202149261647986344646974726209536.00 -2147483648 +00.00 +00.00
"""

        _, cycles = parse_kolkata_uvw_cycles(text, "27JA2026_15_SHT1.uvw7")

        self.assertEqual(len(cycles), 1)
        self.assertEqual(cycles[0]["levels"], [
            {"height_km": 1.65, "u": 1.0, "v": 2.0, "w": 0.25}
        ])

    @patch("dashboard.views.load_station_uvw_payload")
    @patch("dashboard.views._load_uploaded_uvw_payload")
    @patch("dashboard.views._load_uploaded_folder_uvw_payload")
    @patch("dashboard.views.find_station_index", return_value=0)
    @patch(
        "dashboard.views.load_stations",
        return_value=[{"station_id": "KOL01", "station_name": "Kolkata"}],
    )
    def test_kolkata_uvw_prefers_raw_cycle_profiles(
        self,
        _load_stations,
        _find_station_index,
        load_folder_payload,
        load_database_payload,
        load_external_payload,
    ):
        load_folder_payload.return_value = {
            "available": True,
            "timestamp": "2026-01-27T15:45:52",
            "levels": [{"height_km": 1.65, "u": 1, "v": 2, "w": 3}],
        }

        response = self.client.get(
            "/api/stations/KOL01/uvw?date=2026-01-27&hour=15&minute=45"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["timestamp"], "2026-01-27T15:45:52")
        load_folder_payload.assert_called_once_with(
            {"station_id": "KOL01", "station_name": "Kolkata"},
            date_value="2026-01-27",
            hour_value="15",
            minute_value="45",
        )
        load_database_payload.assert_not_called()
        load_external_payload.assert_not_called()
