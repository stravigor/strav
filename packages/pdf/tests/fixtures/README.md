# Test fixtures

Small, open-license binary assets used by tests (fonts, images, ICC profiles).

Milestones 1–3 (object model, content streams, stream filters) require **no
binary fixtures** — all inputs are generated programmatically. This directory
exists so the later font/image/ICC milestones (M4+) have an established home
for committed fixtures.

Policy when fixtures are added:

- Keep each file small (a few KB where possible; subset fonts).
- Only redistributable licenses (SIL OFL fonts, CC0/public-domain images,
  ICC profiles whose license permits redistribution).
- Record the source and license of every file in this README.
