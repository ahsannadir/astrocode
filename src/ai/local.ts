import type {
  AIProvider,
  ChatMessage,
  StreamOptions,
} from '../types.js';

/**
 * Offline demo provider. Used automatically when no API key is set or
 * when --demo is passed, so the full agentic pipeline (streaming text +
 * tool calls) is visible without any credentials or network access.
 *
 * A couple of magical keywords trigger a real tool call to show the loop.
 */
export class LocalProvider implements AIProvider {
  readonly kind = 'local' as const;
  readonly model: string;
  private initialized = false;

  constructor(model: string) {
    this.model = model;
  }

  async streamComplete(options: StreamOptions): Promise<ChatMessage> {
    const lastUser = [...options.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';
    const lower = prompt.toLowerCase();

    await this.sleep(80);

    // Exercise the tool pipeline so the reviewer sees tool cards.
    const toolTriggers =
      /(^|\s)(list|ls|dir|tree|run|execute|shell|grep|search|show.?dir)/;
    if (!this.initialized || toolTriggers.test(lower)) {
      this.initialized = true;

      if (/(list|ls|dir|tree)/.test(lower) && !/(run|execute)/.test(lower)) {
        // Emit some thinking text, then a tool call.
        for (const w of ['Let me look at the workspace…']) {
          for (const ch of w) {
            options.onToken({ type: 'text', text: ch });
            await this.sleep(8);
          }
        }
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'local_listdir',
              name: 'list_dir',
              arguments: JSON.stringify({ path: '.' }),
            },
          ],
        };
      }

      if (/(run|execute|shell)/.test(lower)) {
        for (const w of ['Running that command for you…']) {
          for (const ch of w) {
            options.onToken({ type: 'text', text: ch });
            await this.sleep(8);
          }
        }
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'local_run',
              name: 'run_command',
              arguments: JSON.stringify({ command: 'node --version && pwd' }),
            },
          ],
        };
      }
    }

    // Generic streaming answer.
    const answer = `✦ ${this.initialized ? 'Nice to see you again.' : 'Welcome to AstroCode!'} I’m running in demo mode, so you can explore the full agentic pipeline — streaming output, tool calls, history, and slash commands — without an API key.

To connect a real model, set an API key and (optionally) an endpoint:
  export ASTROCODE_API_KEY=sk-...
  export ASTROCODE_MODEL=gpt-4o-mini
  export ASTROCODE_BASE_URL=https://api.openai.com/v1

Try typing something like “list the files here” or “run a command” to watch me use tools. Type /help for all the slash commands. ✦`;
    for (const ch of answer) {
      options.onToken({ type: 'text', text: ch });
      await this.sleep(3);
    }
    return { role: 'assistant', content: answer };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
