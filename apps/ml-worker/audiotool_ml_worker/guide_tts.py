from __future__ import annotations

from typing import TypedDict

import edge_tts


class GuideVoiceProfile(TypedDict):
    name: str
    displayName: str
    culture: str
    gender: str
    provider: str
    description: str
    baseRatePercent: int
    pitchHz: int


VOICE_PROFILES: tuple[GuideVoiceProfile, ...] = (
    {
        "name": "en-US-JennyNeural",
        "displayName": "Jenny · Worship guide",
        "culture": "en-US",
        "gender": "Female",
        "provider": "edge",
        "description": "Recommended: a tight, clear US cue voice with an assistant-style delivery.",
        "baseRatePercent": 12,
        "pitchHz": 4,
    },
    {
        "name": "en-US-AriaNeural",
        "displayName": "Aria · Clear professional",
        "culture": "en-US",
        "gender": "Female",
        "provider": "edge",
        "description": "A polished US voice with a slightly warmer professional delivery.",
        "baseRatePercent": 10,
        "pitchHz": 3,
    },
    {
        "name": "en-GB-SoniaNeural",
        "displayName": "Sonia · British guide",
        "culture": "en-GB",
        "gender": "Female",
        "provider": "edge",
        "description": "A focused British female voice for short section and count-in cues.",
        "baseRatePercent": 11,
        "pitchHz": 3,
    },
    {
        "name": "ro-RO-AlinaNeural",
        "displayName": "Alina · Ghid în română",
        "culture": "ro-RO",
        "gender": "Female",
        "provider": "edge",
        "description": "Voce neural feminină pentru indicații și numărători rostite în română.",
        "baseRatePercent": 9,
        "pitchHz": 3,
    },
)

VOICE_BY_NAME = {profile["name"]: profile for profile in VOICE_PROFILES}


def public_voice_profiles() -> list[dict[str, str]]:
    return [
        {
            "name": profile["name"],
            "displayName": profile["displayName"],
            "culture": profile["culture"],
            "gender": profile["gender"],
            "provider": profile["provider"],
            "description": profile["description"],
        }
        for profile in VOICE_PROFILES
    ]


def voice_prosody(voice_name: str, speech_rate: int) -> tuple[str, str]:
    profile = VOICE_BY_NAME[voice_name]
    rate_percent = max(-35, min(40, profile["baseRatePercent"] + speech_rate * 4))
    return f"{rate_percent:+d}%", f"{profile['pitchHz']:+d}Hz"


async def synthesize_guide_speech(text: str, voice_name: str, speech_rate: int) -> bytes:
    rate, pitch = voice_prosody(voice_name, speech_rate)
    communicator = edge_tts.Communicate(
        text=text,
        voice=voice_name,
        rate=rate,
        volume="+0%",
        pitch=pitch,
    )
    chunks: list[bytes] = []
    async for message in communicator.stream():
        if message["type"] == "audio":
            chunks.append(message["data"])
    audio = b"".join(chunks)
    if not audio:
        raise RuntimeError("The neural speech service returned no audio.")
    return audio
