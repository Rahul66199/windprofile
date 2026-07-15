# Generated for the Shape File Management Module.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("dashboard", "0005_alter_uploadeduvwfile_file"),
    ]

    operations = [
        migrations.CreateModel(
            name="MapLayer",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("layer_name", models.CharField(max_length=160)),
                (
                    "geometry_type",
                    models.CharField(
                        choices=[
                            ("Point", "Point"),
                            ("MultiPoint", "MultiPoint"),
                            ("LineString", "LineString"),
                            ("MultiLineString", "MultiLineString"),
                            ("Polygon", "Polygon"),
                            ("MultiPolygon", "MultiPolygon"),
                            ("Mixed", "Mixed"),
                        ],
                        default="Mixed",
                        max_length=40,
                    ),
                ),
                ("geojson_file", models.FileField(upload_to="geojson/")),
                ("fill_color", models.CharField(default="#2f80ed", max_length=20)),
                ("border_color", models.CharField(default="#0f3d66", max_length=20)),
                ("fill_opacity", models.FloatField(default=0.35)),
                ("line_width", models.FloatField(default=2)),
                ("marker_color", models.CharField(default="#e11d48", max_length=20)),
                ("marker_icon", models.CharField(blank=True, default="", max_length=80)),
                ("is_visible", models.BooleanField(default=True)),
                ("uploaded_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["layer_name"],
            },
        ),
    ]
