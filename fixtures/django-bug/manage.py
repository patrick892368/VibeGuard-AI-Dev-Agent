#!/usr/bin/env python
"""Django-style fixture entrypoint with a dependency-free test shim."""

import pathlib
import sys
import unittest


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "help"
    if command == "check":
        print("System check identified no issues (fixture shim).")
        return
    if command == "test":
        root = pathlib.Path(__file__).resolve().parent
        suite = unittest.defaultTestLoader.discover(str(root / "tests"))
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(0 if result.wasSuccessful() else 1)
    raise SystemExit("Supported fixture commands: check, test")


if __name__ == "__main__":
    main()
