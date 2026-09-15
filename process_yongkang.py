import pandas as pd
import os

# 文件路径
input_file = r"D:\WFR\visit-miniapp\TMP\金华-永康.xlsx"
output_dir = r"D:\WFR\visit-miniapp\TMP\永康市"

# 确保输出目录存在
os.makedirs(output_dir, exist_ok=True)

print(f"正在读取Excel文件: {input_file}")
print(f"输出目录: {output_dir}")

try:
    # 读取Excel文件
    xl = pd.ExcelFile(input_file)
    sheet_name = xl.sheet_names[0]
    print(f"工作表名称: {sheet_name}")
    
    # 读取数据
    df = xl.parse(sheet_name)
    print(f"成功读取 {len(df)} 行数据")
    print(f"列数: {len(df.columns)}")
    
    # 查看前几列名
    print(f"前10个列名: {list(df.columns)[:10]}")
    
    # 检查是否有"regionName"列
    region_col = None
    possible_cols = ['regionName', 'RegionName', 'regioName', '子区域', '商圈', '区域']
    
    for col in df.columns:
        if col == 'regionName':
            region_col = col
            break
        elif 'region' in col.lower():
            region_col = col
            break
        elif 'name' in col.lower() and 'region' not in col.lower():
            # 避免误选其他name列
            continue
    
    if region_col is None:
        print(f"找不到'regionName'列，所有列名:")
        for i, col in enumerate(df.columns):
            print(f"  {i+1:2}. {col}")
        # 查看是否有类似区域信息的列
        region_candidates = [col for col in df.columns if '区' in col or '域' in col]
        if region_candidates:
            region_col = region_candidates[0]
            print(f"选择 '{region_col}' 作为区域列")
    else:
        print(f"使用列 '{region_col}' 进行分组")
    
    if region_col is None:
        raise KeyError("无法找到regionName列或类似区域列")
    
    # 查看唯一的regionName值及其数量
    region_counts = df[region_col].value_counts()
    print(f"\n共有 {len(region_counts)} 个不同的 {region_col} 值")
    
    # 显示区域统计
    print("区域统计（按记录数排序）:")
    for region, count in region_counts.head(20).items():
        print(f"  {region}: {count} 条记录")
    
    if len(region_counts) > 20:
        print(f"  ... 还有 {len(region_counts) - 20} 个其他区域")
    print(f"\n总计: {df.shape[0]} 条记录")
    
    # 按regionName分组并保存为独立文件
    success_count = 0
    file_info = []
    
    for region, group_df in df.groupby(region_col):
        if len(group_df) > 0:
            # 清理区域名中的非法文件名字符
            clean_region = str(region)
            # 替换常见非法字符
            illegal_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|']
            for char in illegal_chars:
                clean_region = clean_region.replace(char, '_')
            
            # 如果区域名很长，可以适当缩短
            if len(clean_region) > 50:
                clean_region = clean_region[:50]
            
            # 处理空区域名
            if clean_region.strip() == '':
                clean_region = '无区域信息'
            
            output_file = os.path.join(output_dir, f"{clean_region}.xlsx")
            
            # 保存为Excel文件，保持原始格式
            try:
                group_df.to_excel(output_file, index=False)
                success_count += 1
                file_info.append((region, len(group_df), output_file))
                print(f"  ✓ {region}: {len(group_df)} 条记录 -> {clean_region}.xlsx")
            except Exception as e:
                print(f"  ✗ {region}: 保存失败 - {e}")
    
    print(f"\n处理完成！成功生成 {success_count} 个区域文件")
    
    # 显示文件统计信息（按记录数排序）
    print("\n文件统计信息（按记录数排序）:")
    for region, count, filepath in sorted(file_info, key=lambda x: x[1], reverse=True):
        filename = os.path.basename(filepath)
        print(f"  {region:<30} ({count:>5} 条记录) -> {filename}")
    
    # 总记录数验证
    total_exported = sum(count for _, count, _ in file_info)
    print(f"\n总记录数验证: 原始数据 {len(df)} 条，导出数据 {total_exported} 条")
    
    if total_exported < len(df):
        print(f"注意: 有 {len(df) - total_exported} 条记录未被分配（{region_col}列为空或处理失败）")
    
    # 生成统计摘要文件
    stats_file = os.path.join(output_dir, "区域统计信息.txt")
    with open(stats_file, 'w', encoding='utf-8') as f:
        f.write(f"永康市按 {region_col} 分组统计\n")
        f.write(f"="*50 + "\n")
        f.write(f"原始文件: {input_file}\n")
        f.write(f"总记录数: {len(df)}\n")
        f.write(f"不同{region_col}数量: {len(region_counts)}\n")
        f.write(f"生成的区域文件数: {success_count}\n")
        f.write(f"生成时间: {pd.Timestamp.now()}\n\n")
        
        f.write(f"区域统计（按记录数排序）:\n")
        for region, count, _ in sorted(file_info, key=lambda x: x[1], reverse=True):
            f.write(f"{region}: {count} 条记录\n")
        
        f.write(f"\n总记录数验证: {total_exported}/{len(df)}\n")
    
    print(f"\n统计信息已保存到: {stats_file}")
    
except FileNotFoundError as e:
    print(f"错误: 找不到文件 {input_file}")
    print(f"请检查文件路径是否正确")
except Exception as e:
    print(f"处理过程中出现错误: {e}")
    import traceback
    traceback.print_exc()

print("\n所有文件已保存到:", output_dir)