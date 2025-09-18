# AudioShelf Librarian Docker Image
# Lightweight production-ready container for running AudioShelf Librarian

FROM python:3.11-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Create app user for security
RUN useradd --create-home --shell /bin/bash app

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create necessary directories and set permissions
RUN mkdir -p /app/data /app/logs && \
    chown -R app:app /app

# Switch to non-root user
USER app

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/api/operations', timeout=5)"

# Expose port
EXPOSE 8000

# Default command - run web server
CMD ["python", "audioshelf-librarian.py", "web", "--host", "0.0.0.0", "--port", "8000"]

# Labels for metadata
LABEL org.opencontainers.image.title="AudioShelf Librarian" \
      org.opencontainers.image.description="Intelligent audiobook library organizer for AudioBookShelf" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.authors="AudioShelf Librarian Contributors" \
      org.opencontainers.image.source="https://github.com/yourusername/AudioShelf-Librarian" \
      org.opencontainers.image.documentation="https://github.com/yourusername/AudioShelf-Librarian/blob/main/README.md"
