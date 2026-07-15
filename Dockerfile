FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y gdal-bin libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN DJANGO_DEBUG=False \
    DJANGO_SECRET_KEY=build-only-not-used-at-runtime \
    DJANGO_ALLOWED_HOSTS=localhost \
    DJANGO_ADMIN_PASSWORD=build-only-not-used-at-runtime \
    python manage.py collectstatic --noinput

RUN useradd --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app/media/geojson /app/uploads/kochi /app/uploads/kolkata /app/uploads/unknown \
    && chown -R app:app /app

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/healthz', timeout=3)"

CMD ["sh", "-c", "python manage.py migrate --noinput && gunicorn windprofiler.wsgi:application --bind 0.0.0.0:${PORT} --workers ${WEB_CONCURRENCY:-3} --timeout 120 --access-logfile - --error-logfile -"]
