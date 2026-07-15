# Wind Profiler Dashboard

Django dashboard for Indian Meteorological Radar Wind Profiler station data,
UVW profiles, wind-barb charts, product comparisons, station administration,
radar uploads, and GeoJSON/shapefile map layers.

The project is built as a Django backend with a server-rendered HTML shell and
a JavaScript-heavy dashboard frontend. Django serves the APIs, stores uploaded
data, validates admin sessions, parses wind-profiler files, and converts
shapefiles. The browser code renders the dashboard, charts, map, admin panel,
and upload workflows.

## Quick Start

Python 3.12 or newer is required.

```bash
python -m venv .venv
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Open the dashboard at:

```text
http://127.0.0.1:8000/
```

Open the custom admin panel at:

```text
http://127.0.0.1:8000/admin/
```

Development defaults are intentionally local-only. To override them, copy
`.env.example` to `.env`.

The custom admin login accepts either:

- `DJANGO_ADMIN_USERNAME` and `DJANGO_ADMIN_PASSWORD` from `.env`
- Any active Django superuser created with `python manage.py createsuperuser`

Validate a change with:

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
```

## What This Application Does

The dashboard shows Radar Wind Profiler station data on a GIS map and in
profile visualizations. It supports:

- Station availability and station metadata display.
- Uploading UVW radar files through the custom admin panel.
- Parsing uploaded wind profiler files into database records.
- Viewing Derived UVW, UVW components, wind speed, wind direction, wind shear,
  and wind barb products.
- Comparing products by date or by station.
- Uploading permanent admin shapefile map layers.
- Uploading temporary user shapefiles that appear on the map without being
  saved to the database.
- Editing stations, products, map layer styles, and layer visibility.
- Running locally with SQLite or in production with a `DATABASE_URL`.

## Project Layout

```text
dashboard/                 Main Django app
dashboard/models.py        Database models for stations, uploads, readings, map layers
dashboard/views.py         API endpoints and page views
dashboard/urls.py          App URL routes
dashboard/data_utils.py    JSON config loading, station helpers, UVW payload builders
dashboard/parser.py        UVW and metadata file parsers
dashboard/kochi_processing.py
                            Kochi fine/coarse profile merge and derived calculations
dashboard/services/utils.py
                            Shapefile validation and conversion to GeoJSON
dashboard/serializers.py   API serializers for map layers
dashboard/tests.py         Django tests

data/                      Versioned JSON configuration
data/stations.json         Station list and station attributes
data/products.json         Product list and product type mapping
data/settings.json         Map and dashboard settings

docs/                      Additional project documentation
media/                     Runtime generated media, especially GeoJSON files
static/                    Frontend assets
static/js/script.js        Main public dashboard JavaScript
static/js/admin.js         Custom admin panel JavaScript
static/css/style.css       Main dashboard and admin styling
static/css/map-layers.css  Extra map-layer admin styling

templates/index.html       Shared dashboard/admin HTML shell
uploads/                   Runtime radar file uploads
windprofiler/              Django project settings and entry points
manage.py                  Django management command entry point
requirements.txt           Python dependencies
Dockerfile                 Production container build
```

## Backend Overview

### `windprofiler/settings.py`

This file configures Django.

Important settings:

- Loads optional `.env` values using `load_env_file`.
- Uses SQLite locally by default.
- Supports PostgreSQL or another database through `DATABASE_URL`.
- Enables `django.contrib.auth`, sessions, static files, and the `dashboard`
  app.
