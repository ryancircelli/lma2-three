// LMA2-Aquarium.scr: the three.js remake as a real Windows screensaver.
//
// A screensaver is an .exe renamed .scr that Windows starts with:
//   /s              run full screen (on every monitor); exit on input
//   /p <hwnd>       draw the little preview inside Screen Saver Settings
//   /c[:<hwnd>]     show the settings dialog (also: no arguments / double-click)
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

            try
            {
                switch (mode)
                {
                    case "/s":
                        return Saver.RunFullScreen();
                    case "/p":
                        long hwnd;
                        return rest != null && long.TryParse(rest, out hwnd) ? Saver.RunPreview(new IntPtr(hwnd)) : 0;
                    case "/w":
                        return Saver.RunWindowed();
                    case "/selftest":
                        return Saver.RunSelfTest(rest ?? ".");
                    default: // "/c" and anything unknown: settings
                        Application.Run(new SettingsForm());
                        return 0;
                }
            }
            catch (Exception e)
            {
                if (mode == "/p" || mode == "/selftest") return 1; // never pop up dialogs there
                MessageBox.Show(
                    "The screensaver could not start:\n\n" + e.Message +
                    "\n\nIt needs the Microsoft Edge WebView2 Runtime, which is built into Windows 10 and 11.",
                    "Living Marine Aquarium 2", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
