# BCFNJC Onboarding Video — Security & Compliance Checklist

---

## Privacy Review Process

Every screenshot must pass this checklist before entering production.

**Reviewer:** IT Representative (BCFNJC)  
**Second review:** Producer or Project Lead  
**When:** Before any screenshot is handed to the video editor  

---

## Screenshot Privacy Checklist

For every screenshot, confirm:

### Browser / Microsoft Edge
- [ ] No personal Microsoft account name visible (top-right avatar)
- [ ] No saved password prompts visible
- [ ] No autofill suggestions showing real names or addresses
- [ ] URL bar does not expose session tokens, internal paths, or confidential domains
- [ ] No browser history visible in address bar dropdown
- [ ] No personal bookmarks visible (mask or remove non-essential bookmarks)

### Microsoft Outlook
- [ ] All sender names in inbox → MASKED or replaced with "[Sender Name]"
- [ ] All email subjects → MASKED or replaced with "[Email Subject]"
- [ ] All email preview text → MASKED
- [ ] All email addresses → MASKED
- [ ] No confidential email content visible at any point
- [ ] Calendar: all event titles → MASKED or replaced with "[Meeting]"
- [ ] Calendar: all attendee names → MASKED
- [ ] Calendar: no personal or sensitive appointments visible
- [ ] Address book: no real contact details visible (show interface chrome only)

### Microsoft Teams
- [ ] All private channel names → MASKED (general channels like "All Staff" OK if real)
- [ ] All message content → MASKED (no chat messages visible)
- [ ] All user display names in chat → MASKED
- [ ] No profile photos showing recognizable people
- [ ] No private DM conversations visible
- [ ] No file names in Teams channels that reveal project or client names

### OneDrive / File Explorer
- [ ] Personal folder name (C:\Users\[Name]) → MASKED
- [ ] No client or project file names visible
- [ ] No document titles containing confidential information
- [ ] No recently opened file list visible with sensitive file names
- [ ] No shared drive paths revealing organizational structure if sensitive

### SharePoint
- [ ] No confidential document names in shared library
- [ ] No contributor names on documents (unless publicly available roles)
- [ ] No internal project or client folder names visible
- [ ] No private SharePoint sites visible in navigation

### Microsoft Word
- [ ] No real document content visible (use blank/generic template views)
- [ ] No author name in document properties
- [ ] No track changes comments from real employees
- [ ] No recent documents list showing sensitive file names

### Adobe Acrobat Pro
- [ ] PDF shown is generic/sample only — no real organizational document
- [ ] No visible client names, case numbers, or legal content
- [ ] No signature fields pre-populated with real names

### General / All Screenshots
- [ ] No passwords visible (in any application, any field)
- [ ] No login credentials partially visible
- [ ] No employee ID numbers
- [ ] No financial data or budget figures
- [ ] No HR or performance-related content
- [ ] No personal health information
- [ ] No client case details or legal correspondence
- [ ] No internal IP addresses or system hostnames
- [ ] No IT infrastructure details (server names, admin consoles)
- [ ] No license keys or activation codes
- [ ] Computer clock/date is acceptable (no need to mask)
- [ ] Battery and Wi-Fi status indicators are acceptable

---

## Masking Methods Reference

| Sensitive Item | Preferred Masking Method |
|---|---|
| Names in email/calendar | Gaussian blur (20px) or replacement text |
| Email subjects | Gaussian blur or solid color bar |
| File names | Replacement text (same font/color as original) |
| Passwords / credentials | Solid black bar |
| Account name (top-right) | Solid color patch matching background |
| Full URL paths | Crop or blur the URL bar |
| Chat messages | Gaussian blur across message area |

---

## Video QA — Privacy Pass (Final Cut)

Before export, the editor and IT rep must watch the full video together and confirm:

- [ ] No frame in any scene shows unmasked sensitive information
- [ ] All blur/redaction overlays are correctly positioned and not drifting (if animated)
- [ ] No screen capture accidentally included in transition frames
- [ ] No reflections in laptop/monitor photos showing sensitive content
- [ ] All lower-thirds and on-screen text use placeholder or approved content only

---

## Data Handling During Production

- All raw screenshots must be stored in a password-protected shared folder (OneDrive or SharePoint)
- Access limited to: IT rep, producer, video editor
- Raw (unmasked) screenshots must NOT be shared externally
- After production completes, raw screenshots can be archived or deleted per BCFNJC records policy
- Final video and caption file are the only assets shared publicly (via SharePoint/Stream)

---

## Compliance Notes

| Area | Standard | Status |
|---|---|---|
| Privacy | BC PIPA / FOIPPA | Ensured by screenshot masking workflow |
| Accessibility | WCAG 2.1 AA | Captions + narration design |
| Data residency | Microsoft Canada data region | Ensured by Stream/SharePoint (M365 tenant) |
| Retention | Per BCFNJC records policy | Annual video review + version archiving |
