#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KEYWORDS = [
    "商业模式",
    "估值",
    "现金流",
    "ROE",
    "毛利率",
    "净利率",
    "护城河",
    "竞争格局",
    "周期",
    "风险",
    "分红",
    "资本开支",
    "负债",
    "增长",
    "行业",
    "政策",
    "A股",
    "港股",
    "美股",
    "价值投资",
]


def latest_transcript_dir(catalog_dir: Path) -> Path:
    root = catalog_dir / "transcripts"
    candidates = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")] if root.exists() else []
    if not candidates:
        return root
    return max(candidates, key=lambda p: p.stat().st_mtime)


def env_path(name: str) -> Path | None:
    value = os.environ.get(name)
    return Path(value) if value else None


def keywords() -> list[str]:
    raw = os.environ.get("REF_KEYWORDS", "")
    if not raw:
        return DEFAULT_KEYWORDS
    return [item.strip() for item in re.split(r"[,，\n]", raw) if item.strip()]


def count_keyword(text: str, keyword: str) -> int:
    if not keyword:
        return 0
    if re.fullmatch(r"[A-Za-z0-9_.+-]+", keyword):
        return len(re.findall(re.escape(keyword), text, flags=re.IGNORECASE))
    return text.count(keyword)


def load_payload(file: Path) -> dict | None:
    if file.name == "transcription-summary.json":
        return None
    try:
        payload = json.loads(file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or "transcript" not in payload:
        return None
    return payload


def md_escape(value: object) -> str:
    return str(value or "").replace("|", "\\|").replace("\n", " ")


def rel(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


def main() -> int:
    catalog_dir = env_path("REF_CATALOG_DIR") or env_path("AUDIO_CATALOG_DIR") or ROOT / "data" / "xiaoyuzhou" / "mianji"
    transcript_dir = env_path("REF_TRANSCRIPT_DIR") or latest_transcript_dir(catalog_dir)
    output_file = env_path("REF_OUTPUT_FILE") or catalog_dir / "investment-reference-index.md"
    output_json = output_file.with_suffix(".json")
    terms = keywords()

    rows = []
    for file in sorted(transcript_dir.glob("*.json")):
        payload = load_payload(file)
        if not payload:
            continue
        item = payload.get("episode") or {}
        transcript = payload.get("transcript") or {}
        text = transcript.get("text") or ""
        hits = {term: count_keyword(text, term) for term in terms}
        hits = {term: count for term, count in hits.items() if count > 0}
        rows.append(
            {
                "score": sum(hits.values()),
                "keywordHits": hits,
                "title": item.get("title") or file.stem,
                "source": item.get("source") or "",
                "uploader": item.get("uploader") or "",
                "pubDate": str(item.get("pubDate") or item.get("uploadDate") or "")[:10],
                "duration": item.get("duration") or "",
                "url": item.get("episodeUrl") or item.get("webpageUrl") or "",
                "audioFile": item.get("audioFile") or "",
                "transcriptJson": str(file),
                "transcriptMd": str(file.with_suffix(".md")),
            }
        )

    rows.sort(key=lambda row: (row["score"], row["pubDate"]), reverse=True)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        "# 投资音频参考索引",
        "",
        f"- Generated: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        f"- Transcript dir: {transcript_dir}",
        f"- Items: {len(rows)}",
        f"- Keywords: {', '.join(terms)}",
        "",
        "## High-Signal Items",
        "",
        "| Score | Date | Source | Title | Keyword Hits | Transcript |",
        "| ---: | --- | --- | --- | --- | --- |",
    ]

    for row in rows:
        hit_text = ", ".join(f"{term}:{count}" for term, count in row["keywordHits"].items()) or "-"
        md_path = Path(row["transcriptMd"])
        transcript_link = rel(md_path, output_file.parent)
        lines.append(
            "| {score} | {date} | {source} | {title} | {hits} | [{name}]({link}) |".format(
                score=row["score"],
                date=md_escape(row["pubDate"]),
                source=md_escape(row["uploader"] or row["source"]),
                title=md_escape(row["title"]),
                hits=md_escape(hit_text),
                name=md_escape(md_path.name),
                link=transcript_link.replace(" ", "%20"),
            )
        )

    output_file.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    output_json.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {output_file}")
    print(f"Wrote {output_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
