#!/usr/bin/env bash
#
# Local AI Studio - Piper setup (extra text-to-speech languages)
# Kokoro only ships English voices; Piper adds other languages (Polish).
# Everything lands inside app/ so nothing is installed system-wide.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
APP_DIR="$ROOT_DIR/app"
TTS_RUNTIME="$APP_DIR/tts-runtime"
VENV_DIR="$TTS_RUNTIME/piper-venv"
VOICES_DIR="$APP_DIR/tts-models/piper"
PIPER_BIN="$VENV_DIR/bin/piper"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL"
PIPER_PACKAGE="${PIPER_PACKAGE:-piper-tts}"

print_ok() { echo "   OK   $1"; }
print_info() { echo "   >>   $1"; }
print_warn() { echo "   !!   $1"; }

echo ""
echo "  ============================================================"
echo "   Setting up Piper voices (Polish)"
echo "  ============================================================"
echo ""

mkdir -p "$VOICES_DIR"

if [[ ! -x "$PIPER_BIN" ]]; then
  print_info "Creating an isolated Piper runtime in app/tts-runtime/piper-venv"
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV_DIR" --python 3.12
    uv pip install --python "$VENV_DIR/bin/python" "$PIPER_PACKAGE"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip
    "$VENV_DIR/bin/python" -m pip install --quiet "$PIPER_PACKAGE"
  else
    print_warn "Neither uv nor python3 is available; skipping Piper."
    exit 1
  fi
fi

if [[ ! -x "$PIPER_BIN" ]]; then
  print_warn "The Piper runtime could not be created."
  exit 1
fi
print_ok "Piper runtime ready: app/tts-runtime/piper-venv"

for voice in gosia darkman; do
  for file in "pl_PL-$voice-medium.onnx" "pl_PL-$voice-medium.onnx.json"; do
    target="$VOICES_DIR/$file"
    if [[ -s "$target" ]]; then
      continue
    fi
    print_info "Downloading $file"
    rm -f "$target.part"
    curl -fSL --retry 2 --progress-bar -o "$target.part" "$VOICE_BASE/$voice/medium/$file"
    mv "$target.part" "$target"
  done
done

print_ok "Polish voices ready in app/tts-models/piper"

# Voice conversion (OpenVoice V2, MIT) lets a Piper voice borrow another voice's timbre.
VC_DIR="$APP_DIR/tts-runtime/voiceconv"
REFS_DIR="$APP_DIR/tts-models/voiceconv-refs"
mkdir -p "$VC_DIR" "$REFS_DIR"
for file in tone_extract.onnx tone_color.onnx tone_config.json; do
  target="$VC_DIR/$file"
  if [[ -s "$target" ]]; then
    continue
  fi
  print_info "Downloading $file"
  rm -f "$target.part"
  curl -fSL --retry 2 --progress-bar -o "$target.part" "https://huggingface.co/Hinotsuba/OpenVoice-ONNX-v2/resolve/main/$file"
  mv "$target.part" "$target"
done
print_ok "Voice conversion models ready in app/tts-runtime/voiceconv"

if [[ ! -s "$REFS_DIR/bm_george.wav" ]]; then
  print_warn "No reference recording for the George (PL) voice yet:"
  print_warn "generate a Kokoro \"George\" sample in the Voice tab and save it as"
  print_warn "app/tts-models/voiceconv-refs/bm_george.wav"
fi
