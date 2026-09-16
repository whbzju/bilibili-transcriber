#!/usr/bin/env python3

import json
import os
import re
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG_DIR = ROOT / "data" / "xiaoyuzhou" / "mianji"
CATALOG_DIR = Path(os.environ.get("AUDIO_CATALOG_DIR") or os.environ.get("XYZ_CATALOG_DIR") or DEFAULT_CATALOG_DIR)
MANIFEST_FILE = Path(
    os.environ.get("AUDIO_MANIFEST")
    or os.environ.get("XYZ_AUDIO_MANIFEST")
    or CATALOG_DIR / "audio-manifest.json"
)
BACKEND = (os.environ.get("WHISPER_BACKEND") or os.environ.get("AUDIO_TRANSCRIBE_BACKEND") or "mlx").lower()
MODEL = (
    os.environ.get("WHISPER_MODEL")
    or os.environ.get("XYZ_WHISPER_MODEL")
    or (
        "large-v3"
        if BACKEND in {"openai", "openai-whisper", "whisper"}
        else "small"
        if BACKEND in {"faster", "faster-whisper", "faster_whisper"}
        else "mlx-community/whisper-large-v3-turbo"
    )
)
MODEL_SLUG = re.sub(r"[^a-zA-Z0-9_.-]+", "-", MODEL).strip("-")
OUTPUT_DIR = Path(
    os.environ.get("TRANSCRIPT_DIR")
    or os.environ.get("XYZ_TRANSCRIPT_DIR")
    or CATALOG_DIR / "transcripts" / MODEL_SLUG
)

START_INDEX = int(os.environ.get("AUDIO_START_INDEX") or os.environ.get("XYZ_START_INDEX") or "0")
END_INDEX = int(os.environ.get("AUDIO_END_INDEX") or os.environ.get("XYZ_END_INDEX") or "0")
MAX_EPISODES = int(os.environ.get("AUDIO_MAX_EPISODES") or os.environ.get("XYZ_MAX_EPISODES") or "0")
OVERWRITE = (os.environ.get("AUDIO_OVERWRITE") or os.environ.get("XYZ_OVERWRITE") or "0") == "1"
WORD_TIMESTAMPS = (os.environ.get("AUDIO_WORD_TIMESTAMPS") or os.environ.get("XYZ_WORD_TIMESTAMPS") or "0") == "1"
LANGUAGE = os.environ.get("AUDIO_LANGUAGE") or os.environ.get("XYZ_LANGUAGE") or "zh"
INITIAL_PROMPT = os.environ.get("AUDIO_INITIAL_PROMPT") or os.environ.get("XYZ_INITIAL_PROMPT") or ""
DEVICE = os.environ.get("WHISPER_DEVICE") or ""
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE") or "int8"
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE") or "5")
VAD_FILTER = (os.environ.get("AUDIO_VAD_FILTER") or "1") == "1"


def timestamp(seconds: float) -> str:
    seconds = max(0.0, float(seconds or 0.0))
    whole = int(seconds)
    ms = int(round((seconds - whole) * 1000))
    h = whole // 3600
    m = (whole % 3600) // 60
    s = whole % 60
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def srt_timestamp(seconds: float) -> str:
    return timestamp(seconds).replace(".", ",")


def safe_stem(item: dict) -> str:
    index = str(item.get("index", "")).zfill(3)
    date = str(item.get("pubDate") or item.get("uploadDate") or "")[:10] or "unknown-date"
    title = re.sub(r'[\\/:*?"<>|]+', " ", str(item.get("title") or item.get("id") or "untitled"))
    title = re.sub(r"\s+", " ", title).strip()[:120]
    return f"{index}-{date}-{title}"


def item_url(item: dict) -> str:
    return str(item.get("episodeUrl") or item.get("webpageUrl") or item.get("url") or "")


