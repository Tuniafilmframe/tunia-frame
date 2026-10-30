#!/usr/bin/env python3
"""Quét thư mục frames/ và tạo frames/manifest.json.

Chạy lại mỗi khi bạn thêm hoặc xóa file khung PNG:
    python3 make_manifest.py
"""
import json
import pathlib
import re

folder = pathlib.Path(__file__).resolve().parent / "frames"
old = {}
mf = folder / "manifest.json"
if mf.exists():
    old = {i["id"]: i["name"] for i in json.loads(mf.read_text(encoding="utf-8"))}
items = []
for p in sorted(folder.glob("*.png")):
    name = re.sub(r"[-_]+", " ", p.stem).strip().capitalize()
    items.append({"id": p.stem, "name": old.get(p.stem, name), "file": p.name})

(folder / "manifest.json").write_text(
    json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
)
print(f"Đã tạo manifest với {len(items)} khung.")
