// Everything the screensaver needs travels inside the single .scr file:
//   site.zip                         the built site (index.html, dist/, assets/)
//   Microsoft.Web.WebView2.*.dll     the WebView2 .NET wrappers (loaded from memory)
//   WebView2Loader.<arch>.dll        the native loader, per CPU architecture
// On first run of each version, site.zip and the loader are unpacked to
// %LOCALAPPDATA%\LMA2Screensaver\<version>\; older versions are removed.

using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;

namespace Lma2Saver
{
    internal static class Embedded
    {
        public static readonly string Version = typeof(Embedded).Assembly.GetName().Version.ToString();

        public static string DataDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LMA2Screensaver"); }
        }

        /// <summary>WebView2's profile (localStorage keeps the scene rotation between runs).</summary>
        public static string ProfileDir
        {
            get { return Path.Combine(DataDir, "profile"); }
        }

        private static byte[] Read(string name)
        {
            using (Stream s = typeof(Embedded).Assembly.GetManifestResourceStream(name))
            {
                if (s == null) return null;
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }

        public static Assembly Resolve(object sender, ResolveEventArgs e)
        {
            string name = new AssemblyName(e.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            byte[] bytes = Read(name + ".dll");
            return bytes == null ? null : Assembly.Load(bytes);
        }

        /// <summary>Unpack this version's site and loader (once); returns the version folder.</summary>
        public static string EnsureExtracted()
        {
            string dir = Path.Combine(DataDir, Version);
            string marker = Path.Combine(dir, ".complete");
            if (File.Exists(marker)) return dir;

            Directory.CreateDirectory(DataDir);
            if (Directory.Exists(dir)) Directory.Delete(dir, true); // an earlier run was interrupted
            string tmp = dir + ".tmp-" + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(tmp);
            using (Stream s = typeof(Embedded).Assembly.GetManifestResourceStream("site.zip"))
            {
                if (s == null) throw new InvalidOperationException("site.zip is not embedded in this build.");
                using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
                    zip.ExtractToDirectory(Path.Combine(tmp, "site"));
            }
            byte[] loader = Read("WebView2Loader." + Arch() + ".dll");
            if (loader == null) throw new InvalidOperationException("No WebView2 loader for " + Arch() + ".");
            File.WriteAllBytes(Path.Combine(tmp, "WebView2Loader.dll"), loader);
            File.WriteAllText(Path.Combine(tmp, ".complete"), Version);
            Directory.Move(tmp, dir);

            // Remove other versions (and leftovers), but never the WebView2 profile.
            foreach (string d in Directory.GetDirectories(DataDir))
            {
                if (string.Equals(d, dir, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(d, ProfileDir, StringComparison.OrdinalIgnoreCase)) continue;
                try { Directory.Delete(d, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
            return dir;
        }

        private static string Arch()
        {
            // PROCESSOR_ARCHITECTURE is the architecture this process runs as
            // (an x64 process under ARM64 emulation reports AMD64).
            string a = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").ToUpperInvariant();
            if (a == "ARM64") return "arm64";
            return Environment.Is64BitProcess ? "x64" : "x86";
        }
    }
}
