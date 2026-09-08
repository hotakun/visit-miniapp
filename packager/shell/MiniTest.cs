// 最小 WebView2 环境测试：创建环境 + Ensure + 加载 about:blank，写 minitest.log
using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

public static class Program
{
    static void Log(string msg)
    {
        try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "minitest.log"),
            DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n"); } catch { }
    }

    [STAThread]
    public static void Main()
    {
        Application.EnableVisualStyles();
        Form form = new Form();
        form.Width = 800; form.Height = 600;
        WebView2 wv = new WebView2();
        wv.Dock = DockStyle.Fill;
        form.Controls.Add(wv);
        bool finished = false;
        form.Load += async delegate(object s, EventArgs e)
        {
            try
            {
                Log("Load start, calling CreateAsync ...");
                string userData = Path.Combine(Path.GetTempPath(), "wvminitest");
                Microsoft.Web.WebView2.Core.CoreWebView2Environment env =
                    await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, userData, null);
                Log("env created");
                var task = wv.EnsureCoreWebView2Async(env);
                bool ok = await TaskTimeout(task, 25000);
                Log(ok ? ("ensure OK, CoreWebView2=" + (wv.CoreWebView2 != null)) : "ensure TIMEOUT 25s");
            }
            catch (Exception ex)
            {
                Log("ERR: " + ex.GetType().Name + " " + ex.Message);
                if (ex.InnerException != null) Log("INNER: " + ex.InnerException.Message);
            }
            finally
            {
                finished = true;
                Log("done, closing");
                form.Close();
            }
        };
        // 兜底：35 秒强制退出
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
        t.Interval = 35000;
        t.Tick += delegate { if (!finished) { Log("force exit 35s"); } form.Close(); };
        t.Start();
        Application.Run(form);
        Log("process end");
    }

    static async System.Threading.Tasks.Task<bool> TaskTimeout(System.Threading.Tasks.Task task, int ms)
    {
        var done = await System.Threading.Tasks.Task.WhenAny(task, System.Threading.Tasks.Task.Delay(ms));
        return done == task && task.Status == System.Threading.Tasks.TaskStatus.RanToCompletion;
    }
}
