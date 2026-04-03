import { Bot, InlineKeyboard } from 'grammy';

import {
  ASSISTANT_NAME,
  getAvailableModels,
  getDefaultModel,
} from '../config.js';
import { getTasksForGroup, setRegisteredGroup } from '../db.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import type { TelegramChannelOpts } from './telegram.js';

const FORWARDED_AGENT_COMMANDS = [
  '/search',
  '/news',
  '/screenshot',
  '/summarize',
  '/translate',
  '/weather',
  '/remind',
  '/code',
  '/agent-browser',
  '/loop',
  '/simplify',
  '/claude-api',
  '/remote-control',
  '/remote-control-end',
];

function parseCommandArgs(text?: string): string {
  if (!text) return '';
  const parts = text.trim().split(/\s+/);
  parts.shift();
  return parts.join(' ').trim();
}

function getModelByInput(input: string) {
  const normalized = input.trim().toLowerCase();
  const models = getAvailableModels();

  if (!normalized) return undefined;

  if (normalized === 'opus') {
    return models.find((m) => m.label === 'Opus');
  }
  if (normalized === 'sonnet') {
    return models.find((m) => m.label === 'Sonnet');
  }
  if (normalized === 'haiku') {
    return models.find((m) => m.label === 'Haiku');
  }

  return models.find((m) => m.id.toLowerCase() === normalized);
}

function renderHelpText(isMain: boolean): string {
  const systemCommands = [
    '• /help — danh sách lệnh',
    '• /status — trạng thái bot',
    '• /capabilities — khả năng hệ thống',
    '• /chatid — lấy chat ID để đăng ký',
    '• /ping — kiểm tra bot online',
    '• /tasks — xem scheduled tasks của group',
  ];

  if (isMain) {
    systemCommands.splice(
      5,
      0,
      '• /model [opus|sonnet|haiku|model_id] — xem/đổi model',
      '• /approve <tg:chatId> [name] — duyệt chat Telegram mới',
    );
  }

  return [
    '📚 *Lệnh Telegram*',
    '',
    '*Phản hồi ngay (bot system):*',
    ...systemCommands,
    '',
    '*Forward vào agent (có thể chậm hơn):*',
    ...FORWARDED_AGENT_COMMANDS.map((cmd) => `• ${cmd}`),
  ].join('\n');
}

function buildModelKeyboard(currentModel: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const models = getAvailableModels();

  for (const model of models) {
    // currentModel may be a label ('Haiku') or an ID — match either
    const isActive =
      model.id === currentModel ||
      model.label.toLowerCase() === currentModel.toLowerCase();
    const label = isActive ? `• ${model.label}` : model.label;
    keyboard.text(label, `model:${model.id}`).row();
  }

  return keyboard;
}

function sanitizeFolderName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function getUniqueFolder(
  opts: TelegramChannelOpts,
  baseFolder: string,
  chatJid: string,
): string {
  const used = new Set(
    Object.values(opts.registeredGroups()).map((g) => g.folder),
  );
  if (!used.has(baseFolder)) return baseFolder;

  const suffix = chatJid
    .replace(/^tg:/, '')
    .replace(/[^0-9]/g, '')
    .slice(-6);
  const fallback = `${baseFolder}-${suffix || 'tg'}`;
  if (!used.has(fallback)) return fallback;

  let i = 2;
  while (used.has(`${fallback}-${i}`)) i += 1;
  return `${fallback}-${i}`;
}

function parseApproveArgs(
  text?: string,
): { chatJid: string; name?: string } | null {
  const raw = parseCommandArgs(text);
  if (!raw) return null;

  const parts = raw.split(/\s+/);
  const first = parts[0]?.trim();
  if (!first) return null;

  const chatJid = first.startsWith('tg:') ? first : `tg:${first}`;
  if (!/^tg:\d+$/.test(chatJid)) return null;

  const name = parts.slice(1).join(' ').trim() || undefined;
  return { chatJid, name };
}

