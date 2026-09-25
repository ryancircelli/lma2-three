// Screensaver settings, per user, in HKCU\Software\LMA2Screensaver. They map
// onto the site's own URL parameters.

using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.Win32;

namespace Lma2Saver
{
    internal sealed class Settings
    {
        private const string Key = @"Software\LMA2Screensaver";

        public string Scene = "rotate"; // rotate | 1 | 2 | 3 (rotate: next scene each run, as the original)
        public string Aspect = "fit";   // fit | fill | stretch
        public bool Sound = true;       // the original's ambient loop (primary monitor only)
        public int Volume = 100;        // 0..100, 100 = the original's own level (the page's slider scale)
        public string Speed = "1";      // 0.5 .. 4
        // installed: the original's default tank (17)
        // complete:  that tank with at least one of every species (25, the default)
        // all:       one of every species (19)
        public string Tank = "complete";
        public bool Schooling = true;
        public bool AllMonitors = true; // false: black on the other monitors

        public static Settings Load()
        {
            var s = new Settings();
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(Key))
            {
                if (k == null) return s;
                s.Scene = Str(k, "Scene", s.Scene, "rotate", "1", "2", "3");
                s.Aspect = Str(k, "Aspect", s.Aspect, "fit", "fill", "stretch");
                s.Sound = Flag(k, "Sound", s.Sound);
                object v = k.GetValue("Volume");
                if (v is int) s.Volume = Math.Min(100, Math.Max(0, (int)v));
                s.Speed = Str(k, "Speed", s.Speed, "0.5", "1", "1.5", "2", "3", "4");
                s.Tank = Str(k, "Tank", s.Tank, "installed", "complete", "all");
                s.Schooling = Flag(k, "Schooling", s.Schooling);
                s.AllMonitors = Flag(k, "AllMonitors", s.AllMonitors);
            }
            return s;
        }

        public void Save()
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Key))
            {
                k.SetValue("Scene", Scene);
                k.SetValue("Aspect", Aspect);
                k.SetValue("Sound", Sound ? 1 : 0, RegistryValueKind.DWord);
                k.SetValue("Volume", Volume, RegistryValueKind.DWord);
                k.SetValue("Speed", Speed);
                k.SetValue("Tank", Tank);
                k.SetValue("Schooling", Schooling ? 1 : 0, RegistryValueKind.DWord);
                k.SetValue("AllMonitors", AllMonitors ? 1 : 0, RegistryValueKind.DWord);
            }
        }

        /// <summary>The page URL's query string for one screen.</summary>
        public string Query(bool withSound, bool preview)
        {
            var q = new List<string> { "saver=1", "aspect=" + Aspect };
            // A preview must not advance the scene rotation.
            if (Scene != "rotate") q.Add("scene=" + Scene);
            else if (preview) q.Add("scene=1");
            if (!Sound || !withSound || Volume == 0) q.Add("sound=0");
            // The page's slider is a squared curve: gain = (percent/100)^2, so dB = 40*log10(percent/100).
            else if (Volume < 100) q.Add("volume=" + (40 * Math.Log10(Volume / 100.0)).ToString("0.##", CultureInfo.InvariantCulture));
            if (Speed != "1") q.Add("speed=" + Speed);
            if (Tank == "all") q.Add("all=1");
            else if (Tank == "complete") q.Add("all=fill");
            if (!Schooling) q.Add("school=0");
            return "?" + string.Join("&", q);
        }

        private static string Str(RegistryKey k, string name, string fallback, params string[] allowed)
        {
            string v = k.GetValue(name) as string;
            return v != null && System.Array.IndexOf(allowed, v) >= 0 ? v : fallback;
        }

        private static bool Flag(RegistryKey k, string name, bool fallback)
        {
            object v = k.GetValue(name);
            return v is int ? (int)v != 0 : fallback;
        }
    }
}
