// Per-user install (no admin rights needed):
//   %LOCALAPPDATA%\LMA2Screensaver\LMA2-Aquarium.scr   the screensaver itself
//   HKCU\Control Panel\Desktop                          the selected screensaver (the wait time and
//                                                       sign-in lock are Windows' settings: untouched)
//   HKCU\...\Uninstall\LMA2Screensaver                  the Apps & features entry
// Uninstall reverses all of it, including the unpacked site and WebView2 profile.

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Lma2Saver
{
    internal static class Installer
    {
        public const string ScrName = "LMA2-Aquarium.scr";
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LMA2Screensaver";
        private const string DesktopKey = @"Control Panel\Desktop";
        private const uint SPI_SETSCREENSAVEACTIVE = 0x0011;
        private const uint SPIF_UPDATEINIFILE = 0x01, SPIF_SENDCHANGE = 0x02;

        public static string Target
        {
            get { return Path.Combine(Embedded.DataDir, ScrName); }
        }

        public static bool IsInstalled
        {
            get { return File.Exists(Target); }
        }

        public static string InstalledVersion
        {
            get
            {
                try { return FileVersionInfo.GetVersionInfo(Target).FileVersion ?? "?"; }
                catch (IOException) { return "?"; }
            }
        }

        /// <summary>True when this process is the installed copy (not a setup .exe run from Downloads).</summary>
        public static bool IsRunningInstalledCopy
        {
            get { return string.Equals(Path.GetFullPath(Application.ExecutablePath), Target, StringComparison.OrdinalIgnoreCase); }
        }

        public static void Install()
        {
            Directory.CreateDirectory(Embedded.DataDir);
            if (!IsRunningInstalledCopy)
            {
                File.Copy(Application.ExecutablePath, Target, true);
                // The download's "from the internet" mark would make Windows ask
                // before every start; the user has just chosen to install it.
                Native.DeleteFile(Target + ":Zone.Identifier");
            }
            Embedded.EnsureExtracted(); // unpack now, so the first start is instant

            using (RegistryKey d = Registry.CurrentUser.CreateSubKey(DesktopKey))
            {
                d.SetValue("SCRNSAVE.EXE", Target);
                d.SetValue("ScreenSaveActive", "1");
                // Only if Windows has no wait time at all, so the screensaver can start.
                if (d.GetValue("ScreenSaveTimeOut") == null) d.SetValue("ScreenSaveTimeOut", "600");
            }
            Native.SystemParametersInfo(SPI_SETSCREENSAVEACTIVE, 1, IntPtr.Zero, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);

            long kb = 0;
            try { kb = new FileInfo(Target).Length / 1024 * 3; } catch (IOException) { } // .scr + unpacked site
            using (RegistryKey u = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                u.SetValue("DisplayName", "Living Marine Aquarium 2 screensaver (three.js remake)");
                u.SetValue("DisplayVersion", Embedded.Version);
                u.SetValue("Publisher", "lma2-three");
                u.SetValue("URLInfoAbout", "https://github.com/ryancircelli/lma2-three");
                u.SetValue("InstallLocation", Embedded.DataDir);
                u.SetValue("DisplayIcon", Target);
                u.SetValue("UninstallString", "\"" + Target + "\" /uninstall");
                u.SetValue("EstimatedSize", (int)kb, RegistryValueKind.DWord);
                u.SetValue("NoModify", 1, RegistryValueKind.DWord);
                u.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        public static bool ConfirmAndUninstall(IWin32Window owner)
        {
            DialogResult r = MessageBox.Show(owner,
                "Remove the Living Marine Aquarium 2 screensaver and its settings?",
                "Uninstall", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return false;
            Uninstall();
            MessageBox.Show(owner, "Uninstalled.", "Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return true;
        }

        public static void Uninstall()
        {
            using (RegistryKey d = Registry.CurrentUser.OpenSubKey(DesktopKey, true))
            {
                string current = d == null ? null : d.GetValue("SCRNSAVE.EXE") as string;
                if (current != null && string.Equals(current, Target, StringComparison.OrdinalIgnoreCase))
                {
                    d.DeleteValue("SCRNSAVE.EXE", false);
                    Native.SystemParametersInfo(SPI_SETSCREENSAVEACTIVE, 0, IntPtr.Zero, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
                }
            }
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\LMA2Screensaver", false);

            if (IsRunningInstalledCopy)
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
    }
}
