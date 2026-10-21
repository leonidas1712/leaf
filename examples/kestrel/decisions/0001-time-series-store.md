# 0001: Use a time-series store for readings

**Status:** accepted · **Date:** 2026-09-30

## Context

Version 1 appended readings to one CSV file per station per day. The map reloaded every file each morning,
which took eleven minutes and could not show anything newer than midnight.

## Decision

Store readings in a time-series database with one series per station and sensor. Keep the raw messages in
object storage for thirty days so readings can be replayed after a validation bug.

## Consequences

- The map can query the last hour in under a second.
- Retention becomes a configuration setting instead of a cleanup script.
- The ops agent must monitor disk use on the store; it grows by about 2 GB per month.
