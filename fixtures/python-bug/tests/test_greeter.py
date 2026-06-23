import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from greeter import greet


class GreeterTest(unittest.TestCase):
    def test_greet_normalizes_name(self):
        self.assertEqual(greet(" Ada "), "hello ada")


if __name__ == "__main__":
    unittest.main()
