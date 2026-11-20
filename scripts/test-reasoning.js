const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
const CLOUD = {
  endpoint: 'https://interview-copilot-46083.app.workbuddy.host',
  publishableKey: 'wbpk_miLM4efMAFOyQ8nH2zC8dZ_9gEGPP6UdPHAQjCYhKsa43rV2uANeN5R',
};

(async () => {
  const cloud = createWorkBuddyCloud(CLOUD);
  for (const model of ['deepseek-v4.1-flash', 'deepseek-v4-pro']) {
    let content = 0;
    let reasoning = 0;
    let sample = '';
    const t0 = Date.now();
    let firstTokenMs = 0;
    try {
      for await (const chunk of cloud.llm.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: '你是面试辅助助手，回答极简。' },
          { role: 'user', content: '什么是 CAP 定理？两行内说清。' },
        ],
        stream: true,
      })) {
        const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (d && d.reasoning_content) {
          if (!reasoning) firstTokenMs = Date.now() - t0;
          reasoning += d.reasoning_content.length;
          if (!sample) sample = d.reasoning_content.slice(0, 50);
        }
        if (d && d.content) {
          if (!content) firstTokenMs = firstTokenMs || Date.now() - t0;
          content += d.content.length;
        }
      }
      console.log(
        `${model}: content=${content}字 reasoning=${reasoning}字 首包=${firstTokenMs}ms 总=${Date.now() - t0}ms`
      );
      if (sample) console.log('   reasoning 样例:', JSON.stringify(sample));
    } catch (e) {
      console.log(model, '失败:', (e.error && e.error.code) || e.message);
    }
  }
})();
