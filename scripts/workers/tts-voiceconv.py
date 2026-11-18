#!/usr/bin/env python3
"""OpenVoice V2 tone-colour conversion (ONNX).

Re-paints the timbre of a spoken WAV with the voice colour of a reference WAV,
keeping the pronunciation and prosody of the source. Used by the text-to-speech
pipeline so a Polish Piper voice can speak with an English Kokoro voice's colour.

Models: Hinotsuba/OpenVoice-ONNX-v2 (MIT, derived from MyShell OpenVoice V2).
"""

import argparse
import wave

import numpy as np
import onnxruntime as ort

SR = 22050
NFFT = 1024
HOP = 256
PAD = 384


def read_wav(path):
    with wave.open(path) as w:
        sr, channels = w.getframerate(), w.getnchannels()
        raw = w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if sr != SR:
        target = np.arange(int(len(audio) * SR / sr)) / SR
        audio = np.interp(target, np.arange(len(audio)) / sr, audio).astype(np.float32)
    return audio


def write_wav(path, audio):
    data = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def spectrogram(audio):
    """Linear magnitude STFT matching OpenVoice's spectrogram_torch settings."""
    audio = np.pad(audio, (PAD, PAD), mode="reflect")
    window = np.hanning(NFFT + 1)[:-1].astype(np.float32)
    frames = 1 + (len(audio) - NFFT) // HOP
    indices = np.arange(NFFT)[None, :] + HOP * np.arange(frames)[:, None]
    spectrum = np.fft.rfft(audio[indices] * window, n=NFFT, axis=1)
    return np.sqrt(spectrum.real ** 2 + spectrum.imag ** 2 + 1e-6).astype(np.float32)


def tame_tails(audio, sr=SR):
    """Downward expander that removes the low-level smear the converter leaves.

    Voice conversion raises the energy between syllables (audible as a small
    room/echo). Quiet 10 ms frames are pulled down relative to the loud ones,
    with smoothed gain so speech itself is untouched.
    """
    win = int(0.01 * sr)
    if len(audio) < win * 4:
        return audio
    frames = len(audio) // win
    trimmed = audio[: frames * win].reshape(frames, win)
    rms = np.sqrt(np.mean(trimmed ** 2, axis=1))
    loud = np.percentile(rms, 95) + 1e-9
    # Gentle setting: only deep smear is trimmed, quiet consonants survive.
    low, high = 0.20 * loud, 0.45 * loud
    gain = np.clip((rms - low) / (high - low + 1e-9), 0.0, 1.0)
    gain = 0.25 + 0.75 * gain  # never fully mute: keep breaths and soft consonants
    smoothed = np.convolve(gain, np.ones(5) / 5, mode="same")
    out = audio.copy()
    out[: frames * win] = (trimmed * smoothed[:, None]).reshape(-1)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True, help="Speech to re-voice")
    parser.add_argument("--ref", required=True, help="Reference recording of the target voice")
    parser.add_argument("--out", required=True, help="Output WAV")
    parser.add_argument("--models", required=True, help="Directory with the ONNX models")
    parser.add_argument("--tau", type=float, default=0.3)
    parser.add_argument("--clean", action="store_true", help="Tame the trailing smear after syllables")
    args = parser.parse_args()

    extract = ort.InferenceSession(f"{args.models}/tone_extract.onnx", providers=["CPUExecutionProvider"])
    convert = ort.InferenceSession(f"{args.models}/tone_color.onnx", providers=["CPUExecutionProvider"])

    def embedding(audio):
        spec = spectrogram(audio)[None, :, :]
        return extract.run(None, {"input": spec})[0].reshape(1, 256, 1)

    source = read_wav(args.src)
    reference = read_wav(args.ref)
    source_tone = embedding(source)
    target_tone = embedding(reference)

    spec = spectrogram(source).T[None, :, :].astype(np.float32)
    converted = convert.run(None, {
        "audio": spec,
        "audio_length": np.array([spec.shape[2]], dtype=np.int64),
        "src_tone": source_tone,
        "dest_tone": target_tone,
        "tau": np.array([args.tau], dtype=np.float32),
    })[0]
    waveform = converted.reshape(-1)
    if args.clean:
        waveform = tame_tails(waveform)
    write_wav(args.out, waveform)


if __name__ == "__main__":
    main()
