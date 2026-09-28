# realityjs

A real-time Lake Tahoe shoreline in three.js: clear alpine water over granite boulders, snow-capped
mountains across the lake, and Jeffrey pines on a rocky point.

- **Water:** a GPU shallow-water simulation for the nearshore (runup, backwash, wet/dry), a JONSWAP FFT
  ocean for the open lake, Beer-Lambert absorption, and photon-traced caustics (after
  [caustic-volume](https://github.com/ScottieFox/caustic-volume), MIT).
- **Terrain:** a baked height field of jointed granite boulders with a photographic granite texture.
- **Sky:** single-scattering atmosphere, a photographic mountain panorama graded into the sky's own haze.

No build step: it is static HTML plus ES modules, with three.js loaded from jsDelivr.

## Run locally

```sh
python3 serve.py   # http://localhost:5197 (no-cache dev server)
```

URL params: `?t=` warm-up seconds, `?freeze`, `?yaw=`, `?pitch=`, `?fov=`, `?sunel=`, `?sunaz=`, `?fps`.
Drag to look around, scroll to crouch or stand.

## Deploy

Import the repo in Vercel. It is a static site (`vercel.json` skips install and build).

Textures in `tex/` were generated with gpt-image-2; see `tex/raw/PROVENANCE.md`.
