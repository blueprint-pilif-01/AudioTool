import { z } from "zod";

export const projectStatuses = [
  "draft",
  "analyzing",
  "awaiting_confirmation",
  "separating",
  "ready",
  "failed",
] as const;
export const projectStatusSchema = z.enum(projectStatuses);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const jobStatuses = [
  "queued",
  "detecting",
  "awaiting_confirmation",
  "separating",
  "rendering",
  "completed",
  "failed",
  "cancelled",
] as const;
export const jobStatusSchema = z.enum(jobStatuses);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const separationModes = ["quick", "standard", "auto"] as const;
export const separationModeSchema = z.enum(separationModes);
export type SeparationMode = z.infer<typeof separationModeSchema>;

export const audioAssetKinds = ["source", "stem", "preview", "mix", "export"] as const;
export const audioAssetKindSchema = z.enum(audioAssetKinds);
export type AudioAssetKind = z.infer<typeof audioAssetKindSchema>;

export const instrumentLabels = [
  "lead_vocals",
  "backing_vocals",
  "vocals",
  "drums",
  "percussion",
  "bass_guitar",
  "synth_bass",
  "acoustic_guitar",
  "electric_guitar",
  "guitar",
  "piano",
  "electric_piano",
  "organ",
  "synthesizer",
  "strings",
  "brass",
  "woodwinds",
  "saxophone",
  "flute",
  "instrumental",
  "other",
] as const;
export const instrumentLabelSchema = z.enum(instrumentLabels);
export type InstrumentLabel = z.infer<typeof instrumentLabelSchema>;

export const instrumentDisplayNames: Record<InstrumentLabel, string> = {
  lead_vocals: "Lead vocals",
  backing_vocals: "Backing vocals",
  vocals: "Vocals",
  drums: "Drums",
  percussion: "Percussion",
  bass_guitar: "Bass guitar",
  synth_bass: "Synth bass",
  acoustic_guitar: "Acoustic guitar",
  electric_guitar: "Electric guitar",
  guitar: "Guitar",
  piano: "Piano",
  electric_piano: "Electric piano",
  organ: "Organ",
  synthesizer: "Synthesizer / pad",
  strings: "Strings",
  brass: "Brass",
  woodwinds: "Woodwinds / reeds",
  saxophone: "Saxophone",
  flute: "Flute",
  instrumental: "Instrumental",
  other: "Other / residual",
};

export const mlProviderCapabilitiesSchema = z.object({
  provider: z.string().min(1),
  modelName: z.string().min(1),
  modelVersion: z.string().min(1),
  supportedLabels: z.array(instrumentLabelSchema),
  dynamicStemCount: z.boolean(),
  limitations: z.array(z.string()),
  mock: z.boolean(),
});
export type MlProviderCapabilities = z.infer<typeof mlProviderCapabilitiesSchema>;

const aliases: Record<string, InstrumentLabel> = {
  kit: "drums",
  "drum kit": "drums",
  drums: "drums",
  percussion: "percussion",
  vocal: "vocals",
  vocals: "vocals",
  voice: "vocals",
  "lead vocal": "lead_vocals",
  "backing vocal": "backing_vocals",
  bass: "bass_guitar",
  "bass guitar": "bass_guitar",
  "synth bass": "synth_bass",
  guitar: "guitar",
  "acoustic guitar": "acoustic_guitar",
  "electric guitar": "electric_guitar",
  piano: "piano",
  "electric piano": "electric_piano",
  keys: "electric_piano",
  keyboard: "electric_piano",
  organ: "organ",
  synth: "synthesizer",
  synthesizer: "synthesizer",
  pad: "synthesizer",
  strings: "strings",
  violin: "strings",
  viola: "strings",
  cello: "strings",
  brass: "brass",
  trumpet: "brass",
  trombone: "brass",
  woodwind: "woodwinds",
  reeds: "woodwinds",
  sax: "saxophone",
  saxophone: "saxophone",
  flute: "flute",
  other: "other",
  residual: "other",
};

export function normalizeInstrumentLabel(value: string): InstrumentLabel | null {
  const normalized = value.trim().toLowerCase().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
  return aliases[normalized] ?? null;
}

export const detectedSpanSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
});

export const instrumentDetectionSchema = z.object({
  id: z.string().uuid().optional(),
  canonicalLabel: instrumentLabelSchema,
  displayLabel: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  detectedSpans: z.array(detectedSpanSchema).default([]),
  selected: z.boolean().default(true),
  manuallyAdded: z.boolean().default(false),
  modelName: z.string().min(1),
  modelVersion: z.string().min(1),
});
export type InstrumentDetection = z.infer<typeof instrumentDetectionSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const updateProjectSchema = createProjectSchema.partial();

export const updateDetectionsSchema = z.object({
  detections: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        canonicalLabel: instrumentLabelSchema,
        displayLabel: z.string().trim().min(1).max(100),
        confidence: z.number().min(0).max(1).default(1),
        selected: z.boolean(),
        manuallyAdded: z.boolean().default(false),
      }),
    )
    .min(1),
});

export const createSeparationJobSchema = z.object({
  mode: separationModeSchema.default("auto"),
  detectionIds: z.array(z.string().uuid()).optional(),
});

