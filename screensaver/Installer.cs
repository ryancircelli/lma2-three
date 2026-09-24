// Installing the screensaver so Windows treats it like any other:
//   C:\Windows\System32\Living Marine Aquarium 2 Remake.scr
//       Windows' Screen Saver Settings only lists screensavers from the system
//       folder, so that is where it goes (one UAC prompt; the original 2005
//       screensaver installed itself into C:\Windows the same way). Settings...
//       and Preview in that dialog then run it with /c and /p.
//       If the prompt is declined: %LOCALAPPDATA%\LMA2Screensaver\ instead,
//       which works while selected but isn't listed once you pick another.
//   rundll32 desk.cpl,InstallScreenSaver <path>
//       Windows' own "right-click > Install": selects it and opens the dialog.
//   HKCU\...\Uninstall\LMA2Screensaver - the Apps & features entry.
// The wait time and sign-in-on-resume are Windows' settings and left alone.
// Uninstall reverses all of it, including the unpacked site and WebView2 profile.

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Lma2Saver
{
    internal static class Installer
    {
        // The name Windows shows in its list (the file name without ".scr").
        public const string ScrName = "Living Marine Aquarium 2 Remake.scr";
        private const string LegacyUserScrName = "LMA2-Aquarium.scr"; // v1.0.4-1.0.5 per-user installs
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LMA2Screensaver";
        private const string DesktopKey = @"Control Panel\Desktop";
        private const uint SPI_SETSCREENSAVEACTIVE = 0x0011;
        private const uint SPIF_UPDATEINIFILE = 0x01, SPIF_SENDCHANGE = 0x02;
        private const int ERROR_CANCELLED = 1223;

        public static string SystemTarget
        {
            get { return Path.Combine(Environment.SystemDirectory, ScrName); }
        }

        public static string UserTarget
        {
            get { return Path.Combine(Embedded.DataDir, ScrName); }
        }

        /// <summary>Where it is installed, or null.</summary>
        public static string InstalledPath
        {
            get
            {
                if (File.Exists(SystemTarget)) return SystemTarget;
                if (File.Exists(UserTarget)) return UserTarget;
                string legacy = Path.Combine(Embedded.DataDir, LegacyUserScrName);
                return File.Exists(legacy) ? legacy : null;
            }
        }

        public static bool IsInstalled
        {
            get { return InstalledPath != null; }
        }

        public static string InstalledVersion
        {
            get
            {
                try { return FileVersionInfo.GetVersionInfo(InstalledPath).FileVersion ?? "?"; }
                catch (Exception) { return "?"; }
            }
        }

        private static string Self
        {
            get { return LongPath(Path.GetFullPath(Application.ExecutablePath)); }
        }

        private static bool Same(string a, string b)
        {
            return a != null && b != null && string.Equals(LongPath(a), LongPath(b), StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Install and select it. Returns a note for the user about where it went.
        /// </summary>
        public static string Install()
        {
            string target = SystemTarget;
            string note = null;
            if (!Same(Self, target))
            {
                try
                {
                    RunElevated(Application.ExecutablePath, "/copyto \"" + target + "\"");
                }
                catch (Win32Exception e) when (e.NativeErrorCode == ERROR_CANCELLED)
                {
                    // No admin approval: per-user copy.
                    target = UserTarget;
                    Directory.CreateDirectory(Embedded.DataDir);
                    if (!Same(Self, target)) CopySelf(target);
                    note = "Installed for your account only (the admin prompt was declined), so Windows lists it only " +
                           "while it is selected. Run Setup again and allow the prompt to add it to Windows' list permanently.";
                }
            }
            if (!File.Exists(target)) throw new IOException("The screensaver file was not copied to " + target + ".");

            // Earlier per-user installs are replaced by this one.
            foreach (string old in new[] { Path.Combine(Embedded.DataDir, LegacyUserScrName), target == SystemTarget ? UserTarget : null })
                if (old != null && File.Exists(old) && !Same(old, Self)) try { File.Delete(old); } catch (IOException) { } catch (UnauthorizedAccessException) { }

            Embedded.EnsureExtracted(); // unpack now, so the first start is instant

            using (RegistryKey d = Registry.CurrentUser.CreateSubKey(DesktopKey))
            {
                d.SetValue("SCRNSAVE.EXE", ShortPath(target));
                d.SetValue("ScreenSaveActive", "1");
                // Only if Windows has no wait time at all, so the screensaver can start.
                if (d.GetValue("ScreenSaveTimeOut") == null) d.SetValue("ScreenSaveTimeOut", "600");
            }
            Native.SystemParametersInfo(SPI_SETSCREENSAVEACTIVE, 1, IntPtr.Zero, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);

            long kb = 0;
            try { kb = new FileInfo(target).Length / 1024 * 3; } catch (IOException) { } // .scr + unpacked site
            using (RegistryKey u = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                u.SetValue("DisplayName", "Living Marine Aquarium 2 Remake (screensaver)");
                u.SetValue("DisplayVersion", Embedded.Version);
                u.SetValue("Publisher", "lma2-three");
                u.SetValue("URLInfoAbout", "https://github.com/ryancircelli/lma2-three");
                u.SetValue("InstallLocation", Path.GetDirectoryName(target));
                u.SetValue("DisplayIcon", target);
                u.SetValue("UninstallString", "\"" + target + "\" /uninstall");
                u.SetValue("EstimatedSize", (int)kb, RegistryValueKind.DWord);
                u.SetValue("NoModify", 1, RegistryValueKind.DWord);
                u.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
            return note;
        }

        /// <summary>Windows' own install action: selects it and opens Screen Saver Settings on it.</summary>
        public static void OpenWindowsDialog()
        {
            string path = InstalledPath;
            if (path != null) Process.Start("rundll32.exe", "desk.cpl,InstallScreenSaver " + ShortPath(path));
            else Process.Start("control.exe", "desk.cpl,,@screensaver");
        }

        /// <summary>/copyto: the elevated half of Install (runs as admin, copies only).</summary>
        public static int CopyTo(string dest)
        {
            try
            {
                CopySelf(dest);
                return 0;
            }
            catch (Exception)
            {
                return 1;
            }
        }

        private static void CopySelf(string dest)
        {
            try
            {
                File.Copy(Application.ExecutablePath, dest, true);
            }
            catch (IOException) when (File.Exists(dest))
            {
                // The installed copy is running (e.g. the preview in an open Screen Saver
                // Settings). A running file can be renamed but not overwritten: move it
                // aside, copy the new one in, and delete the old one at the next reboot.
                string old = dest + ".old-" + DateTime.Now.Ticks;
                File.Move(dest, old);
                File.Copy(Application.ExecutablePath, dest, true);
                if (!Native.DeleteFile(old)) Native.MoveFileEx(old, null, Native.MOVEFILE_DELAY_UNTIL_REBOOT);
            }
            // The download's "from the internet" mark would make Windows ask
            // before every start; the user has just chosen to install it.
            Native.DeleteFile(dest + ":Zone.Identifier");
        }

        private static void RunElevated(string file, string args)
        {
            var psi = new ProcessStartInfo(file, args) { Verb = "runas", UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden };
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                if (p.ExitCode != 0) throw new IOException("Copying into the Windows folder failed (code " + p.ExitCode + ").");
            }
        }

        public static bool ConfirmAndUninstall(IWin32Window owner)
        {
            DialogResult r = MessageBox.Show(owner,
                "Remove the Living Marine Aquarium 2 Remake screensaver and its settings?\n\n(The original 2005 screensaver is not touched.)",
                "Uninstall", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return false;
            try
            {
                Uninstall();
            }
            catch (Win32Exception e) when (e.NativeErrorCode == ERROR_CANCELLED)
            {
                MessageBox.Show(owner, "Uninstall needs the admin prompt to remove the file from the Windows folder.", "Uninstall",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            MessageBox.Show(owner, "Uninstalled.", "Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return true;
        }

        public static void Uninstall()
        {
            // The system copy needs admin to delete; if it is the one running, delete it just after we exit.
            if (File.Exists(SystemTarget))
            {
                string wait = Same(Self, SystemTarget) ? "timeout /t 3 /nobreak >nul & " : "";
                var psi = new ProcessStartInfo("cmd.exe", "/c " + wait + "del /f /q \"" + SystemTarget + "\"")
                { Verb = "runas", UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden };
                Process.Start(psi);
            }

            using (RegistryKey d = Registry.CurrentUser.OpenSubKey(DesktopKey, true))
            {
                string current = d == null ? null : d.GetValue("SCRNSAVE.EXE") as string;
                if (current != null && (Same(current, SystemTarget) || Same(current, UserTarget) ||
                    Same(current, Path.Combine(Embedded.DataDir, LegacyUserScrName))))
                {
                    d.DeleteValue("SCRNSAVE.EXE", false);
                    Native.SystemParametersInfo(SPI_SETSCREENSAVEACTIVE, 0, IntPtr.Zero, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
                }
            }
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\LMA2Screensaver", false);

            if (Self.StartsWith(Embedded.DataDir, StringComparison.OrdinalIgnoreCase))
            {
                // A running file can't delete itself: remove the folder once we exit.
                Process.Start(new ProcessStartInfo("cmd.exe",
                    "/c timeout /t 3 /nobreak >nul & rmdir /s /q \"" + Embedded.DataDir + "\"")
                { CreateNoWindow = true, UseShellExecute = false });
            }
            else
            {
                try { Directory.Delete(Embedded.DataDir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        // Windows stores and passes screensaver paths in 8.3 form (C:\WINDOWS\SYSTEM32\LIVING~2.SCR).
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint size);

        public static string ShortPath(string path)
        {
            var sb = new StringBuilder(1024);
            return GetShortPathName(path, sb, (uint)sb.Capacity) > 0 ? sb.ToString() : path;
        }

        public static string LongPath(string path)
        {
            var sb = new StringBuilder(1024);
            return GetLongPathName(path, sb, (uint)sb.Capacity) > 0 ? sb.ToString() : path;
        }
    }
}
