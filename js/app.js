// Pexip Resource & Capacity Calculator — Vue 3 app (plain script, no build step)
// Depends on: window.PEXIP (config.js loaded first), window.Vue (CDN)

(function () {
  'use strict';

  const C = window.PEXIP; // shorthand alias
  const { createApp, reactive, computed, ref } = Vue;

  // ── helpers ────────────────────────────────────────────────────────────────

  function fmtHD(n) {
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function fmtKbps(kbps) {
    if (kbps >= 1000000) return (kbps / 1000000).toFixed(2) + ' Tbps';
    if (kbps >= 1000)    return (kbps / 1000).toFixed(2) + ' Gbps';
    return Math.round(kbps) + ' Mbps';
  }

  // ── app ───────────────────────────────────────────────────────────────────

  createApp({
    setup() {

      // ── endpoint & interop model ──────────────────────────────────────────
      // count = total defined endpoints of this type (internal to the deployment)
      // External participants are defined per-meeting in the Meeting Builder
      const endpointRows = reactive([
        { type: 'sip_h323',           count: 0, quality: '720p', codec: 'h264', presentationOn: false },
        { type: 'zoom',               count: 0, quality: '720p', codec: 'h264', presentationOn: false },
        { type: 'webrtc',             count: 0, quality: '720p', codec: 'vp8',  presentationOn: false },
        { type: 'teams',              count: 0, quality: '720p', codec: 'h264', presentationOn: false },
        { type: 'google_meet',        count: 0, quality: '720p', codec: 'vp8',  presentationOn: false },
        { type: 'skype_for_business', count: 0, quality: '720p', codec: 'h264', presentationOn: false },
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
      const numberOfSites                = computed(() => Math.max(1, numberOfTranscodingLocations.value));
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

      // ── meeting builder ───────────────────────────────────────────────────
      const meetings = reactive([]);

      function addMeeting() {
        meetings.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          name: '',
          hostLocationId: null,
          layout: 'classic',
          presentationActive: false,
          expanded: true,
          participantLocations: [],
          participantEndpoints: {
            sip_h323: 0, zoom: 0, webrtc: 0,
            teams: 0, google_meet: 0, skype_for_business: 0,
          },
        });
      }
      function removeMeeting(id) {
        const idx = meetings.findIndex(m => m.id === id);
        if (idx !== -1) meetings.splice(idx, 1);
      }
      function toggleMeeting(id) {
        const m = meetings.find(m => m.id === id);
        if (m) m.expanded = !m.expanded;
      }
      function addParticipantLocation(meetingId) {
        const m = meetings.find(m => m.id === meetingId);
        if (m) m.participantLocations.push({ locationId: null, count: 0 });
      }
      function removeParticipantLocation(meetingId, idx) {
        const m = meetings.find(m => m.id === meetingId);
        if (m) m.participantLocations.splice(idx, 1);
      }

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
          const hdPerPt     = weight * connFactor * codecFactor;
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
      const hasTeams = computed(() => {
        const r = endpointRows.find(e => e.type === 'teams');
        return !!(r && Number(r.count) > 0);
      });

      // ── per-meeting resource calculation ──────────────────────────────────
      const meetingResults = computed(() =>
        meetings.map(m => {
          const totalPts = m.participantLocations.reduce((a, pl) => a + (Number(pl.count) || 0), 0);
          const extPts   = m.participantLocations
            .filter(pl => pl.locationId === 'external')
            .reduce((a, pl) => a + (Number(pl.count) || 0), 0);
          const extProportion = totalPts > 0 ? extPts / totalPts : 0;

          // Cross-location detection: find non-external location IDs with participants
          const locIdsWithPts = new Set(
            m.participantLocations
              .filter(pl => pl.locationId && pl.locationId !== 'external' && (Number(pl.count) || 0) > 0)
              .map(pl => pl.locationId)
          );
          const hostId = m.hostLocationId;
          const nonHostLocs = hostId
            ? [...locIdsWithPts].filter(id => id !== hostId)
            : [...locIdsWithPts];
          const hasCrossLocation = locIdsWithPts.size > 1
            || (hostId && locIdsWithPts.size === 1 && !locIdsWithPts.has(hostId))
            || (!hostId && locIdsWithPts.size >= 1);
          const crossLocationCount = Math.max(0, nonHostLocs.length);

          // HD & bandwidth per endpoint type
          let hdEndpoints = 0, hdPresentation = 0, bwLan = 0, bwWan = 0;
          const proxyFactor = viaProxy.value ? C.PROXY_RESOURCE_FACTOR : 1.0;

          endpointRows.forEach(row => {
            const typeCount = Number(m.participantEndpoints[row.type]) || 0;
            if (!typeCount) return;
            const def         = C.ENDPOINT_TYPES[row.type] ?? {};
            const weight      = C.QUALITY_WEIGHTS[row.quality] ?? 1.0;
            const codecFactor = row.codec === 'vp9' ? C.VP9_RESOURCE_FACTOR : 1.0;
            const connFactor  = def.connectionFactor ?? 1.0;
            const base        = weight * connFactor * codecFactor;

            const typeExtCount = Math.round(typeCount * extProportion);
            const typeIntCount = typeCount - typeExtCount;

            hdEndpoints += typeIntCount * base + typeExtCount * base * proxyFactor;

            if (def.presentationExtra && m.presentationActive) {
              hdPresentation += typeCount * (def.presentationHD ?? 1.0);
            }

            const bwKey       = row.quality + '-' + row.codec;
            const bwFallback  = row.quality + '-h264';
            const bwPerStream = C.BANDWIDTH_TABLE[bwKey] ?? C.BANDWIDTH_TABLE[bwFallback] ?? 0;
            bwLan += typeIntCount * bwPerStream;
            bwWan += typeExtCount * bwPerStream;
          });

          // Teams Adaptive Composition per meeting (layout-driven)
          let hdComposition = 0;
          const teamsInMeeting = Number(m.participantEndpoints.teams) || 0;
          if (m.layout === 'adaptive' && teamsInMeeting > 0) {
            hdComposition = C.TEAMS_COMPOSITION_HD_BASE
              + Math.max(0, teamsInMeeting - 3) * C.TEAMS_COMPOSITION_HD_ONSTAGE;
          }

          return {
            id: m.id,
            name: m.name || 'Unnamed',
            totalPts, extPts, hdEndpoints, hdPresentation, hdComposition,
            hdTotal: hdEndpoints + hdPresentation + hdComposition,
            hasCrossLocation, crossLocationCount,
            bwLan, bwWan,
          };
        })
      );

      // ── derived meeting totals ────────────────────────────────────────────
      const numberOfMeetings  = computed(() => meetings.length);
      const totalParticipants = computed(() => meetingResults.value.reduce((a, m) => a + m.totalPts, 0));
      const totalExternalPts  = computed(() => meetingResults.value.reduce((a, m) => a + m.extPts, 0));
      const totalInternalPts  = computed(() => totalParticipants.value - totalExternalPts.value);
      const wanBandwidthKbps  = computed(() => meetingResults.value.reduce((a, m) => a + m.bwWan, 0));

      // ── step 3: total HD before backplane ─────────────────────────────────
      const totalHDBeforeBackplane = computed(() =>
        meetingResults.value.reduce((a, m) => a + m.hdTotal, 0)
      );

      // ── step 4: backplane — per-meeting cross-location detection ──────────
      const backplaneHD = computed(() => {
        if (totalDefinedTranscodingNodes.value <= 1) return 0;
        return meetingResults.value.reduce((a, m) =>
          a + (m.hasCrossLocation
            ? Math.max(1, m.crossLocationCount) * C.BACKPLANE_HD_PER_MEETING
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
      const totalBandwidthKbps = computed(() =>
        meetingResults.value.reduce((a, m) => a + m.bwLan + m.bwWan, 0)
      );
      const interNodeBandwidthKbps = computed(() => {
        if (totalDefinedTranscodingNodes.value <= 1) return 0;
        return meetingResults.value
          .filter(m => m.hasCrossLocation)
          .reduce((a, m) => a + Math.max(1, m.crossLocationCount) * 960, 0);
      });

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
        if (meetings.length === 0) {
          w.push({
            type: 'proxy',
            text: 'No meetings defined. Add meetings in the Meeting Builder — resource calculations are driven by active conferences.',
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

        // meeting builder
        meetings,
        meetingResults,
        addMeeting,
        removeMeeting,
        toggleMeeting,
        addParticipantLocation,
        removeParticipantLocation,

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
        hasTeams,

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
        totalBandwidthKbps,
        wanBandwidthKbps,
        interNodeBandwidthKbps,
        warnings,
        nodeRecommendations,

        // computed — topology
        numberOfSites,
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
        ENDPOINT_TYPES:           C.ENDPOINT_TYPES,
        ENDPOINT_CODEC:           C.ENDPOINT_CODEC,
        ENDPOINT_QUALITY_OPTIONS: C.ENDPOINT_QUALITY_OPTIONS,
        TEAMS_COMPOSITION_HD_BASE:    C.TEAMS_COMPOSITION_HD_BASE,
        TEAMS_COMPOSITION_HD_ONSTAGE: C.TEAMS_COMPOSITION_HD_ONSTAGE,
        NODE_SIZES:               C.NODE_SIZES,
        NODE_ROLES:               C.NODE_ROLES,
        QUALITY_LABELS:           C.QUALITY_LABELS,
        EFFICIENCY_BASE,
        HV_FACTORS,

        // formatters
        fmtHD,
        fmtKbps,
      };
    },
  }).mount('#app');

})();
