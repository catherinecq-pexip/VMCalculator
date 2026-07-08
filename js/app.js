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
        { type: 'google_meet',        count: 0, quality: '720p',  codec: 'vp8'  },
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
      // allNodeDefinitions: one entry per node definition (not multiplied by server quantity)
      // allNodes: quantity-multiplied — used for counts and capacity calculations
      const allNodeDefinitions = computed(() => servers.flatMap(s =>
        s.nodes.map(n => ({ ...n, locationId: n.locationId ?? s.locationId, _serverId: s.id }))
      ));
      const allNodes = computed(() =>
        servers.flatMap(s => {
          const resolved = s.nodes.map(n => ({ ...n, locationId: n.locationId ?? s.locationId }));
          if (s.quantity <= 1) return resolved;
          return Array.from({ length: s.quantity }, () => resolved).flat();
        })
      );
      const totalDefinedTranscodingNodes = computed(() => allNodes.value.filter(n => n.role === 'transcoding').length);
      const totalDefinedProxyNodes       = computed(() => allNodes.value.filter(n => n.role === 'proxy').length);
      const totalDefinedExternalNodes    = computed(() => allNodes.value.filter(n => n.role === 'external').length);
      const transcodingLocations         = computed(() =>
        locations.filter(loc => allNodes.value.some(n => n.role === 'transcoding' && n.locationId === loc.id))
      );
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

      // Pick the best default location for an endpoint type given a host location context.
      // Prefers the host location if it has any of this type assigned; otherwise the
      // location with the highest assignment count; null if no location has any.
      function defaultLocationForType(type, hostLocationId) {
        const hostLoc = locations.find(l => l.id === hostLocationId);
        if (hostLoc && Number(hostLoc.endpointAssignments?.[type]) > 0) return hostLocationId;
        let best = null, bestCount = 0;
        locations.forEach(l => {
          const n = Number(l.endpointAssignments?.[type]) || 0;
          if (n > bestCount) { bestCount = n; best = l.id; }
        });
        return best;
      }

      // Build participant rows for a new template (one row per active endpoint type)
      function buildParticipantRows(meetingType, hostLocationId) {
        return endpointRows
          .filter(r => Number(r.count) > 0)
          .map(r => ({
            endpointType: r.type,
            locationId: defaultLocationForType(r.type, hostLocationId),
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
                externalParticipants: [],
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
                tmpl.participants.push({ endpointType: type, locationId: defaultLocationForType(type, tmpl.hostLocationId), count: 0 });
              }
            });
          });
        }
      );

      // When topology assignments change, fill any participant rows still showing null.
      // Runs in the same Vue flush cycle as the auto-generate watch, so newly created
      // templates are also healed. Only null rows are touched — user-set locations are preserved.
      watch(
        () => locations.map(l => l.endpointAssignments),
        () => {
          meetingTemplates.forEach(tmpl => {
            tmpl.participants.forEach(p => {
              if (p.locationId === null) {
                const best = defaultLocationForType(p.endpointType, tmpl.hostLocationId);
                if (best !== null) p.locationId = best;
              }
            });
          });
        },
        { deep: true }
      );

      function duplicateTemplate(id) {
        const orig = meetingTemplates.find(t => t.id === id);
        if (!orig) return;
        meetingTemplates.push({
          ...orig,
          id: Date.now() + Math.floor(Math.random() * 1000),
          _autoKey: false,
          participants: orig.participants.map(p => ({ ...p })),
          externalParticipants: (orig.externalParticipants || []).map(p => ({ ...p })),
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
          externalParticipants: [],
          layout: '1+7',
          presentationActive: true,
          meetingCount: 1,
          expanded: true,
        });
      }
      function addExternalParticipant(id) {
        const tmpl = meetingTemplates.find(t => t.id === id);
        if (!tmpl) return;
        const defaultType = endpointRows.find(r => Number(r.count) > 0)?.type || 'sip_h323';
        tmpl.externalParticipants.push({ count: 0, endpointType: defaultType });
      }
      function removeExternalParticipant(id, index) {
        const tmpl = meetingTemplates.find(t => t.id === id);
        if (tmpl) tmpl.externalParticipants.splice(index, 1);
      }

      function removeMeetingTemplate(id) {
        const idx = meetingTemplates.findIndex(t => t.id === id);
        if (idx !== -1) meetingTemplates.splice(idx, 1);
      }

      // ── hardware builder — server fleet ───────────────────────────────────
      const servers     = reactive([]);
      const hwActiveTab = ref('servers');

      function uid() { return Date.now() + Math.floor(Math.random() * 10000); }

      function roundToStandardRAM(gb) {
        for (const sz of [8, 16, 32, 64, 128, 256]) { if (sz >= gb) return sz; }
        return 256;
      }

      // Compute K coefficient and all intermediate scores for a server + node combination
      function computeK(server, node) {
        const vCPU             = node?.vCPU ?? 48;
        const threadsPerSocket = server.physicalCoresPerSocket * (server.hyperthreading ? 2 : 1);
        const cpuCacheMB       = server.cpuCacheMB ?? 36;
        const cachePerThread   = vCPU > 0 ? cpuCacheMB / vCPU : 0;

        const maxCh  = server.maxMemoryChannelsPerSocket   ?? null;
        const popCh  = server.populatedMemoryChannelsPerSocket ?? null;
        const memChannelRatio = (maxCh != null && popCh != null && maxCh > 0)
          ? popCh / maxCh : null;

        let instructionSetScore = 0;
        if      (server.instructionSet === 'avx512') instructionSetScore = 0.04;
        else if (server.instructionSet === 'avx2')   instructionSetScore = 0.02;

        let baseClockScore = 0;
        if      (server.baseClockGhz < 2.3) baseClockScore = -0.05;
        else if (server.baseClockGhz < 2.6) baseClockScore = -0.02;
        else if (server.baseClockGhz < 2.9) baseClockScore =  0.02;
        else                                 baseClockScore =  0.04;

        let cacheScore = 0;
        if      (cachePerThread < 0.50) cacheScore = -0.02;
        else if (cachePerThread < 0.75) cacheScore =  0.00;
        else if (cachePerThread < 1.25) cacheScore =  0.02;
        else                             cacheScore =  0.04;

        let memChannelWidthScore = 0;
        if (maxCh != null) {
          if      (maxCh >= 8)  memChannelWidthScore =  0.03;
          else if (maxCh === 6) memChannelWidthScore = -0.06;
          else if (maxCh <= 4)  memChannelWidthScore = -0.08;
        }

        let memChannelPopScore = 0;
        if (memChannelRatio !== null) {
          if      (memChannelRatio >= 1.00) memChannelPopScore =  0.00;
          else if (memChannelRatio >= 0.75) memChannelPopScore = -0.03;
          else                               memChannelPopScore = -0.08;
        }

        let nodeSizeScore = 0;
        if      (vCPU > 56)  nodeSizeScore = -0.06;
        else if (vCPU >= 49) nodeSizeScore = -0.02;

        const rawK = C.BASE_COEFF + instructionSetScore + baseClockScore + cacheScore
          + memChannelWidthScore + memChannelPopScore + nodeSizeScore;

        // Projected eligibility — all conditions must hold to unlock higher ceiling
        const projectedEligible = (
          server.instructionSet === 'avx512' &&
          maxCh != null && popCh != null &&
          maxCh >= 8 &&
          Number(popCh) === Number(maxCh) &&
          cachePerThread >= 1.25 &&
          server.baseClockGhz >= 2.6 &&
          vCPU >= 4 && vCPU <= 56 &&
          (node?.ram ?? 0) >= vCPU
        );

        const inferredEstimateMode = projectedEligible ? 'Projected'                    : 'Conservative';
        const modeAdjustment       = projectedEligible ? C.PROJECTED_MODE_ADJUSTMENT     : 0;
        const selectedCeiling      = projectedEligible ? C.COEFF_CEILING_PROJECTED       : C.COEFF_CEILING_CONSERVATIVE;
        const K = Math.max(C.COEFF_FLOOR, Math.min(selectedCeiling, rawK + modeAdjustment));

        return {
          K,
          rawK,
          inferredEstimateMode,
          modeAdjustment,
          selectedCeiling,
          threadsPerSocket,
          cachePerThread,
          memChannelRatio,
          instructionSetScore,
          baseClockScore,
          cacheScore,
          memChannelWidthScore,
          memChannelPopScore,
          nodeSizeScore,
          memChannelsMissing:    maxCh == null || popCh == null,
          instructionSetUnknown: !server.instructionSet || server.instructionSet === 'unknown' || server.instructionSet === 'avx',
        };
      }

      // HD capacity contributed by one transcoding node, given its server's specs
      function nodeHDCapacity(node, server) {
        if (node.role !== 'transcoding') return 0;
        const { K } = computeK(server, node);
        return Math.floor(node.vCPU * server.baseClockGhz * K);
      }

      // Look up a node's server and return its HD capacity (used from template + Section 2)
      function serverNodeHD(node) {
        const server = servers.find(s => s.nodes.some(n => n.id === node.id));
        return server ? nodeHDCapacity(node, server) : 0;
      }

      function addServer() {
        servers.push({
          id:                   uid(),
          name:                 '',
          quantity:             1,
          locationId:           null,
          expanded:             true,
          nodesExpanded:        true,
          socketsPerServer:     2,
          physicalCoresPerSocket: 24,
          baseClockGhz:         3.0,
          hyperthreading:       false,
          cpuCacheMB:           36,
          instructionSet:       'avx2',
          totalRAM:             64,
          maxMemoryChannelsPerSocket:    8,
          populatedMemoryChannelsPerSocket: 8,
          nodes:                [],
        });
      }

      function removeServer(id) {
        const idx = servers.findIndex(s => s.id === id);
        if (idx !== -1) servers.splice(idx, 1);
      }

      function duplicateServer(id) {
        const orig = servers.find(s => s.id === id);
        if (!orig) return;
        servers.push({
          ...orig,
          id:    uid(),
          nodes: orig.nodes.map(n => ({ ...n, id: uid() })),
        });
      }

      function toggleServer(id) {
        const s = servers.find(sv => sv.id === id);
        if (s) s.expanded = !s.expanded;
      }

      function addNodeToServer(serverId) {
        const server = servers.find(s => s.id === serverId);
        if (!server) return;
        const threadsPerSocket = server.physicalCoresPerSocket * (server.hyperthreading ? 2 : 1);
        // Find first socket with available capacity
        let socket = 1;
        for (let i = 1; i <= server.socketsPerServer; i++) {
          const used = server.nodes
            .filter(n => n.socketNUMA === i)
            .reduce((a, n) => a + n.vCPU, 0);
          if (used < threadsPerSocket) { socket = i; break; }
        }
        const vCPU = threadsPerSocket;
        const ram  = roundToStandardRAM(vCPU);
        server.nodes.push({
          id:         uid(),
          name:       '',
          role:       'transcoding',
          socketNUMA: socket,
          vCPU,
          ram,
          locationId: null, // inherits server's locationId
        });
      }

      function removeNodeFromServer(serverId, nodeId) {
        const server = servers.find(s => s.id === serverId);
        if (!server) return;
        const idx = server.nodes.findIndex(n => n.id === nodeId);
        if (idx !== -1) server.nodes.splice(idx, 1);
      }

      function applyRoleDefaults(node, server) {
        if (node.role === 'management') {
          node.vCPU = 8;
          node.ram  = 8;
        } else if (node.role === 'proxy') {
          node.vCPU = 4;
          node.ram  = 4;
        } else {
          const threads = server.physicalCoresPerSocket * (server.hyperthreading ? 2 : 1);
          node.vCPU = threads;
          node.ram  = roundToStandardRAM(threads);
        }
      }

      // When switching to "Configure Nodes" tab, expand all server node sections
      watch(hwActiveTab, (tab) => {
        if (tab === 'nodes') servers.forEach(s => { s.nodesExpanded = true; });
      });

      // Primary server = first defined server (used for hdEstimateResult and per-node display)
      const primaryServer = computed(() => servers[0] ?? null);

      // Total vCPU capacity across all servers (quantity-weighted)
      const totalAvailableVCPU = computed(() =>
        servers.reduce((acc, s) => {
          const threads = s.physicalCoresPerSocket * (s.hyperthreading ? 2 : 1);
          return acc + s.quantity * s.socketsPerServer * threads;
        }, 0)
      );

      // Average vCPU per transcoding node (or fallback estimate from primary server specs)
      const vCPUPerNode = computed(() => {
        const tNodes = allNodeDefinitions.value.filter(n => n.role === 'transcoding');
        if (tNodes.length === 0) {
          const s = primaryServer.value;
          if (!s) return 48;
          const cores     = s.socketsPerServer * s.physicalCoresPerSocket;
          const nodeCount = Math.max(1, Math.floor(cores / C.CORES_PER_NODE_TARGET));
          return Math.ceil(cores / nodeCount) * (s.hyperthreading ? 2 : 1);
        }
        return Math.round(tNodes.reduce((a, n) => a + n.vCPU, 0) / tNodes.length);
      });

      // Average RAM per transcoding node (or fallback)
      const ramPerNode = computed(() => {
        const tNodes = allNodeDefinitions.value.filter(n => n.role === 'transcoding');
        if (tNodes.length === 0) return roundToStandardRAM(vCPUPerNode.value);
        return Math.round(tNodes.reduce((a, n) => a + n.ram, 0) / tNodes.length);
      });

      // HD capacity of one transcoding node — threshold for intra-location multi-node spill
      const nodeCapacityHD = computed(() => {
        const s = primaryServer.value;
        if (!s) return vCPUPerNode.value; // fallback: 1 HD ≈ 1 vCPU
        const tNodes = allNodeDefinitions.value.filter(n => n.role === 'transcoding');
        const repVCPU = tNodes.length > 0
          ? Math.round(tNodes.reduce((a, n) => a + n.vCPU, 0) / tNodes.length)
          : vCPUPerNode.value;
        const repRAM = tNodes.length > 0
          ? Math.round(tNodes.reduce((a, n) => a + n.ram, 0) / tNodes.length)
          : repVCPU;
        const { K } = computeK(s, { vCPU: repVCPU, ram: repRAM });
        return Math.max(1, Math.floor(repVCPU * s.baseClockGhz * K));
      });

      // ── server allocation computeds ───────────────────────────────────────

      // Per-server breakdown of vCPU, RAM, HD, and per-socket thread usage
      const serverAllocations = computed(() =>
        servers.map(s => {
          const threadsPerSocket = s.physicalCoresPerSocket * (s.hyperthreading ? 2 : 1);
          const totalVCPU        = s.socketsPerServer * threadsPerSocket;
          const allocatedVCPU    = s.nodes.reduce((a, n) => a + n.vCPU, 0);
          const allocatedRAM     = s.nodes.reduce((a, n) => a + n.ram, 0);
          const hdPerServer      = s.nodes
            .filter(n => n.role === 'transcoding')
            .reduce((a, n) => a + nodeHDCapacity(n, s), 0);

          const socketBreakdown = Array.from({ length: s.socketsPerServer }, (_, i) => {
            const sock = i + 1;
            const used = s.nodes
              .filter(n => n.socketNUMA === sock)
              .reduce((a, n) => a + n.vCPU, 0);
            return { socket: sock, used, total: threadsPerSocket, remaining: threadsPerSocket - used };
          });

          return {
            id: s.id, name: s.name, quantity: s.quantity,
            totalVCPU, allocatedVCPU, remainingVCPU: totalVCPU - allocatedVCPU,
            totalRAM: s.totalRAM, allocatedRAM, remainingRAM: s.totalRAM - allocatedRAM,
            hdPerServer, totalHD: hdPerServer * s.quantity,
            socketBreakdown,
          };
        })
      );

      // Physical Capacity Summary table (one row per server group)
      const physicalCapacitySummary = computed(() =>
        servers.map((s, idx) => {
          const loc   = locations.find(l => l.id === s.locationId);
          const alloc = serverAllocations.value[idx];
          return {
            name:           s.name || ('Server ' + (idx + 1)),
            locationName:   loc?.name || '—',
            quantity:       s.quantity,
            nodesPerServer: s.nodes.filter(n => n.role === 'transcoding').length,
            rawHDPerServer: alloc.hdPerServer,
            totalRawHD:     alloc.hdPerServer * s.quantity,
          };
        })
      );

      const totalRawHDCapacity = computed(() =>
        physicalCapacitySummary.value.reduce((a, r) => a + r.totalRawHD, 0)
      );

      // Global allocation summary (shown in the section header chips)
      const hwAllocationSummary = computed(() => ({
        totalServers:       servers.length,
        totalTranscoding:   allNodes.value.filter(n => n.role === 'transcoding').length,
        totalProxy:         allNodes.value.filter(n => n.role === 'proxy').length,
        totalManagement:    allNodes.value.filter(n => n.role === 'management').length,
        totalHDCapacity:    totalRawHDCapacity.value,
        totalVCPUAllocated: servers.reduce((a, s) =>
          a + s.nodes.reduce((b, n) => b + n.vCPU, 0) * s.quantity, 0),
        totalVCPUCapacity:  totalAvailableVCPU.value,
        totalRAMAllocated:  servers.reduce((a, s) =>
          a + s.nodes.reduce((b, n) => b + n.ram, 0) * s.quantity, 0),
        totalRAMCapacity:   servers.reduce((a, s) => a + s.totalRAM * s.quantity, 0),
      }));

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
          (tmpl.externalParticipants || []).forEach(p => {
            const n = Number(p.count) || 0;
            if (n > 0 && p.endpointType) {
              participantEndpoints[p.endpointType] = (participantEndpoints[p.endpointType] || 0) + n;
            }
          });
          const totalPts      = Object.values(participantEndpoints).reduce((a, b) => a + b, 0);
          const extPts        = (tmpl.externalParticipants || []).reduce((a, p) => a + (Number(p.count) || 0), 0);
          const extProportion = totalPts > 0 ? extPts / totalPts : 0;

          // Only SIP/H.323 and WebRTC meetings are hosted on Pexip Infinity itself.
          // For external-hosted meetings (Teams, Google Meet, Zoom, SfB), native participants
          // of the host platform don't route through Pexip and consume no Pexip HD resources.
          const PEXIP_NATIVE_TYPES = new Set(['sip_h323', 'webrtc']);
          const isExternalHosted = !PEXIP_NATIVE_TYPES.has(tmpl.meetingType);
          const pexipParticipantEndpoints = isExternalHosted
            ? { ...participantEndpoints, [tmpl.meetingType]: 0 }
            : participantEndpoints;
          const pexipPts = Object.values(pexipParticipantEndpoints).reduce((a, b) => a + b, 0);

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
          const audioOverflow  = maxVideoPts !== null ? Math.max(0, pexipPts - maxVideoPts) : 0;
          const videoFraction  = (maxVideoPts !== null && pexipPts > 0)
            ? Math.min(1, maxVideoPts / pexipPts) : 1;

          // HD & access bandwidth per endpoint type
          let hdEndpoints = 0, hdPresentation = 0;
          let bwAccessMin = 0, bwAccessMax = 0;

          endpointRows.forEach(row => {
            const typeCount = Number(pexipParticipantEndpoints[row.type]) || 0;
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
            const qualityCap = C.QUALITY_MAX_KBPS[row.quality] ?? C.PARTICIPANT_MAX_KBPS;
            const bwMax      = Math.min(qualityCap,
              C.BANDWIDTH_TABLE_MAX[bwKey] ?? C.BANDWIDTH_TABLE_MAX[bwFallback] ?? bwMin);
            bwAccessMin += typeCount * bwMin;
            bwAccessMax += typeCount * bwMax;
          });

          const bwAudioMin = pexipPts * C.AUDIO_MIN_KBPS;
          const bwAudioMax = pexipPts * C.AUDIO_MAX_KBPS;

          let bwPresentationMin = 0, bwPresentationMax = 0;
          if (tmpl.presentationActive && pexipPts > 0) {
            const pBw = C.PRESENTATION_BW[tmpl.meetingType] ?? C.PRESENTATION_BW.default;
            bwPresentationMin = pBw.min;
            bwPresentationMax = pBw.max;
          }

          const bwProxyMin = extPts > 0 ? Math.round(bwAccessMin * extProportion) : 0;
          const bwProxyMax = extPts > 0 ? Math.round(bwAccessMax * extProportion) : 0;
          const bwMeetingMin = bwAccessMin + bwAudioMin + bwPresentationMin;
          const bwMeetingMax = bwAccessMax + bwAudioMax + bwPresentationMax;

          let hdComposition = 0;
          const videoVisiblePts = maxVideoPts !== null ? Math.min(pexipPts, maxVideoPts) : pexipPts;
          if (tmpl.layout === 'adaptive' && videoVisiblePts > 0) {
            hdComposition = C.TEAMS_COMPOSITION_HD_BASE
              + Math.max(0, videoVisiblePts - 3) * C.TEAMS_COMPOSITION_HD_ONSTAGE;
          }

          // Gateway overhead: Teams Connector or Google Meet connection cost per active call
          const gatewayHDPerCall = tmpl.meetingType === 'teams'       ? C.GATEWAY_HD_PER_CALL_TEAMS
                                 : tmpl.meetingType === 'google_meet' ? C.GATEWAY_HD_PER_CALL_GOOGLE_MEET
                                 : 0;
          const hdGateway = pexipPts * gatewayHDPerCall;

          // hdTotal must be computed before backplane so nodesForMeeting can be derived
          const hdTotal = hdEndpoints + hdPresentation + hdComposition + hdGateway;

          // Participants at non-host locations (needed for per-participant gateway backplane)
          const crossLocationPts = (tmpl.participants || [])
            .filter(p => Number(p.count) > 0 && p.locationId && p.locationId !== hostId)
            .reduce((a, p) => a + Number(p.count), 0);

          // Intra-location node spill: if hdTotal exceeds one node's capacity, extra nodes are
          // needed at the host location and each pair requires its own backplane connection.
          const nodesForMeeting = Math.max(1, Math.ceil(hdTotal / nodeCapacityHD.value));
          const totalNodes      = nodesForMeeting + (hasCrossLocation ? crossLocationCount : 0);

          // Per-meeting backplane HD — every node involved reserves 1 HD per meeting.
          // Triggers for cross-location, intra-location multi-node, or proxy boundaries.
          // Teams/Google Meet gateway costs are separate (hdGateway above).
          const isMultiNodeMeeting = totalNodes > 1 || extPts > 0;
          let hdBackplane = 0;
          if (isMultiNodeMeeting) {
            hdBackplane = totalNodes * C.BACKPLANE_HD_PER_MEETING;
            if (extPts > 0) hdBackplane += C.BACKPLANE_HD_PER_MEETING; // proxy = extra node boundary
          }

          // Backplane BW: one link set per node boundary.
          // Links = (nodesForMeeting − 1) intra-location + crossLocationCount cross-location.
          const totalBackplaneLinks = (nodesForMeeting - 1) + (hasCrossLocation ? crossLocationCount : 0);
          let bwBackplaneMin = 0, bwBackplaneMax = 0;
          if (totalBackplaneLinks > 0) {
            const lp = C.LAYOUTS[tmpl.layout]?.backplane ?? { hd: 1, thumb: 0 };
            bwBackplaneMin = totalBackplaneLinks * (lp.hd * C.BACKPLANE_HD_MIN_KBPS + lp.thumb * C.BACKPLANE_THUMB_MIN_KBPS);
            bwBackplaneMax = totalBackplaneLinks * (lp.hd * C.BACKPLANE_HD_MAX_KBPS + lp.thumb * C.BACKPLANE_THUMB_MAX_KBPS);
            if (tmpl.presentationActive) {
              bwBackplaneMin += C.BACKPLANE_PRESENTATION_KBPS;
              bwBackplaneMax += C.BACKPLANE_PRESENTATION_KBPS;
            }
          }

          const loc = locations.find(l => l.id === tmpl.hostLocationId);

          // Interop summary
          const nativeCount = (tmpl.participants || [])
            .filter(p => p.endpointType === tmpl.meetingType)
            .reduce((a, p) => a + (Number(p.count) || 0), 0)
            + (tmpl.externalParticipants || [])
                .filter(p => p.endpointType === tmpl.meetingType)
                .reduce((a, p) => a + (Number(p.count) || 0), 0);
          const interopByType = {};
          (tmpl.participants || [])
            .filter(p => p.endpointType !== tmpl.meetingType && Number(p.count) > 0)
            .forEach(p => {
              interopByType[p.endpointType] = (interopByType[p.endpointType] || 0) + Number(p.count);
            });
          (tmpl.externalParticipants || [])
            .filter(p => p.endpointType !== tmpl.meetingType && Number(p.count) > 0)
            .forEach(p => {
              interopByType[p.endpointType] = (interopByType[p.endpointType] || 0) + Number(p.count);
            });
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
            pexipPts,
            extPts,
            maxVideoPts,
            audioOverflowPts: audioOverflow,
            hdEndpoints,
            hdPresentation,
            hdComposition,
            hdGateway,
            hdBackplane,
            hdTotal,
            nodesForMeeting,
            totalNodes,
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
            bwVideoMinAll:        bwAccessMin       * effectiveCount,
            bwVideoMaxAll:        bwAccessMax       * effectiveCount,
            bwAudioMinAll:        bwAudioMin        * effectiveCount,
            bwAudioMaxAll:        bwAudioMax        * effectiveCount,
            bwPresentationMinAll: bwPresentationMin * effectiveCount,
            bwPresentationMaxAll: bwPresentationMax * effectiveCount,
            bwMeetingMinAll:      bwMeetingMin      * effectiveCount,
            bwMeetingMaxAll:      bwMeetingMax      * effectiveCount,
            bwBackplaneMinAll:    bwBackplaneMin    * effectiveCount,
            bwBackplaneMaxAll:    bwBackplaneMax    * effectiveCount,
            bwProxyMinAll:        bwProxyMin        * effectiveCount,
            bwProxyMaxAll:        bwProxyMax        * effectiveCount,
            backplaneHdStreams:    hasCrossLocation ? (C.LAYOUTS[tmpl.layout]?.backplane?.hd    ?? 1) : 0,
            backplaneThumbStreams: hasCrossLocation ? (C.LAYOUTS[tmpl.layout]?.backplane?.thumb ?? 0) : 0,
            bwPerPtMin: pexipPts > 0 ? Math.round(bwMeetingMin / pexipPts) : 0,
            bwPerPtMax: pexipPts > 0 ? Math.round(bwMeetingMax / pexipPts) : 0,
            crossLocationNames: (tmpl.participants || [])
              .filter(p => Number(p.count) > 0 && p.locationId && p.locationId !== hostId)
              .reduce((acc, p) => {
                const ln = locations.find(l => l.id === p.locationId)?.name || 'Unknown';
                if (!acc.includes(ln)) acc.push(ln);
                return acc;
              }, []),
            nativeCount,
            interopByType,
            interopCount,
          };
        })
      );

      // ── derived meeting totals ────────────────────────────────────────────
      const numberOfMeetings  = computed(() => meetingTemplates.reduce((a, t) => a + effectiveCountForTemplate(t), 0));

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

      // ── step 6: HD estimate result — for the Estimated Raw HD Capacity card ──
      const hdEstimateResult = computed(() => {
        const s = primaryServer.value;
        if (!s) return null;
        const tNodes = s.nodes.filter(n => n.role === 'transcoding');
        const repVCPU = tNodes.length > 0
          ? Math.round(tNodes.reduce((a, n) => a + n.vCPU, 0) / tNodes.length)
          : vCPUPerNode.value;
        const repRAM = tNodes.length > 0
          ? Math.round(tNodes.reduce((a, n) => a + n.ram, 0) / tNodes.length)
          : repVCPU;
        const kResult = computeK(s, { vCPU: repVCPU, ram: repRAM });
        const nodeRawHD = Math.floor(repVCPU * s.baseClockGhz * kResult.K);
        const totalTNodes = allNodes.value.filter(n => n.role === 'transcoding').length;
        return {
          ...kResult,
          assignedVCPU: repVCPU,
          numberOfNodes: totalTNodes,
          nodeRawHD,
          totalRawHD: totalRawHDCapacity.value,
        };
      });

      // ── step 7: vCPU + node count ─────────────────────────────────────────
      // Node count: use user-defined transcoding nodes when available; fall back to
      // totalHDWithHeadroom ÷ nodeCapacityHD (K-adjusted), matching the per-meeting
      // nodesForMeeting denominator so both counts are on the same scale.
      const transcodingNodeCount = computed(() => {
        const defined = allNodes.value.filter(n => n.role === 'transcoding').length;
        return defined || Math.max(1, Math.ceil(totalHDWithHeadroom.value / nodeCapacityHD.value));
      });
      // vCPU required = recommended node count × vCPU per node (actual fleet commitment).
      const vCPURequired = computed(() => transcodingNodeCount.value * vCPUPerNode.value);
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
              id:            loc.id,
              name:          loc.name || 'Unnamed',
              localMin:      ms.reduce((a, r) => a + r.bwMeetingMinAll,   0),
              localMax:      ms.reduce((a, r) => a + r.bwMeetingMaxAll,   0),
              wanMin:        ms.reduce((a, r) => a + r.bwBackplaneMinAll, 0),
              wanMax:        ms.reduce((a, r) => a + r.bwBackplaneMaxAll, 0),
              proxyMin:      ms.reduce((a, r) => a + r.bwProxyMinAll,     0),
              proxyMax:      ms.reduce((a, r) => a + r.bwProxyMaxAll,     0),
              crossMeetings: ms.filter(r => r.hasCrossLocation).length,
              totalMin:      ms.reduce((a, r) => a + r.bwMeetingMinAll + r.bwBackplaneMinAll + r.bwProxyMinAll, 0),
              totalMax:      ms.reduce((a, r) => a + r.bwMeetingMaxAll + r.bwBackplaneMaxAll + r.bwProxyMaxAll, 0),
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

      // ── proxy endpoint type aggregation ──────────────────────────────────
      const proxyEndpointTypes = computed(() => {
        const types = new Set();
        meetingTemplates.forEach(tmpl => {
          (tmpl.externalParticipants || []).forEach(p => {
            if (Number(p.count) > 0 && p.endpointType)
              types.add(C.ENDPOINT_TYPES[p.endpointType]?.label ?? p.endpointType);
          });
        });
        return [...types];
      });

      // ── warnings ──────────────────────────────────────────────────────────
      const warnings = computed(() => {
        const w = [];

        // Per-server hardware warnings
        servers.forEach((s, idx) => {
          const alloc = serverAllocations.value[idx];
          const label = s.name || ('Server ' + (idx + 1));

          if (s.socketsPerServer < 2) {
            w.push({ type: 'numa', text: `${label}: Minimum 2 CPU sockets required. Conferencing nodes must be NUMA-pinned to a single socket.` });
          }
          if (s.baseClockGhz < C.CPU_MIN_CLOCK_GHZ) {
            w.push({ type: 'numa', text: `${label}: Base clock ${s.baseClockGhz.toFixed(1)} GHz is below the recommended minimum of ${C.CPU_MIN_CLOCK_GHZ} GHz for Pexip nodes.` });
          }
          if (alloc.remainingVCPU < 0) {
            w.push({ type: 'numa', text: `${label}: Over-allocated by ${Math.abs(alloc.remainingVCPU)} vCPU (${alloc.allocatedVCPU} allocated, ${alloc.totalVCPU} available). Reduce node vCPU or add more sockets.` });
          }
          if (alloc.remainingRAM < 0) {
            w.push({ type: 'numa', text: `${label}: Over-allocated by ${Math.abs(alloc.remainingRAM)} GB RAM (${alloc.allocatedRAM} GB allocated, ${s.totalRAM} GB available).` });
          }
          alloc.socketBreakdown.forEach(sock => {
            if (sock.remaining < 0) {
              w.push({ type: 'numa', text: `${label} Socket ${sock.socket}: ${sock.used} vCPU assigned but only ${sock.total} threads available.` });
            }
          });
          if (s.hyperthreading) {
            w.push({ type: 'ht', text: `${label}: Hyperthreading bonus applied. Requires NUMA-pinned VM affinity. Disable vMotion / Live Migration when using CPU pinning.` });
          }
        });

        // Deployment-wide hardware capacity vs demand
        if (servers.length > 0 && totalRawHDCapacity.value < totalHDWithHeadroom.value && totalHDWithHeadroom.value > 0) {
          w.push({ type: 'numa', text: `Hardware HD capacity (${fmtHD(totalRawHDCapacity.value)} HD) is less than required capacity with headroom (${fmtHD(totalHDWithHeadroom.value)} HD). Add more servers or transcoding nodes.` });
        }
        if (servers.length > 0 && totalAvailableVCPU.value > 0 && vCPURequired.value > totalAvailableVCPU.value) {
          w.push({ type: 'numa', text: `Insufficient hardware: ${vCPURequired.value} vCPU required but only ${totalAvailableVCPU.value} vCPU available. Add more servers or increase socket/core counts.` });
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
      const CPU_MIN_CLOCK = C.CPU_MIN_CLOCK_GHZ;

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
        addExternalParticipant,
        removeExternalParticipant,

        // hardware builder state
        servers,
        hwActiveTab,
        primaryServer,

        // hardware builder actions
        addServer,
        removeServer,
        duplicateServer,
        toggleServer,
        addNodeToServer,
        removeNodeFromServer,
        applyRoleDefaults,
        serverNodeHD,

        // hardware builder computeds
        totalAvailableVCPU,
        vCPUPerNode,
        nodeCapacityHD,
        ramPerNode,
        serverAllocations,
        physicalCapacitySummary,
        totalRawHDCapacity,
        hwAllocationSummary,
        allNodeDefinitions,

        // computed — endpoint ref data
        rowResults,
        hasInterop,

        // computed — meeting totals
        numberOfMeetings,

        // computed — resource pipeline
        totalHDRaw,
        totalHDWithHeadroom,
        backplaneHD,
        proxyHDDemand,
        hdEstimateResult,
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
        proxyEndpointTypes,
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
        toggleLocation,
        toggleLocationNodes,

        // constants for template
        LAYOUTS:                  C.LAYOUTS,
        ENDPOINT_TYPES:           C.ENDPOINT_TYPES,
        ENDPOINT_CODEC:           C.ENDPOINT_CODEC,
        ENDPOINT_QUALITY_OPTIONS: C.ENDPOINT_QUALITY_OPTIONS,
        NODE_SIZES:               C.NODE_SIZES,
        NODE_ROLES:               C.NODE_ROLES,
        NODE_ROLES_HW:            C.NODE_ROLES_HW,
        QUALITY_LABELS:           C.QUALITY_LABELS,
        CPU_MIN_CLOCK,

        // formatters
        fmtHD,
        fmtKbps,
        fmtRange,
      };
    },
  }).mount('#app');

})();
