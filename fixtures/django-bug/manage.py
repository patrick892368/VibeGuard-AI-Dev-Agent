#!/usr/bin/env python
"""Small Django-style fixture marker for repository detection."""


def main():
    raise SystemExit("This fixture uses unittest tests and does not require Django.")


if __name__ == "__main__":
    main()
