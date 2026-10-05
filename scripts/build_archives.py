#!/usr/bin/env python3
"""Build self-contained Qwen release assets using only the Python standard library."""

import argparse
import copy
import json
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PLATFORMS = ("win32", "linux", "darwin")


def build(output: Path) -> None:
    template = json.loads((ROOT / "packaging/qwen-extension.json").read_text("utf-8"))
    sources = [ROOT / name for name in ("LICENSE", "README.md", "mcp/package.json", "mcp/DIAGNOSTICS.md")]
    for directory in ("qwen", "hooks", "mcp/src"):
        sources.extend(sorted((ROOT / directory).glob("*.mjs")))
    contents = {}
    for source in sources:
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"Expected a regular package file: {source.relative_to(ROOT)}")
        # Checkouts may use CRLF; archive bytes must be independent of the build host.
        contents[source.relative_to(ROOT).as_posix()] = source.read_bytes().replace(b"\r\n", b"\n")
    output.mkdir(parents=True, exist_ok=True)
    for platform in PLATFORMS:
        manifest = copy.deepcopy(template)
        for definitions in manifest.get("hooks", {}).values():
            for definition in definitions:
                for hook in definition.get("hooks", []):
                    if hook.get("type") == "command":
                        hook.pop("shell", None)
                        if platform == "win32":
                            hook["shell"] = "powershell"
        files = {**contents, "qwen-extension.json": (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")}
        path = output / f"{platform}.{manifest['name']}.zip"
        # Fixed order, timestamps and permissions; stored ZIP avoids zlib-version drift.
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
        print(path.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    build(parser.parse_args().output)
