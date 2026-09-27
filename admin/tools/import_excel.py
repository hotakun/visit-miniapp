# -*- coding: utf-8 -*-
"""阶段 3b · 客户数据合并 + 分片（纯本地，不碰云端）

输入：TMP/拜访程序用表格/ 下的四份表
  ① 商城客户列表002-已匹配大众点评-带shopuuid.xlsx   （463 行 × 49 列，商城侧 + shopuuid）
  ② 金华-永康-已匹配商城-带商城客户名-补齐同店.xlsx   （471 行 × 46 列，点评侧画像，有 shopuuid）
  ③ 客户列表0912-同店重复注册.xlsx                    （94 行，表头在第 2 行，用于交叉核对同编号）
  ④ 已经匹配客户的销售数据/销售订单-已匹配客户.csv    （2135 行 × 36 列）
  ⑤ 已经匹配客户的销售数据/订单明细/*.csv + 1 个 .xls （2135 个文件，表头在第 2 行、订单号在文件名里）

输出：_scratch/import_out/{customers,orders,order_items}_NNN.json  +  _report.txt
用法：python _scratch/build_import.py

口径：字段表见 _scratch/客户数据导入规范.md §四；规则见 _scratch/数据落地-实施顺序与规则.md §四。
"""
import os, io, json, re, csv, datetime, sys

import pandas as pd

BASE = os.environ.get('JH_SRC') or r'D:\WFR\visit-miniapp\TMP\拜访程序用表格'
ORDERS_DIR = os.path.join(BASE, '已经匹配客户的销售数据')
OUTDIR = os.environ.get('JH_OUT') or r'D:\WFR\visit-miniapp\_scratch\import_out'
PART_LIMIT = 68 * 1024  # 每片字节上限（云函数入参 100KB，留余量）

# ===== 任务与源文件路径（2026-09-25：后台「导入信息」页改成四个入口各自吃表格/目录）=====
# TASK 决定**只跑哪一类**（原来是 all 一把全跑）：
#   mall  = 商城客户（生成 customers，含平台画像）
#   plat  = ⭐ 大众点评（2026-09-26 老板定：**点评导入也能建客户**）
#           分片里带「点评侧有的全部字段」；入库时云端按 shopuuid 匹配：
#           匹配上 → 字段级取优（只补空位，冲突以商城为准）；匹配不上 → **新建客户**。
#           ⚠️ 旧规则「只更新 customers.plat、且分片裁成关联键 + plat」**已作废**。
#           ⚠️ 点评表里 **shopuuid 为空的行直接跳过**（这条只对点评表成立，商城表不适用）。
#   order = 销售订单（orders）
#   item  = 订单明细（order_items）
#   all   = 三类全跑（保持兼容）
TASK = (os.environ.get('JH_TASK') or 'all').strip().lower()
F_MALL = os.environ.get('JH_F_MALL') or ''    # 商城客户表（.xlsx）
F_PLAT = os.environ.get('JH_F_PLAT') or ''    # 大众点评表（.xlsx）
F_ORDER = os.environ.get('JH_F_ORDER') or ''  # 销售订单表（.csv）
D_ITEMS = os.environ.get('JH_D_ITEMS') or ''  # 订单明细目录

REPORT = []
def R(s=''):
    line = str(s)
    REPORT.append(line)
    # 2026-09-25：后台 server.js 要**实时**读到进度（流式），所以同时打到 stdout 并 flush。
    try:
        print(line, flush=True)
    except Exception:
        pass

# ============ 通用清洗 ============
def s(v):
    """转字符串：None→''，float 去 .0，NaN→''"""
    if v is None:
        return ''
    if isinstance(v, float):
        if v != v:
            return ''
        if v == int(v):
            return str(int(v))
        return repr(v)
    t = str(v).strip()
    if t.lower() in ('nan', 'none', 'nat', 'null'):
        return ''
    return t

def num(v):
    try:
        f = float(v)
        if f != f:
            return None
        return f
    except Exception:
        return None

def date_only(v):
    """'2026-04-12 17:11:20.977000' → '2026-04-12'（秒也去掉，口径：只留日期）"""
    t = s(v)
    m = re.match(r'^(\d{4}-\d{2}-\d{2})', t)
    return m.group(1) if m else ''

def excel_date(v):
    """下单 / 预计发货 / 业务 / 送达 时间 → 'YYYY-MM-DD'
    ⚠️ 2026-09-25 修（老板报障："订单都有日期，为什么显示不出来"）：
       原先**只认 Excel 序列号**（46273.529…），而新导入的订单表里「下单时间」是**文本**
       （'2026-09-08 10:49:56.477000'）→ num() 解析失败 → 整列 orderedAt 落成空串
       （云端抽样 96.7% 为空，而日期其实都躺在 orderedAtRaw 里）。
       现在**两种格式都认**：先看是不是日期字符串，是就直接取日期部分；不是再按序列号换算。"""
    t = s(v)
    if t:
        m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', t)
        if m:
            return m.group(0)
        m2 = re.match(r'^(\d{4})/(\d{1,2})/(\d{1,2})', t)   # 2026/09/08 这种也认
        if m2:
            return '%s-%02d-%02d' % (m2.group(1), int(m2.group(2)), int(m2.group(3)))
    f = num(v)
    if f is None or f <= 0:
        return ''
    try:
        base = datetime.date(1899, 12, 30)  # Excel 的 1900 闰年 bug 标准修正
        return (base + datetime.timedelta(days=int(f))).isoformat()
    except Exception:
        return ''

