import pandas as pd
import numpy as np

# 读取杭州美食店铺信息表
print("正在读取杭州美食店铺信息表...")
df_hangzhou = pd.read_csv(r"D:\WFR\visit-miniapp\杭州美食店铺信息表.csv", encoding='utf-8')
print(f"原始数据行数: {df_hangzhou.shape[0]}, 列数: {df_hangzhou.shape[1]}")

# 查看列名
print("\n前5行数据和列名:")
print(df_hangzhou.head(5))
print("\n列名:")
print(df_hangzhou.columns.tolist())

# 确定需要的字段
# 根据现有数据，需要映射:
# 店铺名 -> name列
# 电话 -> phone1列 (可能还有phone2)
# 地址 -> 地址列
# 经纬度 -> lat, lng列
# 区域 -> 需要从"城市"和"行政区"组合成"浙江省>杭州市>行政区"

# 检查关键列是否存在
required_columns = ['name', 'phone1', '地址', 'lat', 'lng', '城市', '行政区']
for col in required_columns:
    if col not in df_hangzhou.columns:
        print(f"警告: 缺少列 '{col}'，实际列名:")
        print([c for c in df_hangzhou.columns if col.lower() in c.lower()])

# 创建拜访表格
print("\n创建拜访表格...")

# 构建区域列: 浙江省>杭州市>行政区
df_hangzhou['区域'] = '浙江省>杭州市>' + df_hangzhou['行政区'].astype(str)

# 处理电话: 优先使用phone1，如果有phone2可以一起显示
def combine_phones(phone1, phone2):
    phones = []
    if pd.notna(phone1) and str(phone1).strip() != '-' and str(phone1).strip() != '':
        phones.append(str(phone1).strip())
    if pd.notna(phone2) and str(phone2).strip() != '-' and str(phone2).strip() != '':
        phones.append(str(phone2).strip())
    if phones:
        return ','.join(phones)
    else:
        return ''

df_hangzhou['电话'] = df_hangzhou.apply(lambda row: combine_phones(row.get('phone1', ''), row.get('phone2', '')), axis=1)

# 处理经纬度
df_hangzhou['地图经纬度'] = df_hangzhou['lat'].astype(str) + ',' + df_hangzhou['lng'].astype(str)

# 创建拜访表
baifang_df = pd.DataFrame()
baifang_df['序号'] = range(1, len(df_hangzhou) + 1)
baifang_df['客户单位'] = df_hangzhou['name']
baifang_df['区域'] = df_hangzhou['区域']
baifang_df['地址'] = df_hangzhou['地址']
baifang_df['地图经纬度'] = df_hangzhou['地图经纬度']
baifang_df['电话'] = df_hangzhou['电话']

# 过滤掉地址为空的数据
print(f"处理前总行数: {len(baifang_df)}")
baifang_df = baifang_df[baifang_df['地址'].notna() & (baifang_df['地址'].astype(str).str.strip() != '')]
print(f"处理后有效行数: {len(baifang_df)}")

# 保存到文件
output_file = r"D:\WFR\visit-miniapp\杭州美食店铺拜访表.csv"
baifang_df.to_csv(output_file, index=False, encoding='utf-8-sig')

print(f"\n拜访表已保存到: {output_file}")
print(f"包含 {len(baifang_df)} 行数据")
print("\n前10行数据:")
print(baifang_df.head(10))

# 统计信息
print("\n统计信息:")
print(f"有电话号码的记录数: {baifang_df['电话'].notna().sum()}")
print(f"有经纬度记录数: {baifang_df['地图经纬度'].notna().sum()}")
print(f"区域分布:")
print(baifang_df['区域'].value_counts().head(20))