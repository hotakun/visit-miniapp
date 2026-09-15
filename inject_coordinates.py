#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将客户经纬度数据注入到客户列表中
源文件：客户经纬度(1).xlsx
目标文件：客户列表-含经纬度.xlsx
将源文件中的经纬度数据注入到目标文件匹配客户的"经纬度"列
"""

import pandas as pd
import numpy as np
import os
import sys
from pathlib import Path

def main():
    print("=" * 70)
    print("客户经纬度数据注入工具")
    print("=" * 70)
    
    # 定义文件路径
    source_file = Path(r"D:\WFR\visit-miniapp\TMP\客户经纬度(1).xlsx")
    target_file = Path(r"D:\WFR\visit-miniapp\TMP\客户列表-含经纬度.xlsx")
    
    if not source_file.exists():
        print(f"❌ 错误: 源文件不存在")
        print(f"请确认文件路径: {source_file}")
        return False
    
    if not target_file.exists():
        print(f"❌ 错误: 目标文件不存在")
        print(f"请确认文件路径: {target_file}")
        return False
    
    print(f"✅ 源文件: {source_file}")
    print(f"✅ 目标文件: {target_file}")
    
    try:
        # 1. 读取源文件
        print(f"\n📖 正在读取源文件...")
        source_xl = pd.ExcelFile(source_file)
        source_sheet = source_xl.sheet_names[0]
        source_df = source_xl.parse(source_sheet)
        print(f"  读取工作表: {source_sheet}")
        print(f"  数据形状: {source_df.shape} (行数:{len(source_df)}, 列数:{len(source_df.columns)})")
        
        print(f"\n  📋 源文件列名:")
        for i, col in enumerate(source_df.columns, 1):
            print(f"    {i:2d}. {col}")
        
        # 查找源文件中的经纬度列
        source_coord_cols = []
        for col in source_df.columns:
            col_str = str(col).lower()
            if any(keyword in col_str for keyword in ['经纬度', '坐标', 'location', 'lat', 'long', 'lng', 'lon']):
                source_coord_cols.append(col)
        
        if not source_coord_cols:
            print(f"\n⚠ 警告: 源文件中未找到明显的经纬度列")
            print("  可能包含经纬度的列:")
            for col in source_df.columns:
                print(f"    - {col}")
            # 让用户选择或默认第一列
            source_coord_col = input(f"\n请输入的源文件经纬度列名: ") if False else None  # 交互模式暂时关闭
            if not source_coord_col:
                print("使用默认列名: '经纬度'")
                if '经纬度' in source_df.columns:
                    source_coord_col = '经纬度'
                else:
                    # 检查列内容是否包含经纬度格式
                    for col in source_df.columns:
                        sample = source_df[col].dropna().iloc[0] if len(source_df[col].dropna()) > 0 else ''
                        if isinstance(sample, str) and ',' in sample and len(sample.split(',')) == 2:
                            print(f"  推测列 '{col}' 可能包含经纬度数据")
                            source_coord_col = col
                            break
                    if not source_coord_col:
                        print("无法自动识别经纬度列，将使用第一列")
                        source_coord_col = source_df.columns[0]
        else:
            source_coord_col = source_coord_cols[0]
            print(f"\n✅ 找到源文件经纬度列: {source_coord_col}")
        
        # 2. 读取目标文件
        print(f"\n📖 正在读取目标文件...")
        target_xl = pd.ExcelFile(target_file)
        target_sheet = target_xl.sheet_names[0]
        target_df = target_xl.parse(target_sheet)
        print(f"  读取工作表: {target_sheet}")
        print(f"  数据形状: {target_df.shape} (行数:{len(target_df)}, 列数:{len(target_df.columns)})")
        
        print(f"\n  📋 目标文件列名:")
        for i, col in enumerate(target_df.columns, 1):
            print(f"    {i:2d}. {col}")
        
        # 查找目标文件中的经纬度列
        target_coord_cols = []
        for col in target_df.columns:
            col_str = str(col).lower()
            if any(keyword in col_str for keyword in ['经纬度', '坐标', 'location', 'lat', 'long', 'lng', 'lon']):
                target_coord_cols.append(col)
        
        if not target_coord_cols:
            print(f"\n⚠ 警告: 目标文件中未找到明显的经纬度列")
            print("  目标文件中包含的列:")
            for col in target_df.columns:
                print(f"    - {col}")
            target_coord_col = input(f"\n请输入目标文件经纬度列名: ") if False else '经纬度'  # 交互模式暂时关闭
        else:
            target_coord_col = target_coord_cols[0]
            print(f"\n✅ 找到目标文件经纬度列: {target_coord_col}")
        
        # 3. 确定匹配列（客户标识）
        print(f"\n🔍 查找匹配列...")
        
        # 查找可能的匹配列
        possible_match_cols = []
        source_col_set = set(source_df.columns)
        target_col_set = set(target_df.columns)
        common_cols = list(source_col_set.intersection(target_col_set))
        
        if common_cols:
            print(f"  两个文件共同的列: {common_cols}")
            # 优先选择客户标识列
            preferred_cols = ['客户名称', '客户名', '商户名', '商户名称', '名称', 'name', '电话', '手机', 'phone', '地址', 'address']
            for pref in preferred_cols:
                for col in common_cols:
                    if pref in str(col).lower():
                        match_col = col
                        break
                else:
                    continue
                break
            else:
                # 没有找到首选列，使用第一个共同列
                match_col = common_cols[0]
        else:
            print(f"  两个文件没有共同的列名")
            print(f"  源文件列: {list(source_df.columns)}")
            print(f"  目标文件列: {list(target_df.columns)}")
            match_col = input(f"\n请输入匹配列名（在源文件和目标文件中都存在）: ") if False else None
        
        if match_col:
            print(f"\n✅ 使用匹配列: {match_col}")
        else:
            print("❌ 无法确定匹配列，无法继续")
            return False
        
        # 4. 数据合并注入
        print(f"\n🔄 正在注入经纬度数据...")
        
        # 准备源数据字典：{匹配键: 经纬度}
        source_dict = {}
        missing_count = 0
        total_source = len(source_df)
        
        for idx, row in source_df.iterrows():
            match_key = row[match_col]
            coord_value = row[source_coord_col]
            
            if pd.isna(match_key):
                missing_count += 1
                continue
                
            # 将匹配键转换为字符串用于比较
            match_key_str = str(match_key).strip()
            if match_key_str:
                source_dict[match_key_str] = coord_value
        
        print(f"  源文件有效数据: {len(source_dict)}/{total_source} (缺失匹配键: {missing_count})")
        
        # 注入目标文件
        updated_count = 0
        total_target = len(target_df)
        
        for idx, row in target_df.iterrows():
            match_key = row[match_col]
            if pd.isna(match_key):
                continue
                
            match_key_str = str(match_key).strip()
            if match_key_str in source_dict:
                target_df.at[idx, target_coord_col] = source_dict[match_key_str]
                updated_count += 1
        
        # 5. 保存结果
        output_file = Path(r"D:\WFR\visit-miniapp\TMP\客户列表-含经纬度_已注入.xlsx")
        print(f"\n💾 正在保存注入结果...")
        target_df.to_excel(output_file, index=False)
        print(f"✅ 结果已保存到: {output_file}")
        
        # 6. 生成统计报告
        print(f"\n📊 注入结果统计:")
        print(f"  - 源文件总行数: {total_source}")
        print(f"  - 目标文件总行数: {total_target}")
        print(f"  - 成功匹配并注入: {updated_count}")
        print(f"  - 匹配成功率: {updated_count/total_target*100:.1f}%")
        
        # 显示示例
        print(f"\n📄 注入效果示例（前5个匹配项）:")
        sample_count = 0
        for idx, row in target_df.iterrows():
            if sample_count >= 5:
                break
            match_key = row[match_col]
            if pd.isna(match_key):
                continue
                
            match_key_str = str(match_key).strip()
            if match_key_str in source_dict:
                before_value = '未知'  # 无法知道原值，除非保存副本
                after_value = source_dict[match_key_str]
                print(f"  {sample_count+1}. {match_key_str}: {after_value}")
                sample_count += 1
        
        # 生成详细报告
        report_file = Path(r"D:\WFR\visit-miniapp\TMP\经纬度注入报告.txt")
        with open(report_file, 'w', encoding='utf-8') as f:
            f.write("客户经纬度数据注入报告\n")
            f.write("=" * 60 + "\n")
            f.write(f"源文件: {source_file.name}\n")
            f.write(f"目标文件: {target_file.name}\n")
            f.write(f"输出文件: {output_file.name}\n")
            f.write(f"处理时间: {pd.Timestamp.now()}\n\n")
            
            f.write("配置信息:\n")
            f.write(f"  源文件经纬度列: {source_coord_col}\n")
            f.write(f"  目标文件经纬度列: {target_coord_col}\n")
            f.write(f"  匹配列: {match_col}\n\n")
            
            f.write("处理统计:\n")
            f.write(f"  源文件总行数: {total_source}\n")
            f.write(f"  目标文件总行数: {total_target}\n")
            f.write(f"  成功注入数量: {updated_count}\n")
            f.write(f"  匹配成功率: {updated_count/total_target*100:.1f}%\n\n")
            
            f.write("详细匹配列表（前50个）:\n")
            f.write("-" * 80 + "\n")
            count = 0
            for idx, row in target_df.iterrows():
                if count >= 50:
                    break
                match_key = row[match_col]
                if pd.isna(match_key):
                    continue
                    
                match_key_str = str(match_key).strip()
                if match_key_str in source_dict:
                    coord_value = source_dict[match_key_str]
                    f.write(f"{match_key_str}: {coord_value}\n")
                    count += 1
        
        print(f"\n📋 详细报告已保存到: {report_file}")
        print(f"\n✅ 经纬度数据注入完成！")
        print(f"   原始目标文件: {target_file}")
        print(f"   注入后文件: {output_file}")
        print(f"   详细报告: {report_file}")
        
        return True
        
    except Exception as e:
        print(f"\n❌ 处理过程中出错: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = main()
    
    if not success:
        print(f"\n💡 建议:")
        print(f"1. 检查两个Excel文件是否正确")
        print(f"2. 确认文件中包含匹配的客户标识列")
        print(f"3. 确保文件没有被其他程序打开")
        print(f"4. 如果缺少pandas库，运行: pip install pandas openpyxl")
    
    print(f"\n{'='*70}")
    print("处理完成")
    print("=" * 70)