export function registerTelegramCommands(
  bot: Bot,
  opts: TelegramChannelOpts,
): Set<string> {
  bot.command('chatid', (ctx) => {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    const chatName =
      chatType === 'private'
        ? ctx.from?.first_name || 'Private'
        : (ctx.chat as any).title || 'Unknown';

    ctx.reply(
      `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
      {
        parse_mode: 'Markdown',
      },
    );
  });

  bot.command('ping', (ctx) => {
    ctx.reply(`${ASSISTANT_NAME} is online.`);
  });

  bot.command('help', async (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = opts.registeredGroups()[chatJid];
    await ctx.reply(renderHelpText(group?.isMain === true), {
      parse_mode: 'Markdown',
    });
  });

  bot.command('status', async (ctx) => {
    await ctx.reply('✅ Bot đang online. Telegram channel: connected.');
  });

  bot.command('capabilities', async (ctx) => {
    await ctx.reply(
      [
        '⚙️ Capabilities:',
        '- Chat qua agent (tool use, coding, web search)',
        '- Telegram media intake (photo/video/audio/document)',
        '- Scheduled tasks',
        '- Per-group model switch (/model)',
      ].join('\n'),
    );
  });

  bot.command('tasks', async (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = opts.registeredGroups()[chatJid];
    if (!group) {
      await ctx.reply(
        'Chat chưa đăng ký. Dùng /chatid để lấy ID rồi đăng ký group trước.',
      );
      return;
    }

    const tasks = getTasksForGroup(group.folder);
    if (tasks.length === 0) {
      await ctx.reply('Không có scheduled task nào trong group này.');
      return;
    }

    const lines = tasks.slice(0, 20).map((task) => {
      const schedule =
        task.schedule_type === 'cron'
          ? `cron: ${task.schedule_value}`
          : `${task.schedule_type}: ${task.schedule_value}`;
      return `• ${task.id} [${task.status}] — ${schedule}`;
    });

    await ctx.reply(`🗂 Scheduled tasks:\n${lines.join('\n')}`);
  });

  bot.command('approve', async (ctx) => {
    const sourceChatJid = `tg:${ctx.chat.id}`;
    const sourceGroup = opts.registeredGroups()[sourceChatJid];

    if (sourceGroup?.isMain !== true) {
      await ctx.reply('❌ Chỉ main chat mới được dùng lệnh này.');
      return;
    }

    const parsed = parseApproveArgs(ctx.message?.text);
    if (!parsed) {
      await ctx.reply('Dùng: /approve tg:<chatId> [name]');
      return;
    }

    if (parsed.chatJid === sourceChatJid) {
      await ctx.reply(
        'Chat này là main chat, không thể duyệt lại bằng /approve.',
      );
      return;
    }

    const existing = opts.registeredGroups()[parsed.chatJid];
    const approvedName =
      parsed.name ||
      existing?.name ||
      `Telegram ${parsed.chatJid.replace(/^tg:/, '')}`;

    let approvedGroup: RegisteredGroup;
    if (existing) {
      approvedGroup = {
        ...existing,
        name: approvedName,
        isMain: false,
      };
    } else {
      const baseFolder = sanitizeFolderName(
        `telegram-${parsed.chatJid.replace(/^tg:/, '')}`,
      );
      const folder = getUniqueFolder(opts, baseFolder, parsed.chatJid);
      approvedGroup = {
        name: approvedName,
        folder,
        trigger: sourceGroup.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: sourceGroup.requiresTrigger,
        isMain: false,
        containerConfig: {
          ...sourceGroup.containerConfig,
        },
      };
    }

    setRegisteredGroup(parsed.chatJid, approvedGroup);
    opts.registeredGroups()[parsed.chatJid] = approvedGroup;

    await ctx.reply(
      [
        '✅ Đã duyệt chat Telegram mới.',
        `• chatId: \`${parsed.chatJid}\``,
        `• name: ${approvedGroup.name}`,
        `• folder: ${approvedGroup.folder}`,
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );

    try {
      await bot.api.sendMessage(
        parsed.chatJid.replace(/^tg:/, ''),
        [
          `✅ ${approvedGroup.name}, chat của bạn đã được admin duyệt.`,
          'Bạn có thể nhắn bot ngay bây giờ.',
          `Chat ID: \`${parsed.chatJid}\``,
        ].join('\n'),
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      logger.warn(
        { targetChatJid: parsed.chatJid, err },
        'Approved chat but failed to notify target chat',
      );
    }

    logger.info(
      {
        sourceChatJid,
        targetChatJid: parsed.chatJid,
        folder: approvedGroup.folder,
      },
      'Telegram chat approved by main admin',
    );
  });

  bot.command('model', async (ctx) => {
    const chatJid = `tg:${ctx.chat.id}`;
    const group = opts.registeredGroups()[chatJid];
    if (!group) {
      await ctx.reply(
        'Chat chưa đăng ký. Dùng /chatid để lấy ID rồi đăng ký group trước.',
      );
      return;
    }

    if (group.isMain !== true) {
      await ctx.reply('❌ Chỉ main chat mới được dùng lệnh /model.');
      return;
    }

    const arg = parseCommandArgs(ctx.message?.text);
    if (arg) {
      const selected = getModelByInput(arg);
      if (!selected) {
        await ctx.reply(
          'Model không hợp lệ. Dùng: /model opus | /model sonnet | /model haiku',
        );
        return;
      }

      const updatedGroup: RegisteredGroup = {
        ...group,
        containerConfig: {
          ...group.containerConfig,
          model: selected.id,
        },
      };

      setRegisteredGroup(chatJid, updatedGroup);
      opts.registeredGroups()[chatJid] = updatedGroup;
      const stopped = opts.stopActiveRunByChatJid?.(chatJid) === true;
      opts.clearSessionByGroupFolder?.(updatedGroup.folder);

      await ctx.reply(
        `✅ Đã chuyển model sang \`${selected.id}\`${stopped ? '\n⏹ Đang dừng run hiện tại để áp model mới ngay.' : ''}`,
        {
          parse_mode: 'Markdown',
        },
      );
      logger.info(
        { chatJid, model: selected.id },
        'Telegram model switched by command',
      );
      return;
    }

    const currentModel = group.containerConfig?.model || getDefaultModel();
    await ctx.reply(`Model hiện tại: \`${currentModel}\`\nChọn model:`, {
      parse_mode: 'Markdown',
      reply_markup: buildModelKeyboard(currentModel),
    });
  });

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.callbackQuery.data.startsWith('model:')) return;

    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'Không xác định được chat.' });
      return;
    }
    const chatJid = `tg:${chatId}`;
    const group = opts.registeredGroups()[chatJid];
    if (!group) {
      await ctx.answerCallbackQuery({ text: 'Chat chưa đăng ký.' });
      return;
    }
    if (group.isMain !== true) {
      await ctx.answerCallbackQuery({
        text: '❌ Chỉ main chat mới được dùng lệnh /model.',
      });
      return;
    }

    const selectedModel = ctx.callbackQuery.data.slice('model:'.length);
    const selected = getAvailableModels().find((m) => m.id === selectedModel);
    if (!selected) {
      await ctx.answerCallbackQuery({ text: 'Model không hợp lệ.' });
      return;
    }

    const updatedGroup: RegisteredGroup = {
      ...group,
      containerConfig: {
        ...group.containerConfig,
        model: selected.id,
      },
    };

    setRegisteredGroup(chatJid, updatedGroup);
    opts.registeredGroups()[chatJid] = updatedGroup;
    opts.stopActiveRunByChatJid?.(chatJid);
    opts.clearSessionByGroupFolder?.(updatedGroup.folder);

    await ctx.editMessageText(
      `Model hiện tại: \`${selectedModel}\`\nChọn model:`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildModelKeyboard(selectedModel),
      },
    );
    await ctx.answerCallbackQuery({ text: `Đã chuyển sang ${selected.label}` });

    logger.info({ chatJid, model: selectedModel }, 'Telegram model switched');
  });

  return new Set([
    'help',
    'status',
    'capabilities',
    'chatid',
    'ping',
    'approve',
    'model',
    'tasks',
  ]);
}
