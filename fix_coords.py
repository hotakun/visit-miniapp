import pandas as pd
import sys

# 读取文件
input_file = "杭州美食店铺拜访表.csv"
output_file = "杭州美食店铺拜访表_坐标修正.csv"

print(f"Reading {input_file}...")
df = pd.read_csv(input_file, encoding='utf-8-sig')

print(f"Loaded {len(df)} rows")

# 定义交换经纬度的函数
def swap_lat_lng(coord_str):
    if pd.isna(coord_str):
        return coord_str
    
    # 去除可能的引号
    s = str(coord_str).strip()
    s = s.replace('"', '').replace("'", "")
    
    # 分割纬度和经度
    parts = s.split(',')
    if len(parts) == 2:
        lat = parts[0].strip()
        lng = parts[1].strip()
        # 交换顺序: 经度,纬度
        return f"{lng},{lat}"
    else:
        print(f"Warning: Invalid coordinate format: {coord_str}")
        return coord_str

# 应用处理
print("Swapping latitude and longitude order...")
df['地图经纬度'] = df['地图经纬度'].apply(swap_lat_lng)

# 保存新文件
print(f"Saving to {output_file}...")
df.to_csv(output_file, index=False, encoding='utf-8-sig')

# 同时更新原文件
df.to_csv(input_file, index=False, encoding='utf-8-sig')
print(f"Updated original file {input_file}")

# 显示几个示例
print("\nSample coordinates (first 5 rows):")
for i, (orig, new) in enumerate(zip(df['地图经纬度'].head(5), df['地图经纬度'].head(5))):
    print(f"Row {i+1}: {new}")

print("\nDone!")
