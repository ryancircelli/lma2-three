// The screensaver windows: one WebView2 per monitor rendering the offline site.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Lma2Saver
{
    internal static class Saver
    {
        /// <summary>The offline site is served from this private host name.</summary>
        public const string Host = "lma2.saver";

        public static string SiteDir;
        private static bool selfTest;
        public static bool Testing; // /stest: the saver path, off-screen and timed
        private static Task<CoreWebView2Environment> env;

        /// <summary>
        /// Injected into the page in /s mode: like the original (decompiled),
        /// any key, any mouse button, or a mouse move of more than 120 px ends
        /// the screensaver. Input in the first second is ignored.
        /// </summary>
        public const string ExitScript = @"(() => {
  const t0 = performance.now(); let origin = null;
  const exit = (why) => { if (performance.now() - t0 > 1000) window.chrome.webview.postMessage('exit:' + why); };
  addEventListener('mousemove', (e) => {
    if (!origin) { origin = [e.screenX, e.screenY]; return; }
    const d = Math.hypot(e.screenX - origin[0], e.screenY - origin[1]);
    if (d > 120) exit('mouse moved ' + Math.round(d) + ' px');
  }, true);
  for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart']) addEventListener(type, (e) => exit(type + (e.key ? ' ' + e.key : '')), true);
})();";

        private static void Prepare()
        {
            string dir = Embedded.EnsureExtracted();
            SiteDir = Path.Combine(dir, "site");
            CoreWebView2Environment.SetLoaderDllFolderPath(dir);
        }

        /// <summary>The WebView2 profile for this process (see Embedded.ProfileDir).</summary>
        public static string Profile = "saver";

        public static Task<CoreWebView2Environment> Environment()
        {
            if (env == null)
            {
                // Sound without a click (a screensaver has no user gesture).
                string args = "--autoplay-policy=no-user-gesture-required";
                // The self-test window is off-screen: keep it rendering anyway.
                if (selfTest) args += " --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling";
                string dir = Embedded.ProfileDir(Profile);
                Log.Write("WebView2 runtime " + SafeVersion() + ", profile " + dir + ", args " + args);
                env = CoreWebView2Environment.CreateAsync(null, dir, new CoreWebView2EnvironmentOptions(args));
            }
            return env;
        }

        private static bool exiting;

        public static void Exit(string why = null)
        {
            if (exiting) return;
            exiting = true;
            Log.Write("exit" + (why == null ? "" : ": " + why));
            Application.Exit();
        }

        private static string SafeVersion()
        {
            try { return CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (Exception e) { return "NOT FOUND (" + e.Message + ")"; }
        }

        /// <summary>/stest: one Saver window off-screen for N seconds (the /s code path without taking over the display).</summary>
        public static int RunSaverTest(int seconds)
        {
            selfTest = true;
            Testing = true;
            Profile = "test";
            Prepare();
            Settings s = Settings.Load();
            var form = new SaverForm(SaverForm.Kind.Saver, new Rectangle(-4000, -4000, 1024, 768), s.Query(true, false));
            var timer = new Timer { Interval = seconds * 1000 };
            int result = 3; // 3: ended early (see log)
            timer.Tick += (o, e) => { result = 0; Exit("test survived " + seconds + " s"); };
            timer.Start();
            form.FormClosed += (o, e) => Exit();
            Application.Run(form);
            return result;
        }

        public static int RunFullScreen()
        {
            Prepare();
            Settings s = Settings.Load();
            var forms = new List<Form>();
            foreach (Screen screen in Screen.AllScreens)
            {
                bool show = s.AllMonitors || screen.Primary;
                forms.Add(new SaverForm(SaverForm.Kind.Saver, screen.Bounds, show ? s.Query(screen.Primary, false) : null));
            }
            Cursor.Hide();
            var context = new ApplicationContext();
            foreach (Form f in forms)
            {
                f.FormClosed += (sender, e) => Exit();
                f.Show();
            }
            // The primary monitor's window takes the keyboard.
            forms[Array.FindIndex(Screen.AllScreens, sc => sc.Primary)].Activate();
            Application.Run(context);
            return 0;
        }

        public static int RunPreview(IntPtr parent)
        {
            Profile = "preview";
            Prepare();
            var form = new SaverForm(SaverForm.Kind.Preview, Rectangle.Empty, Settings.Load().Query(false, true), parent);
            Application.Run(form);
            return 0;
        }

        public static int RunWindowed()
        {
            Profile = "window";
            Prepare();
            Application.Run(new SaverForm(SaverForm.Kind.Window, Rectangle.Empty, "?aspect=" + Settings.Load().Aspect));
            return 0;
        }

        public static int RunSelfTest(string outDir)
        {
            selfTest = true;
            Profile = "test";
            Prepare();
            Directory.CreateDirectory(outDir);
            // Off-screen, fixed seed and time (?clean=1&t=30), no sound.
            var form = new SaverForm(SaverForm.Kind.SelfTest, new Rectangle(-4000, -4000, 1024, 768), "?saver=1&clean=1&t=30&scene=1&sound=0", IntPtr.Zero, outDir);
            Application.Run(form);
            return form.SelfTestResult;
        }
    }

    internal sealed class SaverForm : Form
    {
        public enum Kind { Saver, Preview, Window, SelfTest }

        private readonly Kind kind;
        private readonly string query;
        private readonly IntPtr previewParent;
        private readonly string testDir;
        private readonly WebView2 web;
        private readonly DateTime shown = DateTime.UtcNow;
        private Point? mouseOrigin;
        public int SelfTestResult = 2; // 2: timed out

        public SaverForm(Kind kind, Rectangle bounds, string query, IntPtr previewParent = default(IntPtr), string testDir = null)
        {
            this.kind = kind;
            this.query = query;
            this.previewParent = previewParent;
            this.testDir = testDir;
            Text = "Living Marine Aquarium 2";
            BackColor = Color.Black;
            StartPosition = FormStartPosition.Manual;
            KeyPreview = true;
            switch (kind)
            {
                case Kind.Saver:
                case Kind.SelfTest:
                    FormBorderStyle = FormBorderStyle.None;
                    ShowInTaskbar = false;
                    Bounds = bounds;
                    TopMost = kind == Kind.Saver && !Saver.Testing;
                    break;
                case Kind.Preview:
                    FormBorderStyle = FormBorderStyle.None;
                    ShowInTaskbar = false;
                    break;
                default:
                    ClientSize = new Size(1024, 768);
                    StartPosition = FormStartPosition.CenterScreen;
                    break;
            }
            if (query != null)
            {
                web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
                Controls.Add(web);
            }
        }

        // /p: become a child of the Screen Saver Settings preview box.
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                if (kind == Kind.Preview)
                {
                    cp.Style = unchecked((int)(Native.WS_CHILD | Native.WS_VISIBLE | Native.WS_CLIPCHILDREN));
                    cp.Parent = previewParent;
                    Native.RECT r;
                    if (Native.GetClientRect(previewParent, out r))
                    {
                        cp.X = 0;
                        cp.Y = 0;
                        cp.Width = r.Right - r.Left;
                        cp.Height = r.Bottom - r.Top;
                    }
                }
                return cp;
            }
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            if (kind == Kind.Preview)
            {
                // The preview process is ours to end when its host window goes away.
                var timer = new Timer { Interval = 1000 };
                timer.Tick += (s, a) => { if (!Native.IsWindow(previewParent)) Saver.Exit("preview host closed"); };
                timer.Start();
            }
            if (web == null) return;
            try
            {
                CoreWebView2Environment environment = await Saver.Environment();
                Log.Write(kind + ": environment ready, browser " + environment.BrowserVersionString);
                await web.EnsureCoreWebView2Async(environment);
                CoreWebView2 core = web.CoreWebView2;
                Log.Write(kind + ": webview ready");
                core.ProcessFailed += (s, a) =>
                {
                    Log.Write(kind + ": WebView2 process failed: " + a.ProcessFailedKind + " reason " + a.Reason + " exit " + a.ExitCode);
                    if (kind == Kind.Saver && a.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) Saver.Exit("browser process exited");
                };
                core.NavigationCompleted += (s, a) =>
                    Log.Write(kind + ": page loaded " + (a.IsSuccess ? "ok" : "FAILED " + a.WebErrorStatus));
                core.SetVirtualHostNameToFolderMapping(Saver.Host, Saver.SiteDir, CoreWebView2HostResourceAccessKind.Allow);
                bool interactive = kind == Kind.Window;
                core.Settings.AreDefaultContextMenusEnabled = interactive;
                core.Settings.AreDevToolsEnabled = interactive;
                core.Settings.AreBrowserAcceleratorKeysEnabled = interactive;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                // Links (GitHub, downloads) open in the user's browser, never in here.
                core.NewWindowRequested += (s, a) => { a.Handled = true; OpenExternal(a.Uri); };
                core.NavigationStarting += (s, a) =>
                {
                    if (a.Uri.StartsWith("https://" + Saver.Host + "/", StringComparison.OrdinalIgnoreCase)) return;
                    a.Cancel = true;
                    OpenExternal(a.Uri);
                };
                if (kind == Kind.Saver)
                {
                    await core.AddScriptToExecuteOnDocumentCreatedAsync(Saver.ExitScript);
                    core.WebMessageReceived += (s, a) =>
                    {
                        string message = null;
                        try { message = a.TryGetWebMessageAsString(); } catch (ArgumentException) { }
                        if (message != null && message.StartsWith("exit")) Saver.Exit("input: " + message.Substring(Math.Min(5, message.Length)));
                    };
                }
                core.Navigate("https://" + Saver.Host + "/index.html" + query);
                if (kind == Kind.Saver) web.Focus();
                if (kind == Kind.SelfTest) await RunSelfTest(core);
            }
            catch (Exception ex)
            {
                Log.Error(kind + " start", ex);
                if (kind == Kind.Saver || kind == Kind.Preview) { Saver.Exit("error: " + ex.Message); return; }
                if (kind == Kind.SelfTest)
                {
                    File.WriteAllText(Path.Combine(testDir, "status.json"), "{\"error\":" + Json(ex.Message) + "}");
                    SelfTestResult = 1;
                    Saver.Exit();
                    return;
                }
                MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private async Task RunSelfTest(CoreWebView2 core)
        {
            string status = "null";
            for (int i = 0; i < 180; i++) // up to 90 s
            {
                await Task.Delay(500);
                // ExecuteScriptAsync returns JSON, so a JSON string comes back quoted.
                status = await core.ExecuteScriptAsync("JSON.stringify(window.lma2 || null)");
                if (status.Contains("\\\"ready\\\":true")) break;
            }
            // "ready" first turns true when the scene is up, before the creatures
            // arrive, and textures can still be loading: settle, then re-read.
            await Task.Delay(3000);
            status = await core.ExecuteScriptAsync("JSON.stringify(window.lma2 || null)");
            using (var png = File.Create(Path.Combine(testDir, "selftest.png")))
                await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, png);
            File.WriteAllText(Path.Combine(testDir, "status.json"),
                "{\"version\":" + Json(Embedded.Version) + ",\"lma2\":" + status + ",\"browser\":" + Json(core.Environment.BrowserVersionString) + "}");
            bool ok = status.Contains("\\\"ready\\\":true") && status.Contains("\\\"error\\\":null");
            SelfTestResult = ok ? 0 : 3;
            Saver.Exit();
        }

        private void OpenExternal(string uri)
        {
            if (kind != Kind.Window) return; // no browsers popping up from a running screensaver
            if (uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            {
                try { System.Diagnostics.Process.Start(uri); } catch (System.ComponentModel.Win32Exception) { }
            }
        }

        private static string Json(string s)
        {
            return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
        }

        // Input that reaches the form itself (black screens, or before the page loads).
        private bool Armed { get { return kind == Kind.Saver && (DateTime.UtcNow - shown).TotalSeconds > 1; } }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (kind != Kind.Saver) return;
            Point p = Cursor.Position;
            if (mouseOrigin == null) { mouseOrigin = p; return; }
            int dx = p.X - mouseOrigin.Value.X, dy = p.Y - mouseOrigin.Value.Y;
            if (Armed && dx * dx + dy * dy > 120 * 120) Saver.Exit("form: mouse moved");
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (Armed) Saver.Exit("form: mouse button");
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (Armed) Saver.Exit("form: key " + e.KeyCode);
        }
    }

    internal static class Native
    {
        public const uint WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_CLIPCHILDREN = 0x02000000;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SystemParametersInfo(uint action, uint param, IntPtr vparam, uint winIni);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool DeleteFile(string path);

        public const uint MOVEFILE_DELAY_UNTIL_REBOOT = 0x4;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool MoveFileEx(string existing, string replacement, uint flags);
    }
}
