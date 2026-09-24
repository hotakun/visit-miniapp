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
    """Excel 序列号（46273.529…）→ '2026-09-15'"""
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
    m = re.match(r'^([a-zA-Z]\d{1,5})\s+(.*)$', t)
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
    mall = pd.read_excel(os.path.join(BASE, '商城客户列表002-已匹配大众点评-带shopuuid.xlsx'))
    plat = pd.read_excel(os.path.join(BASE, '金华-永康-已匹配商城-带商城客户名-补齐同店.xlsx'))
    dup = pd.read_excel(os.path.join(BASE, '客户列表0912-同店重复注册.xlsx'), header=1)
    R('① 商城侧 %d 行 × %d 列' % (len(mall), len(mall.columns)))
    R('② 点评侧 %d 行 × %d 列' % (len(plat), len(plat.columns)))
    R('③ 同店重复登记 %d 行 × %d 列' % (len(dup), len(dup.columns)))
    return mall, plat, dup

def plat_index(plat):
    """shopuuid → 点评行（同一 shopuuid 多条时按 §1.3 方案 A：字段级合并，收录时间取更早）"""
    idx = {}
    for _, r in plat.iterrows():
        u = s(r.get('shopuuid'))
        if not u:
            continue
        if u not in idx:
            idx[u] = r
        else:
            a, b = idx[u], r
            merged = {}
            for col in plat.columns:
                va, vb = clean_plat_field(a.get(col)), clean_plat_field(b.get(col))
                merged[col] = va if va else vb
            # 收录时间取更早
            ta, tb = listed_time(a.get('收录时间')), listed_time(b.get('收录时间'))
            if ta and tb:
                merged['收录时间'] = min(ta, tb)
            elif ta or tb:
                merged['收录时间'] = ta or tb
            idx[u] = pd.Series(merged)
    return idx

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
            'lng': lng,
            'lat': lat,
            'coord_status': 'ok' if (lng is not None and lat is not None) else 'pending',
            'coordSource': 'mall',                     # 来源：商城（2026-09-24 定）
            # —— 客户类型（沿用现有字段）——
            'customerType': 'mall',
            'status': 'active',
        }
        if not doc['mallJoinedAt'] and not doc['lastOrderAt']:
            stat['nodate'] += 1

        # —— 平台画像（按 shopuuid 硬匹配）——
        p = plat_map.get(uuid)
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
    path = os.path.join(ORDERS_DIR, '销售订单-已匹配客户.csv')
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    R('')
    R('④ 订单主表 %d 行 × %d 列' % (len(df), len(df.columns)))

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
    d = os.path.join(ORDERS_DIR, '订单明细')
    files = sorted(os.listdir(d))
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
    R('=== 阶段 3b 合并报告（%s）===' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))
    R('')
    mall, plat, dup = load_sources()
    pidx = plat_index(plat)
    R('点评侧按 shopuuid 去重后：%d 个 shopuuid' % len(pidx))

    cust, stat = build_customers(mall, pidx)
    R('')
    R('customers：%d 条文档' % len(cust))
    R('  其中：有平台画像 %d 家 ｜ 无坐标 %d 家 ｜ 商城日期全空 %d 家' % (stat['plat'], stat['nocoord'], stat['nodate']))

    ords = build_orders(cust)
    items = build_items()

    R('')
    R('=== 写分片 ===')
    pc = write_parts('customers', cust)
    po = write_parts('orders', ords)
    pi = write_parts('order_items', items)
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
