# Pexip Resource & Capacity Calculator

A static, browser-based sizing tool for planning [Pexip Infinity](https://www.pexip.com/) video conferencing deployments. It models the nodes, vCPU, and bandwidth a deployment will need before any infrastructure is provisioned.

Runs entirely in the browser with no build step. Hosted on GitHub Pages at [catherinecq-pexip.github.io/VMCalculator](https://catherinecq-pexip.github.io/VMCalculator/).

---

## Purpose

Architects and customers use this tool to answer:

- How many transcoding nodes do I need for my endpoint mix?
- What vCPU count is required given my CPU model and hypervisor?
- How much bandwidth will peak concurrent calls consume — including WAN traffic from external participants?
- Do I need proxy/edge nodes, and how many?
- What is the Teams Adaptive Composition overhead for my conference layout?

Inputs cover endpoint composition (type, count, quality, codec, presentation, internal vs external split), a Deployment Topology Builder where each location holds named nodes with explicit roles (Transcoding Internal, Proxy DMZ/Edge, External Public-facing), and hardware characteristics. The output is a per-location node recommendation table, vCPU count, and full bandwidth estimate.

---

## Principles Derived from Pexip

The calculation model is grounded in Pexip's published capacity planning methodology:

- **HD equivalence** — All streams are normalised to a 720p HD unit. A 1080p stream costs 2.0 HD; SD costs 0.5 HD; audio costs 0.0625 HD. This lets heterogeneous endpoint mixes be reduced to a single scalar for node sizing.
- **Per-platform connection factors** — Each endpoint type carries a different resource multiplier: SIP/H.323 = 1.0×, WebRTC VP8 = 1.0×, WebRTC VP9 = 1.25×, Microsoft Teams = 1.5×, Google Meet = 1.0×, Skype for Business = 1.0×. These encode codec normalisation, layout adaptation, and gateway leg overhead automatically — no manual interop override needed.
- **VP9 resource trade-off** — VP9 reduces bandwidth by ~33% compared to H.264 at the same resolution, but increases node CPU load by 25% (`VP9_RESOURCE_FACTOR = 1.25`).
- **Teams Adaptive Composition** — When Teams endpoints are present, an additional HD reservation is made per conference: +1.0 HD for up to 3 on-stage participants, plus +0.5 HD per additional on-stage participant beyond 3.
- **Backplane overhead** — In clustered deployments each active meeting requires internal node-to-node signalling capacity (1 HD unit per meeting per transcoding location). Single-node deployments incur no backplane cost.
- **Proxy doubling (external traffic only)** — External participants route via proxy/edge nodes. When proxy or external nodes are defined in the topology, their traffic is counted twice: once at the edge node and once at the transcoding node. Internal participants are not doubled.
- **NUMA alignment** — Pexip performance is sensitive to NUMA topology. A node VM should not span NUMA nodes. The calculator warns when `nodeVcpuSize > cpuCoresPerSocket` and refuses configurations where `nodeVcpuSize > cpuCoresPerSocket × 2`.
- **No CPU overcommit** — Pexip is CPU-intensive real-time media software. The calculator warns to maintain a 1:1 vCPU-to-physical-core ratio on non-cloud hypervisors.
- **25% headroom** — All resource totals are multiplied by 1.25 before converting to node counts. This provides capacity for bursts and rolling upgrades.
- **CPU efficiency calibration** — Base HD-per-vCPU figures are calibrated from Pexip NUMA documentation (Xeon Gold 6342, AVX-512, 2.8 GHz ≈ 195 HD across 2 nodes × 16 vCPU each). Clock speed and instruction-set tier scale linearly from that reference point.

---

## Calculation Methodology

The calculator runs a sequential 9-step pipeline. Each step feeds into the next. All formulas can be traced directly to the source constants in [js/config.js](js/config.js) and the computed properties in [js/app.js](js/app.js).

---

### Step 1 — Per-endpoint HD resource calculation

For each endpoint type row the tool computes base HD, external proxy overhead, and presentation overhead separately, then sums them.

**Inputs:** `internalCount`, `externalCount`, `quality`, `codec`, endpoint type definition from `ENDPOINT_TYPES`.

**Formula:**
```
weight       = QUALITY_WEIGHTS[quality]
               { 'sd': 0.5, '720p': 1.0, '1080p': 2.0 }

codecFactor  = 1.25  if codec === 'vp9'  else  1.0
connFactor   = ENDPOINT_TYPES[type].connectionFactor

basePerCall  = weight × connFactor × codecFactor

hdInternal   = internalCount × basePerCall
hdExternal   = externalCount × basePerCall × proxyFactor
               where proxyFactor = 2.0  if proxy/external nodes exist in topology  else  1.0

hdPresentation = (presentationOn && type supports it)
               ? (internalCount + externalCount) × ENDPOINT_TYPES[type].presentationHD
               : 0

hdRow        = hdInternal + hdExternal + hdPresentation
```

**Per-platform connection factors and presentation:**

| Endpoint | `connectionFactor` | Codec | Presentation overhead |
|---|---|---|---|
| SIP / H.323 | 1.0 | H.264 | — (native dual-stream) |
| Zoom | 1.0 | H.264 | — |
| WebRTC | 1.0 (VP8) / 1.25 (VP9) via `codecFactor` | VP8 or VP9 (user-selectable) | +1.0 HD/participant |
| Microsoft Teams | 1.5 | MS / H.264 | +0.5 HD/participant |
| Google Meet | 1.0 | VP8 | +1.0 HD/participant |
| Skype for Business | 1.0 | H.264 | +1.0 HD/participant |

**Example:** 10 internal + 2 external Teams participants, HD quality, proxy nodes present, presentation on:
```
basePerCall  = 1.0 × 1.5 × 1.0 = 1.5 HD
hdInternal   = 10 × 1.5        = 15.0 HD
hdExternal   = 2  × 1.5 × 2.0 = 6.0  HD
hdPres       = 12 × 0.5        = 6.0  HD
hdRow        = 15 + 6 + 6      = 27.0 HD
```

---

### Step 2 — Teams Adaptive Composition overhead

When Microsoft Teams endpoints are active and Adaptive Composition is enabled, an additional HD reservation is made per conference to account for layout rendering and multi-stream handling.

**Inputs:** `numberOfMeetings`, `teamsOnStageCount`.

**Formula (from Pexip docs):**
```
teamsCompositionHD = numberOfMeetings × (TEAMS_COMPOSITION_HD_BASE
                     + max(0, teamsOnStageCount − 3) × TEAMS_COMPOSITION_HD_ONSTAGE)

where:
  TEAMS_COMPOSITION_HD_BASE    = 1.0 HD  (per conference, for 1–3 on-stage participants)
  TEAMS_COMPOSITION_HD_ONSTAGE = 0.5 HD  (each additional on-stage participant beyond 3)
```

**Example:** 3 conferences, 5 on-stage participants:
```
teamsCompositionHD = 3 × (1.0 + (5−3) × 0.5) = 3 × 2.0 = 6.0 HD
```

This value is added to the HD sum before backplane and headroom are applied.

---

### Step 3 — HD sum before backplane

```
totalHDBeforeBackplane = sum(hdRow for all endpoint types) + teamsCompositionHD
```

No global proxy multiplier is applied here — proxy doubling is already embedded per-row in Step 1 (applied only to external participants).

---

### Step 4 — Backplane overhead

Derived from the nodes defined in the Deployment Topology Builder, not a manual topology selection.

**Inputs:** `totalDefinedTranscodingNodes` (count of Transcoding-role nodes across all locations), `numberOfTranscodingLocations`, `numberOfMeetings`.

**Formula:**
```
backplaneHD = 0                                       if totalDefinedTranscodingNodes ≤ 1
backplaneHD = numberOfMeetings × 1 × BACKPLANE_HD_PER_MEETING   if 1 transcoding location
backplaneHD = numberOfMeetings × N × BACKPLANE_HD_PER_MEETING   if N transcoding locations

where BACKPLANE_HD_PER_MEETING = 1.0 HD
```

| Condition | backplaneHD |
|-----------|-------------|
| 0 or 1 Transcoding node defined | 0 (no backplane) |
| 2+ nodes in 1 location | meetings × 1 × 1.0 |
| Nodes across N locations | meetings × N × 1.0 |

**Example:** 5 meetings across 2 transcoding locations:
```
backplaneHD = 5 × 2 × 1.0 = 10.0 HD
```

---

### Step 5 — Total HD with headroom

```
totalHDRaw          = totalHDBeforeBackplane + backplaneHD
totalHDWithHeadroom = totalHDRaw × HEADROOM_FACTOR

where HEADROOM_FACTOR = 1.25
```

The 25% headroom provides capacity for concurrent-use bursts and ensures rolling node upgrades do not drop below capacity.

---

### Step 6 — CPU efficiency model

Translates the total HD requirement into a vCPU count by modelling the specific hardware characteristics of the target server.

**Inputs:** `cpuInstructionSet`, `cpuClockGhz`, `hyperthreading`, `hypervisor`.

**Formula:**
```
effectiveHDperVcpu = CPU_EFFICIENCY_TABLE[cpuInstructionSet]
                     × (cpuClockGhz / CPU_REFERENCE_CLOCK)
                     × (HT_BONUS_FACTOR if hyperthreading else 1.0)
                     × HYPERVISOR_FACTORS[hypervisor]
```

**Lookup tables:**

| Instruction set | Base HD/vCPU |
|-----------------|-------------|
| Legacy (SSE4)   | 2.5         |
| AVX-2           | 4.0         |
| AVX-512         | 6.0         |

`CPU_REFERENCE_CLOCK = 2.8 GHz` (calibrated from Pexip NUMA docs: Xeon Gold 6342, AVX-512, 2.8 GHz).

| Hypervisor   | Factor |
|--------------|--------|
| VMware ESXi  | 1.0    |
| KVM          | 0.95   |
| Hyper-V      | 0.90   |
| Cloud / bare | 1.0    |

`HT_BONUS_FACTOR = 1.4` — only valid when VMs are NUMA-pinned to a single socket.

**Example:** AVX-512, 3.2 GHz, Hyper-V, HT off:
```
effectiveHDperVcpu = 6.0 × (3.2 / 2.8) × 1.0 × 0.90 = 6.17 HD/vCPU
```

---

### Step 7 — vCPU and node count

```
vCPURequired     = ceil(totalHDWithHeadroom / max(effectiveHDperVcpu, 0.01))

transcodingNodes = ceil(vCPURequired / nodeVcpuSize)
```

Supported `nodeVcpuSize` options: 16, 24, 32, 48 vCPU.

**Proxy / External node count** comes directly from the topology: the number of Proxy (DMZ/Edge) nodes plus the number of External (Public-facing) nodes defined in the Deployment Topology Builder. No formula — these are counted from user input.

**Node recommendations when multi-site:**
```
nodesPerLocation = ceil(transcodingNodes / numberOfTranscodingLocations)
```
Each transcoding location gets its own row in the recommendations table.

---

### Step 8 — Bandwidth calculation

Bandwidth is computed per endpoint type using a codec-and-resolution lookup table, with a separate WAN (external) figure derived from the per-row `externalCount`.

**Formula per row:**
```
bwKey        = quality + '-' + codec    (e.g. '720p-h264', '720p-vp9', '720p-vp8')
bwPerStream  = BANDWIDTH_TABLE[bwKey]   (fallback to quality + '-h264' if key not found)
bwLan        = internalCount × bwPerStream   (LAN traffic from internal participants)
bwWan        = externalCount × bwPerStream   (WAN traffic from external participants)
bwKbps       = (internalCount + externalCount) × bwPerStream
```

**Bandwidth lookup table (kbps per stream, video only):**

| Resolution | H.264 | VP8 | VP9 |
|------------|-------|-----|-----|
| 1080p      | 2,400 | 2,400 | 1,600 |
| 720p       | 960   | 960   | 640   |
| SD         | 448   | 448   | 448   |
| Audio      | 64    | 64    | 64    |

VP8 uses H.264-equivalent bandwidth (similar bitrate at same resolution).

**Totals:**
```
totalBandwidthKbps = sum(bwKbps for all rows)   (all participants)
wanBandwidthKbps   = sum(bwWan  for all rows)   (external participants only)
```

**Inter-node backplane bandwidth** (clustered deployments):
```
interNodeBandwidthKbps = numberOfMeetings × transcodingNodeCount × 960 kbps
```
This applies only when more than one transcoding node is defined.

---

### Step 9 — Topology-based routing

The Deployment Topology Builder drives four routing behaviors:

| Routing scenario | Effect on calculation |
|---|---|
| All participants in one location, single node | No backplane, no proxy doubling |
| Multiple nodes in one location | Intra-site backplane: `meetings × 1 × 1.0 HD` |
| Nodes across N locations | Inter-location backplane: `meetings × N × 1.0 HD` |
| External participants + proxy/external nodes defined | Proxy doubling ×2.0 applied to external traffic only in `hdExternal` |

`viaProxy` is computed automatically:
```
viaProxy = (totalDefinedProxyNodes + totalDefinedExternalNodes) > 0
```

When `viaProxy` is true, every external participant's stream is counted at both the edge node and the transcoding node behind it. Internal participants are unaffected.

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

`app.js` will throw if `config.js` has not been loaded first. There is no build step, bundler, or package manager.

---

## How to Safely Modify the Calculator

### Changing a constant (e.g. headroom, bandwidth figures, HD weights)

Edit [js/config.js](js/config.js) only. All numeric constants live there. Do not hardcode values inside [js/app.js](js/app.js).

```js
// js/config.js — example: change headroom from 25% to 30%
HEADROOM_FACTOR: 1.30,
```

### Adding a new endpoint type

1. Add an entry to `ENDPOINT_TYPES` in [js/config.js](js/config.js):
   ```js
   my_endpoint: {
     label:             'My Endpoint',
     connectionFactor:  1.0,
     presentationExtra: false,
     presentationHD:    0,
     gatewayLegs:       1,
   }
   ```
2. Add an entry to `ENDPOINT_CODEC` (static codec label or `null` for user-selectable).
3. Add a row to `endpointRows` in `setup()` in [js/app.js](js/app.js).
4. The `rowResults` computed will pick up the new type automatically via the `ENDPOINT_TYPES` lookup.

### Adding a new node role to the Topology Builder

1. Add an entry to `NODE_ROLES` in [js/config.js](js/config.js).
2. Add an `<option>` to the role `<select>` in [index.html](index.html).
3. Add a `totalDefinedMyRoleNodes` computed in [js/app.js](js/app.js) alongside the existing proxy/external computeds.
4. Decide whether the role triggers proxy doubling — if yes, include it in the `viaProxy` computed.
5. Push a row into `nodeRecommendations` and add a `.badge-my-role` CSS class.

### Adding a new CPU instruction set

Add an entry to `CPU_EFFICIENCY_TABLE` in [js/config.js](js/config.js) and expose it in the `EFFICIENCY_BASE` object in `setup()` in [js/app.js](js/app.js) so the template can display it.

### Modifying the calculation pipeline

The 9-step pipeline runs inside `setup()` in [js/app.js](js/app.js) as a chain of Vue `computed()` properties. Each step reads from the previous one. If you insert a new step:

- Declare it between the existing steps it logically belongs between.
- Update all downstream `computed()` references to use the new intermediate value.
- Verify the chain against a hand-calculated example using the verification cases in the plan file.

### What not to do

- **Do not introduce a build step.** GitHub Pages serves static files. Adding webpack, Vite, or any bundler changes the deployment model.
- **Do not add `<script type="module">`.** The plain `<script>` + `window.PEXIP` pattern is intentional. ES modules break the global-variable handoff without a bundler.
- **Do not inline constants in `app.js`.** Keeping all numbers in `config.js` makes auditing safe without touching computation logic.
- **Do not split `setup()` across files.** Vue's reactivity depends on all `reactive()`, `ref()`, and `computed()` calls being in the same scope.
