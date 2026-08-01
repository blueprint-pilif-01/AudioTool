import type { ApiMixTrack } from "../lib/api";

export interface MixerTrackState extends ApiMixTrack {
  color: string;
  sourceDurationMs: number;
}
