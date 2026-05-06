# BCFNJC Onboarding Video — Templates & Conventions

---

## 1. Screenshot Naming Convention

### Format
```
[SCENE##]_[SECTION-SLUG]_[CONTENT-DESC]_[STATUS].ext
```

### Status Codes
| Code | Meaning |
|---|---|
| RAW | Unmasked, not approved for production |
| MASKED | Sensitive data obscured, pending review |
| APPROVED | Privacy-reviewed, cleared for production |

### Examples
```
SC06_EDGE-INTRANET_bookmarks-bar_APPROVED.png
SC07_ONEDRIVE_file-explorer-sidebar_APPROVED.png
SC08_OUTLOOK_inbox-view_MASKED.png
SC08_OUTLOOK_calendar-month-view_RAW.png
SC09_TEAMS_notification-settings_APPROVED.png
SC10_WORD_file-new-templates_APPROVED.png
```

### Rules
- Use lowercase with hyphens for slugs (no spaces, no underscores in slug portion)
- Scene number always 2 digits: SC01, SC02...SC12
- Never share RAW files outside of the restricted production folder
- Once a file is APPROVED, do not modify it — create a new version if changes needed

---

## 2. Folder Structure

```
BCFNJC-Onboarding-Video/
│
├── 00_Project-Docs/
│   ├── BCFNJC_IT_Onboarding_Script_v1.0.docx
│   ├── Storyboard_v1.0.pdf
│   ├── Narration_Script_v1.0.docx
│   └── Approval_Log.xlsx
│
├── 01_Screenshots/
│   ├── RAW/                  ← Unmasked originals (restricted access)
│   │   ├── SC06_EDGE-INTRANET_bookmarks-bar_RAW.png
│   │   └── ...
│   ├── MASKED/               ← Pending privacy review
│   │   └── ...
│   └── APPROVED/             ← Cleared for production
│       ├── SC01_WELCOME_logo-title-card_APPROVED.png
│       └── ...
│
├── 02_Audio/
│   ├── Narration/
│   │   ├── SC01_Welcome_Narration_v1.wav
│   │   ├── SC02_Hardware_Narration_v1.wav
│   │   └── ...
│   ├── Music/
│   │   └── Background_Ambient_Royalty-Free.mp3
│   └── SFX/
│       └── UI_Click_Subtle.wav
│
├── 03_Avatars/
│   ├── SC01_Welcome_Avatar_v1.mp4
│   ├── SC12_Closing_Avatar_v1.mp4
│   └── Avatar_Exports/
│
├── 04_Graphics/
│   ├── BCFNJC_Logo_Transparent.png
│   ├── Section_Title_Card_Template.pptx
│   ├── Lower_Third_Template.pptx
│   ├── IT_Contact_Card_Final.png
│   └── Color_Palette.pdf
│
├── 05_Project-Files/
│   ├── BCFNJC_Onboarding_v1.0.tscproj    ← Camtasia project
│   └── BCFNJC_Onboarding_v1.0.prproj     ← Premiere project (if used)
│
├── 06_Exports/
│   ├── Rough-Cuts/
│   │   ├── BCFNJC_IT_Onboarding_RoughCut1.mp4
│   │   └── BCFNJC_IT_Onboarding_RoughCut2.mp4
│   ├── Final/
│   │   ├── BCFNJC_IT_Onboarding_v1.0_1080p.mp4
│   │   └── BCFNJC_IT_Onboarding_v1.0_Captions_EN.vtt
│   └── Archive/
│
└── 07_Review-Feedback/
    ├── RoughCut1_Feedback_ITRep.docx
    └── FinalCut_Approval_Signed.pdf
```

---

## 3. Production Checklist

