// LMA2-Aquarium.scr: the three.js remake as a real Windows screensaver.
//
// A screensaver is an .exe renamed .scr that Windows starts with:
//   /s              run full screen (on every monitor); exit on input
//   /p <hwnd>       draw the little preview inside Screen Saver Settings
//   /c[:<hwnd>]     show the settings dialog
// Double-clicking an .scr runs it with /S, so the same program is also shipped
// as LMA2-Aquarium-Setup.exe: run as an .exe with no arguments it is the
// installer (SettingsForm in setup mode; Installer.cs). /uninstall is what
// Apps & features runs.
// Extra modes for testing:
//   /w              a normal 1024x768 window with the site's own UI
//   /selftest <dir> load off-screen, wait for the tank, write status.json and
//                   selftest.png to <dir>, exit 0 on success
//
// The whole site (the same files lma2.ryancircelli.com serves) is embedded as
// site.zip and rendered offline by WebView2, the Edge engine built into
// Windows 10/11. See Embedded.cs for how it is unpacked.

using System;
using System.Runtime.CompilerServices;
using System.Windows.Forms;

namespace Lma2Saver
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            // Must be hooked before any method that touches a WebView2 type is
            // compiled: the WebView2 assemblies are embedded, not beside the .scr.
            AppDomain.CurrentDomain.AssemblyResolve += Embedded.Resolve;
            return Run(args);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static int Run(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string mode = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "/c";
            string rest = args.Length > 1 ? args[1] : null;
            // Windows sometimes passes "/p:1234" or "/c:1234" in one argument.
            int colon = mode.IndexOf(':');
            if (colon > 0)
            {
                rest = mode.Substring(colon + 1);
                mode = mode.Substring(0, colon);
            }
            if (mode.StartsWith("-")) mode = "/" + mode.Substring(1);

            Log.Start(mode, args);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) =>
            {
                Log.Error("UI thread", e.Exception);
                Saver.Exit();
            };
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                if (e.ExceptionObject is Exception ex) Log.Error("unhandled", ex);
            };

            try
            {
                switch (mode)
                {
                    case "/s":
                        return Saver.RunFullScreen();
                    case "/stest": // the /s code path in one off-screen window, for testing
                        int seconds;
                        return Saver.RunSaverTest(rest != null && int.TryParse(rest, out seconds) ? seconds : 20);
                    case "/p":
                        long hwnd;
                        return rest != null && long.TryParse(rest, out hwnd) ? Saver.RunPreview(new IntPtr(hwnd)) : 0;
                    case "/w":
                        return Saver.RunWindowed();
                    case "/selftest":
                        return Saver.RunSelfTest(rest ?? ".");
                    case "/uninstall": // Apps & features
                        Installer.ConfirmAndUninstall(null);
                        return 0;
                    case "/copyto": // the elevated half of Install
                        return rest == null ? 1 : Installer.CopyTo(rest);
                    default:
                        // Run as an .exe (LMA2-Aquarium-Setup.exe): the installer.
                        // As an .scr with /c (Screen Saver Settings): its settings.
                        bool setup = !Application.ExecutablePath.EndsWith(".scr", StringComparison.OrdinalIgnoreCase);
                        Application.Run(new SettingsForm(setup));
                        return 0;
                }
            }
            catch (Exception e)
            {
                Log.Error("start", e);
                if (mode == "/p" || mode == "/selftest" || mode == "/stest") return 1; // never pop up dialogs there
                MessageBox.Show(
                    "The screensaver could not start:\n\n" + e.Message +
                    "\n\nIt needs the Microsoft Edge WebView2 Runtime, which is built into Windows 10 and 11.",
                    "Living Marine Aquarium 2", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
