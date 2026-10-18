
import pytest

from matching_engine import __version__
from matching_engine.cli import main


# ------------------------------------------
# TEST 1: Package version
# ------------------------------------------

def test_package_version():
    assert __version__ == "1.0.0"


# ------------------------------------------
# TEST 2: CLI version command
# ------------------------------------------

def test_cli_version(capsys):

    with pytest.raises(SystemExit) as result:
        main(["--version"])

    assert result.value.code == 0

    output = capsys.readouterr().out

    assert "matching-engine 1.0.0" in output


# ------------------------------------------
# TEST 3: CLI help command
# ------------------------------------------

def test_cli_help(capsys):

    with pytest.raises(SystemExit) as result:
        main(["--help"])

    assert result.value.code == 0

    output = capsys.readouterr().out

    assert "--input" in output
    assert "--output" in output
    assert "--config" in output


# ------------------------------------------
# TEST 4: Required arguments
# ------------------------------------------

def test_cli_requires_arguments():

    with pytest.raises(SystemExit) as result:
        main([])

    assert result.value.code == 2


# ------------------------------------------
# TEST 5: Algorithm not implemented yet
# ------------------------------------------


def test_cli_requires_config_for_execution():
    from matching_engine.cli import main

    with pytest.raises(SystemExit) as error:
        main([
            "--input", "input.json",
            "--output", "output.json",
        ])

    assert error.value.code == 2
