import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from accounts.views import profile_template


class ProfileViewTest(unittest.TestCase):
    def test_profile_template_matches_existing_template(self):
        self.assertEqual(profile_template(), "accounts/detail.html")


if __name__ == "__main__":
    unittest.main()
