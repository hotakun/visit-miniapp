import pandas as pd
import os
import time

# 配置
input_dir = r"D:\WFR\visit-miniapp\TMP\fenqu"
processed_dir = r"D:\WFR\visit-miniapp\TMP\fenqu\xihu"  # 西湖区已处理目录
region_col = 'regionName'  # 分割列名

print("批量处理所有行政区的区域细分")
print("=" * 60)
print(f"输入目录: {input_dir}")
print(f"已处理目录（西湖区）: {processed_dir}")

# 跳过文件列表（已处理的区域）
skip_files = ['西湖区.xlsx']

# 获取所有行政区Excel文件
all_files = [f for f in os.listdir(input_dir) if f.endswith('.xlsx')]
print(f"\n输入目录中有 {len(all_files)} 个Excel文件")

# 去掉已处理的文件
files_to_process = [f for f in all_files if f not in skip_files]
print(f"需要处理的文件数: {len(files_to_process)}")
print(f"需要处理的文件: {sorted(files_to_process)}")

# 检查海盐县和温岭市文件是否存在
special_small_files = ['海盐县.xlsx', '温岭市.xlsx', '杭州.xlsx']
for special_file in special_small_files:
    if special_file in files_to_process:
        print(f"注意: {special_file} 只有少量数据（1-41条），可能没有足够的regionName数据")

# 全局统计
total_regions_processed = 0
total_files_generated = 0
region_stats = []

# 开始批量处理
start_time = time.time()

for input_file in sorted(files_to_process):
    try:
        file_start_time = time.time()
        input_path = os.path.join(input_dir, input_file)
        
        # 从文件名提取区域名（去掉扩展名）
        region_name = os.path.splitext(input_file)[0]
        
        # 创建输出目录
        output_dir = os.path.join(input_dir, region_name)
        os.makedirs(output_dir, exist_ok=True)
        
        print(f"\n{'='*60}")
        print(f"处理文件: {input_file}")
        print(f"区域: {region_name}")
        print(f"输出目录: {output_dir}")
        
        # 读取Excel文件
        xl = pd.ExcelFile(input_path)
        sheet_name = xl.sheet_names[0]
        df = xl.parse(sheet_name)
        
        print(f"成功读取 {len(df)} 行数据")
        
        # 检查是否有regionName列
        if region_col not in df.columns:
            # 尝试查找类似的列
            possible_cols = [col for col in df.columns if 'region' in col.lower() or 'name' in col.lower()]
            if possible_cols:
                region_col_to_use = possible_cols[0]
                print(f"注意: 找不到'{region_col}'列，使用 '{region_col_to_use}' 替代")
            else:
                print(f"警告: {input_file} 中没有regionName列或类似列，跳过此文件")
                print("列名列表:")
                for i, col in enumerate(df.columns):
                    print(f"  {i+1:2}. {col}")
                region_stats.append({
                    '区域': region_name,
                    '原始记录数': len(df),
                    '处理状态': '失败：无regionName列',
                    '生成文件数': 0
                })
                continue
        else:
            region_col_to_use = region_col
        
        # 查看regionName分布
        region_counts = df[region_col_to_use].value_counts()
        unique_regions = len(region_counts)
        print(f"共有 {unique_regions} 个不同的 {region_col_to_use} 值")
        
        # 显示区域统计前10名
        if unique_regions > 0:
            print(f"【TOP 10 regionName分布】:")
            top_count = min(10, unique_regions)
            for i, (region, count) in enumerate(region_counts.head(top_count).items()):
                print(f"  {i+1:2}. {region}: {count} 条记录")
            if unique_regions > 10:
                print(f"  ... 还有 {unique_regions - 10} 个其他区域")
        
        # 按regionName分组并保存为独立文件
        success_count = 0
        success_records = 0
        problem_regions = []
        
        for region, group_df in df.groupby(region_col_to_use):
            if len(group_df) > 0:
                # 清理区域名中的非法文件名字符
                clean_region = str(region)
                
                # 替换常见非法字符
                illegal_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
                for char in illegal_chars:
                    clean_region = clean_region.replace(char, '_')
                
                # 去除首尾空格
                clean_region = clean_region.strip()
                
                # 处理空区域名
                if clean_region == '':
                    clean_region = '无区域信息'
                
                # 如果区域名很长，可以适当缩短
                if len(clean_region) > 100:
                    clean_region = clean_region[:100] + "..."
                
                output_file = os.path.join(output_dir, f"{clean_region}.xlsx")
                
                # 保存为Excel文件
                try:
                    group_df.to_excel(output_file, index=False)
                    success_count += 1
                    success_records += len(group_df)
                    
                    # 只显示少量信息，避免输出过多
                    if success_count <= 5 or success_count % 10 == 0:
                        print(f"  ✓ {region}: {len(group_df)} 条记录 -> {clean_region}.xlsx")
                        
                except Exception as e:
                    problem_regions.append((region, str(e)))
        
        print(f"处理完成！生成 {success_count} 个区域文件，覆盖 {success_records}/{len(df)} 条记录")
        
        if problem_regions:
            print(f"警告: {len(problem_regions)} 个区域保存失败")
            for region, error in problem_regions[:3]:  # 只显示前3个错误
                print(f"  ✗ {region}: {error}")
            if len(problem_regions) > 3:
                print(f"  ... 还有 {len(problem_regions) - 3} 个错误未显示")
        
        # 记录统计信息
        region_stats.append({
            '区域': region_name,
            '原始记录数': len(df),
            'regionName数量': unique_regions,
            '生成文件数': success_count,
            '处理状态': '成功' if success_records == len(df) else f'部分成功 ({success_records}/{len(df)})'
        })
        
        total_regions_processed += 1
        total_files_generated += success_count
        
        # 文件处理时间
        file_time = time.time() - file_start_time
        print(f"处理耗时: {file_time:.2f} 秒")
        
        # 生成简要统计文件
        stats_file = os.path.join(output_dir, "区域统计信息.txt")
        try:
            with open(stats_file, 'w', encoding='utf-8') as f:
                f.write(f"{region_name} 按 {region_col_to_use} 分组统计\n")
                f.write(f"="*50 + "\n")
                f.write(f"原始文件: {input_file}\n")
                f.write(f"原始记录数: {len(df)}\n")
                f.write(f"不同regionName数量: {unique_regions}\n")
                f.write(f"生成的区域文件数: {success_count}\n")
                f.write(f"处理时间: {pd.Timestamp.now()}\n")
                f.write(f"总覆盖记录数: {success_records}/{len(df)}\n\n")
                
                f.write(f"{region_col_to_use}分布:\n")
                for region, count in region_counts.head(50).items():
                    f.write(f"{region}: {count} 条记录\n")
                
                if unique_regions > 50:
                    f.write(f"... 还有 {unique_regions - 50} 个区域\n")
            
            print(f"统计信息已保存到: {stats_file}")
        except Exception as e:
            print(f"生成统计文件失败: {e}")
        
    except Exception as e:
        print(f"处理文件 {input_file} 时出现错误: {e}")
        import traceback
        traceback.print_exc()
        region_stats.append({
            '区域': input_file,
            '原始记录数': '未知',
            'regionName数量': '失败',
            '生成文件数': 0,
            '处理状态': f'处理失败: {str(e)}'
        })

