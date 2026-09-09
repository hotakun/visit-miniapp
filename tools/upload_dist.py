# -*- coding: utf-8 -*-
"""
后台文件分发上传（2026-09-08 老板定：老板说"上传"才执行，不自动上传）
用法：
  python tools/upload_dist.py [后台地址，默认 http://localhost:8581]
作用：
  读 admin/admin.html + admin/nt-map.js → 分片（90KB/片，配合云端 100KB 出入参限制）
  → 调 adminapi uploadAdminDist 存云端 settings/admin_dist，并更新"当前版本号标记"
文员机点 🔄 刷新时自动对齐该版本。
"""
import json, re, sys, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8581'
CHUNK = 90000  # 与云端 DIST_CHUNK 一致


def api(body):
    req = urllib.request.Request(BASE + '/api',
                                 data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode('utf-8'))


def upload_file(kind, text, version):
    total = max(1, (len(text) + CHUNK - 1) // CHUNK)
    for p in range(total):
        r = api({
            'action': 'uploadAdminDist', 'username': 'qingyan', 'password': '123456',
            'kind': kind, 'part': p, 'total': total, 'version': version,
            'content': text[p * CHUNK:(p + 1) * CHUNK]
        })
        if not r.get('ok'):
            raise RuntimeError('%s 分片 %d/%d 失败：%s' % (kind, p + 1, total, r.get('msg', r)))
    print('  %s 上传完成（%d 片）' % (kind, total))


def main():
    html = open(r'admin\admin.html', encoding='utf-8').read()
    ntmap = open(r'admin\nt-map.js', encoding='utf-8').read()
    serverjs = open(r'admin\server.js', encoding='utf-8').read()  # 2026-09-09：server.js 纳入分发
    m = re.search(r"const APP_VERSION = '([^']+)'", html)
    version = m.group(1) if m else '0.9.00'
    print('目标版本：v%s | admin.html %d 字符 | nt-map.js %d 字符 | server.js %d 字符' % (version, len(html), len(ntmap), len(serverjs)))
    print('正在上传到 %s ...' % BASE)
    upload_file('adminHtml', html, version)
    upload_file('ntMapJs', ntmap, version)
    upload_file('serverJs', serverjs, version)
    print('[完成] 上传完成：云端分发版本 = v%s（文员点 检查更新 即可对齐）' % version)


if __name__ == '__main__':
    main()