def write_text_outputs(item: dict, result: dict, base: Path) -> None:
    text = (result.get("text") or "").strip()
    segments = result.get("segments") or []

    base.with_suffix(".txt").write_text(text + "\n", encoding="utf-8")

    md_lines = [
        f"# {item.get('title', '')}",
        "",
        f"- Source: {item.get('source', '')}",
        f"- URL: {item_url(item)}",
        f"- Published: {item.get('pubDate') or item.get('uploadDate') or ''}",
        f"- Duration: {item.get('duration', '')} seconds",
        f"- Audio: {item.get('audioFile', '')}",
        f"- Model: {MODEL}",
        "",
        "## Transcript",
        "",
    ]
    for seg in segments:
        seg_text = (seg.get("text") or "").strip()
        if seg_text:
            md_lines.append(f"[{timestamp(seg.get('start', 0))}] {seg_text}")
    base.with_suffix(".md").write_text("\n".join(md_lines).rstrip() + "\n", encoding="utf-8")

    srt_lines = []
    for idx, seg in enumerate(segments, 1):
        seg_text = (seg.get("text") or "").strip()
        if not seg_text:
            continue
        srt_lines.extend(
            [
                str(idx),
                f"{srt_timestamp(seg.get('start', 0))} --> {srt_timestamp(seg.get('end', seg.get('start', 0)))}",
                seg_text,
                "",
            ]
        )
    base.with_suffix(".srt").write_text("\n".join(srt_lines), encoding="utf-8")


def select_items(items: list[dict]) -> list[dict]:
    selected = []
    allowed_statuses = {"downloaded", "exists"}
    for item in items:
        if item.get("status") not in allowed_statuses:
            continue
        if not item.get("audioFile"):
            continue
        index = int(item.get("index") or 0)
        if START_INDEX and index < START_INDEX:
            continue
        if END_INDEX and index > END_INDEX:
            continue
        selected.append(item)
    if MAX_EPISODES:
        selected = selected[:MAX_EPISODES]
    return selected


def load_transcriber():
    if BACKEND == "mlx":
        try:
            import mlx_whisper  # type: ignore
        except ModuleNotFoundError:
            print(
                "Missing Python package: mlx_whisper. Install it in this Python environment with "
                "`python3 -m pip install mlx-whisper`, or run with a Python that already has it. "
                "Alternatively use `WHISPER_BACKEND=openai` in an environment with openai-whisper.",
                file=sys.stderr,
            )
            return None
        return ("mlx", mlx_whisper)

    if BACKEND in {"openai", "openai-whisper", "whisper"}:
        try:
            import whisper  # type: ignore
        except ModuleNotFoundError:
            print(
                "Missing Python package: openai-whisper. Install it with "
                "`python3 -m pip install openai-whisper`, or use `WHISPER_BACKEND=mlx`.",
                file=sys.stderr,
            )
            return None
        print(f"Loading OpenAI Whisper model: {MODEL}")
        kwargs = {"device": DEVICE} if DEVICE else {}
        return ("openai", whisper.load_model(MODEL, **kwargs))

    if BACKEND in {"faster", "faster-whisper", "faster_whisper"}:
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except ModuleNotFoundError:
            print(
                "Missing Python package: faster-whisper. Install it with "
                "`python3 -m pip install faster-whisper`, or use `WHISPER_BACKEND=mlx`/`openai`.",
                file=sys.stderr,
            )
            return None
        device = DEVICE or "cpu"
        print(f"Loading faster-whisper model: {MODEL} ({device}, {COMPUTE_TYPE})")
        return ("faster", WhisperModel(MODEL, device=device, compute_type=COMPUTE_TYPE))

    print(f"Unsupported WHISPER_BACKEND={BACKEND}. Use `mlx`, `openai`, or `faster`.", file=sys.stderr)
    return None


