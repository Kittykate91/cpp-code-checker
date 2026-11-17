import * as vscode from 'vscode';

type Severity = 'error' | 'warning' | 'info';
interface Issue {
  line: number;
  start: number;
  end: number;
  severity: Severity;
  code: string;
  message: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('cpp-code-checker');
  context.subscriptions.push(diagnostics);

  const analyze = (document: vscode.TextDocument): void => {
    if (document.languageId !== 'cpp' && document.languageId !== 'c') return;
    const issues = analyzeSource(document.getText(), vscode.workspace.getConfiguration('cppCodeChecker').get<number>('maxLineLength', 100));
    const items = issues.map(issue => {
      const range = new vscode.Range(issue.line, issue.start, issue.line, issue.end);
      const severity = issue.severity === 'error' ? vscode.DiagnosticSeverity.Error
        : issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const diagnostic = new vscode.Diagnostic(range, `[${issue.code}] ${issue.message}`, severity);
      diagnostic.source = 'C++ Code Checker';
      return diagnostic;
    });
    diagnostics.set(document.uri, items);
  };

  context.subscriptions.push(vscode.commands.registerCommand('cppCodeChecker.analyze', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a C++ file to analyze it.');
      return;
    }
    analyze(editor.document);
    const count = diagnostics.get(editor.document.uri)?.length ?? 0;
    vscode.window.showInformationMessage(`C++ Code Checker: found ${count} issue(s).`);
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(analyze));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(analyze));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (vscode.workspace.getConfiguration('cppCodeChecker').get<boolean>('checkOnChange', true)) analyze(event.document);
  }));
  if (vscode.window.activeTextEditor) analyze(vscode.window.activeTextEditor.document);
}

export function deactivate(): void {}

function maskNonCode(source: string): string {
  const chars = source.split('');
  let state: 'code' | 'line' | 'block' | 'string' | 'char' = 'code';
  for (let i = 0; i < chars.length; i++) {
    const current = chars[i];
    const next = chars[i + 1];
    if (state === 'code') {
      if (current === '/' && next === '/') { chars[i] = chars[i + 1] = ' '; i++; state = 'line'; }
      else if (current === '/' && next === '*') { chars[i] = chars[i + 1] = ' '; i++; state = 'block'; }
      else if (current === '"') { chars[i] = ' '; state = 'string'; }
      else if (current === "'") { chars[i] = ' '; state = 'char'; }
    } else if (state === 'line') {
      if (current === '\n') state = 'code'; else chars[i] = ' ';
    } else if (state === 'block') {
      if (current === '*' && next === '/') { chars[i] = chars[i + 1] = ' '; i++; state = 'code'; }
      else if (current !== '\n') chars[i] = ' ';
    } else if (state === 'string' || state === 'char') {
      if (current === '\\') { chars[i] = ' '; if (i + 1 < chars.length && chars[i + 1] !== '\n') chars[++i] = ' '; }
      else if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) { chars[i] = ' '; state = 'code'; }
      else if (current !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function analyzeSource(source: string, maxLineLength: number): Issue[] {
  const code = maskNonCode(source);
  const lines = source.split(/\r?\n/);
  const codeLines = code.split(/\r?\n/);
  const issues: Issue[] = [];
  const add = (line: number, start: number, end: number, severity: Severity, rule: string, message: string): void => {
    issues.push({ line, start: Math.max(0, start), end: Math.max(start + 1, end), severity, code: rule, message });
  };

  codeLines.forEach((line, index) => {
    if (/^\s*#\s*include\s*[<"]bits\/stdc\+\+\.h[>"]/.test(line)) {
      const start = line.indexOf('#'); add(index, start, line.length, 'warning', 'CPP001', 'bits/stdc++.h is non-standard; include only the headers you use.');
    }
    if (lines[index].length > maxLineLength) add(index, maxLineLength, lines[index].length, 'info', 'STYLE001', `Line is longer than ${maxLineLength} characters.`);
    if (/\busing\s+namespace\s+std\s*;/.test(line)) {
      const start = line.indexOf('using'); add(index, start, start + line.slice(start).indexOf(';') + 1, 'info', 'CPP002', 'Avoid using namespace std in header files and large projects.');
    }
    if (/\bgets\s*\(/.test(line)) {
      const start = line.indexOf('gets'); add(index, start, start + 4, 'error', 'CPP003', 'gets() is unsafe and was removed from modern C++; use std::getline instead.');
    }
    if (/\bdelete\s*\[\s*\]\s*\w+\s*;/.test(line) === false && /\bdelete\s+\w+\s*\[\s*\]/.test(line)) {
      const start = line.indexOf('delete'); add(index, start, start + 6, 'warning', 'CPP004', 'Possible mismatched delete: arrays allocated with new[] must be released with delete[].');
    }
    if (/\bvoid\s+main\s*\(/.test(line)) {
      const start = line.indexOf('void'); add(index, start, start + 4, 'error', 'CPP005', 'main should return int, not void.');
    }
    if (/\bif\s*\([^)]*\b(?:[A-Za-z_]\w*)\s*=\s*[^=]/.test(line)) {
      const start = line.indexOf('='); add(index, start, start + 1, 'warning', 'CPP006', 'Assignment inside an if condition may be accidental; did you mean ==?');
    }
    if (/\b(?:int|long|short|char|float|double|bool)\s+\w+\s*;/.test(line) && !/=/.test(line)) {
      const match = /\b(?:int|long|short|char|float|double|bool)\s+(\w+)\s*;/.exec(line);
      if (match) { const start = line.indexOf(match[1]); add(index, start, start + match[1].length, 'info', 'CPP007', 'Variable is declared without an initial value; initialize it before use.'); }
    }
  });

  const seenIncludes = new Set<string>();
  codeLines.forEach((line, index) => {
    const match = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(line);
    if (match) {
      if (seenIncludes.has(match[1])) {
        const start = line.indexOf('#'); add(index, start, line.length, 'warning', 'CPP008', `Header '${match[1]}' is included more than once.`);
      } else seenIncludes.add(match[1]);
    }
  });

  issues.sort((a, b) => a.line - b.line || a.start - b.start || a.code.localeCompare(b.code));
  return issues;
}