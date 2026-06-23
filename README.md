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
- What is the per-meeting Teams Adaptive Composition overhead?

The workflow mirrors how Pexip resources are actually consumed:

1. **Define endpoint types** (① Endpoint & Interop Model) — set total count, quality, and codec for each platform (SIP/H.323, Zoom, WebRTC, Teams, Google Meet, Skype for Business). Connection factors and gateway overhead are applied automatically.
2. **Build the topology** (② Deployment Topology Builder) — create locations, add nodes with roles (Transcoding / Proxy / External), and assign how many endpoints of each type sit at each location.
3. **Configure meetings** (③ Meeting Builder) — meeting templates are **auto-generated** from the topology. For every `(location, endpoint type)` combination with assigned endpoints, one template card is created. Each template specifies: participant count and distribution by location (including external), interop target, layout, and presentation. Set the meeting count per template — capped at the endpoint capacity assigned to that location. All resource calculations are driven by these templates.
4. **Configure hardware** (④ Hardware Configuration) — select CPU instruction set, clock speed, hypervisor, and node vCPU size.

The output is a per-location node recommendation table, total vCPU count, per-template HD breakdown, and a five-section network bandwidth model showing minimum and maximum requirements for meeting access, inter-node backplane, proxy forwarding, per-location totals, and deployment-wide totals.

---

## Principles Derived from Pexip

The calculation model is grounded in Pexip's published capacity planning methodology:

- **HD equivalence** — All streams are normalised to a 720p HD unit. Full HD (1080p) costs 2.0 HD; SD costs 0.5 HD; audio costs 0.0625 HD. This reduces heterogeneous endpoint mixes to a single scalar for node sizing.
- **Per-platform connection factors** — Each endpoint type carries a different resource multiplier: SIP/H.323 = 1.0×, Zoom = 1.0×, WebRTC VP8 = 1.0×, WebRTC VP9 = 1.25×, Microsoft Teams = 1.5× (minimum 1.5 HD per connection regardless of quality — Pexip specifies Teams costs 1.5 HD at both SD and HD quality), Google Meet = 1.0×, Skype for Business = 1.0×. These encode codec normalisation, layout adaptation, and gateway leg overhead.
- **VP9 resource trade-off** — VP9 reduces bandwidth by ~33% compared to H.264 at the same resolution, but increases node CPU load by 25% (`VP9_RESOURCE_FACTOR = 1.25`).
- **Teams Adaptive Composition** — When Teams participants are in a meeting using Adaptive/Teams-like layout, an additional HD reservation is made per conference: +1.0 HD for up to 3 on-stage participants, plus +0.5 HD per on-stage participant beyond 3.
- **Template-driven resources** — Resources are consumed only during active conferences. Meeting templates are auto-generated from topology × endpoint assignment. Each template's per-meeting HD/BW cost is computed once and multiplied by the template's meeting count to produce aggregate totals.
- **Layout-driven video participant limits** — Each layout has a maximum number of participants that are actively composited into the video mix. Participants beyond that limit are treated as audio-only for HD resource calculation (0.0625 HD × connFactor), reducing the node resource they consume. The limits by category: Adaptive Composition (12); Speaker-Focused: 1+0 (1), 1+1 (2), 1+7 (8), 1+21 (22), 2+21 (23), 1+33 (34); Equal Grid: 2×2 (4), 3×3 (9), 4×4 (16), 5×5 (25).
- **Layout-aware backplane overhead** — Meetings whose participants span multiple topology locations incur inter-node bandwidth cost. The number of HD and thumbnail streams crossing nodes is driven by the selected layout. Each HD stream costs 1.6–4 Mbps; each thumbnail costs 64–192 kbps. An active presentation adds a further 1.6 Mbps to backplane traffic. See Step 2g for the full per-layout stream count table.
- **Proxy node routing (external participants)** — External participants (those with no assigned topology location) route through proxy/edge nodes. Proxy nodes forward media packets to transcoding nodes without performing transcoding, so external participants consume the same transcoding HD as internal ones. The presence of proxy or external nodes in the topology enables proxy bandwidth tracking: the external proportion within each template determines how much access bandwidth is also forwarded through the proxy link and reported as a separate bandwidth component.
- **Endpoint-aware meeting limits** — A template's meeting count cannot exceed the number of endpoints of that type assigned to that location. E.g. 100 Zoom endpoints assigned to East → at most 100 `[East / Zoom]` meetings.
- **Presentation overhead** — Toggled per meeting template. Adds per-participant HD overhead for endpoint types that support dual-stream: WebRTC +1.0 HD/pt, Teams +0.5 HD/pt, Google Meet +1.0 HD/pt, Skype for Business +1.0 HD/pt.
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
weight       = QUALITY_WEIGHTS[quality]     { 'sd': 0.5, '720p': 1.0, '1080p': 2.0, 'audio': 0.0625 }
codecFactor  = 1.25  if codec === 'vp9'  else  1.0
connFactor   = ENDPOINT_TYPES[type].connectionFactor
rawHdPerPt   = weight × connFactor × codecFactor
hdPerPt      = max(ENDPOINT_TYPES[type].minConnectionHD, rawHdPerPt)   if minConnectionHD is defined
               else rawHdPerPt