def split_code(name):
    """'a101 沙县小吃(市场路店)' → ('a101', '沙县小吃(市场路店)')；没有前缀就原样返回"""
    t = s(name)
    # ⚠️ 2026-09-27 修正（老板报障「永康 AA 开头的客户全被判成未加商城」）：
    #   原正则只认「1 个字母 + 数字」（a52 / c602），**AA021 这类两个字母的编号提取不到** → mallCode 留空
    #   → 后台「商城」列显示「未加」、订单也匹配不上。改为支持 1~3 个字母（大小写都认）。
    m = re.match(r'^([a-zA-Z]{1,3}\d{1,6})\s+(.*)$', t)
    if m:
        return m.group(1).lower(), m.group(2).strip()
    return '', t

def mall_coord(v):
    """商城表「经纬度」列 = '经度,纬度' → (lng, lat)"""
    t = s(v).replace('，', ',')
    parts = [x.strip() for x in t.split(',') if x.strip()]
    if len(parts) >= 2:
        a, b = num(parts[0]), num(parts[1])
        if a is not None and b is not None and a > 20 and b > 0:
            return a, b  # (lng, lat)
    return None, None

def plat_bool(v):
    """点评表的 True/False 列（团购/外卖/外国 等）"""
    t = s(v)
    if t == '':
        return None
    return t.lower() in ('true', '1', '是', 'y')

def clean_plat_field(v):
    """点评表的 '-' 视为空"""
    t = s(v)
    return '' if t in ('-', '--', '[]', "['']") else t

def listed_time(v):
    """收录时间：Excel 序列号（43800）或已是日期字符串"""
    t = s(v)
    if not t:
        return ''
    if re.match(r'^\d{4}-\d{2}-\d{2}', t):
        return t[:10]
    return excel_date(t)

# ============ 分片输出 ============
TYPE_OF = {'customers': 'customers', 'orders': 'orders', 'order_items': 'order_items'}

def write_parts(prefix, docs):
    os.makedirs(OUTDIR, exist_ok=True)
    part, cur, size = 0, [], 0
    def flush():
        nonlocal part, cur, size
        if not cur:
            return
        part += 1
        fn = os.path.join(OUTDIR, '%s_%03d.json' % (prefix, part))
        with io.open(fn, 'w', encoding='utf-8') as f:
            json.dump({'type': TYPE_OF[prefix], 'part': part, 'rows': cur}, f, ensure_ascii=False)
        R('    分片 %s_%03d.json：%d 行' % (prefix, part, len(cur)))
        cur, size = [], 0
    for d in docs:
        b = len(json.dumps(d, ensure_ascii=False).encode('utf-8'))
        if size + b > PART_LIMIT and cur:
            flush()
        cur.append(d)
        size += b
    flush()
    return part

# ============ ① 读源表 ============
def load_sources():
    """按任务读表：
         mall       商城客户表（必填）＋ 点评表（可选，带来就顺便补平台画像）
         plat ⭐     大众点评表（必填）—— 2026-09-26 老板定：点评导入**也能建客户**，不再需要商城表
         order/item 只导订单/明细，两张表都不需要
    """
    p_mall = F_MALL or os.path.join(BASE, '商城客户列表002-已匹配大众点评-带shopuuid.xlsx')
    p_plat = F_PLAT or os.path.join(BASE, '金华-永康-已匹配商城-带商城客户名-补齐同店.xlsx')
    p_dup = os.path.join(BASE, '客户列表0912-同店重复注册.xlsx')
    mall = plat = None

    if TASK == 'plat':
        # ⚠️ 2026-09-26 修 bug：原来这里**只认 mall/all**（`if TASK in ('mall','all')` 才读点评表），
        #    于是后台「大众点评客户导入」等于白跑，还会把已有客户的 plat 覆盖成空对象。
        if not os.path.exists(p_plat):
            raise SystemExit('找不到大众点评表：' + p_plat)
        plat = pd.read_excel(p_plat)
        R('① 点评侧 %s → %d 行 × %d 列' % (os.path.basename(p_plat), len(plat), len(plat.columns)))
    elif TASK in ('mall', 'all'):
        if not os.path.exists(p_mall):
            raise SystemExit('找不到商城客户表：' + p_mall)
        mall = pd.read_excel(p_mall)
        R('① 商城侧 %s → %d 行 × %d 列' % (os.path.basename(p_mall), len(mall), len(mall.columns)))
        if os.path.exists(p_plat):
            plat = pd.read_excel(p_plat)
            R('② 点评侧 %s → %d 行 × %d 列' % (os.path.basename(p_plat), len(plat), len(plat.columns)))
        else:
            R('② 点评侧（本次没给这张表 → 不带平台画像）')

    dup = pd.read_excel(p_dup, header=1) if os.path.exists(p_dup) else None
    R('③ 同店重复登记 %s' % ('%d 行' % len(dup) if dup is not None else '（无此文件，跳过）'))
    return mall, plat, dup

