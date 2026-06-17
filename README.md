# Pexip Resource & Capacity Calculator

A static, browser-based sizing tool for planning [Pexip Infinity](https://www.pexip.com/) video conferencing deployments. It models the nodes, vCPU, and bandwidth a deployment will need before any infrastructure is provisioned.

Runs entirely in the browser with no build step. Hosted on GitHub Pages.

---

## Purpose

Architects and customers use this tool to answer:

- How many transcoding nodes do I need for my call mix?
- What vCPU count is required given my CPU model and hypervisor?
- How much bandwidth will peak concurrent calls consume?
- Do I need proxy/edge nodes, and how many?

Inputs cover call quality mix, endpoint types (WebRTC, SIP/H.323, Microsoft Teams, Google Meet, interop gateways), a Deployment Topology Builder where each location holds named nodes with explicit roles (Transcoding Internal, Proxy DMZ/Edge, External Public-facing), and hardware characteristics. The output is a node recommendation table per location, vCPU count, and bandwidth estimate.

---

## Principles Derived from Pexip

The calculation model is grounded in Pexip's published capacity planning methodology:

- **HD equivalence** — All streams are normalised to a 720p HD unit. A 1080p stream costs 2.0 HD; SD costs 0.5 HD; audio costs 0.0625 HD. This lets heterogeneous call mixes be reduced to a single scalar for node sizing.
- **VP9 resource trade-off** — VP9 reduces bandwidth by ~33% compared to H.264 at the same resolution, but increases node CPU load by 25% (`VP9_RESOURCE_FACTOR = 1.25`). The calculator applies this factor to resource cost while keeping bandwidth figures from the lookup table.
- **Backplane overhead** — In clustered deployments each active meeting requires internal node-to-node signalling capacity (1 HD unit per meeting per site). Single-node deployments incur no backplane cost.
- **NUMA alignment** — Pexip performance is sensitive to NUMA topology. A node VM should not span NUMA nodes. The calculator warns when `nodeVcpuSize > cpuCoresPerSocket` and blocks configurations where `nodeVcpuSize > cpuCoresPerSocket × 2`, which Pexip explicitly does not support.
- **No CPU overcommit** — Pexip is CPU-intensive real-time media software. The calculator warns when running on non-cloud hypervisors to maintain a 1:1 vCPU-to-physical-core ratio.
- **25% headroom** — All resource totals are multiplied by 1.25 before converting to node counts. This provides capacity for bursts and rolling upgrades.
- **CPU efficiency calibration** — Base HD-per-vCPU figures are calibrated from Pexip NUMA documentation (Xeon Gold 6342, AVX-512, 2.8 GHz ≈ 195 HD across 2 nodes × 16 vCPU each). Clock speed and instruction-set tier scale linearly from that reference point.

---

## Mathematical Logic

The calculation runs as a sequential 9-step pipeline. Each step feeds into the next.

### Step 1 — Base HD per row

```
hdBase = count × qualityWeight × codecFactor
```

| Quality | Weight | H.264 codecFactor | VP9 codecFactor |
|---------|--------|-------------------|-----------------|
| 1080p   | 2.0    | 1.0               | 1.25            |
| 720p    | 1.0    | 1.0               | 1.25            |
| SD      | 0.5    | 1.0               | 1.25            |
| Audio   | 0.0625 | 1.0               | 1.25            |

### Step 2 — Presentation stream additions

If presentation sharing is enabled, extra HD is added per endpoint type for each participant row:

| Endpoint type  | Extra HD per participant |
|----------------|--------------------------|
| WebRTC         | +1.0 HD                  |
| Microsoft Teams | +0.5 HD                 |
| Google Meet    | +1.0 HD                  |
| Interop/Gateway | +1.0 HD                 |

### Step 3 — Gateway overhead

Applied to `hdBase` (not presentation) when gateway interop is active:

| Gateway mode | Multiplier |
|--------------|------------|
| None         | ×1.0       |
| Light        | ×1.5       |
| Heavy        | ×1.75      |

`hdRow = hdBase × gatewayFactor + hdPresentation`

### Step 4 — Proxy doubling

Applied automatically when one or more **Proxy (DMZ/Edge)** or **External (Public-facing)** nodes are defined in the Deployment Topology Builder. Every stream is handled twice — once at the edge node and once at the transcoding node behind it:

```
viaProxy = (proxyNodeCount + externalNodeCount) > 0
totalHDBeforeBackplane = sum(hdRow) × (viaProxy ? 2.0 : 1.0)
```

### Step 5 — Backplane overhead

Derived from the nodes defined in the Deployment Topology Builder, not a manual topology selection:

```
backplaneHD = meetings × numberOfTranscodingLocations × BACKPLANE_HD_PER_MEETING
```

| Condition | backplaneHD |
|-----------|-------------|
| 0 or 1 Transcoding node defined | 0 (no backplane) |
| 2+ Transcoding nodes in 1 location | meetings × 1 × 1.0 |
| Transcoding nodes across N locations | meetings × N × 1.0 |

### Step 6 — Headroom

```
totalHDWithHeadroom = (totalHDBeforeBackplane + backplaneHD) × 1.25
```

### Step 7 — CPU efficiency

```
effectiveHDperVcpu = baseISA × (clockGHz / 2.8) × htFactor × hvFactor
```

| Instruction set | Base HD/vCPU |
|-----------------|-------------|
| Legacy (SSE4)   | 2.5         |
| AVX-2           | 4.0         |
| AVX-512         | 6.0         |

| Hypervisor    | Factor |
|---------------|--------|
| VMware ESXi   | 1.0    |
| KVM           | 0.95   |
| Hyper-V       | 0.90   |
| Cloud (bare)  | 1.0    |

Hyperthreading with NUMA-pinned VMs: ×1.4 bonus.

### Step 8 — vCPU and node count

```
vCPURequired       = ceil(totalHDWithHeadroom / effectiveHDperVcpu)
transcodingNodes   = ceil(vCPURequired / nodeVcpuSize)
```

Proxy node count equals the number of **Proxy (DMZ/Edge)** and **External (Public-facing)** nodes defined explicitly in the Deployment Topology Builder. Node recommendations show one Transcoding row per location when multiple transcoding locations are defined, distributing the required vCPU count evenly.

### Step 9 — Bandwidth

```
totalBandwidthKbps = sum(count × bandwidthPerStream)
```

Lookup table (video only; add up to 64 kbps per stream for audio):

| Resolution | H.264 | VP9   |
|------------|-------|-------|
| 1080p      | 2,400 kbps | 1,600 kbps |
| 720p       | 960 kbps   | 640 kbps   |
| SD         | 448 kbps   | 448 kbps   |
| Audio      | 64 kbps    | 64 kbps    |

Inter-node bandwidth (clustered topologies):
```
interNodeBandwidthKbps = meetings × transcodingNodes × 960
```

---

## File Structure and Dependencies

```
index.html       ← Vue template and page structure
js/
  config.js      ← All constants (window.PEXIP global)
  app.js         ← Vue app, all computed logic
css/
  styles.css     ← Brand styles
```

**Load order matters.** `index.html` loads scripts in this sequence:

1. Vue 3 from unpkg CDN
2. `js/config.js` — populates `window.PEXIP`
3. `js/app.js` — reads `window.PEXIP` via the alias `const C = window.PEXIP`

`app.js` will throw if `config.js` has not been loaded first.

There is no build step, bundler, or package manager. All dependencies are resolved at runtime.

---

## How to Safely Modify the Calculator

### Changing a constant (e.g. headroom, bandwidth figures, HD weights)

Edit [js/config.js](js/config.js) only. All numeric constants live there. Do not hardcode values inside [js/app.js](js/app.js).

Example: to change the headroom factor from 25% to 30%:
```js
// js/config.js
HEADROOM_FACTOR: 1.30,  // was 1.25
```

### Adding a new endpoint type

1. Add an entry to `ENDPOINT_TYPES` in [js/config.js](js/config.js) following the existing shape:
   ```js
   my_endpoint: {
     label:             'My Endpoint',
     connectionFactor:  1.0,
     presentationExtra: false,
     gatewayLegs:       1,
   }
   ```
2. Add a corresponding checkbox in the endpoint types section of [index.html](index.html).
3. If the endpoint adds presentation streams, add a branch in the Step 2 block inside `rowResults` in [js/app.js](js/app.js) (the `hdPresentation` section) mirroring the WebRTC/Teams pattern.

### Adding a new quality tier or codec

1. Add the weight to `QUALITY_WEIGHTS` in [js/config.js](js/config.js).
2. Add bandwidth entries to `BANDWIDTH_TABLE` for each codec variant.
3. Add a label to `QUALITY_LABELS`.
4. The `rowResults` computed property in [js/app.js](js/app.js) will pick up the new tier automatically via the lookup.

### Adding a new CPU instruction set

Add an entry to `CPU_EFFICIENCY_TABLE` in [js/config.js](js/config.js) and expose it in the `EFFICIENCY_BASE` object near the bottom of `setup()` in [js/app.js](js/app.js) so the template can display it.

### Adding a new node role to the Topology Builder

1. Add an entry to `NODE_ROLES` in [js/config.js](js/config.js):
   ```js
   my_role: 'My Role (Description)',
   ```
2. Add an `<option>` to the role `<select>` inside `.node-row` in [index.html](index.html).
3. In [js/app.js](js/app.js), add a `totalDefinedMyRoleNodes` computed alongside the existing `totalDefinedProxyNodes` / `totalDefinedExternalNodes` computeds.
4. Decide whether the new role should trigger proxy-doubling (×2.0). If yes, include it in the `viaProxy` computed. If it counts toward recommendations, push a row in `nodeRecommendations`.
5. Add a badge color class (`.badge-my-role`) to [css/styles.css](css/styles.css) and add the class binding to the `node-type-badge` span in the Node Recommendations table in [index.html](index.html).

### Modifying the calculation pipeline

The 9-step pipeline runs inside the `setup()` function in [js/app.js](js/app.js) as a chain of Vue `computed()` properties. Each step reads from the previous one. If you insert a new step:

- Place it between the existing steps it logically belongs between.
- Update all downstream `computed()` references to use the new intermediate value.
- Verify the chain is not broken by checking the final outputs (`vCPURequired`, `transcodingNodeCount`, `totalBandwidthKbps`) against a known hand-calculated example before deploying.

### What not to do

- **Do not introduce a build step.** GitHub Pages serves static files. Adding webpack, Vite, or any bundler requires a CI pipeline and changes the deployment model.
- **Do not add `<script type="module">`.** The plain `<script>` + `window.PEXIP` pattern is intentional. ES modules would break the global-variable handoff between `config.js` and `app.js` without a bundler.
- **Do not inline constants in `app.js`.** Keeping all numbers in `config.js` makes auditing and updating values safe without touching computation logic.
- **Do not split `setup()` across files.** Vue's reactivity depends on all `reactive()`, `ref()`, and `computed()` calls being in the same scope.
