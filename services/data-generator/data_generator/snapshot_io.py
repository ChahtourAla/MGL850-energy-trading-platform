
"""
Save validated hourly EnergySnapshots as JSON files.

Output naming convention:
    energy_snapshot_YYYY-MM-DDTHH.json

Examples:
    energy_snapshot_2026-10-18T12.json
    energy_snapshot_2026-10-18T18.json
"""

from pathlib import Path

from p2p_energy_shared import EnergySnapshot

from data_generator.energy_simulator import get_utc_hour


# --------------------------------------------------
# 1. Build a Windows-safe snapshot filename
# --------------------------------------------------

def snapshot_filename(time_slot: str) -> str:
    """
    Convert a validated UTC hourly timestamp
    into a standard snapshot filename.
    """

    get_utc_hour(time_slot)

    # Example:
    # 2026-10-18T12:00:00Z
    # becomes:
    # energy_snapshot_2026-10-18T12.json
    return f"energy_snapshot_{time_slot[:13]}.json"


# --------------------------------------------------
# 2. Save the snapshot as JSON
# --------------------------------------------------

def save_energy_snapshot(
    snapshot: EnergySnapshot,
    output_dir: str | Path,
    overwrite: bool = False,
) -> Path:
    """
    Export an EnergySnapshot to a UTF-8 JSON file.

    The function:
    - Accepts a validated EnergySnapshot.
    - Creates the output directory if necessary.
    - Uses the standard snapshot filename.
    - Refuses accidental file overwriting.
    - Returns the saved file path.
    """

    # ----------------------------------------------
    # 3. Validate arguments
    # ----------------------------------------------

    if not isinstance(snapshot, EnergySnapshot):
        raise TypeError(
            "snapshot must be an EnergySnapshot"
        )

    if type(overwrite) is not bool:
        raise TypeError(
            "overwrite must be a boolean"
        )

    # ----------------------------------------------
    # 4. Prepare the output path
    # ----------------------------------------------

    directory = Path(output_dir)

    filename = snapshot_filename(
        snapshot.time_slot
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    output_path = directory / filename

    # ----------------------------------------------
    # 5. Protect existing snapshots
    # ----------------------------------------------

    if output_path.exists() and not overwrite:
        raise FileExistsError(
            f"Snapshot already exists: {output_path}"
        )

    # ----------------------------------------------
    # 6. Serialize using shared JSON field names
    # ----------------------------------------------

    content = snapshot.model_dump_json(
        by_alias=True,
        indent=2,
    )

    # ----------------------------------------------
    # 7. Write the JSON file
    # ----------------------------------------------

    # "x" creates a new file exclusively.
    # "w" permits replacement when requested.
    mode = "w" if overwrite else "x"

    with output_path.open(
        mode,
        encoding="utf-8",
        newline="\n",
    ) as file:
        file.write(content)
        file.write("\n")

    return output_path
