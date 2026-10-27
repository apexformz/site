import json
import os

filepath = r"c:\Users\ASUS\Desktop\IITK Composit\Apexformz\apps\ai-service\app\data\reference_movements.json"

with open(filepath, 'r') as f:
    data = json.load(f)

# Define the new rich Taekwondo blueprint
taekwondo_data = {
  "ap_chagi_front_kick": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160, "left_knee": 160, "right_hip": 170}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "weight_transfer", "angles": {"right_knee": 160, "left_knee": 150}, "duration_range_ms": [50, 300], "trigger": {"joint": "left_knee", "metric": "angle_below", "threshold": 155}, "weight": 0.1},
      {"name": "knee_chamber", "angles": {"right_knee": 60, "right_hip": 90}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "knee_extension", "angles": {"right_knee": 170, "right_hip": 90}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "impact", "angles": {"right_knee": 180, "right_hip": 90}, "duration_range_ms": [10, 100], "trigger": {"joint": "right_knee", "metric": "angle_above", "threshold": 170}, "weight": 0.1},
      {"name": "retraction", "angles": {"right_knee": 60, "right_hip": 90}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.1},
      {"name": "recovery", "angles": {"right_knee": 160, "left_knee": 160}, "duration_range_ms": [100, 500], "trigger": {"joint": "right_knee", "metric": "angle_above", "threshold": 150}, "weight": 0.1}
    ],
    "kinetic_chain_order": ["hips", "legs"],
    "cues": {
      "knee_chamber_right_knee_bent": "Knee rises toward target. Keep kicking knee aligned.",
      "knee_extension_right_knee_straight": "Extend knee toward target without swinging sideways.",
      "retraction_right_knee_bent": "Fast retraction after impact."
    }
  },
  "dollyo_chagi_roundhouse_kick": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "pivot_and_chamber", "angles": {"right_knee": 60, "left_hip": 160}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "hip_rotation", "angles": {"right_hip": 120}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_hip", "metric": "angular_velocity", "direction": "positive", "threshold": 2.0}, "weight": 0.2},
      {"name": "knee_extension", "angles": {"right_knee": 170}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "retraction_recovery", "angles": {"right_knee": 90}, "duration_range_ms": [100, 500], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.2}
    ],
    "kinetic_chain_order": ["hips", "shoulders", "legs"],
    "cues": {
      "pivot_and_chamber_right_knee_bent": "Supporting heel rotates. Knee chambers before extension.",
      "hip_rotation_right_hip_rotated": "Hip rotates toward target. Trunk remains controlled.",
      "knee_extension_right_knee_straight": "Leg follows a circular trajectory."
    }
  },
  "yeop_chagi_side_kick": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "tight_chamber", "angles": {"right_knee": 45, "right_hip": 60}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 70}, "weight": 0.3},
      {"name": "pivot_and_hip_rotation", "angles": {"right_hip": 90}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_hip", "metric": "angular_velocity", "direction": "positive", "threshold": 2.0}, "weight": 0.2},
      {"name": "horizontal_extension", "angles": {"right_knee": 170, "right_hip": 90}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "retraction", "angles": {"right_knee": 60}, "duration_range_ms": [100, 400], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.1}
    ],
    "kinetic_chain_order": ["hips", "legs"],
    "cues": {
      "tight_chamber_right_knee_bent": "Knee chambers tightly. Body becomes side-on.",
      "pivot_and_hip_rotation_right_hip_rotated": "Supporting foot pivots. Hip and heel move toward target.",
      "horizontal_extension_right_knee_straight": "Kicking leg extends along a relatively straight path."
    }
  },
  "dwi_chagi_back_kick": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "body_rotation", "angles": {"right_hip": 160}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_hip", "metric": "angular_velocity", "direction": "positive", "threshold": 1.5}, "weight": 0.2},
      {"name": "chamber", "angles": {"right_knee": 60}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "explosive_extension", "angles": {"right_knee": 170, "right_hip": 160}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 4.0}, "weight": 0.3},
      {"name": "retraction_recovery", "angles": {"right_knee": 90}, "duration_range_ms": [100, 500], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.2}
    ],
    "kinetic_chain_order": ["shoulders", "hips", "legs"],
    "cues": {
      "body_rotation_right_hip_rotated": "Head turns toward target. Supporting foot pivots.",
      "explosive_extension_right_knee_straight": "Heel travels directly toward target. Body remains balanced."
    }
  },
  "miro_chagi_push_kick": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "high_chamber", "angles": {"right_knee": 60, "right_hip": 70}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "push_extension", "angles": {"right_knee": 160, "right_hip": 120}, "duration_range_ms": [100, 400], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 2.0}, "weight": 0.4},
      {"name": "controlled_retraction", "angles": {"right_knee": 90}, "duration_range_ms": [100, 400], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -1.5}, "weight": 0.3}
    ],
    "kinetic_chain_order": ["hips", "legs"],
    "cues": {
      "high_chamber_right_knee_bent": "Knee rises before extension. Trunk remains controlled.",
      "push_extension_right_knee_straight": "Foot travels forward. Contact occurs with sole."
    }
  },
  "bandae_dollyo_chagi_reverse_roundhouse": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "body_rotation", "angles": {"right_hip": 160}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_hip", "metric": "angular_velocity", "direction": "positive", "threshold": 2.0}, "weight": 0.2},
      {"name": "chamber", "angles": {"right_knee": 90}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 110}, "weight": 0.2},
      {"name": "circular_extension", "angles": {"right_knee": 160}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "recovery", "angles": {"right_knee": 150}, "duration_range_ms": [100, 500], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.2}
    ],
    "kinetic_chain_order": ["shoulders", "hips", "legs"],
    "cues": {
      "body_rotation_right_hip_rotated": "Shoulder and pelvic rotation. Supporting-foot pivot.",
      "circular_extension_right_knee_straight": "Kicking-leg trajectory follows a reverse arc."
    }
  },
  "twio_ap_chagi_jumping_front_kick": {
    "type": "dynamic",
    "phases": [
      {"name": "countermovement", "angles": {"left_knee": 120, "right_knee": 120}, "duration_range_ms": [50, 300], "trigger": "initial", "weight": 0.1},
      {"name": "takeoff", "angles": {"left_knee": 170, "right_knee": 170}, "duration_range_ms": [50, 200], "trigger": {"joint": "left_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.2},
      {"name": "airborne_chamber", "angles": {"right_knee": 60, "right_hip": 90}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "midair_extension", "angles": {"right_knee": 170}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "landing", "angles": {"left_knee": 140, "right_knee": 140}, "duration_range_ms": [50, 400], "trigger": {"joint": "left_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.2}
    ],
    "kinetic_chain_order": ["legs", "hips"],
    "cues": {
      "countermovement_left_knee_bent": "Controlled crouch before takeoff. Both feet leave ground.",
      "airborne_chamber_right_knee_bent": "Knee chambers in flight.",
      "midair_extension_right_knee_straight": "Extension occurs before/around peak movement. Balanced landing."
    }
  },
  "twio_dollyo_chagi_jumping_roundhouse": {
    "type": "dynamic",
    "phases": [
      {"name": "countermovement", "angles": {"left_knee": 120, "right_knee": 120}, "duration_range_ms": [50, 300], "trigger": "initial", "weight": 0.1},
      {"name": "takeoff_rotation", "angles": {"left_knee": 170, "right_hip": 140}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_hip", "metric": "angular_velocity", "direction": "positive", "threshold": 2.0}, "weight": 0.2},
      {"name": "aerial_chamber", "angles": {"right_knee": 60}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "roundhouse_extension", "angles": {"right_knee": 170}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "landing", "angles": {"left_knee": 140}, "duration_range_ms": [50, 400], "trigger": {"joint": "left_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.2}
    ],
    "kinetic_chain_order": ["legs", "shoulders", "hips"],
    "cues": {
      "takeoff_rotation_right_hip_rotated": "Takeoff symmetry. Aerial body rotation.",
      "roundhouse_extension_right_knee_straight": "Hip rotation. Circular foot trajectory. Landing stability."
    }
  },
  "baka_chagi_side_slide_roundhouse": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "lateral_slide", "angles": {"left_knee": 140, "right_knee": 140}, "duration_range_ms": [100, 400], "trigger": {"joint": "left_knee", "metric": "angle_below", "threshold": 150}, "weight": 0.2},
      {"name": "weight_transfer_chamber", "angles": {"right_knee": 60}, "duration_range_ms": [50, 300], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "roundhouse_extension", "angles": {"right_knee": 170}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "recovery", "angles": {"right_knee": 150}, "duration_range_ms": [100, 500], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.2}
    ],
    "kinetic_chain_order": ["legs", "hips"],
    "cues": {
      "lateral_slide_left_knee_bent": "Lateral displacement. Center-of-mass control. Minimal unnecessary vertical movement.",
      "weight_transfer_chamber_right_knee_bent": "Correct chamber after slide. Supporting-foot pivot.",
      "roundhouse_extension_right_knee_straight": "Roundhouse trajectory."
    }
  },
  "preamble_dollyo_chagi_front_leg_slide": {
    "type": "dynamic",
    "phases": [
      {"name": "stance", "angles": {"right_knee": 160}, "duration_range_ms": [100, 1000], "trigger": "initial", "weight": 0.1},
      {"name": "front_leg_slide", "angles": {"left_knee": 140, "right_knee": 140}, "duration_range_ms": [100, 400], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 150}, "weight": 0.2},
      {"name": "front_leg_chamber", "angles": {"right_knee": 60}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angle_below", "threshold": 90}, "weight": 0.2},
      {"name": "roundhouse_extension", "angles": {"right_knee": 170}, "duration_range_ms": [50, 200], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "positive", "threshold": 3.0}, "weight": 0.3},
      {"name": "retraction_recovery", "angles": {"right_knee": 150}, "duration_range_ms": [100, 500], "trigger": {"joint": "right_knee", "metric": "angular_velocity", "direction": "negative", "threshold": -2.0}, "weight": 0.2}
    ],
    "kinetic_chain_order": ["legs", "hips"],
    "cues": {
      "front_leg_slide_right_knee_bent": "Front-leg slide distance. Center-of-mass displacement.",
      "front_leg_chamber_right_knee_bent": "Knee chamber height. Hip rotation. Supporting-foot pivot.",
      "roundhouse_extension_right_knee_straight": "Kick trajectory. Recovery stability."
    }
  }
}

data['taekwondo'] = taekwondo_data

with open(filepath, 'w') as f:
    json.dump(data, f, indent=2)

print("Updated reference_movements.json with rich Taekwondo blueprints!")
