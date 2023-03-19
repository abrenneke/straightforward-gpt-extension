import * as vscode from 'vscode';
import type { Prompter } from './prompts';

export class DocProvider implements vscode.TextDocumentContentProvider {
  #prompter: Prompter;

  constructor(prompter: Prompter) {
    this.#prompter = prompter;

    prompter.provider = this;
  }

  provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
    return this.#prompter.getResult(uri.path);
  }

  onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.onDidChangeEmitter.event;
}
