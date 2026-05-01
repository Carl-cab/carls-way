"""Build v2 of the TOD reel: silent visuals + single-voice TTS narration."""
from gtts import gTTS
from pathlib import Path
import subprocess

ROOT = Path("/home/user/carls-way")
CLIPS = ROOT / "assets/clips"
OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)

NARRATION = (
    "Every day, drivers get stranded. Dead battery, flat tire, no fuel. "
    "With TOD, help is just one tap away. "
    "A nearby tech sees your request and rolls out in minutes. "
    "Be the help. Earn while doing it. "
    "Join TOD today and download the app at todtechondemand.com."
)

vo_mp3 = OUT / "narration.mp3"
print("[1/5] Generating narration with gTTS (en-US)...")
tts = gTTS(text=NARRATION, lang="en", tld="us", slow=False)
tts.save(str(vo_mp3))
print(f"      wrote {vo_mp3}")

silent_reel = OUT / "tod-reel-silent.mp4"
concat_list = OUT / "concat.txt"
concat_list.write_text("\n".join(f"file '{(CLIPS / f'clip{i}.mp4').as_posix()}'" for i in range(1, 6)) + "\n")

print("[2/5] Concatenating clips losslessly and dropping audio...")
subprocess.run([
    "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
    "-an", "-c:v", "copy", str(silent_reel),
], check=True, capture_output=True)
print(f"      wrote {silent_reel}")

print("[3/5] Probing durations...")
def dur(p):
    out = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(p),
    ], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())

vid_d = dur(silent_reel)
aud_d = dur(vo_mp3)
print(f"      video={vid_d:.2f}s  audio={aud_d:.2f}s")

print("[4/5] Building final mux: narration centered, padded with silence to match video...")
# Strategy: shift narration ~0.6s in, leave breathing room at the end on the logo bumper.
lead_in = 0.6
tail_pad_min = 0.3
final = OUT / "tod-reel-v2.mp4"

afilter = (
    f"adelay={int(lead_in*1000)}|{int(lead_in*1000)},"
    f"apad=whole_dur={vid_d:.3f},"
    f"atrim=duration={vid_d:.3f},"
    f"loudnorm=I=-16:TP=-1.5:LRA=11"
)

cmd = [
    "ffmpeg", "-y",
    "-i", str(silent_reel),
    "-i", str(vo_mp3),
    "-filter_complex", f"[1:a]{afilter}[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    str(final),
]
subprocess.run(cmd, check=True, capture_output=True)
print(f"      wrote {final}")

print("[5/5] Verifying output...")
out = subprocess.run([
    "ffprobe", "-v", "error", "-show_entries",
    "format=duration:stream=codec_type,codec_name,sample_rate,width,height",
    "-of", "default=noprint_wrappers=1", str(final),
], capture_output=True, text=True, check=True)
print(out.stdout)
