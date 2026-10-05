"""Compatibility entry point: generate the current Nudgi SVG icons with Electron."""
from pathlib import Path
import subprocess

if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    subprocess.run([str(root / "node_modules/electron/dist/electron.exe"), str(root / "scripts/make-icons.cjs")], cwd=root, check=True)
