#!/bin/sh
# Builds whisper.cpp for local call transcription and downloads a model.
# No root needed; everything goes under ~/.local/share/call-recorder.
#
#   sh install-whisper.sh            # default model: small
#   sh install-whisper.sh turbo      # or: base, small, medium, turbo, large
set -eu

WHISPER_TAG=v1.9.5
MODEL=${1:-small}
ROOT=${XDG_DATA_HOME:-$HOME/.local/share}/call-recorder
SRC=$ROOT/whisper.cpp

case "$MODEL" in
    base|small|medium|turbo|large) ;;
    *) echo "Unknown model '$MODEL'; use base, small, medium, turbo or large" >&2; exit 1 ;;
esac

for tool in git cmake make gcc g++ ffmpeg; do
    command -v "$tool" >/dev/null || { echo "Missing $tool; see README prerequisites" >&2; exit 1; }
done

mkdir -p "$ROOT/models"

if [ ! -x "$SRC/build/bin/whisper-cli" ] || [ "$(git -C "$SRC" describe --tags 2>/dev/null)" != "$WHISPER_TAG" ]; then
    echo "Building whisper.cpp $WHISPER_TAG (a few minutes)…"
    rm -rf "$SRC"
    git clone --quiet --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$SRC"
    cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON \
          -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
    cmake --build "$SRC/build" --config Release -j"$(nproc)" --target whisper-cli >/dev/null
fi

# Quantized multilingual models: much smaller and faster, nearly the same accuracy
case "$MODEL" in
    base)   FILE=ggml-base-q5_1.bin ;;
    small)  FILE=ggml-small-q5_1.bin ;;
    medium) FILE=ggml-medium-q5_0.bin ;;
    turbo)  FILE=ggml-large-v3-turbo-q5_0.bin ;;
    large)  FILE=ggml-large-v3-q5_0.bin ;;
esac
if [ ! -s "$ROOT/models/$FILE" ]; then
    echo "Downloading $FILE…"
    curl -fsSL -o "$ROOT/models/$FILE.part" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$FILE"
    mv "$ROOT/models/$FILE.part" "$ROOT/models/$FILE"
fi

# Voice activity detection model: skips silence, which stops Whisper inventing
# phrases while the other person is talking
VAD=ggml-silero-v5.1.2.bin
if [ ! -s "$ROOT/models/$VAD" ]; then
    echo "Downloading $VAD…"
    curl -fsSL -o "$ROOT/models/$VAD.part" "https://huggingface.co/ggml-org/whisper-vad/resolve/main/$VAD"
    mv "$ROOT/models/$VAD.part" "$ROOT/models/$VAD"
fi

echo "Ready: $SRC/build/bin/whisper-cli with models/$FILE"
