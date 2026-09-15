#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检查两个客户经纬度Excel文件结构
"""

import pandas as pd
import os
from pathlib import Path

def inspect_file(file_path, description):
    """检查Excel文件结构"""
    print(f"\n{'='*60}")
    print(f"检查: {description}")
    print(f"文件: {file_path}")
    print(f"{'='*60}")
    
    if not os.path.exists(file_path):
        print(f"❌ 文件不存在")
        return None
    
    try:
        # 读取所有工作表名称
        xl = pd.ExcelFile(file_path)
        print(f"工作表: {xl.sheet_names}")
        
        # 读取第一个工作表的前几行
        sheet_name = xl.sheet_names[0]
        print(f"使用工作表: {sheet_name}")
        
        # 读取前10行数据
        df = xl.parse(sheet_name, nrows=10)
        print(f"数据形状: {df.shape} (行数, 列数)")
        print(f"列名:")
        for i, col in enumerate(df.columns, 1):
            print(f"  {i:2d}. {col}")
        
        print(f"\n前5行数据:")
        print(df.head(5))
        
        # 检查是否有经纬度相关的列
        coord_cols = [col for col in df.columns if any(keyword in str(col) for keyword in ['经纬度', '坐标', 'latitude', 'longitude', 'lat', 'lng', 'lon'])]
        if coord_cols:
            print(f"\n✅ 找到经纬度相关列: {coord_cols}")
        else:
            print(f"\n⚠ 未找到'经纬度'相关列")
        
        # 检查可能的匹配列（客户标识）
        possible_id_cols = [col for col in df.columns if any(keyword in str(col).lower() for keyword in ['客户', '商户', '名称', 'name', 'id', '电话', '手机', 'phone', '地址', 'address'])]
        if possible_id_cols:
            print(f"可能的匹配列: {possible_id_cols}")
        
        return df, sheet_name
        
    except Exception as e:
        print(f"❌ 读取文件时出错: {str(e)}")
        import traceback
        traceback.print_exc()
        return None, None

def main():
    # 文件路径
    source_file = Path(r"D:\WFR\visit-miniapp\TMP\客户经纬度(1).xlsx")
    target_file = Path(r"D:\WFR\visit-miniapp\TMP\客户列表-含经纬度.xlsx")
    
    print("客户经纬度文件结构检查")
    print("=" * 60)
    
    # 检查源文件
    source_df, source_sheet = inspect_file(source_file, "源文件（客户经纬度数据）")
    
    # 检查目标文件
    target_df, target_sheet = inspect_file(target_file, "目标文件（客户列表，需要注入经纬度）")
    
    if source_df is not None and target_df is not None:
        print(f"\n{'='*60}")
        print("文件对比分析")
        print(f"{'='*60}")
        
        # 找出共同列
        source_cols = set(source_df.columns)
        target_cols = set(target_df.columns)
        common_cols = source_cols.intersection(target_cols)
        
        if common_cols:
            print(f"✅ 两个文件有共同列: {common_cols}")
        else:
            print(f"⚠ 两个文件没有完全相同的列名")
        
        # 建议匹配策略
        print(f"\n📋 建议的匹配策略:")
        print(f"  1. 查找两个文件都有的客户标识列（如客户名称、电话、地址等）")
        print(f"  2. 使用该列进行数据匹配")
        print(f"  3. 将源文件的经纬度数据注入到目标文件")
        
        # 查找源文件中的经纬度列
        source_coord_cols = [col for col in source_df.columns if any(keyword in str(col) for keyword in ['经纬度', '坐标'])]
        if source_coord_cols:
            print(f"  源文件经纬度列: {source_coord_cols[0]}")
        
        # 查找目标文件中的经纬度列
        target_coord_cols = [col for col in target_df.columns if any(keyword in str(col) for keyword in ['经纬度', '坐标'])]
        if target_coord_cols:
            print(f"  目标文件经纬度列: {target_coord_cols[0]}")
        else:
            print(f"  目标文件可能需要添加经纬度列，或您需要指定列名")

if __name__ == "__main__":
    main()