# ============ 点评行：内部合并 / 画像块 / 建客户 ============
# 点评表的「空」口径：`-` / `--` / `[]` / `['']` 都当没有（clean_plat_field 同口径）
PLAT_EMPTY = ('', '-', '--', '[]', "['']", 'nan', 'none', 'nat', 'null')

def plat_richness(row, cols):
    """有效字段数（老板 2026-09-13 口径）：遍历该行，剔除 空 / '-' / '[]' / "['']" / False / 0 / '0.0'"""
    n = 0
    for col in cols:
        v = s(row.get(col))
        if not v:
            continue
        lv = v.lower()
        if lv in PLAT_EMPTY or lv in ('false', '0', '0.0'):
            continue
        n += 1
    return n

def plat_score(row):
    try:
        return float(s(row.get('评分')) or 0)
    except Exception:
        return 0.0

def merge_plat_rows(rows, cols, uuid):
    """同一 shopuuid 的多条点评记录 → **字段级合并**（老板 2026-09-13 拍板「方案 A」）：
       ① 定主记录：有效字段多 → 评分高 → 随机（用 uuid 的 md5 掷，**保证每次跑结果一样**）
       ② 主记录为基座，逐字段补缺（主记录为空就用另一条的值）
       ③ 【收录时间】例外：取**更早**的那个
       ④ 【小类】不同 → **两个都留成标签**（老板 2026-09-26 定；`cat3Tags` 装全部，`小类` 仍给主记录的）
    """
    rows = list(rows)
    if len(rows) == 1:
        one = rows[0]
        c3 = clean_plat_field(one.get('小类'))
        return {'row': one, 'cat3Tags': [c3] if c3 else [], 'mergeCount': 1,
                'fromNames': [s(one.get('name'))]}

    rich = [plat_richness(r, cols) for r in rows]
    cand = [i for i in range(len(rows)) if rich[i] == max(rich)]
    sco = [plat_score(rows[i]) for i in cand]
    cand = [i for i in cand if plat_score(rows[i]) == max(sco)]
    pick = cand[int(hashlib.md5(uuid.encode('utf-8')).hexdigest(), 16) % len(cand)]
    base = rows[pick]

    merged = {}
    for col in cols:
        v = clean_plat_field(base.get(col))
        if not v:
            for r2 in rows:
                if r2 is base:
                    continue
                v = clean_plat_field(r2.get(col))
                if v:
                    break
        merged[col] = v

    # 收录时间取更早（两条都读）
    times = [t for t in (listed_time(r.get('收录时间')) for r in rows) if t]
    if times:
        merged['收录时间'] = min(times)

    # 小类：两个都留
    cat3 = []
    for r2 in rows:
        v = clean_plat_field(r2.get('小类'))
        if v and v not in cat3:
            cat3.append(v)
    merged['小类'] = cat3[0] if cat3 else ''

    return {'row': merged, 'cat3Tags': cat3, 'mergeCount': len(rows),
            'fromNames': [s(r.get('name')) for r in rows]}

def plat_index(plat):
    """shopuuid → 合并后的点评条目 { row, cat3Tags, mergeCount, fromNames }。
       ⚠️ **shopuuid 为空的行直接跳过**（2026-09-26 老板定）—— ⚠️ 这条只对**点评表**成立，
       商城表不按这个规则（商城没有 shopuuid 也照导）。实测金华表有 5 行整行全空的废行。
    """
    if plat is None:
        return {}, {'skipNoUuid': 0, 'merged': 0}
    cols = list(plat.columns)
    buckets, order, skip = {}, [], 0
    for _, r in plat.iterrows():
        u = s(r.get('shopuuid'))
        if not u:
            skip += 1
            continue
        if u not in buckets:
            buckets[u] = []
            order.append(u)
        buckets[u].append(r)
    idx, merged_n = {}, 0
    for u in order:
        item = merge_plat_rows(buckets[u], cols, u)
        if item['mergeCount'] > 1:
            merged_n += 1
        idx[u] = item
    return idx, {'skipNoUuid': skip, 'merged': merged_n}

# 只用来给「随机选主记录」掷一个**稳定**的骰子（同 shopuuid 每次跑结果都一样，导入才幂等）
import hashlib


