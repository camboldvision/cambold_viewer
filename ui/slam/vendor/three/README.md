# Three.js r170

Vendored from the official `mrdoob/three.js` r170 tag:

- `build/three.module.js`
- `examples/jsm/controls/OrbitControls.js`
- `LICENSE` (MIT, unmodified)

Upstream: https://github.com/mrdoob/three.js/tree/r170

SHA-256:

```text
ce1fa418de16a19495a9f72495580e3015d7745c296d3ce0485897f902ddedfb  three.module.js (unmodified)
80efaadea4f8a636a65fb0bd08bfef62f3d93a0bb94e2e7500f23176c5c07f4e  OrbitControls.js (upstream)
6f3052dd8860a60fe6999260d50558ff54609523724c6e374326228e5590cf55  OrbitControls.js (local)
```

The only local change in OrbitControls is the import specifier: `three` becomes
`./three.module.js`. All resources are local ES modules, so no import-map support,
CDN, npm install, or frontend build step is required.
