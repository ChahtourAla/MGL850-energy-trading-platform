
"""
Static user registry loader for the Energy Data Generator.

The registry contains simulated user profiles.
Blockchain accounts are created by the backend,
not by this module.
"""

from pathlib import Path

from pydantic import ValidationError

from p2p_energy_shared import UserRegistry


# --------------------------------------------------
# 1. Load a user registry from a JSON file
# --------------------------------------------------

def load_user_registry(
    file_path: str | Path
) -> UserRegistry:

    # Convert the provided path into a Path object.
    path = Path(file_path)

    # --------------------------------------------------
    # 2. Check that the file exists
    # --------------------------------------------------

    if not path.is_file():
        raise FileNotFoundError(
            f"User registry file not found: {path}"
        )

    # --------------------------------------------------
    # 3. Read the JSON file
    # --------------------------------------------------

    try:
        content = path.read_text(
            encoding="utf-8"
        )

    except UnicodeDecodeError as error:
        raise ValueError(
            f"User registry is not valid UTF-8: {path}"
        ) from error

    # --------------------------------------------------
    # 4. Validate JSON using our shared models
    # --------------------------------------------------

    try:
        registry = UserRegistry.model_validate_json(
            content
        )

    except ValidationError as error:
        raise ValueError(
            f"Invalid user registry '{path}': {error}"
        ) from error

    # --------------------------------------------------
    # 5. Return the validated registry
    # --------------------------------------------------

    return registry
