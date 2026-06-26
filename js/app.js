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
          nodesExpanded: false,
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
      function toggleLocationNodes(id) {
        const loc = locations.find(l => l.id === id);
        if (loc) loc.nodesExpanded = !loc.nodesExpanded;
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

      // Build participant rows for a new template (one row per active endpoint type)
      function buildParticipantRows(meetingType, hostLocationId) {
        return endpointRows
          .filter(r => Number(r.count) > 0)
          .map(r => ({
            endpointType: r.type,
            locationId: r.type === meetingType ? hostLocationId : null,
            count: 0,
          }));
      }

      // Meeting count is user-controlled — no hard cap enforced.
      // Pool tracking and over-commitment warnings are handled by poolAllocation.
      function effectiveCountForTemplate(tmpl) {
        return Number(tmpl.meetingCount) || 0;
      }

      // Demand tracking: total endpoint consumption per (type × location) across all templates.
      const poolAllocation = computed(() => {
        const map = {};

        meetingTemplates.forEach(tmpl => {
          const meetingCount = Number(tmpl.meetingCount) || 0;
          (tmpl.participants || []).forEach(p => {
            const count = Number(p.count) || 0;
            if (!count || !p.locationId) return;
            const key = p.endpointType + '|' + p.locationId;
            if (!map[key]) {
              map[key] = { endpointType: p.endpointType, locationId: p.locationId, demand: 0, templates: [] };
            }
            map[key].demand += meetingCount * count;
            map[key].templates.push({
              id:             tmpl.id,
              label:          C.ENDPOINT_TYPES[tmpl.meetingType]?.label ?? tmpl.meetingType,
              countPerMeeting: count,
              meetingCount,
            });
          });
        });

        return Object.values(map).map(entry => {
          const loc      = locations.find(l => l.id === entry.locationId);
          const assigned = Number(loc?.endpointAssignments?.[entry.endpointType]) || 0;
          return {
            ...entry,
            locationName:  loc?.name || 'Unnamed',
            typeName:      C.ENDPOINT_TYPES[entry.endpointType]?.label ?? entry.endpointType,
            assigned,
            overCommitted: entry.demand > assigned,
          };
        });
      });

      // Auto-generate templates from (location × endpointType) assignment combos
      watch(
        () => {
          const keys = [];
          locations.forEach(loc => {
            Object.entries(loc.endpointAssignments || {}).forEach(([type, count]) => {
              if (Number(count) > 0) keys.push({ locationId: loc.id, endpointType: type });
            });
          });
          return keys;
        },
        (newKeys) => {
          const desiredSet = new Set(newKeys.map(k => k.locationId + '|' + k.endpointType));

          // Remove auto-generated templates whose combo no longer exists
          for (let i = meetingTemplates.length - 1; i >= 0; i--) {
            const t = meetingTemplates[i];
            if (t._autoKey && !desiredSet.has(t.hostLocationId + '|' + t.meetingType)) {
              meetingTemplates.splice(i, 1);
            }
          }

          // Add templates for new combos
          newKeys.forEach(k => {
            const existing = meetingTemplates.find(
              t => t._autoKey && t.hostLocationId === k.locationId && t.meetingType === k.endpointType
            );
            if (!existing) {
              meetingTemplates.push({
                id: k.locationId + '-' + k.endpointType,
                _autoKey: true,
                meetingType: k.endpointType,
                hostLocationId: k.locationId,
                participants: buildParticipantRows(k.endpointType, k.locationId),
                externalCount: 0,
                externalEndpointType: endpointRows.find(r => Number(r.count) > 0)?.type || 'sip_h323',
                layout: '1+7',
                presentationActive: true,
                meetingCount: 1,
                expanded: false,
              });
            }
          });
        },
        { deep: true, immediate: true }
      );

      // Sync participant rows when endpoint types become active/inactive in step ①
      watch(
        () => endpointRows.map(r => r.type + ':' + (Number(r.count) > 0 ? '1' : '0')).join(','),
        () => {
          const activeTypes = new Set(endpointRows.filter(r => Number(r.count) > 0).map(r => r.type));
          meetingTemplates.forEach(tmpl => {
            for (let i = tmpl.participants.length - 1; i >= 0; i--) {
              if (!activeTypes.has(tmpl.participants[i].endpointType)) tmpl.participants.splice(i, 1);
            }
            activeTypes.forEach(type => {
              if (!tmpl.participants.find(p => p.endpointType === type)) {
                tmpl.participants.push({ endpointType: type, locationId: null, count: 0 });
              }
            });
          });
        }
      );

      function duplicateTemplate(id) {
        const orig = meetingTemplates.find(t => t.id === id);
        if (!orig) return;
        meetingTemplates.push({
          ...orig,
          id: Date.now() + Math.floor(Math.random() * 1000),
          _autoKey: false,
          participants: orig.participants.map(p => ({ ...p })),
          expanded: true,
        });
      }
      function addBlankTemplate() {
        const firstType = endpointRows.find(r => Number(r.count) > 0)?.type || 'sip_h323';
        const firstLoc  = locations[0]?.id || null;
        meetingTemplates.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          _autoKey: false,
          meetingType: firstType,
          hostLocationId: firstLoc,
          participants: buildParticipantRows(firstType, firstLoc),
          externalCount: 0,
          externalEndpointType: firstType,
          layout: '1+7',
          presentationActive: true,
          meetingCount: 1,
          expanded: true,
        });
      }
      function removeMeetingTemplate(id) {
        const idx = meetingTemplates.findIndex(t => t.id === id);
        if (idx !== -1) meetingTemplates.splice(idx, 1);
      }

      // ── hardware ──────────────────────────────────────────────────────────
      const cpuInstructionSet = ref('avx2');
      const cpuClockGhz       = ref(3.0);
      const cpuCoresPerSocket = ref(24);
      const cpuSocketCount    = ref(2);
      const hyperthreading    = ref(false);
      const hypervisor        = ref('vmware');

      // Total physical cores across all sockets
      const totalPhysicalCores = computed(() =>
        cpuCoresPerSocket.value * cpuSocketCount.value
      );
      // Total vCPU available from hardware (HT doubles logical threads)
      const totalAvailableVCPU = computed(() =>
        totalPhysicalCores.value * (hyperthreading.value ? 2 : 1)
      );
      // Conferencing nodes: ~22 physical cores per node (NUMA-aware, per socket)
      const recommendedNodeCount = computed(() =>
        Math.max(1, Math.floor(totalPhysicalCores.value / C.CORES_PER_NODE_TARGET))
      );
      // vCPU size of each conferencing node
      const vCPUPerNode = computed(() =>
        Math.ceil(totalPhysicalCores.value / recommendedNodeCount.value) * (hyperthreading.value ? 2 : 1)
      );

      function roundToStandardRAM(gb) {
        for (const s of [8, 16, 32, 64, 128, 256]) { if (s >= gb) return s; }
        return 256;
      }
      // RAM per node: 1 GB per vCPU, rounded to standard size
      const ramPerNode = computed(() => roundToStandardRAM(vCPUPerNode.value));

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
      const meetingResults = computed(() =>
        meetingTemplates.map(tmpl => {
          const effectiveCount = effectiveCountForTemplate(tmpl);

          const hostRow              = endpointRows.find(r => r.type === tmpl.meetingType);
          const meetingQualityWeight = C.QUALITY_WEIGHTS[hostRow?.quality ?? '720p'] ?? 1.0;

          // Build participantEndpoints from per-type participant rows + external
          const participantEndpoints = {};
          endpointRows.forEach(r => { participantEndpoints[r.type] = 0; });
          (tmpl.participants || []).forEach(p => {
            participantEndpoints[p.endpointType] = (participantEndpoints[p.endpointType] || 0) + (Number(p.count) || 0);
          });
          const externalCount = Number(tmpl.externalCount) || 0;
          if (externalCount > 0 && tmpl.externalEndpointType) {
            participantEndpoints[tmpl.externalEndpointType] =
              (participantEndpoints[tmpl.externalEndpointType] || 0) + externalCount;
          }
          const totalPts      = Object.values(participantEndpoints).reduce((a, b) => a + b, 0);
          const extPts        = externalCount;
          const extProportion = totalPts > 0 ? extPts / totalPts : 0;

          // Cross-location detection from participant rows
          const locIdsWithPts = new Set(
            (tmpl.participants || [])
              .filter(p => Number(p.count) > 0 && p.locationId)
              .map(p => p.locationId)
          );
          const hostId = tmpl.hostLocationId;
          const nonHostLocs = hostId
            ? [...locIdsWithPts].filter(id => id !== hostId)
            : [...locIdsWithPts];
          const hasCrossLocation = locIdsWithPts.size > 1
            || (hostId && locIdsWithPts.size === 1 && !locIdsWithPts.has(hostId))
            || (!hostId && locIdsWithPts.size >= 1);
          const crossLocationCount = Math.max(0, nonHostLocs.length);

          // Layout-aware video/audio split
          const layoutDef      = C.LAYOUTS[tmpl.layout];
          const maxVideoPts    = layoutDef?.maxVideoParticipants ?? null;
          const audioOverflow  = maxVideoPts !== null ? Math.max(0, totalPts - maxVideoPts) : 0;
          const videoFraction  = (maxVideoPts !== null && totalPts > 0)
            ? Math.min(1, maxVideoPts / totalPts) : 1;

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

            const typeVideoCount = Math.round(typeCount * videoFraction);
            const typeAudioCount = typeCount - typeVideoCount;
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

          const bwAudioMin = totalPts * C.AUDIO_MIN_KBPS;
          const bwAudioMax = totalPts * C.AUDIO_MAX_KBPS;

          let bwPresentationMin = 0, bwPresentationMax = 0;
          if (tmpl.presentationActive && totalPts > 0) {
            const pBw = C.PRESENTATION_BW[tmpl.meetingType] ?? C.PRESENTATION_BW.default;
            bwPresentationMin = pBw.min;
            bwPresentationMax = pBw.max;
          }

          let bwBackplaneMin = 0, bwBackplaneMax = 0;
          if (hasCrossLocation) {
            const lp = C.LAYOUTS[tmpl.layout]?.backplane ?? { hd: 1, thumb: 0 };
            bwBackplaneMin = lp.hd * C.BACKPLANE_HD_MIN_KBPS + lp.thumb * C.BACKPLANE_THUMB_MIN_KBPS;
            bwBackplaneMax = lp.hd * C.BACKPLANE_HD_MAX_KBPS + lp.thumb * C.BACKPLANE_THUMB_MAX_KBPS;
            if (tmpl.presentationActive) {
              bwBackplaneMin += C.BACKPLANE_PRESENTATION_KBPS;
              bwBackplaneMax += C.BACKPLANE_PRESENTATION_KBPS;
            }
          }

          const bwProxyMin = extPts > 0 ? Math.round(bwAccessMin * extProportion) : 0;
          const bwProxyMax = extPts > 0 ? Math.round(bwAccessMax * extProportion) : 0;
          const bwMeetingMin = bwAccessMin + bwAudioMin + bwPresentationMin;
          const bwMeetingMax = bwAccessMax + bwAudioMax + bwPresentationMax;

          let hdComposition = 0;
          const videoVisiblePts = maxVideoPts !== null ? Math.min(totalPts, maxVideoPts) : totalPts;
          if (tmpl.layout === 'adaptive' && videoVisiblePts > 0) {
            hdComposition = C.TEAMS_COMPOSITION_HD_BASE
              + Math.max(0, videoVisiblePts - 3) * C.TEAMS_COMPOSITION_HD_ONSTAGE;
          }

          // Gateway overhead: Teams Connector or Google Meet connection cost per active call
          const gatewayHDPerCall = tmpl.meetingType === 'teams'       ? C.GATEWAY_HD_PER_CALL_TEAMS
                                 : tmpl.meetingType === 'google_meet' ? C.GATEWAY_HD_PER_CALL_GOOGLE_MEET
                                 : 0;
          const hdGateway = totalPts * gatewayHDPerCall;

          // Participants at non-host locations (needed for per-participant gateway backplane)
          const crossLocationPts = (tmpl.participants || [])
            .filter(p => Number(p.count) > 0 && p.locationId && p.locationId !== hostId)
            .reduce((a, p) => a + Number(p.count), 0);

          // Per-meeting backplane HD — per Pexip docs:
          // Every conference on every node in a multi-node deployment reserves 1 HD.
          // Each topology location = one node. All meeting types use the same rule;
          // Teams/Google Meet gateway costs are separate (hdGateway above).
          const isMultiNodeDeployment = locations.length > 1;
          let hdBackplane = 0;
          if (isMultiNodeDeployment) {
            const nodeCount = hasCrossLocation ? (crossLocationCount + 1) : 1;
            hdBackplane = nodeCount * C.BACKPLANE_HD_PER_MEETING;
            if (extPts > 0) hdBackplane += C.BACKPLANE_HD_PER_MEETING; // proxy = extra node boundary
          }

          const hdTotal = hdEndpoints + hdPresentation + hdComposition + hdGateway;
          const loc = locations.find(l => l.id === tmpl.hostLocationId);

          // Interop summary
          const nativeCount = (tmpl.participants || [])
            .filter(p => p.endpointType === tmpl.meetingType)
            .reduce((a, p) => a + (Number(p.count) || 0), 0)
            + (externalCount > 0 && tmpl.externalEndpointType === tmpl.meetingType ? externalCount : 0);
          const interopByType = {};
          (tmpl.participants || [])
            .filter(p => p.endpointType !== tmpl.meetingType && Number(p.count) > 0)
            .forEach(p => {
              interopByType[p.endpointType] = (interopByType[p.endpointType] || 0) + Number(p.count);
            });
          if (externalCount > 0 && tmpl.externalEndpointType !== tmpl.meetingType) {
            interopByType[tmpl.externalEndpointType] =
              (interopByType[tmpl.externalEndpointType] || 0) + externalCount;
          }
          const interopCount = Object.values(interopByType).reduce((a, b) => a + b, 0);

          return {
            id: tmpl.id,
            hostLocationId: tmpl.hostLocationId,
            meetingType: tmpl.meetingType,
            layout: tmpl.layout,
            meetingQualityWeight,
            name: (tmpl.hostLocationId === 'external' ? 'External' : (loc?.name || 'Unknown')) + ' / ' + (C.ENDPOINT_TYPES[tmpl.meetingType]?.label ?? tmpl.meetingType),
            locationName: tmpl.hostLocationId === 'external' ? 'External' : (loc?.name || 'Unknown'),
            endpointLabel: C.ENDPOINT_TYPES[tmpl.meetingType]?.label ?? tmpl.meetingType,
            count: effectiveCount,
            totalPts,
            extPts,
            maxVideoPts,
            audioOverflowPts: audioOverflow,
            hdEndpoints,
            hdPresentation,
            hdComposition,
            hdGateway,
            hdBackplane,
            hdTotal,
            hdTotalAll:        hdTotal        * effectiveCount,
            hdEndpointsAll:    hdEndpoints    * effectiveCount,
            hdPresentationAll: hdPresentation * effectiveCount,
            hdCompositionAll:  hdComposition  * effectiveCount,
            hdGatewayAll:      hdGateway      * effectiveCount,
            hdBackplaneAll:    hdBackplane    * effectiveCount,
            crossLocationPts,
            hasCrossLocation,
            crossLocationCount,
            bwAccessMin, bwAccessMax,
            bwAudioMin, bwAudioMax,
            bwPresentationMin, bwPresentationMax,
            bwBackplaneMin, bwBackplaneMax,
            bwProxyMin, bwProxyMax,
            bwMeetingMin, bwMeetingMax,
            bwMeetingMinAll:   bwMeetingMin   * effectiveCount,
            bwMeetingMaxAll:   bwMeetingMax   * effectiveCount,
            bwBackplaneMinAll: bwBackplaneMin * effectiveCount,
            bwBackplaneMaxAll: bwBackplaneMax * effectiveCount,
            bwProxyMinAll:     bwProxyMin     * effectiveCount,
            bwProxyMaxAll:     bwProxyMax     * effectiveCount,
            nativeCount,
            interopByType,
            interopCount,
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

      // ── step 4: backplane — aggregated from per-meeting hdBackplaneAll ───────
      const backplaneHD = computed(() =>
        meetingResults.value.reduce((a, r) => a + r.hdBackplaneAll, 0)
      );

      // HD load on proxy/edge nodes from forwarded external calls (not added to transcoding demand)
      const proxyHDDemand = computed(() =>
        meetingResults.value.reduce((a, r) =>
          a + r.extPts * C.BACKPLANE_HD_PROXY_PER_CALL * r.count, 0)
      );

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
      const vCPURequired = computed(() => Math.ceil(totalHDWithHeadroom.value));
      // Node count is hardware-derived (floor(total_cores / 22)), not HD-derived
      const transcodingNodeCount = computed(() =>
        Math.max(1, Math.ceil(vCPURequired.value / vCPUPerNode.value))
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
            const ms = meetingResults.value.filter(r => r.hostLocationId === loc.id);
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

        if (cpuSocketCount.value < 2) {
          w.push({
            type: 'numa',
            text: 'Minimum 2 CPU sockets required. Conferencing nodes must be NUMA-pinned to a single socket — single-socket servers cannot safely host Pexip nodes.',
          });
        }
        if (cpuClockGhz.value < C.CPU_MIN_CLOCK_GHZ) {
          w.push({
            type: 'numa',
            text: `Base clock ${cpuClockGhz.value.toFixed(1)} GHz is below the recommended minimum of ${C.CPU_MIN_CLOCK_GHZ} GHz for Pexip conferencing nodes.`,
          });
        }
        const nodesPerSocket = recommendedNodeCount.value / cpuSocketCount.value;
        if (nodesPerSocket > 2) {
          w.push({
            type: 'numa',
            text: `${Math.round(nodesPerSocket)} nodes per socket exceeds the maximum of 2. Pexip only supports up to 2 nodes per socket when ≥44 cores are available per socket.`,
          });
        }
        if (vCPURequired.value > totalAvailableVCPU.value) {
          w.push({
            type: 'numa',
            text: `Insufficient hardware: ${vCPURequired.value} vCPU required but only ${totalAvailableVCPU.value} vCPU available across ${recommendedNodeCount.value} node${recommendedNodeCount.value !== 1 ? 's' : ''}. Add more cores/sockets or reduce meeting demand.`,
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
        poolAllocation.value.filter(e => e.overCommitted).forEach(e => {
          w.push({
            type: 'numa',
            text: `Endpoint pool over-committed — ${e.locationName} / ${e.typeName}: ${e.demand} demanded across templates, only ${e.assigned} assigned. Reduce meeting counts or increase assignments.`,
          });
        });
        return w;
      });

      // ── node recommendation table ─────────────────────────────────────────
      const nodeRecommendations = computed(() => {
        const rows = [];
        const tLocs = numberOfTranscodingLocations.value;
        const vcpu  = vCPUPerNode.value;
        const ram   = ramPerNode.value;

        if (tLocs > 1) {
          const perLoc = Math.ceil(transcodingNodeCount.value / tLocs);
          transcodingLocations.value.forEach(loc => {
            rows.push({
              type: 'Transcoding', location: loc.name || 'Unnamed',
              count: perLoc, vcpu, ram,
              note: `${loc.name || 'Location'} — ${vcpu} vCPU / ${ram} GB RAM each`,
            });
          });
        } else {
          rows.push({
            type: 'Transcoding', location: null,
            count: transcodingNodeCount.value, vcpu, ram,
            note: `Handles media mixing — ${vcpu} vCPU / ${ram} GB RAM each`,
          });
        }
        if (totalDefinedProxyNodes.value > 0) {
          rows.push({
            type: 'Proxy / Edge', location: null,
            count: totalDefinedProxyNodes.value, vcpu: C.PROXY_NODE_VCPU, ram: C.PROXY_NODE_VCPU,
            note: `DMZ-facing, forwards media to transcoding nodes — ${fmtHD(proxyHDDemand.value)} HD demand across proxy nodes`,
          });
        }
        if (totalDefinedExternalNodes.value > 0) {
          rows.push({
            type: 'External', location: null,
            count: totalDefinedExternalNodes.value, vcpu: C.PROXY_NODE_VCPU, ram: C.PROXY_NODE_VCPU,
            note: 'Public-facing, routes external calls inbound',
          });
        }
        rows.push({ type: 'Management', location: null, count: 1, vcpu: 8, ram: 8, note: 'Recommended 8 vCPU / 8 GB for API & integrations' });
        return rows;
      });

      // ── lookup tables exposed to template ─────────────────────────────────
      const EFFICIENCY_BASE = { avx2: 4.0, avx512: 6.0 };
      const HV_FACTORS      = { vmware: 1.0, kvm: 0.95, hyperv: 0.90, cloud: 1.0 };
      const CPU_MIN_CLOCK   = C.CPU_MIN_CLOCK_GHZ;

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
        poolAllocation,
        duplicateTemplate,
        addBlankTemplate,
        removeMeetingTemplate,

        // hardware state
        cpuInstructionSet,
        cpuClockGhz,
        cpuCoresPerSocket,
        cpuSocketCount,
        hyperthreading,
        hypervisor,

        // hardware capacity (computed)
        totalPhysicalCores,
        totalAvailableVCPU,
        recommendedNodeCount,
        vCPUPerNode,
        ramPerNode,

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
        proxyHDDemand,
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
        toggleLocationNodes,

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
        CPU_MIN_CLOCK,

        // formatters
        fmtHD,
        fmtKbps,
        fmtRange,
      };
    },
  }).mount('#app');

})();
