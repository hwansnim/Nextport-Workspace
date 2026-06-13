# 넥스트포트 공구 워크스페이스 - Production Dockerfile
FROM python:3.11-slim

# 시스템 의존성
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production requirements 만
COPY requirements-prod.txt .
RUN pip install --no-cache-dir -r requirements-prod.txt

# 앱 코드
COPY app.py .
COPY modules/ modules/
COPY templates/ templates/
COPY static/ static/
COPY scripts/ scripts/
COPY data/ data/

# 환경
ENV ENV_MODE=cloud
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

# logs
RUN mkdir -p /app/logs

EXPOSE 8080

# gunicorn 으로 실행
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "300", "app:app"]
