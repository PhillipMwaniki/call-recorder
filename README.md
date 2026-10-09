# Call Recorder

A Cinnamon panel applet that records both sides of a call with one click: your
microphone plus everything your computer plays (which is how you hear the other
people). It works with any call app (browser, Zoom, Teams, WhatsApp Desktop,
and so on) and with earbuds, headphones or laptop speakers.

## Features

- **One click:** left-click the panel icon to start, click again to stop.
  While recording, the icon turns into a red dot with an elapsed-time counter.
- **Follows your devices:** if earbuds connect or disconnect, Bluetooth
  switches between music and headset mode, or you change the default mic or
  output, recording carries on in the same file using the new device. Brief
  gaps are filled with silence so both sides stay in sync.
- **Opus or MP3:** Opus (`.ogg`, about 30 MB per hour) is the default; MP3
  (`.mp3`, 96 kbps, about 45 MB per hour) plays on practically any device.
- **Right-click menu:** play the last recording, open the recordings folder,
  or configure the applet.

Recordings are saved as `Call YYYY-MM-DD HH-MM-SS.ogg` (or `.mp3`) in
`~/Recordings/Calls` by default.

## Prerequisites

| Prerequisite | Why it's needed | How to check |
| --- | --- | --- |
| Cinnamon 6.x desktop | Runs the panel applet | `cinnamon --version` |
| PipeWire audio system | Captures the mic and the audio you hear | `pactl info \| grep "Server Name"` should mention PipeWire |
| Python 3 with GObject bindings | Runs the recorder | `python3 -c "import gi"` prints nothing |
| GStreamer + PipeWire plugin | Audio capture, mixing, Opus encoding | `gst-inspect-1.0 pipewiresrc` and `gst-inspect-1.0 opusenc` show details |
| GStreamer "good" plugins | MP3 encoding | `gst-inspect-1.0 lamemp3enc` shows details |
| `pactl` | Detects default-device changes | `pactl --version` |

Linux Mint 22 (Cinnamon) has all of these installed out of the box. On other
Debian- or Ubuntu-based systems with Cinnamon and PipeWire, install anything
missing with:

```sh
sudo apt update
sudo apt install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good pulseaudio-utils
```

Running it again when everything is present is harmless; `apt` just reports
that the packages are already installed.

To check everything at once, paste this into a terminal. It prints `all good`,
or names what's missing and which package provides it:

```sh
ok=1
python3 -c "import gi; gi.require_version('Gst', '1.0')" 2>/dev/null \
  || { echo "missing: python3-gi / gir1.2-gstreamer-1.0"; ok=0; }
command -v pactl >/dev/null || { echo "missing: pulseaudio-utils (pactl)"; ok=0; }
for e in pipewiresrc:gstreamer1.0-pipewire audiomixer:gstreamer1.0-plugins-base \
         opusenc:gstreamer1.0-plugins-base oggmux:gstreamer1.0-plugins-base \
         lamemp3enc:gstreamer1.0-plugins-good xingmux:gstreamer1.0-plugins-good; do
  gst-inspect-1.0 "${e%%:*}" >/dev/null 2>&1 || { echo "missing: ${e#*:} (${e%%:*})"; ok=0; }
done
[ "$ok" = 1 ] && echo "all good"
```

If your system still uses PulseAudio instead of PipeWire (`pactl info` shows
`Server Name: pulseaudio`), the recorder won't work. PipeWire has been the
default since Linux Mint 22 and Ubuntu 22.10.

## Installation

Link (or copy) the applet folder into Cinnamon's applet directory:

```sh
ln -s "$PWD/call-recorder@PhillipMwaniki" ~/.local/share/cinnamon/applets/
```

Then open **System Settings → Applets**, find **Call Recorder** and add it to
your panel.

## Settings

Right-click the icon and choose **Configure**:

| Setting | Default | Notes |
| --- | --- | --- |
| Save recordings in | `~/Recordings/Calls` | Created automatically if missing |
| Recording format | Opus (.ogg) | Or MP3 (.mp3) |
| Show elapsed time | On | Timer next to the icon while recording |

## How it works

- `applet.js` is the panel applet. It starts `recorder.py` when you start a
  recording and sends it `SIGINT` when you stop, so the file is closed cleanly.
- `recorder.py` is a GStreamer pipeline:
  - two `pipewiresrc` streams, one capturing the default microphone and one
    capturing the monitor of the default output, are mixed with
    `audiomixer` into a mono track and encoded to Opus or MP3;
  - a silent live source keeps the timeline continuous;
  - when a capture device disappears, or `pactl subscribe` reports a change of
    default device, only the affected stream is rebuilt, so the recording keeps
    going.

The recorder can also be used on its own:

```sh
python3 call-recorder@PhillipMwaniki/recorder.py ~/call.mp3   # Ctrl+C to stop
```

## Limitations

- **All system sound is recorded,** not only the call. Notification sounds or
  music playing at the same time will be in the file.
- **On speakers,** your microphone also picks up the other side, so their voice
  can sound slightly doubled. Earbuds or headphones give the cleanest result.
- **Bluetooth earbuds in music (A2DP) mode have no microphone.** Call apps
  normally switch them to headset mode when a call starts, and the recorder
  follows; otherwise your voice is recorded from the built-in microphone.
- **Audio sent to a non-default output device** isn't captured.

## Consent

Laws on recording calls differ between countries, and some require everyone on
the call to agree. Tell the other people when you are recording.
