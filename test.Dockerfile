FROM alpine
WORKDIR /app
COPY packages/ ./packages/
RUN find /app