# 整体统计
total_time = time.time() - start_time
print(f"\n{'='*60}")
print(f"批量处理完成！")
print(f"{'='*60}")

# 生成整体统计
print("\n【整体处理统计】")
print(f"总处理区域数: {len(files_to_process)}")
print(f"成功处理区域数: {total_regions_processed}")
print(f"总耗时: {total_time:.2f} 秒")
print(f"总生成文件数: {total_files_generated}")

# 显示详细统计表
print("\n【各区域处理详情】")
print(f"{'区域':<10} {'原始记录数':>10} {'regionName数':>12} {'生成文件数':>10} {'状态':<20}")
print(f"{'-'*70}")
for stat in sorted(region_stats, key=lambda x: x.get('原始记录数', 0) if isinstance(x.get('原始记录数', 0), (int, float)) else 0, reverse=True):
    region = stat['区域']
    orig_count = stat.get('原始记录数', 'N/A')
    region_count = stat.get('regionName数量', 'N/A')
    file_count = stat.get('生成文件数', 0)
    status = stat.get('处理状态', '未知')
    
    print(f"{region:<10} {str(orig_count):>10} {str(region_count):>12} {str(file_count):>10} {status:<20}")

# 保存整体统计报告
summary_file = os.path.join(input_dir, "批量处理总统计.txt")
try:
    with open(summary_file, 'w', encoding='utf-8') as f:
        f.write(f"杭州美食店铺区域细分 - 批量处理总统计\n")
        f.write(f"="*60 + "\n")
        f.write(f"处理时间: {pd.Timestamp.now()}\n")
        f.write(f"总处理区域数: {len(files_to_process)}\n")
        f.write(f"成功处理区域数: {total_regions_processed}\n")
        f.write(f"总生成子区域文件数: {total_files_generated}\n")
        f.write(f"总耗时: {total_time:.2f} 秒\n\n")
        
        f.write(f"各区域处理详情:\n")
        f.write(f"{'区域':<10} {'原始记录数':>10} {'regionName数':>12} {'生成文件数':>10} {'状态':<20}\n")
        f.write(f"{'-'*70}\n")
        for stat in sorted(region_stats, key=lambda x: x.get('原始记录数', 0) if isinstance(x.get('原始记录数', 0), (int, float)) else 0, reverse=True):
            region = stat['区域']
            orig_count = stat.get('原始记录数', 'N/A')
            region_count = stat.get('regionName数量', 'N/A')
            file_count = stat.get('生成文件数', 0)
            status = stat.get('处理状态', '未知')
            f.write(f"{region:<10} {str(orig_count):>10} {str(region_count):>12} {str(file_count):>10} {status:<20}\n")
    
    print(f"\n详总统计信息已保存到: {summary_file}")
except Exception as e:
    print(f"保存总体统计文件失败: {e}")

print(f"\n所有文件已处理完成！")
print(f"详情请查看各行政区分目录和 {summary_file}")