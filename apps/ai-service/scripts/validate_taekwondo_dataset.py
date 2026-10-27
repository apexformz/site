"""Validate Taekwondo reference coverage without changing runtime data.

The live matcher can only be as good as its source data. This check makes the
expected 10 movements x 3 camera variants explicit and fails loudly when a
video or extracted reference variant is missing.
"""

import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
VIDEO_ROOT = os.path.join(ROOT, "taekwando_training_videos")
RAW_ROOT = os.path.join(os.path.dirname(__file__), "..", "app", "services", "dynamic", "expert_data", "taekwondo")
EXPECTED = {
    "ap_chagi_front_kick": "Ap_chagi_front_kick",
    "baka_chagi_side_slide_roundhouse": "baka_chagi_Side_slide_roundhouse_kick",
    "bandae_dollyo_chagi_reverse_roundhouse": "bandae_dollyo_chagi_reverse_roundhouse_kick",
    "dollyo_chagi_roundhouse_kick": "dolyo_chagi_roundhouse_kick",
    "dwi_chagi_back_kick": "dwi_chagi_Back_kick",
    "miro_chagi_push_kick": "miro_chagi_push_kick",
    "preamble_dollyo_chagi_front_leg_slide": "Preamble_dollyo_chagi_front_leg_slide_roundhouse_kick",
    "twio_ap_chagi_jumping_front_kick": "twio_ap_chagi_jumping_front_kick",
    "twio_dollyo_chagi_jumping_roundhouse": "twio_dollyo_chagi_Jumping_roundhouse_kick",
    "yeop_chagi_side_kick": "yeop_chagi_side_kick",
}
EXTRACTED_NAMES = {
    "baka_chagi_side_slide_roundhouse": "baka_chagi.json",
    "bandae_dollyo_chagi_reverse_roundhouse": "bandae_dollyo_chagi.json",
    "preamble_dollyo_chagi_front_leg_slide": "preamble_dollyo_chagi.json",
    "twio_dollyo_chagi_jumping_roundhouse": "twio_dollyo_chagi_jumping_roundhouse_kick.json",
}
VARIANTS = {"front", "left", "right"}


def main() -> int:
    failures = []
    print("Taekwondo dataset coverage")
    print("=" * 28)
    for movement, folder in EXPECTED.items():
        video_dir = os.path.join(VIDEO_ROOT, folder)
        videos = {os.path.splitext(name)[0].lower() for name in os.listdir(video_dir)} if os.path.isdir(video_dir) else set()
        video_variants = {variant for variant in VARIANTS if variant in videos}

        raw_path = os.path.join(RAW_ROOT, EXTRACTED_NAMES.get(movement, f"{movement}.json"))
        raw_variants = set()
        if os.path.exists(raw_path):
            with open(raw_path, "r", encoding="utf-8") as handle:
                for frame in json.load(handle):
                    source = str(frame.get("source", "")).lower()
                    raw_variants.update(variant for variant in VARIANTS if source.startswith(variant + "_"))

        missing_video = sorted(VARIANTS - video_variants)
        missing_raw = sorted(VARIANTS - raw_variants)
        status = "OK" if not missing_video and not missing_raw else "INCOMPLETE"
        print(f"{status:10} {movement:48} videos={sorted(video_variants)} extracted={sorted(raw_variants)}")
        if missing_video:
            failures.append(f"{movement}: missing videos {missing_video}")
        if missing_raw:
            failures.append(f"{movement}: missing extracted variants {missing_raw}")

    if failures:
        print("\nProblems:")
        print("\n".join(f"- {failure}" for failure in failures))
        return 1
    print("\nAll 10 movements have front, left, and right source/extracted coverage.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
