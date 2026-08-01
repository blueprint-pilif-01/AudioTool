from audiotool_ml_worker.guide_tts import public_voice_profiles, voice_prosody


def test_worship_guide_voice_is_default_and_romanian_is_available() -> None:
    voices = public_voice_profiles()
    assert voices[0]["name"] == "en-US-JennyNeural"
    assert voices[0]["provider"] == "edge"
    assert any(voice["name"] == "ro-RO-AlinaNeural" for voice in voices)


def test_voice_prosody_is_crisp_and_obeys_speed_control() -> None:
    assert voice_prosody("en-US-JennyNeural", 0) == ("+12%", "+4Hz")
    assert voice_prosody("en-US-JennyNeural", 2) == ("+20%", "+4Hz")
    assert voice_prosody("ro-RO-AlinaNeural", -2) == ("+1%", "+3Hz")
