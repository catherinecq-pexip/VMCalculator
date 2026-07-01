# Pexip Resource & Capacity Calculator

A static, browser-based sizing tool for planning [Pexip Infinity](https://www.pexip.com/) video conferencing deployments. It models the nodes, vCPU, and bandwidth a deployment will need before any infrastructure is provisioned.

Runs entirely in the browser with no build step. Hosted on GitHub Pages at [catherinecq-pexip.github.io/VMCalculator](https://catherinecq-pexip.github.io/VMCalculator/).

---

## Purpose

Architects and customers use this tool to answer:

- How many transcoding nodes do I need for my endpoint mix?
- What vCPU count is required given my CPU model and hypervisor?
- What is the minimum and maximum bandwidth requirement across all meetings, broken out by meeting access, inter-node backplane, and proxy forwarding?
- Do I need proxy/edge nodes, and how many?
- What is the per-meeting gateway overhead for Teams or Google Meet calls?
- How does backplane cost change across single-site, multi-site, and gateway meeting scenarios?

The workflow mirrors how Pexip resources are actually consumed:

1. **Define endpoint types** (① Endpoint & Interop Model) — set total count, quality, and codec for each platform (SIP/H.323, Zoom, WebRTC, Teams, Google Meet, Skype for Business). Connection factors and gateway overhead are applied automatically.
2. **Build the topology** (② Deployment Topology Builder) — create locations and assign how many endpoints of each type sit at each location. Nodes defined in ④ automatically appear here in a read-only view, grouped by location.
3. **Configure meetings** (③ Meeting Builder) — meeting templates are **auto-generated** from the topology. Each template specifies: participant count and distribution by location (including external), meeting type (gateway target or standard VMR), layout, and presentation. The Endpoint Pool Allocation summary at the top of this section shows demand against assigned endpoints in real time. Resource calculations are topology-driven and independent of the hardware configuration section.
4. **Build the hardware deployment** (④ Deployment Hardware Builder) — define one or more physical or cloud servers (sockets, cores, clock speed, hyperthreading, RAM, hypervisor). Each server is a resource container. Carve Pexip nodes out of servers in the Configure Nodes tab: assign each node a role (Transcoding Conferencing, Proxying Edge, Management), socket/NUMA affinity, vCPU, and RAM. Node counts drive the allocation summary strip and feed back into the topology view in ②. HD capacity and vCPU/RAM allocation are tracked per server and across the deployment.

The output is a per-location node recommendation table, total vCPU count, per-template HD breakdown with full backplane and gateway decomposition in the interop summary, and a five-section network bandwidth model.

---

## Principles Derived from Pexip

The calculation model is grounded in Pexip's published capacity planning methodology:

- **HD equivalence** — Full HD (1080p) costs 2.0 HD; SD costs 0.5 HD; audio costs 0.0625 HD. This reduces heterogeneous endpoint mixes to a single scalar for node sizing.
- **Per-platform connection factors** — SIP/H.323 = 1.0×, Zoom = 1.0×, WebRTC VP8 = 1.0×, WebRTC VP9 = 1.25× (via codec factor), Microsoft Teams = 1.5× (minimum 1.5 HD per connection at any quality), Google Meet = 1.0×, Skype for Business = 1.0×.
- **Gateway call overhead** — When the meeting type is a cloud gateway (Teams or Google Meet), Pexip creates one gateway call leg per participant to the external platform. Each leg carries a fixed HD overhead on the hosting transcoding node, in addition to the participant's endpoint HD: Teams Connector = 1.5 HD/call, Google Meet connection = 1.0 HD/call. These are shown grouped under "Endpoint HD" in the interop summary. This cost is independent of endpoint quality and applies to all participants regardless of location.
- **Backplane model (per Pexip docs)** — Every transcoding node in a multi-node deployment reserves a fixed **1 HD per conference** for backplane, even if the conference is not distributed. Each topology location is treated as a separate node. Single-location deployments (one location defined) have no backplane reservation. For distributed meetings, each additional participating location adds 1 HD: `(crossLocationCount + 1) × 1 HD`. External participants always imply a proxy node boundary (+1 HD). This model is identical for all meeting types — Teams and Google Meet gateway meetings use the same standard 1 HD backplane; their gateway leg costs (1.5 HD or 1.0 HD per call) are tracked separately in the gateway overhead component.
- **Proxy node load** — Proxy/Edge nodes forward external calls without transcoding. Each forwarded call consumes approximately 0.2 HD on the proxy node. This demand is tracked separately from transcoding node HD and shown in node recommendations.
- **VP9 resource trade-off** — VP9 reduces bandwidth by ~33% compared to H.264 at the same resolution, but increases node CPU load by 25% (`VP9_RESOURCE_FACTOR = 1.25`).
- **Presentation overhead** — When content is shared in a meeting, each Pexip-routed participant incurs a per-participant HD overhead on the transcoding node (`presentationHD × typeCount`, applied when `presentationActive` is enabled). Overhead by endpoint type: SIP/H.323 = 0.5 HD, Zoom = 0.5 HD, WebRTC = 1.0 HD, Microsoft Teams = 0.5 HD, Google Meet = 1.0 HD, Skype for Business = 1.0 HD.
- **Teams Adaptive Composition** — When the Adaptive/Teams-like layout is active and participants are present, an additional HD reservation is made per conference: +1.0 HD for up to 3 on-stage participants, plus +0.5 HD per on-stage participant beyond 3. This is separate from the Teams Connector gateway overhead.
- **Host-native participant exclusion** — For meetings hosted on external platforms (Teams, Google Meet, Zoom, Skype for Business), native participants of the host platform don't route through Pexip Infinity and consume no Pexip HD or bandwidth resources. Only interop participants whose media path traverses Pexip count toward endpoint HD, gateway overhead, composition overhead, audio bandwidth, and presentation bandwidth. Pexip-native meeting types (SIP/H.323, WebRTC) are unaffected — all participants count.
- **Template-driven resources** — Resources are consumed only during active conferences. Each template's per-meeting HD/BW cost is computed once and multiplied by the template's meeting count to produce aggregate totals.
- **Layout-driven video participant limits** — Each layout has a maximum number of participants actively composited into the video mix. Participants beyond that limit are treated as audio-only for HD resource calculation (0.0625 HD × connFactor). Limits by category: Adaptive Composition (12); Speaker-Focused: 1+0 (1), 1+1 (2), 1+7 (8), 1+21 (22), 2+21 (23), 1+33 (34); Equal Grid: 2×2 (4), 3×3 (9), 4×4 (16), 5×5 (25).
- **Demand-driven node recommendations** — The recommended transcoding node count is derived from meeting demand (vCPU required ÷ vCPU per node), not from the physical hardware count alone. Hardware configuration determines the node size and efficiency; demand determines how many nodes are needed.
- **NUMA alignment** — Pexip performance is sensitive to NUMA topology. A node VM should not span NUMA nodes. The calculator warns when `nodesPerSocket > 2`.
- **No CPU overcommit** — Pexip is CPU-intensive real-time media software. The calculator warns to maintain a 1:1 vCPU-to-physical-core ratio on non-cloud hypervisors.
- **25% headroom** — All resource totals are multiplied by 1.25 before converting to node counts. This provides capacity for bursts and rolling upgrades.
- **CPU efficiency calibration** — The base HD/vCPU efficiency is fixed at **4.0 HD/vCPU** (AVX2 baseline, 2.8 GHz reference clock). Clock speed and hypervisor factors scale linearly from that reference. Hyperthreading adds a 1.4× bonus when VMs are NUMA-pinned to a single socket. This conservative fixed baseline avoids the variability introduced by per-server instruction set selection.

---

## Calculation Methodology

The calculator runs a sequential pipeline. All formulas can be traced directly to the constants in [js/config.js](js/config.js) and the `computed()` properties in [js/app.js](js/app.js).

---

### Step 1 — Endpoint configuration reference (`rowResults`)

`rowResults` computes a reference HD-per-participant value for each endpoint type. This drives the "Endpoint Configuration Reference" table in the results panel and is used inside `meetingResults` (Step 2) to look up quality weights and bandwidth figures.

**Formula:**
```
weight       = QUALITY_WEIGHTS[quality]     { 'sd': 0.5, '720p': 1.0, '1080p': 2.0, 'audio': 0.0625 }
codecFactor  = 1.25  if codec === 'vp9'  else  1.0
connFactor   = ENDPOINT_TYPES[type].connectionFactor
rawHdPerPt   = weight × connFactor × codecFactor
hdPerPt      = max(ENDPOINT_TYPES[type].minConnectionHD, rawHdPerPt)   if minConnectionHD is defined
               else rawHdPerPt

bwPerStream  = BANDWIDTH_TABLE[quality + '-' + codec]
```

**Per-platform connection factors:**

| Endpoint | `connectionFactor` | `minConnectionHD` | Default codec | Presentation overhead |
|---|---|---|---|---|
| SIP / H.323 | 1.0 | — | H.264 | +0.5 HD/participant |
| Zoom | 1.0 | — | H.264 | +0.5 HD/participant |
| WebRTC | 1.0 (VP8) / applies VP9 codecFactor | — | VP8 or VP9 | +1.0 HD/participant |
| Microsoft Teams | 1.5 | 1.5 HD | MS / H.264 | +0.5 HD/participant |
| Google Meet | 1.0 | — | VP8 | +1.0 HD/participant |
| Skype for Business | 1.0 | — | H.264 | +1.0 HD/participant |

---

### Step 2 — Per-template resource calculation (`meetingResults`)

This is the core of the pipeline. For each template in the Meeting Builder, one set of per-meeting HD/BW values is computed and then multiplied by the template's effective meeting count to produce aggregate totals.

**2a — Participant totals and external proportion:**
```
totalPts       = sum of all participant counts in template
extPts         = count of external participants (no location assigned)
extProportion  = extPts / totalPts   (0.0 if no participants)
```

**2b — Host-native participant exclusion:**

For external-hosted meetings, the host-native endpoint type is zeroed out before all HD and bandwidth sub-calculations. Those participants don't traverse Pexip Infinity.

```
PEXIP_NATIVE_TYPES  = { 'sip_h323', 'webrtc' }
isExternalHosted    = meetingType ∉ PEXIP_NATIVE_TYPES

pexipParticipantEndpoints = { ...participantEndpoints, [meetingType]: 0 }   if isExternalHosted
                          = participantEndpoints                              otherwise

pexipPts = sum(pexipParticipantEndpoints values)
```

`pexipPts` drives all HD, composition, gateway overhead, audio bandwidth, and presentation activation (Steps 2c–2e). `totalPts` (the full headcount) continues to govern backplane and proxy topology decisions (Steps 2f–2g).

**2c — Cross-location detection:**
```
locIdsWithPts  = set of location IDs with participant count > 0
nonHostLocs    = locIdsWithPts excluding the template's host location

hasCrossLocation = true  if:
  - participants span more than 1 location, OR
  - host location is set but has no participants assigned to it, OR
  - host location is null and any located participants exist

crossLocationCount = max(0, nonHostLocs.length)   ← non-host locations with participants
```

**2d — HD per endpoint type:**

Layout video limits determine video-visible vs. audio-only split, using Pexip-routed participants only:
```
maxVideoPts   = LAYOUTS[layout].maxVideoParticipants   (null = no limit)
audioOverflow = max(0, pexipPts − maxVideoPts)
videoFraction = min(1, maxVideoPts / pexipPts)
```

For each participant type T with count > 0 (using `pexipParticipantEndpoints`):
```
weight        = QUALITY_WEIGHTS[endpointRows[T].quality]
codecFactor   = 1.25 if codec === 'vp9' else 1.0
connFactor    = ENDPOINT_TYPES[T].connectionFactor
rawBase       = weight × connFactor × codecFactor
base          = max(ENDPOINT_TYPES[T].minConnectionHD, rawBase)   if minConnectionHD defined, else rawBase

typeVideoCount = round(typeCount × videoFraction)
typeAudioCount = typeCount − typeVideoCount
audioBase      = QUALITY_WEIGHTS.audio × connFactor

hdT            = typeVideoCount × base + typeAudioCount × audioBase

hdPresentation_T = typeCount × ENDPOINT_TYPES[T].presentationHD
                   if (presentationExtra && presentationActive) else 0
```

**2e — Teams Adaptive Composition overhead (per meeting):**
```
hdComposition = 0   if layout !== 'adaptive' or videoVisiblePts = 0

hdComposition = TEAMS_COMPOSITION_HD_BASE
                + max(0, videoVisiblePts − 3) × TEAMS_COMPOSITION_HD_ONSTAGE
                if layout === 'adaptive' and videoVisiblePts > 0

where:
  TEAMS_COMPOSITION_HD_BASE    = 1.0 HD   (≤3 on-stage participants)
  TEAMS_COMPOSITION_HD_ONSTAGE = 0.5 HD   (each on-stage participant beyond 3)
  videoVisiblePts              = min(pexipPts, maxVideoPts)   ← Pexip-routed participants only
```

This represents the video compositing overhead for adaptive layout and applies to any meeting using that layout, regardless of meeting type.

**2f — Gateway call overhead (per meeting, per participant):**

When the meeting type is a cloud gateway, every Pexip-routed participant generates a gateway call leg on the hosting transcoding node. Host-native participants (excluded in Step 2b) do not generate a Pexip gateway leg.

```
gatewayHDPerCall = GATEWAY_HD_PER_CALL_TEAMS        (1.5 HD)   if meetingType === 'teams'
                 = GATEWAY_HD_PER_CALL_GOOGLE_MEET  (1.0 HD)   if meetingType === 'google_meet'
                 = 0                                            otherwise

hdGateway = pexipPts × gatewayHDPerCall   ← Pexip-routed participants only
```

This cost is fixed per call regardless of endpoint quality, and is separate from `hdComposition`. It represents the Teams Connector leg to Microsoft or the Google Meet connection to Google.

**2g — Per-meeting backplane HD:**

Backplane cost is topology-driven. Each topology location is treated as a separate node. The same rule applies to all meeting types — gateway overhead (Teams/Google Meet) is a separate component.

```
isMultiNodeDeployment = locations.length > 1

if isMultiNodeDeployment:
  nodeCount   = (crossLocationCount + 1)   if hasCrossLocation   else 1
  hdBackplane = nodeCount × BACKPLANE_HD_PER_MEETING   (1.0 HD per node, fixed)
  hdBackplane += BACKPLANE_HD_PER_MEETING   if extPts > 0   (proxy = extra node boundary)

else:   (single location = single-node deployment)
  hdBackplane = 0
```

**Backplane model by scenario (all meeting types, per meeting):**

| Scenario | Topology | hdBackplane |
|---|---|---|
| Single location defined | 1 location | 0 HD (single-node, no backplane) |
| Single-location meeting, multi-location topology | ≥2 locations | 1.0 HD (base reservation, non-distributed) |
| Host + 1 remote location | ≥2 locations | 2.0 HD |
| Host + 2 remote locations | ≥2 locations | 3.0 HD |
| External participants only (no cross-location) | ≥2 locations | 2.0 HD (host node + proxy boundary) |
| Cross-location + external participants | ≥2 locations | (N+1) × 1.0 + 1.0 HD |

Teams and Google Meet gateway meetings use the same backplane values. Their gateway leg costs (1.5 HD or 1.0 HD per call) are accounted for separately in `hdGateway`.

**2h — Per-meeting HD total:**
```
hdTotal = hdEndpoints + hdPresentation + hdComposition + hdGateway
```

`hdBackplane` is tracked separately from `hdTotal` and displayed as its own line in the interop summary. The aggregate `backplaneHD = sum(hdBackplaneAll)` across all templates.

**Effective meeting count and aggregate:**
```
effectiveCount = meetingCount   (user-controlled; pool over-commitment is shown as a warning, not a hard cap)

hdTotalAll      = hdTotal      × effectiveCount
hdBackplaneAll  = hdBackplane  × effectiveCount
```

**Example — Teams gateway, cross-location, 3 SIP participants (1 at host, 2 remote), 0 Teams-native participants, multi-location topology, 10 meetings:**
```
pexipPts      = 3   (all participants are SIP, not Teams-native → pexipParticipantEndpoints unaffected)
hdEndpoints   = 3 × 1.0 = 3.0 HD   (SIP/H.264 at 720p)
hdGateway     = 3 × 1.5 = 4.5 HD   (Teams Connector, 1.5 HD/call per Pexip-routed participant)
hdComposition = 0                   (not adaptive layout)
hdPresentation= 0                   (presentation off)

hdTotal       = 3.0 + 4.5 = 7.5 HD  per meeting

Interop summary "Endpoint HD" = hdEndpoints + hdGateway = 7.5 HD
  · Teams gateway (+1.5 HD/call) = 4.5 HD

isMultiNodeDeployment = true (multiple locations)
nodeCount   = crossLocationCount + 1 = 1 + 1 = 2
hdBackplane = 2 × 1.0 = 2.0 HD   (standard Pexip inter-node backplane, all meeting types)

Total per meeting = hdTotal + hdBackplane = 7.5 + 2.0 = 9.5 HD
hdTotalAll    = 7.5 × 10  = 75 HD
hdBackplaneAll= 2.0 × 10  = 20 HD
```

**2i — Bandwidth per meeting (min / max range):**

Access bandwidth (using `pexipParticipantEndpoints` — host-native excluded):
```
bwKey     = quality + '-' + codec
bwMin     = BANDWIDTH_TABLE[bwKey]
bwMax     = min(PARTICIPANT_MAX_KBPS, BANDWIDTH_TABLE_MAX[bwKey])

bwAccessMin += typeCount × bwMin   (summed across Pexip-routed endpoint types)
bwAccessMax += typeCount × bwMax

bwAudioMin  = pexipPts × AUDIO_MIN_KBPS   (8 kbps/participant)
bwAudioMax  = pexipPts × AUDIO_MAX_KBPS   (64 kbps/participant)
```

Presentation stream (activated only if `pexipPts > 0`):
```
pBw              = PRESENTATION_BW[meetingType] ?? PRESENTATION_BW.default
bwPresentationMin = pBw.min
bwPresentationMax = pBw.max
```

| Meeting type | Presentation min | Presentation max |
|---|---|---|
| Teams | 2,400 kbps | 2,400 kbps |
| Google Meet | 960 kbps | 2,000 kbps |
| All others | 960 kbps | 2,400 kbps |

Inter-node backplane bandwidth (cross-location meetings):
```
lp = LAYOUTS[layout].backplane   { hd: N, thumb: M }

bwBackplaneMin = lp.hd × BACKPLANE_HD_MIN_KBPS + lp.thumb × BACKPLANE_THUMB_MIN_KBPS
bwBackplaneMax = lp.hd × BACKPLANE_HD_MAX_KBPS + lp.thumb × BACKPLANE_THUMB_MAX_KBPS

if presentationActive:
  bwBackplaneMin += BACKPLANE_PRESENTATION_KBPS   (1,600 kbps)
  bwBackplaneMax += BACKPLANE_PRESENTATION_KBPS
```

Backplane stream counts per layout:

| Layout | Max video | HD streams | Thumbnail streams | BW min | BW max |
|---|---|---|---|---|---|
| Adaptive Composition | 12 | 13 | 0 | 20,800 kbps | 52,000 kbps |
| 1+0 | 1 | 1 | 0 | 1,600 kbps | 4,000 kbps |
| 1+1 | 2 | 2 | 0 | 3,200 kbps | 8,000 kbps |
| 1+7 | 8 | 2 | 7 | 3,648 kbps | 9,344 kbps |
| 1+21 | 22 | 2 | 21 | 4,544 kbps | 12,032 kbps |
| 2+21 | 23 | 2 | 21 | 4,544 kbps | 12,032 kbps |
| 1+33 | 34 | 2 | 33 | 5,312 kbps | 14,336 kbps |
| 2×2 | 4 | 4 | 0 | 6,400 kbps | 16,000 kbps |
| 3×3 | 9 | 9 | 0 | 14,400 kbps | 36,000 kbps |
| 4×4 | 16 | 16 | 0 | 25,600 kbps | 64,000 kbps |
| 5×5 | 25 | 25 | 0 | 40,000 kbps | 100,000 kbps |

Proxy-forwarded bandwidth (external participants):
```
bwProxyMin = round(bwAccessMin × extProportion)   if extPts > 0
bwProxyMax = round(bwAccessMax × extProportion)
```

External participants always imply proxy routing; this bandwidth is tracked independently of whether proxy nodes have been explicitly defined in the topology.

---

### Step 3 — Total HD before backplane

```
totalHDBeforeBackplane = sum(hdTotalAll  for all templates)
```

This includes endpoint HD, presentation, composition, and gateway overhead — but not backplane.

---

### Step 4 — Backplane overhead aggregate

```
backplaneHD = sum(hdBackplaneAll  for all templates)
```

Each template's `hdBackplaneAll` is computed in Step 2f and aggregated here. One unified formula covers all meeting types:

```
backplaneHD = sum over all templates:
  if locations.length > 1 (multi-node deployment):
    nodeCount  = (crossLocationCount + 1)   if hasCrossLocation   else 1
    hdBackplane = nodeCount × 1.0 HD
    hdBackplane += 1.0 HD   if extPts > 0   (proxy boundary)
  else:
    hdBackplane = 0
```

| Topology | Scenario | hdBackplane per meeting |
|---|---|---|
| 1 location | Any meeting | 0 HD (single-node) |
| ≥2 locations | Single-location meeting | 1.0 HD (base reservation) |
| ≥2 locations | Distributed (N nodes) | (N) × 1.0 HD |
| ≥2 locations | External participants added | +1.0 HD (proxy boundary) |

Key constant: `BACKPLANE_HD_PER_MEETING = 1.0 HD` — applies identically to regular VMR, Teams gateway, and Google Meet gateway meetings.

---

### Step 5 — Total HD with headroom

```
totalHDRaw          = totalHDBeforeBackplane + backplaneHD
totalHDWithHeadroom = totalHDRaw × HEADROOM_FACTOR   (1.25)
```

The 25% headroom provides capacity for concurrent-use bursts and rolling node upgrades.

---

### Step 6 — CPU efficiency model

Translates total HD demand into a vCPU count based on the primary server's characteristics. If no servers have been defined, a reference estimate is used (4.0 × 3.0/2.8 ≈ 4.29 HD/vCPU).

```
effectiveHDperVcpu = 4.0   (fixed AVX2 baseline, 2.8 GHz reference)
                     × (primaryServer.baseClockGhz / CPU_REFERENCE_CLOCK)
                     × (HT_BONUS_FACTOR if primaryServer.hyperthreading else 1.0)
                     × HYPERVISOR_FACTORS[primaryServer.hypervisor]
```

The base of **4.0 HD/vCPU** is a fixed conservative baseline (AVX2 at 2.8 GHz reference). Clock speed scales linearly from that reference point.

`CPU_REFERENCE_CLOCK = 2.8 GHz`

| Hypervisor | Factor |
|---|---|
| VMware ESXi | 1.0 |
| KVM | 0.95 |
| Hyper-V | 0.90 |
| Cloud / hosted | 1.0 |

`HT_BONUS_FACTOR = 1.4` — only valid when VMs are NUMA-pinned to a single socket.

**Example:** 3.2 GHz, Hyper-V, HT off:
```
effectiveHDperVcpu = 4.0 × (3.2 / 2.8) × 1.0 × 0.90 ≈ 4.11 HD/vCPU
```

---

### Step 7 — vCPU and node count

```
vCPURequired = ceil(totalHDWithHeadroom)   (1 HD = 1 vCPU planning rule)
```

**Transcoding node count** — if transcoding nodes have been defined in the Hardware Builder, the count is taken directly from the user's deployment definition (× server quantity). If no nodes have been defined yet, the count falls back to a demand-derived estimate:

```
vCPUPerNode      = average vCPU across defined transcoding nodes
                   OR: ceil(socketsPerServer × coresPerSocket / CORES_PER_NODE_TARGET) × HT_factor
                       if no nodes defined

transcodingNodes = defined transcoding nodes × server quantity   (when nodes are defined)
                 = max(1, ceil(vCPURequired / vCPUPerNode))      (fallback estimate)

CORES_PER_NODE_TARGET = 22   (physical cores per node target)
```

**Proxy node count** comes from the Hardware Builder: total Proxying Edge nodes defined across all servers × server quantity. Default sizing: 4 vCPU / 4 GB RAM.

**Management node count** comes from the Hardware Builder: total Management nodes defined. Default sizing: 8 vCPU / 8 GB RAM.

**Proxy node HD demand** (informational, shown in node recommendations):
```
proxyHDDemand = sum(extPts × BACKPLANE_HD_PROXY_PER_CALL × effectiveCount)
BACKPLANE_HD_PROXY_PER_CALL = 0.2 HD per forwarded call
```

This is not added to the transcoding node's HD total — it is proxy node load only.

---

### Step 8 — Bandwidth aggregation

Per-template components from Step 2h are summed into five outputs shown in the Network Bandwidth panel.

**① Meeting bandwidth:**
```
meetingBandwidthMin = sum(bwMeetingMinAll  for all templates)
meetingBandwidthMax = sum(bwMeetingMaxAll  for all templates)
```

**② Inter-node / backplane WAN:**
```
backplaneBandwidthMin = sum(bwBackplaneMinAll  for all templates)
backplaneBandwidthMax = sum(bwBackplaneMaxAll  for all templates)
```
Non-zero only for cross-location meetings.

**③ Proxy / edge forwarded bandwidth:**
```
proxyBandwidthMin = sum(bwProxyMinAll  for all templates)
proxyBandwidthMax = sum(bwProxyMaxAll  for all templates)
```
Non-zero only for templates with external participants (`extPts > 0`).

**④ Per-location totals:**
```
localMin = sum(bwMeetingMinAll    for meetings hosted at location)
localMax = sum(bwMeetingMaxAll    for meetings hosted at location)
wanMin   = sum(bwBackplaneMinAll  for meetings hosted at location)
wanMax   = sum(bwBackplaneMaxAll  for meetings hosted at location)
```

**⑤ Deployment-wide totals:**
```
totalBandwidthMin = meetingBandwidthMin + backplaneBandwidthMin + proxyBandwidthMin
totalBandwidthMax = meetingBandwidthMax + backplaneBandwidthMax + proxyBandwidthMax
```

---

### Step 9 — Topology and routing model

**Meeting Builder independence:** All resource calculations in the Meeting Builder (Steps 2–4) are topology-driven. They do not depend on what nodes have been defined in the hardware section. Backplane activates from the number of topology locations and participant location assignments; proxy bandwidth activates from external participant counts. Each topology location is treated as one distinct transcoding node.

**Routing scenarios:**

| Scenario | Effect |
|---|---|
| Only 1 location defined | Single-node deployment — no backplane for any meeting |
| ≥2 locations defined, all participants at host location | 1 HD base backplane reserved (non-distributed, multi-node) |
| Host at Location A, participants at Location B | `hasCrossLocation = true` → 2 HD backplane (2 nodes) |
| Participants span N additional locations | `(N+1) × 1 HD` backplane |
| External participants | +1 HD proxy boundary; proxy bandwidth tracked from `extPts > 0` |
| Teams gateway meeting | 1.5 HD/call gateway overhead (`hdGateway`) + standard 1 HD/node backplane |
| Google Meet gateway meeting | 1.0 HD/call gateway overhead (`hdGateway`) + standard 1 HD/node backplane |

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

Edit [js/config.js](js/config.js) only. All numeric constants live there.

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
   }
   ```
2. Add an entry to `ENDPOINT_CODEC` (static label or `null` for user-selectable).
3. Add a row to `endpointRows` in `setup()` in [js/app.js](js/app.js).
4. Add a `my_endpoint: 0` key to the `endpointAssignments` object in `addLocation()` so new locations include this type.
5. `rowResults` and `meetingResults` will pick up the new type automatically.

### Adding a new node role to the Hardware Builder

1. Add an entry to `NODE_ROLES_HW` in [js/config.js](js/config.js).
2. Add an `<option>` to the role `<select>` in the Configure Nodes tab in [index.html](index.html).
3. Add vCPU/RAM defaults for the new role in `applyRoleDefaults()` in [js/app.js](js/app.js).
4. Add a `totalDefinedMyRoleNodes` count to `hwAllocationSummary` if the role should appear in the summary strip.
5. Push a row into `nodeRecommendations` and add a `.badge-my-role` CSS class in [css/styles.css](css/styles.css).

### Adding a new gateway meeting type

If a new meeting type requires per-call gateway overhead on the hosting node:

1. Add a constant to [js/config.js](js/config.js): `GATEWAY_HD_PER_CALL_MY_TYPE: X.X`
2. Extend the `gatewayHDPerCall` ternary in `meetingResults` in [js/app.js](js/app.js).
3. If backplane cost differs from 1.0 HD per node, add a `BACKPLANE_HD_MY_TYPE` constant and extend `bpHDPerMeeting`.

### Modifying the calculation pipeline

The pipeline runs inside `setup()` in [js/app.js](js/app.js) as a chain of Vue `computed()` properties:

```
rowResults → meetingResults (per template × count)
  ├─ HD path:        totalHDBeforeBackplane
  │                  → backplaneHD (sum of hdBackplaneAll from meetingResults)
  │                  → totalHDRaw → totalHDWithHeadroom
  │                  → effectiveHDperVcpu → vCPURequired → transcodingNodeCount
  └─ Bandwidth path: meetingBandwidthMin/Max
                     backplaneBandwidthMin/Max   (cross-location meetings)
                     proxyBandwidthMin/Max        (external participants)
                     perLocationBandwidth
                     totalBandwidthMin/Max
```

### What not to do

- **Do not introduce a build step.** GitHub Pages serves static files. Adding webpack, Vite, or any bundler changes the deployment model.
- **Do not add `<script type="module">`.** The plain `<script>` + `window.PEXIP` pattern is intentional.
- **Do not inline constants in `app.js`.** All numbers belong in `config.js`.
- **Do not split `setup()` across files.** Vue's reactivity depends on all `reactive()`, `ref()`, and `computed()` calls being in the same scope.
- **Do not couple Meeting Builder calculations to hardware configuration.** Meeting resource costs (HD, backplane, proxy bandwidth) are topology-driven — they must not read from `totalDefinedTranscodingNodes`, `viaProxy`, or other node-config computeds.
