# Runbook: station silent on the map

Use this when a station shows "no data" for more than ten minutes.

## Check the station

1. Open the station page and note the last reading time.
2. Check the dead-letter queue for that station ID.
3. If readings are rejected for clock drift, trigger a time sync:

```sh
kestrel station sync-clock 041
```

## Check the broker

```sh
kestrel broker clients --station 041
```

> [!CAUTION]
> Do not restart the broker during the top-of-hour peak. Stations reconnect all at once and the map stalls.

## Escalate

Page the field team if the station has been silent for more than an hour and the broker shows no client.
Back to the [rollout plan](PLAN.md#risks).
