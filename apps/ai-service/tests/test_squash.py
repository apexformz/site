"""Implementation tests for experimental Squash; not efficacy validation."""
import math
import unittest

from app.services.pose_analyzer import analyze_pose, REFERENCE_POSES


def position_landmarks(angles):
    """Build an articulated 2D skeleton, then let the real engine recover angles."""
    points = []
    def point(name, x, y):
        points.append({"name": name, "x": x, "y": y, "score": 1.0})
        return x, y
    def limb(name, origin, direction, length):
        theta = math.radians(direction)
        return point(name, origin[0] + length * math.cos(theta), origin[1] + length * math.sin(theta))
    for side, x, sign in [("left", .38, 1), ("right", .62, -1)]:
        shoulder = point(f"{side}_shoulder", x, .25)
        hip = point(f"{side}_hip", x, .5)
        arm_direction = 90 + sign * angles[f"{side}_shoulder"]
        elbow = limb(f"{side}_elbow", shoulder, arm_direction, .14)
        limb(f"{side}_wrist", elbow, arm_direction + 180 + sign * angles[f"{side}_elbow"], .12)
        leg_direction = -90 - sign * angles[f"{side}_hip"]
        knee = limb(f"{side}_knee", hip, leg_direction, .18)
        limb(f"{side}_ankle", knee, leg_direction + 180 - sign * angles[f"{side}_knee"], .18)
    return points


class SquashPositionTests(unittest.TestCase):
    def test_each_position_scores_aligned_landmarks_above_straight_arms(self):
        for pose, target in REFERENCE_POSES["squash"].items():
            with self.subTest(pose=pose):
                aligned = analyze_pose("squash", position_landmarks(target), pose)
                changed = dict(target, left_elbow=180, right_elbow=180, left_shoulder=0, right_shoulder=0)
                incorrect = analyze_pose("squash", position_landmarks(changed), pose)
                self.assertGreaterEqual(aligned["score"], 95)
                self.assertLess(incorrect["score"], aligned["score"] - 10)
                self.assertTrue(any("elbow" in issue["joint"] for issue in incorrect["issues"]))
                self.assertTrue(any("experimental" in issue["problem"] for issue in incorrect["issues"]))
                self.assertEqual(aligned["analysis_mode"], "experimental_static")

    def test_mirrored_position_is_accepted(self):
        pose = "forehand_volley_preparation"
        landmarks = position_landmarks(REFERENCE_POSES["squash"][pose])
        for item in landmarks:
            prefix, rest = item["name"].split("_", 1)
            item["name"] = ("right" if prefix == "left" else "left") + "_" + rest
        self.assertGreaterEqual(analyze_pose("squash", landmarks, pose)["score"], 95)

    def test_high_average_does_not_hide_one_actionable_joint(self):
        target = dict(REFERENCE_POSES["squash"]["ready_stance"], left_elbow=180)
        result = analyze_pose("squash", position_landmarks(target), "ready_stance")
        self.assertGreater(result["score"], 80)
        self.assertEqual(result["overall_severity"], "error")
        self.assertTrue(any(issue["joint"] == "left_elbow" and issue["severity"] == "high" for issue in result["issues"]))

    def test_missing_body_cannot_get_a_good_score(self):
        result = analyze_pose("squash", [], "ready_stance")
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["overall_severity"], "error")
        self.assertTrue(any(issue["joint"] == "body_visibility" for issue in result["issues"]))

    def test_unknown_pose_is_not_silently_substituted(self):
        landmarks = position_landmarks(REFERENCE_POSES["squash"]["ready_stance"])
        self.assertEqual(analyze_pose("squash", landmarks, "unknown_pose")["score"], 0)

    def test_no_cross_athlete_smoothing_or_grip_claim(self):
        target = REFERENCE_POSES["squash"]["ready_stance"]
        changed = dict(target, left_elbow=180, right_elbow=180)
        first = analyze_pose("squash", position_landmarks(changed), "ready_stance")
        hand = {"handedness": "Left", "keypoints": [{"x": i / 30, "y": .5, "score": 1} for i in range(21)]}
        good = analyze_pose("squash", position_landmarks(target), "ready_stance", [hand])
        second = analyze_pose("squash", position_landmarks(changed), "ready_stance")
        self.assertEqual(first["score"], second["score"])
        self.assertFalse(any("grip" in issue["problem"].lower() for issue in good["issues"]))


if __name__ == "__main__":
    unittest.main()
