// Test du SDK z-ai : support streaming + reasoning
import ZAI from 'z-ai-web-dev-sdk';

async function testStream() {
  const zai = await ZAI.create();
  // @ts-expect-error test signature optionnelle stream
  const stream = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: 'Réponds en une phrase.' },
      { role: 'user', content: 'Dis bonjour.' },
    ],
    stream: true,
    thinking: { type: 'enabled' },
  });

  if (typeof (stream as AsyncIterable)[Symbol.asyncIterator] !== 'function') {
    console.log('NO_ASYNC_ITERATOR');
    console.log('RAW:', JSON.stringify(stream).slice(0, 500));
    return;
  }

  let text = '';
  let reasoning = '';
  for await (const chunk of stream as any) {
    const delta = chunk?.choices?.[0]?.delta;
    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
    if (delta?.content) text += delta.content;
    console.log('CHUNK:', JSON.stringify(chunk).slice(0, 200));
  }
  console.log('===TEXT===', text);
  console.log('===REASONING===', reasoning.slice(0, 200));
}

testStream().catch((e) => {
  console.error('STREAM_FAILED', e?.message || e);
});