def plat_block(row, uuid, cat3_tags=None):
    """点评行 → customers.plat 平台画像块（商城路径与点评路径共用同一套字段名）"""
    b = {
        'newShop': clean_plat_field(row.get('新店标签')),
        'phone1': clean_plat_field(row.get('phone1')),
        'phone2': clean_plat_field(row.get('phone2')),
        'cityCode': clean_plat_field(row.get('城市编码')),
        'addr': clean_plat_field(row.get('地址')),
        'province': clean_plat_field(row.get('省份')),
        'city': clean_plat_field(row.get('城市')),
        'district': clean_plat_field(row.get('行政区')),
        'regionName': clean_plat_field(row.get('regionName')),
        'regionId': clean_plat_field(row.get('regionId')),
        'cityId': clean_plat_field(row.get('cityId')),
        'shopUuid': uuid,
        'shopId': clean_plat_field(row.get('shopid')),
        'bizStatus': clean_plat_field(row.get('经营状态')),
        'cat1': clean_plat_field(row.get('大类')),
        'cat2': clean_plat_field(row.get('中类')),
        'cat3': clean_plat_field(row.get('小类')),
        'dishes': clean_plat_field(row.get('菜品')),
        'dishDetail': clean_plat_field(row.get('菜品详情')),
        'avgPriceText': clean_plat_field(row.get('人均消费')),
        'rating': clean_plat_field(row.get('评分')),
        'taste': clean_plat_field(row.get('评分详情_口味')),
        'env': clean_plat_field(row.get('评分详情_环境')),
        'service': clean_plat_field(row.get('评分详情_服务')),
        'reviewCount': clean_plat_field(row.get('评论总数')),
        'reviewCount2025': clean_plat_field(row.get('评论总数(2025年)')),
        'groupon': plat_bool(row.get('团购')),
        'takeout': plat_bool(row.get('外卖')),
        'rank': clean_plat_field(row.get('榜单信息')),
        'features': clean_plat_field(row.get('特色服务')),
        'facilities': clean_plat_field(row.get('配套设施')),
        'services': clean_plat_field(row.get('服务设施')),
        'foreign': plat_bool(row.get('外国')),
        'lng': num(clean_plat_field(row.get('lng'))),      # 平台坐标：入库留存
        'lat': num(clean_plat_field(row.get('lat'))),
        'url': clean_plat_field(row.get('url')),
        'photoCount': clean_plat_field(row.get('图片数量')),
        'alias': clean_plat_field(row.get('商户别名')),
        'hours': clean_plat_field(row.get('营业时间')),
        'lastPhotoAt': clean_plat_field(row.get('商家最近上次图片时间')),
        'chainCount': clean_plat_field(row.get('已登记的连锁店数量')),
        'listedTime': listed_time(row.get('收录时间')),
    }
    # 小类两边不一样时**两个都留成标签**（老板 2026-09-26 定）：cat3 仍是主记录的，cat3Tags 装全部
    if cat3_tags and len(cat3_tags) > 1:
        b['cat3Tags'] = list(cat3_tags)
    return b


def build_customers_from_plat(pmap):
    """⭐ 点评导入建客户（2026-09-26 老板定的新规则）：
       **点评表自己就能建客户** —— 不再要求先有商城表，"假商城表中转"那套也就作废了。

       写进去的只有「点评侧有的」：店名 / 地址 / 三层骨架 / 坐标 / 平台画像；
       **一律不写商城侧字段**（mallKey、mallCode、购买次数、订单数…）—— 还没加入商城就留空，
       以后这家加入了商城、再导商城表时，云端会按 shopuuid 匹配上并自然补齐（见 importdata）。

       同 shopuuid 的多条记录**已经在 plat_index 里合并成一条**（不建"主副档"）：
       点评那两条没有各自的订单和拜访记录，合并什么都不丢；留 platMergeCount / platMergeFrom 可回溯。
    """
    docs = []
    stat = {'noCoord': 0}
    for uuid, item in pmap.items():
        row = item['row']
        lng = num(clean_plat_field(row.get('lng')))
        lat = num(clean_plat_field(row.get('lat')))
        if lng is None or lat is None:
            stat['noCoord'] += 1
        city = clean_plat_field(row.get('城市'))
        if city and not city.endswith('市'):
            city += '市'
        docs.append({
            # —— 关联键（点评侧唯一键）——
            'platShopUuid': uuid,
            # —— 基本信息（点评侧有什么写什么）——
            'name': clean_plat_field(row.get('name')),
            'address': clean_plat_field(row.get('地址')),
            # ⭐ 2026-09-27 老板定：**顶部电话也要从平台带过来**。
            #   原来只写进 plat.phone1/phone2，导致"点评新建的客户"顶层 phone 为空 → 详情页/手机端看不到电话。
            #   口径（老板原话）：**商城有就用商城、平台有就用平台、两个都有就用商城的** ——
            #   这里是"点评新建"（商城本来没有），所以直接写；若是"匹配上已有客户"，合并逻辑会保证不覆盖商城已有值。
            'phone': clean_plat_field(row.get('phone1')),
            'phone2': clean_plat_field(row.get('phone2')),
            # —— 三层骨架（点评表本来就分好了城市/行政区/商圈，直接取，不做地址解析）——
            'city': city,
            'district': clean_plat_field(row.get('行政区')),
            'bizCircle': clean_plat_field(row.get('regionName')) or '❓ 未划分商圈',
            # —— 坐标（§坐标取数口径第 2 条：没有商城坐标就用点评坐标）——
            'lng': lng,
            'lat': lat,
            'coord_status': 'ok' if (lng is not None and lat is not None) else 'pending',
            'coordSource': 'platform',   # ⚠️ 2026-09-26 修正：必须是 'platform'（之前写成 'plat' → 前台会误显示成“商城”）
            # —— 类型与状态 ——
            'customerType': 'mall',   # 2026-09-26 老板定：暂时不分线，点评新建的也先放"老客"这边
            'status': 'active',
            'platMatched': True,
            'platMergeCount': item.get('mergeCount', 1),
            'platMergeFrom': item.get('fromNames') or [],
            'plat': plat_block(row, uuid, item.get('cat3Tags')),
            # —— 空壳（与商城路径一致，详情页/后台不用判空）——
            'isSubAccount': False,
            'mainAccountId': '',
            'subAccounts': [],
            'remarks': [],
            'photos': [],
            'platManual': {},
        })
    return docs, stat

