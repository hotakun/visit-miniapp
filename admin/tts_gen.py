# 微软 edge-tts 语音合成（云希男声）：从 UTF-8 文本文件读取内容，输出 mp3
# 用法：python tts_gen.py <text.txt> <out.mp3>（避免命令行中文编码问题）
import sys
import asyncio
import edge_tts

VOICE = 'zh-CN-YunxiNeural'


async def main():
    text = open(sys.argv[1], encoding='utf-8').read().strip()
    await edge_tts.Communicate(text, VOICE).save(sys.argv[2])


if __name__ == '__main__':
    asyncio.run(main())
