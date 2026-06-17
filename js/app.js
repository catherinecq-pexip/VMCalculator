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
    if (kbps >= 1000000) return (kbps / 1000000).toFixed(2) + ' Tbps';
    if (kbps >= 1000)    return (kbps / 1000).toFixed(2) + ' Gbps';
    return Math.round(kbps) + ' Mbps';
  }

  // ── app ───────────────────────────────────────────────────────────────────

  createApp({
    setup() {

      // ── endpoint & interop model ──────────────────────────────────────────
      const endpointRows = reactive([
        { type: 'sip_h323',           internalCount: 0, externalCount: 0, quality: '720p', codec: 'h264', presentationOn: false },
        { type: 'zoom',               internalCount: 0, externalCount: 0, quality: '720p', codec: 'h264', presentationOn: false },
        { type: 'webrtc',             internalCount: 0, externalCount: 0, quality: '720p', codec: 'vp8',  presentationOn: false },
        { type: 'teams',              internalCount: 0, externalCount: 0, quality: '720p', codec: 'h264', presentationOn: false },
        { type: 'google_meet',        internalCount: 0, externalCount: 0, quality: '720p', codec: 'vp8',  presentationOn: false },
        { type: 'skype_for_business', internalCount: 0, externalCount: 0, quality: '720p', codec: 'h264', presentationOn: false },
      ]);

      // ── Teams Adaptive Composition ────────────────────────────────────────
      const teamsAdaptiveComposition = ref(true);
      const teamsOnStageCount        = ref(3);

      // ── topology — deployment topology builder ────────────────────────────
      const locations = reactive([]);

      function addLocation() {
        locations.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          name: '',
          description: '',
          nodes: [],
          expanded: true,
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

      // ── concurrency ───────────────────────────────────────────────────────
      const totalUsers                = ref(100);
      const peakConcurrentPct         = ref(20);
      const numberOfMeetings          = ref(5);
      const avgParticipantsPerMeeting = ref(5);

      const peakParticipants = computed(() =>
        Math.round(totalUsers.value * (peakConcurrentPct.value / 100))
      );

      // ── hardware ──────────────────────────────────────────────────────────
      const cpuInstructionSet = ref('avx2');
      const cpuClockGhz       = ref(3.0);
      const cpuCoresPerSocket = ref(16);
      const nodeVcpuSize      = ref(32);
      const hyperthreading    = ref(false);
      const hypervisor        = ref('vmware');

      // ── interop / codec flags ─────────────────────────────────────────────
      const hasInterop = computed(() =>
        endpointRows.some(r => (Number(r.internalCount) + Number(r.externalCount)) > 0
          && ['teams', 'google_meet', 'skype_for_business'].includes(r.type))
      );
      const hasTeams = computed(() => {
        const r = endpointRows.find(e => e.type === 'teams');
        return !!(r && (Number(r.internalCount) + Number(r.externalCount)) > 0);
      });

      // ── per-endpoint-type HD & bandwidth calculation ───────────────────────
      const rowResults = computed(() =>
        endpointRows.map(row => {
          const def        = C.ENDPOINT_TYPES[row.type] ?? {};
          const intCount   = Number(row.internalCount) || 0;
          const extCount   = Number(row.externalCount) || 0;
          const totalCount = intCount + extCount;
          const weight     = C.QUALITY_WEIGHTS[row.quality] ?? 1.0;
          const codecFactor = row.codec === 'vp9' ? C.VP9_RESOURCE_FACTOR : 1.0;
          const connFactor  = def.connectionFactor ?? 1.0;

          const basePerCall    = weight * connFactor * codecFactor;
          const proxyFactor    = viaProxy.value ? C.PROXY_RESOURCE_FACTOR : 1.0;
          const hdInternal     = intCount * basePerCall;
          const hdExternal     = extCount * basePerCall * proxyFactor;
          const hdPresentation = (def.presentationExtra && row.presentationOn)
            ? totalCount * (def.presentationHD ?? 1.0) : 0;
          const hdRow          = hdInternal + hdExternal + hdPresentation;

          const bwKey       = row.quality + '-' + row.codec;
          const bwFallback  = row.quality + '-h264';
          const bwPerStream = C.BANDWIDTH_TABLE[bwKey] ?? C.BANDWIDTH_TABLE[bwFallback] ?? 0;

          return {
            type: row.type, intCount, extCount, totalCount,
            hdInternal, hdExternal, hdPresentation, hdRow,
            bwLan: intCount * bwPerStream,
            bwWan: extCount * bwPerStream,
            bwKbps: totalCount * bwPerStream,
            bwPerStream, quality: row.quality, codec: row.codec,
          };
        })
      );

      // ── Teams Adaptive Composition overhead ───────────────────────────────
      const teamsCompositionHD = computed(() => {
        if (!teamsAdaptiveComposition.value || !hasTeams.value) return 0;
        const m     = numberOfMeetings.value || 0;
        const extra = Math.max(0, (teamsOnStageCount.value || 3) - 3) * C.TEAMS_COMPOSITION_HD_ONSTAGE;
        return m * (C.TEAMS_COMPOSITION_HD_BASE + extra);
      });

      // ── derived participant totals ─────────────────────────────────────────
      const totalParticipants = computed(() => rowResults.value.reduce((a, r) => a + r.totalCount, 0));
      const totalInternalPts  = computed(() => rowResults.value.reduce((a, r) => a + r.intCount, 0));
      const totalExternalPts  = computed(() => rowResults.value.reduce((a, r) => a + r.extCount, 0));
      const wanBandwidthKbps  = computed(() => rowResults.value.reduce((a, r) => a + r.bwWan, 0));

      // ── step 4: HD sum + composition overhead (proxy doubling embedded per-row) ──
      const totalHDBeforeBackplane = computed(() =>
        rowResults.value.reduce((a, r) => a + r.hdRow, 0) + teamsCompositionHD.value
      );

      // ── step 5: backplane overhead ────────────────────────────────────────
      const backplaneHD = computed(() => {
        const m = numberOfMeetings.value || 0;
        if (totalDefinedTranscodingNodes.value <= 1) return 0;
        return m * numberOfSites.value * C.BACKPLANE_HD_PER_MEETING;
      });

      // ── step 6: total + headroom ──────────────────────────────────────────
      const totalHDRaw          = computed(() => totalHDBeforeBackplane.value + backplaneHD.value);
      const totalHDWithHeadroom = computed(() => totalHDRaw.value * C.HEADROOM_FACTOR);

      // ── step 7: CPU efficiency ────────────────────────────────────────────
      const effectiveHDperVcpu = computed(() => {
        const base       = C.CPU_EFFICIENCY_TABLE[cpuInstructionSet.value] ?? 4.0;
        const clockFx    = cpuClockGhz.value / C.CPU_REFERENCE_CLOCK;
        const htFx       = hyperthreading.value ? C.HT_BONUS_FACTOR : 1.0;
        const hvFx       = C.HYPERVISOR_FACTORS[hypervisor.value] ?? 1.0;
        return base * clockFx * htFx * hvFx;
      });

      // ── step 8: vCPU + node count ─────────────────────────────────────────
      const vCPURequired = computed(() =>
        Math.ceil(totalHDWithHeadroom.value / Math.max(effectiveHDperVcpu.value, 0.01))
      );

      const transcodingNodeCount = computed(() =>
        Math.max(1, Math.ceil(vCPURequired.value / nodeVcpuSize.value))
      );

      const proxyNodeCount = computed(() =>
        totalDefinedProxyNodes.value + totalDefinedExternalNodes.value
      );

      // ── step 9: bandwidth ─────────────────────────────────────────────────
      const totalBandwidthKbps = computed(() =>
        rowResults.value.reduce((a, r) => a + r.bwKbps, 0)
      );

      const interNodeBandwidthKbps = computed(() => {
        if (totalDefinedTranscodingNodes.value <= 1) return 0;
        return (numberOfMeetings.value || 0) * transcodingNodeCount.value * 960;
      });

      // ── warnings ──────────────────────────────────────────────────────────
      const warnings = computed(() => {
        const w = [];

        if (nodeVcpuSize.value > cpuCoresPerSocket.value && !hyperthreading.value) {
          w.push({
            type: 'numa',
            text: `Node size (${nodeVcpuSize.value} vCPU) exceeds physical cores per socket (${cpuCoresPerSocket.value}). This spans NUMA nodes and degrades media performance. Enable hyperthreading with VM pinning, or reduce node size.`,
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
            text: 'Topology has locations defined but no Transcoding nodes. Add at least one Transcoding (Internal) node to drive resource calculations.',
          });
        }
        if (endpointRows.some(r => r.codec === 'vp9' && (Number(r.internalCount) + Number(r.externalCount)) > 0)) {
          w.push({
            type: 'vp9',
            text: 'VP9 selected for WebRTC: +25% node resource overhead vs VP8/H.264. VP9 saves ~33% bandwidth but increases CPU load — account for this when sizing nodes.',
          });
        }
        if (hasTeams.value && teamsAdaptiveComposition.value && (teamsOnStageCount.value || 0) > 3) {
          w.push({
            type: 'ht',
            text: `Teams Adaptive Composition: ${teamsOnStageCount.value} on-stage participants adds ${fmtHD(teamsCompositionHD.value)} HD overhead across ${numberOfMeetings.value} conference(s). Reduce on-stage count to lower composition load.`,
          });
        }
        if (hyperthreading.value) {
          w.push({
            type: 'ht',
            text: 'Hyperthreading bonus applied. This requires NUMA-pinned VM affinity rules. Disable vMotion / Live Migration when using CPU pinning.',
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
              type:     'Transcoding',
              location: loc.name || 'Unnamed',
              count:    perLoc,
              vcpu:     nodeVcpuSize.value,
              ram:      nodeVcpuSize.value * 2,
              note:     `${loc.name || 'Location'} — ${nodeVcpuSize.value} vCPU each`,
            });
          });
        } else {
          rows.push({
            type:     'Transcoding',
            location: null,
            count:    transcodingNodeCount.value,
            vcpu:     nodeVcpuSize.value,
            ram:      nodeVcpuSize.value * 2,
            note:     `Handles media mixing — ${nodeVcpuSize.value} vCPU each`,
          });
        }

        if (totalDefinedProxyNodes.value > 0) {
          rows.push({
            type:     'Proxy / Edge',
            location: null,
            count:    totalDefinedProxyNodes.value,
            vcpu:     C.PROXY_NODE_VCPU,
            ram:      C.PROXY_NODE_VCPU,
            note:     'DMZ-facing, forwards media to transcoding nodes',
          });
        }
        if (totalDefinedExternalNodes.value > 0) {
          rows.push({
            type:     'External',
            location: null,
            count:    totalDefinedExternalNodes.value,
            vcpu:     C.PROXY_NODE_VCPU,
            ram:      C.PROXY_NODE_VCPU,
            note:     'Public-facing, routes external calls inbound',
          });
        }
        rows.push({
          type:     'Management',
          location: null,
          count:    1,
          vcpu:     4,
          ram:      8,
          note:     'Always 1 — no media processing',
        });
        return rows;
      });

      // ── bandwidth breakdown per endpoint type ─────────────────────────────
      const bandwidthRows = computed(() =>
        rowResults.value
          .filter(r => r.totalCount > 0)
          .map(r => ({
            label:     (C.ENDPOINT_TYPES[r.type]?.label ?? r.type)
                       + ' (' + r.codec.toUpperCase() + ')',
            count:     r.totalCount,
            perStream: r.bwPerStream,
            total:     r.bwKbps,
            wan:       r.bwWan,
          }))
      );

      // ── lookup tables exposed to template ─────────────────────────────────
      const EFFICIENCY_BASE = { legacy: 2.5, avx2: 4.0, avx512: 6.0 };
      const HV_FACTORS      = { vmware: 1.0, kvm: 0.95, hyperv: 0.90, cloud: 1.0 };

      // ── return ─────────────────────────────────────────────────────────────
      return {
        // endpoint model state
        endpointRows,
        teamsAdaptiveComposition,
        teamsOnStageCount,

        // topology state
        locations,

        // concurrency state
        numberOfMeetings,
        totalUsers,
        peakConcurrentPct,
        avgParticipantsPerMeeting,

        // hardware state
        cpuInstructionSet,
        cpuClockGhz,
        cpuCoresPerSocket,
        nodeVcpuSize,
        hyperthreading,
        hypervisor,

        // computed — endpoint model
        rowResults,
        teamsCompositionHD,
        totalParticipants,
        totalInternalPts,
        totalExternalPts,
        wanBandwidthKbps,
        hasInterop,
        hasTeams,

        // computed — resource pipeline
        peakParticipants,
        totalHDRaw,
        totalHDWithHeadroom,
        backplaneHD,
        effectiveHDperVcpu,
        vCPURequired,
        transcodingNodeCount,
        proxyNodeCount,
        totalBandwidthKbps,
        interNodeBandwidthKbps,
        warnings,
        nodeRecommendations,
        bandwidthRows,

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
