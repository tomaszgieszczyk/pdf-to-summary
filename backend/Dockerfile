FROM golang:1.27.4-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /pdf-to-summary .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 service && install -d -o service /data
COPY --from=build /pdf-to-summary /usr/local/bin/
USER service
ENV STORAGE_DIR=/data LISTEN_ADDR=:8000
EXPOSE 8000
ENTRYPOINT ["pdf-to-summary"]