- Uses WhiteNoise for static files in production.
- Defines `STATIC_ROOT`, `MEDIA_ROOT`, and `UPLOAD_ROOT`.
- Defines custom admin fallback credentials:
  `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
- In production, requires `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`, and
  `DJANGO_ADMIN_PASSWORD`.

### `windprofiler/urls.py`

This is the project-level URL file. It includes the dashboard app routes and,
when `DEBUG=True`, serves local `media/` and `uploads/` files for development.

### `dashboard/models.py`

This file defines database tables.

`Station`

- Stores station name, latitude, longitude, status, and extra JSON attributes.
- Used for database-backed station records.

`UploadedUVWFile`

- Stores uploaded profiler files.
- Tracks station name, station relation, file type, upload time, baud length,
  and time of day.
- Uses a custom storage path so UVW uploads are organized under station folders.

`WindReading`

- Stores parsed wind readings for an uploaded file.
- Each row contains height, U, V, and W wind components.
- Ordered by height.

`MapLayer`

- Stores permanent shapefile/GeoJSON map layers.
- Tracks geometry type, GeoJSON file path, style colors, line width, marker
  style, visibility, and timestamps.
- Deletes its generated GeoJSON file when the database layer is deleted.

### `dashboard/views.py`

This is the main backend controller file. It contains the page routes, API
routes, upload handlers, admin auth, and response-building logic.

Page routes:

- `dashboard_page` renders the main dashboard.
- `admin_page` renders the same template but starts in admin mode.
- `health_check` returns `{"status": "ok"}` for liveness checks.

Auth helpers:

- `is_admin_logged_in` checks the session flag.
- `require_admin` protects mutation and upload endpoints.
- `api_admin_login` accepts either configured admin credentials or an active
  Django superuser.
- `api_admin_logout` clears the session.
- `api_admin_status` tells the frontend whether the admin is logged in.

Station and product APIs:

- `api_stations` lists or creates stations.
- `api_station_detail` updates or deletes one station.
- `api_products` lists, creates, or reorders products.
- `api_delete_product` renames or deletes products.

Wind profiler APIs:

- `upload_uvw` accepts radar uploads from the admin panel, parses the file, and
  stores file metadata plus readings.
- `api_station_uvw` returns the UVW profile payload for one station.
- `api_station_wind_barb` returns wind barb profile data for one station.
- `api_kochi_profile` returns the special Kochi merged profile payload.

Map layer APIs:

- `api_map_layers` lists map layers or creates a new permanent layer from a
  shapefile upload.
- `api_user_shapefile` converts a user-uploaded shapefile into in-memory
  GeoJSON and returns it without saving a database row.
- `api_map_layer_detail` reads, updates, or deletes a layer.
- `api_map_layer_style` updates style values.
- `api_map_layer_visibility` toggles or sets visibility.
- `api_map_layer_geojson` returns the generated GeoJSON for a saved layer.

### `dashboard/data_utils.py`

This file handles JSON-backed configuration and profile-building helpers.

Main responsibilities:

- Loads and saves `data/stations.json`, `data/products.json`, and
  `data/settings.json`.
- Merges configured stations with external folder-based stations.
- Cleans station payloads before saving.
- Infers station file folders.
- Parses several UVW file formats into common profile dictionaries.
- Builds UVW payloads for frontend charts.
- Builds wind barb payloads.
- Selects morning/evening cycles and date-filtered cycles.
- Provides `admin_password_matches`, which compares configured admin passwords
  safely.

The JSON writers use an in-process lock. That is enough for local/single-host
deployment, but not enough for multi-host horizontal scaling.

### `dashboard/parser.py`

This file parses uploaded profiler files.

It contains helpers for:

- Extracting timestamps from file names.
- Reading uploaded files safely as text.
- Parsing metadata blocks.
- Normalizing numeric values.
- Parsing Kolkata-style UVW cycles.
- Parsing Kochi-style CSV text.
- Returning station metadata and wind readings in a consistent shape.

`parse_uvw_file` is the main parser entry point used during upload.

### `dashboard/kochi_processing.py`

This file handles a special Kochi workflow.

It:

- Finds matching fine-resolution and coarse-resolution profiles.
- Merges the two resolutions into one profile.
- Computes wind speed, wind direction, and shear from U/V/W readings.
- Returns a frontend-ready profile payload.

### `dashboard/services/utils.py`

This file handles shapefile uploads and conversion.

It:

- Validates ZIP files and individual shapefile components.
- Prevents unsafe ZIP paths.
- Requires matching `.shp`, `.shx`, `.dbf`, and usually `.prj` files for ZIP
  uploads.
- Extracts shapefiles to a temporary folder.
- Reads shapefiles with GeoPandas when available.
- Falls back to PyShp for environments without a working GDAL/pyogrio stack.
- Converts geometries to EPSG:4326 GeoJSON when CRS information is available.
- Writes permanent GeoJSON files under `media/geojson/`.
- Returns temporary in-memory GeoJSON for user shapefile uploads.

### `dashboard/serializers.py`

This file converts `MapLayer` model objects into JSON dictionaries for the API.
It includes the generated GeoJSON URL and API URL used by the frontend.

### `dashboard/tests.py`

This file contains regression tests for:

- Admin session login/logout behavior.
- Django superuser login into the custom admin panel.
- Protected mutation endpoints.
- Health checks.
- Product type preservation during rename/reorder.
- Temporary user shapefile upload behavior.
- Kolkata UVW file discovery and corrupt-value rejection.

## Frontend Overview

The frontend is mostly plain JavaScript, Leaflet, Chart.js, and Plotly.

### `templates/index.html`

This template is the shared HTML shell for both the public dashboard and the
custom admin panel.

It contains:

- Header stats and theme toggle.
- Station, product, time, comparison, and shapefile controls.
- Attribute/product panels.
- The Leaflet map container.
- The custom admin login panel.
- Station/product/map-layer admin forms.
- Script and stylesheet includes.

Django renders the same page for `/` and `/admin/`; the JavaScript decides
which view is initially visible from `body[data-initial-view]`.

### `static/js/script.js`

This is the main dashboard script. It owns the public user experience.

Important parts:

- `appState` keeps all frontend state: stations, products, selected station,
  map object, markers, map layers, charts, active view, and comparison state.
- API helpers fetch data from Django endpoints.
- Theme helpers store and apply light/dark mode.
- Product helpers manage selected products and visible product panels.
- Chart helpers render UVW, wind speed, wind direction, wind shear, wind barb,
  and comparison views.
- Map helpers create Leaflet basemaps, station markers, popups, map controls,
  shapefile layer controls, and GeoJSON layers.
- Shapefile helpers upload temporary user shapefiles, add them to the map, and
  remove them when needed.
- Admin-view helpers switch between dashboard and admin UI.
- Sync helpers listen for `postMessage` and `localStorage` events so admin
  changes update the dashboard without a full reload.
- `startDashboard` is the startup function. It loads summary, stations,
  products, settings, and visible map layers, then initializes the map and UI.

The map layer flow is:

1. The browser loads visible layers from `/api/map-layers?visible=true`.
2. Each layer references `/api/map-layers/<id>/geojson`.
3. `renderMapLayers` fetches the GeoJSON.
4. Leaflet renders it with the layer style.
5. The Layers control lets the user show/hide each shapefile.
6. Uploaded temporary shapefiles are added to `appState.temporaryMapLayers` and
   rendered immediately without database persistence.

### `static/js/admin.js`

This is the custom admin panel script.

Important parts:

- `adminApi` wraps authenticated JSON requests with CSRF protection.
- `adminUpload` uploads files with progress support.
- Login/logout functions call the admin auth API.
- Station functions render, create, edit, and delete station data.
- Product functions create, rename, delete, and reorder products.
- Map layer functions upload shapefiles, render the layer list, edit styles,
  toggle visibility, and delete layers.
- Notification helpers tell the dashboard when stations or map layers changed.

The admin panel is not Django's built-in admin site. It is a custom UI served at
`/admin/` and protected by session auth through the APIs in `dashboard/views.py`.

### CSS Files

`static/css/style.css`

- Main layout, theme variables, dashboard shell, panels, tables, chart cards,
  map layout, admin layout, and responsive behavior.

`static/css/map-layers.css`

- Additional styling for map-layer upload/list/editor controls.

## API Summary

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Public dashboard page |
| `/admin/` | GET | Custom admin page |
| `/healthz` | GET | Liveness check |
| `/api/settings` | GET | Dashboard settings |
| `/api/summary` | GET | Station summary counts |
| `/api/stations` | GET, POST | List or create stations |
| `/api/stations/<station_id>` | GET, PUT/PATCH, DELETE | Read/update/delete station |
| `/api/stations/<station_id>/uvw` | GET | UVW profile payload |
| `/api/stations/<station_id>/wind-barb` | GET | Wind barb payload |
| `/api/products` | GET, POST, PATCH | List/create/reorder products |
| `/api/products/<product_name>` | PUT/PATCH, DELETE | Rename/delete product |
| `/upload/` | POST | Upload radar profiler files |
| `/api/map-layers` | GET, POST | List or upload permanent map layers |
| `/api/map-layers/<id>` | GET, PUT/PATCH, DELETE | Read/update/delete map layer |
| `/api/map-layers/<id>/style` | POST, PUT, PATCH | Update layer style |
| `/api/map-layers/<id>/visibility` | POST, PUT, PATCH | Toggle/set visibility |
| `/api/map-layers/<id>/geojson` | GET | Return saved layer GeoJSON |
| `/api/user-shapefile` | POST | Upload temporary shapefile for current browser session |
| `/api/admin/status` | GET | Current admin session status |
| `/api/admin/login` | POST | Login to custom admin |
| `/api/admin/logout` | POST | Logout from custom admin |
| `/api/kochi/profile` | GET | Kochi merged profile |

## Data Flow

### Dashboard startup

1. Browser loads `templates/index.html`.
2. `static/js/script.js` calls `startDashboard`.
3. The frontend fetches summary, stations, products, settings, and visible map
   layers.
4. Leaflet map is initialized.
5. Station markers and visible map layers are rendered.
6. Product panels wait for the user to select a station/product.

### Radar upload flow

1. Admin logs in through `/api/admin/login`.
2. Admin uploads files through the admin upload form.
3. `upload_uvw` receives the files.
4. `dashboard/parser.py` parses metadata and readings.
5. `UploadedUVWFile` and `WindReading` rows are saved.
6. Dashboard APIs can now serve chart payloads from uploaded data.

### Product chart flow

1. User selects a station.
2. User enables a product and clicks Submit.
3. Frontend calls the relevant station API.
4. Backend returns normalized profile data.
5. Chart.js, Plotly, or canvas drawing code renders the profile.

### Permanent shapefile flow

1. Admin logs in.
2. Admin uploads a ZIP or matching shapefile components.
3. `dashboard/services/utils.py` validates and converts the shapefile.
4. A GeoJSON file is written under `media/geojson/`.
5. A `MapLayer` row is saved.
6. The dashboard refreshes map layers and renders the new GeoJSON on Leaflet.

### Temporary user shapefile flow

1. User uploads a shapefile from the dashboard sidebar.
2. `/api/user-shapefile` converts it to GeoJSON in memory.
3. No `MapLayer` row is created.
4. The frontend adds it to `appState.temporaryMapLayers`.
5. The layer is visible immediately and removed when the user removes it or the
   page session ends.

## Runtime Data

The repository contains only placeholders for `media/` and `uploads/`.
Databases, uploaded profiler files, generated GeoJSON, collected static assets,
environment files, caches, and local backups are ignored by Git.

Important runtime locations:

- `db.sqlite3`: local SQLite database.
- `uploads/`: uploaded UVW/radar files.
- `media/geojson/`: generated GeoJSON from permanent shapefile uploads.
- `staticfiles/`: collected production static files.
- `.env`: local environment variables.

The JSON files under `data/` are editable application configuration. Concurrent
writes to those files assume a single application host; move them into the
database before horizontally scaling the web process across hosts.

## Authentication and Security

- Mutation endpoints call `require_admin`.
- Admin login is session based.
- Login rotates the session key to reduce session fixation risk.
- Logout flushes the session.
- CSRF middleware is enabled.
- Frontend admin requests send the CSRF token.
- Production requires explicit secrets and allowed hosts.
- Uploaded shapefile ZIP paths are checked to avoid unsafe extraction.
- Shapefile size is limited to 50 MB.

## Environment Variables

See `.env.example` for the complete local template.

Common variables:

```text
DJANGO_DEBUG=True
DJANGO_SECRET_KEY=...
DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost
DJANGO_CSRF_TRUSTED_ORIGINS=
DJANGO_ADMIN_USERNAME=admin
DJANGO_ADMIN_PASSWORD=change-this-to-a-strong-password
DATABASE_URL=
```

When `DJANGO_DEBUG=False`, these are mandatory:

- `DJANGO_SECRET_KEY`
- `DJANGO_ALLOWED_HOSTS`
- `DJANGO_ADMIN_PASSWORD`

## Production

The included `Dockerfile` runs migrations and Gunicorn, and WhiteNoise serves
versioned static assets. Build and run it with a PostgreSQL `DATABASE_URL` and
the required settings from `.env.example`:

```bash
docker build -t windprofiler .
docker run --env-file .env -p 8000:8000 windprofiler
```

Persist `/app/media` and `/app/uploads` with volumes or object storage. The
application serves these paths itself only in debug mode; in production, serve
them through the reverse proxy or storage service.

Before release, run the production security check with deployment environment
variables loaded:

```bash
python manage.py check --deploy
```

## Testing

Run all tests:

```bash
python manage.py test
```

Run only admin session tests:

```bash
python manage.py test dashboard.tests.AdminSessionTests
```

Run Django system checks:

```bash
python manage.py check
```

Check for missing migrations:

```bash
python manage.py makemigrations --check --dry-run
```

## Common Development Tasks

Create a Django superuser:

```bash
python manage.py createsuperuser
```

Start the development server:

```bash
python manage.py runserver
```

Open the custom admin panel:

```text
http://127.0.0.1:8000/admin/
```

Upload a permanent shapefile:

1. Login to `/admin/`.
2. Use the Map Layers form.
3. Upload one ZIP containing matching `.shp`, `.shx`, `.dbf`, and `.prj`
   files, or select all components together.
4. Keep "Visible on map" checked if it should appear immediately.

Upload a temporary user shapefile:

1. Open the dashboard sidebar.
2. Use "User Shapefile".
3. Upload a ZIP or matching shapefile components.
4. The layer appears on the map for the current browser session only.

## Extra Documentation

See `docs/PROJECT_DOCUMENTATION.md` for a shorter architecture and data-flow
summary.
