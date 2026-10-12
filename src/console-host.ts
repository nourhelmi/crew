import type { ConsoleAnswer, ConsoleCapabilities, ConsoleEvent, ConsoleLaunch, ConsoleRequest, ConsoleState, CommandState } from './console-types.ts';
import type { OwnedProcess } from './console-process.ts';

/** Private provider seam. The supervisor owns persistence; adapters own provider pipes. */
export type HostEvent = ConsoleEvent extends infer E ? E extends ConsoleEvent ? Omit<E, 'id' | 'sequence' | 'at'> & { key?: string } : never : never;
export interface HostIdentity { sessionId: string; turnId?: string; provider?: OwnedProcess }
export interface HostCallbacks {
  identity(identity: HostIdentity): void;
  state(state: ConsoleState, error?: string): void;
  event(event: HostEvent): void;
  request(request: ConsoleRequest): void;
  cancelRequest(id: string): void;
  command(requestId: string, state: CommandState, error?: string): void;
}
export interface HostOptions {
  launch: ConsoleLaunch;
  /** Fully scrubbed root env supplied by the supervisor. Never inherited CREW_RUN. */
  env: NodeJS.ProcessEnv;
  /** Explicit child identity; roots must never inherit CREW_RUN. */
  child?: { runId: string };
  instructions: string;
  /** Reapply the authoritative workflow contract in an existing native session. */
  instructionsChanged?: boolean;
  /** Server-configured host CLI options, never browser-supplied. */
  args?: string[];
  identity?: HostIdentity;
  callbacks: HostCallbacks;
  /** Test-only command override, never accepted from browser input. */
  executable?: string;
}
export interface ConsoleHostAdapter {
  capabilities: ConsoleCapabilities;
  /** Start a new session or resume exactly options.identity, without replaying input. */
  start(): Promise<void>;
  send(text: string, requestId: string, interrupt?: boolean): Promise<CommandState>;
  interrupt(): Promise<void>;
  answer(answer: ConsoleAnswer): Promise<void>;
  close(): Promise<void>;
}
export type HostFactory = (options: HostOptions) => ConsoleHostAdapter;
