# Third-party and model license notes

This is an engineering inventory, not legal advice. The lockfile is the source of exact JavaScript
versions. Production releases should generate an SBOM and bundle all required notices.

| Component                                                       | Role                       | License/provenance action                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vue, Vite, Fastify, Drizzle, BullMQ, Zod, Pinia, TanStack Query | Web platform               | Permissive open-source dependencies; preserve their notices and verify the lockfile during release                                                                                                                                                     |
| FFmpeg executable                                               | Decode, DSP, render        | Used behind `FfmpegPitchTempoAdapter` and other process-boundary builders. Usually LGPL 2.1+, but builds compiled with GPL components become GPL; inspect the deployed binary's configuration and codec licenses                                       |
| Demucs code                                                     | Optional separation worker | Upstream repository states MIT; preserve the license                                                                                                                                                                                                   |
| `htdemucs_6s` checkpoint                                        | Model weights              | Local benchmark artifact `5c90dfd2.safetensors`: SHA-256 `d2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411`. Obtain a separate commercial-use/provenance review; the code's MIT license does not by itself resolve weight/data rights  |
| `htdemucs_ft` checkpoint ensemble                               | Vocal-remover weights      | Four local artifacts: `04573f0d` / `68854b0d…b7c`, `92cfc3b6` / `a2418635…eb59`, `d12395a8` / `5b01a975…fb56`, and `f7e0c4bc` / `2c85ab3c…925f` (84,025,440 bytes each). Apply the same separate checkpoint/data provenance and commercial-use review. |
| PyTorch, FastAPI, Uvicorn, NumPy, SoundFile                     | ML runtime                 | Verify installed wheel licenses and native library notices in the release environment                                                                                                                                                                  |
| Plus Jakarta Sans                                               | UI font                    | Bundled through Fontsource; preserve the font license notice                                                                                                                                                                                           |
| Tabler Icons                                                    | UI icons                   | Preserve the upstream icon license notice                                                                                                                                                                                                              |

Official references:

- Maintained Demucs package/source: https://pypi.org/project/demucs/ and
  https://github.com/adefossez/demucs
- Archived Meta Demucs repository and license: https://github.com/facebookresearch/demucs
- FFmpeg legal/license guidance: https://ffmpeg.org/legal.html
- Tabler Icons license: https://github.com/tabler/tabler-icons/blob/main/LICENSE
- Fontsource package metadata: https://fontsource.org/fonts/plus-jakarta-sans

Before adding Banquet, SAM-Audio, AudioSep, Rubber Band, or any hosted API, add a row for both code
and checkpoint/service terms. Do not integrate GPL/AGPL DSP into a proprietary distribution without
an explicit architecture and legal decision.

The current pitch/tempo implementation deliberately uses FFmpeg's `asetrate`, `aresample`, and
`atempo` filters through the `PitchTempoAdapter` contract. It does not embed Rubber Band or another
GPL/AGPL time-stretch library. Replacing the adapter therefore requires a separate code and binary
license review before distribution.
