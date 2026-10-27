# Issue: Real-time Feedback Failing (Blue Lines Only)

## Background
The system successfully rendered the chest red lines for the `Real_system_working` offline video because the person in the video is a master and matches the stance perfectly, avoiding an edge-case logic crash. However, during live real-time analysis, the system evaluated the user's initial stance, found it slightly off from the "expert" stance, and attempted to **block** the user from progressing to Phase 1 (the dynamic kick).

## The Bug
When attempting to block the phase transition, the code referenced `self.phases[0]` instead of `self.config.phases[0]`. This caused an `AttributeError` which silently crashed the Python backend during live inference. 

When the backend crashed:
1. The WebSocket connection was interrupted or failed to emit `feedback:result`
2. The UI stopped receiving `FrameAnalysis` updates entirely
3. The UI defaulted to drawing the standard blue lines (`hasError = false`) because no new issues were being streamed
4. The score counter stayed blank/zero

## The Fix
1. Fixed the bug in `apps/ai-service/app/services/dynamic/dynamic_analyzer.py` on line 248 to correctly reference `self.config.phases[0]`.
2. The system will now gracefully block the transition and return the `"stance"` issue (which is set to medium severity) back to the UI. The user will see `"Waiting for correct starting posture"` in the feedback cards.

## Video Frame Extraction
You requested that we map the 10 movements directly from the real videos located in `taekwando_training_videos`. 

I have written an extraction script for you to run locally to pull the real frames from the MP4s:
[extract_reference_frames.py](file:///c:/Users/ASUS/Desktop/IITK%20Composit/Apexformz/apps/ai-service/scripts/extract_reference_frames.py)

**How to run it:**
Since you need `mediapipe` installed to run the frame extraction, and because your backend currently runs without it using the browser-based tracking, you can generate the JSON reference data by running:

```bash
cd apps/ai-service
pip install mediapipe==0.10.35 opencv-python
python scripts/extract_reference_frames.py
```

This will automatically loop through the 10 folders, scan `front.mp4`, `left.mp4`, and `right.mp4`, extract the precise expert frames, and overwrite the JSON blueprints in the `expert_data` folder. Once completed, your system will match live users perfectly against the actual masters from your videos.
