import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import * as openai from 'openai';
import { DocProvider } from './docProvider';
import { encoding_for_model } from '@dqbd/tiktoken';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import * as eventSourceParser from 'eventsource-parser';
import { AxiosError } from 'axios';

interface Prompt {
  path: string;
  content: string;
  name: string;
  userInput: string | undefined;
}

export class Prompter {
  #channel: vscode.OutputChannel;

  model = 'gpt-3.5-turbo' as const;
  endpoint = 'https://api.openai.com/v1/chat/completions';
  temperature = 0.7;

  configuration = new openai.Configuration({});
  openai = new openai.OpenAIApi(this.configuration);

  #results: { [key: string]: openai.CreateChatCompletionResponse[] | string } = {};
  provider?: DocProvider;
  #context: vscode.ExtensionContext;

  tokenizer = encoding_for_model(this.model);

  constructor(channel: vscode.OutputChannel, context: vscode.ExtensionContext) {
    this.#channel = channel;
    this.#context = context;
  }

  debug(obj: any, depth: number = 4) {
    this.#channel.appendLine(inspect(obj, false, depth, false));
  }

  async promptForPrompt(): Promise<Prompt | undefined> {
    const promptsPath = vscode.workspace.getConfiguration().get<string>('straightforward-gpt.promptsPath');

    if (!promptsPath) {
      this.#channel.appendLine('Must set straightforward-gpt.promptsPath to use this command.');
      return;
    }

    const { globby } = await import('globby');

    try {
      const files = await globby('**/*.{txt,prompt}', {
        cwd: promptsPath,
        absolute: true,
      });

      const prompts = files.map((file) => ({
        path: file,
        prompt: basename(file, extname(file)),
      }));

      const lastSelectedPrompt = this.#context.workspaceState.get<string>('lastSelectedPrompt');

      prompts.sort((a, b) => a.prompt.localeCompare(b.prompt)).sort((a) => (a.prompt === lastSelectedPrompt ? -1 : 1));

      const selectedPrompt = await vscode.window.showQuickPick(
        prompts.map((p) => p.prompt),
        { title: 'Pick Prompt', placeHolder: 'Prompt' }
      );

      if (!selectedPrompt) {
        return undefined;
      }

      const prompt = prompts.find((p) => p.prompt === selectedPrompt)!;
      const promptText = await readFile(prompt.path, 'utf8');

      const lastInput = this.#context.workspaceState.get<string>('lastUserInput');

      let userInput: string | undefined = undefined;

      if (promptText.includes('{input}')) {
        userInput = await vscode.window.showInputBox({
          title: 'Enter Question',
          prompt: 'Enter your question to ask about the code',
          placeHolder: 'What is the name of the function?',
          value: lastInput ?? '',
          valueSelection: [0, -1],
        });

        this.#context.workspaceState.update('lastUserInput', userInput ?? '');
      }

      this.#context.workspaceState.update('lastSelectedPrompt', selectedPrompt);

      return { content: promptText, name: prompt.prompt, path: prompt.path, userInput };
    } catch (error) {
      this.#channel.appendLine(`Error getting prompt: ${error}`);
      return undefined;
    }
  }

  populatePrompt(
    prompt: Prompt,
    parts: {
      selectedText: string;
      language: string;
      fileText: string;
      fileName: string;
      selectionStartLine: number;
    }
  ) {
    return prompt.content
      .replace(/\{selectedText\}/g, parts.selectedText)
      .replace(/\{language\}/g, parts.language)
      .replace(/\{input\}/g, prompt.userInput ?? '')
      .replace(/\{fileText\}/g, parts.fileText)
      .replace(/\{fileName\}/g, parts.fileName)
      .replace(/\{selectionStartLine\}/g, (parts.selectionStartLine + 1).toLocaleString());
  }

