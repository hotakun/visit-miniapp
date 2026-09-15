#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
快速检查两个Excel文件的列结构
"""

import pandas as pd
import sys

print("快速检查Excel文件结构")
print("="*60)

files = {
    "源文件": r"D:\WFR\visit-miniapp\TMP\客户经纬度(1).xlsx",
    "目标文件": r"D:\WFR\visit-miniapp\TMP\客户列表-含经纬度.xlsx"
}

for name, path in files.items():
    print(f"\n检查{name}: {path}")
    try:
        xl = pd.ExcelFile(path)
        print(f"  工作表: {xl.sheet_names}")
        
        df = xl.parse(xl.sheet_names[0], nrows=5)
        print(f"  数据形状: {df.shape}")
        print(f"  列名:")
        for i, col in enumerate(df.columns, 1):
            print(f"    {i:2d}. {col}")
            
        # 检查是否有经纬度列
        coord_cols = [col for col in df.columns if any(keyword in str(col) for keyword in ['经纬度', '坐标', 'lat', 'lon', 'lng'])]
        if coord_cols:
            print(f"  经纬度相关列: {coord_cols}")
            print(f"  示例数据: {df[coord_cols[0]].head().tolist()}")
            
        # 检查可能的客户标识列
        id_cols = [col for col in df.columns if any(keyword in str(col).lower() for keyword in ['客户', '商户', '名称', 'name', 'id', '电话', '手机', 'phone'])]
        if id_cols:
            print(f"  客户标识列: {id_cols}")
            
        # 显示前几行数据概要
        print(f"  前3行数据概要:")
        for i in range(min(3, len(df))):
            row_data = {col: df.iloc[i][col] for col in df.columns[:5]}  # 只显示前5列
            row_str = ", ".join([f"{k}: {v}" for k, v in row_data.items()])
            print(f"    第{i+1}行: {row_str[:100]}...")
            
    except Exception as e:
        print(f"  读取失败: {e}")

print(f"\n完成检查")