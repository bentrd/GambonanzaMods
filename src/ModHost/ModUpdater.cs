using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using Gambonanza.ModSdk;
using UnityEngine;

namespace Gambonanza.ModHost
{
    internal sealed class ModUpdater : MonoBehaviour
    {
        /// <summary>
        /// Displayed framework version. Read from the install metadata that both
        /// build.sh and the Gambonanza Mod Manager write next to the DLLs, so it
        /// tracks the actual install instead of a constant that drifts (the old
        /// hardcoded value was still "1.0.0" when 1.1.0 shipped).
        /// </summary>
        public static string FrameworkVersion
        {
            get
            {
                if (_frameworkVersion == null)
                {
                    var meta = LoadMetadata();
                    _frameworkVersion = string.IsNullOrEmpty(meta?.version) ? FallbackFrameworkVersion : meta.version;
                }
                return _frameworkVersion;
            }
        }

        private const string FallbackFrameworkVersion = "1.1.0";
        private static string _frameworkVersion;

        private const string InstallFileName = "Gambonanza.ModHost.install.json";
        private static ModUpdater _instance;

        private readonly Queue<Action> _mainThread = new Queue<Action>();
        private ModConsole _console;
        private InstallMetadata _metadata;
        private bool _checking;

        public static void SpawnOnce(ModConsole console)
        {
            if (_instance != null)
            {
                _instance.Bind(console);
                return;
            }

            var go = new GameObject("__GambonanzaModUpdater");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideAndDontSave;
            _instance = go.AddComponent<ModUpdater>();
            _instance.Bind(console);
        }

        private void Bind(ModConsole console)
        {
            _console = console;
            _metadata = LoadMetadata();
            console.RegisterCommand("update", "update GambonanzaMods, reinstall framework, and restart the game", _ => BeginUpdate());
            console.RegisterCommand("update check", "check whether origin/main has a newer GambonanzaMods build", _ => BeginCheck(verbose: true));
            BeginCheck(verbose: false);
        }

        private void Update()
        {
            lock (_mainThread)
            {
                while (_mainThread.Count > 0)
                    _mainThread.Dequeue()?.Invoke();
            }
        }

