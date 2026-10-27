# Dynamic Motion Analysis Guide (Taekwondo)

This document outlines the methodology for upgrading Taekwondo from static pose evaluation to full dynamic movement analysis, including data requirements and implementation steps.

## How It Works (No New Model Training Required)

We **do not** need to train a new AI model from scratch. 

Our AI service uses an advanced `DynamicAnalyzer` (`apps/ai-service/app/services/dynamic/`). Instead of looking at single static frames, the dynamic engine evaluates movements across time using three key pillars:
1. **Phase Detection:** Breaks a movement down into distinct phases (e.g., Chamber, Extension, Re-chamber) based on "triggers" like angular velocity or specific joint angles.
2. **Kinetic Chain Validation:** Tracks how power is generated (e.g., checking if the hip rotation correctly precedes the knee extension during a roundhouse kick).
3. **Fluidity Tracking:** Measures the "jerk" (rate of change of acceleration) to score how smooth the movement is.

To add Taekwondo kicks, we just need to create **biomechanical blueprints** for these kicks in our `reference_movements.json` database.

---

## What We Need (The Data Requirements)

**We need VIDEOS, not static images.** 

Because dynamic analysis measures velocity, fluidity, and timing, static images are unusable. Specifically, we need:
1. **Number of Videos:** 2 to 3 videos per specific movement (e.g., 3 videos of a Roundhouse Kick). This helps ensure consistency.
2. **Length of Videos:** Very short! Just **3 to 5 seconds** per video. Each video should capture exactly ONE clean repetition (from the starting stance, through the kick, and back to the starting stance).
3. **High-Frame-Rate (Optional but ideal):** 60fps is ideal.
4. **Clear Angles:** Side-profile views are usually best for capturing the full extension and mechanics of a kick.
5. **List of Priority Movements:** Decide which 2-3 specific kicks or forms to implement first.

---

## The Execution Plan

Once expert videos are provided, follow these steps to integrate them:

### Step 1: Data Extraction & Analysis
Instead of manually guessing the perfect angles, run the expert videos through the extraction script:
```bash
python apps/ai-service/scripts/video_extractor.py path/to/video.mp4 path/to/output_telemetry.json
```
This outputs a frame-by-frame telemetry log of the expert's exact joint angles, angular velocities, and kinetic chain timing.

### Step 2: Blueprint Creation
Use the extracted telemetry to define the new dynamic blueprints in `apps/ai-service/app/data/reference_movements.json` under the `taekwondo` key. 
For example, a Roundhouse Kick is defined by its phases:
1. **Pivot & Chamber:** Triggered by the hips rotating and the knee bending.
2. **Extension:** Triggered by rapid positive angular velocity of the knee joint.
3. **Re-chamber & Return:** Triggered by negative angular velocity.

Also define the `kinetic_chain_order` (e.g., `["hips", "shoulders", "legs"]`) and phase-specific correction cues.

### Step 3: API & Frontend Hookup
Update the training UI (`apps/frontend/src/app/train/[sport]/page.tsx`) so that when a user selects a dynamic movement (like "Roundhouse Kick"), the frontend sends a WebSocket message requesting `dynamic: true` and the specific `movementId`. This tells the backend to route the incoming camera frames to the `DynamicAnalyzer`.
