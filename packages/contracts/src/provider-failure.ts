/** OpenAI's generic server-side failure. It clears on retry and is not an account or quota problem. */
export function isOpenAiRequestProcessingFailure(text: string): boolean {
  return /an error occurred while processing your request/i.test(text);
}
