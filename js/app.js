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

      // ── call mix ──────────────────────────────────────────────────────────
      const callMix = reactive(C.DEFAULT_CALL_MIX.map(r => ({ ...r })));
      const nextRowId = ref(callMix.length + 1);

      function addRow() {
        callMix.push({ id: nextRowId.value++, quality: '720p', count: 0, codec: 'h264' });
      }
      function removeRow(id) {
        const idx = callMix.findIndex(r => r.id === id);
        if (idx !== -1) callMix.splice(idx, 1);
      }

      // ── endpoint types ────────────────────────────────────────────────────
      const endpointTypes = reactive(
        Object.fromEntries(Object.keys(C.ENDPOINT_TYPES).map(k => [k, false]))
      );
      endpointTypes.sip_h323 = true; // default

      // ── presentation ──────────────────────────────────────────────────────
      const presentationEnabled = ref(false);

      // ── gateway ───────────────────────────────────────────────────────────
      const gatewayOverhead = ref('none');
      const viaProxy = ref(false);

      // ── topology ──────────────────────────────────────────────────────────
      const topology = ref(C.TOPOLOGY.single_node);
      const locations = reactive([]);

      function addLocation() {
        locations.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          name: 'Location ' + (locations.length + 1),
          type: 'transcoding',
        });
      }
      function removeLocation(id) {
        const idx = locations.findIndex(l => l.id === id);
        if (idx !== -1) locations.splice(idx, 1);
      }

      const numberOfSites = computed(() =>
        topology.value === C.TOPOLOGY.multi_site ? Math.max(locations.length, 1) : 1
      );

      // ── concurrency ───────────────────────────────────────────────────────
      const totalUsers                = ref(100);
      const peakConcurrentPct         = ref(20);
      const numberOfMeetings          = ref(5);
      const avgParticipantsPerMeeting = ref(5);

      const peakParticipants = computed(() =>
        Math.round(totalUsers.value * (peakConcurrentPct.value / 100))
      );

      // ── hardware ──────────────────────────────────────────────────────────
      const cpuVendor         = ref('intel');
      const cpuInstructionSet = ref('avx2');
      const cpuClockGhz       = ref(2.8);
      const cpuCoresPerSocket = ref(16);
      const nodeVcpuSize      = ref(32);
      const hyperthreading    = ref(false);
      const hypervisor        = ref('vmware');

      // ── derived flags ─────────────────────────────────────────────────────
      const hasWebRTC = computed(() => endpointTypes.webrtc);
      const hasInterop = computed(() =>
        endpointTypes.teams || endpointTypes.google_meet || endpointTypes.interop
      );

      // ── step 1+2+3: per-row HD calculation ───────────────────────────────
      const rowResults = computed(() =>
        callMix.map(row => {
          const count   = Number(row.count) || 0;
          const weight  = C.QUALITY_WEIGHTS[row.quality] ?? 1.0;
          const codecFx = row.codec === 'vp9' ? C.VP9_RESOURCE_FACTOR : 1.0;

          // Step 1: base HD for this quality tier
          let hdBase = count * weight * codecFx;

          // Step 2: presentation stream additions
          let hdPresentation = 0;
          if (presentationEnabled.value) {
            if (hasWebRTC.value) {
              hdPresentation += count * (C.ENDPOINT_TYPES.webrtc.presentationHD ?? 1.0);
            }
            if (endpointTypes.teams) {
              hdPresentation += count * (C.ENDPOINT_TYPES.teams.presentationHD ?? 0.5);
            }
            if (endpointTypes.google_meet) {
              hdPresentation += count * (C.ENDPOINT_TYPES.google_meet.presentationHD ?? 1.0);
            }
            if (endpointTypes.interop) {
              hdPresentation += count * (C.ENDPOINT_TYPES.interop.presentationHD ?? 1.0);
            }
          }

          // Step 3: gateway overhead (apply to base, not presentation)
          const gwFactor = C.GATEWAY_OVERHEAD[gatewayOverhead.value] ?? 1.0;
          const gatewayActive = hasInterop.value || gatewayOverhead.value !== 'none';
          const hdAfterGateway = gatewayActive
            ? hdBase * gwFactor + hdPresentation
            : hdBase + hdPresentation;

          // Bandwidth for this row
          const bwKey     = row.quality + '-' + row.codec;
          const bwPerStream = C.BANDWIDTH_TABLE[bwKey] ?? 0;

          return {
            id:            row.id,
            quality:       row.quality,
            codec:         row.codec,
            count,
            hdBase,
            hdPresentation,
            hdRow:         hdAfterGateway,
            bwKbps:        count * bwPerStream,
            bwPerStream,
          };
        })
      );

      // ── step 4: proxy doubling ────────────────────────────────────────────
      const totalHDBeforeBackplane = computed(() => {
        const sum = rowResults.value.reduce((a, r) => a + r.hdRow, 0);
        return viaProxy.value ? sum * C.PROXY_RESOURCE_FACTOR : sum;
      });

      // ── step 5: backplane overhead ────────────────────────────────────────
      const backplaneHD = computed(() => {
        const m = numberOfMeetings.value || 0;
        if (topology.value === C.TOPOLOGY.single_node) return 0;
        if (topology.value === C.TOPOLOGY.single_site) return m * C.BACKPLANE_HD_PER_MEETING;
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

      const proxyNodeCount = computed(() => {
        if (topology.value === C.TOPOLOGY.single_node) return 0;
        if (!viaProxy.value) return 0;
        if (topology.value === C.TOPOLOGY.single_site) return 1;
        return Math.max(2, numberOfSites.value);
      });

      // ── step 9: bandwidth ─────────────────────────────────────────────────
      const totalBandwidthKbps = computed(() =>
        rowResults.value.reduce((a, r) => a + r.bwKbps, 0)
      );

      const interNodeBandwidthKbps = computed(() => {
        if (topology.value === C.TOPOLOGY.single_node) return 0;
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
        if (topology.value === C.TOPOLOGY.multi_site && !viaProxy.value) {
          w.push({
            type: 'proxy',
            text: 'Multi-site topology without proxy/edge nodes. Add DMZ proxy nodes in each site for external connectivity and resilience.',
          });
        }
        if (callMix.some(r => r.codec === 'vp9')) {
          w.push({
            type: 'vp9',
            text: 'VP9 rows carry a 25% resource overhead. VP9 saves bandwidth but increases node load — account for this when setting bandwidth limits.',
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
        rows.push({
          type:  'Transcoding',
          count: transcodingNodeCount.value,
          vcpu:  nodeVcpuSize.value,
          ram:   nodeVcpuSize.value * 2,
          note:  `Handles media mixing — ${nodeVcpuSize.value} vCPU each`,
        });
        if (proxyNodeCount.value > 0) {
          rows.push({
            type:  'Proxy / Edge',
            count: proxyNodeCount.value,
            vcpu:  C.PROXY_NODE_VCPU,
            ram:   C.PROXY_NODE_VCPU,
            note:  'DMZ-facing, forwards media to transcoding nodes',
          });
        }
        rows.push({
          type:  'Management',
          count: 1,
          vcpu:  4,
          ram:   8,
          note:  'Always 1 — no media processing',
        });
        return rows;
      });

      // ── bandwidth breakdown per row ────────────────────────────────────────
      const bandwidthRows = computed(() =>
        rowResults.value
          .filter(r => r.count > 0)
          .map(r => ({
            label:      (C.QUALITY_LABELS[r.quality] ?? r.quality) + ' (' + r.codec.toUpperCase() + ')',
            count:      r.count,
            perStream:  r.bwPerStream,
            total:      r.bwKbps,
          }))
      );

      // ── lookup tables exposed to template ─────────────────────────────────
      const EFFICIENCY_BASE = { legacy: 2.5, avx2: 4.0, avx512: 6.0 };
      const HV_FACTORS      = { vmware: 1.0, kvm: 0.95, hyperv: 0.90, cloud: 1.0 };
      const QUALITY_WEIGHTS_MAP = C.QUALITY_WEIGHTS;

      // ── return ─────────────────────────────────────────────────────────────
      return {
        // state
        callMix,
        endpointTypes,
        presentationEnabled,
        gatewayOverhead,
        viaProxy,
        topology,
        locations,
        numberOfMeetings,
        totalUsers,
        peakConcurrentPct,
        avgParticipantsPerMeeting,
        cpuVendor,
        cpuInstructionSet,
        cpuClockGhz,
        cpuCoresPerSocket,
        nodeVcpuSize,
        hyperthreading,
        hypervisor,

        // computed
        peakParticipants,
        rowResults,
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
        numberOfSites,

        // actions
        addRow,
        removeRow,
        addLocation,
        removeLocation,

        // constants for template
        ENDPOINT_TYPES:    C.ENDPOINT_TYPES,
        QUALITY_LABELS:    C.QUALITY_LABELS,
        TOPOLOGY:          C.TOPOLOGY,
        NODE_SIZES:        C.NODE_SIZES,
        EFFICIENCY_BASE,
        HV_FACTORS,
        QUALITY_WEIGHTS_MAP,

        // formatters
        fmtHD,
        fmtKbps,
      };
    },
  }).mount('#app');

})();