bwPerStream  = BANDWIDTH_TABLE[quality + '-' + codec]
```

**Per-platform connection factors:**

| Endpoint | `connectionFactor` | Default codec | Presentation overhead |
|---|---|---|---|
| SIP / H.323 | 1.0 | H.264 | — |
| Zoom | 1.0 | H.264 | — |
| WebRTC | 1.0 (VP8) / 1.25 (VP9) via `codecFactor` | VP8 or VP9 | +1.0 HD/participant |
| Microsoft Teams | 1.5 (min 1.5 HD/connection) | MS / H.264 | +0.5 HD/participant |
| Google Meet | 1.0 | VP8 | +1.0 HD/participant |
| Skype for Business | 1.0 | H.264 | +1.0 HD/participant |

---

### Step 2 — Per-template resource calculation (`meetingResults`)

This is the core of the pipeline. For each auto-generated template in the Meeting Builder, one set of per-meeting HD/BW values is computed and then multiplied by the template's effective meeting count to produce aggregate totals.

**Inputs:** `tmpl.participantCounts{}` (location → count, including `'external'`), `tmpl.endpointType` (originating endpoint), `tmpl.interopTarget` (optional gateway leg), `tmpl.layout`, `tmpl.presentationActive`, `tmpl.meetingCount`, `endpointRows[]` (for quality/codec).

**2a — Participant totals and external proportion:**
```
totalPts       = sum(participantCounts[*])
extPts         = participantCounts['external']
extProportion  = extPts / totalPts        (0.0 if no participants)
```

**2b — Cross-location detection:**
```
locIdsWithPts  = set of non-external location IDs with count > 0
nonHostLocs    = locIdsWithPts excluding template's locationId (host)

hasCrossLocation = true  if:
  - locIdsWithPts.size > 1, OR
  - host location is set but not in locIdsWithPts, OR
  - host location is null and locIdsWithPts is non-empty

crossLocationCount = max(0, nonHostLocs.length)
```

**2c — Participant endpoints:**
```
participantEndpoints[endpointType]  = totalPts   (all participants use origin type)
participantEndpoints[interopTarget] += 1          (one gateway leg, if interopTarget is set
                                                   and differs from endpointType)
```

**2d — HD per endpoint type:**

Layout video limits are applied first to determine how many participants are video-visible vs. audio-only:
```
maxVideoPts   = LAYOUTS[layout].maxVideoParticipants   (null = no limit)
audioOverflow = max(0, totalPts − maxVideoPts)          (0 if no limit)
videoFraction = min(1, maxVideoPts / totalPts)          (1.0 if no limit or totalPts = 0)
```

For each type T with `typeCount = participantEndpoints[T] > 0`:
```
weight        = QUALITY_WEIGHTS[endpointRows[T].quality]
codecFactor   = 1.25 if endpointRows[T].codec === 'vp9' else 1.0
connFactor    = ENDPOINT_TYPES[T].connectionFactor
rawBase       = weight × connFactor × codecFactor
base          = max(ENDPOINT_TYPES[T].minConnectionHD, rawBase)   if minConnectionHD is defined
                else rawBase

typeVideoCount = round(typeCount × videoFraction)
typeAudioCount = typeCount − typeVideoCount

