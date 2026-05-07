# BCFNJC Onboarding Video — Camtasia Build Guide
**For: Video Editor**  
**Tool: Camtasia 2023 / 2024**

---

## Project Setup

### New Project Settings
1. Open Camtasia → New Project
2. **Canvas size:** 1920 × 1080
3. **Frame rate:** 30fps
4. **Project name:** `BCFNJC_IT_Onboarding_v1.0`
5. Save project file to: `05_Project-Files/BCFNJC_IT_Onboarding_v1.0.tscproj`

### Media Bin — Import All Assets First
Before building any scenes, import everything:
- All approved screenshots from `01_Screenshots/APPROVED/`
- All narration WAV files from `02_Audio/Narration/`
- All avatar MP4 segments from `03_Avatars/`
- Background music from `02_Audio/Music/`
- Logo PNG from `04_Graphics/`

Organize the Media Bin into folders matching the project folder structure.

---

## Timeline Track Layout

Use this consistent track stack for every scene:

```
Track 6 (top):   On-screen text / callout labels
Track 5:         Highlight boxes / spotlight annotations
Track 4:         Cursor animations
Track 3:         Avatar PiP (picture-in-picture)
Track 2:         Screenshot / image content
Track 1:         Background / title card / color fill
──────────────────────────────────────────────────────
Track A1:        Narration audio
Track A2:        Background music
Track A3:        SFX (click sounds, etc.)
```

Keep this layer order consistent throughout the entire project — it makes editing and troubleshooting much easier.

---

## Scene-by-Scene Build Instructions

---

### SCENE 01 — Title Card & Welcome (~40s)

**Tracks used:** 1 (background), 3 (avatar), 5 (text)

1. **Background:** Add a solid color clip (BCFNJC primary color) to Track 1, 40 seconds long
2. **Logo:** Import BCFNJC logo PNG → Place on Track 2, centered top area, scale to ~300px wide
   - Add **Fade In** behavior: duration 0.5s
   - Add **Scale** behavior: 100%→105% over 5s (Ken Burns)
3. **Title text:** Use a Text annotation on Track 5
   - "BC First Nations Justice Council" — Montserrat ExtraBold, 48pt, white
   - "Microsoft 365 IT Onboarding" — Montserrat Bold, 32pt, white
   - Add **Fly In from Bottom** behavior, stagger start times by 0.3s between lines
4. **Avatar:** Place avatar MP4 (SC01_Welcome_Avatar) on Track 3
   - Scale to fill ~60% of canvas width, center position
   - Add **Fade In** behavior: starts at 5s into scene, 0.5s fade
5. **Narration:** Place SC01 narration WAV on Track A1
6. **Transition out:** Add **Fade to Black** transition at end of clip (0.5s)

---

### SCENE 02 — Hardware Overview (~90s)

**Tracks used:** 1 (bg), 2 (screenshot), 3 (avatar PiP), 4 (cursor), 5 (highlight), 6 (text)

1. **Background:** Light grey `#E8E8E8` solid clip, full scene duration
2. **Section title card** (first 3s):
   - Full-width colored bar on Track 1: BCFNJC primary color
   - Text on Track 6: "Hardware Overview" — Montserrat Bold, 36pt, white
   - Behavior: **Fly In from Bottom** (0.3s), hold 2.5s, **Fade Out** (0.3s)
3. **Laptop screenshot:** Place laptop photo on Track 2
   - Position: left 60% of canvas
   - Behavior: **Slide In from Left** (0.4s, ease-out)
   - Add **Zoom-n-Pan** keyframes:
     - 0s → 8s: Full view
     - 8s → 10s: Zoom to privacy shutter area (150% scale, repositioned)
     - 10s → 12s: Hold on shutter
     - 12s → 13s: Zoom back out to full view
4. **Bullet points:** Three text annotations on Track 6, staggered:
   - Privacy Shutter text: appears at narration cue (~15s)
   - Ethernet/Power text: appears at narration cue (~35s)
   - Reboot text: appears at narration cue (~55s)
   - Each: **Fade In** 0.3s; add checkmark icon image before each line
5. **Highlight box:** On Track 5, draw a rounded rectangle around the shutter area
   - Appears at 8s (when zoomed), fades out at 13s
   - Color: Amber `#F5A623`, 3px stroke, no fill
6. **Avatar PiP:** Place avatar on Track 3
   - Position: lower-right, 320×320px, rounded mask
   - Appears from scene start with 0.3s fade in
7. **Narration + music:** Place on A1/A2
8. **Transition out:** **Slide Wipe Left** (0.4s)

---

### SCENE 03 — Care & Security (~75s)

1. **Background:** Same light grey
2. **Section title card:** same format as Scene 02
3. **Shield icon:** SVG/PNG on Track 2, center-top area
   - Animation: scale from 0%→100% over 0.5s (pop in)
4. **Five bullet points:** Text annotations on Track 6, each staggered by ~8–10s
   - Each fades in on narration cue, holds, does not exit until scene ends
5. **Emphasis pulse:** On "Protecting client data" bullet — add a color animation
   - Text color: white → amber → white over 0.5s, triggered at that narration moment
6. **Avatar PiP:** Lower-right, consistent position
7. **Transition out:** **Cross Dissolve** (0.5s)

---

### SCENE 04 — IT Support (~50s)

1. **Avatar:** 40% width, left side of canvas (side-by-side mode)
   - Scale avatar clip to fill left 40%