        private void BeginCheck(bool verbose)
        {
            if (_checking) return;
            _checking = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    var status = CheckForUpdate();
                    Enqueue(() => ReportStatus(status, verbose));
                }
                catch (Exception ex)
                {
                    if (verbose) Enqueue(() => _console?.PrintWarn("update check failed: " + ex.Message));
                }
                finally
                {
                    Enqueue(() => _checking = false);
                }
            });
        }

        /// <summary>
        /// Installs made by the Gambonanza Mod Manager have no git checkout to pull
        /// from - the manager downloads released bundles instead. Tell the player to
        /// use it rather than printing a confusing "missing repoDir" error.
        /// </summary>
        private const string ManagerInstaller = "GambonanzaModManager";

        private bool ManagedByModManager =>
            _metadata != null &&
            string.Equals(_metadata.managedBy, ManagerInstaller, StringComparison.OrdinalIgnoreCase);

        private UpdateStatus CheckForUpdate()
        {
            if (ManagedByModManager)
                return new UpdateStatus { CanCheck = false, Message = "this install is managed by the Gambonanza Mod Manager - open it to update the framework and your mods." };
            if (_metadata == null || string.IsNullOrEmpty(_metadata.repoDir) || !Directory.Exists(_metadata.repoDir))
                return new UpdateStatus { CanCheck = false, Message = "install metadata missing repoDir; reinstall with ./build.sh first." };

            RunGit("fetch origin main", timeoutMs: 20000);
            var behindText = RunGit("rev-list --count HEAD..origin/main", timeoutMs: 10000).Trim();
            int.TryParse(behindText, out var behind);
            var remote = RunGit("rev-parse --short origin/main", timeoutMs: 10000).Trim();
            var local = RunGit("rev-parse --short HEAD", timeoutMs: 10000).Trim();
            return new UpdateStatus { CanCheck = true, Behind = behind, Local = local, Remote = remote };
        }

        private void ReportStatus(UpdateStatus status, bool verbose)
        {
            if (status == null) return;
            if (!status.CanCheck)
            {
                if (verbose) _console?.PrintWarn(status.Message);
                return;
            }

            if (status.Behind > 0)
            {
                _console?.PrintRich("<size=34><color=#ffcf5f>╔════════════════════════════════════════════════════╗</color></size>");
                _console?.PrintRich("<size=34><color=#ffcf5f>║  GAMBONANZAMODS UPDATE AVAILABLE                  ║</color></size>");
                _console?.PrintRich("<size=26><color=#f4b35e>origin/main is " + status.Behind + " commit(s) ahead (" + status.Local + " → " + status.Remote + ").</color></size>");
                _console?.PrintRich("<size=28><color=#b8ff5f>Type </color><color=#ffd36b>update</color><color=#b8ff5f> to pull, reinstall, and restart the game.</color></size>");
                _console?.PrintRich("<size=34><color=#ffcf5f>╚════════════════════════════════════════════════════╝</color></size>");
            }
            else if (verbose)
            {
                _console?.PrintInfo("GambonanzaMods is up to date (" + status.Local + ", v" + FrameworkVersion + ").");
            }
        }

        private void BeginUpdate()
        {
            if (ManagedByModManager)
            {
                _console?.PrintWarn("this install is managed by the Gambonanza Mod Manager - quit the game and hit Update there.");
                return;
            }
            if (_metadata == null || string.IsNullOrEmpty(_metadata.repoDir) || !Directory.Exists(_metadata.repoDir))
            {
                _console?.PrintWarn("cannot update: install metadata missing repoDir. Reinstall manually with ./build.sh first.");
                return;
            }

            var script = WriteUpdaterScript();
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    Arguments = Quote(script),
                    UseShellExecute = false,
                });
                _console?.PrintRich("<color=#b8ff5f>Updater launched. Gambonanza will quit; the updater will pull origin/main, reinstall, then reopen the game.</color>");
                StartCoroutine(QuitSoon());
            }
            catch (Exception ex)
            {
                _console?.PrintWarn("failed to launch updater: " + ex.Message);
            }
        }

        private IEnumerator QuitSoon()
        {
            yield return new WaitForSecondsRealtime(0.8f);
            Application.Quit();
        }

        private string WriteUpdaterScript()
        {
            var repo = _metadata.repoDir;
            var game = string.IsNullOrEmpty(_metadata.gameDir) ? GuessGameDir() : _metadata.gameDir;
            var appId = string.IsNullOrEmpty(_metadata.appId) ? "3509230" : _metadata.appId;
            var log = Path.Combine(Path.GetTempPath(), "gambonanza-mods-update.log");
            var script = Path.Combine(Path.GetTempPath(), "gambonanza-mods-update.sh");

            var sb = new StringBuilder();
            sb.AppendLine("#!/bin/bash");
            sb.AppendLine("set -euo pipefail");
            sb.AppendLine("repo=" + BashQuote(repo));
            sb.AppendLine("game=" + BashQuote(game));
            sb.AppendLine("appid=" + BashQuote(appId));
            sb.AppendLine("log=" + BashQuote(log));
            sb.AppendLine("exec > >(tee -a \"$log\") 2>&1");
            sb.AppendLine("echo '==> GambonanzaMods updater started: '$(date)");
            sb.AppendLine("for i in {1..80}; do pgrep -f 'Gambonanza.app|Gambonanza_Data|Gambonanza$' >/dev/null 2>&1 || break; sleep 0.5; done");
            sb.AppendLine("cd \"$repo\"");
            sb.AppendLine("git fetch origin main");
            sb.AppendLine("git pull --ff-only origin main");
            sb.AppendLine("./build.sh --skip-samples");
            sb.AppendLine("./sample_mods/build.sh --install");
            sb.AppendLine("if command -v open >/dev/null 2>&1; then");
            sb.AppendLine("  open \"steam://rungameid/$appid\" || open \"$game/Gambonanza.app\" || true");
            sb.AppendLine("fi");
            sb.AppendLine("echo '==> GambonanzaMods updater finished: '$(date)");
            File.WriteAllText(script, sb.ToString());
            try { Process.Start("/bin/chmod", "+x " + Quote(script)); } catch { }
            return script;
        }

        private string RunGit(string args, int timeoutMs)
        {
            return Run("git", "-C " + Quote(_metadata.repoDir) + " " + args, timeoutMs);
        }

        private static string Run(string fileName, string args, int timeoutMs)
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = args,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (var p = Process.Start(psi))
            {
                if (p == null) throw new InvalidOperationException("could not start " + fileName);
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    throw new TimeoutException(fileName + " " + args + " timed out");
                }
                var stdout = p.StandardOutput.ReadToEnd();
                var stderr = p.StandardError.ReadToEnd();
                if (p.ExitCode != 0) throw new InvalidOperationException((stderr.Length > 0 ? stderr : stdout).Trim());
                return stdout;
            }
        }

        private void Enqueue(Action action)
        {
            lock (_mainThread) _mainThread.Enqueue(action);
        }

        private static InstallMetadata LoadMetadata()
        {
            try
            {
                var managed = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                var path = Path.Combine(managed ?? "", InstallFileName);
                if (!File.Exists(path)) return null;
                return JsonUtility.FromJson<InstallMetadata>(File.ReadAllText(path));
            }
            catch { return null; }
        }

        private static string GuessGameDir()
        {
            try
            {
                var managed = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                var app = managed;
                for (int i = 0; i < 5 && !string.IsNullOrEmpty(app); i++) app = Path.GetDirectoryName(app);
                return Path.GetDirectoryName(app ?? "") ?? "";
            }
            catch { return ""; }
        }

        private static string Quote(string value) => "\"" + (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        private static string BashQuote(string value) => "'" + (value ?? "").Replace("'", "'\\''") + "'";

        [Serializable]
        private sealed class InstallMetadata
        {
            public string version = null;
            public string commit = null;
            public string repoDir = null;
            public string gameDir = null;
            public string appId = null;
            /// <summary>Which installer wrote this file, e.g. "GambonanzaModManager".</summary>
            public string managedBy = null;
        }

        private sealed class UpdateStatus
        {
            public bool CanCheck;
            public int Behind;
            public string Local;
            public string Remote;
            public string Message;
        }
    }
}
