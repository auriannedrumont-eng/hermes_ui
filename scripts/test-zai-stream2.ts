// Test 2 : parsing SSE manuel du stream z-ai
import ZAI from 'z-ai-web-dev-sdk';

async function testStream() {
  const zai = await ZAI.create();
  // @ts-expect-error option stream
  const stream = await zai.chat.completions.create({
    messages: [
      { role: 'assistant', content: 'Réponds en une phrase courte.' },
      { role: 'user', content: 'Dis bonjour.' },
    ],
    stream: true,
    thinking: { type: 'enabled' },
  });

  const parts: string[] = [];
  for await (const chunk of stream as any) {
    if (typeof chunk === 'string') parts.push(chunk);
    else if (chunk && typeof chunk[Symbol.iterator] === 'function') {
      // Objet indexé -> reconstituer la chaîne
      parts.push(String.fromCharCode(...Array.from(chunk, (c: any) => Number(c))));
    } else if (chunk != null) {
      parts.push(JSON.stringify(chunk));
    }
  }
  const raw = parts.join('');
  console.log('===RAW (800 premiers)===');
  console.log(raw.slice(0, 800));
}

testStream().catch((e) => {
  console.error('STREAM_FAILED', e?.message || e);
});
