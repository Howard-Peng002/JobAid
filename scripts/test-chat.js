const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
(async () => {
  const cloud = createWorkBuddyCloud({
    endpoint: 'https://interview-copilot-46083.app.workbuddy.host',
    publishableKey: 'wbpk_miLM4efMAFOyQ8nH2zC8dZ_9gEGPP6UdPHAQjCYhKsa43rV2uANeN5R',
  });
  const t0 = Date.now();
  let out = '';
  try {
    for await (const chunk of cloud.llm.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: '你是面试辅助助手，回答极简。' },
        { role: 'user', content: '面试官问：请介绍一下你自己。给出一句话要点。' },
      ],
      stream: true,
      temperature: 0.6,
    })) {
      const d = chunk.choices[0]?.delta?.content;
      if (d) out += d;
    }
    console.log('CHAT OK in', Date.now() - t0, 'ms');
    console.log(out.slice(0, 300));
  } catch (e) {
    console.log('CHAT FAIL:', e && e.error ? JSON.stringify(e.error) : e.message, 'status=', e.status);
  }
})();
