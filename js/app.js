// Pexip Resource & Capacity Calculator — Vue 3 app (plain script, no build step)
// Depends on: window.PEXIP (config.js loaded first), window.Vue (CDN)

(function () {
  'use strict';

  const C = window.PEXIP; // shorthand alias
  const { createApp, reactive, computed, ref, watch } = Vue;

  // ── helpers ────────────────────────────────────────────────────────────────

  function fmtHD(n) {
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function fmtKbps(kbps) {
    if (kbps >= 1000000000) return (kbps / 1000000000).toFixed(2) + ' Tbps';
    if (kbps >= 1000000)    return (kbps / 1000000).toFixed(2) + ' Gbps';
    if (kbps >= 1000)       return (kbps / 1000).toFixed(2) + ' Mbps';
    return Math.round(kbps) + ' kbps';
  }

  function fmtRange(min, max) {
    if (!min && !max) return '0 kbps';
    if (min === max)  return fmtKbps(min);
    return fmtKbps(min) + ' – ' + fmtKbps(max);
  }

  // ── app ───────────────────────────────────────────────────────────────────

  createApp({
    setup() {

      // ── endpoint & interop model ──────────────────────────────────────────
      // count = total defined endpoints of this type (internal to the deployment)
      const endpointRows = reactive([
        { type: 'sip_h323',           count: 0, quality: '1080p', codec: 'h264' },
        { type: 'zoom',               count: 0, quality: '1080p', codec: 'h264' },
        { type: 'webrtc',             count: 0, quality: '1080p', codec: 'vp8'  },
        { type: 'teams',              count: 0, quality: '1080p', codec: 'h264' },
        { type: 'google_meet',        count: 0, quality: '1080p', codec: 'vp8'  },
        { type: 'skype_for_business', count: 0, quality: '1080p', codec: 'h264' },
      ]);

      // ── topology — deployment topology builder ────────────────────────────
      const locations = reactive([]);

      function addLocation() {
        locations.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          name: '',
          description: '',
          nodes: [],
          expanded: true,
          endpointsExpanded: false,
          endpointAssignments: {
            sip_h323: 0, zoom: 0, webrtc: 0,
            teams: 0, google_meet: 0, skype_for_business: 0,
          },
        });
      }
      function removeLocation(id) {
        const idx = locations.findIndex(l => l.id === id);
        if (idx !== -1) locations.splice(idx, 1);
      }
      function addNodeToLocation(locationId) {
        const loc = locations.find(l => l.id === locationId);
        if (loc) loc.nodes.push({ id: Date.now() + Math.floor(Math.random() * 1000), name: '', role: 'transcoding' });
      }
      function removeNodeFromLocation(locationId, nodeId) {
        const loc = locations.find(l => l.id === locationId);
        if (loc) {
          const idx = loc.nodes.findIndex(n => n.id === nodeId);
          if (idx !== -1) loc.nodes.splice(idx, 1);
        }
      }
      function toggleLocation(id) {
        const loc = locations.find(l => l.id === id);
        if (loc) loc.expanded = !loc.expanded;
      }
      function toggleLocationEndpoints(id) {
        const loc = locations.find(l => l.id === id);
        if (loc) loc.endpointsExpanded = !loc.endpointsExpanded;
      }

      // Derived topology state
      const allNodes                     = computed(() => locations.flatMap(l => l.nodes));
      const totalDefinedTranscodingNodes = computed(() => allNodes.value.filter(n => n.role === 'transcoding').length);
      const totalDefinedProxyNodes       = computed(() => allNodes.value.filter(n => n.role === 'proxy').length);
      const totalDefinedExternalNodes    = computed(() => allNodes.value.filter(n => n.role === 'external').length);
      const transcodingLocations         = computed(() => locations.filter(l => l.nodes.some(n => n.role === 'transcoding')));
      const numberOfTranscodingLocations = computed(() => transcodingLocations.value.length);
      const viaProxy                     = computed(() => totalDefinedProxyNodes.value > 0 || totalDefinedExternalNodes.value > 0);

      const topologyMode = computed(() => {
        if (locations.length === 0) return 'unconfigured';
        if (totalDefinedTranscodingNodes.value === 0) return 'no_transcoding';
        if (totalDefinedTranscodingNodes.value === 1 && numberOfTranscodingLocations.value <= 1) return 'single_node';
        if (numberOfTranscodingLocations.value <= 1) return 'single_site';
        return 'multi_site';
      });

      // Endpoint assignment tracking
      const totalEndpointCounts = computed(() =>
        Object.fromEntries(endpointRows.map(r => [r.type, Number(r.count) || 0]))
      );
      const assignedEndpointCounts = computed(() => {
        const acc = Object.fromEntries(endpointRows.map(r => [r.type, 0]));
        locations.forEach(loc => {
          if (loc.endpointAssignments) {
            Object.keys(acc).forEach(t => {
              acc[t] += Number(loc.endpointAssignments[t]) || 0;
            });
          }
        });
        return acc;
      });
      const unassignedEndpointCounts = computed(() =>
        Object.fromEntries(endpointRows.map(r => [
          r.type,
          Math.max(0, (totalEndpointCounts.value[r.type] || 0) - (assignedEndpointCounts.value[r.type] || 0)),
        ]))
      );
      const allEndpointsAssigned = computed(() =>
        endpointRows.every(r => !r.count || (unassignedEndpointCounts.value[r.type] || 0) === 0)
      );

      // ── meeting builder — template-based auto-generation ──────────────────
      const meetingTemplates = reactive([]);

      // Returns the endpoint capacity ceiling for a template (can't exceed assigned endpoints)
      function maxCountForTemplate(tmpl) {
        const loc = locations.find(l => l.id === tmpl.locationId);
        if (!loc) return 0;
        return Number(loc.endpointAssignments[tmpl.endpointType]) || 0;
      }

      function effectiveCountForTemplate(tmpl) {
        return Math.min(Number(tmpl.meetingCount) || 0, maxCountForTemplate(tmpl));
      }

      // Derive the set of (location × endpointType) combos that should have templates
      const autoTemplateKeys = computed(() => {
        const keys = [];
        locations.forEach(loc => {
          Object.entries(loc.endpointAssignments || {}).forEach(([type, count]) => {
            if (Number(count) > 0) {
              keys.push({ locationId: loc.id, endpointType: type });
            }
          });
        });
        return keys;
      });

      // Reconcile meetingTemplates whenever the desired set changes
      watch(
        () => autoTemplateKeys.value,
        (newKeys) => {
          const desiredSet = new Set(newKeys.map(k => k.locationId + '|' + k.endpointType));

          // Remove templates whose (location, endpointType) combo no longer exists
          for (let i = meetingTemplates.length - 1; i >= 0; i--) {
            const t = meetingTemplates[i];
            if (!desiredSet.has(t.locationId + '|' + t.endpointType)) {
              meetingTemplates.splice(i, 1);
            }
          }

          // Add templates for new combos (preserve existing config)
          newKeys.forEach(k => {
            const existing = meetingTemplates.find(
              t => t.locationId === k.locationId && t.endpointType === k.endpointType
            );
            if (!existing) {
              // Pre-populate participantCounts with all current locations set to 0
              const participantCounts = { external: 0 };
              locations.forEach(loc => { participantCounts[loc.id] = 0; });

              meetingTemplates.push({
                id: k.locationId + '-' + k.endpointType,
                locationId: k.locationId,
                endpointType: k.endpointType,
                meetingCount: 1,
                participantCounts,
                interopTarget: null,
                layout: '1+7',
                presentationActive: false,
                expanded: false,
              });
            }
          });
        },
        { deep: true, immediate: true }
      );

      // ── hardware ──────────────────────────────────────────────────────────
      const cpuInstructionSet = ref('avx2');
      const cpuClockGhz       = ref(3.0);
      const cpuCoresPerSocket = ref(16);
      const nodeVcpuSize      = ref(32);
      const hyperthreading    = ref(false);
      const hypervisor        = ref('vmware');

      // ── endpoint reference data (display only — HD/participant) ───────────
      const rowResults = computed(() =>
        endpointRows.map(row => {
          const def         = C.ENDPOINT_TYPES[row.type] ?? {};
          const weight      = C.QUALITY_WEIGHTS[row.quality] ?? 1.0;
          const codecFactor = row.codec === 'vp9' ? C.VP9_RESOURCE_FACTOR : 1.0;
          const connFactor  = def.connectionFactor ?? 1.0;
          const rawHdPerPt  = weight * connFactor * codecFactor;
          const hdPerPt     = def.minConnectionHD != null ? Math.max(def.minConnectionHD, rawHdPerPt) : rawHdPerPt;
          const bwKey       = row.quality + '-' + row.codec;
          const bwFallback  = row.quality + '-h264';
          const bwPerStream = C.BANDWIDTH_TABLE[bwKey] ?? C.BANDWIDTH_TABLE[bwFallback] ?? 0;
          return { type: row.type, count: Number(row.count) || 0, hdPerPt, bwPerStream,
                   quality: row.quality, codec: row.codec };
        })
      );

      // ── interop flags ─────────────────────────────────────────────────────
      const hasInterop = computed(() =>
        endpointRows.some(r => (Number(r.count)) > 0
          && ['teams', 'google_meet', 'skype_for_business'].includes(r.type))
      );
      // ── per-template resource calculation ─────────────────────────────────
      // Each template represents N identical meetings; we compute per-meeting HD/BW
      // once and multiply by the effective count for aggregate totals.
      const meetingResults = computed(() =>
        meetingTemplates.map(tmpl => {
          const effectiveCount = effectiveCountForTemplate(tmpl);

          // Quality weight of this meeting's host endpoint type — used for backplane reservation scaling
          const hostRow              = endpointRows.find(r => r.type === tmpl.endpointType);
          const meetingQualityWeight = C.QUALITY_WEIGHTS[hostRow?.quality ?? '720p'] ?? 1.0;

          // Total participants per meeting derived from participantCounts
          const totalPts = Object.values(tmpl.participantCounts)
            .reduce((a, c) => a + (Number(c) || 0), 0);
          const extPts = Number(tmpl.participantCounts.external) || 0;
          const extProportion = totalPts > 0 ? extPts / totalPts : 0;

          // Cross-location detection
          const locIdsWithPts = new Set(
            Object.entries(tmpl.participantCounts)
              .filter(([locId, count]) => locId !== 'external' && (Number(count) || 0) > 0)
              .map(([locId]) => locId)
          );
          const hostId = tmpl.locationId;
          const nonHostLocs = hostId
            ? [...locIdsWithPts].filter(id => id !== hostId)
            : [...locIdsWithPts];
          const hasCrossLocation = locIdsWithPts.size > 1
            || (hostId && locIdsWithPts.size === 1 && !locIdsWithPts.has(hostId))
            || (!hostId && locIdsWithPts.size >= 1);
          const crossLocationCount = Math.max(0, nonHostLocs.length);

          // Build participantEndpoints: origin type = all participants,
          // interop target = 1 gateway leg (if set and different from origin)
          const participantEndpoints = {};
          endpointRows.forEach(row => { participantEndpoints[row.type] = 0; });
          participantEndpoints[tmpl.endpointType] = (participantEndpoints[tmpl.endpointType] || 0) + totalPts;
          if (tmpl.interopTarget && tmpl.interopTarget !== tmpl.endpointType && totalPts > 0) {
            participantEndpoints[tmpl.interopTarget] = (participantEndpoints[tmpl.interopTarget] || 0) + 1;
          }

          // Layout-aware video/audio split:
          // Participants beyond the layout's max visible slots are counted as audio-only.
          const layoutDef      = C.LAYOUTS[tmpl.layout];
          const maxVideoPts    = layoutDef?.maxVideoParticipants ?? null;
          const audioOverflow  = maxVideoPts !== null ? Math.max(0, totalPts - maxVideoPts) : 0;
          const videoFraction  = (maxVideoPts !== null && totalPts > 0)
            ? Math.min(1, maxVideoPts / totalPts)
            : 1;

          // HD & access bandwidth per endpoint type
          let hdEndpoints = 0, hdPresentation = 0;
          let bwAccessMin = 0, bwAccessMax = 0;

          endpointRows.forEach(row => {
            const typeCount = Number(participantEndpoints[row.type]) || 0;
            if (!typeCount) return;
            const def         = C.ENDPOINT_TYPES[row.type] ?? {};
            const weight      = C.QUALITY_WEIGHTS[row.quality] ?? 1.0;
            const codecFactor = row.codec === 'vp9' ? C.VP9_RESOURCE_FACTOR : 1.0;
            const connFactor  = def.connectionFactor ?? 1.0;
            const rawBase     = weight * connFactor * codecFactor;
            const base        = def.minConnectionHD != null ? Math.max(def.minConnectionHD, rawBase) : rawBase;

            // Split this type's participants proportionally into video-visible and audio-overflow
            const typeVideoCount = Math.round(typeCount * videoFraction);
            const typeAudioCount = typeCount - typeVideoCount;
            // Audio-overflow participants: audio quality weight only, connFactor still applies, no VP9/min floor
            const audioBase      = C.QUALITY_WEIGHTS.audio * connFactor;
            hdEndpoints += typeVideoCount * base + typeAudioCount * audioBase;

            if (def.presentationExtra && tmpl.presentationActive) {
              hdPresentation += typeCount * (def.presentationHD ?? 1.0);
            }

            const bwKey      = row.quality + '-' + row.codec;
            const bwFallback = row.quality + '-h264';
            const bwMin      = C.BANDWIDTH_TABLE[bwKey]     ?? C.BANDWIDTH_TABLE[bwFallback]     ?? 0;
            const bwMax      = Math.min(C.PARTICIPANT_MAX_KBPS,
              C.BANDWIDTH_TABLE_MAX[bwKey] ?? C.BANDWIDTH_TABLE_MAX[bwFallback] ?? bwMin);
            bwAccessMin += typeCount * bwMin;
            bwAccessMax += typeCount * bwMax;
          });

          // Audio overhead per participant
          const bwAudioMin = totalPts * C.AUDIO_MIN_KBPS;
          const bwAudioMax = totalPts * C.AUDIO_MAX_KBPS;

          // Presentation stream bandwidth (single stream added when presentation is active)
          let bwPresentationMin = 0, bwPresentationMax = 0;
          if (tmpl.presentationActive && totalPts > 0) {
            const pBw = C.PRESENTATION_BW[tmpl.endpointType] ?? C.PRESENTATION_BW.default;
            bwPresentationMin = pBw.min;
            bwPresentationMax = pBw.max;
          }

          // Inter-node backplane bandwidth — layout-aware, cross-location meetings only
          let bwBackplaneMin = 0, bwBackplaneMax = 0;
          if (hasCrossLocation && totalDefinedTranscodingNodes.value > 1) {
            const lp = C.LAYOUTS[tmpl.layout]?.backplane ?? { hd: 1, thumb: 0 };
            bwBackplaneMin = lp.hd * C.BACKPLANE_HD_MIN_KBPS + lp.thumb * C.BACKPLANE_THUMB_MIN_KBPS;
            bwBackplaneMax = lp.hd * C.BACKPLANE_HD_MAX_KBPS + lp.thumb * C.BACKPLANE_THUMB_MAX_KBPS;
            if (tmpl.presentationActive) {
              bwBackplaneMin += C.BACKPLANE_PRESENTATION_KBPS;
              bwBackplaneMax += C.BACKPLANE_PRESENTATION_KBPS;
            }
          }

          // Proxy-forwarded bandwidth: external participant media traverses proxy → transcoding
          const bwProxyMin = (viaProxy.value && extPts > 0)
            ? Math.round(bwAccessMin * extProportion) : 0;
          const bwProxyMax = (viaProxy.value && extPts > 0)
            ? Math.round(bwAccessMax * extProportion) : 0;

          // Meeting bandwidth total (access + audio + presentation per meeting × count)
          const bwMeetingMin = bwAccessMin + bwAudioMin + bwPresentationMin;
          const bwMeetingMax = bwAccessMax + bwAudioMax + bwPresentationMax;

          // Adaptive Composition overhead per meeting (layout-driven).
          // Applies to all participants visible in the adaptive layout, not just Teams connections.
          let hdComposition = 0;
          const videoVisiblePts = maxVideoPts !== null ? Math.min(totalPts, maxVideoPts) : totalPts;
          if (tmpl.layout === 'adaptive' && videoVisiblePts > 0) {
            hdComposition = C.TEAMS_COMPOSITION_HD_BASE
              + Math.max(0, videoVisiblePts - 3) * C.TEAMS_COMPOSITION_HD_ONSTAGE;
          }

          const hdTotal = hdEndpoints + hdPresentation + hdComposition;
          const loc = locations.find(l => l.id === tmpl.locationId);

          return {
            id: tmpl.id,
            locationId: tmpl.locationId,
            layout: tmpl.layout,
            meetingQualityWeight,
            // Display name: "Location / Endpoint Type"
            name: (loc?.name || 'Unknown') + ' / ' + (C.ENDPOINT_TYPES[tmpl.endpointType]?.label ?? tmpl.endpointType),
            locationName: loc?.name || 'Unknown',
            endpointLabel: C.ENDPOINT_TYPES[tmpl.endpointType]?.label ?? tmpl.endpointType,
            count: effectiveCount,
            totalPts,
            extPts,
            maxVideoPts,
            audioOverflowPts: audioOverflow,
            hdEndpoints,
            hdPresentation,
            hdComposition,
            hdTotal,
            // Aggregate (per-meeting × count) variants for HD totals
            hdTotalAll: hdTotal * effectiveCount,
            hdEndpointsAll: hdEndpoints * effectiveCount,
            hdPresentationAll: hdPresentation * effectiveCount,
            hdCompositionAll: hdComposition * effectiveCount,
            hasCrossLocation,
            crossLocationCount,
            // Bandwidth — per-meeting single-instance values
            bwAccessMin, bwAccessMax,
            bwAudioMin, bwAudioMax,
            bwPresentationMin, bwPresentationMax,
            bwBackplaneMin, bwBackplaneMax,
            bwProxyMin, bwProxyMax,
            bwMeetingMin, bwMeetingMax,
            // Bandwidth — aggregate (× effectiveCount)
            bwMeetingMinAll:   bwMeetingMin   * effectiveCount,
            bwMeetingMaxAll:   bwMeetingMax   * effectiveCount,
            bwBackplaneMinAll: bwBackplaneMin * effectiveCount,
            bwBackplaneMaxAll: bwBackplaneMax * effectiveCount,
            bwProxyMinAll:     bwProxyMin     * effectiveCount,
            bwProxyMaxAll:     bwProxyMax     * effectiveCount,
          };
        })
      );

      // ── derived meeting totals ────────────────────────────────────────────
      const numberOfMeetings  = computed(() => meetingTemplates.reduce((a, t) => a + effectiveCountForTemplate(t), 0));
      const totalParticipants = computed(() => meetingResults.value.reduce((a, r) => a + r.totalPts * r.count, 0));
      const totalExternalPts  = computed(() => meetingResults.value.reduce((a, r) => a + r.extPts * r.count, 0));
      const totalInternalPts  = computed(() => totalParticipants.value - totalExternalPts.value);

      // ── step 3: total HD before backplane ─────────────────────────────────
      const totalHDBeforeBackplane = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.hdTotalAll, 0)
      );

      // ── step 4: backplane — per-template cross-location detection ─────────
      const backplaneHD = computed(() => {
        if (totalDefinedTranscodingNodes.value <= 1) return 0;
        return meetingResults.value.reduce((a, r) =>
          a + (r.hasCrossLocation
            ? (r.crossLocationCount + 1) * C.BACKPLANE_HD_PER_MEETING * r.meetingQualityWeight * r.count
            : 0), 0);
      });

      // ── step 5: total + headroom ──────────────────────────────────────────
      const totalHDRaw          = computed(() => totalHDBeforeBackplane.value + backplaneHD.value);
      const totalHDWithHeadroom = computed(() => totalHDRaw.value * C.HEADROOM_FACTOR);

      // ── step 6: CPU efficiency ────────────────────────────────────────────
      const effectiveHDperVcpu = computed(() => {
        const base    = C.CPU_EFFICIENCY_TABLE[cpuInstructionSet.value] ?? 4.0;
        const clockFx = cpuClockGhz.value / C.CPU_REFERENCE_CLOCK;
        const htFx    = hyperthreading.value ? C.HT_BONUS_FACTOR : 1.0;
        const hvFx    = C.HYPERVISOR_FACTORS[hypervisor.value] ?? 1.0;
        return base * clockFx * htFx * hvFx;
      });

      // ── step 7: vCPU + node count ─────────────────────────────────────────
      const vCPURequired = computed(() =>
        Math.ceil(totalHDWithHeadroom.value / Math.max(effectiveHDperVcpu.value, 0.01))
      );
      const transcodingNodeCount = computed(() =>
        Math.max(1, Math.ceil(vCPURequired.value / nodeVcpuSize.value))
      );
      const proxyNodeCount = computed(() =>
        totalDefinedProxyNodes.value + totalDefinedExternalNodes.value
      );

      // ── step 8: bandwidth ─────────────────────────────────────────────────
      const meetingBandwidthMin = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.bwMeetingMinAll, 0)
      );
      const meetingBandwidthMax = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.bwMeetingMaxAll, 0)
      );
      const backplaneBandwidthMin = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.bwBackplaneMinAll, 0)
      );
      const backplaneBandwidthMax = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.bwBackplaneMaxAll, 0)
      );
      const proxyBandwidthMin = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.bwProxyMinAll, 0)
      );
      const proxyBandwidthMax = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.bwProxyMaxAll, 0)
      );
      const perLocationBandwidth = computed(() =>
        locations
          .map(loc => {
            const ms = meetingResults.value.filter(r => r.locationId === loc.id);
            return {
              id:       loc.id,
              name:     loc.name || 'Unnamed',
              localMin: ms.reduce((a, r) => a + r.bwMeetingMinAll,   0),
              localMax: ms.reduce((a, r) => a + r.bwMeetingMaxAll,   0),
              wanMin:   ms.reduce((a, r) => a + r.bwBackplaneMinAll, 0),
              wanMax:   ms.reduce((a, r) => a + r.bwBackplaneMaxAll, 0),
            };
          })
          .filter(l => l.localMin > 0 || l.wanMin > 0)
      );
      const totalBandwidthMin = computed(() =>
        meetingBandwidthMin.value + backplaneBandwidthMin.value + proxyBandwidthMin.value
      );
      const totalBandwidthMax = computed(() =>
        meetingBandwidthMax.value + backplaneBandwidthMax.value + proxyBandwidthMax.value
      );

      // ── warnings ──────────────────────────────────────────────────────────
      const warnings = computed(() => {
        const w = [];

        if (nodeVcpuSize.value > cpuCoresPerSocket.value && !hyperthreading.value) {
          w.push({
            type: 'numa',
            text: `Node size (${nodeVcpuSize.value} vCPU) exceeds physical cores per socket (${cpuCoresPerSocket.value}). Enable hyperthreading with VM pinning, or reduce node size.`,
          });
        }
        if (nodeVcpuSize.value > cpuCoresPerSocket.value * 2) {
          w.push({
            type: 'numa',
            text: `Node size (${nodeVcpuSize.value} vCPU) exceeds all logical threads on one socket (${cpuCoresPerSocket.value * 2}). Pexip does not support this configuration.`,
          });
        }
        if (hypervisor.value !== 'cloud') {
          w.push({
            type: 'overcommit',
            text: `Avoid CPU overcommit on ${hypervisor.value === 'vmware' ? 'VMware' : hypervisor.value === 'hyperv' ? 'Hyper-V' : 'KVM'}. Pexip is CPU-intensive; maintain a 1:1 vCPU-to-pCPU ratio.`,
          });
        }
        if (topologyMode.value === 'multi_site' && !viaProxy.value) {
          w.push({
            type: 'proxy',
            text: 'Multi-site deployment has no Proxy or External nodes defined. Add DMZ proxy nodes in each site for external connectivity and resilience.',
          });
        }
        if (topologyMode.value === 'no_transcoding' && locations.length > 0) {
          w.push({
            type: 'proxy',
            text: 'Topology has locations defined but no Transcoding nodes. Add at least one Transcoding (Internal) node.',
          });
        }
        if (endpointRows.some(r => r.codec === 'vp9' && Number(r.count) > 0)) {
          w.push({
            type: 'vp9',
            text: 'VP9 selected for WebRTC: +25% node resource overhead vs VP8/H.264. VP9 saves ~33% bandwidth but increases CPU load.',
          });
        }
        if (hyperthreading.value) {
          w.push({
            type: 'ht',
            text: 'Hyperthreading bonus applied. This requires NUMA-pinned VM affinity rules. Disable vMotion / Live Migration when using CPU pinning.',
          });
        }
        if (locations.length > 0 && endpointRows.some(r => Number(r.count) > 0) && !allEndpointsAssigned.value) {
          w.push({
            type: 'proxy',
            text: 'Not all endpoints are assigned to topology locations. Open the Endpoints section within each location to complete the assignment.',
          });
        }
        if (meetingTemplates.length === 0 || numberOfMeetings.value === 0) {
          w.push({
            type: 'proxy',
            text: 'No meetings configured. Assign endpoints to locations in ② — meeting templates are generated automatically. Set meeting counts in ③.',
          });
        }
        return w;
      });

      // ── node recommendation table ─────────────────────────────────────────
      const nodeRecommendations = computed(() => {
        const rows = [];
        const tLocs = numberOfTranscodingLocations.value;

        if (tLocs > 1) {
          const perLoc = Math.ceil(transcodingNodeCount.value / tLocs);
          transcodingLocations.value.forEach(loc => {
            rows.push({
              type: 'Transcoding', location: loc.name || 'Unnamed',
              count: perLoc, vcpu: nodeVcpuSize.value, ram: nodeVcpuSize.value * 2,
              note: `${loc.name || 'Location'} — ${nodeVcpuSize.value} vCPU each`,
            });
          });
        } else {
          rows.push({
            type: 'Transcoding', location: null,
            count: transcodingNodeCount.value, vcpu: nodeVcpuSize.value, ram: nodeVcpuSize.value * 2,
            note: `Handles media mixing — ${nodeVcpuSize.value} vCPU each`,
          });
        }
        if (totalDefinedProxyNodes.value > 0) {
          rows.push({
            type: 'Proxy / Edge', location: null,
            count: totalDefinedProxyNodes.value, vcpu: C.PROXY_NODE_VCPU, ram: C.PROXY_NODE_VCPU,
            note: 'DMZ-facing, forwards media to transcoding nodes',
          });
        }
        if (totalDefinedExternalNodes.value > 0) {
          rows.push({
            type: 'External', location: null,
            count: totalDefinedExternalNodes.value, vcpu: C.PROXY_NODE_VCPU, ram: C.PROXY_NODE_VCPU,
            note: 'Public-facing, routes external calls inbound',
          });
        }
        rows.push({ type: 'Management', location: null, count: 1, vcpu: 4, ram: 8, note: 'Always 1 — no media processing' });
        return rows;
      });

      // ── lookup tables exposed to template ─────────────────────────────────
      const EFFICIENCY_BASE = { legacy: 2.5, avx2: 4.0, avx512: 6.0 };
      const HV_FACTORS      = { vmware: 1.0, kvm: 0.95, hyperv: 0.90, cloud: 1.0 };

      // ── return ─────────────────────────────────────────────────────────────
      return {
        // endpoint model
        endpointRows,

        // topology
        locations,
        unassignedEndpointCounts,
        allEndpointsAssigned,

        // meeting builder — templates
        meetingTemplates,
        meetingResults,
        maxCountForTemplate,

        // hardware state
        cpuInstructionSet,
        cpuClockGhz,
        cpuCoresPerSocket,
        nodeVcpuSize,
        hyperthreading,
        hypervisor,

        // computed — endpoint ref data
        rowResults,
        hasInterop,

        // computed — meeting totals
        numberOfMeetings,
        totalParticipants,
        totalInternalPts,
        totalExternalPts,

        // computed — resource pipeline
        totalHDRaw,
        totalHDWithHeadroom,
        backplaneHD,
        effectiveHDperVcpu,
        vCPURequired,
        transcodingNodeCount,
        proxyNodeCount,
        meetingBandwidthMin,
        meetingBandwidthMax,
        backplaneBandwidthMin,
        backplaneBandwidthMax,
        proxyBandwidthMin,
        proxyBandwidthMax,
        perLocationBandwidth,
        totalBandwidthMin,
        totalBandwidthMax,
        warnings,
        nodeRecommendations,

        // computed — topology
        viaProxy,
        totalDefinedTranscodingNodes,
        totalDefinedProxyNodes,
        totalDefinedExternalNodes,
        numberOfTranscodingLocations,
        transcodingLocations,
        topologyMode,

        // actions — topology
        addLocation,
        removeLocation,
        addNodeToLocation,
        removeNodeFromLocation,
        toggleLocation,
        toggleLocationEndpoints,

        // constants for template
        LAYOUTS:                  C.LAYOUTS,
        ENDPOINT_TYPES:           C.ENDPOINT_TYPES,
        ENDPOINT_CODEC:           C.ENDPOINT_CODEC,
        ENDPOINT_QUALITY_OPTIONS: C.ENDPOINT_QUALITY_OPTIONS,
        NODE_SIZES:               C.NODE_SIZES,
        NODE_ROLES:               C.NODE_ROLES,
        QUALITY_LABELS:           C.QUALITY_LABELS,
        EFFICIENCY_BASE,
        HV_FACTORS,

        // formatters
        fmtHD,
        fmtKbps,
        fmtRange,
      };
    },
  }).mount('#app');

})();
