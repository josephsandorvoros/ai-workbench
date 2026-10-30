import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LicenseTests(unittest.TestCase):
    def test_project_license_and_manifests_agree(self):
        license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
        self.assertTrue(license_text.startswith("MIT License\n"))
        self.assertIn("AI Workbench contributors", license_text)
        self.assertIn("The above copyright notice and this permission notice", license_text)
        self.assertIn('THE SOFTWARE IS PROVIDED "AS IS"', license_text)
        manifest = json.loads((ROOT / "spatial-workbench" / "package.json").read_text())
        lock = json.loads((ROOT / "spatial-workbench" / "package-lock.json").read_text())
        self.assertEqual(manifest["license"], "MIT")
        self.assertEqual(lock["packages"][""]["license"], "MIT")
        cargo = (ROOT / "spatial-workbench" / "src-tauri" / "Cargo.toml").read_text()
        self.assertIn('license = "MIT"', cargo)

    def test_build_and_image_recipes_ship_notices(self):
        manifest = json.loads((ROOT / "spatial-workbench" / "package.json").read_text())
        self.assertIn("npm run licenses", manifest["scripts"]["build"])
        for component in ("agent", "web", "sandbox", "worker"):
            dockerfile = (ROOT / "deploy" / component / "Dockerfile").read_text()
            self.assertIn("COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/ai-workbench/", dockerfile)
        web = (ROOT / "deploy" / "web" / "Dockerfile").read_text()
        self.assertIn("COPY licenses/ /licenses/", web)
        self.assertIn("python3 libfreetype6", web)

    def test_public_publish_checks_review_before_external_operations(self):
        script = (ROOT / "deploy" / "publish-github.sh").read_text()
        self.assertLess(script.index("check-license-review.mjs"), script.index("skopeo login"))
        self.assertLess(script.index("check-license-review.mjs"), script.index("push --atomic"))

    def test_license_review_warns_about_deferred_items_without_claiming_approval(self):
        with tempfile.TemporaryDirectory() as directory:
            review_file = Path(directory) / "review.json"
            for review, expected, message in (
                ({"status": "pending", "blockers": ["deferred font work"], "reviewedAt": "2026-10-30", "evidence": "fixture"}, 0, "remains pending"),
                ({"status": "approved", "blockers": ["still unresolved"], "reviewedAt": "2026-10-30", "evidence": "fixture"}, 0, "remains pending"),
                ({"status": "approved", "blockers": []}, 1, "requires a date and evidence"),
                ({"status": "approved", "blockers": [], "reviewedAt": "2026-10-30", "evidence": "fixture"}, 0, "review: approved"),
            ):
                with self.subTest(review=review):
                    review_file.write_text(json.dumps(review), encoding="utf-8")
                    result = subprocess.run(
                        ["node", str(ROOT / "deploy" / "check-license-review.mjs"), str(review_file)],
                        text=True, capture_output=True,
                    )
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    self.assertIn(message, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()