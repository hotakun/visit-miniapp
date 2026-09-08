// 聚火拜访 · 无边框壳程序（WebView2 自绘窗口，2026-09-06）
// 功能：无边框窗体 + 顶部拖动条 + 自绘最小化/关闭按钮 + 内置启动 server.js + 读 current-port.txt 加载页面
// 编译：csc /target:winexe /platform:x64 /win32icon:icon.ico /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Drawing.Text;
using Microsoft.Web.WebView2.WinForms;

public class ShellForm : Form
{
    private WebView2 wv;
    private Process nodeProc;
    private Panel titleBar;
    private Rectangle savedBounds = Rectangle.Empty;
    private bool isCustomMax = false;
    private Button btnBell, btnSet, btnMax, btnMin, btnClose;
    private Panel pnlRefresh; // 2026-09-08 老板定：标题栏铃铛左侧自绘刷新图标（点击旋转动画）
    private Timer refreshSpinTimer;
    private int spinAngle = 0;
    private bool refreshHover = false;
    private Button btnFloatClose;
    private Label lblBadge;
    private Font badgeFont;
    private PrivateFontCollection badgePfc;
    private bool dragging = false;
    private Point dragStart;
    private float uiScale = 1f; // 当前屏 DPI 缩放（标题栏/按钮物理尺寸按此放大，高 DPI 屏观感一致）

