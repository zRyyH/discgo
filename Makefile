# Dev entry points. On Windows run from Git Bash with GNU make
# (`mingw32-make` from WinLibs works, or `winget install ezwinports.make`).

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

GST_ROOT ?= $(GSTREAMER_1_0_ROOT_MSVC_X86_64)
export PKG_CONFIG := $(GST_ROOT)/bin/pkg-config.exe
export PKG_CONFIG_PATH := $(GST_ROOT)/lib/pkgconfig
DATABASE_URL ?= postgres://discgo:discgo@localhost:5432/discgo?sslmode=disable
COMPOSE_DEV := docker compose -f deploy/docker-compose.dev.yml
ENGINE_SIDECAR := desktop/src-tauri/binaries/discgo-engine-x86_64-pc-windows-msvc.exe

.PHONY: infra-up infra-down api engine engine-release gst-runtime desktop build lint test

infra-up:
	$(COMPOSE_DEV) up -d --wait

infra-down:
	$(COMPOSE_DEV) down

api:
	cd api && DATABASE_URL='$(DATABASE_URL)' go run ./cmd/api

engine:
	cargo build -p discgo-engine

engine-release:
	cargo build --release -p discgo-engine
	cp target/release/discgo-engine.exe $(ENGINE_SIDECAR)

gst-runtime: engine-release
	powershell -NoProfile -ExecutionPolicy Bypass -File engine/gst-runtime/collect.ps1

desktop:
	cd desktop && pnpm install && pnpm tauri dev

build: gst-runtime
	cd api && go build -trimpath -o bin/api.exe ./cmd/api
	cd desktop && pnpm install && pnpm tauri build

lint:
	cd api && gofmt -l . | (! grep .) && go vet ./...
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cd desktop && pnpm lint

test:
	cd api && go test ./...
	cargo test --workspace