# ============ ② 组 customers 文档 ============
def build_customers(mall, plat_map):
    docs = []
    stat = {'nocoord': 0, 'plat': 0, 'dup_groups': {}, 'nodate': 0}
    for _, r in mall.iterrows():
        code, clean_name = split_code(r.get('客户名称'))
        mall_key = s(r.get('系统Key(勿改)'))
        uuid = s(r.get('shopuuid'))
        lng, lat = mall_coord(r.get('经纬度'))
        if lng is None or lat is None:
            stat['nocoord'] += 1

        doc = {
            # —— 关联键 ——
            'mallKey': mall_key,
            'mallCode': code or s(r.get('客户编码')).lower(),
            'platShopUuid': uuid,
            # —— 基本信息 ——
            'name': clean_name,
            'nameRaw': s(r.get('客户名称')),          # 原值留底（带编码前缀）
            'region': s(r.get('地区')),
            'address': s(r.get('公司地址')),
            'contactName': s(r.get('客户联系人')),
            'phone': s(r.get('联系人联系手机')),
            'phone2': s(r.get('联系人联系电话')),
            'contactQQ': s(r.get('联系人QQ')),
            'contactEmail': s(r.get('联系人邮箱')),
            'contactRemark': s(r.get('联系人备注')),
            'receiver': s(r.get('收货人')),
            'receiverPhone': s(r.get('收货人手机')),
            'receiverAddress': s(r.get('收货地址')),
            'legalPerson': s(r.get('法人代表')),
            'regCapital': s(r.get('注册资本')),
            'bizCode': s(r.get('企业代码')),
            'website': s(r.get('网站')),
            'tel': s(r.get('公司固话')),
            'fax': s(r.get('公司传真')),
            'companyRemark': s(r.get('公司备注')),
            'bank': s(r.get('银行')),
            'bankBranch': s(r.get('开户银行')),
            'bankAccount': s(r.get('银行账户')),
            'invoiceType': s(r.get('开票类型')),
            'mallTags': s(r.get('客户标签')),
            'mallCategory': s(r.get('客户分类')),
            'salesman': s(r.get('业务负责人')),        # 原值照抄（口径：不许改）
            'driver': s(r.get('司机')),
            'sortNo': s(r.get('排序')),
            'creditDays': s(r.get('账期天数（天）')),
            'creditLimit': s(r.get('信用额度')),
            'mallType': s(r.get('客户类型')),
            'route': s(r.get('配送路线')),
            'warehouse': s(r.get('关联仓库')),
            # —— 时间 ——
            'mallJoinedAt': date_only(r.get('添加时间')),
            'lastOrderAt': date_only(r.get('最后下单')),
            'lastBrowseAt': date_only(r.get('最后浏览商城')),
            'lastVisitAt': date_only(r.get('最后拜访')),
            # —— 经营/消费 ——
            'source': s(r.get('来源')),
            'level': s(r.get('等级')),
            'avgPrice': num(r.get('客单价')) or 0,
            'buyFreq': num(r.get('购买频次')) or 0,
            'orderCount': num(r.get('购买次数')) or 0,
            'pointsPolicy': s(r.get('积分策略')),
            'routeLine': s(r.get('配送线路')),
            # —— 坐标（商城侧，实地验证）——
            # ⭐ 2026-09-26 老板定：**商城优先，但“有坐标才写”** ——
            #   商城表里这家没填经纬度时，**不要写 coord_status / coordSource**（下面条件赋值），
            #   否则会把「平台导入时已有的坐标」误标成“补标”（坐标还在、状态却说没有）。
            #   而 lng/lat 为 None 时也不用担心：importdata 的“空值不写”会自动跳过。
            'lng': lng,
            'lat': lat,
            # —— 客户类型（沿用现有字段）——
            'customerType': 'mall',
            'status': 'active',
        }
        # 有坐标才写「状态 + 来源」：商城坐标一落地就把来源定成商城（覆盖平台来的）
        if lng is not None and lat is not None:
            doc['coord_status'] = 'ok'
            doc['coordSource'] = 'mall'
        if not doc['mallJoinedAt'] and not doc['lastOrderAt']:
            stat['nodate'] += 1

        # —— 平台画像（按 shopuuid 硬匹配）——
        #   plat_map[uuid] = { row, cat3Tags, mergeCount, fromNames }（点评内部已按 shopuuid 合并，见 plat_index）
        item = plat_map.get(uuid)
        p = item['row'] if item else None
        if p is not None:
            stat['plat'] += 1
            doc['platMatched'] = True
            doc['plat'] = {
                'newShop': clean_plat_field(p.get('新店标签')),
                'phone1': clean_plat_field(p.get('phone1')),
                'phone2': clean_plat_field(p.get('phone2')),
                'cityCode': clean_plat_field(p.get('城市编码')),
                'addr': clean_plat_field(p.get('地址')),
                'province': clean_plat_field(p.get('省份')),
                'city': clean_plat_field(p.get('城市')),
                'district': clean_plat_field(p.get('行政区')),
                'regionName': clean_plat_field(p.get('regionName')),
                'regionId': clean_plat_field(p.get('regionId')),
                'cityId': clean_plat_field(p.get('cityId')),
                'shopUuid': uuid,
                'shopId': clean_plat_field(p.get('shopid')),
                'bizStatus': clean_plat_field(p.get('经营状态')),
                'cat1': clean_plat_field(p.get('大类')),
                'cat2': clean_plat_field(p.get('中类')),
                'cat3': clean_plat_field(p.get('小类')),
                'dishes': clean_plat_field(p.get('菜品')),
                'dishDetail': clean_plat_field(p.get('菜品详情')),
                'avgPriceText': clean_plat_field(p.get('人均消费')),
                'rating': clean_plat_field(p.get('评分')),
                'taste': clean_plat_field(p.get('评分详情_口味')),
                'env': clean_plat_field(p.get('评分详情_环境')),
                'service': clean_plat_field(p.get('评分详情_服务')),
                'reviewCount': clean_plat_field(p.get('评论总数')),
                'reviewCount2025': clean_plat_field(p.get('评论总数(2025年)')),
                'groupon': plat_bool(p.get('团购')),
                'takeout': plat_bool(p.get('外卖')),
                'rank': clean_plat_field(p.get('榜单信息')),
                'features': clean_plat_field(p.get('特色服务')),
                'facilities': clean_plat_field(p.get('配套设施')),
                'services': clean_plat_field(p.get('服务设施')),
                'foreign': plat_bool(p.get('外国')),
                'lng': num(clean_plat_field(p.get('lng'))),   # 平台坐标：入库但不使用
                'lat': num(clean_plat_field(p.get('lat'))),
                'url': clean_plat_field(p.get('url')),
                'photoCount': clean_plat_field(p.get('图片数量')),
                'alias': clean_plat_field(p.get('商户别名')),
                'hours': clean_plat_field(p.get('营业时间')),
                'lastPhotoAt': clean_plat_field(p.get('商家最近上次图片时间')),
                'chainCount': clean_plat_field(p.get('已登记的连锁店数量')),
                'listedTime': listed_time(p.get('收录时间')),
            }
            # 与商城名不一致时，点评名留底（老板常要看"平台叫什么"）
            pn = clean_plat_field(p.get('name'))
            if pn and pn != clean_name:
                doc['plat']['name'] = pn
        else:
            doc['platMatched'] = False
            doc['plat'] = {}

        doc['isSubAccount'] = False
        doc['mainAccountId'] = ''
        doc['subAccounts'] = []
        doc['remarks'] = []
        doc['photos'] = []
        doc['platManual'] = {}
        if code:
            stat['dup_groups'].setdefault(code, []).append(doc)
        docs.append(doc)

    # —— 同编号合并（同一家店：购买次数多者为主，其余为副）——
    groups = {k: v for k, v in stat['dup_groups'].items() if len(v) > 1}
    R('')
    R('同编号重复：共 %d 组' % len(groups))
    for code, lst in sorted(groups.items()):
        lst.sort(key=lambda d: (-(d.get('orderCount') or 0), d.get('name', '')))
        main = lst[0]
        for sub in lst[1:]:
            sub['isSubAccount'] = True
            sub['mainAccountId'] = main['mallKey']
            main['subAccounts'].append(sub['mallKey'])
        R('  %s → 主 %s（购买 %s 次）｜副 %s' % (
            code, main['name'], main['orderCount'], '、'.join(x['name'] for x in lst[1:])))
    R('合并后：主档 %d 家（副档 %d 条也入库，带 isSubAccount 标记）→ 文档共 %d 条'
      % (len(docs) - sum(len(v) - 1 for v in groups.values()),
         sum(len(v) - 1 for v in groups.values()), len(docs)))
    return docs, stat