2. **Contact card graphic:** Place the pre-designed IT contact card PNG on Track 2
   - Position: right 55% of canvas
   - Behavior: **Slide In from Right** (0.4s)
3. **Row highlights:** Three separate highlight box annotations on Track 5
   - Intranet row highlight: appears at narration cue, amber border
   - Email row highlight: appears at email mention
   - Phone row highlight: appears at phone mention
   - Each holds for 3s then fades
4. **Transition out:** **Slide Wipe Right** (0.4s)

---

### SCENE 05 — Hardware & Printers (~60s)

1. **Two sub-sections:** Split scene at ~30s mark
2. **First half (hardware requests):**
   - Manager icon → arrow → laptop icon animation
   - Use three separate PNG icons, animate path with **Move** behaviors
3. **Second half (printers):**
   - Printer icon + Wi-Fi animation
   - Timer graphic "10–15 min" with clock icon
4. **Transition mid-scene:** Brief cross-dissolve between sub-sections
5. **Transition out:** **Cross Dissolve** (0.5s)

---

### SCENES 06–11 — Screenshot Scenes (General Pattern)

For all screenshot-based scenes, follow this build pattern:

#### Step 1 — Scene Title (first 2.5s)
- Full-width section title card, same format as Scene 02

#### Step 2 — Screenshot Entry
- Screenshot on Track 2, **Slide In from Right** (0.4s)
- Scale to fill canvas (or left 65% if avatar in PiP mode)

#### Step 3 — Cursor Animation (if showing navigation)
- Use Camtasia's built-in cursor annotations or a cursor PNG on Track 4
- Set position keyframes to simulate cursor movement path
- Add click ripple annotation at click points

#### Step 4 — Zoom-n-Pan Keyframes
- Set up per the storyboard zoom instructions for that scene
- Use Camtasia's Zoom-n-Pan track for smooth interpolation

#### Step 5 — Callout Annotations
- Add callout labels on Track 6 at narration-synced timecodes
- Callouts: dark background (#1A1A1A, 85% opacity), white Montserrat text, arrow pointing to UI element

#### Step 6 — Highlight Boxes
- Add on Track 5 for each UI element mentioned
- Draw-on animation (use Camtasia's Sketch Motion annotation for this)

#### Step 7 — Screenshot Transitions Between Sub-Scenes
- Cross-dissolve 0.5s between different screenshots in same section

#### Step 8 — Section Transition Out
- Alternate between Slide Wipe and Cross Dissolve to maintain rhythm
- Slides for major section changes, dissolves for minor ones

---

## Audio Mixing in Camtasia

### Narration (Track A1)
- Import each scene's narration WAV
- Place on A1, aligned to scene start
- Target level: **-14 LUFS** (use Audio → Gain to adjust if needed)
- Fade in 0.2s at start, fade out 0.3s at end of each clip

### Background Music (Track A2)
- Import ambient music MP3
- Stretch across entire timeline (or use multiple overlapping clips)
- Target level: **-28 LUFS** (well under narration)
- Fade in over first 3s; fade out over last 5s
- Duck (lower) music by additional 3dB during narration-heavy moments if needed

### SFX — Click Sounds (Track A3)
- Place `UI_Click_Subtle.wav` at each cursor click animation point
- Volume: -18 dBFS (subtle, not prominent)

---

## Camtasia Export Settings

### Final Export
1. **Share → Local File**
2. **Format:** MP4 up to 1080p
3. **Frame rate:** 30fps
4. **Quality:** High (slider at ~85%)
5. **Include captions:** Yes (if you've added captions in Camtasia)
6. **Output file:** `BCFNJC_IT_Onboarding_v1.0_1080p.mp4`

### Rough Cut Export (for review)
- Same settings but quality at 70% (smaller file for faster review sharing)
- Name: `BCFNJC_IT_Onboarding_RoughCut1.mp4`

---

## Caption Workflow in Camtasia

### Option A — Import from Descript/External VTT
1. Generate captions in Descript by uploading the narration audio
2. Review and correct all text
3. Export as SRT or VTT
4. In Camtasia: **Tools → Captions → Import Captions**
5. Select your SRT/VTT file
6. Captions will auto-align to the timeline

### Option B — Auto-Generate in Camtasia
1. With narration audio on timeline: **Tools → Captions → Speech to Captions**
2. Select your narration track
3. Review EVERY line — auto-generated captions always need correction
4. Pay special attention to: BCFNJC, OneDrive, SharePoint, Montserrat, SFY

### Caption Style Settings (Camtasia)
- Font: Segoe UI or Arial (Montserrat may not be available in caption tool)
- Size: 18pt
- Background: semi-transparent black
- Position: lower-center, above the lower-third bar

---

## Quality Check Before Export

Run through this in Camtasia Preview (full-screen):

- [ ] All scene transitions are smooth (no jump cuts or flashes)
- [ ] Zoom-n-Pan moves feel natural (not jerky)
- [ ] All callout labels appear and disappear at correct narration moments
- [ ] Audio levels are balanced (narration clearly audible over music)
- [ ] No tracks overlapping in unexpected ways
- [ ] Logo visible and correctly positioned on all designed cards
- [ ] Avatar PiP does not cover key UI elements in any screenshot scene
- [ ] Captions are visible and readable at bottom of frame
- [ ] Scene 01 starts cleanly (no black flash before title card)
- [ ] Scene 12 fades to clean black at end
