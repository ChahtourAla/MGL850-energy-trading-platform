
"""
Verify that the standalone backend handoff check passes.
"""

import subprocess
import sys

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_python_services_backend_handoff():

    script = (
        ROOT
        / "scripts"
        / "check_python_handoff.py"
    )

    assert script.is_file()

    result = subprocess.run(
        [
            sys.executable,
            str(script),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, (
        f"STDOUT:\n{result.stdout}\n"
        f"STDERR:\n{result.stderr}"
    )

    assert (
        "PASS: Python services backend handoff"
        in result.stdout
    )

    assert "JSON Schemas: valid" in result.stdout

    assert (
        "Seller energy conservation: valid"
        in result.stdout
    )
