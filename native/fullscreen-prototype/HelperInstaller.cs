using System;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Drawing;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// Per-user installer. Native messaging is restricted to the listed extension IDs.
internal static class HelperInstaller {
    const string StoreId = "dfbmennlapdcfamcdocebolgclgibmmn";
    const string HostName = "kr.aniseongu.icampus_fullscreen";
    const string StateKey = @"Software\IcampusPlus\Autoplay";
    static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"WhaleExtentions\IcampusFullscreenHost");
    static readonly string[] Names = { "Chrome", "Whale", "Edge", "Brave", "Vivaldi", "Chromium" };
    static readonly string[] NativeKeys = { @"Software\Google\Chrome\NativeMessagingHosts\", @"Software\Naver\Naver Whale\NativeMessagingHosts\", @"Software\Microsoft\Edge\NativeMessagingHosts\", @"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\", @"Software\Vivaldi\NativeMessagingHosts\", @"Software\Chromium\NativeMessagingHosts\" };
    static readonly string[] PolicyKeys = { @"Software\Policies\Google\Chrome\AutoplayAllowlist", @"Software\Policies\Naver\Naver Whale\AutoplayAllowlist", @"Software\Policies\Microsoft\Edge\AutoplayAllowlist", @"Software\Policies\BraveSoftware\Brave\AutoplayAllowlist", @"Software\Policies\Vivaldi\AutoplayAllowlist", @"Software\Policies\Chromium\AutoplayAllowlist" };
    static readonly string[] Sites = { "https://canvas.skku.edu", "https://lcms.skku.edu" };
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string ExtensionId = ReadExtensionId();
    static readonly PrivateFontCollection UiFonts = new PrivateFontCollection();

    static Font LoadUiFont() {
        using (var stream = typeof(HelperInstaller).Assembly.GetManifestResourceStream("Pretendard-Regular.subset.ttf")) {
            if (stream == null) return new Font("Malgun Gothic", 9F);
            var bytes = new byte[stream.Length];
            int position = 0; while (position < bytes.Length) { int read = stream.Read(bytes, position, bytes.Length - position); if (read == 0) throw new EndOfStreamException(); position += read; }
            IntPtr memory = Marshal.AllocCoTaskMem(bytes.Length);
            Marshal.Copy(bytes, 0, memory, bytes.Length);
            UiFonts.AddMemoryFont(memory, bytes.Length);
            // The private collection can refer to this memory for the process lifetime.
            return new Font(UiFonts.Families[0], 10F);
        }
    }

    static string ReadExtensionId() {
        string name = Path.GetFileNameWithoutExtension(Application.ExecutablePath);
        var match = Regex.Match(name, @"^IcampusPlusSetup-([a-p]{32})(?: \(\d+\))?$", RegexOptions.CultureInvariant);
        return match.Success ? match.Groups[1].Value : StoreId;
    }

    [STAThread] static void Main() {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(true);
        using (var form = new Form { Text = "아캠 플러스 보조 설정", ClientSize = new Size(520, 400), Font = LoadUiFont(), BackColor = ColorTranslator.FromHtml("#eef2f6"), ForeColor = ColorTranslator.FromHtml("#434343"), AutoScaleMode = AutoScaleMode.Font, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false }) {
            var label = new Label { Left = 20, Top = 18, Width = 480, Height = 25, Text = "사용할 브라우저와 필요한 설정을 골라 주세요." };
            var browsers = new ComboBox { Left = 20, Top = 52, Width = 480, DropDownStyle = ComboBoxStyle.DropDownList };
            browsers.Items.Add("브라우저를 골라 주세요"); browsers.Items.AddRange(Names); browsers.SelectedIndex = 0;
            var state = new Label { Left = 20, Top = 100, Width = 480, Height = 25, Text = "브라우저를 고르면 현재 설정을 보여 줘요." };
            var note = new Label { Left = 20, Top = 142, Width = 480, Height = 25, Text = "자동 재생을 바꾼 뒤에는 브라우저를 다시 열어 주세요." };
            var warning = new Label { Left = 20, Top = 170, Width = 480, Height = 25, Text = "브라우저에 ‘조직에서 관리’가 표시될 수 있어요." };
            form.Controls.AddRange(new Control[] { label, browsers, state, note, warning });
            Action refresh = () => { if (browsers.SelectedIndex > 0) state.Text = ReadState(browsers.SelectedIndex - 1); };
            browsers.SelectedIndexChanged += (sender, args) => refresh();
            AddButton(form, browsers, refresh, "전체화면 보조 설치", 20, 230, () => { InstallHost(browsers.SelectedIndex - 1); return "보조 프로그램을 연결했어요. 확장 설정에서 기능을 켜 주세요."; });
            AddButton(form, browsers, refresh, "전체화면 보조 연결 해제", 270, 230, () => { RemoveHost(browsers.SelectedIndex - 1); return "보조 프로그램 연결을 해제했어요."; });
            AddButton(form, browsers, refresh, "강의 자동 재생 허용", 20, 285, () => SetAutoplay(browsers.SelectedIndex - 1, true) ? "자동 재생을 허용했어요. 브라우저를 다시 열어 주세요." : "이미 자동 재생을 허용했어요.");
            AddButton(form, browsers, refresh, "자동 재생 설정 되돌리기", 270, 285, () => SetAutoplay(browsers.SelectedIndex - 1, false) ? "이 프로그램이 추가한 자동 재생 설정을 지웠어요. 브라우저를 다시 열어 주세요." : "이 프로그램이 추가한 설정이 없어요.");
            var licenses = new LinkLabel { Left = 20, Top = 350, Width = 200, Height = 24, Text = "오픈소스 라이선스" };
            licenses.LinkClicked += (sender, args) => ShowLicenses(form);
            form.Controls.Add(licenses);
            Application.Run(form);
        }
    }
    static void ShowLicenses(Form owner) {
        var text = new StringBuilder();
        foreach (string resource in new[] { "Pretendard.LICENSE", "MinHook.LICENSE" }) {
            using (var stream = typeof(HelperInstaller).Assembly.GetManifestResourceStream(resource))
            using (var reader = new StreamReader(stream, Encoding.UTF8)) text.AppendLine(reader.ReadToEnd()).AppendLine();
        }
        using (var dialog = new Form { Text = "오픈소스 라이선스", Width = 620, Height = 500, StartPosition = FormStartPosition.CenterParent }) {
            dialog.Controls.Add(new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, Text = text.ToString() });
            dialog.ShowDialog(owner);
        }
    }
    static void AddButton(Form form, ComboBox browsers, Action refresh, string text, int left, int top, Func<string> action) {
        var button = new Button { Text = text, Left = left, Top = top, Width = 220, Height = 36, Enabled = false };
        browsers.SelectedIndexChanged += (sender, args) => button.Enabled = browsers.SelectedIndex > 0;
        button.Click += (sender, args) => { try { string result = action(); refresh(); MessageBox.Show(form, result, "아캠 플러스"); }
            catch (System.Security.SecurityException) { MessageBox.Show(form, "브라우저 설정을 바꿀 권한이 없어요. 컴퓨터 관리자에게 확인해 주세요.", "아캠 플러스"); }
            catch (UnauthorizedAccessException) { MessageBox.Show(form, "브라우저 설정을 바꿀 권한이 없어요. 컴퓨터 관리자에게 확인해 주세요.", "아캠 플러스"); }
            catch (Exception e) { MessageBox.Show(form, "설정을 마치지 못했어요.\n" + e.Message, "아캠 플러스"); } };
        form.Controls.Add(button);
    }
    static string ReadState(int browser) {
        try {
            bool connected = false;
            using (var key = Registry.CurrentUser.OpenSubKey(NativeKeys[browser] + HostName)) {
                var path = key == null ? null : key.GetValue(null) as string;
                if (!String.IsNullOrEmpty(path) && path.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(path)) {
                    var manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path)); object value;
                    object hostPath;
                    if (manifest.TryGetValue("allowed_origins", out value) && manifest.TryGetValue("path", out hostPath) && File.Exists(hostPath as string) && File.Exists(Path.Combine(Path.GetDirectoryName((string)hostPath), "notice-hook.dll")))
                        foreach (object origin in (System.Collections.IEnumerable)value) if ((string)origin == "chrome-extension://" + ExtensionId + "/") connected = true;
                }
            }
            bool autoplay = true;
            using (var key = Registry.CurrentUser.OpenSubKey(PolicyKeys[browser])) {
                foreach (string site in Sites) {
                    bool found = false; if (key != null) foreach (string name in key.GetValueNames()) if (String.Equals(key.GetValue(name) as string, site, StringComparison.OrdinalIgnoreCase)) found = true;
                    if (!found) autoplay = false;
                }
            }
            return "보조 프로그램: " + (connected ? "연결됨" : "연결 안 됨") + "   자동 재생: " + (autoplay ? "허용됨" : "사용자 설정 없음");
        } catch { return "현재 설정을 확인하지 못했어요."; }
    }
    static void InstallHost(int browser) {
        string keyPath = NativeKeys[browser] + HostName;
        var origins = new HashSet<string>(StringComparer.Ordinal) { "chrome-extension://" + ExtensionId + "/" };
        using (var key = Registry.CurrentUser.OpenSubKey(keyPath)) {
            var existing = key == null ? null : key.GetValue(null) as string;
            if (!String.IsNullOrEmpty(existing)) {
                if (!existing.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("기존 보조 프로그램의 위치를 확인해 주세요.");
                if (File.Exists(existing)) {
                    var manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(existing));
                    object value; if (manifest.TryGetValue("allowed_origins", out value)) foreach (object origin in (System.Collections.IEnumerable)value) origins.Add((string)origin);
                }
            }
        }
        string dir = Path.Combine(Root, DateTime.UtcNow.ToString("yyyyMMddHHmmssfff")); Directory.CreateDirectory(dir);
        foreach (string name in new[] { "host.ps1", "host.cmd", "operate.ps1", "notice-hook.dll" }) {
            using (var input = typeof(HelperInstaller).Assembly.GetManifestResourceStream(name))
            using (var output = File.Create(Path.Combine(dir, name))) { if (input == null) throw new InvalidOperationException("설치 파일이 손상됐어요."); input.CopyTo(output); }
        }
        var result = new Dictionary<string, object> { { "name", HostName }, { "description", "아캠 플러스 전체화면 보조 프로그램" }, { "path", Path.Combine(dir, "host.cmd") }, { "type", "stdio" }, { "allowed_origins", new List<string>(origins) } };
        string path = Path.Combine(dir, "manifest.json"); File.WriteAllText(path, Json.Serialize(result), new UTF8Encoding(false));
        using (var key = Registry.CurrentUser.CreateSubKey(keyPath)) key.SetValue(null, path);
    }
    static void RemoveHost(int browser) {
        string path = NativeKeys[browser] + HostName;
        using (var key = Registry.CurrentUser.OpenSubKey(path)) {
            var existing = key == null ? null : key.GetValue(null) as string;
            if (String.IsNullOrEmpty(existing)) return;
            if (!existing.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("기존 보조 프로그램의 위치를 확인해 주세요.");
            if (File.Exists(existing)) {
                var manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(existing));
                object value;
                if (manifest.TryGetValue("allowed_origins", out value)) {
                    var remaining = new List<string>();
                    foreach (object origin in (System.Collections.IEnumerable)value) if ((string)origin != "chrome-extension://" + ExtensionId + "/") remaining.Add((string)origin);
                    if (remaining.Count > 0) { manifest["allowed_origins"] = remaining; File.WriteAllText(existing, Json.Serialize(manifest), new UTF8Encoding(false)); return; }
                }
            }
        }
        Registry.CurrentUser.DeleteSubKey(path, false);
    }
    static bool SetAutoplay(int browser, bool enable) {
        if (enable) {
            using (var read = Registry.CurrentUser.OpenSubKey(PolicyKeys[browser])) {
                bool allPresent = read != null;
                foreach (string site in Sites) {
                    bool found = false;
                    if (read != null) foreach (string name in read.GetValueNames()) if (String.Equals(read.GetValue(name) as string, site, StringComparison.OrdinalIgnoreCase)) found = true;
                    if (!found) allPresent = false;
                }
                if (allPresent) return false;
            }
        } else {
            using (var read = Registry.CurrentUser.OpenSubKey(StateKey + "\\" + Names[browser])) if (read == null) return false;
        }
        using (var state = Registry.CurrentUser.CreateSubKey(StateKey + "\\" + Names[browser]))
        using (var policy = Registry.CurrentUser.CreateSubKey(PolicyKeys[browser])) {
            foreach (string site in Sites) {
                string marker = site.EndsWith("canvas.skku.edu") ? "canvas" : "lcms";
                string slot = state.GetValue(marker) as string;
                if (!enable) {
                    if (slot != null && String.Equals(policy.GetValue(slot) as string, site, StringComparison.OrdinalIgnoreCase)) policy.DeleteValue(slot, false);
                    state.DeleteValue(marker, false); continue;
                }
                bool exists = false; foreach (string name in policy.GetValueNames()) if (String.Equals(policy.GetValue(name) as string, site, StringComparison.OrdinalIgnoreCase)) exists = true;
                if (exists) continue;
                int number = 1; while (policy.GetValue(number.ToString()) != null) number++;
                slot = number.ToString(); policy.SetValue(slot, site); state.SetValue(marker, slot);
            }
        }
        return true;
    }
}
