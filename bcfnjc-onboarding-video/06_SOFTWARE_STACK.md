# BCFNJC Onboarding Video — Recommended Software Stack

---

## Recommended Full Stack (Tiered by Budget)

---

### TIER 1 — Professional (Best Quality, ~$150–200/mo)

| Role | Tool | Cost | Notes |
|---|---|---|---|
| AI Avatar | Synthesia | $89/mo Creator | Best enterprise option; 140+ avatars |
| AI Voice | ElevenLabs | $22/mo | Highest-quality neural TTS; 29 voices |
| Screen Animation | Camtasia | $33/mo or $330/yr | Purpose-built for this use case |
| Video Editing | Adobe Premiere Pro | $55/mo (CC) | Professional-grade editing |
| Captions | Descript | $24/mo | Auto-captions + transcript editing |
| SharePoint Hosting | Microsoft Stream | Included in M365 | Native integration |
| Privacy Masking | Adobe Photoshop | Included in CC | Blur/redact screenshots |

---

### TIER 2 — Mid-Range (~$50–80/mo)

| Role | Tool | Cost | Notes |
|---|---|---|---|
| AI Avatar | HeyGen | $29/mo | Excellent lip sync, custom avatar option |
| AI Voice | Azure Neural TTS | ~$5/mo | Microsoft ecosystem; good quality |
| Screen Animation | Canva Pro | $20/mo | Simpler but capable; good for this project |
| Video Editing | Clipchamp | Free (M365) | Built into Windows 11 + M365 |
| Captions | Clipchamp auto-captions | Free | Basic but functional |
| SharePoint Hosting | Microsoft Stream | Included in M365 | |
| Privacy Masking | Canva / Snagit | ~$15/mo | Blur and annotate screenshots |

---

### TIER 3 — Budget / Free Tools (~$0–30/mo)

| Role | Tool | Cost | Notes |
|---|---|---|---|
| AI Avatar | D-ID | $6/mo lite | Animates still photos; basic but effective |
| AI Voice | Microsoft Edge Read Aloud / Azure | Free tier | Lower quality but zero cost |
| Screen Animation | PowerPoint | Included in M365 | Surprisingly capable with Morph transitions |
| Video Editing | Clipchamp | Free | M365 included |
| Captions | Microsoft Stream auto-captions | Free | Post-upload captioning |
| SharePoint Hosting | Microsoft Stream | Included | |
| Privacy Masking | Paint 3D / Snipping Tool | Free | Basic redaction |

---

## Tool-by-Tool Deep Dive

---

### Synthesia
- **What it does:** Converts script to video with a realistic AI presenter
- **Best feature:** 140+ diverse AI avatars; 29 languages; no green screen needed
- **BCFNJC use:** Produce avatar segments (intro + outro), export as MP4, composite into main video
- **Workflow:** Write script → select avatar → generate → download MP4 → import to editor
- **Limitation:** Cannot directly edit generated video — regenerate for changes

### HeyGen
- **What it does:** AI avatar video generator with the best lip-sync on the market
- **Best feature:** Create a custom avatar from 2 minutes of real video footage
- **BCFNJC use:** If an IT staff member wants to appear as the host, 2 min video → custom avatar
- **Workflow:** Record or generate → download → composite in editor

### ElevenLabs
- **What it does:** Neural text-to-speech with natural voice quality
- **Best feature:** Voice cloning (can clone a real person's voice with permission)
- **BCFNJC use:** Generate narration audio for all 12 scenes
- **Export:** MP3 or WAV at 44.1 kHz
- **Recommended voices:** "Rachel" (calm, professional) or "Daniel" (warm, measured)

### Camtasia (TechSmith)
- **What it does:** Screen recording + video editing purpose-built for tutorial/training videos
- **Best features:** Zoom-n-Pan, cursor effects, callout animations, SmartFocus
- **BCFNJC use:** Import screenshots as images → animate with pan/zoom/callouts → assemble scenes → export
- **Why it beats Premiere for this:** Cursor simulation, annotation tools, learning curve is lower
- **Export preset:** MP4, H.264, 1920×1080, 30fps

### Adobe Premiere Pro
- **What it does:** Professional video editing suite
- **Best features:** Lumetri color grading, Morphcut, multi-track timeline
- **BCFNJC use:** Final assembly if editor has Premiere skills; color grading; avatar compositing
- **When to use instead of Camtasia:** When the team has Premiere expertise and needs precision control

### Descript
- **What it does:** Transcript-based video + podcast editor; auto-captions
- **Best features:** Edit video by editing text transcript; Overdub AI voice; auto-captions export
- **BCFNJC use:** Generate WebVTT caption files from narration; edit audio by editing text
- **Bonus:** Can remove filler words ("um", "uh") automatically

### Clipchamp (Microsoft)
- **What it does:** Browser-based and Windows video editor, included in M365
- **Best features:** Free with Microsoft 365; direct SharePoint/OneDrive integration; auto-captions
- **BCFNJC use:** Budget/quick option; good for assembling pre-animated slides from PowerPoint
- **Limitation:** Less control over fine animation timing vs Camtasia

### Microsoft PowerPoint (with Morph)
- **What it does:** Presentation software with animation/video export
- **Best features:** Morph transition creates smooth animated transitions between slides; Designer for layout
- **BCFNJC use:** Build each scene as a PowerPoint slide → use Morph for pan/zoom → export as MP4
- **Export:** File > Export > Create a Video → 1080p → MP4
- **Best for:** Teams without video editing experience; quick turnaround

### Microsoft Stream
- **What it does:** Microsoft's video streaming platform, integrated with SharePoint and Teams
- **Best features:** Auto-captions, SharePoint embed, M365 permissions, Teams tab
- **BCFNJC use:** Host the final video; embed on SharePoint onboarding page
- **Limitation:** Not a production tool — hosting only

---

## Recommended Workflow Combinations

### Option A — PowerPoint + Camtasia + Synthesia (Balanced)
```
Screenshots → PowerPoint (scene building) → Camtasia (animation + assembly)
+ Synthesia (avatar segments) → ElevenLabs (narration) → Descript (captions)
→ Premiere or Camtasia (final export) → Stream (hosting)
```

### Option B — All-Microsoft Stack (Budget-friendly, familiar)
```
Screenshots → PowerPoint (build + export scenes as MP4)
+ Clipchamp (assemble + narration) → D-ID (avatar) → Azure TTS (voice)
→ Stream (hosting + auto-captions)
```

### Option C — Premium Production
```
Screenshots → Photoshop (masking) → After Effects (animation)
+ Synthesia (avatar) → ElevenLabs (narration) → Premiere Pro (assembly + grade)
→ Descript (captions) → Stream (hosting)
```