# ============ ③ 组 orders 文档 ============
def build_orders(cust_docs):
    # 2026-09-25 老板定：订单源既支持**单个文件**，也支持**一个目录**
    # （老板的订单是「销售订单1~5.xls」5 个分开的文件 → 选目录后自动逐个读、合并成一张表）。
    path = F_ORDER or os.path.join(ORDERS_DIR, '销售订单-已匹配客户.csv')
    frames = []
    if os.path.isdir(path):
        fs = sorted([x for x in os.listdir(path) if x.lower().endswith(('.xls', '.xlsx', '.csv'))])
        if not fs:
            raise SystemExit('目录里没有订单表（.xls/.xlsx/.csv）：' + path)
        R('')
        R('④ 订单源目录 %s —— 共 %d 个文件，逐个读后合并：' % (path, len(fs)))
        for fn in fs:
            fp = os.path.join(path, fn)
            try:
                if fn.lower().endswith('.csv'):
                    frames.append(pd.read_csv(fp, dtype=str, keep_default_na=False, encoding='utf-8-sig'))
                else:
                    frames.append(pd.read_excel(fp, dtype=str))
                R('     · %s → %d 行' % (fn, len(frames[-1])))
            except Exception as e:
                R('     [X] 读取失败：%s（%s）' % (fn, e))
        if not frames:
            raise SystemExit('目录里的订单表一个都没读成功：' + path)
        df = pd.concat(frames, ignore_index=True)
    else:
        if not os.path.exists(path):
            raise SystemExit('找不到销售订单表：' + path)
        df = pd.read_csv(path, dtype=str, keep_default_na=False)
        R('')
    R('   合并后 %d 行 × %d 列' % (len(df), len(df.columns)))

    # 客户编码 → 客户名（用于回填与核对）
    code2name = {}
    for d in cust_docs:
        if d.get('mallCode'):
            code2name.setdefault(d['mallCode'], d['name'])

    docs, miss = [], 0
    for _, r in df.iterrows():
        code, clean = split_code(r.get('客户单位'))
        if code and code not in code2name:
            miss += 1
        docs.append({
            'orderNo': s(r.get('订单号')),
            'customerCode': code,                    # 业务关联键（本地生成时拿不到云端 _id）
            'customerName': clean,
            'customerNameRaw': s(r.get('客户单位')),
            'contact': s(r.get('联系信息')),
            'province': s(r.get('省')),
            'city': s(r.get('市')),
            'district': s(r.get('区')),
            'region': s(r.get('区域')),
            'street': s(r.get('街道')),
            'address': s(r.get('地址')),
            'warehouse': s(r.get('仓库')),
            'orderAmount': num(r.get('订单金额')),
            'actualAmount': num(r.get('实际金额')),
            'shortAmount': num(r.get('缺货金额')),
            'orderStatus': s(r.get('订单状态')),
            'freight': num(r.get('运费')),
            'payMethod': s(r.get('支付方式')),
            'orderedAt': excel_date(r.get('下单时间')),
            'orderedAtRaw': s(r.get('下单时间')),
            'clerk': s(r.get('开单员')),
            'settleStatus': s(r.get('结账状态')),
            'orderChannel': s(r.get('下单方式')),
            'expectShipAt': excel_date(r.get('预计发货时间')),
            'bizAt': excel_date(r.get('业务时间')),
            'printCount': s(r.get('打印次数')),
            'invoiceType': s(r.get('票据类型')),
            'taxAmount': num(r.get('税额')),
            'bizOwner': s(r.get('业务负责人')),
            'auditor': s(r.get('审核人')),
            'deliveryMethod': s(r.get('交货方式')),
            'deliveredAt': excel_date(r.get('送达时间')),
            'remark': s(r.get('备注')),
            'multiShopName': s(r.get('多店商户名')),
            'route': s(r.get('配送路线')),
            'logisticsCompany': s(r.get('物流公司')),
            'logisticsNo': s(r.get('物流单号')),
        })
    nodate = sum(1 for d in docs if not d['orderedAt'])
    R('  订单共 %d 条；下单日期解析失败 %d 条；客户编码在本批找不到 %d 条' % (len(docs), nodate, miss))
    return docs

