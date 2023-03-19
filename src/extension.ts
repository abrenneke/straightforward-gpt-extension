import * as vscode from 'vscode';
import { DocProvider } from './docProvider';
import { Prompter } from './prompts';

export function activate(context: vscode.ExtensionContext) {
  const channel = vscode.window.createOutputChannel('straightforward-gpt');
  const prompter = new Prompter(channel, context);
  const provider = new DocProvider(prompter);

  context.subscriptions.push(
    vscode.commands.registerCommand('straightforward-gpt.runPromptWithSelection', async () => {
      await prompter.doSelectedTextPrompt();
    }),
    vscode.workspace.registerTextDocumentContentProvider('straightforward-gpt', provider),
    channel
  );
}

export function deactivate() {}
