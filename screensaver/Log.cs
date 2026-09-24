// A small log at %LOCALAPPDATA%\LMA2Screensaver\log.txt: why a run ended,
// and any error. A screensaver must not pop up dialogs, so this is where
// failures in /s and /p go. Kept to the last ~200 KB.

using System;
using System.Diagnostics;
using System.IO;

namespace Lma2Saver
{
    internal static class Log
    {
        private static readonly object Gate = new object();
        private static string mode = "?";

        public static string FilePath
        {
            get { return Path.Combine(Embedded.DataDir, "log.txt"); }
        }

        public static void Start(string runMode, string[] args)
        {
            mode = runMode;
            Write("start " + string.Join(" ", args) + " | v" + Embedded.Version + " | pid " + Process.GetCurrentProcess().Id +
                  " | " + (Environment.Is64BitProcess ? "x64" : "x86") + " | " + Environment.OSVersion.VersionString);
        }

        public static void Write(string message)
        {
            try
            {
                lock (Gate)
                {
                    Directory.CreateDirectory(Embedded.DataDir);
                    var info = new FileInfo(FilePath);
                    if (info.Exists && info.Length > 200 * 1024)
                    {
                        string tail = File.ReadAllText(FilePath);
                        File.WriteAllText(FilePath, tail.Substring(tail.Length / 2));
                    }
                    File.AppendAllText(FilePath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + mode + "] " + message + Environment.NewLine);
                }
            }
            catch (Exception)
            {
                // Logging must never be the thing that breaks the screensaver.
            }
        }

        public static void Error(string where, Exception e)
        {
            Write("ERROR in " + where + ": " + e.GetType().Name + ": " + e.Message +
                  (e.InnerException != null ? " | inner: " + e.InnerException.Message : "") +
                  " | HRESULT 0x" + e.HResult.ToString("X8") + Environment.NewLine + e.StackTrace);
        }
    }
}