    public ShellForm()
    {
        Text = "聚火拜访 · 管理后台";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        // 初始尺寸/位置（2026-09-08 定稿）：工作区百分比 + 手动居中。
        // 自适应任何分辨率/DPI 缩放（老板 2560×1440@225%、文员 2880×1800@200%），永不盖任务栏；
        // 不用 CenterScreen（无边框+大窗在部分系统上会偏移到屏幕角落）。
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        int w0 = Math.Min(wa.Width - 40, Math.Max((int)(wa.Width * 0.96), 800));
        int h0 = Math.Min(wa.Height - 40, Math.Max((int)(wa.Height * 0.92), 560));
        Size = new Size(w0, h0);
        MinimumSize = new Size(Math.Min(900, Math.Max(wa.Width - 80, 800)), Math.Min(600, Math.Max(wa.Height - 80, 520)));
        Location = new Point(wa.X + (wa.Width - w0) / 2, wa.Y + (wa.Height - h0) / 2);
        BackColor = Color.FromArgb(26, 28, 34);
        // 标题栏物理尺寸按屏幕 DPI 缩放（2026-09-08：2880×1800@200% 屏上 44px 标题栏太矮，按比例放大）
        try { using (Graphics g = CreateGraphics()) { uiScale = Math.Max(g.DpiX, g.DpiY) / 96f; } } catch { }
        if (uiScale < 1f || uiScale > 4f) uiScale = 1f;

        // 内容根容器
        Panel rootPanel = new Panel();
        rootPanel.Dock = DockStyle.Fill;

        // 顶部自绘标题条（2026-09-07 老板改稿）：
        // 高 44px，横向渐变 左深橙 #D93B1B → 右红橙 #F0502E；左侧仅白色圆润胶囊「管理后台」（微软雅黑深橙字）
        titleBar = new Panel();
        titleBar.Dock = DockStyle.Top;
        titleBar.Height = (int)(44 * uiScale);
        titleBar.BackColor = Color.FromArgb(217, 59, 27);
        titleBar.Cursor = Cursors.SizeAll;
        titleBar.Paint += delegate(object s, PaintEventArgs pe)
        {
            Rectangle rc = titleBar.ClientRectangle;
            using (System.Drawing.Drawing2D.LinearGradientBrush br = new System.Drawing.Drawing2D.LinearGradientBrush(
                rc, Color.FromArgb(217, 59, 27), Color.FromArgb(240, 80, 46), 0f))
            {
                pe.Graphics.FillRectangle(br, rc);
            }
            // 左侧玻璃胶囊底（2026-09-07 重新设计）：半透明白底 + 细白描边 + 全圆角，抗锯齿
            if (lblBadge != null && lblBadge.Visible)
            {
                pe.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                pe.Graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                Rectangle brc = new Rectangle(lblBadge.Left - (int)(14 * uiScale), lblBadge.Top - (int)(3 * uiScale), lblBadge.Width + (int)(28 * uiScale), (int)(26 * uiScale));
                int r = (int)(13 * uiScale);
                using (System.Drawing.Drawing2D.GraphicsPath gp = new System.Drawing.Drawing2D.GraphicsPath())
                {
                    gp.AddArc(brc.X, brc.Y, r * 2, r * 2, 180, 90);
                    gp.AddArc(brc.Right - r * 2, brc.Y, r * 2, r * 2, 270, 90);
                    gp.AddArc(brc.Right - r * 2, brc.Bottom - r * 2, r * 2, r * 2, 0, 90);
                    gp.AddArc(brc.X, brc.Bottom - r * 2, r * 2, r * 2, 90, 90);
                    gp.CloseFigure();
                    using (SolidBrush bb = new SolidBrush(Color.FromArgb(30, 255, 255, 255)))
                    {
                        pe.Graphics.FillPath(bb, gp);
                    }
                    using (Pen pn = new Pen(Color.FromArgb(115, 255, 255, 255)))
                    {
                        pe.Graphics.DrawPath(pn, gp);
                    }
                }
            }
        };

        // 胶囊标签「管理后台」：优先阿里巴巴普惠体（内嵌 TTF，随包分发），缺失回退微软雅黑
        LoadBadgeFont();
        lblBadge = new Label();
        lblBadge.Text = "管理后台";
        lblBadge.ForeColor = Color.White;
        lblBadge.Font = badgeFont;
        lblBadge.BackColor = Color.Transparent;
        lblBadge.AutoSize = false;
        lblBadge.TextAlign = ContentAlignment.MiddleCenter;
        Size badgeSize = TextRenderer.MeasureText("管理后台", lblBadge.Font);
        lblBadge.Width = badgeSize.Width + (int)(2 * uiScale);
        lblBadge.Height = (int)(22 * uiScale);
        lblBadge.MouseDown += TitleMouseDown;
        lblBadge.MouseMove += TitleMouseMove;
        lblBadge.MouseUp += TitleMouseUp;
        lblBadge.MouseDoubleClick += TitleDoubleClick;

        // 右侧白色图标排（Segoe MDL2 Assets）：通知/刷新/设置/全屏/最小化/关闭（2026-09-08 加刷新，铃铛左侧）
        btnBell = MakeBtn("\uE7ED", "显示/隐藏消息铃铛（不影响通知）");
        btnBell.Click += delegate
        {
            try { if (wv != null && wv.CoreWebView2 != null) wv.CoreWebView2.PostWebMessageAsString("toggle-bell"); } catch { }
        };
        // 自绘刷新图标：点击立即刷新当前页，图标旋转一圈反馈
        pnlRefresh = new Panel();
        pnlRefresh.Size = new Size((int)(40 * uiScale), titleBar.Height);
        pnlRefresh.BackColor = Color.Transparent;
        pnlRefresh.Cursor = Cursors.Hand;
        pnlRefresh.TabStop = false;
        pnlRefresh.Paint += delegate(object ps, PaintEventArgs pe)
        {
            Graphics g = pe.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            if (refreshHover)
            {
                using (SolidBrush hb = new SolidBrush(Color.FromArgb(70, 255, 255, 255)))
                { g.FillRectangle(hb, 0, 0, pnlRefresh.Width, pnlRefresh.Height); }
            }
            using (Font f = new Font("Segoe MDL2 Assets", 10.5f))
            {
                SizeF sz = g.MeasureString("\uE72C", f);
                g.TranslateTransform(pnlRefresh.Width / 2f, pnlRefresh.Height / 2f);
                g.RotateTransform(spinAngle);
                using (SolidBrush wb = new SolidBrush(Color.White))
                { g.DrawString("\uE72C", f, wb, -sz.Width / 2f, -sz.Height / 2f); }
                g.ResetTransform();
            }
        };
        pnlRefresh.MouseEnter += delegate { refreshHover = true; pnlRefresh.Invalidate(); };
        pnlRefresh.MouseLeave += delegate { refreshHover = false; pnlRefresh.Invalidate(); };
        pnlRefresh.Click += delegate
        {
            try { if (wv != null && wv.CoreWebView2 != null) wv.CoreWebView2.PostWebMessageAsString("manual-refresh"); } catch { }
            // 旋转一圈（24° × 15 帧 ≈ 600ms）
            if (refreshSpinTimer == null)
            {
                refreshSpinTimer = new Timer();
                refreshSpinTimer.Interval = 40;
                refreshSpinTimer.Tick += delegate
                {
                    spinAngle += 24;
                    if (spinAngle >= 360)
                    {
                        spinAngle = 0;
                        refreshSpinTimer.Stop();
                    }
                    pnlRefresh.Invalidate();
                };
            }
            refreshSpinTimer.Stop();
            spinAngle = 0;
            refreshSpinTimer.Start();
        };
        ToolTip refreshTip = new ToolTip();
        refreshTip.SetToolTip(pnlRefresh, "刷新当前页（点一下立即刷新数据）");
        btnSet = MakeBtn("\uE713", "设置");
        btnMax = MakeBtn("\uE740", "全屏切换");
        btnMin = MakeBtn("\uE921", "最小化");
        btnClose = MakeBtn("\uE8BB", "关闭");
        titleBar.Controls.Add(lblBadge);
        titleBar.Controls.Add(btnBell);
        titleBar.Controls.Add(pnlRefresh);
        titleBar.Controls.Add(btnSet);
        titleBar.Controls.Add(btnMax);
        titleBar.Controls.Add(btnMin);
        titleBar.Controls.Add(btnClose);

        btnMin.Click += delegate { WindowState = FormWindowState.Minimized; };
        btnMax.Click += delegate { ToggleMaximize(); };
        btnClose.Click += delegate { AskClose(); };
        btnClose.FlatAppearance.MouseOverBackColor = Color.FromArgb(232, 17, 35);
        btnClose.FlatAppearance.MouseDownBackColor = Color.FromArgb(190, 10, 25);
        Color hover = Color.FromArgb(70, 255, 255, 255);
        Color down = Color.FromArgb(110, 255, 255, 255);
        Button[] deco = { btnBell, btnSet, btnMax, btnMin };
        foreach (Button b in deco)
        {
            b.FlatAppearance.MouseOverBackColor = hover;
            b.FlatAppearance.MouseDownBackColor = down;
        }

        titleBar.MouseDown += TitleMouseDown;
        titleBar.MouseMove += TitleMouseMove;
        titleBar.MouseUp += TitleMouseUp;
        titleBar.MouseDoubleClick += TitleDoubleClick;

        wv = new WebView2();
        wv.Dock = DockStyle.Fill;
        rootPanel.Controls.Add(wv);          // 先加 Fill
        rootPanel.Controls.Add(titleBar);    // 后加 Top：titleBar 占顶部，WebView 填剩余
        Controls.Add(rootPanel);
        titleBar.Visible = false;  // 登录页期间隐藏标题条（2026-09-06 老板定：登录进入后台后才显示）

        // 登录页期间右上角悬浮关闭按钮（半透明、悬停变红）——否则无边框窗口无法关闭
        btnFloatClose = new Button();
        btnFloatClose.Text = "\uE8BB";
        btnFloatClose.Size = new Size((int)(44 * uiScale), (int)(36 * uiScale));
        btnFloatClose.FlatStyle = FlatStyle.Flat;
        btnFloatClose.FlatAppearance.BorderSize = 0;
        btnFloatClose.ForeColor = Color.White;
        btnFloatClose.BackColor = Color.FromArgb(120, 30, 30, 30);
        btnFloatClose.FlatAppearance.MouseOverBackColor = Color.FromArgb(232, 17, 35);
        btnFloatClose.FlatAppearance.MouseDownBackColor = Color.FromArgb(190, 10, 25);
        btnFloatClose.Font = new Font("Segoe MDL2 Assets", 9.5f);
        btnFloatClose.Cursor = Cursors.Hand;
        btnFloatClose.TabStop = false;
        btnFloatClose.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        btnFloatClose.Location = new Point(ClientSize.Width - (int)(44 * uiScale), 0);
        btnFloatClose.Click += delegate { AskClose(); };
        Controls.Add(btnFloatClose); // 悬浮于 WebView 之上
        btnFloatClose.BringToFront();

        Resize += delegate { PositionTitleItems(); btnFloatClose.Location = new Point(ClientSize.Width - (int)(44 * uiScale), 0); };
        PositionTitleItems();      // 初始布局（品牌名/胶囊/图标位）

        Load += ShellLoad;
        FormClosed += ShellClosed;
    }

