const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');
(async () => {
  const cloud = createWorkBuddyCloud({
    endpoint: 'https://interview-copilot-46083.app.workbuddy.host',
    publishableKey: 'wbpk_miLM4efMAFOyQ8nH2zC8dZ_9gEGPP6UdPHAQjCYhKsa43rV2uANeN5R',
  });
  try {
    const models = await cloud.llm.models.list();
    console.log('MODELS OK:', models.length);
    for (const m of models.slice(0, 12)) console.log(' -', m.id, '|', m.name, '| disabled=', m.disabled);
  } catch (e) {
    console.log('MODELS FAIL:', e && e.error ? JSON.stringify(e.error) : e.message, 'status=', e.status);
  }
})();
