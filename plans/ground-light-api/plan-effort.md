# Effort — ground-light-api

| Phase | Model | Effort | Why |
|---|---|---|---|
| 1 — tie the light to its item, expose `dropLightWithItem` and `pickupGroundLight` | Opus 5.5 | high | The shape gives every value, but reordering the HUD drop around the socket relay, and the `deleteItem` hook firing on every client, are seams it cannot show |
