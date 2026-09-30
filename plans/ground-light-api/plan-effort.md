# Effort — ground-light-api

| Phase | Model | Effort | Why |
|---|---|---|---|
| 1 — expose `dropLightWithItem` and `pickupGroundLight` | Opus 5.5 | high | The shape gives every value, but splitting `dropLight` / `pickupLight` into a shared core has a seam: `createLightEffect` replacing an actor's existing light, and the sweep reading ground lights the shape cannot show |