export const mixTrackSchema = z.object({
  id: z.string().uuid().optional(),
  stemId: z.string().uuid().nullable().optional(),
  audioAssetId: z.string().uuid(),
  orderIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  trimStartMs: z.number().int().nonnegative(),
  trimEndMs: z.number().int().nonnegative(),
  volumeDb: z.number().min(-60).max(12),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  solo: z.boolean(),
  enabled: z.boolean().default(true),
  fadeInMs: z.number().int().nonnegative(),
  fadeOutMs: z.number().int().nonnegative(),
});

export const saveMixSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Main mix"),
  masterSettings: z.object({
    volumeDb: z.number().min(-60).max(12).default(0),
  }),
  tracks: z.array(mixTrackSchema),
});
export type SaveMixInput = z.infer<typeof saveMixSchema>;

export const timeSignatureDenominatorSchema = z.union([
  z.literal(2),
  z.literal(4),
  z.literal(8),
  z.literal(16),
]);

export const guideCueSchema = z.object({
  id: z.string().min(1).max(80),
  bar: z.number().int().min(1).max(10_000),
  beat: z.number().int().min(1).max(16),
  text: z.string().trim().min(1).max(160),
});
export type GuideCue = z.infer<typeof guideCueSchema>;

export const generateGuideTracksSchema = z
  .object({
    bpm: z.number().min(30).max(300),
    beatsPerBar: z.number().int().min(2).max(12),
    beatUnit: timeSignatureDenominatorSchema,
    createGuide: z.boolean().default(true),
    createClick: z.boolean().default(true),
    voiceName: z.string().trim().min(1).max(120).optional(),
    speechRate: z.number().int().min(-5).max(5).default(0),
    guideVolumeDb: z.number().min(-60).max(6).default(-3),
    clickVolumeDb: z.number().min(-60).max(6).default(-9),
    cues: z.array(guideCueSchema).max(80).default([]),
  })
  .superRefine((value, context) => {
    if (!value.createGuide && !value.createClick) {
      context.addIssue({
        code: "custom",
        message: "Select the guide track, the click track, or both.",
      });
    }
    if (value.createGuide && value.cues.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["cues"],
        message: "Add at least one spoken cue.",
      });
    }
    value.cues.forEach((cue, index) => {
      if (cue.beat > value.beatsPerBar) {
        context.addIssue({
          code: "custom",
          path: ["cues", index, "beat"],
          message: `Beat must be between 1 and ${value.beatsPerBar}.`,
        });
      }
    });
  });
export type GenerateGuideTracksInput = z.infer<typeof generateGuideTracksSchema>;

export interface GuideVoice {
  name: string;
  displayName?: string;
  culture: string;
  gender: "Female" | "Male" | "Neutral" | "Unknown";
  provider?: "groq" | "edge" | "system";
  description?: string;
}

export interface GeneratedProjectTrack {
  type: "guide" | "click";
  asset: ApiAudioAsset;
  settings: {
    bpm: number;
    beatsPerBar: number;
    beatUnit: number;
    voiceName?: string;
    speechRate?: number;
    cues?: GuideCue[];
  };
}

export const vocalBreakdownParts = ["melody", "soprano", "alto", "tenor", "bass"] as const;
export type VocalBreakdownPart = (typeof vocalBreakdownParts)[number];

export const generateVocalBreakdownSchema = z.object({
  parts: z.array(z.enum(vocalBreakdownParts)).min(1).max(vocalBreakdownParts.length),
});
export type GenerateVocalBreakdownInput = z.infer<typeof generateVocalBreakdownSchema>;

export interface VocalNoteEvent {
  startMs: number;
  endMs: number;
  midi: number;
  note: string;
  frequencyHz: number;
  confidence: number;
  register: Exclude<VocalBreakdownPart, "melody">;
}

export interface VocalRegisterSummary {
  part: Exclude<VocalBreakdownPart, "melody">;
  displayName: string;
  range: string;
  coverage: number;
  confidence: number;
}

export interface VocalBreakdownAnalysis {
  durationMs: number;
  voicedDurationMs: number;
  confidence: number;
  lowestNote: string | null;
  highestNote: string | null;
  medianNote: string | null;
  notes: VocalNoteEvent[];
  registers: VocalRegisterSummary[];
  modelName: string;
  modelVersion: string;
  methodology: "dominant-pitch-register-gating";
  experimental: true;
}

export interface VocalBreakdownTrack {
  part: VocalBreakdownPart;
  displayName: string;
  asset: ApiAudioAsset;
  confidence: number;
  coverage: number;
}

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export interface ApiProject {
  id: string;
  name: string;
  status: ProjectStatus;
  sourceAudioId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAudioAsset {
  id: string;
  projectId: string;
  kind: AudioAssetKind;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  streamUrl: string;
}

export interface ApiStem {
  id: string;
  projectId: string;
  jobId: string;
  audioAssetId: string;
  canonicalLabel: InstrumentLabel;
  displayLabel: string;
  confidence: number | null;
  isResidual: boolean;
  streamUrl: string;
  downloadUrl: string;
}

export interface ApiJob {
  id: string;
  projectId: string;
  mode: SeparationMode;
  status: JobStatus;
  progress: number;
  currentStage: string | null;
  provider: string;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApiRecentJob extends ApiJob {
  projectName: string;
  projectStatus: ProjectStatus;
}

export interface JobEventPayload {
  jobId: string;
  status: JobStatus;
  progress: number;
  stage: string;
  message: string;
  timestamp: string;
}