audioBase     = QUALITY_WEIGHTS.audio × connFactor   (no VP9 factor or minConnectionHD for overflow)

hdT           = typeVideoCount × base + typeAudioCount × audioBase

hdPresentation_T = typeCount × ENDPOINT_TYPES[T].presentationHD
                   if (ENDPOINT_TYPES[T].presentationExtra && presentationActive)
                   else 0
```

Presentation overhead applies to all participants regardless of layout visibility — the content stream is delivered to every participant in the call. External participants consume the same transcoding HD as internal ones; proxy routing is accounted for in the bandwidth model (Step 2g) only.

**2e — Teams Adaptive Composition (per meeting):**
```
teamsInMeeting = participantEndpoints['teams']

hdComposition = 0  if layout !== 'adaptive' or teamsInMeeting === 0
hdComposition = TEAMS_COMPOSITION_HD_BASE
                + max(0, teamsInMeeting − 3) × TEAMS_COMPOSITION_HD_ONSTAGE
                otherwise

where:
  TEAMS_COMPOSITION_HD_BASE    = 1.0 HD   (≤3 on-stage)
  TEAMS_COMPOSITION_HD_ONSTAGE = 0.5 HD   (each on-stage beyond 3)
```

**2f — Per-meeting HD total and aggregate:**
```
hdTotal        = sum(hdT for all types) + sum(hdPresentation_T) + hdComposition
effectiveCount = min(meetingCount, loc.endpointAssignments[endpointType])

hdTotalAll         = hdTotal × effectiveCount
hdEndpointsAll     = hdEndpoints × effectiveCount
hdPresentationAll  = hdPresentation × effectiveCount
hdCompositionAll   = hdComposition × effectiveCount
```

**Example:** Template `[East / Teams]`, 10 participants (7 East, 3 external), proxy nodes in topology, presentation on, 1+7 layout (max 8 video), 720p quality, 50 meetings:
```
maxVideoPts    = 8   (1+7 layout limit)
audioOverflow  = max(0, 10 − 8) = 2 participants treated as audio-only
videoFraction  = 8 / 10 = 0.80

rawBase        = 1.0 × 1.5 × 1.0 = 1.5 HD
base           = max(1.5, 1.5) = 1.5 HD   (Teams minConnectionHD floor, matches at 720p)
audioBase      = 0.0625 × 1.5 = 0.09375 HD   (audio quality weight × Teams connFactor)

typeVideoCount = round(10 × 0.80) = 8
typeAudioCount = 10 − 8 = 2

hdEndpoints    = 8 × 1.5 + 2 × 0.09375 = 12.0 + 0.1875 ≈ 12.19 HD
hdPresentation = 10 × 0.5 = 5.0 HD   (all participants receive the content stream)
hdComposition  = 0   (layout is '1+7', not 'adaptive')

hdTotal        = 12.19 + 5.0 + 0 = 17.19 HD  (per meeting)
hdTotalAll     = 17.19 × 50 = 859.5 HD  (aggregate for this template)
```

**2g — Bandwidth per meeting (min / max range):**

Access bandwidth is computed as a min–max range. The minimum uses the standard bitrate from `BANDWIDTH_TABLE`; the maximum uses `BANDWIDTH_TABLE_MAX`, capped at `PARTICIPANT_MAX_KBPS = 6000 kbps` per participant.

```
bwKey     = quality + '-' + codec
bwMin     = BANDWIDTH_TABLE[bwKey]
bwMax     = min(PARTICIPANT_MAX_KBPS, BANDWIDTH_TABLE_MAX[bwKey])

bwAccessMin += typeCount × bwMin   (summed across all endpoint types in meeting)
bwAccessMax += typeCount × bwMax

