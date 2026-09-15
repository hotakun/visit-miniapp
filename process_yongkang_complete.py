#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
永康市regionName分组处理脚本
将金华-永康.xlsx按regionName列分组保存到永康市目录
"""

import pandas as pd
import os
import sys
from pathlib import Path

def main():
    # 文件路径
    input_file = Path(r"D:\WFR\visit-miniapp\TMP\金华-永康.xlsx")
    output_dir = Path(r"D:\WFR\visit-miniapp\TMP\永康市")
    
    print("=" * 60)
    print("永康市regionName分组处理")
    print("=" * 60)
    
    # 1. 检查输入文件是否存在
    if not input_file.exists():
        print(f"错误: 输入文件不存在")
        print(f"路径: {input_file}")
        sys.exit(1)
    
    print(f"✓ 输入文件: {input_file}")
    print(f"✓ 输出目录: {output_dir}")
    
    # 2. 创建输出目录
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"✓ 输出目录已创建")
    
    try:
        # 3. 读取Excel文件
        print(f"正在读取Excel文件...")
        xl = pd.ExcelFile(input_file)
        sheet_name = xl.sheet_names[0]
        print(f"✓ 工作表: {sheet_name}")
        
        # 读取完整数据
        df = pd.read_excel(input_file, sheet_name=sheet_name)
        print(f"✓ 成功读取 {len(df):,} 行数据")
        print(f"✓ 列数: {len(df.columns)}")
        
        # 显示完整列名
        print(f"\n列名列表:")
        for i, col in enumerate(df.columns, 1):
            print(f"  {i:2d}. {col}")
        
        # 4. 查找regionName列
        region_col = None
        if 'regionName' in df.columns:
            region_col = 'regionName'
            print(f"\n✓ 找到 'regionName' 列")
        else:
            # 尝试模糊匹配
            possible_cols = []
            for col in df.columns:
                col_lower = col.lower()
                if 'region' in col_lower:
                    possible_cols.append(col)
            
            if possible_cols:
                region_col = possible_cols[0]
                print(f"\n⚠ 未找到 'regionName' 列，使用 '{region_col}' 替代")
            else:
                # 显示所有可能包含区域信息的列
                region_candidates = [col for col in df.columns if any(keyword in col.lower() for keyword in ['区', '域', 'name', '商圈', '地点'])]
                if region_candidates:
                    print(f"\n❓ 未找到regionName列，请从以下列中选择:")
                    for i, col in enumerate(region_candidates, 1):
                        print(f"  {i}. {col}")
                    
                    # 尝试自动选择
                    region_col = region_candidates[0]
                    print(f"自动选择 '{region_col}' 作为区域列")
                else:
                    print(f"\n❌ 错误: 找不到区域信息列")
                    print("数据列:")
                    for i, col in enumerate(df.columns, 1):
                        print(f"  {i:2d}. {col}")
                    sys.exit(1)
        
        # 5. 分析regionName分布
        print(f"\n{'='*40}")
        print(f"按 '{region_col}' 统计:")
        region_counts = df[region_col].value_counts()
        print(f"共有 {len(region_counts)} 个不同的区域")
        
        # 显示TOP 15区域分布
        print(f"\n【前15名区域分布】:")
        for i, (region, count) in enumerate(region_counts.head(15).items(), 1):
            print(f"  #{i:2d} {region}: {count:,} 条记录")
        
        if len(region_counts) > 15:
            other_count = region_counts[15:].sum()
            print(f"  其他: {other_count:,} 条记录 ({len(region_counts)-15} 个区域)")
        
        # 6. 按regionName分组保存
        print(f"\n{'='*40}")
        print("开始按区域分组保存...")
        
        total_files = 0
        total_records_exported = 0
        file_stats = []
        
        for region, group_df in df.groupby(region_col):
            if len(group_df) > 0:
                # 清理文件名
                region_str = str(region)
                
                # 替换非法字符
                illegal_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
                for char in illegal_chars:
                    region_str = region_str.replace(char, '_')
                
                # 处理空值或过长
                if region_str.strip() == '':
                    region_str = '空区域或未分类'
                
                if len(region_str) > 100:
                    region_str = region_str[:100] + "..."
                
                # 保存文件
                output_file = output_dir / f"{region_str}.xlsx"
                try:
                    group_df.to_excel(output_file, index=False)
                    total_files += 1
                    total_records_exported += len(group_df)
                    file_stats.append((region_str, len(group_df), output_file))
                    
                    # 显示部分进度
                    if total_files <= 5 or total_files % 10 == 0:
                        print(f"  ✓ {region}: {len(group_df):,} 条记录 -> {output_file.name}")
                        
                except Exception as e:
                    print(f"  ✗ {region}: 保存失败 - {str(e)[:50]}")
        
        # 7. 结果统计
        print(f"\n{'='*40}")
        print("处理完成！")
        print(f"{'='*40}")
        
        print(f"✓ 生成的区域文件数: {total_files}")
        print(f"✓ 成功导出的记录数: {total_records_exported:,}/{len(df):,}")
        
        if total_records_exported < len(df):
            missing = len(df) - total_records_exported
            print(f"⚠ 注意: 有 {missing} 条记录未成功导出")
        
        # 8. 生成统计报告
        stats_file = output_dir / "永康市_区域统计报告.txt"
        with open(stats_file, 'w', encoding='utf-8') as f:
            f.write(f"永康市数据按 {region_col} 分组统计报告\n")
            f.write("="*60 + "\n")
            f.write(f"原始文件: {input_file.name}\n")
            f.write(f"原始记录数: {len(df):,}\n")
            f.write(f"分组列: '{region_col}'\n")
            f.write(f"不同区域数量: {len(region_counts)}\n")
            f.write(f"生成的文件数: {total_files}\n")
            f.write(f"成功导出记录: {total_records_exported:,}/{len(df):,}\n")
            f.write(f"处理时间: {pd.Timestamp.now()}\n\n")
            
            f.write(f"各区域详细统计（按记录数降序排列）:\n")
            f.write("-"*50 + "\n")
            for region, count, filepath in sorted(file_stats, key=lambda x: x[1], reverse=True):
                filename = filepath.name
                f.write(f"{region}: {count:,} 条记录 -> {filename}\n")
        
        print(f"\n📊 详细统计报告已保存到: {stats_file}")
        
        # 9. 显示处理摘要
        print(f"\n{'='*60}")
        print("处理摘要:")
        print(f"- 输入文件: {input_file.name}")
        print(f"- 区域数量: {len(region_counts)} 个")
        print(f"- 生成文件: {total_files} 个Excel文件")
        print(f"- 保存目录: {output_dir}")
        
        # 显示示例文件
        if file_stats:
            print(f"\n📁 示例文件（前10个）:")
            for region, count, filepath in sorted(file_stats, key=lambda x: x[1], reverse=True)[:10]:
                print(f"  • {region}: {count:,} 条记录 -> {filepath.name}")
        
        print(f"\n✅ 所有文件已成功保存到: {output_dir}")
        
    except Exception as e:
        print(f"\n❌ 处理过程中发生错误:")
        print(f"错误信息: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()