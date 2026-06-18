# fix-final-msg-eaten-by-toolcall

修复 agent 结论文本后跟收尾型 toolcall(如 TodoWrite)被判成中间叙述、加上被打断走 finally 丢弃，导致最终结果消息不发送的问题