bwAudioMin  = totalPts × AUDIO_MIN_KBPS    (8 kbps/participant)
bwAudioMax  = totalPts × AUDIO_MAX_KBPS    (64 kbps/participant)
```

**Presentation stream (if `presentationActive` and participants > 0):**
```
pBw              = PRESENTATION_BW[endpointType] ?? PRESENTATION_BW.default
bwPresentationMin = pBw.min
bwPresentationMax = pBw.max
```

| Endpoint type | Presentation min | Presentation max | Notes |
|---|---|---|---|
| Teams | 2,400 kbps | 2,400 kbps | Always Full HD; fixed |
| Google Meet | 960 kbps | 2,000 kbps | Separate call stream; capped |
| All others | 960 kbps | 2,400 kbps | Up to 75% of call bandwidth |

**Inter-node backplane bandwidth (cross-location meetings only):**

Stream counts per layout drive the backplane range. Only applied when `hasCrossLocation && transcodingNodes > 1`.

```
lp = LAYOUTS[layout].backplane
bwBackplaneMin = lp.hd × BACKPLANE_HD_MIN_KBPS + lp.thumb × BACKPLANE_THUMB_MIN_KBPS
bwBackplaneMax = lp.hd × BACKPLANE_HD_MAX_KBPS + lp.thumb × BACKPLANE_THUMB_MAX_KBPS

if presentationActive:
  bwBackplaneMin += BACKPLANE_PRESENTATION_KBPS   (1,600 kbps)
  bwBackplaneMax += BACKPLANE_PRESENTATION_KBPS
```

**A. Adaptive / Teams-like**

| Layout | Max video | HD streams | Thumbnail streams | Backplane min | Backplane max |
|---|---|---|---|---|---|
| Adaptive Composition | 12 | 13 | 0 | 20,800 kbps | 52,000 kbps |

**B. Speaker-Focused**

| Layout | Max video | HD streams | Thumbnail streams | Backplane min | Backplane max |
|---|---|---|---|---|---|
| 1+0 | 1 | 1 | 0 | 1,600 kbps | 4,000 kbps |
| 1+1 | 2 | 2 | 0 | 3,200 kbps | 8,000 kbps |
| 1+7 | 8 | 2 | 7 | 3,648 kbps | 9,344 kbps |
| 1+21 | 22 | 2 | 21 | 4,544 kbps | 12,032 kbps |
| 2+21 | 23 | 2 | 21 | 4,544 kbps | 12,032 kbps |
| 1+33 | 34 | 2 | 33 | 5,312 kbps | 14,336 kbps |

**C. Equal Grid**

| Layout | Max video | HD streams | Thumbnail streams | Backplane min | Backplane max |
|---|---|---|---|---|---|
| 2×2 | 4 | 4 | 0 | 6,400 kbps | 16,000 kbps |
| 3×3 | 9 | 9 | 0 | 14,400 kbps | 36,000 kbps |
| 4×4 | 16 | 16 | 0 | 25,600 kbps | 64,000 kbps |
| 5×5 | 25 | 25 | 0 | 40,000 kbps | 100,000 kbps |

Constants: `BACKPLANE_HD_MIN/MAX_KBPS = 1600/4000`; `BACKPLANE_THUMB_MIN/MAX_KBPS = 64/192`.

**Proxy-forwarded bandwidth (external participants + proxy nodes defined):**
```
bwProxyMin = round(bwAccessMin × extProportion)   if viaProxy and extPts > 0
bwProxyMax = round(bwAccessMax × extProportion)
```

**Per-meeting total:**
```
bwMeetingMin = bwAccessMin + bwAudioMin + bwPresentationMin
bwMeetingMax = bwAccessMax + bwAudioMax + bwPresentationMax

bwMeetingMinAll   = bwMeetingMin   × effectiveCount
bwMeetingMaxAll   = bwMeetingMax   × effectiveCount
bwBackplaneMinAll = bwBackplaneMin × effectiveCount
bwBackplaneMaxAll = bwBackplaneMax × effectiveCount
bwProxyMinAll     = bwProxyMin     × effectiveCount
bwProxyMaxAll     = bwProxyMax     × effectiveCount
```

**Bandwidth lookup tables (kbps per stream, video only):**

Minimum (`BANDWIDTH_TABLE`):

| Resolution | H.264 | VP8 | VP9 |
|---|---|---|---|
| 1080p | 2,400 | 2,400 | 1,600 |
| 720p | 960 | 960 | 640 |
| SD | 448 | 448 | 448 |
| Audio | 64 | 64 | 64 |

Maximum (`BANDWIDTH_TABLE_MAX`):

| Resolution | H.264 | VP8 | VP9 |
|---|---|---|---|
| 1080p | 4,000 | 4,000 | 2,800 |
| 720p | 2,000 | 2,000 | 1,400 |
| SD | 960 | 960 | 960 |
| Audio | 64 | 64 | 64 |

---

### Step 3 — Total HD before backplane

```
totalHDBeforeBackplane = sum(hdTotalAll  for all templates)
```

Composition overhead is already embedded in each template's `hdTotal` from Step 2.

---

### Step 4 — Backplane overhead

Backplane is detected per template from participant location inputs. A template incurs backplane cost only when its participants span multiple topology locations.

Per Pexip's resource allocation rules, every transcoding node that hosts a conference — including the host node itself — reserves one backplane connection at the meeting's maximum call quality. The quality weight scales this reservation the same way it scales participant HD.

**Inputs:** `meetingResults[]`, `totalDefinedTranscodingNodes`.

```
backplaneHD = 0   if totalDefinedTranscodingNodes ≤ 1