# ============ ④ 组 order_items 文档 ============
ITEM_FILE = re.compile(r'销售订单详细\s*-\s*(\d+)\.(csv|xls)$', re.I)

def build_items():
    # 2026-09-25：明细目录可传（后台「订单明细导入」选目录后由 server.js 传进来）
    d = D_ITEMS or os.path.join(ORDERS_DIR, '订单明细')
    if not os.path.isdir(d):
        raise SystemExit('找不到订单明细目录：' + d)
    files = sorted(os.listdir(d))
    R('')
    R('⑤ 明细目录 %s（%d 个文件）' % (d, len(files)))
    docs, nofile, rowsum, xls_ok = [], 0, 0, 0
    for fn in files:
        m = ITEM_FILE.search(fn)
        if not m:
            continue
        order_no = m.group(1)
        ext = m.group(2).lower()
        path = os.path.join(d, fn)
        try:
            if ext == 'csv':
                # 表头在第 2 行（第 1 行是"销售订单详细 - 订单号"）
                df = pd.read_csv(path, dtype=str, keep_default_na=False, header=1, encoding='utf-8-sig')
            else:
                df = pd.read_excel(path, dtype=str, header=1)   # .xls 走 xlrd
                if ext == 'xls':
                    xls_ok += 1
        except Exception as e:
            nofile += 1
            R('  [X] 明细读取失败：%s（%s）' % (fn, e))
            continue
        line = 0
        for _, r in df.iterrows():
            # 跳过尾部空行（商品名为空的行）
            if not s(r.get('商品名称')):
                continue
            line += 1
            docs.append({
                'orderNo': order_no,
                'lineNo': line,
                'supplier': s(r.get('主供应商')),
                'goodsName': s(r.get('商品名称')),
                'brand': s(r.get('品牌名称')),
                'category': s(r.get('分类')),
                'spec': s(r.get('规格')),
                'unit': s(r.get('单位')),
                'barcode': s(r.get('条码')),
                'goodsCode': s(r.get('商品编码')),
                'selfCode': s(r.get('自编码')),
                'feature': s(r.get('特征')),
                'retailPrice': num(r.get('零售价')),
                'wholesalePrice': num(r.get('批发价')),
                'salePrice': num(r.get('销售价格')),
                'actualPrice': num(r.get('实际价格')),
                'orderQty': num(r.get('订货数量')),
                'outQty': num(r.get('出库数量')),
                'amount': num(r.get('金额')),
                'otherShare': num(r.get('其他分摊')),
                'remark': s(r.get('备注')),
            })
            rowsum += 1
    R('')
    R('⑤ 明细：文件 %d 个（其中 .xls %d 个已解析）→ 明细行 %d 行；读取失败文件 %d 个'
      % (len(files), xls_ok, rowsum, nofile))
    return docs

