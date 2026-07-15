# Wind Profiler Dashboard

Django dashboard for Indian Meteorological Radar Wind Profiler station data,
UVW profiles, wind-barb charts, product comparisons, and GeoJSON map layers.

## Local development

Python 3.12 or newer is required.

```bash
python -m venv .venv
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Development defaults are intentionally local-only. To override them, copy
`.env.example` to `.env`. The dashboard is available at
`http://127.0.0.1:8000/` and its custom administration page at `/admin/`.
The custom admin login accepts either `DJANGO_ADMIN_USERNAME` /
`DJANGO_ADMIN_PASSWORD` or any active Django superuser created with
`python manage.py createsuperuser`.

Validate a change with:

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test
```

## Production

The included `Dockerfile` runs migrations and Gunicorn, and WhiteNoise serves
versioned static assets. Build and run it with a PostgreSQL `DATABASE_URL` and
the required settings from `.env.example`:

```bash
docker build -t windprofiler .
docker run --env-file .env -p 8000:8000 windprofiler
```

`DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`, and `DJANGO_ADMIN_PASSWORD` are
mandatory when `DJANGO_DEBUG=False`. Use a long random admin password. Set
`DJANGO_CSRF_TRUSTED_ORIGINS` to the public HTTPS origin.

Persist `/app/media` and `/app/uploads` with volumes or object storage. The
application serves these paths itself only in debug mode; in production, serve
them through the reverse proxy or storage service. The liveness endpoint is
`/healthz`.

Before release, run the production security check with deployment environment
variables loaded:

```bash
python manage.py check --deploy
```

## Runtime data

The repository contains only placeholders for `media/` and `uploads/`.
Databases, uploaded profiler files, generated GeoJSON, collected static assets,
environment files, caches, and local backups are ignored by Git.

The JSON files under `data/` are editable application configuration. Concurrent
writes to those files assume a single application host; move them into the
database before horizontally scaling the web process across hosts.

See `docs/PROJECT_DOCUMENTATION.md` for the architecture and data flow.
