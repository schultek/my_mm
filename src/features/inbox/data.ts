import { cache } from "../common/cache";
import { slack } from "../../slack";
import { sendInboxNotification } from "./events/check_reminders";

/** The base type for an inbox entry. */
export type InboxEntry = {
  message: {
    channel: string;
    ts: string;
    url: string;
  };
  description: string;
  actions: InboxAction[];
  deadline?: string; // iso timestamp
  reminders?: string[]; // list of iso timestamps, ordered by earliest to latest
};

/** The type of an inbox action. */
export type InboxAction = {
  label: string;
  /** The style for the action button in slack. */
  style?: "primary" | "danger";
  /** The action id for the action button in slack. */
  action_id: string;
};

export const messageDoneAction: InboxAction = {
  label: "✅ Done",
  style: "primary",
  action_id: "message_action_done",
};
export const messageDismissedAction: InboxAction = {
  label: "🗑️ Dismiss",
  action_id: "message_action_dismiss",
};
export const messageAcceptAction: InboxAction = {
  label: "✅ Accept",
  style: "primary",
  action_id: "message_action_accept",
};
export const messageDeclineAction: InboxAction = {
  label: "❌ Decline",
  style: "danger",
  action_id: "message_action_decline",
};
export const messageThumbsUpAction: InboxAction = {
  label: "👍 Thumbs Up",
  action_id: "message_action_thumbsup",
};

export const allResponseActions = [
  messageDoneAction,
  messageDismissedAction,
  messageAcceptAction,
  messageDeclineAction,
  messageThumbsUpAction,
];
export const defaultResponseActions = [
  messageDoneAction,
  messageDismissedAction,
];

/** The type of a inbox entry as viewed by the user that sent it. */
export type SentInboxEntry = InboxEntry & {
  recipientIds: string[];
  resolutions: { [userId: string]: InboxEntryResolution };
};

/**
 * The type of a single users resolution of an inbox entry.
 *
 * A resolution is created when a user choses an action for an received inbox entry, which is
 * then written back to the sent inbox entry.
 * */
export type InboxEntryResolution = {
  action: InboxAction;
  timestamp: string; // iso timestamp
};

/** The type of an inbox entry as viewed by the user that received it. */
export type ReceivedInboxEntry = InboxEntry & {
  senderId: string;
  reminderMessageTs?: string[];
};

/** The options for creating a new inbox entry. */
export type CreateInboxEntryOptions = {
  message: {
    channel: string;
    ts: string;
    userId: string;
  };
  description: string;
  actions: InboxAction[];
  deadline?: string;

  notifyOnCreate: boolean;
  enableReminders: boolean;
};

/**
 * Creates a new inbox entry for all members of the source [channel].
 *
 * If [deadline] is set and [enableReminders] is true, this will set a number of reminders on a fixed schedule.
 *
 * If [notifyOnCreate] is true, this will send a notification to all recipients.
 */
