from __future__ import annotations

import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageChops, UnidentifiedImageError

ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = ROOT / "manifest.json"
REPORT_PATH = ROOT / "validation-report.json"
CENTRAL_CLEARANCE_KEYS = {
    "kitty_head_1", "bunny_1", "ghostBladeNebula", "cuteParty", "kittyRing2", "20260203potato",
    "meowQuest", "privateDetective", "catVillageOverseer_1", "catVillageOverseer_2",
    "SpringFestivalLuckyCat2026", "SpringFestival2026_1", "SpringFestival2026_LuckyHorseCat",
    "holyPawsGospel", "emberClaw", "SpringFestival2026_12",
    "SpringFestival2026_LuckyHorseCat2", "slumberCat", "catMercante",
}
TRANSPARENCY_REQUIRED_CATEGORIES = {"battleStyle", "avatarBorder", "animatedAvatar"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def alpha_extrema(image: Image.Image):
    rgba = image.convert("RGBA")
    return rgba.getchannel("A").getextrema()


def center_circle_is_clear(image: Image.Image, minimum_diameter_percent: float):
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    w, h = rgba.size
    radius = min(w, h) * minimum_diameter_percent / 200.0
    cx, cy = w / 2.0, h / 2.0
    pix = alpha.load()
    opaque_samples = 0
    max_alpha = 0
    sample_count = 0
    # Stay 1 px inside the boundary to avoid rejecting harmless edge antialiasing.
    limit = max(0.0, radius - 1.0)
    limit_sq = limit * limit
    x0 = max(0, int(math.floor(cx - limit)))
    x1 = min(w - 1, int(math.ceil(cx + limit)))
    y0 = max(0, int(math.floor(cy - limit)))
    y1 = min(h - 1, int(math.ceil(cy + limit)))
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= limit_sq:
                value = int(pix[x, y])
                sample_count += 1
                max_alpha = max(max_alpha, value)
                if value > 8:
                    opaque_samples += 1
    return {
        "passed": opaque_samples == 0,
        "minimumDiameterPercent": minimum_diameter_percent,
        "sampleCount": sample_count,
        "nonClearSamples": opaque_samples,
        "maximumAlpha": max_alpha,
    }


def validate_asset(entry):
    relative = entry["candidatePath"]
    path = ROOT / relative
    expected = entry["spec"]
    result = {
        "key": entry["key"],
        "category": entry["category"],
        "variant": entry["variant"],
        "path": relative,
        "targetLogicalPath": entry["targetLogicalPath"],
        "checks": {},
        "errors": [],
        "warnings": [],
    }
    if not path.is_file():
        result["checks"]["exists"] = False
        result["errors"].append("文件不存在")
        result["passed"] = False
        return result
    result["checks"]["exists"] = True
    result["bytes"] = path.stat().st_size
    result["sha256"] = sha256(path)
    try:
        with Image.open(path) as image:
            image.load()
            actual_format = image.format
            actual_mode = image.mode
            size = list(image.size)
            frame_count = int(getattr(image, "n_frames", 1))
            result["actual"] = {
                "width": size[0], "height": size[1], "format": actual_format,
                "mode": actual_mode, "frames": frame_count,
            }
            result["checks"]["decodable"] = True
            dim_ok = size == [expected["width"], expected["height"]]
            result["checks"]["dimensions"] = dim_ok
            if not dim_ok:
                result["errors"].append(f"尺寸应为 {expected['width']}x{expected['height']}，实际 {size[0]}x{size[1]}")
            format_ok = (actual_format or "").upper() == expected["format"].upper()
            result["checks"]["format"] = format_ok
            if not format_ok:
                result["errors"].append(f"格式应为 {expected['format']}，实际 {actual_format}")

            # Alpha validation checks both channel presence and real transparent content where mandated.
            frame_alpha = []
            transparent_pixel_found = False
            for frame_index in range(frame_count):
                image.seek(frame_index)
                frame = image.convert("RGBA")
                extrema = frame.getchannel("A").getextrema()
                frame_alpha.append(list(extrema))
                transparent_pixel_found = transparent_pixel_found or extrema[0] < 255
            alpha_channel_present = "A" in image.getbands() or "transparency" in image.info or actual_format == "GIF"
            alpha_ok = (not expected.get("alphaRequired")) or alpha_channel_present
            result["checks"]["alphaChannel"] = alpha_ok
            result["actual"]["alphaExtremaByFrame"] = frame_alpha
            if not alpha_ok:
                result["errors"].append("声明需要 alpha，但未检测到 alpha/透明索引通道")

            transparency_mandated = (
                entry["category"] in TRANSPARENCY_REQUIRED_CATEGORIES
                and entry["variant"] not in {"scene"}
            )
            if transparency_mandated:
                result["checks"]["transparentPixels"] = transparent_pixel_found
                if not transparent_pixel_found:
                    result["errors"].append("透明头像/头像框必须包含透明像素")

            if expected["format"].upper() == "GIF":
                expected_frames = int(entry.get("frames", 2))
                frames_ok = frame_count == expected_frames and frame_count > 1
                result["checks"]["gifFrameCount"] = frames_ok
                if not frames_ok:
                    result["errors"].append(f"GIF 帧数应为 {expected_frames}，实际 {frame_count}")
                # Prove there is visible motion, not duplicated review frames.
                image.seek(0)
                first = image.convert("RGBA")
                motion_frames = 0
                for frame_index in range(1, frame_count):
                    image.seek(frame_index)
                    current = image.convert("RGBA")
                    diff = ImageChops.difference(first, current)
                    if diff.getbbox() is not None:
                        motion_frames += 1
                motion_ok = motion_frames > 0
                result["checks"]["gifHasMotion"] = motion_ok
                result["actual"]["framesDifferentFromFirst"] = motion_frames
                if not motion_ok:
                    result["errors"].append("GIF 所有帧相同，未检测到动画")

            if entry["key"] in CENTRAL_CLEARANCE_KEYS and "centralClearance" in entry:
                minimum = float(entry["centralClearance"]["minimumDiameterPercent"])
                clearance_results = []
                for frame_index in range(frame_count):
                    image.seek(frame_index)
                    clearance_results.append(center_circle_is_clear(image, minimum))
                clearance_ok = all(x["passed"] for x in clearance_results)
                result["checks"]["centralClearance"] = clearance_ok
                result["actual"]["centralClearanceByFrame"] = clearance_results
                if not clearance_ok:
                    failures = sum(not x["passed"] for x in clearance_results)
                    result["errors"].append(f"中央直径 {minimum:.0f}% 净空失败：{failures} 帧包含非透明像素")
    except (UnidentifiedImageError, OSError, ValueError, EOFError) as exc:
        result["checks"]["decodable"] = False
        result["errors"].append(f"解码失败：{type(exc).__name__}: {exc}")

    result["passed"] = not result["errors"] and all(result["checks"].values())
    return result


def validate_contact_sheet(entry):
    path = ROOT / entry["path"]
    result = {"path": entry["path"], "checks": {}, "errors": []}
    if not path.is_file():
        result["checks"]["exists"] = False
        result["errors"].append("联系表不存在")
        result["passed"] = False
        return result
    result["checks"]["exists"] = True
    result["bytes"] = path.stat().st_size
    result["sha256"] = sha256(path)
    try:
        with Image.open(path) as image:
            image.load()
            spec = entry["spec"]
            result["actual"] = {"width": image.width, "height": image.height, "format": image.format, "mode": image.mode}
            result["checks"]["decodable"] = True
            result["checks"]["dimensions"] = [image.width, image.height] == [spec["width"], spec["height"]]
            result["checks"]["format"] = image.format == spec["format"]
            if not result["checks"]["dimensions"]:
                result["errors"].append("联系表尺寸与 manifest 不一致")
            if not result["checks"]["format"]:
                result["errors"].append("联系表格式与 manifest 不一致")
    except (UnidentifiedImageError, OSError, ValueError, EOFError) as exc:
        result["checks"]["decodable"] = False
        result["errors"].append(f"解码失败：{type(exc).__name__}: {exc}")
    result["passed"] = not result["errors"] and all(result["checks"].values())
    return result


def main():
    if not MANIFEST_PATH.is_file():
        print("manifest.json 不存在", file=sys.stderr)
        return 2
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    assets = [validate_asset(entry) for entry in manifest["assets"]]
    sheets = [validate_contact_sheet(entry) for entry in manifest["contactSheets"]]

    duplicate_paths = sorted({x for x in [a["candidatePath"] for a in manifest["assets"]] if [a["candidatePath"] for a in manifest["assets"]].count(x) > 1})
    duplicate_identity = sorted({f"{a['category']}:{a['variant']}:{a['key']}" for a in manifest["assets"] if [f"{b['category']}:{b['variant']}:{b['key']}" for b in manifest["assets"]].count(f"{a['category']}:{a['variant']}:{a['key']}") > 1})
    expected_assets = int(manifest.get("expectedAssetCount", len(assets)))
    scope_files = sorted(p for p in ROOT.rglob("*") if p.is_file() and p != REPORT_PATH)
    failures = [x for x in assets + sheets if not x["passed"]]

    summary = {
        "passed": not failures and not duplicate_paths and not duplicate_identity and len(assets) == expected_assets,
        "assetRecords": len(assets),
        "expectedAssetRecords": expected_assets,
        "assetRecordsPassed": sum(x["passed"] for x in assets),
        "assetRecordsFailed": sum(not x["passed"] for x in assets),
        "contactSheets": len(sheets),
        "contactSheetsPassed": sum(x["passed"] for x in sheets),
        "contactSheetsFailed": sum(not x["passed"] for x in sheets),
        "gifAssets": sum(a["spec"]["format"].upper() == "GIF" for a in manifest["assets"]),
        "centralClearanceAssets": sum("centralClearance" in a for a in manifest["assets"]),
        "duplicateCandidatePaths": duplicate_paths,
        "duplicateIdentityRecords": duplicate_identity,
        "scopeFileCountBeforeReport": len(scope_files),
        "scopeBytesBeforeReport": sum(p.stat().st_size for p in scope_files),
    }
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "validator": "phase1-style-candidates/validate.py",
        "pillowVersion": Image.__version__,
        "checksPerformed": ["decode", "dimensions", "format", "alpha-channel", "transparent-pixels", "GIF-frame-count", "GIF-motion", "central-clearance-58-percent"],
        "summary": summary,
        "assets": assets,
        "contactSheets": sheets,
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
