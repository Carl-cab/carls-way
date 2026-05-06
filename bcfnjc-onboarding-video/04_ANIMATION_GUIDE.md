# BCFNJC Onboarding Video — Animation Guide

---

## Core Principles

- Every animation serves the narration — never animate for decoration
- Keep motion subtle: 0.3–0.5s transitions, ease-in-out curves
- Guide the viewer's eye with a single focal point per moment
- Simulated interactions must feel natural, not robotic

---

## 1. Screenshot Entry Animations

### Slide In
- Direction: from right or bottom (never top — feels aggressive)
- Duration: 0.4s, ease-out
- Use for: new section screenshots replacing previous

### Fade In
- Duration: 0.5s
- Use for: overlays, callouts, info cards

### Scale Up (Ken Burns)
- Start: 100%, End: 105–108% over 4–6 seconds
- Use for: title cards, static photos where no cursor movement needed
- Never exceed 110% (looks cheap)

---

## 2. Cursor Movement Simulation

**Tool:** Camtasia Cursor Smoothing, or AfterEffects with Motion Blur

### Guidelines
- Cursor starts at a neutral position (bottom-left of screenshot)
- Moves in smooth arcs, not straight lines
- Speed: 200–400px/sec (human-like, not instant)
- Add a subtle drop shadow to the cursor for visibility against light backgrounds

### Click Simulation
- On click: cursor shrinks slightly (95%), then returns (100%) over 0.15s
- Add a soft circular ripple effect at click point (radius 20px, opacity 60%→0 over 0.3s)
- Optional: subtle click sound effect (UI click SFX, -18dBFS)

### Implementation (Camtasia)
1. Import screenshot as image
2. Use Annotations > Spotlight to add click indicator
3. Use cursor animation presets for smooth paths

---

## 3. Zoom Effects

### Pan & Zoom (Ken Burns Style)
- **Purpose:** Draw attention to a specific area of a screenshot
- **Setup:** Set keyframe at full-view position, then keyframe at 150–200% zoom centered on target area
- **Duration:** 0.8–1.2s for the zoom transition, then hold for 2–4s
- **Return:** Ease back to full view over 0.6s

### Quick Punch Zoom
- **Purpose:** Momentary emphasis on a single UI element
- **Scale:** 100% → 130% → 100% over 0.5s total
- **Use sparingly** — maximum once per scene

### Camtasia Zoom & Pan
- Use the Zoom-n-Pan track
- Lock to keyframes aligned with narration timestamps

---

## 4. Highlight Boxes & Callouts

### Highlight Box
- Shape: rounded rectangle, 4px corner radius
- Color: BCFNJC brand color or amber (#F5A623) for general callouts
- Border: 3px solid, no fill (transparent interior so content remains visible)
- Animation: draw on (stroke animation) over 0.4s
- Hold: 2–4s while narration covers that point
- Exit: fade out 0.3s

### Callout Label
- Background: semi-transparent dark (#1A1A1A at 85% opacity)
- Text: white, Montserrat Medium, 16pt
- Arrow: points from label to target element
- Animation: slide in from nearest edge, 0.3s
- Use for: labeling UI elements the narrator mentions by name

### Spotlight Dimming
- Dims everything except the highlighted area
- Implementation: dark overlay (black, 50% opacity) with a "hole" cut out over the target
- Use for: when the whole screenshot is visible but you want one area to stand out clearly

---

## 5. Sensitive Information Masking

### Priority Areas to Mask in Every Screenshot

| Location | What to Mask |
|---|---|
| Top-right of browser | Microsoft account name/avatar |
| Outlook inbox | All sender names, subjects, preview text |
| Outlook calendar | All event titles, attendee names |
| Teams channels | Channel names (if private/sensitive), all message content |
| File Explorer | Personal folder/file names |
| OneDrive | File names if they contain project names or client info |
| SharePoint | Document names if confidential |
| Any URL bar | Full URL if it contains org-specific paths or session tokens |

### Masking Techniques

**Gaussian Blur (preferred)**
- Apply a 20–30px Gaussian blur over the sensitive region
- Use a feathered mask to blend edges naturally
- Tools: Photoshop, Canva (blur effect), Camtasia (blur annotation)

**Solid Color Redaction**
- Use a solid rectangle in background color (white or grey) to cover text
- Match the surrounding background exactly
- Add subtle noise/texture if needed to avoid obvious box artifacts

**Replacement Text**
- Replace real names with generic placeholders: "[Employee Name]", "[Your File]", "[Meeting Title]"
- Use same font, size, and color as original for realism
- Tools: Photoshop text overlay, Canva

---

## 6. Motion Blur Transitions

### Slide Wipe (Section Transitions)
- Direction: left-to-right (reading direction)
- Duration: 0.4s, ease-in-out
- Use between major sections

### Cross-Dissolve
- Duration: 0.5s
- Use between screenshots within the same section

### Morph / Content-Aware Transition
- Use when two screenshots share layout (e.g., same app, different tab)
- Camtasia: SmartFocus transition
- Adobe Premiere: Morphcut (for avatar segments)

---

## 7. Dynamic Callouts — Best Practices

### When to Use
- When narrator says "click on..." → show cursor click + callout label
- When narrator says "you'll see..." → spotlight that element
- When narrator says "make sure..." → highlight box with amber border

### Callout Timing Rule
- Callout appears 0.5s BEFORE narrator mentions the item (anticipatory guide)
- Callout exits 1.0s AFTER narrator finishes mentioning it

### Layering Order (bottom to top)
1. Screenshot (base)
2. Dimming overlay (if used)
3. Highlight box / spotlight
4. Cursor
5. Callout label / annotation text
6. Section title lower-third

---

## 8. Section Title Cards

### Lower-Third Style
- Background: BCFNJC brand color bar, full width, 80px height
- Position: bottom 10% of frame
- Text: Section name, Montserrat Bold, 28pt, white
- Animation: slide up from bottom, 0.3s ease-out
- Hold: 3 seconds, then fade out

### Full-Frame Section Title (between major sections)
- Background: brand color gradient
- Large section number: 72pt, light opacity
- Section name: 36pt, Montserrat Bold, white
- Duration: 2.5 seconds
- Transition in/out: cross-dissolve 0.4s

---

## Software-Specific Notes

### Camtasia
- Use "Annotations" panel for callouts, highlights, spotlights
- Use "Transitions" panel for wipes and dissolves
- Use "Zoom-n-Pan" track for all zoom effects
- Export: MP4, H.264, 1920×1080, 30fps, High quality preset

### Adobe After Effects / Premiere Pro
- Use null objects to control cursor path via expressions
- Motion blur: enable per-layer, set shutter angle 180°
- Color grade: Lumetri, warm slightly (+5 temperature) for welcoming feel

### Canva (for simpler builds)
- Use "Presentation" format, then export as MP4
- Animate elements via "Animate" panel: Rise, Fade, Pan
- Blur tool available for sensitive data masking
- Export: MP4, 1080p
