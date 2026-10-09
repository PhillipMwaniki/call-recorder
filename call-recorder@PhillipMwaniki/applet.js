const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const IDLE_ICON = "audio-input-microphone-symbolic";
const REC_ICON = "media-record-symbolic";
const REC_STYLE = "color: #fd4663;";
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), "call-recorder"]);
const SIDES_ROOT = GLib.build_filenamev([GLib.get_user_cache_dir(), "call-recorder", "sides"]);
const MODEL_FILES = {
    base: "ggml-base-q5_1.bin", small: "ggml-small-q5_1.bin", medium: "ggml-medium-q5_0.bin",
    turbo: "ggml-large-v3-turbo-q5_0.bin", large: "ggml-large-v3-q5_0.bin",
};

function pad(n) {
    return n < 10 ? "0" + n : "" + n;
}

function formatElapsed(secs) {
    let h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
}

class CallRecorderApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.metadata = metadata;
        this.proc = null;
        this.outFile = null;
        this.lastFile = null;
        this.startedAt = 0;
        this.timerId = 0;
        this.sidesDir = null;
        this.queue = [];
        this.transcribing = null;
        this.lastTranscript = null;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("save-folder", "saveFolder");
        this.settings.bind("show-timer", "showTimer", () => this._updateLabel());
        this.settings.bind("format", "format");
        this.settings.bind("auto-transcribe", "autoTranscribe", () => this._updateTranscriptItems());
        this.settings.bind("transcript-language", "transcriptLanguage");
        this.settings.bind("transcript-model", "transcriptModel", () => this._updateTranscriptItems());

        this._buildMenu();
        this._setIdle();
    }

    // Extra entries at the top of the standard right-click menu
    _buildMenu() {
        let menu = this._applet_context_menu;
        this.toggleItem = new PopupMenu.PopupIconMenuItem(_("Start recording"), REC_ICON, 1);
        this.toggleItem.connect("activate", () => this._toggle());
        menu.addMenuItem(this.toggleItem);

        this.lastItem = new PopupMenu.PopupIconMenuItem(_("Play last recording"), "media-playback-start-symbolic", 1);
        this.lastItem.connect("activate", () => {
            if (this.lastFile) Util.spawn(["xdg-open", this.lastFile]);
        });
        this.lastItem.setSensitive(false);
        menu.addMenuItem(this.lastItem);

        let folderItem = new PopupMenu.PopupIconMenuItem(_("Open recordings folder"), "folder-symbolic", 1);
        folderItem.connect("activate", () => {
            let dir = this._folder();
            GLib.mkdir_with_parents(dir, 0o755);
            Util.spawn(["xdg-open", dir]);
        });
        menu.addMenuItem(folderItem);

        this.transcriptItem = new PopupMenu.PopupIconMenuItem(_("Open last transcript"), "text-x-generic-symbolic", 1);
        this.transcriptItem.connect("activate", () => {
            if (this.lastTranscript) Util.spawn(["xdg-open", this.lastTranscript]);
        });
        menu.addMenuItem(this.transcriptItem);

        this.transcribeItem = new PopupMenu.PopupIconMenuItem(_("Transcribe a recording…"), "document-edit-symbolic", 1);
        this.transcribeItem.connect("activate", () => this._pickAndTranscribe());
        menu.addMenuItem(this.transcribeItem);

        this.setupItem = new PopupMenu.PopupIconMenuItem(_("Set up transcription…"), "emblem-downloads-symbolic", 1);
        this.setupItem.connect("activate", () => this._setupTranscription());
        menu.addMenuItem(this.setupItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._updateTranscriptItems();
    }

    // ---- transcription -----------------------------------------------------

    _whisperReady() {
        let cli = GLib.build_filenamev([DATA_DIR, "whisper.cpp", "build", "bin", "whisper-cli"]);
        let model = GLib.build_filenamev([DATA_DIR, "models", MODEL_FILES[this.transcriptModel] || MODEL_FILES.small]);
        return GLib.file_test(cli, GLib.FileTest.IS_EXECUTABLE) && GLib.file_test(model, GLib.FileTest.EXISTS);
    }

    _updateTranscriptItems() {
        if (!this.transcriptItem) return;
        let ready = this._whisperReady();
        this.transcriptItem.setSensitive(!!this.lastTranscript);
        this.transcribeItem.setSensitive(ready);
        this.setupItem.actor.visible = !ready;
        if (this.transcribing) {
            let left = this.queue.length ? ` (+${this.queue.length} waiting)` : "";
            this.transcribeItem.label.set_text(_("Transcribing ") + GLib.path_get_basename(this.transcribing.file) + "…" + left);
        } else {
            this.transcribeItem.label.set_text(_("Transcribe a recording…"));
        }
    }

    _sidesFor(file) {
        let base = GLib.path_get_basename(file).replace(/\.[^.]+$/, "");
        return GLib.build_filenamev([SIDES_ROOT, base]);
    }

    _queueTranscription(file) {
        this.queue.push(file);
        this._nextTranscription();
    }

    _nextTranscription() {
        if (this.transcribing || !this.queue.length) {
            this._updateTranscriptItems();
            return;
        }
        let file = this.queue.shift();
        let args = ["python3", GLib.build_filenamev([this.metadata.path, "transcribe.py"]), file,
                    "--language", this.transcriptLanguage || "auto", "--model", this.transcriptModel || "small"];
        let sides = this._sidesFor(file);
        if (GLib.file_test(sides, GLib.FileTest.IS_DIR)) args.push("--sides", sides);

        let proc;
        try {
            proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            Main.notify(_("Transcription failed"), e.message);
            this._nextTranscription();
            return;
        }
        this.transcribing = { file, proc };
        this._updateTranscriptItems();
        this._updateIdleTooltip();
        proc.communicate_utf8_async(null, null, (p, res) => {
            let out = "", err = "";
            try {
                [, out, err] = p.communicate_utf8_finish(res);
            } catch (e) {
                err = e.message;
            }
            this.transcribing = null;
            if (p.get_successful() && out.trim()) {
                this.lastTranscript = out.trim().split("\n").pop();
                Main.notify(_("Transcript ready"), this.lastTranscript);
            } else {
                let tail = (err || "").trim().split("\n").slice(-2).join("\n");
                global.logError("call-recorder: transcription failed: " + err);
                Main.notify(_("Transcription failed"), tail || _("whisper.cpp stopped unexpectedly."));
            }
            this._updateIdleTooltip();
            this._nextTranscription();
        });
    }

    _pickAndTranscribe() {
        if (this.transcribing) return;
        let dir = this._folder();
        try {
            let proc = Gio.Subprocess.new(["zenity", "--file-selection", "--title=Transcribe a recording",
                                           "--filename=" + dir + "/", "--file-filter=Recordings | *.ogg *.mp3 *.wav *.m4a *.flac"],
                                          Gio.SubprocessFlags.STDOUT_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                let [, out] = p.communicate_utf8_finish(res);
                let file = (out || "").trim();
                if (p.get_successful() && file) this._queueTranscription(file);
            });
        } catch (e) {
            Main.notify(_("Call recorder"), _("Couldn't open a file picker: ") + e.message);
        }
    }

    _setupTranscription() {
        let installer = GLib.build_filenamev([this.metadata.path, "install-whisper.sh"]);
        let model = this.transcriptModel || "small";
        let script = `sh "${installer}" ${model}; echo; printf 'Press Enter to close… '; read _`;
        try {
            let proc = Gio.Subprocess.new(["x-terminal-emulator", "-e", "sh", "-c", script], Gio.SubprocessFlags.NONE);
            proc.wait_async(null, () => this._updateTranscriptItems());
        } catch (e) {
            Main.notify(_("Call recorder"), _("Couldn't open a terminal: ") + e.message);
        }
    }

    _updateIdleTooltip() {
        if (this.proc) return;
        this.set_applet_tooltip(this.transcribing
            ? _("Call recorder: transcribing ") + GLib.path_get_basename(this.transcribing.file) + "…"
            : _("Call recorder: click to record both sides of a call"));
    }

    // Left-click toggles recording; right-click opens the menu.
    on_applet_clicked() {
        this._toggle();
    }

    _folder() {
        let dir = this.saveFolder || "";
        if (dir.startsWith("file://")) dir = Gio.File.new_for_uri(dir).get_path();
        if (!dir) dir = GLib.build_filenamev([GLib.get_home_dir(), "Recordings", "Calls"]);
        return dir.replace(/^~/, GLib.get_home_dir());
    }

    _toggle() {
        if (this.proc) this._stop();
        else this._start();
    }

    _start() {
        let dir = this._folder();
        GLib.mkdir_with_parents(dir, 0o755);
        let stamp = GLib.DateTime.new_now_local().format("%Y-%m-%d %H-%M-%S");
        this.outFile = GLib.build_filenamev([dir, "Call " + stamp + (this.format === "mp3" ? ".mp3" : ".ogg")]);
        let script = GLib.build_filenamev([this.metadata.path, "recorder.py"]);
        let args = ["python3", script, this.outFile];
        // Separate tracks per side let the transcript say who spoke
        this.sidesDir = this.autoTranscribe ? this._sidesFor(this.outFile) : null;
        if (this.sidesDir) args.push("--sides", this.sidesDir);

        try {
            this.proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            global.logError("call-recorder: " + e.message);
            Main.notify(_("Call recorder"), _("Could not start recording: ") + e.message);
            this.proc = null;
            return;
        }

        let proc = this.proc;
        proc.communicate_utf8_async(null, null, (p, res) => {
            let stderr = "";
            try {
                [, , stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                stderr = e.message;
            }
            this._onFinished(proc, stderr || "");
        });

        this.startedAt = GLib.get_monotonic_time();
        this._setRecording();
        Main.notify(_("Recording call"), _("Recording your mic and the other side. Click the panel icon to stop."));
    }

    _stop() {
        if (this.proc) this.proc.send_signal(2); // SIGINT: recorder closes the file cleanly
    }

    _onFinished(proc, stderr) {
        if (proc !== this.proc) return;
        let ok = proc.get_if_exited() && proc.get_exit_status() === 0;
        let file = this.outFile;
        this.proc = null;
        this.outFile = null;
        this._setIdle();

        if (ok && GLib.file_test(file, GLib.FileTest.EXISTS)) {
            this.lastFile = file;
            this.lastItem.setSensitive(true);
            Main.notify(_("Call recording saved"), file);
            if (this.autoTranscribe) {
                if (this._whisperReady()) this._queueTranscription(file);
                else Main.notify(_("Transcription isn't set up yet"),
                                 _("Right-click the recorder and choose \"Set up transcription…\"."));
            }
        } else {
            let tail = stderr.trim().split("\n").slice(-3).join("\n");
            global.logError("call-recorder: recorder exited: " + stderr);
            Main.notify(_("Call recording failed"), tail || _("The recorder stopped unexpectedly."));
        }
    }

    _setRecording() {
        this.set_applet_icon_symbolic_name(REC_ICON);
        this._applet_icon.set_style(REC_STYLE);
        this._applet_label.set_style(REC_STYLE);
        this.toggleItem.label.set_text(_("Stop recording"));
        this.toggleItem.setIconSymbolicName("media-playback-stop-symbolic");
        this._updateLabel();
        this.timerId = Mainloop.timeout_add_seconds(1, () => {
            this._updateLabel();
            return true;
        });
    }

    _setIdle() {
        if (this.timerId) {
            Mainloop.source_remove(this.timerId);
            this.timerId = 0;
        }
        this.set_applet_icon_symbolic_name(IDLE_ICON);
        this._applet_icon.set_style(null);
        this._applet_label.set_style(null);
        this.toggleItem.label.set_text(_("Start recording"));
        this.toggleItem.setIconSymbolicName(REC_ICON);
        this.set_applet_label("");
        this._updateIdleTooltip();
    }

    _updateLabel() {
        if (!this.proc) return;
        let secs = Math.floor((GLib.get_monotonic_time() - this.startedAt) / 1000000);
        this.set_applet_label(this.showTimer ? formatElapsed(secs) : "");
        this.set_applet_tooltip(_("Recording call") + " (" + formatElapsed(secs) + "). " + _("Click to stop."));
    }

    on_applet_removed_from_panel() {
        this._stop();
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new CallRecorderApplet(metadata, orientation, panelHeight, instanceId);
}
