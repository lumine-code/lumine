import type { Disposable, TextEditor } from "atom";

export type ServerTransport = "stdio" | "ipc" | "socket";
export interface ServerLaunch {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  transport?: ServerTransport;
  host?: string;
  port?: number;
  version?: string;
}
export interface ServerResolutionContext {
  rootPath: string;
  projectPaths: string[];
  configDirPath: string;
  managedStoragePath: string;
}
export interface LanguageServerAdapter {
  id: string;
  displayName: string;
  languageId?: string;
  grammarScopes: string[];
  documentSelector?: Array<{ language?: string; scheme?: string; pattern?: string }>;
  sessionScope?: "project-root" | "workspace";
  resolveServer(context: ServerResolutionContext): Promise<ServerLaunch | null>;
  getInitializationOptions?(context: {
    rootPath: string;
    rootUri: string;
  }): unknown | Promise<unknown>;
  getWorkspaceConfiguration?(section?: string, resource?: string): unknown;
  transformServerCapabilities?(capabilities: Record<string, unknown>): Record<string, unknown>;
}
export interface LanguageServerSession {
  adapter: LanguageServerAdapter;
  rootPath: string;
  state: "starting" | "running" | "failed" | "stopping" | "stopped";
  capabilities: Record<string, any>;
  request(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<any>;
  notify(method: string, params?: unknown): void;
}
export interface LanguageServerService {
  registerAdapter(adapter: LanguageServerAdapter): Disposable;
  sessionForEditor(editor: TextEditor): LanguageServerSession | null;
  getSessions(): LanguageServerSession[];
  onDidChangeSession(
    callback: (event: { session: LanguageServerSession; state: string; error?: Error }) => void,
  ): Disposable;
  onDidPublishDiagnostics(callback: (event: object) => void): Disposable;
  request(
    editor: TextEditor,
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<any> | undefined;
  restart(session: LanguageServerSession): Promise<LanguageServerSession>;
  stop(session: LanguageServerSession): Promise<void>;
  getLog(adapterId: string): string;
  applyWorkspaceEdit(edit: object, label?: string): Promise<boolean>;
  openNotebook(session: LanguageServerSession, notebook: object, cells?: object[]): void;
  changeNotebook(session: LanguageServerSession, notebook: object, change: object): void;
  saveNotebook(session: LanguageServerSession, notebook: object): void;
  closeNotebook(session: LanguageServerSession, notebook: object, cells?: object[]): void;
}
