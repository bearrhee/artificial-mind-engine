#!/usr/bin/env python3
"""
Stage, security-audit, and publish Artificial Mind Engine Hugging Face Hub assets:
  - Space (Docker):  <org>/ame-sandbox-live
  - Space (Static):  <org>/ame-benchmarks
  - Dataset:         <org>/cogeval-v1
  - Dataset:         <org>/ame-eval-traces
  - Collection:      <org> Stateful Cognitive Control & Long-Horizon Memory Stack

Runs a built-in Closed-IP (.ts blocklist) & Secret Guard BEFORE touching HF Hub.
Use `--dry-run` to validate all staging folders without HF_TOKEN.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import sys
import tempfile

import pyarrow.parquet as pq
from huggingface_hub import HfApi

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
HF_ROOT = pathlib.Path(__file__).resolve().parent

FORBIDDEN_TS_NAMES = {
    "aacim-affect-plasticity.ts",
    "hierarchical-pc.ts",
    "fep-selective-attention.ts",
    "somatic-markers.ts",
}

SECRET_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"
)


def parse_frontmatter(readme_path: pathlib.Path) -> dict[str, str]:
    text = readme_path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError(f"{readme_path} missing YAML frontmatter '---'")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise ValueError(f"{readme_path} missing closing YAML frontmatter '---'")
    meta: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" in line and not line.startswith((" ", "-")):
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta


def guard_directory(stage_dir: pathlib.Path) -> tuple[int, int]:
    file_count = 0
    total_bytes = 0
    for path in stage_dir.rglob("*"):
        if not path.is_file():
            continue
        file_count += 1
        total_bytes += path.stat().st_size
        rel = path.relative_to(stage_dir).as_posix()
        if path.name in FORBIDDEN_TS_NAMES or (path.suffix == ".ts" and not path.name.endswith(".d.ts")):
            raise RuntimeError(f"Closed-IP .ts file forbidden in HF bundle: {rel}")
        if path.suffix == ".parquet":
            table = pq.read_table(path)
            if table.num_rows <= 0:
                raise RuntimeError(f"Empty parquet table: {rel}")
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        m = SECRET_RE.search(content)
        if m:
            raise RuntimeError(f"Secret pattern detected in {rel}: {m.group(1)[:10]}...")
    return file_count, total_bytes


def stage_sandbox_space(dest: pathlib.Path, sandbox_api_base: str = "https://thesoulthread.com/ame-demo") -> dict[str, str]:
    src_space = HF_ROOT / "spaces" / "ame-sandbox-live"
    shutil.copy2(src_space / "README.md", dest / "README.md")
    html = (REPO_ROOT / "packages" / "sandbox-server" / "src" / "demo-ui.html").read_text(encoding="utf-8")
    if "</head>" not in html:
        raise ValueError("demo-ui.html missing closing </head> tag")
    api_inject = f"  <script>window.__AME_API_BASE__ = {json.dumps(sandbox_api_base)};</script>\n</head>"
    (dest / "index.html").write_text(html.replace("</head>", api_inject, 1), encoding="utf-8")
    shutil.copy2(REPO_ROOT / "spec" / "openapi.yaml", dest / "openapi.yaml")

    meta = parse_frontmatter(dest / "README.md")
    if meta.get("sdk") != "static" or meta.get("app_file") != "index.html":
        raise ValueError(f"Invalid Static Sandbox Space YAML in {dest / 'README.md'}: {meta}")
    return meta


def stage_benchmarks_space(dest: pathlib.Path) -> dict[str, str]:
    src_space = HF_ROOT / "spaces" / "ame-benchmarks"
    shutil.copy2(src_space / "README.md", dest / "README.md")
    shutil.copy2(REPO_ROOT / "docs" / "index.html", dest / "index.html")
    charts_dst = dest / "charts"
    charts_dst.mkdir(parents=True, exist_ok=True)
    for svg in (REPO_ROOT / "docs" / "charts").glob("*.svg"):
        shutil.copy2(svg, charts_dst / svg.name)

    meta = parse_frontmatter(dest / "README.md")
    if meta.get("sdk") != "static" or meta.get("app_file") != "index.html":
        raise ValueError(f"Invalid Static Space YAML in {dest / 'README.md'}: {meta}")
    return meta


def stage_dataset(name: str, dest: pathlib.Path) -> dict[str, str]:
    src = HF_ROOT / "datasets" / name
    shutil.copy2(src / "README.md", dest / "README.md")
    shutil.copytree(src / "data", dest / "data")
    meta = parse_frontmatter(dest / "README.md")
    if not meta.get("license"):
        raise ValueError(f"Dataset YAML missing license in {dest / 'README.md'}")
    return meta


def ensure_collection(api: HfApi, org: str) -> None:
    title = "Stateful Cognitive Control & Long-Horizon Memory Stack (AME)"
    description = (
        "Official collection for Artificial Mind Engine (AME v4.3.0): interactive live cognitive OS sandbox, "
        "Tier-1 benchmark explorer, self-authored CogEval-v1 probes, D4-redacted evaluation traces, and key ecosystem models/benchmarks."
    )
    existing_slug = None
    try:
        for col in api.list_collections(owner=org):
            if col.title == title:
                existing_slug = col.slug
                break
    except Exception:
        existing_slug = None

    if existing_slug is None:
        col = api.create_collection(title=title, namespace=org, description=description, private=False)
        existing_slug = col.slug

    desired_items = [
        (f"{org}/ame-sandbox-live", "space", "Interactive OpenAPI 3.1 contract sandbox (D2/D3/D4, HOT, FEP Lock — zero API key)"),
        (f"{org}/ame-benchmarks", "space", "Interactive charts: LongMemEval-S v4.3.0 (60.00%, -92.67% tok), 5,000T EN Marathon, LoCoMo, EQ-Bench 3"),
        (f"{org}/cogeval-v1", "dataset", "Self-authored EN probes: D1 counterfactual, HOT abstention, FEP Lock, IGT-Conv, D2/D3/D4"),
        (f"{org}/ame-eval-traces", "dataset", "D4-redacted Tier-1 evaluation trajectories (5,000T EN, 5-LLM EN, CogEval-v1 4 arms, LongMemEval-S n=70)"),
        ("google/gemma-4-26b-a4b-it", "model", "26B open-weight backbone reaching 75.66% standalone LoCoMo Confirm-304 & 77.77 EQ-Bench 3 with AME"),
        ("xiaowu0162/longmemeval-cleaned", "dataset", "Upstream LongMemEval benchmark corpus evaluated in Track 4 (n=70 Stratified EN)"),
    ]
    for item_id, item_type, note in desired_items:
        try:
            api.add_collection_item(
                collection_slug=existing_slug,
                item_id=item_id,
                item_type=item_type,
                note=note,
                exists_ok=True,
            )
        except Exception as exc:
            print(f"[WARN] collection item {item_id} skipped: {exc}", file=sys.stderr)
    print(f"[COLLECTION READY] https://huggingface.co/collections/{existing_slug}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage and publish AME assets to Hugging Face Hub")
    parser.add_argument("--org", default="artificial-mind", help="Target HF organization/user namespace")
    parser.add_argument(
        "--sandbox-api-base",
        default="https://thesoulthread.com/ame-demo",
        help="Public CORS sandbox backend URL injected into ame-sandbox-live Static Space",
    )
    parser.add_argument("--dry-run", action="store_true", help="Stage & verify locally without uploading")
    parser.add_argument("--only", choices=["all", "spaces", "datasets", "collection"], default="all")
    parser.add_argument("--skip-collection", action="store_true")
    parser.add_argument("--keep-stage", type=pathlib.Path, default=None, help="Optional directory to keep staged artifacts")
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    if not args.dry_run and not token:
        print("HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) is required unless --dry-run is set.", file=sys.stderr)
        return 1

    stage_root = args.keep_stage.resolve() if args.keep_stage else pathlib.Path(tempfile.mkdtemp(prefix="ame_hf_stage_"))
    stage_root.mkdir(parents=True, exist_ok=True)
    cleanup_needed = args.keep_stage is None

    try:
        targets: list[tuple[str, str, str | None, pathlib.Path]] = []
        if args.only in ("all", "spaces"):
            d1 = stage_root / "ame-sandbox-live"
            d1.mkdir(parents=True, exist_ok=True)
            stage_sandbox_space(d1, sandbox_api_base=args.sandbox_api_base)
            c1, b1 = guard_directory(d1)
            print(f"[STAGED SPACE/static] {args.org}/ame-sandbox-live ({c1} files, {b1:,} bytes)")
            targets.append((f"{args.org}/ame-sandbox-live", "space", "static", d1))

            d2 = stage_root / "ame-benchmarks"
            d2.mkdir(parents=True, exist_ok=True)
            stage_benchmarks_space(d2)
            c2, b2 = guard_directory(d2)
            print(f"[STAGED SPACE/static] {args.org}/ame-benchmarks ({c2} files, {b2:,} bytes)")
            targets.append((f"{args.org}/ame-benchmarks", "space", "static", d2))

        if args.only in ("all", "datasets"):
            for ds_name in ("cogeval-v1", "ame-eval-traces"):
                d_ds = stage_root / ds_name
                d_ds.mkdir(parents=True, exist_ok=True)
                stage_dataset(ds_name, d_ds)
                cd, bd = guard_directory(d_ds)
                print(f"[STAGED DATASET] {args.org}/{ds_name} ({cd} files, {bd:,} bytes)")
                targets.append((f"{args.org}/{ds_name}", "dataset", None, d_ds))

        if args.dry_run:
            print(f"[DRY-RUN COMPLETE] Staged & audited under {stage_root}")
            return 0

        api = HfApi(token=token)
        for repo_id, repo_type, space_sdk, local_dir in targets:
            create_kwargs: dict[str, object] = {
                "repo_id": repo_id,
                "repo_type": repo_type,
                "exist_ok": True,
                "private": False,
            }
            if repo_type == "space" and space_sdk:
                create_kwargs["space_sdk"] = space_sdk
            api.create_repo(**create_kwargs)  # type: ignore[arg-type]
            api.upload_folder(
                folder_path=str(local_dir),
                repo_id=repo_id,
                repo_type=repo_type,
                commit_message="Sync Artificial Mind Engine (AME v4.3.0 / AACIM v2.5.2)",
            )
            print(f"[PUBLISHED] https://huggingface.co/{'datasets/' if repo_type == 'dataset' else 'spaces/'}{repo_id}")

        if args.only in ("all", "collection") and not args.skip_collection:
            ensure_collection(api, args.org)

        return 0
    finally:
        if cleanup_needed:
            shutil.rmtree(stage_root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
