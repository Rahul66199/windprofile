# Project architecture

The application has a server-rendered Django shell and a JavaScript dashboard.
`dashboard/views.py` exposes station, product, map-layer, upload, profile, and
session APIs. `static/js/script.js` renders the public dashboard, while
`static/js/admin.js` implements the custom administration view.

## Data flow

- Station and product configuration is read from `data/*.json`.
- Uploaded profiler files are stored under `uploads/<station>/` and parsed by
  `dashboard/parser.py`.
- Parsed upload metadata and wind readings are stored through the models in
  `dashboard/models.py`.
- Shapefile uploads are validated and converted by
  `dashboard/services/utils.py`; generated GeoJSON is stored under
  `media/geojson/`.
- Profile endpoints prefer original upload files, then database readings, then
  configured external station folders.
- `dashboard/kochi_processing.py` merges fine and coarse Kochi profiles and
  calculates speed, direction, and shear.

## Source layout

```text
dashboard/       Django application, parsers, services, models, and tests
data/            Versioned station/product/display configuration
docs/            Architecture documentation
media/           Generated runtime media (placeholder only in Git)
static/          JavaScript, CSS, and image source assets
templates/       Django HTML templates
uploads/         Runtime profiler uploads (placeholder only in Git)
windprofiler/    Project settings and WSGI/ASGI entry points
```

## Operational notes

Production configuration comes from environment variables documented in
`.env.example`. PostgreSQL is selected through `DATABASE_URL`; SQLite is the
local-development fallback. WhiteNoise serves collected static files. Uploaded
media must be persisted and served separately when debug mode is disabled.

The custom administration session protects all mutation and upload endpoints.
Credentials come from `DJANGO_ADMIN_USERNAME` and `DJANGO_ADMIN_PASSWORD`, not
from versioned JSON. CSRF middleware protects browser mutations.

The JSON configuration writers use an in-process lock. This is sufficient for a
single application host but is not a cross-process or distributed transaction;
store mutable configuration in the database before horizontal scaling.