def transcribe_audio(transcriber, audio_file: Path) -> dict:
    backend, engine = transcriber
    if backend == "mlx":
        return engine.transcribe(
            str(audio_file),
            path_or_hf_repo=MODEL,
            language=LANGUAGE,
            task="transcribe",
            verbose=False,
            word_timestamps=WORD_TIMESTAMPS,
            initial_prompt=INITIAL_PROMPT or None,
            condition_on_previous_text=True,
        )

    if backend == "faster":
        segments_iter, info = engine.transcribe(
            str(audio_file),
            language=LANGUAGE,
            task="transcribe",
            beam_size=BEAM_SIZE,
            vad_filter=VAD_FILTER,
            word_timestamps=WORD_TIMESTAMPS,
            initial_prompt=INITIAL_PROMPT or None,
            condition_on_previous_text=True,
        )
        segments = []
        text_parts = []
        for segment in segments_iter:
            words = []
            if WORD_TIMESTAMPS and getattr(segment, "words", None):
                words = [
                    {"start": word.start, "end": word.end, "word": word.word, "probability": word.probability}
                    for word in segment.words
                ]
            text = (segment.text or "").strip()
            if text:
                text_parts.append(text)
            segments.append({"start": segment.start, "end": segment.end, "text": segment.text, "words": words})
        return {
            "text": "".join(text_parts),
            "segments": segments,
            "language": getattr(info, "language", LANGUAGE),
            "duration": getattr(info, "duration", 0),
            "duration_after_vad": getattr(info, "duration_after_vad", 0),
        }

    return engine.transcribe(
        str(audio_file),
        language=LANGUAGE,
        task="transcribe",
        verbose=False,
        word_timestamps=WORD_TIMESTAMPS,
        initial_prompt=INITIAL_PROMPT or None,
        condition_on_previous_text=True,
    )


def main() -> int:
    if not MANIFEST_FILE.exists():
        print(f"Missing manifest: {MANIFEST_FILE}", file=sys.stderr)
        return 2

    transcriber = load_transcriber()
    if transcriber is None:
        return 2
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    items = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    selected = select_items(items)
    failures = []
    completed = 0
    skipped = 0
    started_at = time.time()

    print(f"Manifest: {MANIFEST_FILE}")
    print(f"Output: {OUTPUT_DIR}")
    print(f"Backend: {BACKEND}")
    print(f"Model: {MODEL}")
    if DEVICE:
        print(f"Device: {DEVICE}")
    print(f"Language: {LANGUAGE}")
    print(f"Selected episodes: {len(selected)}")
    print(f"Word timestamps: {WORD_TIMESTAMPS}")

    for ordinal, item in enumerate(selected, 1):
        audio_file = Path(item["audioFile"])
        base = OUTPUT_DIR / safe_stem(item)
        json_file = base.with_suffix(".json")

        if json_file.exists() and not OVERWRITE:
            skipped += 1
            print(f"[skip] {ordinal}/{len(selected)} #{item.get('index')} {item.get('title')}")
            continue

        if not audio_file.exists():
            failures.append({"index": item.get("index"), "title": item.get("title"), "error": "audio file missing"})
            print(f"[fail] #{item.get('index')} missing audio: {audio_file}", file=sys.stderr)
            continue

        print(f"[tran] {ordinal}/{len(selected)} #{item.get('index')} {item.get('title')}", flush=True)
        one_started = time.time()
        try:
            result = transcribe_audio(transcriber, audio_file)
            elapsed = time.time() - one_started
            payload = {
                "episode": item,
                "backend": BACKEND,
                "model": MODEL,
                "elapsedSeconds": round(elapsed, 3),
                "transcript": result,
            }
            json_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            write_text_outputs(item, result, base)
            completed += 1
            duration = float(item.get("duration") or 0)
            speed = duration / elapsed if elapsed > 0 else 0
            print(f"[done] #{item.get('index')} {elapsed:.1f}s, {speed:.1f}x realtime")
        except Exception as exc:  # noqa: BLE001
            failures.append({"index": item.get("index"), "title": item.get("title"), "error": str(exc)})
            print(f"[fail] #{item.get('index')} {exc}", file=sys.stderr)

    summary = {
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "manifest": str(MANIFEST_FILE),
        "outputDir": str(OUTPUT_DIR),
        "backend": BACKEND,
        "model": MODEL,
        "language": LANGUAGE,
        "selectedCount": len(selected),
        "completedCount": completed,
        "skippedExistingCount": skipped,
        "failureCount": len(failures),
        "elapsedSeconds": round(time.time() - started_at, 3),
        "failures": failures,
    }
    (OUTPUT_DIR / "transcription-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print("\nDone.")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