otherwise:
backplaneHD = sum over templates where hasCrossLocation:
                (crossLocationCount + 1) × BACKPLANE_HD_PER_MEETING × meetingQualityWeight × effectiveCount

where:
  BACKPLANE_HD_PER_MEETING = 1.0 HD   (base unit at 720p)
  meetingQualityWeight     = QUALITY_WEIGHTS[meeting endpoint quality]
                           { 'sd': 0.5, '720p': 1.0, '1080p': 2.0, 'audio': 0.0625 }
  crossLocationCount + 1   = total participating transcoding locations
                             (non-host locations + the host location)
```

| Meeting scenario | Backplane contribution (per meeting, 720p) |
|---|---|
| All participants in host location | 0 HD |
| Participants from 1 additional location | +2.0 HD (host node + 1 remote node) |
| Participants from 2 additional locations | +3.0 HD (host node + 2 remote nodes) |
| No host location set, any non-external participants | +(N+1) HD (N = distinct location count) |
| Same meeting at 1080p quality | ×2.0 applied to all figures above |

**Example:** Template A — East + West participants (720p, 1 cross-location link), 20 meetings. Template B — East-only, 50 meetings. Template C — East + West + South (1080p, 2 cross-location links), 10 meetings:
```
backplaneHD = ((1+1) × 1.0 × 1.0 × 20) + 0 + ((2+1) × 1.0 × 2.0 × 10)
            = (2 × 20) + 0 + (3 × 2.0 × 10)
            = 40.0 + 0 + 60.0 = 100.0 HD
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

### Step 8 — Bandwidth aggregation

Per-template bandwidth components from Step 2g are summed into five outputs that map directly to the five sections of the Network Bandwidth panel.

**① Meeting bandwidth (participant access + audio + presentation):**
```
meetingBandwidthMin = sum(bwMeetingMinAll  for all templates)
meetingBandwidthMax = sum(bwMeetingMaxAll  for all templates)
```

**② Inter-node / backplane WAN:**
```
backplaneBandwidthMin = sum(bwBackplaneMinAll  for all templates)
backplaneBandwidthMax = sum(bwBackplaneMaxAll  for all templates)
```
Only templates where `hasCrossLocation && transcodingNodes > 1` contribute non-zero values.

**③ Proxy / edge forwarded bandwidth:**
```
proxyBandwidthMin = sum(bwProxyMinAll  for all templates)
proxyBandwidthMax = sum(bwProxyMaxAll  for all templates)
```
Only applies when proxy or external nodes exist in the topology (`viaProxy = true`) and the template has external participants.

**④ Per-location totals:**

For each topology location, meetings hosted at that location are aggregated:
```
localMin = sum(bwMeetingMinAll    for meetings where locationId === loc.id)
localMax = sum(bwMeetingMaxAll    for meetings where locationId === loc.id)
wanMin   = sum(bwBackplaneMinAll  for meetings where locationId === loc.id)
wanMax   = sum(bwBackplaneMaxAll  for meetings where locationId === loc.id)
```
Locations with no hosted meetings are excluded from the table.

**⑤ Deployment-wide totals:**
```
totalBandwidthMin = meetingBandwidthMin + backplaneBandwidthMin + proxyBandwidthMin
totalBandwidthMax = meetingBandwidthMax + backplaneBandwidthMax + proxyBandwidthMax
```

