#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
计算金华-永康同名店铺距离工具
按用户要求：如果两边经纬度距离大于500米，在最后一列填入"两家"
否则留空
"""

import pandas as pd
import math
import sys
import os
from pathlib import Path

# Haversine距离计算函数
def haversine_distance(lon1, lat1, lon2, lat2):
    """
    计算两个经纬度之间的距离（单位：米）
    参数: 经度1, 纬度1, 经度2, 纬度2
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

# 解析经纬度字符串函数
def parse_coordinate(coord_str):
    """
    解析经纬度字符串
    输入: "120.050197,28.899617" 或 None
    输出: (经度, 纬度) 或 (None, None)
    """
    if pd.isna(coord_str) or coord_str is None:
        return None, None
    
    coord_str = str(coord_str).strip()
    if coord_str.lower() == 'none' or coord_str == '':
        return None, None
    
    try:
        # 去掉可能的引号
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

def calculate_distance_for_file():
    """主处理函数"""
    # 文件路径
    source_file = Path(r"D:\WFR\visit-miniapp\TMP\金华-永康-同名待人工确认.csv")
    result_file = Path(r"D:\WFR\visit-miniapp\TMP\金华-永康-同名待人工确认_距离计算完成.csv")
    
    print("=" * 60)
    print("金华-永康同名店铺距离计算工具")
    print("=" * 60)
    
    # 1. 检查文件是否存在
    if not source_file.exists():
        print(f"❌ 错误: 找不到文件")
        print(f"请确认路径正确: {source_file}")
        print("请按 'Win + R'，输入 'cmd'，然后运行以下命令检查:")
        print(f'  cd /d D:\\WFR\\visit-miniapp')
        print(f'  dir TMP\\金华-永康-同名待人工确认.csv')
        return False
    
    print(f"✓ 发现文件: {source_file}")
    
    try:
        # 2. 读取CSV文件
        print("正在读取CSV文件...")
        # 注意：CSV可能包含UTF-8 BOM，所以用utf-8-sig编码
        df = pd.read_csv(source_file, encoding='utf-8-sig')
        
        print(f"✓ 读取成功: {len(df)} 行, {len(df.columns)} 列")
        
        # 3. 检查列名
        print("\n📋 文件列名:")
        for i, col in enumerate(df.columns, 1):
            print(f"  第{i}列: '{col}'")
        
        # 4. 确定经纬度列位置
        # E列（第5列）应该是"经纬度(B)"
        # J列（第10列）应该是"经纬度(A)"
        target_col_e = None  # 第5列 (E)
        target_col_j = None  # 第10列 (J)
        
        # 查找列索引
        if len(df.columns) >= 5:
            target_col_e = df.columns[4]  # 第5列，索引4
            print(f"\n📍 E列（第5列）: '{target_col_e}'")
        else:
            print("❌ 错误: CSV文件列数不足5列")
            return False
            
        if len(df.columns) >= 10:
            target_col_j = df.columns[9]  # 第10列，索引9
            print(f"📍 J列（第10列）: '{target_col_j}'")
        else:
            print("❌ 错误: CSV文件列数不足10列")
            return False
        
        # 5. 检查最后一列（L列）
        if len(df.columns) >= 12:
            last_col = df.columns[11]  # 第12列，索引11 (L列)
            print(f"📍 L列（最后一列）: '{last_col}'")
        else:
            # 如果列数不足12，添加新列
            print("⚠ 警告: 文件列数少于12列，将添加新列")
            last_col = "判断结果"
            df[last_col] = ""
        
        # 6. 处理每一行数据
        print(f"\n📏 开始计算距离...")
        
        total_rows = len(df)
        rows_with_distance = 0
        rows_over_500m = 0
        rows_missing_coords = 0
        
        for index, row in df.iterrows():
            # 获取左边经纬度
            coord_e = row[target_col_e]
            lon1, lat1 = parse_coordinate(coord_e)
            
            # 获取右边经纬度
            coord_j = row[target_col_j]
            lon2, lat2 = parse_coordinate(coord_j)
            
            # 如果任一坐标缺失，留空
            if lon1 is None or lat1 is None or lon2 is None or lat2 is None:
                df.at[index, last_col] = ""
                rows_missing_coords += 1
                continue
            
            # 计算距离
            distance = haversine_distance(lon1, lat1, lon2, lat2)
            rows_with_distance += 1
            
            # 判断距离是否大于500米
            if distance > 500:
                df.at[index, last_col] = "两家"
                rows_over_500m += 1
                
                # 显示前几个示例
                if rows_over_500m <= 3:
                    shop_b = row['商户名(B)'] if '商户名(B)' in df.columns else f"第{index}行"
                    shop_a = row['客户名称(A)'] if '客户名称(A)' in df.columns else f"第{index}行"
                    print(f"  ✓ {shop_b} ↔ {shop_a}: {distance:.0f}米 > 500米，标记为'两家'")
            else:
                df.at[index, last_col] = ""
        
        # 7. 保存结果
        print(f"\n💾 正在保存结果...")
        df.to_csv(result_file, index=False, encoding='utf-8-sig')
        
        # 8. 生成统计信息
        print(f"\n📊 处理完成！统计结果:")
        print(f"   总行数: {total_rows}")
        print(f"   成功计算距离的行数: {rows_with_distance}")
        print(f"   距离超过500米的行数: {rows_over_500m}")
        print(f"   缺少经纬度的行数: {rows_missing_coords}")
        print(f"   输出文件: {result_file}")
        
        # 9. 显示前几行结果
        print(f"\n📄 结果预览（前5行）:")
        print("行号 | 店铺A | 店铺B | 距离(米) | 判断结果")
        print("-" * 70)
        
        sample_count = 0
        for index, row in df.head().iterrows():
            coord_e = row[target_col_e]
            coord_j = row[target_col_j]
            lon1, lat1 = parse_coordinate(coord_e)
            lon2, lat2 = parse_coordinate(coord_j)
            
            if lon1 and lat1 and lon2 and lat2:
                distance = haversine_distance(lon1, lat1, lon2, lat2)
                result = row[last_col] if last_col in row else ""
                
                shop_b = row.get('商户名(B)', '未知B')[:20]
                shop_a = row.get('客户名称(A)', '未知A')[:20]
                
                print(f"{index+1:4d} | {shop_b:<20} | {shop_a:<20} | {distance:7.0f} | {result}")
                sample_count += 1
        
        # 10. 生成统计报告
        report_file = source_file.parent / "距离计算_统计报告.txt"
        with open(report_file, 'w', encoding='utf-8') as f:
            f.write("金华-永康同名店铺距离计算统计报告\n")
            f.write("=" * 60 + "\n")
            f.write(f"原始文件: {source_file.name}\n")
            f.write(f"结果文件: {result_file.name}\n")
            f.write(f"计算时间: {pd.Timestamp.now()}\n\n")
            
            f.write("统计信息:\n")
            f.write(f"  总行数: {total_rows}\n")
            f.write(f"  成功计算距离的行数: {rows_with_distance}\n")
            f.write(f"  距离超过500米的行数: {rows_over_500m}\n")
            f.write(f"  缺少经纬度的行数: {rows_missing_coords}\n\n")
            
            f.write("使用的列:\n")
            f.write(f"  E列（左侧经纬度）: {target_col_e}\n")
            f.write(f"  J列（右侧经纬度）: {target_col_j}\n")
            f.write(f"  L列（结果列）: {last_col}\n")
        
        print(f"\n📋 详细统计报告: {report_file}")
        
        return True
        
    except Exception as e:
        print(f"\n❌ 处理过程中发生错误:")
        print(f"错误类型: {type(e).__name__}")
        print(f"错误信息: {str(e)}")
        
        # 提供帮助信息
        print(f"\n💡 可能的原因和解决方案:")
        print(f"1. 文件可能被其他程序打开，请关闭Excel或其他编辑器")
        print(f"2. 缺少pandas库，请运行: pip install pandas")
        print(f"3. CSV格式有问题，请检查文件是否损坏")
        
        import traceback
        traceback.print_exc()
        return False

def main():
    """主函数"""
    success = calculate_distance_for_file()
    
    print(f"\n{'='*60}")
    if success:
        print("✅ 处理成功完成！")
        print("   请打开以下文件查看结果:")
        print(f"   {result_file}")
    else:
        print("❌ 处理失败")
        print("   请按照提示检查问题")
    
    # 提供运行提示
    print(f"\n💡 操作提示:")
    print(f"1. 如果未安装pandas，请在命令行运行: pip install pandas")
    print(f"2. 如果您在运行脚本时遇到问题，可能是Python环境问题")
    print(f"3. 您也可以手动在Excel中使用以下公式计算:")
    print(f'   =IF(SQRT(POWER((经度1-经度2)*111000,2) + POWER((纬度1-纬度2)*111000,2))>500,"两家","")')

if __name__ == "__main__":
    main()