export async function createInboxEntry(
  options: CreateInboxEntryOptions
): Promise<void> {
  let reminders: string[] = [];

  const enableReminders = options.enableReminders && options.deadline != null;
  if (enableReminders) {
    var deadline = Date.parse(options.deadline!);

    // Use a fixed schedule for now.
    const remindHoursBeforeDeadline = [1, 8, 24, 24 * 3, 24 * 7, 24 * 14];

    for (var hours of remindHoursBeforeDeadline) {
      reminders.unshift(
        new Date(deadline - hours * 60 * 60 * 1000).toISOString()
      );
    }
    while (reminders.length > 0 && new Date(reminders[0]) < new Date()) {
      reminders.shift();
    }
  }

  const recipientIds: string[] = [];
  let nextCursor: string | undefined = undefined;

  // Get all members (paginated).
  if (options.message.channel != null && options.message.channel != "") {
    do {
      var response = await slack.client.conversations.members({
        channel: options.message.channel,
        cursor: nextCursor,
      });
      recipientIds.push(...(response.members ?? []));
      nextCursor = response.response_metadata?.next_cursor;
    } while (nextCursor != null && nextCursor != "");
  }

  const link = await slack.client.chat.getPermalink({
    channel: options.message.channel,
    message_ts: options.message.ts,
  });

  const entry: InboxEntry = {
    message: {
      channel: options.message.channel,
      ts: options.message.ts,
      url: link.permalink!,
    },
    description: options.description,
    actions: options.actions,
    deadline: options.deadline,
    reminders: reminders,
  };

  // Get the current sent entries for the sender.
  const entries =
    (await cache.hget<SentInboxEntry[]>(
      "inbox:sent",
      options.message.userId
    )) ?? [];

  // Update the sent entries.
  await cache.hset<SentInboxEntry[]>("inbox:sent", {
    [options.message.userId]: [
      { ...entry, recipientIds: recipientIds, resolutions: {} },
      ...entries,
    ],
  });

  let reminderTsArray: ReminderTsArray = {};
  if (options.notifyOnCreate) {
    // Notify all recipients.
    for (var recipientId of recipientIds) {
      var r = await sendInboxNotification(
        recipientId,
        { ...entry, senderId: options.message.userId },
        "new"
      );
      console.log("Sent notification to", r.channel, r.ts!);
      reminderTsArray[recipientId] = [r.ts!];

      // We need to track if we get rate-limited for this.
      // Sending out bursts of messages is allowed but the docs are not clear on the exact limits.
      if (r.ok == false && r.error == "rate_limited") {
        console.error("App got rate-limited while sending out messages.", r);
        break;
      }
    }
  }

  // Add the entry for all recipients.
  await updateRecipientsInboxes(recipientIds, (inbox, recipientId) => [
    {
      ...entry,
      senderId: options.message.userId,
      reminderMessageTs: reminderTsArray[recipientId],
    },
    ...inbox,
  ]);
}

/** Loads all sent inbox entries for a user. */
export async function loadSentInboxEntries(
  userId: string
): Promise<SentInboxEntry[]> {
  var entries = await cache.hget<SentInboxEntry[]>("inbox:sent", userId);
  return entries ?? [];
}

/** Deletes a sent inbox entry for a user. */
export async function deleteSentInboxEntry(
  userId: string,
  messageTs: string
): Promise<void> {
  //Delete the entry for the sender.
  const oldEntries = await loadSentInboxEntries(userId);
  const targetEntry = oldEntries.find((e) => e.message.ts == messageTs);

  if (!targetEntry) {
    return;
  }

  // Delete the entry for all recipients.
  await updateRecipientsInboxes(targetEntry.recipientIds, (inbox) =>
    inbox.filter((e) => e.message.ts != messageTs)
  );

  //Delete the entry for the sender.
  await cache.hset<SentInboxEntry[]>("inbox:sent", {
    [userId]: oldEntries.filter((e) => e.message.ts != messageTs),
  });
}

/** Loads all received inbox entries for a user. */
export async function loadReceivedInboxEntries(
  userId: string
): Promise<ReceivedInboxEntry[]> {
  var entries = await cache.hget<ReceivedInboxEntry[]>(
    "inbox:received",
    userId
  );
  return entries ?? [];
}

type ReminderTsArray = { [key: string]: string[] };

async function updateRecipientsInboxes(
  recipientIds: string[],
  update: (
    inbox: ReceivedInboxEntry[],
    recipientId: string,
    reminderTsArray?: ReminderTsArray
  ) => ReceivedInboxEntry[]
): Promise<void> {
  var inboxes =
    (await cache.hmget<ReceivedInboxEntry[]>(
      "inbox:received",
      ...recipientIds
    )) ?? {};

  await cache.hset<ReceivedInboxEntry[]>(
    "inbox:received",
    Object.fromEntries(
      recipientIds.map((recipientId) => {
        let updatedInbox = update(inboxes[recipientId] ?? [], recipientId);
        return [recipientId, updatedInbox];
      })
    )
  );
}
