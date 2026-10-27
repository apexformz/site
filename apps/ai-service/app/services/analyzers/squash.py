"""Experimental static-position feedback, not a validated squash model.

The app-authored angle guides implement only coarse body-position cues from
Squash Canada's ready-position and volley coaching notes. They do not measure
racket orientation, ball contact, weight distribution, or stroke quality.
"""
from .base import BaseAnalyzer


class SquashAnalyzer(BaseAnalyzer):
    def analyze(self, keypoints, actual_angles):
        result = super().analyze(keypoints, actual_angles)
        # A good average must never hide a specific positional correction.
        if any(issue["severity"] == "high" for issue in result["issues"]):
            result["overall_severity"] = "error"
        elif any(issue["severity"] == "medium" for issue in result["issues"]):
            result["overall_severity"] = "warning"
        return result

    def _score_blueprint(self, ref_angles, actual_angles, visibility_ratio, missing_regions):
        result = super()._score_blueprint(ref_angles, actual_angles, visibility_ratio, missing_regions)
        for issue in result["issues"]:
            if issue["joint"] in ref_angles:
                issue["problem"] = f"{issue['joint'].replace('_', ' ').capitalize()} differs from the experimental position guide"
        return result