# ============ 主流程 ============
def main():
    R('=== 客户数据合并报告（%s）｜任务：%s ===' % (datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), TASK))
    R('')
    cust, ords, items = [], [], []

    if TASK in ('mall', 'plat', 'all'):
        mall, plat, dup = load_sources()
        pidx, pstat = plat_index(plat)
        R('点评侧：%d 个 shopuuid ｜ 同 shopuuid 合并 %d 组 ｜ shopuuid 为空跳过 %d 行'
          % (len(pidx), pstat['merged'], pstat['skipNoUuid']))
        if TASK == 'plat':
            # ⭐ 2026-09-26 老板定的新规则：**点评导入也能建客户**
            #   —— 不再裁成「关联键 + plat」，也不再依赖商城表（那张"假商城表"作废）。
            #   分片里带的是「点评侧有的全部字段」；入库由云端 fill 模式做字段级取优：
            #   匹配上已有客户 → 只补空位（冲突以商城为准）；匹配不上 → 新建客户。
            cust, stat = build_customers_from_plat(pidx)
            R('')
            R('customers：%d 条点评档案（匹配得上就合并、匹配不上就新建 —— 由云端判定）' % len(cust))
            R('  其中：无坐标 %d 家' % stat['noCoord'])
        else:
            cust, stat = build_customers(mall, pidx)
            R('')
            R('customers：%d 条文档' % len(cust))
            R('  其中：有平台画像 %d 家 ｜ 无坐标 %d 家 ｜ 商城日期全空 %d 家'
              % (stat['plat'], stat['nocoord'], stat['nodate']))
    if TASK in ('order', 'all'):
        ords = build_orders(cust)
    if TASK in ('item', 'all'):
        items = build_items()

    R('')
    R('=== 写分片 ===')
    pc = write_parts('customers', cust) if cust else 0
    po = write_parts('orders', ords) if ords else 0
    pi = write_parts('order_items', items) if items else 0
    R('')
    R('=== 汇总 ===')
    R('  customers   %5d 条 → %d 片' % (len(cust), pc))
    R('  orders      %5d 条 → %d 片' % (len(ords), po))
    R('  order_items %5d 条 → %d 片' % (len(items), pi))
    R('  输出目录：%s' % OUTDIR)

    os.makedirs(OUTDIR, exist_ok=True)
    with io.open(os.path.join(OUTDIR, '_report.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(REPORT) + '\n')
    print('done -> ' + os.path.join(OUTDIR, '_report.txt'))

if __name__ == '__main__':
    main()
