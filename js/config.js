// Pexip capacity constants — loaded as a plain script before app.js
// All values exposed on window.PEXIP for access from app.js

window.PEXIP = {

  // Normalise everything to HD (720p) equivalents
  QUALITY_WEIGHTS: {
    '1080p': 2.0,
    '720p':  1.0,
    'sd':    0.5,
    'audio': 0.0625, // 1/16
  },

  // VP9 codec: same bandwidth savings but +25% node resource cost
  VP9_RESOURCE_FACTOR: 1.25,

  // Bandwidth per stream in kbps (video only; audio adds up to 64 kbps per stream)
  // VP8 ≈ H.264 bandwidth; VP9 saves ~33% vs H.264 at same resolution
  BANDWIDTH_TABLE: {
    '1080p-h264': 2400,
    '1080p-vp8':  2400,
    '1080p-vp9':  1600,
    '720p-h264':  960,
    '720p-vp8':   960,
    '720p-vp9':   640,
    'sd-h264':    448,
    'sd-vp8':     448,
    'sd-vp9':     448,
    'audio-h264': 64,
    'audio-vp8':  64,
    'audio-vp9':  64,
  },

  // Base HD connections per vCPU by instruction set (reference clock: 2.8 GHz)
  // Calibrated from Pexip NUMA docs: Xeon Gold 6342 (AVX-512, 2.8 GHz) ≈ 195 HD / 2 nodes / 16 vCPU each
  CPU_EFFICIENCY_TABLE: {
    legacy: 2.5,
    avx2:   4.0,
    avx512: 6.0,
  },

  CPU_REFERENCE_CLOCK: 2.8, // GHz

  // Hyperthreading bonus — only valid when VMs are NUMA-pinned to socket
  HT_BONUS_FACTOR: 1.4,

  // Hypervisor performance factors
  HYPERVISOR_FACTORS: {
    vmware:  1.0,
    kvm:     0.95,
    hyperv:  0.90,
    cloud:   1.0,
  },

  // Supported transcoding node vCPU sizes
  NODE_SIZES: [16, 24, 32, 48],

  // Default proxy / edge node vCPU size
  PROXY_NODE_VCPU: 4,

  // Headroom buffer applied to all resource calculations
  HEADROOM_FACTOR: 1.25,

  // Backplane HD reservation per active meeting per transcoding node
  BACKPLANE_HD_PER_MEETING: 1.0,

  // Gateway overhead multipliers applied to base HD
  GATEWAY_OVERHEAD: {
    none:  1.0,
    light: 1.5,
    heavy: 1.75,
  },

  // Proxy doubles resource usage (traffic hits both proxy AND transcoding node)
  PROXY_RESOURCE_FACTOR: 2.0,

  // Endpoint type definitions
  ENDPOINT_TYPES: {
    sip_h323: {
      label:             'SIP / H.323',
      connectionFactor:  1.0,
      presentationExtra: false,
      gatewayLegs:       1,
    },
    webrtc: {
      label:             'WebRTC',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    1.0,
      gatewayLegs:       1,
    },
    zoom: {
      label:             'Zoom',
      connectionFactor:  1.0,
      presentationExtra: false,
      gatewayLegs:       1,
    },
    zoom_sip: {
      label:             'Zoom via SIP',
      connectionFactor:  1.0,
      presentationExtra: false,
      gatewayLegs:       1,
    },
    teams: {
      label:             'Microsoft Teams',
      connectionFactor:  1.5,
      presentationExtra: true,
      presentationHD:    0.5,
      gatewayLegs:       2,
    },
    google_meet: {
      label:             'Google Meet',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    1.0,
      gatewayLegs:       2,
    },
    interop: {
      label:             'Interop / Gateway',
      connectionFactor:  2.0,
      presentationExtra: true,
      presentationHD:    1.0,
      gatewayLegs:       2,
    },
    skype_for_business: {
      label:             'Skype for Business',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    1.0,
      gatewayLegs:       1,
    },
  },

  // Static codec label per endpoint type (null = user-selectable)
  ENDPOINT_CODEC: {
    sip_h323:           'H.264',
    zoom:               'H.264',
    webrtc:             null,
    teams:              'MS / H.264',
    google_meet:        'VP8',
    skype_for_business: 'H.264',
  },

  // Quality options available in the endpoint composition table
  ENDPOINT_QUALITY_OPTIONS: [
    { value: 'sd',    label: 'SD (448p)'      },
    { value: '720p',  label: 'HD (720p)'      },
    { value: '1080p', label: 'Full HD (1080p)' },
  ],

  // Teams Adaptive Composition overhead (per conference)
  TEAMS_COMPOSITION_HD_BASE:    1.0,  // HD reserved per conference (≤3 on-stage)
  TEAMS_COMPOSITION_HD_ONSTAGE: 0.5,  // additional HD per on-stage participant beyond 3

  TOPOLOGY: {
    single_node:  'single_node',
    single_site:  'single_site',
    multi_site:   'multi_site',
  },

  NODE_ROLES: {
    transcoding: 'Transcoding (Internal)',
    proxy:       'Proxy (DMZ / Edge)',
    external:    'External (Public-facing)',
  },

  QUALITY_LABELS: {
    '1080p': 'Full HD (1080p)',
    '720p':  'HD (720p)',
    'sd':    'SD (448p)',
    'audio': 'Audio only',
  },

};
