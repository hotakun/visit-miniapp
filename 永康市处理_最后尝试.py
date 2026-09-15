#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
永康市regionName分组处理 - 最后尝试
如果此脚本可以运行，请直接运行它
"""

import os
import pandas as pd
import traceback
from pathlib import Path

def main():
    print("开始处理永康市Excel文件...")
    
    # 定义路径
    input_file = Path(r"D:\WFR\visit-miniapp\TMP\金华-永康.xlsx")
    output_dir = Path(r"D:\WFR\visit-miniapp\TMP\永康市")
    
    print(f"输入文件: {input_file}")
    print(f"输出目录: {output_dir}")
    
    # 检查文件是否存在
    if not input_file.exists():
        print(f"错误: 文件不存在于路径 {input_file}")
        print("请确认文件路径正确")
        return
    
    print("✓ 输入文件存在")
    
    # 创建输出目录
    output_dir.mkdir(parents=True, exist_ok=True)
    print("✓ 输出目录已创建")
    
    try:
        # 读取Excel文件
        print("正在读取Excel文件...")
        df = pd.read_excel(input_file)
        print(f"成功读取 {len(df)} 行数据")
        print(f"数据列数: {len(df.columns)}")
        
        # 显示列名
        print("\n数据列名:")
        for i, col in enumerate(df.columns, 1):
            print(f"  {i:2d}. {col}")
        
        # 查找regionName列
        region_col = None
        possible_columns = ['regionName', 'RegionName', 'regioName', '子区域', '商圈', '区域']
        
        for col in df.columns:
            if col == 'regionName':
                region_col = col
                break
            elif col.lower() == 'regionname':
                region_col = col
                break
        
        if region_col:
            print(f"\n✓ 找到区域列: {region_col}")
        else:
            # 查找含有"region"的列
            for col in df.columns:
                if 'region' in col.lower():
                    region_col = col
                    print(f"\n⚠ 使用相似列作为区域列: {region_col}")
                    break
        
        if not region_col:
            print(f"\n❌ 错误: 找不到regionName列，请从以下列中选择:")
            for i, col in enumerate(df.columns, 1):
                print(f"  {i:2d}. {col}")
            return
        
        # 按区域分组
        print(f"\n正在按 '{region_col}' 分组...")
        grouped = df.groupby(region_col)
        region_count = len(grouped)
        print(f"共发现 {region_count} 个不同区域")
        
        # 统计并保存
        success_count = 0
        total_records = 0
        stats = []
        
        print("\n开始保存各区域文件...")
        for region_name, group_data in grouped:
            records = len(group_data)
            
            # 清理文件名
            safe_name = str(region_name).strip()
            # 替换非法字符
            illegal = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
            for ch in illegal:
                safe_name = safe_name.replace(ch, '_')
            
            if safe_name == '':
                safe_name = '无区域信息'
            
            # 生成输出文件名
            output_file = output_dir / f"{safe_name}.xlsx"
            
            try:
                group_data.to_excel(output_file, index=False)
                success_count += 1
                total_records += records
                stats.append((region_name, records, output_file))
                
                if success_count <= 5 or success_count % 10 == 0:
                    print(f"  ✓ {region_name}: {records} 条记录")
                    
            except Exception as e:
                print(f"  ✗ {region_name}: 保存失败 - {str(e)[:50]}")
        
        # 生成统计报告
        stats_file = output_dir / "永康市_分组统计.txt"
        with open(stats_file, 'w', encoding='utf-8') as f:
            f.write("永康市数据分组统计报告\n")
            f.write("=" * 50 + "\n")
            f.write(f"原始文件: {input_file.name}\n")
            f.write(f"分组列: {region_col}\n")
            f.write(f"总记录数: {len(df)}\n")
            f.write(f"不同区域数: {region_count}\n")
            f.write(f"已生成文件数: {success_count}\n")
            f.write(f"已处理记录: {total_records}/{len(df)}\n\n")
            
            f.write("各区域详细统计:\n")
            f.write("-" * 40 + "\n")
            for region, count, filepath in sorted(stats, key=lambda x: x[1], reverse=True):
                f.write(f"{region}: {count} 条记录 -> {filepath.name}\n")
        
        # 显示总结
        print(f"\n{'='*50}")
        print("处理完成！")
        print(f"成功生成 {success_count} 个区域文件")
        print(f"覆盖 {total_records}/{len(df)} 条记录")
        
        if total_records < len(df):
            print(f"有 {len(df) - total_records} 条记录未处理")
        
        print(f"\n📊 统计报告已保存到: {stats_file}")
        
        # 显示文件示例
        if stats:
            print("\n📁 示例文件（记录数前10名）:")
            for region, count, filepath in sorted(stats, key=lambda x: x[1], reverse=True)[:10]:
                print(f"  • {region}: {count} 条记录 -> {filepath.name}")
        
        print(f"\n✅ 所有文件已保存到: {output_dir}")
        
    except Exception as e:
        print(f"\n❌ 处理过程中出错: {str(e)}")
        traceback.print_exc()
        print("\n请检查以下可能的问题:")
        print("1. Excel文件是否损坏")
        print("2. 是否安装了pandas和openpyxl库")
        print("3. 文件路径是否正确")
        print("4. Excel文件是否被其他程序锁定")

if __name__ == "__main__":
    main()

print("\n如果此脚本无法运行，请尝试:")
print("1. 打开命令提示符 (cmd)")
print("2. 切换到目录: cd /d D:\\WFR\\visit-miniapp")
print("3. 运行: python 永康市处理_最后尝试.py")
print("4. 如果缺少库，运行: pip install pandas openpyxl")