### Pre-Production
- [ ] Kickoff meeting held; stakeholders aligned
- [ ] Script reviewed and approved by IT rep
- [ ] All screenshots identified per storyboard
- [ ] Screenshots captured and placed in `/01_Screenshots/RAW/`
- [ ] Privacy review completed; all approved files in `/01_Screenshots/APPROVED/`
- [ ] Narration recorded/generated; files in `/02_Audio/Narration/`
- [ ] Avatar segments rendered; files in `/03_Avatars/`
- [ ] Graphics and logo assets ready in `/04_Graphics/`
- [ ] Background music licensed and placed in `/02_Audio/Music/`

### Production
- [ ] Project file created in Camtasia / Premiere
- [ ] All approved screenshots imported
- [ ] All narration audio synced to timeline
- [ ] Avatar segments composited
- [ ] Animations applied per Animation Guide
- [ ] Transitions applied per storyboard
- [ ] Lower-thirds and section titles added
- [ ] On-screen text added per storyboard
- [ ] Background music mixed (narration at -14 LUFS, music at -28 LUFS)
- [ ] Color grade / LUT applied

### Post-Production
- [ ] Rough cut exported and distributed for review
- [ ] IT rep feedback collected and applied
- [ ] Privacy QA pass (full video review with IT rep)
- [ ] Caption file generated and reviewed
- [ ] Accessibility review completed
- [ ] Final cut approved by manager (signature in `/07_Review-Feedback/`)
- [ ] Final MP4 exported at spec
- [ ] Final VTT caption file exported

---

## 4. Video QA Checklist

### Visual Quality
- [ ] No blurry or pixelated screenshots
- [ ] No visible compression artifacts in transitions
- [ ] All text is sharp and readable at 1080p
- [ ] No clipping at edges (safe area margins respected)
- [ ] Color is consistent throughout (no random exposure/color shifts)
- [ ] BCFNJC logo appears correctly in all graphics

### Audio Quality
- [ ] Narration is clear and audible throughout
- [ ] No background noise, clicks, or pops in audio
- [ ] Audio levels consistent across all scenes (no loud/quiet jumps)
- [ ] Background music does not overpower narration
- [ ] Narration and visuals are in sync

### Content Accuracy
- [ ] All tool names spelled correctly (OneDrive, SharePoint, etc.)
- [ ] All contact details accurate (email, phone)
- [ ] No outdated UI shown (screenshots match current software versions)
- [ ] No incorrect instructions in narration or on-screen text

### Privacy & Security
- [ ] Full privacy checklist completed (see Section 08)
- [ ] No sensitive data in any frame
- [ ] No personal information visible

### Captions
- [ ] Captions present for entire video
- [ ] Captions are accurate (manually reviewed)
- [ ] Proper nouns spelled correctly
- [ ] Timing is synchronized
- [ ] Max 2 lines per cue, max 42 chars per line

---

## 5. Voiceover Checklist

- [ ] All 12 scenes have narration audio files
- [ ] Audio files match scene order in folder naming
- [ ] All narration matches approved script (no ad-libs or deviations)
- [ ] No mispronounced words (BCFNJC, Montserrat, SharePoint, etc.)
- [ ] No audible breath sounds, lip smacks, or room noise
- [ ] Normalized to -14 LUFS
- [ ] Exported as WAV, 44.1 kHz, stereo
- [ ] Backup copy stored in `/02_Audio/Narration/`

---

## 6. Final Approval Checklist

This checklist must be completed and signed before the video is published.

| Item | Reviewer | Approved | Date |
|---|---|---|---|
| Technical accuracy of all content | IT Representative | | |
| Privacy and data security review | IT Representative | | |
| Narration script accuracy | IT Representative | | |
| Organizational branding | Project Lead | | |
| Caption accuracy | Accessibility Lead | | |
| WCAG 2.1 AA compliance | Accessibility Lead | | |
| Overall video quality | Producer | | |
| **Final publish approval** | **Manager** | | |

**Published to SharePoint:** _____________  
**Stream URL:** _________________________  
**SharePoint Page URL:** _________________  
**Published by:** _______________________  
**Version:** ____________________________
