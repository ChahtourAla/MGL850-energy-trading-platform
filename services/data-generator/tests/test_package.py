
import pytest

from data_generator import __version__
from data_generator.cli import main


def test_package_version():
    assert __version__ == "1.0.0"


def test_cli_version(capsys):
    with pytest.raises(SystemExit) as result:
        main(["--version"])

    assert result.value.code == 0

    output = capsys.readouterr().out

    assert "data-generator 1.0.0" in output


def test_cli_help(capsys):
    with pytest.raises(SystemExit) as result:
        main(["--help"])

    assert result.value.code == 0

    output = capsys.readouterr().out

    assert "usage:" in output
    assert "--version" in output
