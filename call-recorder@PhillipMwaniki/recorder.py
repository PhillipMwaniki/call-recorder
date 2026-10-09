#!/usr/bin/env python3
"""Record both sides of a call: your microphone plus everything your computer plays.

Usage: recorder.py <output.ogg|output.mp3>

The format follows the file extension: .ogg is Opus, .mp3 is MP3.

Both capture streams follow the *current* default devices. When the default
changes or a device disappears (earbuds connect or disconnect, Bluetooth
switches between music and headset mode) the affected stream is rebuilt against
the new default while the recording keeps running; the gap is filled with
silence so both sides stay in sync. Send SIGINT or SIGTERM to finish the file
cleanly.
"""
import signal
import subprocess
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gio, GLib, Gst  # noqa: E402

RATE_CAPS = "audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved"
RETRY_MS = 700

# Encoder chain per file extension; both are mono, tuned for clear speech
ENCODERS = {
    ".ogg": "opusenc bitrate=64000 ! oggmux",
    ".mp3": "lamemp3enc target=bitrate bitrate=96 cbr=true ! xingmux",
}

# "them" = monitor of the default output (what you hear), "me" = default input
SOURCES = {
    "them": 'props,node.name=callrec-them,node.description="Call recorder (output)",stream.capture.sink=true',
    "me": 'props,node.name=callrec-me,node.description="Call recorder (mic)"',
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def default_device(kind):
    cmd = "get-default-sink" if kind == "them" else "get-default-source"
    try:
        return subprocess.run(["pactl", cmd], capture_output=True, text=True,
                              timeout=3).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


class Recorder:
    def __init__(self, path):
        self.stopping = False
        self.branches = {}
        self.targets = {}
        self.pending = set()
        self.check_queued = False
        self.loop = GLib.MainLoop()
        ext = path[path.rfind("."):].lower()
        if ext not in ENCODERS:
            raise SystemExit(f"unsupported format {ext!r}; use .ogg or .mp3")
        self.pipeline = Gst.parse_launch(
            "audiomixer name=mix latency=200000000 start-time-selection=first "
            "! audioconvert ! audio/x-raw,channels=1 "
            f"! {ENCODERS[ext]} "
            f"! filesink name=sink location=\"{path}\" "
            # constant silent input keeps the timeline continuous while a
            # capture stream is being rebuilt
            "audiotestsrc wave=silence is-live=true "
            f"! {RATE_CAPS} ! mix."
        )
        self.mix = self.pipeline.get_by_name("mix")
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self.on_message)
        for kind in SOURCES:
            self.add_branch(kind)
        self.watch_defaults()

    def watch_defaults(self):
        """Rebuild a stream whenever the matching default device changes."""
        self.subscriber = Gio.Subprocess.new(
            ["pactl", "subscribe"], Gio.SubprocessFlags.STDOUT_PIPE)
        self.events = Gio.DataInputStream.new(self.subscriber.get_stdout_pipe())
        self.events.read_line_async(GLib.PRIORITY_DEFAULT, None, self.on_event)

    def on_event(self, stream, result):
        line, _ = stream.read_line_finish_utf8(result)
        if line is None or self.stopping:
            return
        if "on server" in line and not self.check_queued:
            self.check_queued = True
            GLib.timeout_add(300, self.check_defaults)
        stream.read_line_async(GLib.PRIORITY_DEFAULT, None, self.on_event)

    def check_defaults(self):
        self.check_queued = False
        for kind in SOURCES:
            if kind in self.branches and default_device(kind) != self.targets.get(kind):
                log(f"[{kind}] default device changed; switching")
                self.drop_branch(kind)
                self.add_branch(kind)
        return False

    def retry(self, kind):
        if kind not in self.pending:
            self.pending.add(kind)
            GLib.timeout_add(RETRY_MS, self.add_branch, kind)

    def add_branch(self, kind):
        self.pending.discard(kind)
        if self.stopping or kind in self.branches:
            return False
        target = default_device(kind)
        if not target:
            log(f"[{kind}] no default device yet; waiting")
            self.retry(kind)
            return False
        branch = Gst.parse_bin_from_description(
            f"pipewiresrc name=src client-name=callrec-{kind} do-timestamp=true "
            f"! audioconvert ! audioresample ! {RATE_CAPS} "
            "! queue max-size-time=2000000000 leaky=downstream",
            True,
        )
        branch.set_name(f"branch-{kind}")
        src = branch.get_by_name("src")
        src.set_property("target-object", target)
        src.set_property("stream-properties", Gst.Structure.new_from_string(SOURCES[kind]))
        self.targets[kind] = target
        self.pipeline.add(branch)
        sinkpad = self.mix.request_pad_simple("sink_%u")
        branch.get_static_pad("src").link(sinkpad)
        self.branches[kind] = (branch, sinkpad)
        branch.sync_state_with_parent()
        log(f"[{kind}] capturing from {target}")
        return False

    def drop_branch(self, kind):
        branch, sinkpad = self.branches.pop(kind, (None, None))
        if branch is None:
            return
        branch.get_static_pad("src").unlink(sinkpad)
        self.mix.release_request_pad(sinkpad)
        branch.set_state(Gst.State.NULL)
        self.pipeline.remove(branch)

    def branch_of(self, obj):
        while obj is not None:
            for kind, (branch, _) in self.branches.items():
                if obj is branch:
                    return kind
            obj = obj.get_parent()
        return None

    def on_message(self, _bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, _dbg = msg.parse_error()
            kind = self.branch_of(msg.src)
            if kind and not self.stopping:
                log(f"[{kind}] device went away ({err.message}); reconnecting")
                self.drop_branch(kind)
                self.retry(kind)
            elif not self.stopping:
                log(f"fatal: {err.message}")
                self.pipeline.set_state(Gst.State.NULL)
                self.loop.quit()
                self.exit_code = 1
        elif msg.type == Gst.MessageType.EOS:
            self.pipeline.set_state(Gst.State.NULL)
            self.loop.quit()

    def stop(self, *_):
        if self.stopping:
            return True
        self.stopping = True
        log("stopping")
        self.subscriber.force_exit()
        self.pipeline.send_event(Gst.Event.new_eos())
        # never hang if EOS gets stuck somewhere
        GLib.timeout_add_seconds(5, lambda: (self.pipeline.set_state(Gst.State.NULL), self.loop.quit()))
        return True

    def run(self):
        self.exit_code = 0
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            GLib.unix_signal_add(GLib.PRIORITY_HIGH, sig, self.stop)
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            log("fatal: could not start recording pipeline")
            return 1
        print("RECORDING", flush=True)
        self.loop.run()
        return self.exit_code


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    Gst.init(None)
    return Recorder(sys.argv[1]).run()


if __name__ == "__main__":
    sys.exit(main())
