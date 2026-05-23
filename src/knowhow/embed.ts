import OpenAI from "openai";

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

export function embeddingsEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Devuelve embeddings o `null` para cada input cuando no hay API key.
 * Asi el resto del codigo no necesita ramificarse: siempre recibe arreglo.
 */
export async function embedMany(texts: string[]): Promise<(number[] | null)[]> {
  const client = getClient();
  if (!client || texts.length === 0) {
    return texts.map(() => null);
  }
  const res = await client.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding as number[]);
}

export async function embedOne(text: string): Promise<number[] | null> {
  const [v] = await embedMany([text]);
  return v ?? null;
}
