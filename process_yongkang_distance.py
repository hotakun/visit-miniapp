#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
处理金华-永康-同名待人工确认.csv文件
根据E列（经纬度(B)）和J列（经纬度(A)）计算距离
如果距离大于500米，在最后一列（L列）填入"两家"
"""

import pandas as pd
import numpy as np
import math
import os
from pathlib import Path

def haversine_distance(lon1, lat1, lon2, lat2):
    """
    计算两个经纬度坐标之间的Haversine距离（单位：米）
    参数：经度1, 纬度1, 经度2, 纬度2
    """
    # 将角度转换为弧度
    lon1, lat1, lon2, lat2 = map(math.radians, [lon1, lat1, lon2, lat2])
    
    # Haversine公式
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a))
    r = 6371000  # 地球平均半径，单位：米
    return c * r

def parse_coordinates(coord_str):
    """
    解析经纬度字符串，返回(经度, 纬度)元组
    支持格式： "120.050197,28.899617" 或 "None"
    """
    if pd.isna(coord_str) or coord_str is None:
        return None, None
    
    coord_str = str(coord_str).strip()
    if coord_str.lower() == 'none' or coord_str == '':
        return None, None
    
    try:
        # 去除可能的引号
        coord_str = coord_str.replace('"', '').replace("'", "").strip()
        # 按逗号分割
        parts = coord_str.split(',')
        if len(parts) == 2:
            lon = float(parts[0].strip())
            lat = float(parts[1].strip())
            return lon, lat
        else:
            return None, None
    except (ValueError, IndexError):
        return None, None

def main():
    # 文件路径
    input_file = Path(r"D:\WFR\visit-miniapp\TMP\金华-永康-同名待人工确认.csv")
    output_file = Path(r"D:\WFR\visit-miniapp\TMP\金华-永康-同名待人工确认_处理完成.csv")
    
    print("=" * 60)
    print("处理金华-永康同名店铺距离计算")
    print("=" * 60)
    
    # 检查输入文件是否存在
    if not input_file.exists():
        print(f"❌ 错误: 输入文件不存在")
        print(f"路径: {input_file}")
        return
    
    print(f"✓ 输入文件: {input_file}")
    
    try:
        # 读取CSV文件
        # 注意：文件可能有UTF-8 BOM，使用utf-8-sig编码
        print("正在读取CSV文件...")
        df = pd.read_csv(input_file, encoding='utf-8-sig')
        
        print(f"✓ 成功读取 {len(df)} 行数据")
        print(f"✓ 列数: {len(df.columns)}")
        
        # 显示列名
        print("\n📋 文件列名:")
        for i, col in enumerate(df.columns, 1):
            print(f"  {i:2d}. '{col}'")
        
        # 查找经纬度列
        coord_b_col = None  # E列: 经纬度(B)
        coord_a_col = None  # J列: 经纬度(A)
        
        # 尝试通过列名查找
        for col in df.columns:
            if '经纬度(B)' in col:
                coord_b_col = col
            elif '经纬度(A)' in col:
                coord_a_col = col
            elif '经纬度' in col and 'B' in col:
                coord_b_col = col
            elif '经纬度' in col and 'A' in col:
                coord_a_col = col
        
        # 如果通过列名找不到，使用位置索引
        if coord_b_col is None and len(df.columns) >= 5:
            coord_b_col = df.columns[4]  # 第5列，索引4
            
        if coord_a_col is None and len(df.columns) >= 10:
            coord_a_col = df.columns[9]  # 第10列，索引9
        
        print(f"\n📍 使用的列:")
        print(f"  左边经纬度列(E列): '{coord_b_col}'")
        print(f"  右边经纬度列(J列): '{coord_a_col}'")
        
        # 检查最后一列是否存在
        if len(df.columns) >= 12:
            last_col_name = df.columns[11]  # L列，索引11
            print(f"  最后一列(L列): '{last_col_name}'")
            
            # 如果最后一列已经有数据，先备份或重命名
            if not df[last_col_name].isna().all():
                print(f"  ⚠ 最后一列 '{last_col_name}' 已有数据，将创建新列")
                # 创建新列
                df['判断结果'] = ''
                last_col_name = '判断结果'
        else:
            # 如果列数不足12，添加新列
            print(f"  ⚠ 文件只有 {len(df.columns)} 列，将添加新列")
            last_col_name = '判断结果'
            df[last_col_name] = ''
        
        # 处理每一行
        print(f"\n📏 开始计算距离并判断...")
        
        total_processed = 0
        total_distance_500m = 0
        total_missing_coords = 0
        
        for idx, row in df.iterrows():
            # 解析左侧经纬度
            coord_b = row[coord_b_col] if coord_b_col in df.columns else None
            lon1, lat1 = parse_coordinates(coord_b)
            
            # 解析右侧经纬度
            coord_a = row[coord_a_col] if coord_a_col in df.columns else None
            lon2, lat2 = parse_coordinates(coord_a)
            
            # 检查是否有缺失的坐标
            if lon1 is None or lat1 is None or lon2 is None or lat2 is None:
                total_missing_coords += 1
                # 留空不填
                df.at[idx, last_col_name] = ''
                continue
            
            # 计算距离（米）
            distance = haversine_distance(lon1, lat1, lon2, lat2)
            total_processed += 1
            
            # 判断距离是否大于500米
            if distance > 500:
                df.at[idx, last_col_name] = '两家'
                total_distance_500m += 1
                
                # 显示一些示例
                if total_distance_500m <= 3:
                    shop_name_b = row['商户名(B)'] if '商户名(B)' in df.columns else '未知'
                    shop_name_a = row['客户名称(A)'] if '客户名称(A)' in df.columns else '未知'
                    print(f"  ✓ 距离超过500米: {shop_name_b} ↔ {shop_name_a}")
                    print(f"    距离: {distance:.0f} 米")
            else:
                # 距离≤500米，留空不填
                df.at[idx, last_col_name] = ''
        
        print(f"\n📊 处理统计:")
        print(f"  - 总行数: {len(df)}")
        print(f"  - 成功计算距离的行数: {total_processed}")
        print(f"  - 距离超过500米的行数: {total_distance_500m}")
        print(f"  - 缺少经纬度的行数: {total_missing_coords}")
        
        # 保存处理结果
        print(f"\n💾 正在保存处理结果...")
        df.to_csv(output_file, index=False, encoding='utf-8-sig')
        print(f"✓ 处理结果已保存到: {output_file}")
        
        # 显示一些示例结果
        print(f"\n📄 示例结果（距离超过500米的前5行）:")
        sample_count = 0
        for idx, row in df.iterrows():
            if row[last_col_name] == '两家' and sample_count < 5:
                shop_b = row.get('商户名(B)', '未知')
                shop_a = row.get('客户名称(A)', '未知')
                coord_b = row[coord_b_col] if pd.notna(row[coord_b_col]) else '无'
                coord_a = row[coord_a_col] if pd.notna(row[coord_a_col]) else '无'
                
                # 重新计算距离用于显示
                lon1, lat1 = parse_coordinates(row[coord_b_col])
                lon2, lat2 = parse_coordinates(row[coord_a_col])
                if lon1 and lat1 and lon2 and lat2:
                    distance = haversine_distance(lon1, lat1, lon2, lat2)
                    print(f"  第{idx+1}行: {shop_b} ↔ {shop_a}")
                    print(f"    距离: {distance:.0f} 米")
                    print(f"    坐标: {coord_b} ↔ {coord_a}")
                    print()
                    sample_count += 1
        
        # 生成统计报告
        stats_file = input_file.parent / "距离计算统计报告.txt"
        with open(stats_file, 'w', encoding='utf-8-sig') as f:
            f.write("金华-永康同名店铺距离计算统计报告\n")
            f.write("=" * 60 + "\n")
            f.write(f"输入文件: {input_file.name}\n")
            f.write(f"输出文件: {output_file.name}\n")
            f.write(f"计算时间: {pd.Timestamp.now()}\n\n")
            
            f.write("处理统计:\n")
            f.write(f"  总行数: {len(df)}\n")
            f.write(f"  成功计算距离的行数: {total_processed}\n")
            f.write(f"  距离超过500米的行数: {total_distance_500m}\n")
            f.write(f"  缺少经纬度的行数: {total_missing_coords}\n\n")
            
            f.write("列映射:\n")
            f.write(f"  左侧经纬度列: {coord_b_col}\n")
            f.write(f"  右侧经纬度列: {coord_a_col}\n")
            f.write(f"  结果列: {last_col_name}\n")
        
        print(f"📋 详细统计报告已保存到: {stats_file}")
        
        print(f"\n✅ 处理完成！")
        print(f"   原始文件: {input_file}")
        print(f"   结果文件: {output_file}")
        print(f"   统计报告: {stats_file}")
        
    except Exception as e:
        print(f"\n❌ 处理过程中出错: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()

print(f"\n💡 使用说明:")
print(f"   1. 检查输出文件 {output_file} 中的结果")
print(f"   2. 可以在 '判断结果' 列看到 '两家' 的标识")
print(f"   3. 如果没有 '判断结果' 列，则距离≤500米或无坐标数据")