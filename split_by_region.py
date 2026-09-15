import pandas as pd
import os

# 文件路径
input_file = r"D:\WFR\visit-miniapp\TMP\浙江-杭州.xlsx"
output_dir = r"D:\WFR\visit-miniapp\TMP\fenqu"

# 确保输出目录存在
os.makedirs(output_dir, exist_ok=True)

print(f"正在读取Excel文件: {input_file}")
print(f"输出目录: {output_dir}")

# 读取Excel文件
try:
    # 先读取sheet名
    xl = pd.ExcelFile(input_file)
    sheet_name = xl.sheet_names[0]
    print(f"工作表名称: {sheet_name}")
    
    # 一次性读取整个Excel文件
    print("读取数据...")
    df = xl.parse(sheet_name)
    print(f"成功读取 {len(df)} 行数据")
    print(f"列数: {len(df.columns)}")
    print(f"列名: {list(df.columns)}")
    
    # 检查是否有"行政区"列
    if '行政区' not in df.columns:
        # 尝试查找类似的列（可能是繁体或其他名称）
        possible_cols = [col for col in df.columns if '政区' in col or '区' in col]
        print(f"找不到'行政区'列，可能的列有: {possible_cols}")
        if possible_cols:
            region_col = possible_cols[0]
            print(f"使用 '{region_col}' 作为区域列")
        else:
            raise KeyError("无法找到行政区列")
    else:
        region_col = '行政区'
    
    print(f"使用列 '{region_col}' 进行区域划分")
    
    # 查看唯一的区域值
    regions = df[region_col].dropna().unique()
    print(f"共有 {len(regions)} 个不同的行政区")
    print(f"区域列表: {regions[:20]}")  # 只显示前20个
    
    # 按区域分组并保存为独立文件
    success_count = 0
    file_info = []
    
    for region in regions:
        # 过滤该区域的数据
        region_df = df[df[region_col] == region].copy()
        
        if len(region_df) > 0:
            # 生成文件名：区域名.xlsx
            # 清理区域名中的非法文件名字符
            clean_region = str(region).replace('/', '_').replace('\\', '_').replace(':', '_').replace('*', '_').replace('?', '_').replace('"', '_').replace('<', '_').replace('>', '_').replace('|', '_')
            output_file = os.path.join(output_dir, f"{clean_region}.xlsx")
            
            # 保存为Excel文件，保持原始格式
            try:
                region_df.to_excel(output_file, index=False)
                success_count += 1
                file_info.append((region, len(region_df), output_file))
                print(f"  ✓ {region}: {len(region_df)} 条记录 -> {clean_region}.xlsx")
            except Exception as e:
                print(f"  ✗ {region}: 保存失败 - {e}")
    
    print(f"\n处理完成！成功生成 {success_count} 个区域文件")
    
    # 显示文件统计信息
    print("\n文件统计信息:")
    for region, count, filepath in sorted(file_info, key=lambda x: x[1], reverse=True):
        filename = os.path.basename(filepath)
        print(f"  {region:<15} ({count:>5} 条记录) -> {filename}")
    
    # 总记录数验证
    total_exported = sum(count for _, count, _ in file_info)
    print(f"\n总记录数验证: 原始数据 {len(df)} 条，导出数据 {total_exported} 条")
    
    if total_exported != len(df):
        print(f"注意: 有 {len(df) - total_exported} 条记录没有区域信息（'行政区'列为空）")
        
except Exception as e:
    print(f"处理过程中出现错误: {e}")
    import traceback
    traceback.print_exc()

print("\n所有文件已保存到:", output_dir)