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

  // Maximum per-stream bandwidth by quality-codec key (for min–max range calculations)
  // Reflects real-world ceiling before quality adaptation clamps the stream
  BANDWIDTH_TABLE_MAX: {
    '1080p-h264': 4000, '1080p-vp8': 4000, '1080p-vp9': 2800,
    '720p-h264':  2000, '720p-vp8':  2000, '720p-vp9':  1400,
    'sd-h264':    960,  'sd-vp8':    960,  'sd-vp9':    960,
    'audio-h264': 64,   'audio-vp8': 64,   'audio-vp9': 64,
  },

  // Absolute per-participant bandwidth ceiling regardless of quality
  PARTICIPANT_MAX_KBPS: 6000,

  // Pexip-recommended max kbps per call by quality tier (docs.pexip.com — Restricting Bandwidth)
  QUALITY_MAX_KBPS: {
    'sd':    512,
    '720p':  1500,
    '1080p': 2500,
  },

  // Audio overhead per participant (kbps) — added on top of video
  AUDIO_MIN_KBPS: 8,
  AUDIO_MAX_KBPS: 64,

  // Presentation stream bandwidth by endpoint type (kbps, per active presentation)
  // Teams sends Full HD presentation; Google Meet is a separate capped call; others up to 75% of call BW
  PRESENTATION_BW: {
    teams:       { min: 2400, max: 2400 },
    google_meet: { min: 960,  max: 2000 },
    default:     { min: 960,  max: 2400 },
  },

  // Layout definitions — per-layout visible participant limit and inter-node backplane stream counts.
  // maxVideoParticipants: participants beyond this are treated as audio-only for HD resource calculation.
  // backplane.hd:    number of HD-quality streams crossing between transcoding nodes for this layout.
  // backplane.thumb: number of thumbnail streams (64–192 kbps) crossing between nodes.
  LAYOUTS: {
    // ── A. Adaptive / Teams-like ─────────────────────────────────────────────
    adaptive: {
      label:                'Adaptive Composition',
      group:                'adaptive',
      maxVideoParticipants: 12,
      backplane:            { hd: 13, thumb: 0 },
    },
    // ── B. Speaker-Focused (Classic) ─────────────────────────────────────────
    '1+0': {
      label:                '1+0 — Full-screen speaker',
      group:                'speaker',
      maxVideoParticipants: 1,
      backplane:            { hd: 1, thumb: 0 },
    },
    '1+1': {
      label:                '1+1',
      group:                'speaker',
      maxVideoParticipants: 2,
      backplane:            { hd: 2, thumb: 0 },
    },
    '1+7': {
      label:                '1+7',
      group:                'speaker',
      maxVideoParticipants: 8,
      backplane:            { hd: 2, thumb: 7 },
    },
    '1+21': {
      label:                '1+21',
      group:                'speaker',
      maxVideoParticipants: 22,
      backplane:            { hd: 2, thumb: 21 },
    },
    '2+21': {
      label:                '2+21',
      group:                'speaker',
      maxVideoParticipants: 23,
      backplane:            { hd: 2, thumb: 21 },
    },
    '1+33': {
      label:                '1+33',
      group:                'speaker',
      maxVideoParticipants: 34,
      backplane:            { hd: 2, thumb: 33 },
    },
    // ── C. Equal Grid ────────────────────────────────────────────────────────
    '2x2': {
      label:                '2×2 grid',
      group:                'grid',
      maxVideoParticipants: 4,
      backplane:            { hd: 4, thumb: 0 },
    },
    '3x3': {
      label:                '3×3 grid',
      group:                'grid',
      maxVideoParticipants: 9,
      backplane:            { hd: 9, thumb: 0 },
    },
    '4x4': {
      label:                '4×4 grid',
      group:                'grid',
      maxVideoParticipants: 16,
      backplane:            { hd: 16, thumb: 0 },
    },
    '5x5': {
      label:                '5×5 grid',
      group:                'grid',
      maxVideoParticipants: 25,
      backplane:            { hd: 25, thumb: 0 },
    },
  },

  // Backplane per-stream bandwidth range (kbps) — one entry per HD or thumbnail stream crossing nodes
  BACKPLANE_HD_MIN_KBPS:       1600,
  BACKPLANE_HD_MAX_KBPS:       4000,
  BACKPLANE_THUMB_MIN_KBPS:    64,
  BACKPLANE_THUMB_MAX_KBPS:    192,
  BACKPLANE_PRESENTATION_KBPS: 1600,

  CPU_MIN_CLOCK_GHZ:    2.6, // minimum recommended base clock for Pexip nodes
  CORES_PER_NODE_TARGET: 22, // physical cores per conferencing node target

  // K coefficient model constants
  COEFF_FLOOR:                0.58,
  COEFF_CEILING_CONSERVATIVE: 0.78,
  COEFF_CEILING_PROJECTED:    0.83,
  PROJECTED_MODE_ADJUSTMENT:  0.04,
  BASE_COEFF:                 0.62,

  // Supported transcoding node vCPU sizes
  NODE_SIZES: [16, 24, 32, 48],

  // Default proxy / edge node vCPU size
  PROXY_NODE_VCPU: 4,

  // Headroom buffer applied to all resource calculations
  HEADROOM_FACTOR: 1.25,

  // Backplane HD reservation per active meeting per transcoding node
  BACKPLANE_HD_PER_MEETING: 1.0,
  // Teams gateway backplane costs more than standard (per Pexip docs)
  BACKPLANE_HD_TEAMS: 1.5,
  // HD load on a proxy/edge node per forwarded external call
  BACKPLANE_HD_PROXY_PER_CALL: 0.2,
  // Per-call gateway overhead on the hosting transcoding node (Teams Connector / Google Meet connection)
  GATEWAY_HD_PER_CALL_TEAMS:       1.5,
  GATEWAY_HD_PER_CALL_GOOGLE_MEET: 1.0,

  // Endpoint type definitions
  ENDPOINT_TYPES: {
    sip_h323: {
      label:             'SIP / H.323',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    0.5,
    },
    webrtc: {
      label:             'WebRTC',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    1.0,
    },
    zoom: {
      label:             'Zoom',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    0.5,
    },
    teams: {
      label:             'Microsoft Teams',
      connectionFactor:  1.5,
      minConnectionHD:   1.5,  // Pexip: Teams leg is 1.5 HD at SD *and* HD quality — no quality discount below 1.5
      presentationExtra: true,
      presentationHD:    0.5,
    },
    google_meet: {
      label:             'Google Meet',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    1.0,
    },
    skype_for_business: {
      label:             'Skype for Business',
      connectionFactor:  1.0,
      presentationExtra: true,
      presentationHD:    1.0,
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

  NODE_ROLES: {
    transcoding: 'Transcoding (Internal)',
    proxy:       'Proxy (DMZ / Edge)',
    external:    'External (Public-facing)',
  },

  // Role labels for the hardware builder node allocation
  NODE_ROLES_HW: {
    transcoding: 'Transcoding Conferencing',
    proxy:       'Proxying Edge',
    management:  'Management',
  },

  // Default vCPU by role when adding a new node (null = computed from server socket spec)
  DEFAULT_VCPU_BY_ROLE: {
    transcoding: null,
    proxy:       4,
    management:  8,
  },

  // Default RAM (GB) by role for non-transcoding nodes
  DEFAULT_RAM_BY_ROLE: {
    proxy:      4,
    management: 8,
  },

  QUALITY_LABELS: {
    '1080p': 'Full HD (1080p)',
    '720p':  'HD (720p)',
    'sd':    'SD (448p)',
    'audio': 'Audio only',
  },

};
