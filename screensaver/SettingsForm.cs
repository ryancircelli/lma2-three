// Two faces of one dialog:
//   Setup     LMA2-Aquarium-Setup.exe run directly: pick settings, then Install
//             (copies itself into place as the screensaver, selects it, sets
//             the wait time, registers in Apps & features). Offers Uninstall
//             when already installed.
//   Settings  the installed .scr with /c (Screen Saver Settings > Settings...).
// Double-clicking a .scr makes Windows run it as the screensaver (/S), which is
// why setup is distributed as an .exe.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Lma2Saver
{
    internal sealed class SettingsForm : Form
    {
        private const string Website = "https://lma2.ryancircelli.com";
        private const string GitHub = "https://github.com/ryancircelli/lma2-three";

        private readonly bool setup;
        private readonly Settings settings = Settings.Load();
        private readonly ComboBox scene = Combo("Next scene each time (like the original)", "Scene 1", "Scene 2", "Scene 3");
        private readonly ComboBox view = Combo("Fit - 4:3 with black bars", "Fill - zoom to cover (crops)", "Stretch to the screen");
        private readonly ComboBox speed = Combo("0.5x", "1x", "1.5x", "2x", "3x", "4x");
        private readonly ComboBox tank = Combo("The original's tank (17)", "The original's tank + one of every other species (25)", "One of every species (19)");
        private readonly CheckBox schooling = new CheckBox { Text = "Schooling", AutoSize = true };
        private readonly CheckBox sound = new CheckBox { Text = "Play the underwater sound", AutoSize = true };
        private readonly TrackBar volume = new TrackBar { Minimum = 0, Maximum = 100, TickFrequency = 10, SmallChange = 5, LargeChange = 20, Width = 240, AutoSize = true };
        private readonly Label volumeText = new Label { AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(6, 6, 0, 0) };
        private readonly CheckBox allMonitors = new CheckBox { Text = "Show on every monitor (otherwise black)", AutoSize = true };

        private static readonly string[] Scenes = { "rotate", "1", "2", "3" };
        private static readonly string[] Views = { "fit", "fill", "stretch" };
        private static readonly string[] Speeds = { "0.5", "1", "1.5", "2", "3", "4" };
        private static readonly string[] Tanks = { "installed", "complete", "all" };

        public SettingsForm(bool setup)
        {
            this.setup = setup;
            Text = setup ? "Living Marine Aquarium 2 - Setup" : "Living Marine Aquarium 2 - Screensaver settings";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            AutoScaleMode = AutoScaleMode.Dpi;
            Padding = new Padding(14);
            Font = SystemFonts.MessageBoxFont;

            var grid = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            string intro = setup
                ? (Installer.IsInstalled
                    ? "Installed (version " + Installer.InstalledVersion + "). Change settings and press Install to update, or Uninstall."
                    : "Choose how the aquarium should look, then press Install.")
                : "Living Marine Aquarium 2 screensaver settings.";
            var heading = new Label { Text = intro, AutoSize = true, MaximumSize = new Size(460, 0), Margin = new Padding(0, 0, 0, 10) };
            grid.Controls.Add(heading, 0, 0);
            grid.SetColumnSpan(heading, 2);
            grid.RowCount = 1;

            Row(grid, "Scene", scene);
            Row(grid, "Widescreen", view);
            Row(grid, "Speed", speed);
            Row(grid, "Fish", tank);
            Row(grid, "", schooling);
            Row(grid, "", sound);
            var volumeRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
            volumeRow.Controls.Add(volume);
            volumeRow.Controls.Add(volumeText);
            Row(grid, "Volume", volumeRow);
            volume.ValueChanged += (s, e) => volumeText.Text = volume.Value + "%" + (volume.Value == 100 ? " (original)" : "");
            sound.CheckedChanged += (s, e) => volume.Enabled = sound.Checked;
            Row(grid, "", allMonitors);
            if (setup)
            {
                // The wait time and sign-in on resume are Windows' own settings,
                // left as they are; Install offers to open that dialog.
                var note = new Label
                {
                    Text = "How long Windows waits, and whether it asks you to sign in afterwards, stay in Windows' Screen Saver Settings.",
                    AutoSize = true,
                    MaximumSize = new Size(460, 0),
                    ForeColor = SystemColors.GrayText,
                    Margin = new Padding(0, 8, 0, 0),
                };
                AddSpanning(grid, note);
            }

            var links = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
            links.Controls.Add(Link("Website", Website));
            links.Controls.Add(Link("GitHub", GitHub));
            links.Controls.Add(new Label { Text = "Version " + Embedded.Version, AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(12, 3, 0, 0) });
            AddSpanning(grid, links);

            var buttons = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0, 14, 0, 0) };
            var preview = new Button { Text = "Preview", AutoSize = true };
            preview.Click += (s, e) => { Store(); Process.Start(Application.ExecutablePath, "/s"); };
            if (setup)
            {
                var install = new Button { Text = Installer.IsInstalled ? "Update" : "Install", AutoSize = true };
                install.Click += (s, e) => DoInstall();
                var cancel = new Button { Text = "Close", AutoSize = true, DialogResult = DialogResult.Cancel };
                buttons.Controls.Add(install);
                buttons.Controls.Add(preview);
                if (Installer.IsInstalled)
                {
                    var uninstall = new Button { Text = "Uninstall", AutoSize = true };
                    uninstall.Click += (s, e) => { if (Installer.ConfirmAndUninstall(this)) Close(); };
                    buttons.Controls.Add(uninstall);
                }
                buttons.Controls.Add(cancel);
                AcceptButton = install;
                CancelButton = cancel;
            }
            else
            {
                var ok = new Button { Text = "OK", AutoSize = true };
                ok.Click += (s, e) => { Store(); Close(); };
                var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
                buttons.Controls.AddRange(new Control[] { preview, ok, cancel });
                AcceptButton = ok;
                CancelButton = cancel;
            }
            AddSpanning(grid, buttons);
            Controls.Add(grid);

            scene.SelectedIndex = Math.Max(0, Array.IndexOf(Scenes, settings.Scene));
            view.SelectedIndex = Math.Max(0, Array.IndexOf(Views, settings.Aspect));
            speed.SelectedIndex = Math.Max(0, Array.IndexOf(Speeds, settings.Speed));
            tank.SelectedIndex = Math.Max(0, Array.IndexOf(Tanks, settings.Tank));
            schooling.Checked = settings.Schooling;
            sound.Checked = settings.Sound;
            volume.Value = settings.Volume;
            volumeText.Text = volume.Value + "%" + (volume.Value == 100 ? " (original)" : "");
            volume.Enabled = sound.Checked;
            allMonitors.Checked = settings.AllMonitors;
        }

        private void Store()
        {
            settings.Scene = Scenes[scene.SelectedIndex];
            settings.Aspect = Views[view.SelectedIndex];
            settings.Speed = Speeds[speed.SelectedIndex];
            settings.Tank = Tanks[tank.SelectedIndex];
            settings.Schooling = schooling.Checked;
            settings.Sound = sound.Checked;
            settings.Volume = volume.Value;
            settings.AllMonitors = allMonitors.Checked;
            settings.Save();
        }

        private void DoInstall()
        {
            Store();
            string note;
            try
            {
                note = Installer.Install();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not install: " + ex.Message +
                    "\n\nIf the screensaver is running right now, stop it and try again.",
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            MessageBox.Show(this,
                "Installed as \"Living Marine Aquarium 2 Remake\", and selected as your screensaver.\n\n" +
                "Windows' Screen Saver Settings opens next: set the wait time and sign-in there. Its Settings... button " +
                "opens these options again, and the original screensaver is still in the list if you want to switch back." +
                (note == null ? "" : "\n\n" + note),
                Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            Installer.OpenWindowsDialog();
            Close();
        }

        private static ComboBox Combo(params string[] items)
        {
            var c = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 300 };
            c.Items.AddRange(items);
            return c;
        }

        private static void Row(TableLayoutPanel grid, string label, Control control)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 12, 0) }, 0, grid.RowCount);
            grid.Controls.Add(control, 1, grid.RowCount);
            grid.RowCount++;
        }

        private static void AddSpanning(TableLayoutPanel grid, Control control)
        {
            grid.Controls.Add(control, 0, grid.RowCount);
            grid.SetColumnSpan(control, 2);
            grid.RowCount++;
        }

        private static LinkLabel Link(string text, string url)
        {
            var l = new LinkLabel { Text = text, AutoSize = true, Margin = new Padding(0, 3, 12, 0) };
            l.LinkClicked += (s, e) => Process.Start(url);
            return l;
        }
    }
}
