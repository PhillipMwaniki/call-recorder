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

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("save-folder", "saveFolder");
        this.settings.bind("show-timer", "showTimer", () => this._updateLabel());
        this.settings.bind("format", "format");

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
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
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

        try {
            this.proc = Gio.Subprocess.new(["python3", script, this.outFile],
                                           Gio.SubprocessFlags.STDERR_PIPE);
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
        this.set_applet_tooltip(_("Call recorder: click to record both sides of a call"));
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
