FROM python:3.13-alpine

WORKDIR /app
COPY server.py index.html style.css app.js ./

# Bookings live in a volume so they survive rebuilds and restarts.
ENV HOST=0.0.0.0 \
    PORT=8000 \
    RUDENESS_DATA=/data/rudeness.json \
    PYTHONUNBUFFERED=1
RUN mkdir /data && chown nobody:nobody /data
VOLUME /data
USER nobody

EXPOSE 8000
CMD ["python3", "server.py"]
