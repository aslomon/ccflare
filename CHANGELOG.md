# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Server entry point (`apps/server/src/server.ts`) now respects the `PORT`
  environment variable and passes it to `startServer()` instead of always
  starting on the hardcoded default port (8080). Setting `PORT=8081` (or any
  valid port) now works as expected; invalid or unset values fall back to the
  default behavior.
- Request metadata and usage facts now complete durably before worker
  acknowledgements, while payload persistence failures remain non-blocking.
- Unknown or unavailable model prices remain explicitly unpriced instead of
  being recorded as a confirmed zero cost.

### Added

- Optional zstd raw-payload segments with bounded decompression, checksums,
  seven-day expiry metadata, and 512 MiB/384 MiB high- and low-water limits.
- Runtime payload-store and usage-worker degradation details in health output.
- Seven-day Overview defaults with explicit missing buckets and partial-pricing
  disclosure.
