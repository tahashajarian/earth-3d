# Find it on Earth

A geography game on a 3D globe, plus a live "Explore" mode.

- **Play:** 10 rounds — a city is named, spin the globe, drop a pin, confirm.
  Points for distance and speed, streak multiplier, Hard mode worth ×1.5.
  Each result shows the city's real local time and whether it's day or night.
- **Explore:** real-time day/night terminator with city lights; tap anywhere
  for local time, nearest city and coordinates.

Plain HTML/CSS/JS with three.js (vendored in `lib/`), no build step.

## Run locally

Any static server works, e.g.:

```sh
python -m http.server 5181
```

Then open http://localhost:5181. (Opening `index.html` directly from disk
won't work because ES modules need http.)

## Deploy

Upload the whole folder (including the hidden `.htaccess`) to the server.
When you change CSS/JS, bump the `?v=` number in `index.html` so browsers
fetch the new files.

## Image credits

- Day map: NASA Blue Marble (public domain, via Wikimedia Commons), with
  ocean colour from the three-globe example textures.
- City lights: NASA Earth Observatory, "Earth at night" (public domain,
  via Wikimedia Commons).
- Clouds and first-load day map: three.js example textures (MIT).
