import numpy as np
import pytest

from apexformz_perception.lifting import H36M_17, create_lifter
from apexformz_perception.lifting.motionbert_lifter import coco2h36m
from apexformz_perception.lifting.videopose3d_lifter import VideoPose3DLifter, build_temporal_model
from apexformz_perception.pose import ModelUnavailable

torch = pytest.importorskip("torch")


def test_temporal_model_receptive_field_and_shape():
    m = build_temporal_model(causal=False)
    assert m.receptive_field() == 243
    x = torch.zeros(1, 243 + 10, 17, 2)
    with torch.no_grad():
        y = m.eval()(x)
    assert y.shape == (1, 11, 17, 3)
    c = build_temporal_model(causal=True)
    assert c.receptive_field() == 243


def test_coco2h36m_synthesizes_pelvis_and_thorax():
    x = np.random.default_rng(0).random((5, 17, 3))
    y = coco2h36m(x)
    assert np.allclose(y[:, 0], (x[:, 11] + x[:, 12]) / 2)
    assert np.allclose(y[:, 8], (x[:, 5] + x[:, 6]) / 2)


def test_videopose3d_random_init_shape_and_license_flag():
    lifter = VideoPose3DLifter(random_init=True, device="cpu")
    assert lifter.commercial_ok is False and "NC" in lifter.license
    T = 50
    xy = np.random.default_rng(1).random((T, 17, 2)) * 0.5 + 0.25
    sc = np.ones((T, 17))
    out = lifter.lift(xy, sc, (1280, 720))
    assert out.joints_xyz.shape == (T, 17, 3) and out.joint_names == H36M_17
    assert out.retrospective is True and out.coordinate_system == "estimated_world"
    assert out.valid.all()


def test_videopose3d_pretrained_download_if_possible():
    try:
        lifter = VideoPose3DLifter(device="cpu")
    except ModelUnavailable as e:
        pytest.skip(f"weights not downloadable here: {e}")
    xy = np.tile(np.linspace(0.3, 0.7, 17)[:, None], (1, 2))[None].repeat(30, axis=0)
    out = lifter.lift(xy, np.ones((30, 17)), (1280, 720))
    assert out.joints_xyz.shape == (30, 17, 3)
    assert np.isfinite(out.joints_xyz).all()
    assert "pretrained_h36m_detectron_coco" in lifter.weights_path


def test_motionbert_fails_closed_without_weights(monkeypatch):
    monkeypatch.delenv("APEXFORMZ_MOTIONBERT_CKPT", raising=False)
    with pytest.raises(ModelUnavailable):
        create_lifter("motionbert")
