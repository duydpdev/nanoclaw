import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional callback to clear in-memory + persisted session for a group.
  // Used by channels (e.g. Telegram /model) when runtime config changes should
  // apply immediately to the next agent run.
  clearSessionByGroupFolder?: (groupFolder: string) => void;
  // Optional callback to stop active in-flight run for a chat/group.
  // Used by /model so the next run starts immediately with new model.
  stopActiveRunByChatJid?: (chatJid: string) => boolean;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
