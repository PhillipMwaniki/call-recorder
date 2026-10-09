#!/usr/bin/env python3
"""Transcribe a call recording locally with whisper.cpp.

Usage: transcribe.py <recording> [--sides DIR] [--language auto|en|sw|...]
                     [--model base|small|medium] [--keep-sides]

With --sides (the me.flac/them.flac tracks saved by recorder.py) the transcript
labels who spoke: "Me" and "Them". Without it the mixed recording is
transcribed as one voice. The transcript is written next to the recording as
<recording>.txt. Nothing leaves this computer.
"""
import argparse
import difflib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

DATA = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "call-recorder")
WHISPER = os.path.join(DATA, "whisper.cpp", "build", "bin", "whisper-cli")
MODELS = {
    "base": "ggml-base-q5_1.bin",
    "small": "ggml-small-q5_1.bin",
    "medium": "ggml-medium-q5_0.bin",
}
VAD_MODEL = "ggml-silero-v5.1.2.bin"
THREADS = max(1, min(6, (os.cpu_count() or 2) - 2))
MERGE_GAP_MS = 1500
ECHO_SIMILARITY = 0.7


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def stamp(ms):
    s = ms // 1000
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}"


def transcribe_track(path, model, language, tmp):
    """Return ([(start_ms, end_ms, text)], detected_language) for one audio file."""
    base = os.path.join(tmp, os.path.splitext(os.path.basename(path))[0])
    wav = base + ".wav"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", path,
                    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], check=True)
    cmd = [WHISPER, "-m", model, "-f", wav, "-l", language, "-t", str(THREADS),
           "-np", "-oj", "-of", base]
    vad = os.path.join(DATA, "models", VAD_MODEL)
    if os.path.exists(vad):
        cmd += ["--vad", "-vm", vad]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"whisper failed on {os.path.basename(path)}: {r.stderr.strip()[-300:]}")
    with open(base + ".json") as f:
        data = json.load(f)
    segments = []
    for seg in data.get("transcription", []):
        text = seg["text"].strip()
        if text:
            segments.append((seg["offsets"]["from"], seg["offsets"]["to"], text))
    return segments, data.get("result", {}).get("language")


def contained(text, other):
    """Share of `text` that also appears, in order, in `other` (0..1)."""
    a, b = text.lower(), other.lower()
    if not a:
        return 0.0
    matched = sum(m.size for m in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks())
    return matched / len(a)


def drop_echo(mine, theirs):
    """On speakers your mic also hears the other side; drop those duplicate lines."""
    kept = []
    for start, end, text in mine:
        near = [(ts, te, tt) for ts, te, tt in theirs if min(end, te) > max(start, ts)]
        overlap = sum(min(end, te) - max(start, ts) for ts, te, _ in near)
        heard = " ".join(tt for _, _, tt in near)
        if near and overlap > 0.25 * max(1, end - start) and contained(text, heard) > ECHO_SIMILARITY:
            continue
        kept.append((start, end, text))
    return kept


def merge(labelled):
    """Sort by time and join consecutive lines from the same speaker."""
    labelled.sort(key=lambda x: x[0])
    lines = []
    for start, end, speaker, text in labelled:
        if lines and lines[-1][2] == speaker and start - lines[-1][1] <= MERGE_GAP_MS:
            prev = lines[-1]
            lines[-1] = (prev[0], end, speaker, prev[3] + " " + text)
        else:
            lines.append((start, end, speaker, text))
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording")
    ap.add_argument("--sides")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--model", default="small", choices=MODELS)
    ap.add_argument("--keep-sides", action="store_true")
    args = ap.parse_args()

    model = os.path.join(DATA, "models", MODELS[args.model])
    for needed, hint in ((WHISPER, "whisper.cpp"), (model, f"the {args.model} model")):
        if not os.path.exists(needed):
            log(f"Missing {hint}. Run: sh tools/install-whisper.sh {args.model}")
            return 3
    if not os.path.exists(args.recording):
        log(f"No such recording: {args.recording}")
        return 2

    try:
        os.nice(10)  # stay out of the way of whatever you're doing next
    except OSError:
        pass

    sides = None
    if args.sides:
        sides = {k: os.path.join(args.sides, k + ".flac") for k in ("me", "them")}
        if not all(os.path.exists(p) and os.path.getsize(p) > 0 for p in sides.values()):
            log("Side tracks missing; transcribing the mixed recording instead")
            sides = None

    tmp = tempfile.mkdtemp(prefix="call-transcribe-")
    try:
        languages = set()
        if sides:
            log("Transcribing your side…")
            mine, lang = transcribe_track(sides["me"], model, args.language, tmp)
            languages.add(lang)
            log("Transcribing the other side…")
            theirs, lang = transcribe_track(sides["them"], model, args.language, tmp)
            languages.add(lang)
            mine = drop_echo(mine, theirs)
            labelled = [(s, e, "Me", t) for s, e, t in mine] + [(s, e, "Them", t) for s, e, t in theirs]
        else:
            log("Transcribing recording…")
            segs, lang = transcribe_track(args.recording, model, args.language, tmp)
            languages.add(lang)
            labelled = [(s, e, None, t) for s, e, t in segs]
    except (RuntimeError, subprocess.CalledProcessError) as e:
        log(str(e))
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    name = os.path.splitext(os.path.basename(args.recording))[0]
    out_path = os.path.splitext(args.recording)[0] + ".txt"
    langs = ", ".join(sorted(l for l in languages if l)) or "unknown"
    header = [f"Transcript: {name}",
              f"Created {datetime.now():%Y-%m-%d %H:%M} with whisper.cpp ({args.model} model, language: {langs})",
              ""]
    body = [f"[{stamp(s)}] {spk + ': ' if spk else ''}{text}" for s, _, spk, text in merge(labelled)]
    if not body:
        body = ["(no speech detected)"]
    tmp_out = out_path + ".part"
    with open(tmp_out, "w") as f:
        f.write("\n".join(header + body) + "\n")
    os.replace(tmp_out, out_path)
    log(f"Transcript saved: {out_path}")
    print(out_path)

    # The side tracks were only kept for this; remove exactly what recorder.py wrote
    if sides and not args.keep_sides:
        for p in sides.values():
            os.remove(p)
        try:
            os.rmdir(args.sides)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