    // 窗体阴影（2026-09-07 老板定：最简单稳定方案——CS_DROPSHADOW 让系统画淡阴影）
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
            return cp;
        }
    }

    // 加载胶囊字体：阿里巴巴普惠体 55 Regular（内嵌 TTF 随包分发）；缺失回退微软雅黑
    private void LoadBadgeFont()
    {
        try
        {
            string fp = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "AlibabaPuHuiTi-3-55-Regular.ttf");
            if (File.Exists(fp))
            {
                badgePfc = new PrivateFontCollection();
                badgePfc.AddFontFile(fp);
                badgeFont = new Font(badgePfc.Families[0], 10.5f, FontStyle.Regular);
                return;
            }
        }
        catch { /* 加载失败回退 */ }
        badgeFont = new Font("Microsoft YaHei", 10.5f, FontStyle.Regular);
    }

    private Button MakeBtn(string glyph, string tip)
    {
        Button b = new Button();
        b.Text = glyph;
        b.Size = new Size((int)(40 * uiScale), titleBar.Height);
        b.FlatStyle = FlatStyle.Flat;
        b.FlatAppearance.BorderSize = 0;
        b.ForeColor = Color.White;
        b.BackColor = Color.Transparent;
        b.Font = new Font("Segoe MDL2 Assets", 10.5f);
        b.Cursor = Cursors.Hand;
        b.TabStop = false;
        b.Padding = new Padding(0, 0, 0, 2);
        ToolTip tipCtl = new ToolTip();
        tipCtl.SetToolTip(b, tip);
        return b;
    }

    private void PositionTitleItems()
    {
        // 右侧从右到左：关闭/最小化/全屏/设置/通知/刷新（刷新在铃铛左侧）
        int w = titleBar.ClientSize.Width;
        Control[] right = { btnClose, btnMin, btnMax, btnSet, btnBell, pnlRefresh };
        int x = w;
        foreach (Control b in right)
        {
            x -= b.Width;
            b.Location = new Point(x, 0);
        }
        lblBadge.Location = new Point((int)(40 * uiScale), (int)(11 * uiScale));
        lblBadge.BringToFront();
    }

    private void TitleMouseDown(object sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        // 最大化状态下拖动标题条：先还原再拖动（与普通窗口一致）
        if (isCustomMax) ToggleMaximize();
        dragging = true;
        dragStart = e.Location;
    }

    private void TitleMouseMove(object sender, MouseEventArgs e)
    {
        if (!dragging) return;
        Location = new Point(Location.X + e.X - dragStart.X, Location.Y + e.Y - dragStart.Y);
    }

    private void TitleMouseUp(object sender, MouseEventArgs e)
    {
        dragging = false;
    }

    private void TitleDoubleClick(object sender, MouseEventArgs e)
    {
        ToggleMaximize();
    }

    // 自定义最大化（2026-09-07 老板定）：铺满当前屏幕工作区，任务栏不被覆盖；
    // 不用 WindowState.Maximized（无边框窗体下会盖住任务栏）
    private void ToggleMaximize()
    {
        if (isCustomMax)
        {
            Bounds = savedBounds;
            isCustomMax = false;
        }
        else
        {
            savedBounds = Bounds;
            Bounds = Screen.FromControl(this).WorkingArea;
            isCustomMax = true;
        }
    }

    private async void ShellLoad(object sender, EventArgs e)
    {
        Log("LOAD EVENT, wv=" + (wv != null));
        try
        {
            Log("CREATE ENV start");
            // 每实例独立的临时数据目录：旧实例残留进程不会锁新实例（防初始化挂起）
            string userData = Path.Combine(Path.GetTempPath(), "JuHuoVisitWV", Process.GetCurrentProcess().Id.ToString());
            Microsoft.Web.WebView2.Core.CoreWebView2Environment env =
                await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, userData, null);
            Log("CREATE ENV ok, ensuring ...");
            await wv.EnsureCoreWebView2Async(env);
            Log("ENSURE ok");
            // 2026-09-08 文员反馈：禁用网页右键菜单（另存为/刷新等）与浏览器快捷键（F5/Ctrl+R 刷新回登录页）；
            // 页面内编辑类快捷键（Ctrl+C/V）不受影响，后台刷新走标题栏「刷新」图标（页内刷新数据，不掉登录）
            try
            {
                wv.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                wv.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            }
            catch (Exception ex) { Log("SETTINGS FAIL: " + ex.Message); }
            // 监听页面消息：登录成功 → 显示标题条、隐藏悬浮关闭按钮（2026-09-06 老板定）
            wv.CoreWebView2.WebMessageReceived += delegate(object s, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs ev)
            {
                string msg = "";
                try { msg = ev.TryGetWebMessageAsString(); } catch { }
                Log("WEB MSG: " + msg);
                if (msg == "logged-in")
                {
                    titleBar.Visible = true;
                    btnFloatClose.Visible = false;
                    PositionTitleItems();
                }
                else if (msg == "logged-out")
                {
                    titleBar.Visible = false;
                    btnFloatClose.Visible = true;
                    btnFloatClose.Location = new Point(ClientSize.Width - (int)(44 * uiScale), 0);
                    btnFloatClose.BringToFront();
                }
                else if (msg == "bell-hidden")
                {
                    btnBell.ForeColor = Color.FromArgb(140, 255, 255, 255); // 铃铛已隐藏：图标半透明
                }
                else if (msg == "bell-visible")
                {
                    btnBell.ForeColor = Color.White; // 铃铛可见：图标恢复
                }
            };
            StartServerAndNavigate();
            Log("START SERVER CALLED");
        }
        catch (Exception ex)
        {
            Log("WEBVIEW INIT FAIL: " + ex);
            MessageBox.Show("WebView2 Runtime not found or failed to init.\n" + ex.Message +
                "\n\nPlease install WebView2 Runtime from:\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703",
                "JuHuo Visit", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Application.Exit();
        }
    }

    public static void Log(string msg)
    {
        try
        {
            File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "shell.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + "\r\n");
        }
        catch { }
    }

    private void StartServerAndNavigate()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        // 优先用环境包的绿色 Node（..\env\node\node.exe），没有则用系统 node
        string node = Path.Combine(dir, "..", "env", "node", "node.exe");
        if (!File.Exists(node)) node = "node";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = "server.js --port=8581 --no-browser";
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            nodeProc = Process.Start(psi);
            Log("NODE SPAWNED pid=" + nodeProc.Id);
            nodeProc.OutputDataReceived += delegate(object s, DataReceivedEventArgs ev)
            {
                if (ev.Data != null && ev.Data.Length > 0) Log("NODE OUT: " + ev.Data);
            };
            nodeProc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs ev)
            {
                if (ev.Data != null && ev.Data.Length > 0) Log("NODE ERR: " + ev.Data);
            };
            nodeProc.BeginOutputReadLine();
            nodeProc.BeginErrorReadLine();
            nodeProc.EnableRaisingEvents = true;
            nodeProc.Exited += delegate(object s, EventArgs ev)
            {
                Log("NODE EXITED code=" + nodeProc.ExitCode);
            };
        }
        catch (Exception ex)
        {
            Log("START SERVER FAIL: " + ex);
            MessageBox.Show("Failed to start server.js (node not found?).\n" +
                "Please run the Environment Setup package first.",
                "JuHuo Visit", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Timer timer = new Timer();
        timer.Interval = 300;
        int tries = 0;
        timer.Tick += delegate(object s, EventArgs ev)
        {
            tries++;
            string pf = Path.Combine(dir, "current-port.txt");
            if (File.Exists(pf))
            {
                int port = 0;
                string content = "";
                try { content = File.ReadAllText(pf).Trim(); } catch { }
                if (int.TryParse(content, out port) && port > 0)
                {
                    timer.Stop();
                    try { wv.Source = new Uri("http://localhost:" + port + "/"); } catch { }
                    return;
                }
            }
            if (tries > 60) timer.Stop(); // 约 18 秒超时，页面留空
        };
        timer.Start();
    }

    // 关闭前确认（2026-09-07 老板定：朴素系统弹窗，一句话）
    private void AskClose()
    {
        DialogResult dr = MessageBox.Show(this, "确定要退出聚火拜访后台吗？", "聚火拜访", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
        if (dr == DialogResult.OK) CloseApp();
    }

    private bool closing = false;
    private void CloseApp()
    {
        if (closing) return;
        closing = true;
        try
        {
            if (nodeProc != null && !nodeProc.HasExited)
            {
                nodeProc.Kill();
                nodeProc.WaitForExit(2000);
            }
        }
        catch { }
        try { if (wv != null) wv.Dispose(); } catch { } // 优雅释放 WebView2，避免残留进程
        try
        {
            string userData = Path.Combine(Path.GetTempPath(), "JuHuoVisitWV", Process.GetCurrentProcess().Id.ToString());
            if (Directory.Exists(userData)) Directory.Delete(userData, true);
        }
        catch { /* 子进程占用删不掉则留下，下次用新目录不冲突 */ }
        Application.Exit();
    }

    private void ShellClosed(object sender, FormClosedEventArgs e)
    {
        CloseApp();
    }
}

public static class Program
{
    // 2026-09-08 文员 Win10 修复：启动即声明 Per-Monitor V2 DPI 感知。
    // WebView2 初始化会把进程中途提升为 DPI 感知，若提升发生在窗口创建后，
    // Screen.WorkingArea 的物理坐标与窗口逻辑坐标会错位 → 最大化盖住任务栏；先声明保持全程一致。
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(int value);
    private const int DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

    [STAThread]
    public static void Main()
    {
        try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch { }
        // 单实例互斥：后台壳只允许开一个（双开会抢同一 server/端口，数据目录也易冲突）
        bool createdNew = false;
        System.Threading.Mutex mutex = new System.Threading.Mutex(true, "Global\\JuHuoVisitAdminShell", out createdNew);
        if (!createdNew)
        {
            MessageBox.Show("聚火拜访后台已经在运行中。", "JuHuo Visit", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs ev)
        {
            ShellForm.Log("FATAL: " + (ev.ExceptionObject == null ? "null" : ev.ExceptionObject.ToString()));
        };
        Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs ev)
        {
            ShellForm.Log("THREAD: " + ev.Exception);
        };
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ShellForm());
        GC.KeepAlive(mutex);
    }
}
