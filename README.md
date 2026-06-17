# Pexip Resource & Capacity Calculator

A static, browser-based sizing tool for planning [Pexip Infinity](https://www.pexip.com/) video conferencing deployments. It models the nodes, vCPU, and bandwidth a deployment will need before any infrastructure is provisioned.

Runs entirely in the browser with no build step. Hosted on GitHub Pages at [catherinecq-pexip.github.io/VMCalculator](https://catherinecq-pexip.github.io/VMCalculator/).

---

## Purpose

Architects and customers use this tool to answer:

- How many transcoding nodes do I need for my endpoint mix?
- What vCPU count is required given my CPU model and hypervisor?
- How much bandwidth will peak concurrent calls consume — split by LAN and WAN?
- Do I need proxy/edge nodes, and how many?
- What is the per-meeting Teams Adaptive Composition overhead?

The workflow mirrors how Pexip resources are actually consumed:

1. **Define endpoint types** (① Endpoint & Interop Model) — set total count, quality, codec, and presentation for each platform (SIP/H.323, Zoom, WebRTC, Teams, Google Meet, Skype for Business).
2. **Build the topology** (② Deployment Topology Builder) — create locations, add nodes with roles (Transcoding / Proxy / External), and assign how many endpoints of each type sit at each location.
3. **Model meetings** (③ Meeting Builder) — add one card per peak active conference. Each card specifies the host location, participants by location (including external), and participants by endpoint type. All resource calculations — HD, backplane, bandwidth, proxy doubling — are derived from this meeting data.
4. **Configure hardware** (④ Hardware Configuration) — select CPU instruction set, clock speed, hypervisor, and node vCPU size.

The output is a per-location node recommendation table, total vCPU count, per-meeting HD breakdown, and full LAN/WAN bandwidth estimate.

---

## Principles Derived from Pexip

The calculation model is grounded in Pexip's published capacity planning methodology:

- **HD equivalence** — All streams are normalised to a 720p HD unit. Full HD (1080p) costs 2.0 HD; SD costs 0.5 HD; audio costs 0.0625 HD. This reduces heterogeneous endpoint mixes to a single scalar for node sizing.
- **Per-platform connection factors** — Each endpoint type carries a different resource multiplier: SIP/H.323 = 1.0×, WebRTC VP8 = 1.0×, WebRTC VP9 = 1.25×, Microsoft Teams = 1.5×, Google Meet = 1.0×, Skype for Business = 1.0×. These encode codec normalisation, layout adaptation, and gateway leg overhead — no manual interop override needed.
- **VP9 resource trade-off** — VP9 reduces bandwidth by ~33% compared to H.264 at the same resolution, but increases node CPU load by 25% (`VP9_RESOURCE_FACTOR = 1.25`).
- **Teams Adaptive Composition** — When Teams participants are in a meeting using Adaptive/Teams-like layout, an additional HD reservation is made per conference: +1.0 HD for up to 3 on-stage participants, plus +0.5 HD per on-stage participant beyond 3. This is computed per meeting using the Teams participant count defined in that meeting card.
- **Meeting-driven resources** — Resources are consumed only during active conferences. The Meeting Builder models each peak conference individually; the pipeline sums HD across all meetings to produce total resource requirements.
- **Backplane overhead** — Meetings whose participants span multiple topology locations incur inter-node signalling cost: +1 HD per cross-location link per meeting. Detected per meeting from participant location inputs, not from a global site count.
- **Proxy doubling (external participants only)** — External participants (those with no assigned topology location) route via proxy/edge nodes. When proxy or external nodes exist in the topology, their HD contribution is doubled per meeting. Internal participants are never doubled. The external proportion within each meeting is used to split the proxy factor across endpoint types.
- **NUMA alignment** — Pexip performance is sensitive to NUMA topology. A node VM should not span NUMA nodes. The calculator warns when `nodeVcpuSize > cpuCoresPerSocket` and blocks configurations where `nodeVcpuSize > cpuCoresPerSocket × 2`.
- **No CPU overcommit** — Pexip is CPU-intensive real-time media software. The calculator warns to maintain a 1:1 vCPU-to-physical-core ratio on non-cloud hypervisors.
- **25% headroom** — All resource totals are multiplied by 1.25 before converting to node counts. This provides capacity for bursts and rolling upgrades.
- **CPU efficiency calibration** — Base HD-per-vCPU figures are calibrated from Pexip NUMA documentation (Xeon Gold 6342, AVX-512, 2.8 GHz ≈ 195 HD across 2 nodes × 16 vCPU each). Clock speed and instruction-set tier scale linearly from that reference point.

---

## Calculation Methodology

The calculator runs a sequential pipeline. All formulas can be traced directly to the constants in [js/config.js](js/config.js) and the `computed()` properties in [js/app.js](js/app.js).

---

### Step 1 — Endpoint configuration reference (`rowResults`)

`rowResults` computes a reference HD-per-participant value for each endpoint type. This drives the "Endpoint Configuration Reference" table in the results panel and is used inside `meetingResults` (Step 2) to look up quality weights and bandwidth figures. It does not directly contribute to the resource pipeline total.

**Formula:**
```
weight       = QUALITY_WEIGHTS[quality]     { 'sd': 0.5, '720p': 1.0, '1080p': 2.0 }
codecFactor  = 1.25  if codec === 'vp9'  else  1.0
connFactor   = ENDPOINT_TYPES[type].connectionFactor

hdPerPt      = weight × connFactor × codecFactor   (HD cost per participant of this type)
bwPerStream  = BANDWIDTH_TABLE[quality + '-' + codec]
```

**Per-platform connection factors:**

| Endpoint | `connectionFactor` | Default codec | Presentation overhead |
|---|---|---|---|
| SIP / H.323 | 1.0 | H.264 | — (native dual-stream) |
| Zoom | 1.0 | H.264 | — |
| WebRTC | 1.0 (VP8) / 1.25 (VP9) via `codecFactor` | VP8 or VP9 | +1.0 HD/participant |
| Microsoft Teams | 1.5 | MS / H.264 | +0.5 HD/participant |
| Google Meet | 1.0 | VP8 | +1.0 HD/participant |
| Skype for Business | 1.0 | H.264 | +1.0 HD/participant |

---

### Step 2 — Per-meeting resource calculation (`meetingResults`)

This is the core of the pipeline. For each meeting card defined in the Meeting Builder:

**Inputs:** `participantLocations[]` (location → count), `participantEndpoints{}` (type → count), `layout`, `presentationActive`, `hostLocationId`, `endpointRows[]` (for quality/codec settings).

**2a — Participant totals and external proportion:**
```
totalPts       = sum(participantLocations[*].count)
extPts         = sum(count where locationId === 'external')
extProportion  = extPts / totalPts        (0.0 if no participants)
```

**2b — Cross-location detection:**
```
locIdsWithPts  = set of non-external locationIds with count > 0
nonHostLocs    = locIdsWithPts excluding hostLocationId

hasCrossLocation = true  if:
  - locIdsWithPts.size > 1, OR
  - hostLocationId is set but not in locIdsWithPts, OR
  - hostLocationId is null and locIdsWithPts is non-empty

crossLocationCount = max(0, nonHostLocs.length)
```

**2c — HD per endpoint type:**

For each type T with `typeCount = participantEndpoints[T] > 0`:
```
weight        = QUALITY_WEIGHTS[endpointRows[T].quality]
codecFactor   = 1.25 if endpointRows[T].codec === 'vp9' else 1.0
connFactor    = ENDPOINT_TYPES[T].connectionFactor
base          = weight × connFactor × codecFactor
proxyFactor   = 2.0 if viaProxy else 1.0

typeExtCount  = round(typeCount × extProportion)
typeIntCount  = typeCount − typeExtCount

hdT           = typeIntCount × base + typeExtCount × base × proxyFactor

hdPresentation_T = typeCount × ENDPOINT_TYPES[T].presentationHD
                   if (ENDPOINT_TYPES[T].presentationExtra && presentationActive)
                   else 0
```

**2d — Teams Adaptive Composition (per meeting):**
```
teamsInMeeting = participantEndpoints.teams

hdComposition = 0  if layout !== 'adaptive' or teamsInMeeting === 0
hdComposition = TEAMS_COMPOSITION_HD_BASE
                + max(0, teamsInMeeting − 3) × TEAMS_COMPOSITION_HD_ONSTAGE
                otherwise

where:
  TEAMS_COMPOSITION_HD_BASE    = 1.0 HD   (≤3 on-stage)
  TEAMS_COMPOSITION_HD_ONSTAGE = 0.5 HD   (each on-stage beyond 3)
```

**2e — Meeting HD total:**
```
hdTotal_M = sum(hdT for all types) + sum(hdPresentation_T for all types) + hdComposition
```

**Example:** Meeting with 10 Teams (host=East), 3 external Teams, HD, proxy nodes in topology, presentation on, adaptive layout:
```
extProportion  = 3 / 13 = 0.23
typeExtCount   = round(13 × 0.23) = 3
typeIntCount   = 13 − 3 = 10
base           = 1.0 × 1.5 × 1.0 = 1.5 HD

hdEndpoints    = 10 × 1.5 + 3 × 1.5 × 2.0 = 15 + 9 = 24.0 HD
hdPresentation = 13 × 0.5 = 6.5 HD
hdComposition  = 1.0 + max(0, 13 − 3) × 0.5 = 1.0 + 5.0 = 6.0 HD

hdTotal        = 24 + 6.5 + 6 = 36.5 HD
```

**2f — Bandwidth per meeting:**
```
bwPerStream = BANDWIDTH_TABLE[quality + '-' + codec]
bwLan_T     = typeIntCount × bwPerStream   (LAN — internal participants)
bwWan_T     = typeExtCount × bwPerStream   (WAN — external participants via proxy)
```

---

### Step 3 — Total HD before backplane

```
totalHDBeforeBackplane = sum(hdTotal_M  for all meetings M)
```

Proxy doubling and composition overhead are already embedded in each meeting's `hdTotal` from Step 2.

---

### Step 4 — Backplane overhead

Backplane is now detected per meeting rather than from a global `meetings × sites` formula. A meeting incurs backplane cost only when its participants span multiple topology locations.

**Inputs:** `meetingResults[]`, `totalDefinedTranscodingNodes`.

```
backplaneHD = 0   if totalDefinedTranscodingNodes ≤ 1

otherwise:
backplaneHD = sum over meetings M where hasCrossLocation:
                max(1, crossLocationCount_M) × BACKPLANE_HD_PER_MEETING

where BACKPLANE_HD_PER_MEETING = 1.0 HD
```

| Meeting scenario | Backplane contribution |
|---|---|
| All participants in host location | 0 HD |
| Participants from 1 additional location | +1.0 HD |
| Participants from 2 additional locations | +2.0 HD |
| No host location set, any non-external participants | +N HD (N = distinct location count) |

**Example:** 3 meetings — Meeting A has East + West participants (1 cross-location link), Meeting B is East-only, Meeting C has East + West + South (2 cross-location links):
```
backplaneHD = (1 × 1.0) + 0 + (2 × 1.0) = 3.0 HD
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

```
effectiveHDperVcpu = CPU_EFFICIENCY_TABLE[cpuInstructionSet]
                     × (cpuClockGhz / CPU_REFERENCE_CLOCK)
                     × (HT_BONUS_FACTOR if hyperthreading else 1.0)
                     × HYPERVISOR_FACTORS[hypervisor]
```

| Instruction set | Base HD/vCPU |
|-----------------|-------------|
| Legacy (SSE4)   | 2.5         |
| AVX-2           | 4.0         |
| AVX-512         | 6.0         |

`CPU_REFERENCE_CLOCK = 2.8 GHz` (calibrated from Pexip NUMA docs: Xeon Gold 6342, AVX-512).

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

**Proxy / External node count** comes directly from the topology: the number of Proxy (DMZ/Edge) + External (Public-facing) nodes defined in the Topology Builder.

**Node recommendations when multi-site:**
```
nodesPerLocation = ceil(transcodingNodes / numberOfTranscodingLocations)
```
Each transcoding location gets its own row in the recommendations table.

---

### Step 8 — Bandwidth calculation

Bandwidth is computed per meeting from the internal/external participant split within that meeting.

**Per meeting M, per endpoint type T:**
```
bwKey        = quality + '-' + codec     (e.g. '720p-h264', '720p-vp9')
bwPerStream  = BANDWIDTH_TABLE[bwKey]    (fallback: quality + '-h264')
bwLan_T      = typeIntCount × bwPerStream
bwWan_T      = typeExtCount × bwPerStream
```

**Bandwidth lookup table (kbps per stream, video only):**

| Resolution | H.264 | VP8   | VP9   |
|------------|-------|-------|-------|
| 1080p      | 2,400 | 2,400 | 1,600 |
| 720p       | 960   | 960   | 640   |
| SD         | 448   | 448   | 448   |
| Audio      | 64    | 64    | 64    |

VP8 uses H.264-equivalent bandwidth (similar bitrate at same resolution).

**Totals:**
```
totalBandwidthKbps = sum(bwLan_T + bwWan_T  for all meetings, all types)
wanBandwidthKbps   = sum(bwWan_T             for all meetings, all types)
```

**Inter-node backplane bandwidth** (only for cross-location meetings):
```
interNodeBandwidthKbps = sum over cross-location meetings M:
                           max(1, crossLocationCount_M) × 960 kbps
```

---

### Step 9 — Topology and routing model

Three topology features drive routing accuracy:

**Topology Builder — nodes:** Defines where transcoding capacity sits (`transcodingLocations`), whether proxy doubling applies (`viaProxy = proxyNodes + externalNodes > 0`), and the backplane factor (number of transcoding locations).

**Topology Builder — endpoint assignment:** Each location has an Endpoints sub-section showing how many of each defined endpoint type are assigned there. This is informational — it shows a `remaining/total` counter per type and warns when endpoints are not fully assigned, but does not block or constrain Meeting Builder inputs.

**Meeting Builder — host location + participant locations:** The meeting host location determines which participants are "local" (same location) vs "remote" (different location). The cross-location detection in Step 2b uses these inputs to flag backplane cost and routing overhead per meeting.

| Routing scenario | Effect |
|---|---|
| All participants at host location | No backplane, no proxy doubling |
| Participants from other topology locations | `crossLocationCount` → backplane contribution |
| Participants with `locationId === 'external'` + proxy nodes defined | `proxyFactor = 2.0` applied to external portion |
| No proxy nodes defined | `proxyFactor = 1.0` regardless of external participants |

`viaProxy` is derived automatically:
```
viaProxy = (totalDefinedProxyNodes + totalDefinedExternalNodes) > 0
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
2. Add an entry to `ENDPOINT_CODEC` (static label or `null` for user-selectable).
3. Add a row to `endpointRows` in `setup()` in [js/app.js](js/app.js).
4. Add a `participantEndpoints.my_endpoint: 0` field to the `addMeeting()` function in [js/app.js](js/app.js) so new meeting cards include this type.
5. `rowResults` and `meetingResults` will pick up the new type automatically via the `ENDPOINT_TYPES` and `endpointRows` lookups.

### Adding a new node role to the Topology Builder

1. Add an entry to `NODE_ROLES` in [js/config.js](js/config.js).
2. Add an `<option>` to the role `<select>` in the location nodes section of [index.html](index.html).
3. Add a `totalDefinedMyRoleNodes` computed in [js/app.js](js/app.js) alongside the existing proxy/external computeds.
4. Decide whether the role triggers proxy doubling — if yes, include it in the `viaProxy` computed.
5. Push a row into `nodeRecommendations` and add a `.badge-my-role` CSS class in [css/styles.css](css/styles.css).

### Modifying meeting fields

Each meeting object is created in `addMeeting()` in [js/app.js](js/app.js). To add a new per-meeting field:

1. Add the field and its default value to the object in `addMeeting()`.
2. Add the corresponding input control to the meeting card in [index.html](index.html).
3. Reference the field inside `meetingResults` to incorporate it into the HD calculation.

### Adding a new CPU instruction set

Add an entry to `CPU_EFFICIENCY_TABLE` in [js/config.js](js/config.js) and expose it in the `EFFICIENCY_BASE` object in `setup()` in [js/app.js](js/app.js) so the template can display it.

### Modifying the calculation pipeline

The pipeline runs inside `setup()` in [js/app.js](js/app.js) as a chain of Vue `computed()` properties. Key computeds in order:

```
rowResults → meetingResults → totalHDBeforeBackplane → backplaneHD
→ totalHDRaw → totalHDWithHeadroom → effectiveHDperVcpu
→ vCPURequired → transcodingNodeCount
```

When inserting a new step, update all downstream `computed()` references to use the new intermediate value and verify the chain with a hand-calculated example.

### What not to do

- **Do not introduce a build step.** GitHub Pages serves static files. Adding webpack, Vite, or any bundler changes the deployment model.
- **Do not add `<script type="module">`.** The plain `<script>` + `window.PEXIP` pattern is intentional. ES modules break the global-variable handoff without a bundler.
- **Do not inline constants in `app.js`.** Keeping all numbers in `config.js` makes auditing safe without touching computation logic.
- **Do not split `setup()` across files.** Vue's reactivity depends on all `reactive()`, `ref()`, and `computed()` calls being in the same scope.
