"""
Comprehensive audit test suite for OneEuro + DTW + MMPose integration.
Tests edge cases, empty inputs, reset behavior, and cross-module compatibility.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

passed = 0
failed = 0

def test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {name}")
        passed += 1
    except Exception as e:
        print(f"  FAIL  {name}: {e}")
        failed += 1

# ==================== 1. SIGNAL FILTER TESTS ====================
print("\n=== ONE EURO FILTER ===")

def test_smoother_basic():
    from app.services.dynamic.signal_filter import KeypointSmoother
    s = KeypointSmoother(fps_estimate=15.0)
    kps = [{"name": "left_knee", "x": 0.5, "y": 0.5, "score": 0.9}]
    result = s.smooth(kps)
    assert len(result) == 1
    assert "x" in result[0] and "y" in result[0]
    assert result[0]["name"] == "left_knee"
test("Basic smoothing", test_smoother_basic)

def test_smoother_empty():
    from app.services.dynamic.signal_filter import KeypointSmoother
    s = KeypointSmoother()
    result = s.smooth([])
    assert result == []
test("Empty keypoints", test_smoother_empty)

def test_smoother_low_confidence():
    from app.services.dynamic.signal_filter import KeypointSmoother
    s = KeypointSmoother()
    kps = [{"name": "left_knee", "x": 0.5, "y": 0.5, "score": 0.1}]
    result = s.smooth(kps)
    assert result[0]["x"] == 0.5  # Should NOT be smoothed
    assert result[0]["y"] == 0.5
test("Low confidence bypass", test_smoother_low_confidence)

def test_smoother_jitter_reduction():
    from app.services.dynamic.signal_filter import KeypointSmoother
    s = KeypointSmoother(fps_estimate=30.0)
    # Simulate jittery input: value oscillating around 0.5
    vals = [0.50, 0.52, 0.48, 0.53, 0.47, 0.51, 0.49, 0.52, 0.48, 0.50]
    outputs = []
    for v in vals:
        kps = [{"name": "test", "x": v, "y": 0.5, "score": 0.95}]
        result = s.smooth(kps)
        outputs.append(result[0]["x"])
    # The variance of smoothed output should be less than input
    import statistics
    input_var = statistics.variance(vals)
    output_var = statistics.variance(outputs)
    assert output_var < input_var, f"Smoothing failed: {output_var} >= {input_var}"
test("Jitter actually reduced", test_smoother_jitter_reduction)

def test_smoother_reset():
    from app.services.dynamic.signal_filter import KeypointSmoother
    s = KeypointSmoother()
    kps = [{"name": "a", "x": 0.5, "y": 0.5, "score": 0.9}]
    s.smooth(kps)
    s.smooth(kps)
    s.reset()
    assert s._frame_count == 0
    assert len(s._filters) == 0
test("Reset clears state", test_smoother_reset)

def test_smoother_many_frames():
    from app.services.dynamic.signal_filter import KeypointSmoother
    s = KeypointSmoother()
    kps = [{"name": f"j{i}", "x": 0.5, "y": 0.5, "score": 0.9} for i in range(12)]
    for _ in range(1000):
        result = s.smooth(kps)
    assert len(result) == 12
test("1000 frames no crash", test_smoother_many_frames)

# ==================== 2. TRAJECTORY SCORER TESTS ====================
print("\n=== DTW TRAJECTORY SCORER ===")

def test_dtw_import():
    from app.services.dynamic.trajectory_scorer import DTW_AVAILABLE
    assert DTW_AVAILABLE == True, "dtaidistance not installed"
test("dtaidistance installed", test_dtw_import)

def test_scorer_no_reference():
    from app.services.dynamic.trajectory_scorer import TrajectoryScorer
    s = TrajectoryScorer(reference_trajectory=None)
    assert s.available == False
    s.record_frame({"left_knee": 170})
    result = s.score_rep()
    assert result is None
test("No reference = graceful None", test_scorer_no_reference)

def test_scorer_empty_reference():
    from app.services.dynamic.trajectory_scorer import TrajectoryScorer
    s = TrajectoryScorer(reference_trajectory=[])
    assert s.available == False
test("Empty reference = unavailable", test_scorer_empty_reference)

def test_scorer_short_reference():
    from app.services.dynamic.trajectory_scorer import TrajectoryScorer
    s = TrajectoryScorer(reference_trajectory=[{"left_knee": 170}])
    assert s.available == False
test("Too-short reference = unavailable", test_scorer_short_reference)

def test_scorer_perfect_match():
    from app.services.dynamic.trajectory_scorer import TrajectoryScorer
    ref = [{"left_knee": 170, "right_knee": 170} for _ in range(20)]
    s = TrajectoryScorer(reference_trajectory=ref)
    assert s.available == True
    for frame in ref:
        s.record_frame(frame)
    score = s.score_rep()
    assert score is not None
    assert score == 100.0, f"Perfect match should be 100, got {score}"
test("Perfect match = 100", test_scorer_perfect_match)

def test_scorer_reset():
    from app.services.dynamic.trajectory_scorer import TrajectoryScorer
    ref = [{"left_knee": 170} for _ in range(5)]
    s = TrajectoryScorer(reference_trajectory=ref)
    s.record_frame({"left_knee": 170})
    s.reset()
    assert len(s._current_rep) == 0
    assert s._last_score is None
test("Reset clears state", test_scorer_reset)

def test_scorer_invisible_joints():
    from app.services.dynamic.trajectory_scorer import TrajectoryScorer
    ref = [{"left_knee": 170} for _ in range(10)]
    s = TrajectoryScorer(reference_trajectory=ref)
    for _ in range(10):
        s.record_frame({"left_knee": -1})  # All invisible
    score = s.score_rep()
    assert score is None  # Can't compare invisible joints
test("Invisible joints = None", test_scorer_invisible_joints)

# ==================== 3. MMPOSE ESTIMATOR TESTS ====================
print("\n=== MMPOSE ESTIMATOR ===")

def test_mmpose_graceful():
    from app.services.mmpose_estimator import MMPoseEstimator
    m = MMPoseEstimator()
    assert m.available == False  # Not installed
    status = m.get_status()
    assert status["mmpose_installed"] == False
    assert "import_error" in status
test("MMPose graceful when not installed", test_mmpose_graceful)

def test_mmpose_extract_empty():
    from app.services.mmpose_estimator import MMPoseEstimator
    m = MMPoseEstimator()
    result = m.extract_keypoints_from_frame(None)
    assert result == []
test("Extract from None = empty", test_mmpose_extract_empty)

def test_mmpose_coco_mapping():
    from app.services.mmpose_estimator import COCO_TO_APEXFORMZ
    expected_names = {"left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
                      "left_wrist", "right_wrist", "left_hip", "right_hip",
                      "left_knee", "right_knee", "left_ankle", "right_ankle"}
    assert set(COCO_TO_APEXFORMZ.values()) == expected_names
test("COCO keypoint mapping complete", test_mmpose_coco_mapping)

# ==================== 4. VIDEO ANALYZER TESTS ====================
print("\n=== VIDEO ANALYZER ===")

def test_video_analyzer_missing_file():
    from app.services.video_analyzer import analyze_video
    result = analyze_video("/nonexistent/video.mp4", "taekwondo", "ap_chagi")
    assert "error" in result
    assert "not found" in result["error"].lower() or "not installed" in result["error"].lower()
test("Missing video file = error", test_video_analyzer_missing_file)

def test_video_analyzer_bad_sport():
    from app.services.video_analyzer import analyze_video
    result = analyze_video("/nonexistent.mp4", "badminton_nonexistent", "smash")
    assert "error" in result
test("Bad sport config = error", test_video_analyzer_bad_sport)

# ==================== 5. DYNAMIC ANALYZER INTEGRATION TESTS ====================
print("\n=== DYNAMIC ANALYZER INTEGRATION ===")

def test_analyzer_with_all_modules():
    from app.services.dynamic.movement_registry import DYNAMIC_LOOKUP
    from app.services.dynamic.dynamic_analyzer import DynamicAnalyzer
    config = list(DYNAMIC_LOOKUP.get("taekwondo", {}).values())[0]
    analyzer = DynamicAnalyzer(config, fps_estimate=15.0)
    
    kps = [
        {"name": "left_shoulder", "x": 0.4, "y": 0.3, "score": 0.9},
        {"name": "left_elbow", "x": 0.35, "y": 0.45, "score": 0.9},
        {"name": "left_wrist", "x": 0.3, "y": 0.6, "score": 0.9},
        {"name": "right_shoulder", "x": 0.6, "y": 0.3, "score": 0.9},
        {"name": "right_elbow", "x": 0.65, "y": 0.45, "score": 0.9},
        {"name": "right_wrist", "x": 0.7, "y": 0.6, "score": 0.9},
        {"name": "left_hip", "x": 0.45, "y": 0.6, "score": 0.9},
        {"name": "right_hip", "x": 0.55, "y": 0.6, "score": 0.9},
        {"name": "left_knee", "x": 0.42, "y": 0.75, "score": 0.9},
        {"name": "right_knee", "x": 0.58, "y": 0.75, "score": 0.9},
        {"name": "left_ankle", "x": 0.4, "y": 0.9, "score": 0.9},
        {"name": "right_ankle", "x": 0.6, "y": 0.9, "score": 0.9},
    ]
    
    for _ in range(10):
        result = analyzer.analyze_frame(kps)
    
    # Verify all expected fields
    required_fields = [
        "score", "joint_angles", "issues", "overall_severity", "pose_name",
        "dynamic", "current_phase", "phase_index", "phase_changed",
        "phase_scores", "rep_count", "fluidity_score", "kinetic_chain",
        "total_phases", "is_cyclical", "trajectory_similarity"
    ]
    for field in required_fields:
        assert field in result, f"Missing field: {field}"
    
    assert isinstance(result["score"], float)
    assert result["dynamic"] == True
test("All response fields present", test_analyzer_with_all_modules)

def test_analyzer_empty_keypoints():
    from app.services.dynamic.movement_registry import DYNAMIC_LOOKUP
    from app.services.dynamic.dynamic_analyzer import DynamicAnalyzer
    config = list(DYNAMIC_LOOKUP.get("taekwondo", {}).values())[0]
    analyzer = DynamicAnalyzer(config)
    result = analyzer.analyze_frame([])  # Empty keypoints
    assert "score" in result
test("Empty keypoints no crash", test_analyzer_empty_keypoints)

def test_analyzer_partial_keypoints():
    from app.services.dynamic.movement_registry import DYNAMIC_LOOKUP
    from app.services.dynamic.dynamic_analyzer import DynamicAnalyzer
    config = list(DYNAMIC_LOOKUP.get("taekwondo", {}).values())[0]
    analyzer = DynamicAnalyzer(config)
    kps = [{"name": "left_knee", "x": 0.5, "y": 0.7, "score": 0.9}]
    result = analyzer.analyze_frame(kps)
    assert "score" in result
test("Partial keypoints no crash", test_analyzer_partial_keypoints)

def test_analyzer_reset_full():
    from app.services.dynamic.movement_registry import DYNAMIC_LOOKUP
    from app.services.dynamic.dynamic_analyzer import DynamicAnalyzer
    config = list(DYNAMIC_LOOKUP.get("taekwondo", {}).values())[0]
    analyzer = DynamicAnalyzer(config)
    kps = [{"name": "left_knee", "x": 0.5, "y": 0.7, "score": 0.9}]
    analyzer.analyze_frame(kps)
    analyzer.reset()
    assert len(analyzer.phase_scores) == 0
    assert len(analyzer.score_history) == 0
    assert analyzer._prev_rep_count == 0
    assert analyzer.smoother._frame_count == 0
    assert len(analyzer.trajectory_scorer._current_rep) == 0
test("Full reset clears everything", test_analyzer_reset_full)

def test_analyzer_high_volume():
    from app.services.dynamic.movement_registry import DYNAMIC_LOOKUP
    from app.services.dynamic.dynamic_analyzer import DynamicAnalyzer
    config = list(DYNAMIC_LOOKUP.get("taekwondo", {}).values())[0]
    analyzer = DynamicAnalyzer(config, fps_estimate=30.0)
    kps = [
        {"name": n, "x": 0.5, "y": 0.5, "score": 0.9}
        for n in ["left_shoulder", "left_elbow", "left_wrist",
                   "right_shoulder", "right_elbow", "right_wrist",
                   "left_hip", "right_hip", "left_knee", "right_knee",
                   "left_ankle", "right_ankle"]
    ]
    for _ in range(500):
        result = analyzer.analyze_frame(kps)
    assert result["score"] >= 0
test("500 frames no crash", test_analyzer_high_volume)

# ==================== 6. ROUTES TEST ====================
print("\n=== API ROUTES ===")

def test_all_routes_loaded():
    from app.routes.analysis import router
    paths = [r.path for r in router.routes]
    expected = ["/analyze", "/poses/{sport}", "/analyze/batch",
                "/analyze/dynamic", "/movements/{sport}",
                "/analyze/dynamic/cleanup", "/analyze/video", "/mmpose/status"]
    for ep in expected:
        assert ep in paths, f"Missing endpoint: {ep}"
test("All 8 endpoints registered", test_all_routes_loaded)

# ==================== 7. CROSS-MODULE COMPATIBILITY ====================
print("\n=== CROSS-MODULE COMPATIBILITY ===")

def test_movement_registry_unchanged():
    from app.services.dynamic.movement_registry import (
        is_dynamic, get_dynamic_movements, analyze_dynamic_frame, cleanup_session
    )
    assert is_dynamic("taekwondo") == True
    assert len(get_dynamic_movements("taekwondo")) > 0
    cleanup_session("test_audit")  # Should not crash
test("Movement registry still works", test_movement_registry_unchanged)

def test_static_analyzer_unchanged():
    from app.services.pose_analyzer import analyze_pose
    kps = [
        {"name": "left_shoulder", "x": 0.4, "y": 0.3, "score": 0.9},
        {"name": "left_elbow", "x": 0.35, "y": 0.45, "score": 0.9},
        {"name": "left_wrist", "x": 0.3, "y": 0.6, "score": 0.9},
        {"name": "right_shoulder", "x": 0.6, "y": 0.3, "score": 0.9},
        {"name": "right_elbow", "x": 0.65, "y": 0.45, "score": 0.9},
        {"name": "right_wrist", "x": 0.7, "y": 0.6, "score": 0.9},
        {"name": "left_hip", "x": 0.45, "y": 0.6, "score": 0.9},
        {"name": "right_hip", "x": 0.55, "y": 0.6, "score": 0.9},
        {"name": "left_knee", "x": 0.42, "y": 0.75, "score": 0.9},
        {"name": "right_knee", "x": 0.58, "y": 0.75, "score": 0.9},
        {"name": "left_ankle", "x": 0.4, "y": 0.9, "score": 0.9},
        {"name": "right_ankle", "x": 0.6, "y": 0.9, "score": 0.9},
    ]
    result = analyze_pose("cricket", kps)
    assert "score" in result
    assert "issues" in result
test("Static pose analyzer unaffected", test_static_analyzer_unchanged)

# ==================== SUMMARY ====================
print(f"\n{'='*50}")
print(f"AUDIT COMPLETE: {passed} passed, {failed} failed")
print(f"{'='*50}")
if failed > 0:
    sys.exit(1)
