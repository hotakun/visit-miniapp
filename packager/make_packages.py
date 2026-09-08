# 聚火拜访后台分发包组装脚本（2026-09-06）
# 输出：packager/output/聚火拜访-环境安装包.zip + 聚火拜访-后台程序包.zip
# 安装目录全部英文（D:\JuHuoVisit\env + D:\JuHuoVisit\admin），bat 纯 ASCII + CRLF，杜绝编码问题
import os, shutil, zipfile, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ADMIN_SRC = os.path.join(os.path.dirname(ROOT), 'admin')
INPUTS = os.path.join(ROOT, 'inputs')
BUILD = os.path.join(ROOT, 'build')
OUT = os.path.join(ROOT, 'output')

NODE_ZIP = 'node-v24.16.0-win-x64.zip'
NODE_INNER = 'node-v24.16.0-win-x64'  # zip 内根目录名

def write_bat(path, lines):
    with open(path, 'wb') as f:
        f.write(('\r\n'.join(lines) + '\r\n').encode('ascii'))

def zip_dir(src, dst):
    if os.path.exists(dst):
        os.remove(dst)
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(src):
            for fn in files:
                full = os.path.join(root, fn)
                arc = os.path.relpath(full, src)
                z.write(full, arc)
    print('zip ok:', dst, os.path.getsize(dst), 'bytes')