  refresh() {
    this.configuration = new openai.Configuration({
      apiKey: vscode.workspace.getConfiguration().get<string>('straightforward-gpt.apiKey'),
    });
    this.openai = new openai.OpenAIApi(this.configuration);
  }

  async makeRequestWithPrompt(prompt: string): Promise<Readable | undefined> {
    this.refresh();

    const tokenCount = this.tokenizer.encode(prompt).length;
    this.#channel.appendLine(`Prompt: ${prompt}`);
    this.#channel.appendLine(`Prompt token count: ${tokenCount}`);

    let systemPrompt = undefined;
    let userPrompt = prompt;
    if (prompt.startsWith('system:')) {
      systemPrompt = prompt.slice(0, 1).replace('system:', '');
      userPrompt = prompt.slice(1);
    }
    const messages: openai.ChatCompletionRequestMessage[] = systemPrompt
      ? [
          { role: 'system', content: systemPrompt! },
          { role: 'user', content: userPrompt },
        ]
      : [{ role: 'user', content: userPrompt }];

    try {
      const completion = await this.openai.createChatCompletion(
        {
          model: this.model,
          // temperature: this.temperature,
          top_p: 0.1,
          messages,
          stream: true,
        },
        {
          responseType: 'stream',
          responseEncoding: 'utf8',
        }
      );

      const stream = completion.data as unknown as Readable;
      return stream;
    } catch (error: any) {
      const axiosError = error as AxiosError;
      if (axiosError.isAxiosError) {
        const message: Readable = axiosError.response?.data as Readable;
        this.#channel.appendLine(`API Error:`);
        message.on('data', (chunk) => {
          this.#channel.append(chunk.toString());
        });
        await new Promise((resolve) => message.once('end', resolve));
      } else {
        this.#channel.appendLine(`API Error: ${error}`);
      }
      return undefined;
    }
  }

  async doSelectedTextPrompt() {
    const { nanoid } = await import('nanoid');

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      const text = editor.document.getText(selection);

      if (text.length === 0) {
        return;
      }

      const prompt = await this.promptForPrompt();
      if (!prompt) {
        return;
      }

      const populatedPrompt = this.populatePrompt(prompt, {
        selectedText: text,
        language: editor.document.languageId,
        fileText: editor.document.getText(),
        fileName: editor.document.fileName,
        selectionStartLine: selection.start.line,
      });

      const id = `${nanoid()}.md`;
      this.#results[id] = [];

      const uri = vscode.Uri.parse(`straightforward-gpt:${id}`);
      this.#channel.appendLine(`Opening ${uri.toString()}`);

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: 2,
        preview: true,
        preserveFocus: true,
      });

      const parser = eventSourceParser.createParser((event) => {
        if (event.type === 'event') {
          try {
            if (event.data.trim() === '[DONE]') {
              return;
            }

            const completion = JSON.parse(event.data) as openai.CreateChatCompletionResponse;
            (this.#results[id] as openai.CreateChatCompletionResponse[]).push(completion);
            this.provider?.onDidChangeEmitter.fire(uri);
          } catch (err) {
            this.#channel.appendLine(`Error parsing event: ${err}\n\nevent: ${event.data}`);
          }
        }
      });

      const stream = await this.makeRequestWithPrompt(populatedPrompt);
      stream?.on('data', (chunk) => {
        // this.debug(chunk.toString());
        parser.feed(chunk.toString());
      });

      await new Promise((resolve) => {
        stream?.once('end', resolve);
      });
    }
  }

  getResult(path: string): string {
    const id = path.replace(/.+straightforward-gpt:/, '');
    const result = this.#results[id];

    if (Array.isArray(result) && result.length === 0) {
      return 'Loading...';
    }

    if (!result) {
      return 'No result found!';
    }

    if (typeof result === 'string') {
      return result;
    }

    const fullMessage = result.reduce((acc, cur) => {
      const part = (cur.choices[0] as any)?.delta?.content ?? '';
      return acc + part;
    }, '');

    return fullMessage.trim();
  }
}
