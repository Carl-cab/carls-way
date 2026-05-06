# BCFNJC Onboarding Video — SharePoint Deployment Plan

---

## Export Settings

### Video File
| Setting | Value |
|---|---|
| Format | MP4 |
| Codec | H.264 (AVC) |
| Resolution | 1920 × 1080 (1080p) |
| Frame Rate | 30fps |
| Bitrate | 8–12 Mbps (high quality) |
| Audio Codec | AAC |
| Audio Sample Rate | 44.1 kHz |
| Audio Bitrate | 192 kbps stereo |
| Color Space | Rec. 709 |

### Caption File
| Setting | Value |
|---|---|
| Format | WebVTT (.vtt) |
| Encoding | UTF-8 |
| Language Code | en-CA |
| Max line length | 42 characters |
| Max 2 lines per cue | Yes |

### File Naming
```
BCFNJC_IT_Onboarding_v1.0_1080p.mp4
BCFNJC_IT_Onboarding_v1.0_Captions_EN.vtt
```

---

## Upload Process

### Step 1 — Upload to Microsoft Stream

1. Go to `stream.microsoft.com` (or via Microsoft 365 app launcher)
2. Click **+ New** → **Upload video**
3. Select `BCFNJC_IT_Onboarding_v1.0_1080p.mp4`
4. While uploading, fill in metadata:
   - **Title:** BCFNJC IT Onboarding — Microsoft 365 Overview
   - **Description:** New employee IT onboarding video covering hardware setup, Microsoft 365 tools, and IT support resources.
   - **Language:** English
5. After upload, go to **Video settings** → **Captions** → Upload `.vtt` file
6. Set thumbnail (use a clean frame from Scene 01 — title card)
7. Save

### Step 2 — Set Permissions in Stream

| Permission | Setting |
|---|---|
| Viewer access | All BCFNJC staff (via Microsoft 365 group or domain) |
| Download allowed | No (view-only) |
| Embed allowed | Yes |
| Share externally | No |

---

## SharePoint Embedding

### Option A — Stream Web Part (Recommended)

1. Navigate to your SharePoint onboarding page in edit mode
2. Click **+** to add a web part → search **Stream**
3. Paste the Stream video URL
4. Configure:
   - Show title: Yes
   - Show caption: Yes (enable by default)
   - Autoplay: No
   - Show controls: Yes
5. Publish page

### Option B — Embed Code (Manual)

1. In Stream, click **Share** → **Embed**
2. Copy the `<iframe>` embed code
3. In SharePoint, add an **Embed** web part
4. Paste the iframe code
5. Adjust height: `height="540"` for 16:9 at standard width

### Recommended Page Layout

```
[ BCFNJC Logo / Page Header ]

H2: IT Onboarding Video
Subtitle: Watch this video before your first day.

[ Stream Video Web Part — Full Width ]

H3: Key Contacts
- IT Support: support@sfy.ca | 1-877-378-6730
- Records: records@bcfnjc.com

H3: Quick Links
- [Intranet Home]
- [Acceptable Use Policy]
- [IT Request Form]
```

---

## Permissions Strategy

| Audience | Access Level | Method |
|---|---|---|
| New employees (pre-onboarding) | View only | Share via direct link in onboarding email |
| All staff | View only | SharePoint page permissions |
| IT team | Edit/admin | SharePoint site owner role |
| External (contractors, guests) | No access by default | Require explicit IT approval |

### Pre-Day-One Access
Consider creating a guest-accessible version of the onboarding page (or just the video link) that new employees can view before their first day using a personal email — check with IT on guest access policy.

---

## Mobile Compatibility

- Microsoft Stream is fully mobile-responsive on iOS and Android
- SharePoint modern pages are mobile-optimized
- Test on:
  - iPhone (Safari + Edge)
  - Android (Chrome)
  - iPad (landscape and portrait)
- Video should auto-scale to screen width
- Captions must be available on mobile

---

## Accessibility Requirements

### WCAG 2.1 AA Compliance

| Requirement | How to Meet |
|---|---|
| Closed captions | Upload WebVTT file to Stream; captions ON by default |
| Audio description | Narration describes all visual actions (storyboard designed for this) |
| Color contrast | All text overlays: minimum 4.5:1 contrast ratio |
| No autoplay | Video must not autoplay with audio |
| Keyboard navigable | Stream player is keyboard accessible |
| Caption language | Mark as en-CA |

### Caption Quality Standards
- Captions must be reviewed by a human — do not rely 100% on auto-generated captions
- Max 2 lines per cue
- Max 42 characters per line
- Correct all proper nouns: "BCFNJC", "OneDrive", "SharePoint", "Montserrat", "SFY"
- Caption timing: synchronized within 0.5s of audio

---

## Version Control

### File Versioning Convention
```
BCFNJC_IT_Onboarding_v1.0_1080p.mp4   ← initial release
BCFNJC_IT_Onboarding_v1.1_1080p.mp4   ← minor content update
BCFNJC_IT_Onboarding_v2.0_1080p.mp4   ← major revision (new tool, rebrand, etc.)
```

### SharePoint Version Management
1. Keep all versions in a dedicated document library: `IT Resources > Onboarding Videos > Archive`
2. Only the current version is embedded on the onboarding page
3. Tag each version with date in description: "Published: 2024-09-01"
4. Notify HR when a new version is published so they update onboarding communications

### Annual Review
- Schedule a review every 12 months (or when Microsoft 365 UI changes significantly)
- IT rep re-captures screenshots of changed interfaces
- Narration re-recorded only for changed sections
- Full re-render not always required — scene-level updates possible in Camtasia/Premiere

---

## Microsoft Teams Integration (Optional)

- Pin the Stream video URL as a tab in the **IT Support** Teams channel
- Or post the video link in the **All Staff** channel welcome message
- Teams video tab: Apps → Stream → paste URL → add as tab