def main():
    os.makedirs(OUT, exist_ok=True)
    if os.path.exists(BUILD):
        shutil.rmtree(BUILD)
    # ---------- 包 1：环境安装包 ----------
    env_dir = os.path.join(BUILD, 'env')
    os.makedirs(env_dir)
    node_zip_src = os.path.join(INPUTS, NODE_ZIP)
    if not os.path.exists(node_zip_src) or os.path.getsize(node_zip_src) < 20 * 1024 * 1024:
        print('ERROR: node zip missing or too small:', node_zip_src)
        sys.exit(1)
    shutil.copy(node_zip_src, os.path.join(env_dir, 'node.zip'))
    # edge-tts 离线安装包（Python 3.14 win_amd64 wheels）：文员电脑免联网秒装
    shutil.copytree(os.path.join(INPUTS, 'edgetts_wheels'), os.path.join(env_dir, 'edgetts_wheels'))
    write_bat(os.path.join(env_dir, 'setup-env.bat'), [
        '@echo off',
        'cd /d "%~dp0"',
        'echo ============================================',
        'echo  JuHuo Visit - Environment Setup',
        'echo ============================================',
        'echo [1/3] Checking Python ...',
        'python --version >nul 2>nul',
        'if errorlevel 1 (',
        '  echo [WARN] Python not found. Install Python 3.10+ from python.org first.',
        '  goto end',
        ')',
        'echo [OK] Python found.',
        'echo [2/3] Installing edge-tts (offline) ...',
        'python -m pip install edge-tts --user -q --no-index --find-links=edgetts_wheels',
        'if errorlevel 1 (',
        '  echo [WARN] offline install failed, trying online ...',
        '  python -m pip install edge-tts --user -q',
        ')',
        'echo [OK] edge-tts ready.',
        'echo [3/3] Extracting Node.js runtime ...',
        'set "NODEDIR=D:\\JuHuoVisit\\env\\node"',
        'if not exist "D:\\JuHuoVisit\\env" mkdir "D:\\JuHuoVisit\\env"',
        'if exist "%NODEDIR%" rmdir /S /Q "%NODEDIR%"',
        'powershell -NoProfile -Command "Expand-Archive -Force -Path \'%~dp0node.zip\' -DestinationPath \'%NODEDIR%\'"',
        'move "%NODEDIR%\\' + NODE_INNER + '\\*" "%NODEDIR%" >nul',
        'rmdir /S /Q "%NODEDIR%\\' + NODE_INNER + '"',
        'echo [OK] Node.js ready: %NODEDIR%',
        'echo.',
        'echo ============================================',
        'echo  Environment setup complete!',
        'echo  Python: OK  edge-tts: OK  Node: OK',
        'echo  Next: run the Admin Setup package.',
        'echo ============================================',
        ':end',
        'pause',
        ''
    ])
    zip_dir(env_dir, os.path.join(OUT, '聚火拜访-环境安装包.zip'))

    # ---------- 包 2：后台程序包 ----------
    app_dir = os.path.join(BUILD, 'app')
    admin_out = os.path.join(app_dir, 'admin')
    os.makedirs(admin_out)
    include = ['admin.html', 'nt-map.js', 'server.js', 'config.json', 'package.json', 'package-lock.json',
               'tts_gen.py', 'notify.wav', 'bengbao.wav', 'logo.png', 'AlibabaPuHuiTi-3-55-Regular.ttf']
    for fn in include:
        src = os.path.join(ADMIN_SRC, fn)
        if os.path.exists(src):
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(admin_out, fn))
            else:
                shutil.copy(src, os.path.join(admin_out, fn))
        else:
            print('WARN missing:', src)
    # node_modules（xlsx 等运行时依赖）
    nm_src = os.path.join(ADMIN_SRC, 'node_modules')
    if os.path.isdir(nm_src):
        shutil.copytree(nm_src, os.path.join(admin_out, 'node_modules'))
    # voice 语音缓存：老板本机已合成的 mp3 随包分发（文员端免首次联网合成）；缺失则预建空目录
    voice_src = os.path.join(ADMIN_SRC, 'voice')
    if os.path.isdir(voice_src):
        shutil.copytree(voice_src, os.path.join(admin_out, 'voice'))
    else:
        os.makedirs(os.path.join(admin_out, 'voice'), exist_ok=True)
    # 无边框壳程序（JuHuoVisitAdmin.exe + WebView2 依赖 dll）
    SHELL_DIR = os.path.join(ROOT, 'shell')
    for fn in ['JuHuoVisitAdmin.exe']:
        shutil.copy(os.path.join(SHELL_DIR, fn), os.path.join(admin_out, fn))
    for fn in ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']:
        shutil.copy(os.path.join(SHELL_DIR, 'lib', fn), os.path.join(admin_out, fn))
    shutil.copy(os.path.join(INPUTS, 'icon.ico'), os.path.join(admin_out, 'icon.ico'))
    # 后台启动脚本（快捷方式指向）
    write_bat(os.path.join(admin_out, 'start.bat'), [
        '@echo off',
        'cd /d "%~dp0"',
        'set "NODE=..\\env\\node\\node.exe"',
        'if not exist "%NODE%" set "NODE=node"',
        'set PORT=8581',
        '"%NODE%" server.js',
        'pause',
        ''
    ])
    # 安装/卸载脚本
    write_bat(os.path.join(app_dir, 'install.bat'), [
        '@echo off',
        'cd /d "%~dp0"',
        'set "TARGET=D:\\JuHuoVisit\\admin"',
        'echo ============================================',
        'echo  JuHuo Visit - Admin Setup',
        'echo ============================================',
        'echo Installing to %TARGET% ...',
        'if not exist "%TARGET%" mkdir "%TARGET%"',
        'xcopy /E /Y /I "admin" "%TARGET%" >nul',
        'echo Creating desktop shortcut ...',
        'powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath(\'Desktop\'); $lnk=$ws.CreateShortcut($d+\'\\JuHuoVisit Admin.lnk\'); $lnk.TargetPath=\'%TARGET%\\JuHuoVisitAdmin.exe\'; $lnk.WorkingDirectory=\'%TARGET%\'; $lnk.IconLocation=\'%TARGET%\\JuHuoVisitAdmin.exe\'; $lnk.Save()"',
        'echo.',
        'echo Done! Desktop shortcut: JuHuoVisit Admin',
        'echo Double-click it to start the admin console.',
        'echo (Run the Environment Setup package first if not done.)',
        ':end',
        'pause',
        ''
    ])
    write_bat(os.path.join(app_dir, 'uninstall.bat'), [
        '@echo off',
        'echo Removing desktop shortcut ...',
        'powershell -NoProfile -Command "$d=[Environment]::GetFolderPath(\'Desktop\'); $p=$d+\'\\JuHuoVisit Admin.lnk\'; if(Test-Path $p){Remove-Item $p}"',
        'if exist "D:\\JuHuoVisit\\admin" rmdir /S /Q "D:\\JuHuoVisit\\admin"',
        'echo Uninstall complete. (Environment folder kept; remove D:\\JuHuoVisit\\env manually if needed.)',
        'pause',
        ''
    ])
    zip_dir(app_dir, os.path.join(OUT, '聚火拜访-后台程序包.zip'))
    print('ALL DONE. Output in', OUT)

if __name__ == '__main__':
    main()
