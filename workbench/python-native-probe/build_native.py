from __future__ import annotations

import os
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path


PACKAGE_DIRECTORY = Path(__file__).resolve().parent
REPOSITORY_ROOT = PACKAGE_DIRECTORY.parents[1]
CONFIGURED_TARGET_DIRECTORY = os.environ.get("CARGO_TARGET_DIR")
TARGET_DIRECTORY = (
    Path(CONFIGURED_TARGET_DIRECTORY)
    if CONFIGURED_TARGET_DIRECTORY and Path(CONFIGURED_TARGET_DIRECTORY).is_absolute()
    else REPOSITORY_ROOT / (CONFIGURED_TARGET_DIRECTORY or "target")
).resolve()


def artifact_name() -> str:
    if sys.platform == "win32":
        return "_native.dll"
    if sys.platform == "darwin":
        return "lib_native.dylib"
    return "lib_native.so"


def main() -> None:
    environment = os.environ.copy()
    environment["PYO3_PYTHON"] = sys.executable
    subprocess.run(
        [
            "cargo",
            "build",
            "-p",
            "workflow_python_native_probe",
            "--locked",
        ],
        cwd=REPOSITORY_ROOT,
        check=True,
        env=environment,
    )
    extension_suffix = sysconfig.get_config_var("EXT_SUFFIX")
    if not extension_suffix:
        extension_suffix = ".pyd" if sys.platform == "win32" else ".so"
    source = TARGET_DIRECTORY / "debug" / artifact_name()
    destination = (
        PACKAGE_DIRECTORY
        / "workflow_python_native_probe"
        / f"_native{extension_suffix}"
    )
    shutil.copyfile(source, destination)


if __name__ == "__main__":
    main()