These are the figures shown in the summary bar as a min–max range.

---

### Step 9 — Topology and routing model

Three topology features drive routing accuracy:

**Topology Builder — nodes:** Defines where transcoding capacity sits (`transcodingLocations`), whether proxy bandwidth tracking is active (`viaProxy = proxyNodes + externalNodes > 0`), and the backplane factor (number of transcoding locations).

**Topology Builder — endpoint assignment:** Each location has an Endpoints sub-section showing how many of each defined endpoint type are assigned there. This drives two things: (1) it shows a `remaining/total` counter per type and warns when endpoints are not fully assigned; (2) it gates which meeting templates are auto-generated and caps each template's meeting count.

**Meeting Builder — templates:** Each auto-generated template has a fixed host location and originating endpoint type. The participant distribution across locations (including external) drives cross-location detection and proxy doubling per template.

| Routing scenario | Effect |
|---|---|
| All participants at host location | No backplane cost |
| Participants from other topology locations | `(crossLocationCount + 1) × qualityWeight` HD added to backplane per meeting |
| External participants + proxy nodes defined | Proxy bandwidth tracked separately; transcoding HD is unchanged |
| No proxy nodes defined | External participants treated identically to internal for resource calculation |

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
4. Add a `my_endpoint: 0` key to the `endpointAssignments` object in `addLocation()` in [js/app.js](js/app.js) so new locations include this type in their assignment tracker.
5. `rowResults` and `meetingResults` will pick up the new type automatically — and new meeting templates for `[location / My Endpoint]` will be auto-generated once endpoints are assigned.

### Adding a new node role to the Topology Builder

1. Add an entry to `NODE_ROLES` in [js/config.js](js/config.js).
2. Add an `<option>` to the role `<select>` in the location nodes section of [index.html](index.html).
3. Add a `totalDefinedMyRoleNodes` computed in [js/app.js](js/app.js) alongside the existing proxy/external computeds.
4. Decide whether the role triggers proxy doubling — if yes, include it in the `viaProxy` computed.
5. Push a row into `nodeRecommendations` and add a `.badge-my-role` CSS class in [css/styles.css](css/styles.css).

### Modifying per-meeting template fields

Meeting templates are auto-generated objects in `meetingTemplates`. To add a new per-template field:

1. Add the field and its default value to the object pushed in the `watch(autoTemplateKeys, ...)` reconciliation block in [js/app.js](js/app.js).
2. Add the corresponding input control to the template card in [index.html](index.html).
3. Reference the field inside `meetingResults` to incorporate it into the HD calculation.

### Adding a new CPU instruction set

Add an entry to `CPU_EFFICIENCY_TABLE` in [js/config.js](js/config.js) and expose it in the `EFFICIENCY_BASE` object in `setup()` in [js/app.js](js/app.js) so the template can display it.

### Modifying the calculation pipeline

The pipeline runs inside `setup()` in [js/app.js](js/app.js) as a chain of Vue `computed()` properties. Key computeds in order:

```
rowResults → meetingResults (per template × count)
  ├─ HD path:        totalHDBeforeBackplane → backplaneHD → totalHDRaw
  │                  → totalHDWithHeadroom → effectiveHDperVcpu
  │                  → vCPURequired → transcodingNodeCount
  └─ Bandwidth path: meetingBandwidthMin/Max
                     backplaneBandwidthMin/Max   (layout-aware, cross-location)
                     proxyBandwidthMin/Max        (external participants only)
                     perLocationBandwidth         (aggregated per host location)
                     totalBandwidthMin/Max        (deployment-wide)
```

When inserting a new step, update all downstream `computed()` references to use the new intermediate value and verify the chain with a hand-calculated example.

### What not to do

- **Do not introduce a build step.** GitHub Pages serves static files. Adding webpack, Vite, or any bundler changes the deployment model.
- **Do not add `<script type="module">`.** The plain `<script>` + `window.PEXIP` pattern is intentional. ES modules break the global-variable handoff without a bundler.
- **Do not inline constants in `app.js`.** Keeping all numbers in `config.js` makes auditing safe without touching computation logic.
- **Do not split `setup()` across files.** Vue's reactivity depends on all `reactive()`, `ref()`, and `computed()` calls being in the same scope.
