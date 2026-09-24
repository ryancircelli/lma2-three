// The /c settings dialog (also what a double-click on the .scr opens), with an
// "Install as my screensaver" button so no manual steps are needed.

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
        public const string InstalledName = "LMA2-Aquarium.scr";

        private readonly Settings settings = Settings.Load();
        private readonly ComboBox scene = Combo("Next scene each time (like the original)", "Scene 1", "Scene 2", "Scene 3");
        private readonly ComboBox view = Combo("Fit - 4:3 with black bars", "Fill - zoom to cover (crops)", "Stretch to the screen");
        private readonly ComboBox speed = Combo("0.5x", "1x", "1.5x", "2x", "3x", "4x");
        private readonly ComboBox tank = Combo("The original's default tank", "One of every species (19)");
        private readonly CheckBox schooling = new CheckBox { Text = "Schooling", AutoSize = true };
        private readonly CheckBox sound = new CheckBox { Text = "Play the underwater sound", AutoSize = true };
        private readonly CheckBox allMonitors = new CheckBox { Text = "Show on every monitor (otherwise black)", AutoSize = true };

        private static readonly string[] Scenes = { "rotate", "1", "2", "3" };
        private static readonly string[] Views = { "fit", "fill", "stretch" };
        private static readonly string[] Speeds = { "0.5", "1", "1.5", "2", "3", "4" };
        private static readonly string[] Tanks = { "installed", "all" };

        public SettingsForm()
        {
            Text = "Living Marine Aquarium 2 - Screensaver settings";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(12);
            Font = SystemFonts.MessageBoxFont;

            var grid = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            Row(grid, "Scene", scene);
            Row(grid, "Widescreen", view);
            Row(grid, "Speed", speed);
            Row(grid, "Fish", tank);
            Row(grid, "", schooling);
            Row(grid, "", sound);
            Row(grid, "", allMonitors);

            var links = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0, 10, 0, 0) };
            links.Controls.Add(Link("Website", Website));
            links.Controls.Add(Link("GitHub", GitHub));
            links.Controls.Add(new Label { Text = "Version " + Embedded.Version, AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(12, 3, 0, 0) });
            grid.Controls.Add(links, 0, grid.RowCount);
            grid.SetColumnSpan(links, 2);
            grid.RowCount++;

            var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0, 12, 0, 0) };
            var install = new Button { Text = "Install as my screensaver", AutoSize = true };
            var preview = new Button { Text = "Preview", AutoSize = true };
            var ok = new Button { Text = "OK", AutoSize = true, DialogResult = DialogResult.OK };
            var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
            install.Click += (s, e) => { Store(); Install(); };
            preview.Click += (s, e) => { Store(); Process.Start(Application.ExecutablePath, "/s"); };
            ok.Click += (s, e) => { Store(); Close(); };
            buttons.Controls.AddRange(new Control[] { install, preview, ok, cancel });
            grid.Controls.Add(buttons, 0, grid.RowCount);
            grid.SetColumnSpan(buttons, 2);
            grid.RowCount++;

            Controls.Add(grid);
            AcceptButton = ok;
            CancelButton = cancel;

            scene.SelectedIndex = Math.Max(0, Array.IndexOf(Scenes, settings.Scene));
            view.SelectedIndex = Math.Max(0, Array.IndexOf(Views, settings.Aspect));
            speed.SelectedIndex = Math.Max(0, Array.IndexOf(Speeds, settings.Speed));
            tank.SelectedIndex = Math.Max(0, Array.IndexOf(Tanks, settings.Tank));
            schooling.Checked = settings.Schooling;
            sound.Checked = settings.Sound;
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
            settings.AllMonitors = allMonitors.Checked;
            settings.Save();
        }

        /// <summary>
        /// Copy this .scr to %LOCALAPPDATA%\LMA2Screensaver and make it the
        /// current user's screensaver (what right-click > Install does, but to a
        /// folder that won't be cleaned up like Downloads).
        /// </summary>
        private void Install()
        {
            try
            {
                string target = Path.Combine(Embedded.DataDir, InstalledName);
                string self = Path.GetFullPath(Application.ExecutablePath);
                if (!string.Equals(self, target, StringComparison.OrdinalIgnoreCase))
                {
                    Directory.CreateDirectory(Embedded.DataDir);
                    File.Copy(self, target, true);
                    // The download's "from the internet" mark would make Windows ask
                    // before every start; the user has just chosen to install it.
                    Native.DeleteFile(target + ":Zone.Identifier");
                }
                using (RegistryKey desktop = Registry.CurrentUser.CreateSubKey(@"Control Panel\Desktop"))
                {
                    desktop.SetValue("SCRNSAVE.EXE", target);
                    desktop.SetValue("ScreenSaveActive", "1");
                    if (desktop.GetValue("ScreenSaveTimeOut") == null) desktop.SetValue("ScreenSaveTimeOut", "600");
                }
                const uint SPI_SETSCREENSAVEACTIVE = 0x0011, SPIF_UPDATEINIFILE = 0x01, SPIF_SENDCHANGE = 0x02;
                Native.SystemParametersInfo(SPI_SETSCREENSAVEACTIVE, 1, IntPtr.Zero, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
                MessageBox.Show(this,
                    "Installed. Living Marine Aquarium 2 is now your screensaver.\n\n" +
                    "The Screen Saver Settings window will open so you can set the wait time.",
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                Process.Start("control.exe", "desk.cpl,,@screensaver");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not install: " + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static ComboBox Combo(params string[] items)
        {
            var c = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 280 };
            c.Items.AddRange(items);
            return c;
        }

        private static void Row(TableLayoutPanel grid, string label, Control control)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 12, 0) }, 0, grid.RowCount);
            grid.Controls.Add(control, 1, grid.RowCount);
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
