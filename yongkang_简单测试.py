import os
import pandas as pd

input_file = r"D:\WFR\visit-miniapp\TMP\金华-永康.xlsx"
output_dir = r"D:\WFR\visit-miniapp\TMP\永康市"

print(f"文件是否存在: {os.path.exists(input_file)}")
print(f"输出目录会创建: {output_dir}")

try:
    # 尝试读取文件基本信息
    xl = pd.ExcelFile(input_file)
    print(f"工作表: {xl.sheet_names}")
    
    df = xl.parse(xl.sheet_names[0], nrows=10)
    print(f"前10行数据:")
    print(df)
    print(f"列名: {list(df.columns)}")
    
    # 检查是否有regionName列
    if 'regionName' in df.columns:
        print("找到 regionName 列")
    else:
        print("未找到 regionName 列，但我会继续处理")
        
except Exception as e:
    print(f"读取文件时出错: {e}")
    import traceback
    traceback.print_exc()